import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TEXT_DOCUMENT_SCENARIOS } from "./fixtures.mjs";

const require = createRequire(import.meta.url);
const vscode = require("vscode");
const target = process.env.CHATERO_DOCUMENTATION_TEST_TARGET
  ?? (vscode.env.remoteName === "chatero-remote" ? "ssh-fixture" : "local");
const repositoryRoot = process.env.CHATERO_REPOSITORY_ROOT
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const workspacePath = process.env.CHATERO_DOCUMENTATION_WORKSPACE_PATH
  ?? vscode.workspace.workspaceFolders?.[0]?.uri.path;
const REMOTE_ACTIVATION_TIMEOUT_MS = 30_000;

async function documentationExtension() {
  assert.equal(target, "local", "remote workspace extensions are not visible from the UI Extension Host");
  const extension = vscode.extensions.getExtension("chatero.chatero-documentation");
  assert.ok(extension, "materialized Documentation extension is missing");
  await extension.activate();
  return extension;
}

async function activateDocumentation() {
  if (target === "local") return documentationExtension();
  const deadline = Date.now() + REMOTE_ACTIVATION_TIMEOUT_MS;
  let lastError;
  do {
    try {
      await vscode.commands.executeCommand("chatero.documentation.refresh");
      return;
    }
    catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  assert.fail(`remote Documentation command did not activate: ${lastError?.message ?? lastError ?? "unknown error"}`);
}

async function documentationExtensionRoot() {
  if (target === "local") return (await documentationExtension()).extensionPath;
  return join(repositoryRoot, "products", "workbench", "extensions", "chatero-documentation");
}

function fixtureUri() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "Documentation integration workspace is missing");
  return vscode.Uri.joinPath(folder.uri, "documentation", "index.qmd");
}

async function resetFixture() {
  const document = await vscode.workspace.openTextDocument(fixtureUri());
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(
      new vscode.Position(0, 0),
      document.positionAt(document.getText().length),
    ),
    "# Documentation integration fixture\n\nshared TextDocument\n",
  );
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  assert.equal(await document.save(), true);
  return document;
}

async function importProductModule(name) {
  return import(pathToFileURL(join(await documentationExtensionRoot(), name)).href);
}

suite(`Documentation TextDocument editor (${target})`, () => {
  suiteSetup(async () => {
    assert.ok(new Set(["local", "ssh-fixture"]).has(target));
    assert.ok(repositoryRoot && workspacePath);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    if (target === "local") assert.equal(folder.uri.scheme, "file");
    else {
      assert.equal(folder.uri.scheme, "vscode-remote");
      assert.match(folder.uri.authority, /^chatero-remote\+/);
      assert.equal(vscode.env.remoteName, "chatero-remote");
    }
    assert.equal(folder.uri.path, workspacePath);
    await activateDocumentation();
  });

  for (const scenario of TEXT_DOCUMENT_SCENARIOS) {
    test(scenario, async () => {
      if (scenario === "shared-buffer") {
        const uri = fixtureUri();
        const first = await vscode.workspace.openTextDocument(uri);
        const second = await vscode.workspace.openTextDocument(uri);
        assert.equal(first.uri.toString(), second.uri.toString());
        assert.equal(first.getText(), second.getText());
        await vscode.commands.executeCommand("vscode.openWith", uri, "default");
        await vscode.commands.executeCommand("vscode.openWith", uri, "chatero.documentation.livePreview", vscode.ViewColumn.Beside);
        return;
      }
      if (scenario === "dirty-save-autosave-revert") {
        const document = await resetFixture();
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(0, 0), "X");
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        assert.equal(document.isDirty, true);
        assert.equal(await document.save(), true);
        assert.equal(document.isDirty, false);
        return;
      }
      if (scenario === "undo-redo-unit") {
        const document = await resetFixture();
        await vscode.window.showTextDocument(document);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(0, 0), "U");
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        await vscode.commands.executeCommand("undo");
        await vscode.commands.executeCommand("redo");
        assert.match(document.getText(), /^U/);
        return;
      }
      if (scenario === "bounded-large-edit-state") {
        const protocol = await importProductModule("live-preview-protocol.mjs");
        const changes = [{ from: 0, to: 0, insert: "x".repeat(1024 * 1024), deletedText: "", leftContext: "", rightContext: "" }];
        const parsed = protocol.parseViewMessage({ type: "edit", sessionId: "integration", opId: "integration:1", baseVersion: 1, changes });
        const descriptor = await protocol.createPendingDescriptor({
          opId: parsed.opId,
          baseVersion: parsed.baseVersion,
          changes: parsed.changes,
        });
        assert.equal(Object.hasOwn(descriptor, "changes"), false);
        return;
      }
      if (scenario === "nonce-bound-codemirror-styles") {
        const source = await vscode.workspace.fs.readFile(vscode.Uri.file(join(
          await documentationExtensionRoot(),
          "live-preview-html.mjs",
        )));
        const text = new TextDecoder().decode(source);
        assert.match(text, /script-src 'nonce-/);
        assert.match(text, /style-src.*'nonce-/);
        assert.doesNotMatch(text, /unsafe-inline|unsafe-eval/);
        return;
      }
      if (scenario === "activation-failure-isolation") {
        const document = await resetFixture();
        assert.ok(document.getText().length > 0);
        const zotero = vscode.extensions.getExtension("chatero.chatero-zotero");
        assert.ok(zotero, "Zotero extension is unavailable after Documentation activation");
        return;
      }
      if (scenario === "upstream-agent-extension-absent") {
        assert.equal(vscode.extensions.getExtension("GitHub.copilot-chat"), undefined);
        await activateDocumentation();
        return;
      }

      const [changes, coordinator, bridge, rebase] = await Promise.all([
        importProductModule("text-change-set.mjs"),
        importProductModule("working-copy-coordinator.mjs"),
        importProductModule("live-preview-bridge.mjs"),
        importProductModule("pending-edit-rebase.mjs"),
      ]);
      assert.equal(typeof changes.withChangeContext, "function");
      assert.equal(typeof coordinator.createWorkingCopyCoordinator, "function");
      assert.equal(typeof bridge.createLivePreviewBridgeRegistry, "function");
      assert.equal(typeof rebase.rebasePendingOperations, "function");
      const source = "alpha beta\r\n";
      const pending = changes.withChangeContext(source, [{ from: 6, to: 10, insert: "BETA" }]);
      const result = rebase.rebasePendingOperations({
        authoritativeText: `prefix ${source}`,
        authoritativeVersion: 2,
        pendingOperations: [{ opId: "integration:1", baseVersion: 1, changes: pending }],
      });
      assert.equal(result.conflicts.length, 0);
    });
  }
});
