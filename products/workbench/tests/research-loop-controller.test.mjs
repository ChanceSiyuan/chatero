import assert from "node:assert/strict";
import { test } from "node:test";

import { createResearchLoopHandlers } from "../extensions/chatero-documentation/research-loop-controller.mjs";

const revision = value => `sha256:${value.repeat(64)}`;
const papers = Object.freeze([
  Object.freeze({ itemKey: "AAA11111", libraryId: 1, title: "A", creators: Object.freeze(["Ada"]), year: 1843, revision: revision("a") }),
  Object.freeze({ itemKey: "BBB22222", libraryId: 1, title: "B", creators: Object.freeze(["Alan"]), year: 1936, revision: revision("b") }),
]);

function fixture(overrides = {}) {
  const calls = [];
  const vscode = {
    commands: {
      async executeCommand(command, argument) {
        calls.push({ command, argument });
        return command === "chatero.chat.attachTextContext" ? "chatero-text:00000000-0000-4000-8000-000000000001" : undefined;
      },
    },
    workspace: { isTrusted: true },
  };
  const handlers = createResearchLoopHandlers({
    vscode,
    authority: "local",
    zotero: {
      getSelectionSnapshot: async () => papers,
      ...overrides.zotero,
    },
    documentation: {
      stageProposal: async input => ({ kind: "generation-staged", input }),
      stageLiteratureRefresh: async input => ({ kind: "literature-staged", input }),
      ...overrides.documentation,
    },
    ui: {
      chooseResearchAction: async () => "compare-papers",
      ...overrides.ui,
    },
  });
  return { calls, handlers };
}

test("multi-paper chat attaches one bounded immutable manifest then opens native Codex chat", async () => {
  const { calls, handlers } = fixture();
  await handlers["chatero.research.chatWithSelection"]();
  assert.deepEqual(calls.map(value => value.command), [
    "chatero.chat.attachTextContext",
    "workbench.action.chat.open",
  ]);
  assert.equal(calls[0].argument.label, "2 Zotero papers");
  assert.deepEqual(JSON.parse(calls[0].argument.text).papers.map(value => value.itemKey), ["AAA11111", "BBB22222"]);
  assert.doesNotMatch(JSON.stringify(calls), /github\.copilot|\/Users\/|profilePath|attachmentPath|zotero\.sqlite/iu);
  assert.equal(calls[1].argument.mode, "agent");
});

test("Research Action uses the same native chat and rejects an unbounded Zotero object", async () => {
  const { calls, handlers } = fixture({
    zotero: { getActiveResearchObject: async () => ({ kind: "collection", itemKey: "AAA11111", libraryId: 1, title: "Papers" }) },
  });
  await handlers["chatero.research.runAction"]();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "workbench.action.chat.open");
  assert.match(calls[0].argument.query, /Research Loop Action: compare-papers/u);

  const invalid = fixture({
    zotero: { getActiveResearchObject: async () => ({ kind: "pdf", itemKey: "AAA11111", libraryId: 1, title: "A", path: "/Users/alice/a.pdf" }) },
  });
  await assert.rejects(() => invalid.handlers["chatero.research.runAction"](), /unknown field/u);
  assert.equal(invalid.calls.length, 0);
});

test("a selected Zotero item is a valid generic Research Action object", async () => {
  const { calls, handlers } = fixture({
    zotero: { getActiveResearchObject: async () => ({ kind: "item", itemKey: "AAA11111", libraryId: 1, title: "Paper" }) },
    ui: { chooseResearchAction: async () => "summarize" },
  });
  await handlers["chatero.research.runAction"]();
  assert.match(calls[0].argument.query, /"kind":"item"/u);
});

test("Literature and Note imports use separate reviewable mutation boundaries", async () => {
  const staged = [];
  const { calls, handlers } = fixture({
    zotero: {
      exportBibliographySnapshot: async () => ({ bibliographyText: "@article{a,title={A}}\n", current: null, records: papers.slice(0, 1) }),
      getActiveNoteSnapshot: async () => ({ itemKey: "NOTE1234", libraryId: 1, title: "Note", html: "<p>Evidence</p>", version: 2 }),
    },
    documentation: {
      stageLiteratureRefresh: async input => { staged.push(["literature", input]); return { kind: "literature-staged" }; },
      stageProposal: async input => { staged.push(["documentation", input]); return { kind: "generation-staged" }; },
    },
    ui: { chooseDocumentationDestination: async () => "imports/notes/note.qmd" },
  });
  await handlers["chatero.research.refreshLiterature"]();
  await handlers["chatero.research.noteToDraft"]();
  assert.equal(staged.length, 2);
  assert.equal(staged[0][0], "literature");
  assert.equal(staged[0][1].bibliographyText, "@article{a,title={A}}\n");
  assert.equal(staged[1][0], "documentation");
  assert.equal(staged[1][1].operation.path, "imports/notes/note.qmd");
  assert.equal(staged[1][1].reviewRequired, true);
  assert.deepEqual(calls, []);
});

test("untrusted workspaces cannot invoke a Research Loop command", async () => {
  const { handlers } = fixture();
  const untrusted = createResearchLoopHandlers({
    vscode: { workspace: { isTrusted: false }, commands: { executeCommand: async () => assert.fail("must not execute") } },
    authority: "local", zotero: {}, documentation: {}, ui: {},
  });
  for (const handler of Object.values(untrusted)) await assert.rejects(() => handler(), /trusted workspace/u);
  assert.ok(handlers);
});
