import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

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
  });
});

test("the extension registers the native managed authority and publishes the bounded API", async () => {
  const source = await readFile(new URL("extension.cjs", extensionRoot), "utf8");
  assert.match(source, /registerRemoteAuthorityResolver\("chatero-remote"/);
  assert.match(source, /new vscode\.ManagedResolvedAuthority/);
  for (const method of ["ensureAuthoritySession", "getActiveSession", "runProcess", "stageEvidence", "revokeEvidence"]) {
    assert.match(source, new RegExp(method));
  }
  assert.doesNotMatch(source, /StrictHostKeyChecking=no|password|Microsoft Remote/i);
  assert.match(source, /showErrorMessage/);
  assert.match(source, /Show Remote Log/);
  assert.match(source, /createStatusBarItem/);
  assert.match(source, /chooseRemoteWorkspace/);
  assert.match(source, /new remoteProcess\.RemoteProcessService/);
  assert.match(source, /isWorkspaceTrusted:\s*\(\)\s*=>\s*vscode\.workspace\.isTrusted/);
  assert.match(source, /vscode\.Uri\.from/);
  assert.match(source, /vscode\.openFolder/);
});

test("first-party materialization and product proposal allowlist include chatero.remote exactly", async () => {
  const manifest = JSON.parse(await readFile(new URL("../first-party-extensions.json", import.meta.url), "utf8"));
  const remote = manifest.extensions.find(extension => extension.id === "chatero.remote");
  assert.ok(remote);
  const destinations = remote.files.map(file => file.destination).sort();
  const actualFiles = [
    "authority.mjs",
    "extension.cjs",
    "managed-connection.mjs",
    "media/remote.svg",
    "openssh-targets.mjs",
    "package.json",
    "remote-agent-installer.mjs",
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
  assert.deepEqual(product.extensionEnabledApiProposals, { [actualExtensionId]: ["resolvers"] });
  const serialized = JSON.stringify(product);
  assert.doesNotMatch(serialized, /marketplace\.visualstudio\.com|ms-vscode-remote\.remote-ssh|ms-python\.vscode-pylance/i);
});

test("remote indicator contribution uses Code-OSS remote group grammar", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", extensionRoot), "utf8"));
  const entries = manifest.contributes.menus["statusBar/remoteIndicator"];
  assert.equal(entries.length, 1);
  assert.match(entries[0].group, /^remote_\d\d_[a-z][a-z0-9+.-]*_.+$/);
  assert.equal(entries[0].group.includes("chatero-remote"), true);
});

test("agent launch policy enables only the embedded Codex SDK and a private agent-host path", async () => {
  const source = await readFile(new URL("remote-agent-installer.mjs", extensionRoot), "utf8");
  assert.match(source, /--agent-host-path/);
  assert.match(source, /VSCODE_AGENT_HOST_CODEX_AGENT_ENABLED/);
  assert.match(source, /VSCODE_AGENT_HOST_CODEX_SDK_ROOT/);
  assert.match(source, /VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED/);
  assert.match(source, /VSCODE_AGENT_HOST_BYOK_MODELS_ENABLED/);
  assert.doesNotMatch(source, /--agent-host-port=0/);
});
