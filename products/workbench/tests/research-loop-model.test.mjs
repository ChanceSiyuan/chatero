import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  RESEARCH_ACTIONS,
  buildLiteratureRefreshPlan,
  buildMultiPaperContextManifest,
  buildNoteDraftProposal,
  buildResearchActionPrompt,
  buildTopicGraph,
  validateResearchAction,
} from "../extensions/chatero-documentation/research-loop-model.mjs";

const paper = (itemKey, title, extra = {}) => ({
  itemKey,
  libraryId: 1,
  title,
  creators: ["Ada Lovelace"],
  year: 1843,
  ...extra,
});

test("research actions expose one immutable skills-backed catalog", () => {
  assert.deepEqual(RESEARCH_ACTIONS.map(value => value.id), [
    "summarize", "evidence-qa", "compare-papers", "analyze-figure", "write-draft", "review-draft",
  ]);
  assert.ok(Object.isFrozen(RESEARCH_ACTIONS));
  assert.equal(validateResearchAction("compare-papers", "collection").mode, "compare");
  assert.equal(validateResearchAction("summarize", "item").mode, "summary");
  assert.throws(() => validateResearchAction("analyze-figure", "note"), /not available/u);
});

test("action prompts contain bounded evidence identity and no path or hidden bytes", () => {
  const prompt = buildResearchActionPrompt({
    actionId: "summarize",
    object: { kind: "pdf", itemKey: "ABC12345", libraryId: 1, title: "Paper" },
    workspaceAuthority: "local",
  });
  assert.match(prompt, /Research Loop Action: summarize/u);
  assert.match(prompt, /"itemKey":"ABC12345"/u);
  assert.doesNotMatch(prompt, /\/Users\/|zotero\.sqlite|profilePath|attachmentPath|file:\/\//iu);
  assert.throws(() => buildResearchActionPrompt({
    actionId: "summarize",
    object: { kind: "pdf", itemKey: "ABC12345", libraryId: 1, title: "Paper", path: "/Users/alice/paper.pdf" },
    workspaceAuthority: "local",
  }), /unknown field/u);
});

test("multi-paper manifests preserve immutable Zotero identities and selected revisions", () => {
  const manifest = buildMultiPaperContextManifest({
    authority: "chatero-remote+abc",
    papers: [paper("AAA11111", "A", { revision: "sha256:" + "a".repeat(64) }), paper("BBB22222", "B", { revision: "sha256:" + "b".repeat(64) })],
  });
  assert.equal(manifest.kind, "multi-paper-context");
  assert.deepEqual(manifest.papers.map(value => value.itemKey), ["AAA11111", "BBB22222"]);
  assert.ok(Object.isFrozen(manifest));
  assert.ok(manifest.papers.every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(manifest), /path|bytes|token/iu);
});

test("Literature refresh is create-only or exact-revision replacement and never deletes unknown files", () => {
  const plan = buildLiteratureRefreshPlan({
    bibliographyText: "@article{a,title={A}}\n",
    current: null,
    records: [paper("AAA11111", "A")],
  });
  assert.equal(plan.operation.kind, "create");
  assert.equal(plan.operation.path, "literature/ref.bib");
  assert.equal(plan.removals.length, 0);
  const update = buildLiteratureRefreshPlan({
    bibliographyText: "@article{a,title={A2}}\n",
    current: { revision: "sha256:" + "c".repeat(64), text: "@article{a,title={A}}\n" },
    records: [paper("AAA11111", "A2")],
  });
  assert.deepEqual(update.operation, {
    kind: "edit",
    path: "literature/ref.bib",
    baseRevision: "sha256:" + "c".repeat(64),
    proposedText: "@article{a,title={A2}}\n",
  });
  assert.throws(() => buildLiteratureRefreshPlan({
    bibliographyText: "x",
    current: { revision: "missing", text: "x" },
    records: [],
  }), /revision/u);
});

test("Note to QMD bridge always creates a unified Documentation proposal with source provenance", () => {
  const proposal = buildNoteDraftProposal({
    note: { itemKey: "NOTE1234", libraryId: 1, title: "Observation", html: "<p>Result</p>", version: 7 },
    destination: "imports/notes/result.qmd",
  });
  assert.equal(proposal.kind, "draft-proposal");
  assert.equal(proposal.operation.kind, "create");
  assert.match(proposal.operation.proposedText, /sourceItem: zotero:\/\/1\/NOTE1234/u);
  assert.match(proposal.operation.proposedText, /Result/u);
  assert.equal(proposal.reviewRequired, true);
  assert.throws(() => buildNoteDraftProposal({
    note: { itemKey: "NOTE1234", libraryId: 1, title: "x", html: "x", version: 1 },
    destination: "../knowledge/result.qmd",
  }), /Documentation/u);
});

test("topic graph derives deterministic nodes and citation edges without source bytes", () => {
  const graph = buildTopicGraph({
    documents: [
      { path: "a.qmd", title: "A", categories: ["quantum", "codes"], citations: ["lovelace1843"] },
      { path: "b.qmd", title: "B", categories: ["quantum"], citations: ["lovelace1843", "turing1936"] },
    ],
  });
  assert.deepEqual(graph.nodes.map(value => value.id), [
    "citation:lovelace1843", "citation:turing1936", "document:a.qmd", "document:b.qmd", "topic:codes", "topic:quantum",
  ]);
  assert.ok(graph.edges.some(value => value.from === "document:a.qmd" && value.to === "topic:quantum"));
  assert.doesNotMatch(JSON.stringify(graph), /source|text|bytes|html/iu);
});

test("the first-party Documentation payload exposes the complete Research Loop command surface", async () => {
  const root = new URL("../../../", import.meta.url);
  const [manifest, extensionPackage] = await Promise.all([
    readFile(new URL("../first-party-extensions.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../extensions/chatero-documentation/package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const documentation = manifest.extensions.find(value => value.id === "chatero.documentation");
  assert.ok(documentation.files.some(value => value.destination.endsWith("/research-loop-model.mjs")));
  assert.ok(documentation.files.some(value => value.destination.endsWith("/research-loop-commands.mjs")));
  assert.ok(documentation.files.some(value => value.destination.endsWith("/research-loop-composition.mjs")));
  assert.ok(documentation.files.some(value => value.destination.endsWith("/research-loop-controller.mjs")));
  const commands = new Set(extensionPackage.contributes.commands.map(value => value.command));
  for (const command of [
    "chatero.research.runAction",
    "chatero.research.chatWithSelection",
    "chatero.research.refreshLiterature",
    "chatero.research.noteToDraft",
    "chatero.research.openTopicGraph",
    "chatero.research.openMainSite",
  ]) assert.ok(commands.has(command), `${command} must be contributed`);
  assert.equal(new URL(root).pathname.endsWith("/products/"), false);
});
