import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";

import {
  buildLegacyMigrationMapping,
} from "../extensions/chatero-documentation/migration-model.mjs";
import {
  classifyLegacyProposals,
  rewriteLegacyReferences,
} from "../extensions/chatero-documentation/migration-rewrite.mjs";
import {
  MIGRATION_PLAN_LIMITS,
  canonicalMigrationPlanDigest,
  createMigrationPlanner,
  MigrationReportContentProvider,
} from "../extensions/chatero-documentation/migration-planner.mjs";
import {
  decodeAuthorityResponse,
  encodeAuthorityRequest,
} from "../documentation-authority/protocol.mjs";
import {
  runDocumentationAuthority,
} from "../documentation-authority/runtime/chatero-documentation-authority.mjs";

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
    ["knowledge", "nested/result.qmd", "nested/result.qmd", "reviewed", "knowledge-only"],
    ["knowledge", "topic.qmd", "topic.qmd", "reviewed", "knowledge-precedence"],
    ["drafts", "draft-only.qmd", "draft-only.qmd", "working", "draft-only"],
    ["drafts", "topic.qmd", "_migrated-2/drafts/topic.qmd", "working", "draft-preserved"],
  ]);
  assert.deepEqual(mapping.assets.map(entry => [entry.sourceRoot, entry.destination.value]), [
    ["knowledge", "assets/plot.png"],
    ["drafts", "_migrated-2/drafts/assets/plot.png"],
  ]);
  assert.deepEqual(mapping.collisions.map(value => [value.path, value.contentRelation]), [
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

function planRecordFixture() {
  const pathProofs = [{
    path: "knowledge/topic.qmd",
    role: "source",
    expectedDigest: revision("topic"),
    requireClean: true,
  }];
  return {
    schemaVersion: 1,
    sourceSnapshotDigest: revision("snapshot"),
    verificationSnapshotDigest: revision("snapshot"),
    affectedPaths: ["knowledge/topic.qmd"],
    pathProofs,
    mappings: [{
      kind: "page",
      sourceRoot: "knowledge",
      sourcePath: "topic.qmd",
      sourceRevision: revision("topic"),
      destinationPath: "topic.qmd",
      state: "reviewed",
      reason: "knowledge-only",
    }],
    stateOutput: { generation: "0000000000000001", documents: [{ path: "topic.qmd", state: "reviewed" }] },
    collisions: [],
    rewrites: [],
    proposals: [],
    diagnostics: [],
  };
}

function authorityPlanFixture() {
  const planRecord = planRecordFixture();
  return {
    kind: "migration-plan",
    workspaceEpoch: "epoch-1",
    planDigest: canonicalMigrationPlanDigest(planRecord),
    planRecord,
    reportModel: {
      schemaVersion: 1,
      title: "Documentation migration dry run",
      summary: { pages: 1, assets: 0, collisions: 0, proposals: 0, followUps: 0 },
      sections: [
        {
          heading: "Planned mappings",
          items: ["knowledge/topic.qmd -> documentation/topic.qmd"],
        },
        { heading: "Conflicts and follow-ups", items: [] },
      ],
    },
  };
}

test("migration planner performs one read-only request and keeps its token extension-private", async () => {
  const requests = [];
  let trusted = true;
  let entropy = 0xaa;
  const result = authorityPlanFixture();
  const planner = createMigrationPlanner({
    adapter: {
      async snapshot(request) {
        requests.push(request);
        return result;
      },
    },
    capabilities: {
      consumeScope() {
        return {
          uri: "file:///workspace",
          authority: "local",
          epoch: "epoch-1",
          workspaceScopeDigest: "a".repeat(64),
        };
      },
    },
    clock: { now: () => 1_000 },
    limits: MIGRATION_PLAN_LIMITS,
    randomBytes: size => Buffer.alloc(size, ++entropy),
    isWorkspaceTrusted: () => trusted,
    workingCopyEvidence: () => [],
  });

  const firstScope = Object.freeze({ kind: "scope" });
  const planned = await planner.planMigration(firstScope);
  assert.equal(planned.kind, "planned");
  assert.deepEqual(requests, [{ kind: "plan-migration", limits: MIGRATION_PLAN_LIMITS }]);
  assert.match(planned.planToken, /^mp_[A-Za-z0-9_-]{43}$/u);
  assert.equal(planned.report.includes(planned.planToken), false);
  assert.equal(JSON.stringify(planned).includes("file:///workspace"), false);
  assert.equal(planned.plan.schemaVersion, 1);
  assert.equal("intendedOutputManifest" in planned.plan, false);
  assert.equal(planner.consumePlanToken(planned.planToken, Object.freeze({ kind: "clone" })).kind, "invalid-plan-token");
  const secondScope = Object.freeze({ kind: "scope-2" });
  const second = await planner.planMigration(secondScope);
  const consumed = planner.consumePlanToken(second.planToken, secondScope);
  assert.equal(consumed.kind, "consumed-plan");
  assert.equal(consumed.planDigest, second.plan.digest);
  assert.equal(planner.consumePlanToken(second.planToken, secondScope).kind, "invalid-plan-token");

  trusted = false;
  assert.deepEqual(await planner.planMigration(Object.freeze({ kind: "scope-3" })), { kind: "workspace-untrusted" });
  assert.equal(requests.length, 2);
});

test("migration planner returns no token for dirty evidence or trust lost in flight", async () => {
  let trusted = true;
  const result = authorityPlanFixture();
  const scopeRecord = {
    uri: "file:///workspace",
    authority: "local",
    epoch: "epoch-1",
    workspaceScopeDigest: "a".repeat(64),
  };
  const planner = createMigrationPlanner({
    adapter: {
      async snapshot() {
        trusted = false;
        return result;
      },
    },
    capabilities: { consumeScope: () => scopeRecord },
    clock: { now: () => 1_000 },
    limits: MIGRATION_PLAN_LIMITS,
    randomBytes: size => Buffer.alloc(size, 1),
    isWorkspaceTrusted: () => trusted,
    workingCopyEvidence: () => [],
  });
  assert.deepEqual(await planner.planMigration({}), { kind: "workspace-untrusted" });

  trusted = true;
  const dirty = createMigrationPlanner({
    adapter: { snapshot: async () => result },
    capabilities: { consumeScope: () => scopeRecord },
    clock: { now: () => 1_000 },
    limits: MIGRATION_PLAN_LIMITS,
    randomBytes: size => Buffer.alloc(size, 2),
    isWorkspaceTrusted: () => true,
    workingCopyEvidence: () => [{
      uri: "file:///workspace/knowledge/topic.qmd",
      version: 7,
      dirty: true,
      revision: `text-document:7:${revision("topic")}`,
    }],
  });
  assert.deepEqual(await dirty.planMigration({}), {
    kind: "dirty-working-copy",
    paths: ["knowledge/topic.qmd"],
  });
});

test("migration reports are digest-addressed read-only virtual documents", () => {
  const provider = new MigrationReportContentProvider();
  const digest = `sha256:${"c".repeat(64)}`;
  const report = "# Documentation migration dry run\n";
  const uri = provider.publish({ digest }, report, {
    parse(value) {
      const parsed = new URL(value);
      return { scheme: parsed.protocol.slice(0, -1), path: parsed.pathname };
    },
  });
  assert.equal(uri.scheme, "chatero-documentation-report");
  assert.equal(provider.provideTextDocumentContent(uri), report);
  assert.throws(
    () => provider.provideTextDocumentContent({ path: `/${"d".repeat(64)}.md` }),
    /unknown/,
  );
  provider.dispose();
  assert.throws(() => provider.provideTextDocumentContent(uri), /unknown/);
});

async function invokePlanningHelper(workspace, filesystem) {
  const output = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); },
  });
  const request = {
    protocolVersion: 1,
    requestId: "migration-request",
    kind: "snapshot",
    workspace: new URL(`file://${workspace}`).href,
    epoch: "epoch-1",
    snapshot: { kind: "plan-migration", limits: MIGRATION_PLAN_LIMITS, overlays: [] },
  };
  await runDocumentationAuthority({
    stdin: Readable.from([`${encodeAuthorityRequest(request)}\n`]),
    stdout,
    filesystem,
    clock: { now: () => 1_000 },
  });
  return decodeAuthorityResponse(Buffer.concat(output).toString("ascii").trimEnd()).result;
}

test("authority helper plans from two matching private snapshots without writing", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "chatero-migration-plan-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "knowledge", "assets"), { recursive: true });
  await mkdir(join(workspace, "drafts"));
  await writeFile(join(workspace, "knowledge", "topic.qmd"), "# Topic\n![Plot](assets/plot.png)\n");
  await writeFile(join(workspace, "knowledge", "assets", "plot.png"), Buffer.from([1, 2, 3]));
  await writeFile(join(workspace, "drafts", "topic.qmd"), "# Draft\n");

  const mutations = [];
  const filesystem = new Proxy(await import("node:fs/promises"), {
    get(target, property) {
      if (new Set(["appendFile", "copyFile", "mkdir", "rename", "rm", "unlink", "writeFile"]).has(property)) {
        return async (...args) => {
          mutations.push([property, ...args]);
          return target[property](...args);
        };
      }
      return Reflect.get(target, property);
    },
  });
  mutations.length = 0;
  const before = await stat(join(workspace, "knowledge", "topic.qmd"));
  const result = await invokePlanningHelper(workspace, filesystem);
  const after = await stat(join(workspace, "knowledge", "topic.qmd"));

  assert.equal(result.kind, "migration-plan");
  assert.equal(result.planRecord.sourceSnapshotDigest, result.planRecord.verificationSnapshotDigest);
  assert.equal(result.planDigest, canonicalMigrationPlanDigest(result.planRecord));
  assert.deepEqual(result.planRecord.affectedPaths, [
    ...new Set(result.planRecord.pathProofs.map(proof => proof.path)),
  ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
  assert.equal(result.planRecord.mappings.length, 3);
  assert.equal(result.planRecord.collisions.length, 1);
  assert.equal(JSON.stringify(result).includes("# Topic"), false);
  assert.equal(JSON.stringify(result).includes("AQID"), false);
  assert.equal(JSON.stringify(result).includes(workspace), false);
  assert.deepEqual(mutations, []);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(join(workspace, "drafts", "topic.qmd"), "utf8"), "# Draft\n");

  const scope = Object.freeze({ kind: "helper-scope" });
  const planner = createMigrationPlanner({
    adapter: { snapshot: async () => result },
    capabilities: {
      consumeScope: () => ({
        uri: new URL(`file://${workspace}`).href,
        authority: "local",
        epoch: "epoch-1",
        workspaceScopeDigest: "b".repeat(64),
      }),
    },
    clock: { now: () => 1_000 },
    limits: MIGRATION_PLAN_LIMITS,
    randomBytes: size => Buffer.alloc(size, 3),
    isWorkspaceTrusted: () => true,
    workingCopyEvidence: () => [],
  });
  const planned = await planner.planMigration(scope);
  assert.equal(planned.kind, "planned");
  assert.equal(planned.plan.digest, result.planDigest);
});

test("authority helper rejects a pre-existing mixed Documentation layout without a partial plan", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "chatero-migration-conflict-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "knowledge"));
  await mkdir(join(workspace, "documentation"));
  await writeFile(join(workspace, "knowledge", "topic.qmd"), "# Legacy\n");
  await writeFile(join(workspace, "documentation", "existing.qmd"), "# Existing\n");

  const result = await invokePlanningHelper(workspace, await import("node:fs/promises"));
  assert.deepEqual(result, {
    kind: "migration-conflict",
    workspaceEpoch: "epoch-1",
    code: "documentation-not-empty",
    paths: ["documentation/existing.qmd"],
  });
  assert.equal("planRecord" in result, false);
  assert.equal("reportModel" in result, false);
  assert.equal("planToken" in result, false);
  assert.equal(await readFile(join(workspace, "documentation", "existing.qmd"), "utf8"), "# Existing\n");
});
