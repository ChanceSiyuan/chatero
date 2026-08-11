import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, getEventListeners, once } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  RemoteProcessService,
  runFramedBridgeRequest,
} from "../extensions/chatero-remote/remote-process.mjs";
import { SshSession } from "../extensions/chatero-remote/ssh-session.mjs";

function jsonLine(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

class FakeChannel {
  constructor({ generation = 3, sshArgv = ["-T", "--", "lab-a", "fixed-bridge"] } = {}) {
    this.generation = generation;
    this.sshArgv = sshArgv;
    this.writes = [];
    this.closed = 0;
    this.ended = 0;
    this.dataListeners = new Set();
    this.closeListeners = new Set();
  }

  write(value) {
    this.writes.push(Buffer.from(value));
    return true;
  }

  end() {
    this.ended++;
  }

  onData(listener) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onClose(listener) {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  emitFrame(value) {
    for (const listener of this.dataListeners) listener(jsonLine(value));
  }

  emitBytes(value) {
    for (const listener of this.dataListeners) listener(Buffer.from(value));
  }

  finish(result = { code: 0, signal: null, error: null }) {
    for (const listener of this.closeListeners) listener(result);
  }

  close() {
    this.closed++;
    this.finish({ code: null, signal: "SIGTERM", error: null });
  }

  request() {
    return JSON.parse(Buffer.concat(this.writes).toString("utf8").split("\n", 1)[0]);
  }
}

function serviceFixture({
  canonical = ({ root, cwd }) => ({ root, cwd }),
  trusted = true,
} = {}) {
  let generation = 3;
  const channels = [];
  const session = {
    getPublicSession: () => ({ generation }),
    openProcessBridge() {
      const channel = new FakeChannel({ generation });
      channels.push(channel);
      return channel;
    },
  };
  const folder = {
    uri: {
      scheme: "vscode-remote",
      authority: "chatero-remote+cHJvZmlsZTpsYWItYQ",
      path: "/srv/work",
      fsPath: "/this/local-looking-value/must-not-be-used",
    },
  };
  return {
    channels,
    folder,
    session,
    setGeneration(value) { generation = value; },
    service: new RemoteProcessService({
      getSession: () => session,
      getWorkspaceFolder: () => folder,
      isWorkspaceTrusted: () => trusted,
      canonicalizeWorkspaceCwd: async (_session, root, cwd) => canonical({ root, cwd }),
    }),
  };
}

test("remote process transmits command and arguments as framed data", async () => {
  const fixture = serviceFixture();
  const output = [];
  const running = fixture.service.run({
    command: "codex",
    args: ["exec", "text; rm -rf x"],
    cwd: "/srv/work",
    env: { SAFE: "yes; still data" },
  }, { onStdout: bytes => output.push(Buffer.from(bytes).toString("utf8")) });

  await Promise.resolve();
  const channel = fixture.channels[0];
  assert.equal(channel.sshArgv.some(value => value.includes("rm -rf")), false);
  assert.deepEqual(channel.request(), {
    protocolVersion: 1,
    command: "codex",
    args: ["exec", "text; rm -rf x"],
    cwd: "/srv/work",
    env: { SAFE: "yes; still data" },
  });
  channel.emitFrame({ type: "stdout", data: Buffer.from("answer").toString("base64") });
  channel.emitFrame({ type: "exit", code: 0, signal: null });
  channel.finish();
  assert.deepEqual(await running, { code: 0, signal: null });
  assert.deepEqual(output, ["answer"]);
});

test("remote process derives containment root from remote URI path, never fsPath", async () => {
  const seen = [];
  const fixture = serviceFixture({ canonical: value => {
    seen.push(value);
    return value;
  } });
  const running = fixture.service.run({ command: "true", args: [], cwd: "/srv/work/sub", env: {} }, {});
  await Promise.resolve();
  fixture.channels[0].emitFrame({ type: "exit", code: 0, signal: null });
  fixture.channels[0].finish();
  await running;
  assert.deepEqual(seen, [{ root: "/srv/work", cwd: "/srv/work/sub" }]);
  assert.doesNotMatch(JSON.stringify(seen), /local-looking/);
});

test("omitted cwd defaults to the active remote workspace URI path", async () => {
  const seen = [];
  const fixture = serviceFixture({ canonical: value => {
    seen.push(value);
    return value;
  } });
  const running = fixture.service.run({ command: "true", args: [], env: {} }, {});
  await new Promise(resolve => setImmediate(resolve));
  if (!fixture.channels[0]) await running;
  fixture.channels[0].emitFrame({ type: "exit", code: 0, signal: null });
  fixture.channels[0].finish();
  await running;
  assert.deepEqual(seen, [{ root: "/srv/work", cwd: "/srv/work" }]);
  assert.equal(fixture.channels[0].request().cwd, "/srv/work");
});

test("arbitrary remote processes fail closed before opening a channel in an untrusted workspace", async () => {
  const fixture = serviceFixture({ trusted: false });
  const running = fixture.service.run({ command: "true", args: [], cwd: "/srv/work", env: {} }, {});
  await Promise.resolve();
  if (fixture.channels[0]) {
    fixture.channels[0].emitFrame({ type: "exit", code: 0, signal: null });
    fixture.channels[0].finish();
  }
  await assert.rejects(running, /trust/i);
  assert.equal(fixture.channels.length, 0);
});

test("remote process rejects canonical cwd outside the selected root including sibling prefixes", async () => {
  for (const escaped of ["/srv/work-escape", "/etc"]) {
    const fixture = serviceFixture({ canonical: () => ({ root: "/srv/work", cwd: escaped }) });
    await assert.rejects(
      fixture.service.run({ command: "true", args: [], cwd: "/srv/work/link", env: {} }, {}),
      /outside/i,
    );
    assert.equal(fixture.channels.length, 0);
  }
});

test("framed decoder rejects malformed, noncanonical, duplicate, and unterminated output", async () => {
  const cases = [
    channel => channel.emitBytes("not-json\n"),
    channel => channel.emitFrame({ type: "stdout", data: "YQ" }),
    channel => {
      channel.emitFrame({ type: "exit", code: 0, signal: null });
      channel.emitFrame({ type: "exit", code: 0, signal: null });
    },
    channel => channel.emitFrame({ type: "stdout", data: Buffer.from("no-exit").toString("base64") }),
    channel => channel.emitFrame({ type: "wat", data: "" }),
  ];
  for (const produce of cases) {
    const channel = new FakeChannel();
    const result = runFramedBridgeRequest(channel, {
      protocolVersion: 1, command: "true", args: [], cwd: "/srv/work", env: {},
    });
    produce(channel);
    channel.finish();
    await assert.rejects(result, /frame|base64|terminal|exit|JSON/i);
  }
});

test("a nonzero exit is a terminal result while an error frame rejects", async () => {
  const nonzero = new FakeChannel();
  const exited = runFramedBridgeRequest(nonzero, {
    protocolVersion: 1, command: "false", args: [], cwd: "/srv/work", env: {},
  });
  nonzero.emitFrame({ type: "stderr", data: Buffer.from("failed").toString("base64") });
  nonzero.emitFrame({ type: "exit", code: 17, signal: null });
  nonzero.finish({ code: 0, signal: null, error: null });
  assert.deepEqual(await exited, { code: 17, signal: null });

  const remoteError = new FakeChannel();
  const failed = runFramedBridgeRequest(remoteError, {
    protocolVersion: 1, command: "false", args: [], cwd: "/srv/work", env: {},
  });
  remoteError.emitFrame({ type: "error", message: "spawn failed" });
  remoteError.finish();
  await assert.rejects(failed, /spawn failed/);
});

test("cancellation closes only its bridge channel", async () => {
  const controller = new AbortController();
  const channel = new FakeChannel();
  const running = runFramedBridgeRequest(channel, {
    protocolVersion: 1, command: "sleep", args: ["60"], cwd: "/srv/work", env: {},
  }, {}, { signal: controller.signal });
  controller.abort(new Error("turn cancelled"));
  await assert.rejects(running, /cancel/i);
  assert.equal(channel.closed, 1);
});

test("SshSession leaves cancellation ownership to the framed request and removes its listener", async () => {
  class FakeSshProcess extends EventEmitter {
    constructor() {
      super();
      this.stdin = new PassThrough();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.killCalls = [];
    }

    kill(signal) {
      this.killCalls.push(signal);
      queueMicrotask(() => this.emit("close", null, signal));
      return true;
    }
  }

  for (const abortBeforeChannel of [false, true]) {
    const process = new FakeSshProcess();
    const session = new SshSession({ spawn: () => process });
    session.generation = 1;
    session.ready = {
      alias: "lab-a",
      generation: 1,
      controlPath: "/tmp/chatero-test-control",
      installRelativePath: `.chatero-server/artifacts-v1/${"b".repeat(64)}/${"a".repeat(40)}/linux-x86_64`,
    };
    const controller = new AbortController();
    if (abortBeforeChannel) controller.abort(new Error("turn cancelled before channel creation"));
    const channel = session.openProcessBridge({ signal: controller.signal });
    const running = runFramedBridgeRequest(channel, {
      protocolVersion: 1,
      command: "sleep",
      args: ["60"],
      cwd: "/srv/work",
      env: {},
    }, {}, { signal: controller.signal });

    if (!abortBeforeChannel) controller.abort(new Error("turn cancelled"));
    await assert.rejects(running, error => error?.name === "AbortError" && error?.code === "ABORT_ERR");
    assert.deepEqual(process.killCalls, ["SIGTERM"]);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("fixed helper process and stdin failures are classified as resumable SSH transport loss", async t => {
  for (const failure of ["process", "stdin"]) {
    await t.test(failure, async () => {
      class FakeSshProcess extends EventEmitter {
        constructor() {
          super();
          this.stdin = new PassThrough();
          this.stdout = new PassThrough();
          this.stderr = new PassThrough();
        }
        kill() { return true; }
      }
      const process = new FakeSshProcess();
      const session = new SshSession({ spawn: () => process });
      session.generation = 1;
      session.ready = {
        alias: "lab-a",
        generation: 1,
        hostFingerprint: `SHA256:${"A".repeat(43)}`,
        controlPath: "/tmp/chatero-test-control",
        installRelativePath: `.chatero-server/artifacts-v1/${"b".repeat(64)}/${"a".repeat(40)}/linux-x86_64`,
      };
      const channel = session.openEvidenceCache({
        generation: 1,
        hostFingerprint: session.ready.hostFingerprint,
      });
      const closed = new Promise(resolve => channel.onClose(resolve));
      const original = new Error("EPIPE /private/path must not become protocol data");
      if (failure === "process") process.emit("error", original);
      else process.stdin.emit("error", original);
      const result = await closed;
      assert.equal(result.error?.code, "SSH_TRANSPORT");
      assert.doesNotMatch(result.error?.message ?? "", /private|EPIPE/);
    });
  }
});

test("stale connection generations reject and ignore late bytes", async () => {
  const fixture = serviceFixture();
  const output = [];
  const running = fixture.service.run(
    { command: "long", args: [], cwd: "/srv/work", env: {} },
    { onStdout: value => output.push(value) },
  );
  await Promise.resolve();
  fixture.setGeneration(4);
  fixture.channels[0].emitFrame({ type: "stdout", data: Buffer.from("stale").toString("base64") });
  await assert.rejects(running, /stale|generation/i);
  assert.deepEqual(output, []);
  assert.equal(fixture.channels[0].closed, 1);
});

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  }
  finally {
    clearTimeout(timer);
  }
}

async function assertBridgeReapsStubbornDescendant(signal, { leaderExitsFirst = false } = {}) {
  const bridgePath = fileURLToPath(new URL("../remote-agent/runtime/chatero-process-bridge.mjs", import.meta.url));
  const bridge = spawn(process.execPath, [bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
  let leaderPid = null;
  let descendantPid = null;
  let buffered = "";
  const pids = new Promise((resolve, reject) => {
    bridge.stdout.on("data", bytes => {
      buffered += bytes.toString("utf8");
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const value = JSON.parse(line);
        if (value.type === "stdout") {
          const reported = JSON.parse(Buffer.from(value.data, "base64").toString("utf8").trim());
          leaderPid = reported.leaderPid;
          descendantPid = reported.descendantPid;
          resolve(reported);
        }
        if (value.type === "error") reject(new Error(value.message));
      }
    });
    bridge.once("error", reject);
  });
  bridge.stdin.write(`${JSON.stringify({
    protocolVersion: 1,
    command: process.execPath,
    args: ["-e", String.raw`
      const { spawn } = require("node:child_process");
      const source = ${JSON.stringify(String.raw`
        for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) process.on(signal, () => {});
        process.send?.("ready");
        setInterval(() => {}, 1000);
      `)};
      const descendant = spawn(process.execPath, ["-e", source], {
        stdio: ["ignore", ${leaderExitsFirst ? '"inherit"' : '"ignore"'}, ${leaderExitsFirst ? '"inherit"' : '"ignore"'}, "ipc"],
      });
      descendant.once("message", () => {
        console.log(JSON.stringify({ leaderPid: process.pid, descendantPid: descendant.pid }));
        ${leaderExitsFirst ? "setImmediate(() => process.exit(0));" : ""}
      });
      ${leaderExitsFirst ? "" : "setInterval(() => {}, 1000);"}
    `],
    cwd: "/",
    env: {},
  })}\n`);
  bridge.stdin.end();

  try {
    await withTimeout(pids, 3_000, "bridge descendants did not report their pids");
    if (leaderExitsFirst) {
      const deadline = Date.now() + 3_000;
      for (;;) {
        try { process.kill(leaderPid, 0); }
        catch (error) {
          if (error?.code === "ESRCH") break;
          throw error;
        }
        if (Date.now() >= deadline) throw new Error("bridge group leader did not exit first");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    bridge.kill(signal);
    await withTimeout(once(bridge, "exit"), 5_000, "bridge did not exit");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.throws(() => process.kill(descendantPid, 0), error => error?.code === "ESRCH");
  }
  finally {
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill("SIGKILL");
    if (leaderPid) {
      try { process.kill(-leaderPid, "SIGKILL"); }
      catch {}
    }
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL"); }
      catch {}
    }
  }
}

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  test(`the process bridge reaps an ignoring descendant group on ${signal}`,
    { skip: process.platform === "win32" }, () => assertBridgeReapsStubbornDescendant(signal));
}

test("the process bridge kills a surviving group after its leader exits before SIGHUP",
  { skip: process.platform === "win32" }, () =>
    assertBridgeReapsStubbornDescendant("SIGHUP", { leaderExitsFirst: true }));
