import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { test } from "node:test";

import { decodeAuthority, encodeAuthority } from "../extensions/chatero-remote/authority.mjs";
import {
  discoverSshTargets,
  resolveSshTarget,
} from "../extensions/chatero-remote/openssh-targets.mjs";
import {
  createManagedConnection,
  forwardingArguments,
} from "../extensions/chatero-remote/managed-connection.mjs";
import {
  parseRemotePlatform,
  pumpInput,
  REMOTE_AGENT_SCRIPTS,
  RemoteAgentInstaller,
  SshRemoteAgentRuntime,
} from "../extensions/chatero-remote/remote-agent-installer.mjs";
import { SshSession } from "../extensions/chatero-remote/ssh-session.mjs";
import { parseAuthenticatedFingerprint } from "../extensions/chatero-remote/ssh-session.mjs";

const INSTALL_INTEGRITY = Object.freeze({
  treeManifestSha256: "c".repeat(64),
  nodeSha256: "d".repeat(64),
  integrityVerifierSha256: "e".repeat(64),
});

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.endCount = 0;
    this.destroyCount = 0;
    this.blockNextWrite = false;
  }

  write(bytes) {
    this.writes.push(Buffer.from(bytes));
    if (this.blockNextWrite) {
      this.blockNextWrite = false;
      return false;
    }
    return true;
  }

  end() {
    this.endCount++;
  }

  destroy() {
    this.destroyCount++;
  }
}

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new FakeStream();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.killCount = 0;
  }

  kill() {
    this.killCount++;
  }
}

test("authority round trips an opaque target id and rejects embedded paths", () => {
  const authority = encodeAuthority("profile:lab-a");
  assert.match(authority, /^chatero-remote\+[A-Za-z0-9_-]+$/);
  assert.equal(decodeAuthority(authority), "profile:lab-a");
  assert.throws(() => decodeAuthority("chatero-remote+../../private"), /authority/i);
  assert.throws(() => encodeAuthority("profile:../../private"), /target/i);
  assert.throws(() => decodeAuthority(`${authority}=`), /authority/i);
});

test("SSH config discovery expands bounded includes and keeps concrete aliases only", async () => {
  const files = new Map([
    ["/Users/alice/.ssh/config", "Include conf.d/*.conf\nHost *.example lab-a !negated\n"],
    ["/Users/alice/.ssh/conf.d/10-lab.conf", "Host lab-b lab-a\n"],
    ["/Users/alice/.ssh/conf.d/20-more.conf", "Host gpu_2\n"],
  ]);
  const targets = await discoverSshTargets({
    home: "/Users/alice",
    readFile: async path => files.get(path) ?? null,
    realpath: async path => path,
    expandGlob: async pattern => pattern.endsWith("*.conf")
      ? ["/Users/alice/.ssh/conf.d/20-more.conf", "/Users/alice/.ssh/conf.d/10-lab.conf"]
      : [pattern],
  });

  assert.deepEqual(targets.map(target => target.alias), ["lab-b", "lab-a", "gpu_2"]);
  assert.ok(targets.every(target => Object.isFrozen(target)));
});

test("ssh -G is the effective configuration truth and receives structured argv", async () => {
  const calls = [];
  const target = await resolveSshTarget("lab-a", async (command, args) => {
    calls.push({ command, args });
    return {
      code: 0,
      stdout: [
        "hostname 10.0.0.7",
        "user alice",
        "port 2222",
        "identityfile ~/.ssh/id_ed25519",
        "proxyjump bastion",
        "",
      ].join("\n"),
      stderr: "",
    };
  });

  assert.deepEqual(calls, [{ command: "/usr/bin/ssh", args: ["-G", "--", "lab-a"] }]);
  assert.deepEqual(target, {
    alias: "lab-a",
    hostname: "10.0.0.7",
    user: "alice",
    port: 2222,
    identityFiles: ["~/.ssh/id_ed25519"],
    proxyJump: "bastion",
    proxyCommand: null,
  });
  await assert.rejects(resolveSshTarget("bad alias", async () => ({ code: 0 })), /alias/i);
});

test("managed forwarding uses fixed OpenSSH argv and never includes secrets or workspaces", () => {
  const args = forwardingArguments({
    alias: "lab-a",
    controlPath: "/tmp/chatero-123/master.sock",
    remotePort: 41793,
  });
  assert.deepEqual(args, [
    "-T", "-S", "/tmp/chatero-123/master.sock",
    "-o", "BatchMode=yes",
    "-W", "127.0.0.1:41793",
    "--", "lab-a",
  ]);
  assert.equal(args.some(value => value.includes("StrictHostKeyChecking=no")), false);
  assert.equal(args.some(value => value.includes("connection-token")), false);
  assert.equal(args.some(value => value.includes("/srv/research")), false);
});

test("managed connection keeps stderr away from protocol bytes and exposes backpressure", async () => {
  const process = new FakeProcess();
  const protocol = [];
  const logs = [];
  const connection = createManagedConnection(process, {
    isCurrent: () => true,
    log: value => logs.push(value),
  });
  const received = connection.onDidReceiveMessage(bytes => protocol.push(Buffer.from(bytes).toString("utf8")));

  process.stderr.emit("data", Buffer.from("warning token=super-secret"));
  process.stdout.emit("data", Buffer.from("protocol"));
  assert.deepEqual(protocol, ["protocol"]);
  assert.equal(logs.some(value => value.includes("super-secret")), false);

  process.stdin.blockNextWrite = true;
  connection.send(Buffer.from("request"));
  let drained = false;
  const waiting = connection.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  process.stdin.emit("drain");
  await waiting;
  assert.equal(drained, true);

  received.dispose();
  connection.end();
  assert.equal(process.stdin.endCount, 1);
});

test("managed connection waits for process status before graceful end and reports every abnormal exit", () => {
  const failedProcess = new FakeProcess();
  const failed = createManagedConnection(failedProcess);
  const failedEvents = [];
  failed.onDidEnd(() => failedEvents.push("end"));
  failed.onDidClose(error => failedEvents.push(error ? `close:${error.message}` : "close:ok"));
  failedProcess.stdout.emit("end");
  assert.deepEqual(failedEvents, []);
  failedProcess.emit("close", 23, null);
  assert.deepEqual(failedEvents, ["close:SSH channel exited with code 23"]);

  const signaledProcess = new FakeProcess();
  const signaled = createManagedConnection(signaledProcess);
  const signals = [];
  signaled.onDidEnd(() => signals.push("end"));
  signaled.onDidClose(error => signals.push(error?.message));
  signaledProcess.stdout.emit("end");
  signaledProcess.emit("close", null, "SIGKILL");
  assert.deepEqual(signals, ["SSH channel exited with signal SIGKILL"]);

  const cleanProcess = new FakeProcess();
  const clean = createManagedConnection(cleanProcess);
  const cleanEvents = [];
  clean.onDidEnd(() => cleanEvents.push("end"));
  clean.onDidClose(error => cleanEvents.push(error ? "close:error" : "close:ok"));
  cleanProcess.emit("close", 0, null);
  assert.deepEqual(cleanEvents, ["end", "close:ok"]);
});

test("a master loss closes dependent channels once and stale epochs are ignored", async () => {
  const masterProcesses = [];
  const channelProcesses = [];
  const spawnCalls = [];
  const spawn = (command, args) => {
    assert.equal(command, "/usr/bin/ssh");
    const process = new FakeProcess();
    spawnCalls.push({ args: [...args], process });
    if (args.includes("-MN")) masterProcesses.push(process);
    else channelProcesses.push(process);
    return process;
  };
  let epoch = 0;
  const session = new SshSession({
    spawn,
    createMasterRuntime: async () => ({
      directory: `/tmp/chatero-${++epoch}`,
      controlPath: `/tmp/chatero-${epoch}/master.sock`,
      logPath: `/tmp/chatero-${epoch}/master.log`,
    }),
    waitForMaster: async () => ({
      hostFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }),
    installer: {
      async ensureInstalled() {
        return {
          remotePort: 41000 + epoch,
          connectionToken: `token-${epoch}`,
          agentHostPath: `/run/user/1000/chatero-${epoch}.sock`,
          installRelativePath: `.chatero-server/artifacts-v1/${"b".repeat(64)}/${"a".repeat(40)}/linux-x86_64`,
        };
      },
    },
  });

  await session.ensureReady({ target: { alias: "lab-a" }, release: {} });
  const first = session.makeConnection();
  let closes = 0;
  first.onDidClose(() => closes++);
  masterProcesses[0].emit("exit", 255, null);
  masterProcesses[0].emit("close", 255, null);
  assert.equal(closes, 1);
  assert.equal(channelProcesses[0].killCount, 1);

  await session.ensureReady({ target: { alias: "lab-a" }, release: {} });
  const second = session.makeConnection();
  const received = [];
  second.onDidReceiveMessage(bytes => received.push(Buffer.from(bytes).toString("utf8")));
  channelProcesses[0].stdout.emit("data", Buffer.from("stale"));
  channelProcesses[1].stdout.emit("data", Buffer.from("current"));
  assert.deepEqual(received, ["current"]);

  const bridge = session.openProcessBridge();
  assert.equal(bridge.generation, session.getPublicSession().generation);
  const bridgeArgs = spawnCalls.at(-1).args;
  assert.deepEqual(bridgeArgs.slice(0, 7), [
    "-T", "-S", "/tmp/chatero-2/master.sock", "-o", "BatchMode=yes", "--", "lab-a",
  ]);
  assert.match(bridgeArgs.at(-1), /\/node.*chatero-process-bridge\.mjs/);
  assert.doesNotMatch(bridgeArgs.join(" "), /token-|\/srv\/|codex exec/);
});

test("session cache is bound to effective SSH configuration and forwarding failure invalidates a dead server", async () => {
  const masters = [];
  const channels = [];
  const spawn = (_command, args) => {
    const process = new FakeProcess();
    (args.includes("-MN") ? masters : channels).push(process);
    return process;
  };
  let runtime = 0;
  let installs = 0;
  const session = new SshSession({
    spawn,
    createMasterRuntime: async () => ({
      directory: `/tmp/chatero-endpoint-${++runtime}`,
      controlPath: `/tmp/chatero-endpoint-${runtime}/master.sock`,
      logPath: `/tmp/chatero-endpoint-${runtime}/master.log`,
    }),
    waitForMaster: async () => ({ hostFingerprint: `SHA256:${"A".repeat(43)}` }),
    installer: {
      async ensureInstalled() {
        installs++;
        return {
          remotePort: 42000 + installs,
          connectionToken: `token-${"x".repeat(32)}-${installs}`,
          agentHostPath: `/run/user/1000/chatero-${installs}.sock`,
          installRelativePath: `.chatero-server/artifacts-v1/${"b".repeat(64)}/${"a".repeat(40)}/linux-x86_64`,
        };
      },
    },
  });
  const target = overrides => ({
    alias: "lab-a",
    hostname: "host-a.example",
    user: "alice",
    port: 22,
    identityFiles: ["~/.ssh/id_a"],
    proxyJump: null,
    proxyCommand: null,
    ...overrides,
  });

  await session.ensureReady({ target: target(), release: {} });
  await session.ensureReady({ target: target({ hostname: "host-b.example" }), release: {} });
  assert.equal(masters.length, 2);
  assert.equal(masters[0].killCount, 1);
  assert.equal(installs, 2);

  const forwarding = session.makeConnection();
  let forwardingError;
  forwarding.onDidClose(error => { forwardingError = error; });
  channels.at(-1).stdout.emit("end");
  channels.at(-1).emit("close", 255, null);
  assert.match(forwardingError.message, /code 255/);
  assert.equal(session.getPublicSession(), null);

  await session.ensureReady({ target: target({ hostname: "host-b.example" }), release: {} });
  assert.equal(masters.length, 3);
  assert.equal(installs, 3);
});

test("host fingerprint selection ignores an earlier ProxyJump handshake", () => {
  const proxy = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const target = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const log = [
    "debug1: Authenticating to jump.example:22 as 'alice'",
    `debug1: Server host key: ssh-ed25519 ${proxy}`,
    "debug1: Authenticating to 10.0.0.7:2222 as 'alice'",
    `debug1: Server host key: ssh-ed25519 ${target}`,
    "",
  ].join("\n");
  assert.equal(parseAuthenticatedFingerprint(log, {
    hostname: "10.0.0.7",
    port: 2222,
    user: "alice",
  }), target);
  assert.throws(() => parseAuthenticatedFingerprint(log, {
    hostname: "unknown.example",
    port: 22,
    user: "alice",
  }), /authenticated host key/i);
});

test("remote platform probing accepts only the two signed Linux tuples", () => {
  assert.deepEqual(parseRemotePlatform("Linux\nx86_64\n6.8.0\n"), {
    os: "linux", arch: "x86_64", kernel: "6.8.0", tuple: "linux-x86_64",
  });
  assert.deepEqual(parseRemotePlatform("Linux\narm64\n6.6\n"), {
    os: "linux", arch: "aarch64", kernel: "6.6", tuple: "linux-aarch64",
  });
  assert.throws(() => parseRemotePlatform("Darwin\narm64\n24.0\n"), /unsupported/i);
  assert.throws(() => parseRemotePlatform("Linux\nriscv64\n6.8\n"), /unsupported/i);
});

test("installer verifies the signed release before upload and keeps installation outside the workspace", async () => {
  const calls = [];
  const privateToken = "private-token-1234567890-private-secret";
  const installer = new RemoteAgentInstaller({
    verifyRelease: async release => {
      calls.push("verify");
      return release.manifest;
    },
    selectArtifact: (manifest, selection) => {
      calls.push(["select", selection]);
      return manifest.artifacts[0];
    },
    remote: {
      async probe() {
        calls.push("probe");
        return "Linux\nx86_64\n6.8\n";
      },
      async partSize(input) {
        calls.push(["part", input]);
        return 3;
      },
      async probeInstalled(input) {
        calls.push(["installed", input]);
        return false;
      },
      async upload(input) {
        calls.push(["upload", input]);
      },
      async finalize(input) {
        calls.push(["finalize", input]);
      },
      async discardPart(input) {
        calls.push(["discard", input]);
      },
      async createRuntime(input) {
        calls.push(["runtime", { ...input, connectionToken: "[redacted]" }]);
        return {
          remotePort: 41321,
          agentHostPath: "/run/user/1000/c.sock",
          installPath: `/home/alice/.chatero-server/artifacts-v1/${"b".repeat(64)}/${"a".repeat(40)}/linux-x86_64`,
        };
      },
    },
    randomToken: () => privateToken,
    randomTransactionId: () => "c".repeat(24),
  });
  const release = {
    manifestText: "signed",
    signature: Buffer.from("signature"),
    publicKey: "public",
    readArtifact: async () => Buffer.from("artifact"),
    manifest: {
      codeOssCommit: "a".repeat(40),
      artifacts: [{
        tuple: "linux-x86_64",
        filename: "chatero-agent-linux-x86_64.tar.gz",
        sha256: "b".repeat(64),
        size: 8,
        ...INSTALL_INTEGRITY,
      }],
    },
  };

  const ready = await installer.ensureInstalled({
    alias: "lab-a",
    controlPath: "/tmp/master.sock",
    release,
  });

  assert.equal(calls[0], "verify");
  assert.equal(calls.some(value => JSON.stringify(value).includes("/srv/work")), false);
  assert.equal(calls.some(value => JSON.stringify(value).includes(".chatero-server/artifacts-v1")), true);
  assert.equal(JSON.stringify(calls).includes(privateToken), false);
  assert.deepEqual(ready, {
    remotePort: 41321,
    connectionToken: privateToken,
    agentHostPath: "/run/user/1000/c.sock",
    installPath: `/home/alice/.chatero-server/artifacts-v1/${"b".repeat(64)}/${"a".repeat(40)}/linux-x86_64`,
    installRelativePath: `.chatero-server/artifacts-v1/${"b".repeat(64)}/${"a".repeat(40)}/linux-x86_64`,
    artifactSha256: "b".repeat(64),
    ...INSTALL_INTEGRITY,
    codeOssCommit: "a".repeat(40),
    tuple: "linux-x86_64",
    hostPlatform: { os: "linux", arch: "x86_64", kernel: "6.8", tuple: "linux-x86_64" },
  });
  const runtimeCall = calls.find(value => value[0] === "runtime")[1];
  assert.equal(runtimeCall.tuple, "linux-x86_64");
});

function releaseFixture() {
  return {
    manifestText: "signed",
    signature: Buffer.from("signature"),
    publicKey: "public",
    readArtifact: async () => Buffer.from("artifact"),
    manifest: {
      codeOssCommit: "a".repeat(40),
      artifacts: [{
        tuple: "linux-x86_64",
        filename: "chatero-agent-linux-x86_64.tar.gz",
        sha256: "b".repeat(64),
        size: 8,
        ...INSTALL_INTEGRITY,
      }],
    },
  };
}

test("installer probes a valid digest before upload and skips the archive transaction", async () => {
  const calls = [];
  const installer = new RemoteAgentInstaller({
    verifyRelease: async release => release.manifest,
    selectArtifact: manifest => manifest.artifacts[0],
    randomToken: () => "t".repeat(43),
    randomTransactionId: () => "d".repeat(24),
    remote: {
      async probe() { return "Linux\nx86_64\n6.8\n"; },
      async probeInstalled(input) { calls.push(["installed", input]); return true; },
      async partSize() { throw new Error("valid install must not inspect a partial"); },
      async upload() { throw new Error("valid install must not upload"); },
      async finalize() { throw new Error("valid install must not finalize"); },
      async discardPart() { throw new Error("valid install must not discard"); },
      async createRuntime() {
        return {
          remotePort: 41001,
          agentHostPath: "/run/user/1000/a.sock",
          installPath: `/home/alice/.chatero-server/artifacts-v1/${"b".repeat(64)}/${"a".repeat(40)}/linux-x86_64`,
        };
      },
    },
  });

  await installer.ensureInstalled({ alias: "lab-a", controlPath: "/tmp/master.sock", release: releaseFixture() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].sha256, "b".repeat(64));
});

test("installer uses a unique transaction and discards a corrupt completed partial before retry", async () => {
  const calls = [];
  let partProbe = 0;
  let finalize = 0;
  const corrupt = new Error("remote artifact digest mismatch");
  corrupt.remoteExitCode = 76;
  const installer = new RemoteAgentInstaller({
    verifyRelease: async release => release.manifest,
    selectArtifact: manifest => manifest.artifacts[0],
    randomToken: () => "t".repeat(43),
    randomTransactionId: () => "e".repeat(24),
    remote: {
      async probe() { return "Linux\nx86_64\n6.8\n"; },
      async probeInstalled() { return false; },
      async partSize(input) { calls.push(["part", input.partRelativePath]); return partProbe++ === 0 ? 8 : 0; },
      async upload(input) { calls.push(["upload", input.partRelativePath, input.offset]); },
      async finalize(input) {
        calls.push(["finalize", input.partRelativePath]);
        if (finalize++ === 0) throw corrupt;
      },
      async discardPart(input) { calls.push(["discard", input.partRelativePath]); },
      async createRuntime() {
        return {
          remotePort: 41002,
          agentHostPath: "/run/user/1000/b.sock",
          installPath: `/home/alice/.chatero-server/artifacts-v1/${"b".repeat(64)}/${"a".repeat(40)}/linux-x86_64`,
        };
      },
    },
  });

  await installer.ensureInstalled({ alias: "lab-a", controlPath: "/tmp/master.sock", release: releaseFixture() });
  const paths = calls.filter(call => ["part", "upload", "finalize", "discard"].includes(call[0])).map(call => call[1]);
  assert.ok(paths.every(path => path.endsWith(`/transactions/${"a".repeat(40)}/${"e".repeat(24)}.part`)));
  assert.deepEqual(calls.map(call => call[0]), ["part", "finalize", "discard", "part", "upload", "finalize"]);
});

test("installer reuses its transaction after an interrupted upload and resumes from the remote byte count", async () => {
  const paths = [];
  const offsets = [];
  let transactionIds = 0;
  let invocation = 0;
  const transactionState = new Map();
  const interrupted = new Error("forwarding lost");
  interrupted.code = "SSH_TRANSPORT";
  const remote = {
    async probe() { return "Linux\nx86_64\n6.8\n"; },
    async probeInstalled() { return false; },
    async partSize(input) {
      paths.push(input.partRelativePath);
      return invocation++ === 0 ? 0 : 5;
    },
    async upload(input) {
      paths.push(input.partRelativePath);
      offsets.push(input.offset);
      if (offsets.length === 1) throw interrupted;
    },
    async finalize(input) { paths.push(input.partRelativePath); },
    async discardPart() {},
    async createRuntime() {
      return {
        remotePort: 41003,
        agentHostPath: "/run/user/1000/c.sock",
        installPath: `/home/alice/.chatero-server/artifacts-v1/${"b".repeat(64)}/${"a".repeat(40)}/linux-x86_64`,
      };
    },
  };
  const createInstaller = () => new RemoteAgentInstaller({
    verifyRelease: async release => release.manifest,
    selectArtifact: manifest => manifest.artifacts[0],
    randomToken: () => "t".repeat(43),
    randomTransactionId: () => `${++transactionIds}`.padStart(24, "0"),
    transactionState,
    remote,
  });

  await assert.rejects(
    createInstaller().ensureInstalled({ alias: "lab-a", controlPath: "/tmp/master.sock", release: releaseFixture() }),
    /forwarding lost/,
  );
  await createInstaller().ensureInstalled({ alias: "lab-a", controlPath: "/tmp/master.sock", release: releaseFixture() });
  assert.equal(transactionIds, 1);
  assert.ok(paths.every(path => path === paths[0]));
  assert.deepEqual(offsets, [0, 5]);
});

test("concurrent installer calls use separate upload transaction paths", async () => {
  const paths = [];
  let transactionIds = 10;
  let releaseUploads;
  const bothUploading = new Promise(resolve => { releaseUploads = resolve; });
  const installer = new RemoteAgentInstaller({
    verifyRelease: async release => release.manifest,
    selectArtifact: manifest => manifest.artifacts[0],
    randomToken: () => "t".repeat(43),
    randomTransactionId: () => `${++transactionIds}`.padStart(24, "0"),
    remote: {
      async probe() { return "Linux\nx86_64\n6.8\n"; },
      async probeInstalled() { return false; },
      async partSize() { return 0; },
      async upload(input) {
        paths.push(input.partRelativePath);
        if (paths.length === 2) releaseUploads();
        await bothUploading;
      },
      async finalize() {},
      async discardPart() {},
      async createRuntime() {
        return {
          remotePort: 41004,
          agentHostPath: "/run/user/1000/d.sock",
          installPath: `/home/alice/.chatero-server/artifacts-v1/${"b".repeat(64)}/${"a".repeat(40)}/linux-x86_64`,
        };
      },
    },
  });

  await Promise.all([
    installer.ensureInstalled({ alias: "lab-a", controlPath: "/tmp/master.sock", release: releaseFixture() }),
    installer.ensureInstalled({ alias: "lab-a", controlPath: "/tmp/master.sock", release: releaseFixture() }),
  ]);
  assert.equal(new Set(paths).size, 2);
});

test("stdin pumping rejects channel loss and abort while backpressured", async () => {
  const blocked = () => new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, _callback) {},
  });
  const lost = blocked();
  const lostPump = pumpInput(lost, [Buffer.alloc(1024)]);
  lost.destroy(new Error("SSH stdin closed"));
  await assert.rejects(lostPump, /SSH stdin closed/);

  const cancelled = blocked();
  const controller = new AbortController();
  const cancelledPump = pumpInput(cancelled, [Buffer.alloc(1024)], controller.signal);
  controller.abort(new Error("upload cancelled"));
  await assert.rejects(cancelledPump, /upload cancelled|aborted/i);
});

test("remote upload accepts only a clean SSH exit after a terminal EPIPE", async () => {
  function runtime(exitCode) {
    return new SshRemoteAgentRuntime({
      alias: "lab-a",
      controlPath: "/tmp/master.sock",
      spawn: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        child.stdin = new Writable({
          write(_chunk, _encoding, callback) {
            const error = new Error("remote stdin closed after consuming upload");
            error.code = "EPIPE";
            setImmediate(() => child.emit("close", exitCode, null));
            callback(error);
          },
        });
        return child;
      },
    });
  }

  await runtime(0).upload({
    partRelativePath: `.chatero-server/transactions/${"a".repeat(40)}/${"b".repeat(24)}.part`,
    source: async () => Buffer.from("complete artifact"),
    offset: 0,
  });
  await assert.rejects(runtime(71).upload({
    partRelativePath: `.chatero-server/transactions/${"a".repeat(40)}/${"c".repeat(24)}.part`,
    source: async () => Buffer.from("rejected artifact"),
    offset: 0,
  }), /remote bootstrap exited with 71/);
});

test("remote upload accepts an empty regular transaction without broadening file types", () => {
  assert.match(REMOTE_AGENT_SCRIPTS.upload, /'regular file'\|'regular empty file'/);
  assert.match(REMOTE_AGENT_SCRIPTS.upload, /\*\) exit 77/);
  assert.doesNotMatch(REMOTE_AGENT_SCRIPTS.upload, /block special|character special|fifo|socket/);
});
