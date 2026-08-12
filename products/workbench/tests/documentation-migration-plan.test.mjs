import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  buildLegacyMigrationMapping,
} from "../extensions/chatero-documentation/migration-model.mjs";
import {
  classifyLegacyProposals,
  rewriteLegacyReferences,
} from "../extensions/chatero-documentation/migration-rewrite.mjs";

function revision(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function legacyRevision(value) {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const hex = value => (value >>> 0).toString(16).padStart(8, "0");
  return `v2-${hex(h1 ^ h2 ^ h3 ^ h4)}${hex(h2 ^ h1)}${hex(h3 ^ h1)}${hex(h4 ^ h1)}`;
}

test("legacy mapping gives Knowledge precedence and preserves every colliding Draft", () => {
  const same = revision("same");
  const mapping = buildLegacyMigrationMapping({
    knowledge: [
      { path: "assets/plot.png", revision: revision("knowledge-image") },
      { path: "nested/result.qmd", revision: revision("knowledge-result") },
      { path: "topic.qmd", revision: same },
    ],
    drafts: [
      { path: "assets/plot.png", revision: revision("draft-image") },
      { path: "draft-only.qmd", revision: revision("draft-only") },
      { path: "topic.qmd", revision: same },
    ],
    documentation: [
      { path: "_migrated/drafts/occupied.txt", revision: revision("occupied") },
      { path: "_migrated-1", revision: revision("file ancestor") },
    ],
  });

  assert.equal(mapping.conflictRoot, "_migrated-2/drafts");
  assert.deepEqual(mapping.pages.map(entry => [
    entry.sourceRoot,
    entry.sourcePath,
    entry.destination.value,
    entry.state,
    entry.reason,
  ]), [
    ["drafts", "draft-only.qmd", "draft-only.qmd", "working", "draft-only"],
    ["drafts", "topic.qmd", "_migrated-2/drafts/topic.qmd", "working", "draft-preserved"],
    ["knowledge", "nested/result.qmd", "nested/result.qmd", "reviewed", "knowledge-only"],
    ["knowledge", "topic.qmd", "topic.qmd", "reviewed", "knowledge-precedence"],
  ]);
  assert.deepEqual(mapping.assets.map(entry => [entry.sourceRoot, entry.destination.value]), [
    ["drafts", "_migrated-2/drafts/assets/plot.png"],
    ["knowledge", "assets/plot.png"],
  ]);
  assert.deepEqual(mapping.collisions.map(value => [value.path, value.content]), [
    ["assets/plot.png", "different"],
    ["topic.qmd", "equal"],
  ]);
  assert.equal(Object.isFrozen(mapping), true);
  assert.ok(mapping.pages.every(Object.isFrozen));
});

test("legacy mapping rejects unsafe, case-fold, and file-ancestor ambiguity", () => {
  const good = revision("good");
  for (const input of [
    {
      knowledge: [{ path: "Topic.qmd", revision: good }, { path: "topic.qmd", revision: good }],
      drafts: [], documentation: [],
    },
    {
      knowledge: [{ path: "assets", revision: good }, { path: "assets/plot.png", revision: good }],
      drafts: [], documentation: [],
    },
    {
      knowledge: [{ path: "../escape.qmd", revision: good }], drafts: [], documentation: [],
    },
  ]) {
    assert.throws(() => buildLegacyMigrationMapping(input), TypeError);
  }
});

test("structured rewriting changes only proven references and preserves all other bytes", () => {
  const mapping = buildLegacyMigrationMapping({
    knowledge: [
      { path: "assets/plot.png", revision: revision("plot") },
      { path: "topic.qmd", revision: revision("knowledge") },
    ],
    drafts: [{ path: "topic.qmd", revision: revision("draft") }],
    documentation: [],
  });
  const source = [
    "---",
    "project:",
    "  render:",
    "    - ../knowledge/topic.qmd",
    "website:",
    "  navbar:",
    "    left:",
    "      - href: ../knowledge/topic.qmd#intro",
    "        text: Topic",
    "  sidebar:",
    "    contents:",
    "      - ../knowledge/assets/plot.png",
    "chatero:",
    "  main-site:",
    "    routes:",
    "      - source: ../knowledge/topic.qmd",
    "title: ../knowledge/topic.qmd",
    "---",
    "Préface [Topic](../knowledge/topic.qmd#intro)",
    "![Plot](../knowledge/assets/plot.png)",
    "{{< include ../knowledge/topic.qmd >}}",
    "[External](https://example.test/knowledge/topic.qmd)",
    "[Unknown](missing.qmd)",
    "`[Inline](../knowledge/topic.qmd)`",
    "```{=html}",
    "[Raw](../knowledge/topic.qmd)",
    "```",
    "",
  ].join("\r\n");

  const result = rewriteLegacyReferences({
    sourcePath: "drafts/topic.qmd",
    destinationPath: mapping.pages.find(entry => entry.sourceRoot === "drafts").destination,
    bytes: Buffer.from(source, "utf8"),
    mapping,
  });
  const rewritten = Buffer.from(result.bytes).toString("utf8");

  assert.equal(result.kind, "rewritten");
  assert.match(rewritten, /- \.\.\/\.\.\/topic\.qmd\r\n/u);
  assert.match(rewritten, /href: \.\.\/\.\.\/topic\.qmd#intro/u);
  assert.match(rewritten, /- \.\.\/\.\.\/assets\/plot\.png/u);
  assert.match(rewritten, /source: \.\.\/\.\.\/topic\.qmd/u);
  assert.match(rewritten, /Préface \[Topic\]\(\.\.\/\.\.\/topic\.qmd#intro\)/u);
  assert.match(rewritten, /\{\{< include \.\.\/\.\.\/topic\.qmd >\}\}/u);
  assert.match(rewritten, /title: \.\.\/knowledge\/topic\.qmd/u);
  assert.match(rewritten, /`\[Inline\]\(\.\.\/knowledge\/topic\.qmd\)`/u);
  assert.match(rewritten, /\[Raw\]\(\.\.\/knowledge\/topic\.qmd\)/u);
  assert.match(rewritten, /https:\/\/example\.test\/knowledge\/topic\.qmd/u);
  assert.match(rewritten, /\[Unknown\]\(missing\.qmd\)/u);
  assert.ok(result.edits.every(edit => Buffer.from(source).subarray(edit.from, edit.to).length > 0));
  assert.deepEqual(new Set(result.edits.map(edit => edit.syntax)), new Set([
    "main-site-route", "markdown-link", "qmd-cross-reference", "quarto-project", "quarto-website",
  ]));
  assert.deepEqual(new Set(result.followUps.map(value => value.code)), new Set([
    "ambiguous-reference", "ambiguous-yaml-reference", "protected-reference",
  ]));
  assert.equal(rewritten.split("\r\n").length, source.split("\r\n").length);

  const ordered = [...result.edits].sort((left, right) => right.from - left.from);
  let reproduced = Buffer.from(source);
  for (const edit of ordered) {
    reproduced = Buffer.concat([
      reproduced.subarray(0, edit.from),
      Buffer.from(edit.replacement),
      reproduced.subarray(edit.to),
    ]);
  }
  assert.deepEqual(reproduced, Buffer.from(result.bytes));
});

test("legacy proposal classification is deterministic and never returns proposal bodies", () => {
  const base = "[Topic](../knowledge/topic.qmd)\n";
  const proposed = "[Topic](../knowledge/topic.qmd)\nNew\n";
  const mapping = buildLegacyMigrationMapping({
    knowledge: [{ path: "topic.qmd", revision: revision("knowledge") }],
    drafts: [{ path: "proposal.qmd", revision: revision(base) }],
    documentation: [],
  });
  const directory = "work/qlab-zotero/draft-changes/one";
  const manifest = {
    schemaVersion: 2,
    originalPath: "drafts/proposal.qmd",
    workingPath: `${directory}/draft.qmd`,
    basePath: `${directory}/base.qmd`,
    baseRevision: legacyRevision(base),
    revision: legacyRevision(base),
    generation: "generation-1",
    createdAt: "2026-08-12T00:00:00.000Z",
  };
  const records = [
    { path: `${directory}/manifest.json`, bytes: Buffer.from(JSON.stringify(manifest)) },
    {
      path: "work/qlab-zotero/draft-changes/two/manifest.json",
      bytes: Buffer.from(JSON.stringify({
        ...manifest,
        workingPath: "work/qlab-zotero/draft-changes/two/draft.qmd",
        basePath: "work/qlab-zotero/draft-changes/two/base.qmd",
      })),
    },
    { path: "work/qlab-zotero/draft-changes/bad-json/manifest.json", bytes: Buffer.from("{") },
    { path: "work/qlab-zotero/draft-changes/unknown/manifest.json", bytes: Buffer.from('{"schemaVersion":3}') },
    {
      path: "work/qlab-zotero/draft-changes/unsafe/manifest.json",
      bytes: Buffer.from(JSON.stringify({ ...manifest, originalPath: "drafts/../escape.qmd" })),
    },
    {
      path: "work/qlab-zotero/draft-changes/missing/manifest.json",
      bytes: Buffer.from(JSON.stringify({
        ...manifest,
        workingPath: "work/qlab-zotero/draft-changes/missing/draft.qmd",
        basePath: "work/qlab-zotero/draft-changes/missing/base.qmd",
      })),
    },
    {
      path: "work/qlab-zotero/draft-changes/mismatch/manifest.json",
      bytes: Buffer.from(JSON.stringify({
        ...manifest,
        workingPath: "work/qlab-zotero/draft-changes/mismatch/draft.qmd",
        basePath: "work/qlab-zotero/draft-changes/mismatch/base.qmd",
        baseRevision: legacyRevision("different"),
        revision: legacyRevision("different"),
      })),
    },
  ];
  const blobs = new Map([
    [`${directory}/base.qmd`, Buffer.from(base)],
    [`${directory}/draft.qmd`, Buffer.from(proposed)],
    ["work/qlab-zotero/draft-changes/two/base.qmd", Buffer.from(base)],
    ["work/qlab-zotero/draft-changes/two/draft.qmd", Buffer.from(proposed)],
    ["work/qlab-zotero/draft-changes/mismatch/base.qmd", Buffer.from(base)],
    ["work/qlab-zotero/draft-changes/mismatch/draft.qmd", Buffer.from(proposed)],
  ]);

  const result = classifyLegacyProposals({ records, blobs, mapping });
  assert.deepEqual(result.proposals.map(value => value.classification), ["valid", "exact-duplicate"]);
  assert.ok(result.proposals.every(value => /^sha256:[0-9a-f]{64}$/u.test(value.rawBaseDigest)));
  assert.ok(result.proposals.every(value => /^sha256:[0-9a-f]{64}$/u.test(value.migratedProposedDigest)));
  assert.deepEqual(result.diagnostics.map(value => value.code), [
    "malformed-json",
    "digest-mismatch",
    "missing-blob",
    "unknown-schema",
    "unsafe-path",
  ]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(base), false);
  assert.equal(serialized.includes(proposed), false);
  assert.equal(Object.isFrozen(result), true);
});
