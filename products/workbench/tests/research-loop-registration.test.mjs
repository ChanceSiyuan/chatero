import assert from "node:assert/strict";
import { test } from "node:test";

import { registerResearchLoop } from "../extensions/chatero-documentation/research-loop-registration.mjs";

test("Research Loop registers six real handlers over the cross-host Zotero boundary", async () => {
  const commands = new Map();
  const executed = [];
  const scope = {};
  const services = {
    capabilities: { issueAgentProposalGrant: () => ({}) }, randomUUID: () => "id", scope,
    transactions: { stage: async () => ({ kind: "generation-staged" }), state: async () => ({ documents: {} }) },
    workspaceFolderUri: { scheme: "file", authority: "", path: "/repo", with(changes) { return { ...this, ...changes }; } },
  };
  const vscode = {
    ViewColumn: { Active: 1 },
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return { dispose() {} }; },
      async executeCommand(...args) { executed.push(args); if (args[0] === "chatero.zotero.research.activeObject") return { kind: "item", itemKey: "ITEM0001", libraryId: 1, title: "Paper" }; },
    },
    window: {
      createWebviewPanel: () => ({ webview: { html: "" } }),
      showInputBox: async () => "imports/note.qmd",
      showQuickPick: async items => items[0],
    },
    workspace: { fs: {}, isTrusted: true, openTextDocument: async () => ({ getText: () => "" }) },
    Uri: { joinPath: () => ({}) },
  };
  const registrations = await registerResearchLoop({ services, vscode });
  assert.equal(registrations.length, 6);
  assert.equal(commands.size, 6);
  await commands.get("chatero.research.runAction")();
  assert.deepEqual(executed.map(value => value[0]), ["chatero.zotero.research.activeObject", "workbench.action.chat.open"]);
});
