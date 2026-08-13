import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCommandBackedZoteroResearchApi,
  createResearchProposalStager,
  workspaceAuthority,
} from "../extensions/chatero-documentation/research-loop-composition.mjs";

test("workspace authority preserves exact local or Chatero SSH identity", () => {
  assert.equal(workspaceAuthority({ scheme: "file", authority: "" }), "local");
  assert.equal(workspaceAuthority({ scheme: "vscode-remote", authority: "chatero-remote+dGFyZ2V0" }), "chatero-remote+dGFyZ2V0");
  assert.throws(() => workspaceAuthority({ scheme: "vscode-remote", authority: "ssh-remote+host" }), /unsupported/u);
});

test("Documentation invokes Zotero snapshots through the cross-host command boundary", async () => {
  const calls = [];
  const api = createCommandBackedZoteroResearchApi({
    async executeCommand(command) { calls.push(command); return Object.freeze({ command }); },
  });
  for (const method of ["getSelectionSnapshot", "getActiveResearchObject", "getActiveNoteSnapshot", "exportBibliographySnapshot"]) {
    assert.equal((await api[method]()).command, calls.at(-1));
  }
  assert.deepEqual(calls, [
    "chatero.zotero.research.selection",
    "chatero.zotero.research.activeObject",
    "chatero.zotero.research.activeNote",
    "chatero.zotero.research.bibliography",
  ]);
});

test("Note bridge issues a one-use bounded proposal grant and stages review only", async () => {
  const calls = [];
  const grant = Object.freeze({ kind: "grant" });
  const stageProposal = createResearchProposalStager({
    capabilities: {
      issueAgentProposalGrant(scope, input) { calls.push(["grant", scope, input]); return grant; },
    },
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    scope: Object.freeze({ kind: "scope" }),
    transactions: {
      async stage(receivedGrant, input) { calls.push(["stage", receivedGrant, input]); return { kind: "generation-staged" }; },
    },
  });
  const result = await stageProposal({
    kind: "draft-proposal",
    operation: { kind: "create", path: "imports/notes/note.qmd", proposedText: "evidence\n" },
    reviewRequired: true,
    source: { itemKey: "NOTE1234", libraryId: 1, version: 2 },
  });
  assert.equal(result.kind, "generation-staged");
  assert.equal(calls[0][2].maximumOperationCount, 1);
  assert.equal(calls[0][2].maximumProposedBytes, 9);
  assert.deepEqual(calls[0][2].operationKinds, ["create"]);
  assert.deepEqual(calls[1][2].operations, [{ kind: "create", path: "imports/notes/note.qmd", proposedText: "evidence\n" }]);
  assert.doesNotMatch(JSON.stringify(calls), /settle|approve|markReviewed/iu);
});

test("proposal stager rejects Literature and every non-Documentation mutation", async () => {
  const stageProposal = createResearchProposalStager({
    capabilities: { issueAgentProposalGrant: () => assert.fail("must not grant") },
    randomUUID: () => "id",
    scope: {},
    transactions: { stage: () => assert.fail("must not stage") },
  });
  await assert.rejects(() => stageProposal({
    kind: "literature-refresh-plan",
    operation: { kind: "create", path: "literature/ref.bib", proposedText: "x" },
  }), /dedicated Literature review boundary/u);
});
