import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildChangeSetGeneration } from "../extensions/chatero-documentation/change-set-model.mjs";
import { documentationPagePath } from "../extensions/chatero-documentation/documentation-path.mjs";
import {
  createReviewSnapshot,
  createReviewSnapshotRegistry,
} from "../extensions/chatero-documentation/review-snapshot.mjs";
import { planSettlement } from "../extensions/chatero-documentation/settlement-planner.mjs";

const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");
const revision = value => `sha256:${sha256(value)}`;

function reviewFixture({ currentText = "human preface\none\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n" } = {}) {
  const baseText = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
  const proposedText = "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nten\n";
  const built = buildChangeSetGeneration({
    lineageId: "settlement-a",
    generationId: "0000000000000001",
    repositoryIdentity: "repository:fixture",
    authorityIdentity: "authority:local",
    grantDigest: sha256("grant"),
    idempotencyKey: "agent-turn-1",
    createdAt: "2026-08-12T00:00:00.000Z",
    stateGeneration: "0000000000000002",
    allocateStableChangeId: value => value,
    operations: [{
      kind: "edit",
      operationId: "edit-topic",
      path: documentationPagePath("topic.qmd"),
      baseRevision: revision(baseText),
      baseText,
      proposedText,
    }],
  });
  assert.notEqual(built.kind, "invalid-proposal");
  const registry = createReviewSnapshotRegistry({
    clock: { now: () => 1_000 },
    randomUUID: () => "review-settlement-a",
  });
  const snapshot = createReviewSnapshot({
    registry,
    generation: built.generation,
    currentDocuments: [{
      path: "topic.qmd",
      text: currentText,
      revision: revision(currentText),
      dirty: true,
    }],
    stateGeneration: "0000000000000002",
  });
  return { snapshot, baseText, proposedText, currentText };
}

test("plans an accepted hunk over the exact human working copy and leaves rejected bytes untouched", () => {
  const fixture = reviewFixture();
  const hunks = fixture.snapshot.leaves.filter(value => value.kind === "hunk");
  assert.equal(hunks.length, 2);
  const decisions = new Map([
    [hunks[0].id, "accept"],
    [hunks[1].id, "reject"],
  ]);

  const result = planSettlement({
    snapshot: fixture.snapshot,
    decisions,
    currentDocuments: [{
      path: "topic.qmd",
      text: fixture.currentText,
      revision: revision(fixture.currentText),
      dirty: true,
    }],
    idempotencyKey: "settle-review-a",
  });

  assert.equal(result.kind, "settlement-plan");
  assert.equal(result.textOperations.length, 1);
  assert.equal(
    result.textOperations[0].intendedText,
    "human preface\none\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
  );
  assert.equal(result.textOperations[0].currentRevision, revision(fixture.currentText));
  assert.match(result.operationDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(result.stateChanges, [{ kind: "set", path: "topic.qmd", state: "working" }]);
  assert.ok(Object.isFrozen(result));
});

test("returns immutable conflict evidence before planning any write", () => {
  const fixture = reviewFixture({
    currentText: "one\nHUMAN\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
  });
  const decisions = new Map(fixture.snapshot.leaves.map(value => [value.id, "accept"]));
  const result = planSettlement({
    snapshot: fixture.snapshot,
    decisions,
    currentDocuments: fixture.snapshot.documents.map(value => ({
      path: value.path.value,
      text: value.currentText,
      revision: value.currentRevision,
      dirty: value.dirty,
    })),
    idempotencyKey: "settle-review-conflict",
  });
  assert.equal(result.kind, "settlement-conflict");
  assert.equal(result.path, "topic.qmd");
  assert.match(result.evidenceRef, /^review-conflict:sha256:[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(result, "plan"), false);
  assert.ok(Object.isFrozen(result));
});
