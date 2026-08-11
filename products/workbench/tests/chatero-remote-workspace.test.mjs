import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeAuthority } from "../extensions/chatero-remote/authority.mjs";
import {
  canonicalizeWorkspaceCwd,
  chooseRemoteWorkspace,
  createWorkspace,
  formatRemoteFailure,
  formatRemoteStatus,
  probeWorkspace,
  sanitizeRecentTargets,
  selectActiveSessionAuthority,
  validateRemoteWorkspacePath,
} from "../extensions/chatero-remote/remote-workspace.mjs";

function frame(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

class ScriptedBridgeChannel {
  constructor(respond) {
    this.generation = 7;
    this.respond = respond;
    this.writes = [];
    this.dataListeners = new Set();
    this.closeListeners = new Set();
    this.closeCount = 0;
  }

  write(bytes) {
    this.writes.push(Buffer.from(bytes));
    return true;
  }

  end() {
    queueMicrotask(() => {
      const input = Buffer.concat(this.writes);
      const newline = input.indexOf(0x0a);
      const request = JSON.parse(input.subarray(0, newline).toString("utf8"));
      const stdin = input.subarray(newline + 1);
      const result = this.respond({ request, stdin });
      for (const listener of this.dataListeners) {
        listener(frame({ type: "stdout", data: Buffer.from(`${JSON.stringify(result)}\n`).toString("base64") }));
        listener(frame({ type: "exit", code: 0, signal: null }));
      }
      for (const listener of this.closeListeners) listener({ code: 0, signal: null, error: null });
    });
  }

  onData(listener) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onClose(listener) {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  close() {
    this.closeCount++;
    for (const listener of this.closeListeners) {
      listener({ code: null, signal: "SIGTERM", error: null });
    }
  }
}

function helperSession(respond) {
  const channels = [];
  return {
    alias: "lab-a",
    generation: 7,
    channels,
    openProcessBridge() {
      const channel = new ScriptedBridgeChannel(respond);
      channels.push(channel);
      return channel;
    },
  };
}

function decodeHelperInput(stdin) {
  const payload = JSON.parse(stdin.toString("utf8"));
  const decode = encoded => Buffer.from(encoded, "base64url").toString("utf8");
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, decode(value)]));
}

test("remote workspace paths accept arbitrary POSIX folders and reject controls or relative paths", () => {
  assert.equal(validateRemoteWorkspacePath("/srv/empty research/量子"), "/srv/empty research/量子");
  for (const value of ["srv/work", "C:\\work", "", "/srv/a\0b", "/srv/a\nb", "/srv/a\rb", "/srv/a\tb"]) {
    assert.throws(() => validateRemoteWorkspacePath(value), /absolute|control/i);
  }
});

test("workspace probe and creation transmit paths only as canonical base64url stdin data", async () => {
  const operations = [];
  const session = helperSession(({ request, stdin }) => {
    const operation = request.args.at(-1);
    operations.push({ request, stdin: JSON.parse(stdin.toString("utf8")), decoded: decodeHelperInput(stdin) });
    return operation === "probe" ? { state: "missing" } : { created: true };
  });

  assert.equal(await probeWorkspace(session, "/srv/research; rm -rf x"), "missing");
  await createWorkspace(session, "/srv/research; rm -rf x");

  assert.deepEqual(operations.map(value => value.request.command), ["/proc/self/exe", "/proc/self/exe"]);
  assert.deepEqual(operations.map(value => value.request.args.at(-1)), ["probe", "create"]);
  assert.deepEqual(operations.map(value => value.decoded.path), [
    "/srv/research; rm -rf x",
    "/srv/research; rm -rf x",
  ]);
  assert.ok(operations.every(value => !JSON.stringify(value.request).includes("/srv/research")));
  assert.ok(operations.every(value => /^[A-Za-z0-9_-]+$/u.test(value.stdin.path)));
});

test("an empty arbitrary directory opens after confirmation without QLab markers", async () => {
  const calls = [];
  const persisted = [];
  const target = { id: "profile:lab-a", alias: "lab-a", lastPath: "/srv/empty-research" };
  const authority = encodeAuthority(target.id);
  const session = { alias: "lab-a", generation: 4, hostFingerprint: `SHA256:${"A".repeat(43)}` };

  const folder = await chooseRemoteWorkspace({
    selectTarget: async () => target,
    promptPath: async value => {
      calls.push(["prompt", value]);
      return "/srv/empty-research";
    },
    ensureAuthoritySession: async (value, options) => {
      calls.push(["ensure", value, options.signal]);
      return { session, hostFingerprint: session.hostFingerprint };
    },
    probe: async (value, path) => {
      calls.push(["probe", value, path]);
      return "missing";
    },
    confirmCreate: async ({ alias, path }) => {
      calls.push(["confirm", alias, path]);
      return true;
    },
    create: async (value, path) => calls.push(["create", value, path]),
    uriFrom: parts => Object.freeze({ ...parts }),
    openFolder: async (uri, options) => calls.push(["open", uri, options]),
    persistRecent: async record => persisted.push(record),
  });

  assert.equal(folder.uri.scheme, "vscode-remote");
  assert.equal(folder.uri.authority, authority);
  assert.equal(folder.uri.path, "/srv/empty-research");
  assert.deepEqual(folder.created, ["/srv/empty-research"]);
  assert.equal(folder.checkedForQlab, false);
  assert.ok(calls.findIndex(value => value[0] === "ensure") < calls.findIndex(value => value[0] === "probe"));
  assert.equal(calls.filter(value => value[0] === "ensure").length, 1);
  assert.deepEqual(calls.find(value => value[0] === "open").at(-1), { forceReuseWindow: true });
  assert.deepEqual(persisted, [{
    targetId: "profile:lab-a",
    alias: "lab-a",
    lastPath: "/srv/empty-research",
    hostFingerprint: session.hostFingerprint,
  }]);
  assert.doesNotMatch(JSON.stringify(persisted), /password|token|pdf|keyContents/i);
});

test("declining creation or selecting a file performs no write and opens no folder", async () => {
  for (const state of ["missing", "file"]) {
    const mutations = [];
    const input = {
      selectTarget: async () => ({ id: "profile:lab-a", alias: "lab-a" }),
      promptPath: async () => "/srv/not-a-folder",
      ensureAuthoritySession: async () => ({ session: {} }),
      probe: async () => state,
      confirmCreate: async () => false,
      create: async () => mutations.push("create"),
      uriFrom: value => value,
      openFolder: async () => mutations.push("open"),
      persistRecent: async () => mutations.push("persist"),
    };
    if (state === "missing") assert.equal(await chooseRemoteWorkspace(input), null);
    else await assert.rejects(chooseRemoteWorkspace(input), /file/i);
    assert.deepEqual(mutations, []);
  }
});

test("remote canonicalization rejects sibling-prefix and symlink escapes", async () => {
  const values = [
    { root: "/srv/work", cwd: "/srv/work/sub" },
    { root: "/srv/work", cwd: "/srv/work-escape" },
    { root: "/srv/work", cwd: "/etc" },
  ];
  const session = helperSession(({ stdin }) => values.shift());

  assert.deepEqual(await canonicalizeWorkspaceCwd(session, "/srv/work", "/srv/work/sub"), {
    root: "/srv/work",
    cwd: "/srv/work/sub",
  });
  await assert.rejects(canonicalizeWorkspaceCwd(session, "/srv/work", "/srv/work/link"), /outside/i);
  await assert.rejects(canonicalizeWorkspaceCwd(session, "/srv/work", "/srv/work/sub"), /outside/i);
});

test("recent target persistence retains only opaque identity, alias, path, and fingerprint", () => {
  const sanitized = sanitizeRecentTargets([
    {
      targetId: "profile:lab-a",
      alias: "lab-a",
      lastPath: "/srv/work",
      hostFingerprint: `SHA256:${"A".repeat(43)}`,
      password: "must disappear",
      connectionToken: "must disappear",
      pdfContext: "must disappear",
    },
    { targetId: "profile:lab-a", alias: "duplicate", lastPath: "/ignored", hostFingerprint: null },
    { targetId: "profile:bad alias", alias: "bad alias", lastPath: "relative", hostFingerprint: "bad" },
  ]);
  assert.deepEqual(sanitized, [{
    targetId: "profile:lab-a",
    alias: "lab-a",
    lastPath: "/srv/work",
    hostFingerprint: `SHA256:${"A".repeat(43)}`,
  }]);
  assert.doesNotMatch(JSON.stringify(sanitized), /password|token|pdf/i);
});

test("remote status formatter exposes connecting, connected, reconnecting, and error states", () => {
  assert.deepEqual(formatRemoteStatus("connecting", { alias: "lab-a" }), {
    text: "$(sync~spin) Connecting to lab-a",
    tooltip: "Chatero Remote is connecting to lab-a",
    command: "chatero.remote.showLog",
    isError: false,
  });
  const connected = formatRemoteStatus("connected", { alias: "lab-a", path: "/srv/research" });
  assert.match(connected.text, /lab-a/);
  assert.match(connected.tooltip, /\/srv\/research/);
  const reconnecting = formatRemoteStatus("reconnecting", { alias: "lab-a", path: "/srv/research" });
  assert.match(reconnecting.text, /Reconnect/i);
  assert.match(reconnecting.tooltip, /\/srv\/research/);
  assert.equal(formatRemoteStatus("error", { alias: "lab-a" }).isError, true);
});

test("remote UI failures never interpolate transport details, tokens, paths, or controls", () => {
  const hostile = Object.assign(new Error("token=secret\n/private/id_ed25519\u0007"), {
    code: "UNCLASSIFIED_REMOTE_FAILURE",
  });
  for (const operation of ["resolve", "connect", "open-folder", "reconnect", "login"]) {
    const failure = formatRemoteFailure(operation, { alias: "lab-a", error: hostile });
    assert.doesNotMatch(JSON.stringify(failure), /secret|id_ed25519|private|\u0007/i);
    assert.doesNotMatch(failure.message, /[\u0000-\u001f\u007f]/u);
    assert.match(failure.message, /lab-a|cancelled/i);
  }
});

test("candidate connections never replace the authority of the actual workspace", () => {
  const authorityA = encodeAuthority("profile:lab-a");
  const authorityB = encodeAuthority("profile:lab-b");
  const folders = [{ uri: { scheme: "vscode-remote", authority: authorityA, path: "/srv/a" } }];

  // A picker may authenticate B before the user declines folder creation. The
  // default authority remains derived solely from the actual A workspace.
  const connectedCandidate = authorityB;
  assert.ok(connectedCandidate);
  assert.equal(selectActiveSessionAuthority(undefined, folders), authorityA);
  assert.equal(selectActiveSessionAuthority(undefined, []), null);
  assert.equal(selectActiveSessionAuthority(authorityB, folders), authorityB);
});
