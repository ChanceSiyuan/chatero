import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { encodeAuthority } from "../extensions/chatero-remote/authority.mjs";
import { makeCodexLoginTerminalOptions } from "../extensions/chatero-remote/ssh-session.mjs";

const extensionRoot = new URL("../extensions/chatero-remote/", import.meta.url);

test("remote resolver manifest is a local proposed-API UI extension", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", extensionRoot), "utf8"));
  assert.equal(manifest.name, "chatero-remote");
  assert.equal(manifest.publisher, "chatero");
  assert.deepEqual(manifest.extensionKind, ["ui"]);
  assert.deepEqual(manifest.enabledApiProposals, ["resolvers"]);
  assert.deepEqual(manifest.activationEvents, ["onResolveRemoteAuthority:chatero-remote"]);
  assert.equal(JSON.stringify(manifest).includes("remote-ssh"), false);
  assert.equal(JSON.stringify(manifest).includes("marketplace.visualstudio.com"), false);
  const commands = Object.fromEntries(manifest.contributes.commands.map(value => [value.command, value.title]));
  assert.deepEqual(commands, {
    "chatero.remote.connect": "Connect to SSH…",
    "chatero.remote.openFolder": "Open Remote Folder…",
    "chatero.remote.reconnect": "Reconnect",
    "chatero.remote.showLog": "Show Remote Log",
    "chatero.remote.openLoginTerminal": "Open SSH Login Terminal",
    "chatero.remote.codexLogin": "Sign In to Codex with Device Authentication",
  });
  assert.equal(
    manifest.contributes.commands.find(value => value.command === "chatero.remote.codexLogin")?.enablement,
    "remoteName == chatero-remote",
  );
});

test("Codex device authentication opens only the fixed bundled remote binary", async () => {
  const commit = "df53daabb18cd157bdb08c7f01c34df936cf12f4";
  const artifactSha256 = "b".repeat(64);
  const cwd = Object.freeze({
    scheme: "vscode-remote",
    authority: encodeAuthority("profile:lab-a"),
    path: "/srv/project",
  });
  const installPath = `/home/alice/.chatero-server/artifacts-v1/${artifactSha256}/${commit}/linux-x86_64`;
  const options = makeCodexLoginTerminalOptions({
    codeOssCommit: commit,
    artifactSha256,
    installPath,
    tuple: "linux-x86_64",
    cwd,
  });
  assert.deepEqual(options, {
    name: "Codex login",
    shellPath: `${installPath}/agent-sdk/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`,
    shellArgs: ["login", "--device-auth"],
    cwd,
  });
  assert.throws(() => makeCodexLoginTerminalOptions({
    codeOssCommit: "a".repeat(40),
    artifactSha256,
    installPath,
    tuple: "linux-x86_64",
    cwd,
  }), /pinned Code-OSS commit/);
  assert.throws(() => makeCodexLoginTerminalOptions({
    codeOssCommit: commit,
    artifactSha256,
    installPath,
    tuple: "linux-riscv64",
    cwd,
  }), /remote tuple/);

  const created = [];
  const vscode = {
    window: {
      createTerminal(value) {
        const terminal = { shown: 0, show() { this.shown++; } };
        created.push({ value, terminal });
        return terminal;
      },
    },
  };
  const require = createRequire(import.meta.url);
  const extensionPath = fileURLToPath(new URL("../extensions/chatero-remote/extension.cjs", import.meta.url));
  delete require.cache[require.resolve(extensionPath)];
  const originalLoad = Module._load;
  let extension;
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    extension = require(extensionPath);
  }
  finally {
    Module._load = originalLoad;
  }
  const session = {
    getCodexLoginTerminalOptions(requestedCwd) {
      assert.equal(requestedCwd, cwd);
      return options;
    },
  };
  const terminal = extension.openCodexLoginTerminal(session, { uri: cwd });
  assert.equal(terminal.shown, 1);
  assert.deepEqual(created.map(value => value.value), [options]);
  assert.throws(
    () => extension.openCodexLoginTerminal(session, { uri: { ...cwd, scheme: "file" } }),
    /active Chatero SSH workspace/,
  );
});

test("the extension registers the native managed authority and publishes the bounded API", async () => {
  const source = await readFile(new URL("extension.cjs", extensionRoot), "utf8");
  assert.match(source, /registerRemoteAuthorityResolver\("chatero-remote"/);
  assert.match(source, /new vscode\.ManagedResolvedAuthority/);
  for (const method of ["getActiveSession", "runProcess", "stageEvidence", "revokeEvidence"]) {
    assert.match(source, new RegExp(method));
  }
  const publicApi = source.slice(source.lastIndexOf("\n  return Object.freeze({"));
  assert.deepEqual(
    [...publicApi.matchAll(/^ {4}(?:async )?([A-Za-z][A-Za-z0-9]*)\(/gmu)].map(match => match[1]),
    ["getActiveSession", "runProcess", "stageEvidence", "revokeEvidence"],
  );
  assert.doesNotMatch(publicApi, /ensureAuthoritySession|openProcessBridge/);
  assert.doesNotMatch(source, /StrictHostKeyChecking=no|password|Microsoft Remote/i);
  assert.match(source, /showErrorMessage/);
  assert.match(source, /Show Remote Log/);
  assert.match(source, /createStatusBarItem/);
  assert.match(source, /chooseRemoteWorkspace/);
  // Long connects and staging transfers must be cancellable from their progress
  // notification, not only observable as a spinning status-bar item.
  assert.match(source, /vscode\.window\.withProgress\(\{/);
  assert.match(source, /cancellable: true/);
  assert.match(source, /new remoteProcess\.RemoteProcessService/);
  assert.match(source, /new evidenceModule\.EvidenceCacheService/);
  assert.match(source, /new evidenceControllerModule\.RemoteEvidenceController/);
  assert.doesNotMatch(source, /pendingFeature\("Remote evidence cache"\)/);
  assert.match(source, /isWorkspaceTrusted:\s*\(\)\s*=>\s*vscode\.workspace\.isTrusted/);
  assert.match(source, /vscode\.Uri\.from/);
  assert.match(source, /vscode\.openFolder/);
});

test("extension activation derives status from the real remote workspace without cached candidate state", async () => {
  const commands = new Map();
  const workspaceListeners = new Set();
  const status = {
    text: "",
    tooltip: "",
    command: null,
    backgroundColor: undefined,
    shown: 0,
    hidden: 0,
    show() { this.shown++; },
    hide() { this.hidden++; },
    dispose() {},
  };
  const output = { appendLine() {}, show() {}, dispose() {} };
  const authority = encodeAuthority("profile:lab-a");
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    ThemeColor: class ThemeColor {},
    window: {
      createOutputChannel: () => output,
      createStatusBarItem: () => status,
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: "vscode-remote", authority, path: "/srv/a" } }],
      registerRemoteAuthorityResolver: () => ({ dispose() {} }),
      onDidChangeWorkspaceFolders(listener) {
        workspaceListeners.add(listener);
        return { dispose: () => workspaceListeners.delete(listener) };
      },
    },
    commands: {
      registerCommand(id, callback) {
        commands.set(id, callback);
        return { dispose: () => commands.delete(id) };
      },
      executeCommand: async () => undefined,
    },
    Uri: { from: value => Object.freeze({ ...value }) },
  };
  const context = {
    subscriptions: [],
    globalState: {
      get: () => [],
      update: async () => undefined,
    },
    asAbsolutePath: value => value,
  };
  const require = createRequire(import.meta.url);
  const extensionPath = fileURLToPath(new URL("../extensions/chatero-remote/extension.cjs", import.meta.url));
  delete require.cache[require.resolve(extensionPath)];
  const originalLoad = Module._load;
  let extension;
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    extension = require(extensionPath);
  }
  finally {
    Module._load = originalLoad;
  }

  const api = await extension.activate(context);
  assert.deepEqual(Object.keys(api), ["getActiveSession", "runProcess", "stageEvidence", "revokeEvidence"]);
  assert.match(status.text, /Reconnect.*lab-a/i);
  assert.match(String(status.tooltip), /\/srv\/a/);
  assert.equal(commands.has("chatero.remote.connect"), true);

  vscode.workspace.workspaceFolders = [];
  for (const listener of workspaceListeners) listener();
  assert.equal(status.hidden, 1);
  for (const disposable of context.subscriptions.reverse()) disposable?.dispose?.();
});

test("first-party materialization and product proposal allowlist include chatero.remote exactly", async () => {
  const manifest = JSON.parse(await readFile(new URL("../first-party-extensions.json", import.meta.url), "utf8"));
  const remote = manifest.extensions.find(extension => extension.id === "chatero.remote");
  assert.ok(remote);
  const destinations = remote.files.map(file => file.destination).sort();
  const actualFiles = [
    "authority.mjs",
    "evidence-cache.mjs",
    "extension.cjs",
    "managed-connection.mjs",
    "media/remote.svg",
    "openssh-targets.mjs",
    "package.json",
    "remote-agent-installer.mjs",
    "remote-evidence-controller.mjs",
    "remote-process.mjs",
    "remote-workspace.mjs",
    "runtime/release-contract.mjs",
    "runtime/release-public-key.pem",
    "ssh-session.mjs",
  ].map(path => `extensions/chatero-remote/${path}`).sort();
  assert.deepEqual(destinations, actualFiles);

  const product = JSON.parse(await readFile(new URL("../product.chatero.json", import.meta.url), "utf8"));
  const packageManifest = JSON.parse(await readFile(new URL("package.json", extensionRoot), "utf8"));
  const actualExtensionId = `${packageManifest.publisher}.${packageManifest.name}`;
  assert.deepEqual(product.extensionEnabledApiProposals, {
    [actualExtensionId]: ["resolvers"],
    "chatero.chatero-zotero": ["chatContextProvider"],
    "vscode.mermaid-markdown-features": ["chatOutputRenderer", "chatParticipantPrivate"],
  });
  const serialized = JSON.stringify(product);
  assert.doesNotMatch(serialized, /marketplace\.visualstudio\.com|ms-vscode-remote\.remote-ssh|ms-python\.vscode-pylance/i);
});

test("remote indicator contribution uses Code-OSS remote group grammar", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", extensionRoot), "utf8"));
  const entries = manifest.contributes.menus["statusBar/remoteIndicator"];
  assert.deepEqual(entries.map(value => [value.command, value.when]), [
    ["chatero.remote.connect", "remoteName != chatero-remote"],
    ["chatero.remote.openFolder", "remoteName == chatero-remote"],
    ["chatero.remote.reconnect", "remoteName == chatero-remote"],
    ["chatero.remote.showLog", "remoteName == chatero-remote"],
  ]);
  for (const entry of entries) {
    assert.match(entry.group, /^remote_\d\d_[a-z][a-z0-9+.-]*_.+$/);
    assert.equal(entry.group.includes("chatero-remote"), true);
  }
});

test("agent launch policy enables only the embedded Codex SDK and a private agent-host path", async () => {
  const source = await readFile(new URL("remote-agent-installer.mjs", extensionRoot), "utf8");
  assert.match(source, /--agent-host-path/);
  assert.match(source, /VSCODE_AGENT_HOST_CODEX_AGENT_ENABLED/);
  assert.match(source, /VSCODE_AGENT_HOST_CODEX_SDK_ROOT/);
  assert.match(source, /VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED/);
  assert.match(source, /VSCODE_AGENT_HOST_BYOK_MODELS_ENABLED/);
  assert.match(source, /codex-linux-(?:x64|arm64)/);
  assert.match(source, /printf '%s\\\\n%s\\\\n%s\\\\n'.*\$install/);
  assert.doesNotMatch(source, /--agent-host-port=0/);
});
