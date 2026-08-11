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
});

test("the extension registers the native managed authority and publishes the bounded API", async () => {
  const source = await readFile(new URL("extension.cjs", extensionRoot), "utf8");
  assert.match(source, /registerRemoteAuthorityResolver\("chatero-remote"/);
  assert.match(source, /new vscode\.ManagedResolvedAuthority/);
  for (const method of ["ensureAuthoritySession", "getActiveSession", "runProcess", "stageEvidence", "revokeEvidence"]) {
    assert.match(source, new RegExp(method));
  }
  assert.doesNotMatch(source, /StrictHostKeyChecking=no|password|Microsoft Remote/i);
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
    "runtime/release-contract.mjs",
    "runtime/release-public-key.pem",
    "ssh-session.mjs",
  ].map(path => `extensions/chatero-remote/${path}`).sort();
  assert.deepEqual(destinations, actualFiles);

  const product = JSON.parse(await readFile(new URL("../product.chatero.json", import.meta.url), "utf8"));
  assert.deepEqual(product.extensionEnabledApiProposals, { "chatero.remote": ["resolvers"] });
  const serialized = JSON.stringify(product);
  assert.doesNotMatch(serialized, /marketplace\.visualstudio\.com|ms-vscode-remote\.remote-ssh|ms-python\.vscode-pylance/i);
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
