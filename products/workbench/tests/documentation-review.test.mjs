import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildChangeSetGeneration } from "../extensions/chatero-documentation/change-set-model.mjs";
import { documentationPagePath } from "../extensions/chatero-documentation/documentation-path.mjs";
import { createDocumentationCapabilityIssuer } from "../extensions/chatero-documentation/documentation-capabilities.mjs";
import { createDocumentationTransactions } from "../extensions/chatero-documentation/documentation-transactions.mjs";
import { validateReviewDecisions } from "../extensions/chatero-documentation/review-decisions.mjs";
import {
  createReviewSnapshot,
  createReviewSnapshotRegistry,
} from "../extensions/chatero-documentation/review-snapshot.mjs";
import { threeWayReconcile } from "../extensions/chatero-documentation/three-way-reconcile.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const revision = value => `sha256:${sha256(value)}`;

function generation() {
  return buildChangeSetGeneration({
    lineageId: "review-a",
    generationId: "0000000000000001",
    repositoryIdentity: "repository:fixture",
    authorityIdentity: "authority:local",
    grantDigest: sha256("grant"),
    idempotencyKey: "review-turn-1",
    createdAt: "2026-08-12T00:00:00.000Z",
    stateGeneration: "0000000000000002",
    allocateStableChangeId: value => value,
    operations: [
      {
        kind: "edit", operationId: "edit-a", path: documentationPagePath("topic.qmd"),
        baseRevision: revision("one\ntwo\nthree\nfour\nfive\n"),
        baseText: "one\ntwo\nthree\nfour\nfive\n",
        proposedText: "one\nTWO\nthree\nFOUR\nfive\n",
      },
      {
        kind: "rename", operationId: "rename-a", from: documentationPagePath("old.qmd"),
        to: documentationPagePath("new.qmd"), baseRevision: revision("old\n"),
        baseText: "old\n", targetAbsent: true, proposedText: "revised\n",
      },
      {
        kind: "create", operationId: "create-a", path: documentationPagePath("created.qmd"),
        targetAbsent: true, proposedText: "created\n",
      },
      {
        kind: "delete", operationId: "delete-a", path: documentationPagePath("deleted.qmd"),
        baseRevision: revision("deleted\n"), baseText: "deleted\n",
      },
    ],
  }).generation;
}

function currentDocuments() {
  return [
    { path: "topic.qmd", text: "human note\none\ntwo\nthree\nfour\nfive\n", revision: revision("human note\none\ntwo\nthree\nfour\nfive\n"), dirty: true },
    { path: "old.qmd", text: "old\n", revision: revision("old\n"), dirty: false },
    { path: "new.qmd", absent: true },
    { path: "created.qmd", absent: true },
    { path: "deleted.qmd", text: "deleted\n", revision: revision("deleted\n"), dirty: false },
  ];
}

test("creates one immutable content-bound review snapshot and one-use token", () => {
  let sequence = 0;
  const registry = createReviewSnapshotRegistry({
    clock: { now: () => 1_000 }, randomUUID: () => `review-token-${++sequence}`,
  });
  const snapshot = createReviewSnapshot({
    registry,
    generation: generation(),
    currentDocuments: currentDocuments(),
    stateGeneration: "0000000000000002",
    expiresInMs: 30_000,
  });
  assert.match(snapshot.reviewDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(snapshot.reviewToken, "review-token-1");
  assert.equal(snapshot.documents.find(value => value.path.value === "topic.qmd").currentText.startsWith("human note"), true);
  assert.ok(snapshot.leaves.some(value => value.kind === "rename"));
  assert.ok(snapshot.leaves.filter(value => value.operationId === "edit-a").every(value => value.kind === "hunk"));
  const rename = snapshot.leaves.find(value => value.kind === "rename");
  assert.ok(snapshot.leaves.filter(value => value.operationId === "rename-a" && value.kind === "hunk")
    .every(value => value.dependsOn.includes(rename.id)));
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(snapshot.documents.every(Object.isFrozen));
  assert.ok(snapshot.leaves.every(Object.isFrozen));

  const bound = registry.consume(snapshot.reviewToken, snapshot.reviewDigest);
  assert.equal(bound.snapshot, snapshot);
  assert.throws(() => registry.consume(snapshot.reviewToken, snapshot.reviewDigest), /consumed/u);
  assert.throws(() => registry.consume("review-token-forged", snapshot.reviewDigest), /unrecognized/u);
});

test("requires exactly one valid decision per leaf and enforces dependencies", () => {
  const registry = createReviewSnapshotRegistry({ clock: { now: () => 1 }, randomUUID: () => "token-a" });
  const snapshot = createReviewSnapshot({
    registry, generation: generation(), currentDocuments: currentDocuments(),
    stateGeneration: "0000000000000002", expiresInMs: 10,
  });
  assert.deepEqual(validateReviewDecisions(snapshot, new Map()), {
    kind: "incomplete-decision-set",
    missing: snapshot.leaves.map(value => value.id),
  });
  const complete = new Map(snapshot.leaves.map(value => [value.id, "reject"]));
  assert.equal(validateReviewDecisions(snapshot, complete).kind, "complete");
  complete.set("unknown", "accept");
  assert.deepEqual(validateReviewDecisions(snapshot, complete), {
    kind: "invalid-decision-set", violations: ["unknown:unknown"],
  });

  const rename = snapshot.leaves.find(value => value.kind === "rename");
  const dependent = snapshot.leaves.find(value => value.kind === "hunk" && value.dependsOn.includes(rename.id));
  const invalid = new Map(snapshot.leaves.map(value => [value.id, "reject"]));
  invalid.set(dependent.id, "accept");
  assert.deepEqual(validateReviewDecisions(snapshot, invalid), {
    kind: "invalid-decision-set",
    violations: [`dependency:${dependent.id}:${rename.id}`],
  });
  invalid.set(dependent.id, "maybe");
  assert.equal(validateReviewDecisions(snapshot, invalid).kind, "invalid-decision-set");
});

test("three-way reconciliation preserves non-overlapping human and Agent edits", () => {
  const result = threeWayReconcile({
    base: "alpha\r\nbeta 😀\r\ngamma\r\n",
    current: "human\r\nalpha\r\nbeta 😀\r\ngamma!\r\n",
    proposed: "alpha\r\nBETA λ\r\ngamma\r\n",
  });
  assert.equal(result.kind, "merged");
  assert.equal(result.text, "human\r\nalpha\r\nBETA λ\r\ngamma!\r\n");
  assert.ok(result.changes.length > 0);
  assert.ok(result.changes.every(Object.isFrozen));
});

test("three-way reconciliation reports overlapping or ambiguous edits without choosing bytes", () => {
  const conflict = threeWayReconcile({ base: "same value\n", current: "human value\n", proposed: "agent value\n" });
  assert.equal(conflict.kind, "conflict");
  assert.match(conflict.evidenceRef, /^review-conflict:sha256:[0-9a-f]{64}$/u);
  assert.equal(conflict.current, "human value\n");
  assert.equal(conflict.proposed, "agent value\n");

  const repeated = threeWayReconcile({
    base: "x\nrepeat\nx\nrepeat\n",
    current: "x\nHUMAN\nx\nrepeat\n",
    proposed: "x\nAGENT\nx\nrepeat\n",
  });
  assert.equal(repeated.kind, "conflict");
  assert.equal(threeWayReconcile({ base: "a", current: "a", proposed: "b" }).text, "b");
  assert.equal(threeWayReconcile({ base: "a", current: "b", proposed: "a" }).text, "b");
});

test("review tokens expire and snapshots bind current revisions and state generation", () => {
  let now = 1;
  let sequence = 0;
  const registry = createReviewSnapshotRegistry({
    clock: { now: () => now }, randomUUID: () => `token-expiring-${++sequence}`,
  });
  const snapshot = createReviewSnapshot({
    registry, generation: generation(), currentDocuments: currentDocuments(),
    stateGeneration: "0000000000000002", expiresInMs: 5,
  });
  const changed = createReviewSnapshot({
    registry,
    generation: generation(),
    currentDocuments: currentDocuments().map(value => value.path === "topic.qmd" ? {
      ...value, text: `${value.text}later\n`, revision: revision(`${value.text}later\n`),
    } : value),
    stateGeneration: "0000000000000003",
    expiresInMs: 5,
  });
  assert.notEqual(changed.reviewDigest, snapshot.reviewDigest);
  now = 7;
  assert.throws(() => registry.consume(snapshot.reviewToken, snapshot.reviewDigest), /expired/u);
});

test("transaction review snapshots the current local-or-SSH TextDocuments through the authority adapter", async () => {
  let sequence = 0;
  const capabilities = createDocumentationCapabilityIssuer({
    clock: { now: () => 1_000 }, randomUUID: () => `review-capability-${++sequence}`,
  });
  const scope = capabilities.issueScope({ uri: "file:///workspace", authority: "local", epoch: "epoch-a" });
  const reviewRegistry = createReviewSnapshotRegistry({
    clock: { now: () => 1_000 }, randomUUID: () => `review-registry-${++sequence}`,
  });
  const source = generation();
  const current = new Map(currentDocuments().map(value => [value.path, value]));
  const requests = [];
  const adapter = {
    async snapshot(request) {
      requests.push(request);
      if (request.kind === "documentation-state") return {
        kind: "documentation-state", epoch: "epoch-a", pages: [], state: { kind: "missing" },
      };
      return {
        kind: "snapshot", epoch: "epoch-a",
        entries: request.paths.map(path => {
          const value = current.get(path.value);
          if (value.absent) return { path: `documentation/${path.value}`, type: "absent" };
          return {
            path: `documentation/${path.value}`, type: "file",
            bytes: Buffer.from(value.text).toString("base64url"), sha256: sha256(value.text),
            revision: value.revision, dirty: value.dirty,
          };
        }),
      };
    },
    async transact() { throw new Error("review must not transact"); },
  };
  const transactions = createDocumentationTransactions({
    adapter, capabilities, scope, reviewRegistry,
    workspaceView: { capture() {}, revalidate() {} },
    changeSetStore: {
      async loadGeneration() { return source; },
      async loadCurrentRef() { return { kind: "current-generation", ref: source.ref }; },
      async stageGeneration() { throw new Error("review must not stage"); },
    },
  });
  const snapshot = await transactions.review(source.ref);
  assert.equal(snapshot.generationDigest, source.generationDigest);
  assert.equal(snapshot.documents.find(value => value.path.value === "topic.qmd").dirty, true);
  assert.deepEqual(requests.map(value => value.kind), ["paths", "documentation-state"]);
});
