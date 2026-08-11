import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  RemoteProcessService,
  runFramedBridgeRequest,
} from "../extensions/chatero-remote/remote-process.mjs";

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

test("the process bridge reaps a detached child group on SIGHUP", { skip: process.platform === "win32" }, async () => {
  const bridgePath = fileURLToPath(new URL("../remote-agent/runtime/chatero-process-bridge.mjs", import.meta.url));
  const bridge = spawn(process.execPath, [bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
  let childPid = null;
  let buffered = "";
  const pid = new Promise((resolve, reject) => {
    bridge.stdout.on("data", bytes => {
      buffered += bytes.toString("utf8");
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const value = JSON.parse(line);
        if (value.type === "stdout") {
          childPid = Number(Buffer.from(value.data, "base64").toString("utf8").trim());
          resolve(childPid);
        }
        if (value.type === "error") reject(new Error(value.message));
      }
    });
    bridge.once("error", reject);
  });
  bridge.stdin.write(`${JSON.stringify({
    protocolVersion: 1,
    command: process.execPath,
    args: ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
    cwd: "/",
    env: {},
  })}\n`);
  bridge.stdin.end();

  try {
    await Promise.race([
      pid,
      new Promise((_, reject) => setTimeout(() => reject(new Error("bridge child did not report its pid")), 3_000)),
    ]);
    bridge.kill("SIGHUP");
    await Promise.race([
      once(bridge, "exit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("bridge did not exit")), 3_000)),
    ]);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.throws(() => process.kill(childPid, 0), error => error?.code === "ESRCH");
  }
  finally {
    if (bridge.exitCode === null && bridge.signalCode === null) bridge.kill("SIGKILL");
    if (childPid) {
      try { process.kill(-childPid, "SIGKILL"); }
      catch {}
    }
  }
});
