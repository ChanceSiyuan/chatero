import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  RemoteAgentInstaller,
} from "../extensions/chatero-remote/remote-agent-installer.mjs";
import { SshSession } from "../extensions/chatero-remote/ssh-session.mjs";
import { parseAuthenticatedFingerprint } from "../extensions/chatero-remote/ssh-session.mjs";

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
          installRelativePath: `.chatero-server/bin/${"a".repeat(40)}/linux-x86_64`,
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
      async upload(input) {
        calls.push(["upload", input]);
      },
      async finalize(input) {
        calls.push(["finalize", input]);
      },
      async createRuntime(input) {
        calls.push(["runtime", { ...input, connectionToken: "[redacted]" }]);
        return { remotePort: 41321, agentHostPath: "/run/user/1000/c.sock" };
      },
    },
    randomToken: () => privateToken,
  });
  const release = {
    manifestText: "signed",
    signature: Buffer.from("signature"),
    publicKey: "public",
    readArtifact: async () => Buffer.from("artifact"),
    manifest: {
      codeOssCommit: "a".repeat(40),
      artifacts: [{ tuple: "linux-x86_64", filename: "chatero-agent-linux-x86_64.tar.gz", sha256: "b".repeat(64), size: 8 }],
    },
  };

  const ready = await installer.ensureInstalled({
    alias: "lab-a",
    controlPath: "/tmp/master.sock",
    release,
  });

  assert.equal(calls[0], "verify");
  assert.equal(calls.some(value => JSON.stringify(value).includes("/srv/work")), false);
  assert.equal(calls.some(value => JSON.stringify(value).includes(".chatero-server/bin")), true);
  assert.equal(JSON.stringify(calls).includes(privateToken), false);
  assert.deepEqual(ready, {
    remotePort: 41321,
    connectionToken: privateToken,
    agentHostPath: "/run/user/1000/c.sock",
    installRelativePath: `.chatero-server/bin/${"a".repeat(40)}/linux-x86_64`,
    tuple: "linux-x86_64",
    hostPlatform: { os: "linux", arch: "x86_64", kernel: "6.8", tuple: "linux-x86_64" },
  });
});
