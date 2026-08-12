import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildChangeSetGeneration } from "../extensions/chatero-documentation/change-set-model.mjs";
import { createDocumentationCapabilityIssuer } from "../extensions/chatero-documentation/documentation-capabilities.mjs";
import { documentationPagePath } from "../extensions/chatero-documentation/documentation-path.mjs";
import { createDocumentationTransactions } from "../extensions/chatero-documentation/documentation-transactions.mjs";
import {
  createReviewSnapshot,
  createReviewSnapshotRegistry,
} from "../extensions/chatero-documentation/review-snapshot.mjs";
import { executeSettlement } from "../extensions/chatero-documentation/settlement-executor.mjs";
import { planSettlement } from "../extensions/chatero-documentation/settlement-planner.mjs";
import { settlementApprovalDigest } from "../extensions/chatero-documentation/settlement-protocol.mjs";

const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");
const revision = value => `sha256:${sha256(value)}`;
const openRevision = (value, version) => `text-document:${version}:sha256:${sha256(value)}`;

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
  return { snapshot, generation: built.generation, baseText, proposedText, currentText };
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

  assert.equal(result.kind, "settlement-plan", result.message);
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

test("executes one barrier-bound WorkspaceEdit and acknowledges its exact text proof", async () => {
  const fixture = reviewFixture();
  const decisions = new Map(fixture.snapshot.leaves.map(value => [value.id, "accept"]));
  const plan = planSettlement({
    snapshot: fixture.snapshot,
    decisions,
    currentDocuments: [{
      path: "topic.qmd",
      text: fixture.currentText,
      revision: openRevision(fixture.currentText, 7),
      dirty: true,
    }],
    idempotencyKey: "settle-review-execute",
  });
  assert.equal(plan.kind, "settlement-plan", plan.message);

  const uri = Object.freeze({
    value: "file:///workspace/documentation/topic.qmd",
    toString() { return this.value; },
  });
  const acquireCalls = [];
  const leaseCalls = { revalidate: 0, apply: 0, dispose: 0 };
  const lease = {
    async revalidate() { leaseCalls.revalidate++; return { kind: "valid" }; },
    async applyWorkspaceEdit(edit) { leaseCalls.apply++; assert.equal(edit, "workspace-edit"); return true; },
    async finalizeResourceOutcomes() { throw new Error("text-only settlement must not finalize structural outcomes"); },
    dispose() { leaseCalls.dispose++; },
  };
  const barrier = {
    async acquire(input) { acquireCalls.push(input); return lease; },
  };
  const coordinatorCalls = [];
  const coordinator = {
    async applyVersionedTextEdits(input) {
      coordinatorCalls.push(input);
      assert.equal(await input.applyWorkspaceEdit("workspace-edit"), true);
      return {
        kind: "applied",
        operationId: input.operationId,
        versions: input.edits.map(edit => ({ uri: edit.uri, before: edit.baseVersion, after: edit.baseVersion + 1 })),
      };
    },
  };
  const requests = [];
  const approvalCalls = { accept: [], release: 0 };
  const approvalReservation = {
    digest: `sha256:${"f".repeat(64)}`,
    accept(proof) { approvalCalls.accept.push(proof); },
    release() { approvalCalls.release++; },
  };
  const adapter = {
    async transact(request) {
      requests.push(request);
      if (request.kind === "prepare-settlement") {
        return {
          kind: "awaiting-text",
          operationId: request.operationId,
          operationDigest: request.operationDigest,
          affectedResourceDigest: request.affectedResourceDigest,
          textOverlay: request.textOverlay,
          approvalAcceptanceProof: `approval:${request.operationDigest}`,
        };
      }
      assert.equal(request.kind, "ack-settlement-text");
      return {
        kind: "settlement-committed",
        operationId: request.operationId,
        receipt: "receipt-a",
      };
    },
  };

  const result = await executeSettlement({
    plan,
    adapter,
    barrier,
    coordinator,
    uriFor: () => uri,
    approvalReservation,
  });

  assert.deepEqual(result, {
    kind: "settlement-committed",
    operationId: plan.operationId,
    receipt: "receipt-a",
  });
  assert.equal(acquireCalls.length, 1);
  assert.equal(acquireCalls[0].reason, "settlement");
  assert.deepEqual(acquireCalls[0].resources, [{
    uri,
    expectedVersion: 7,
    expectedDigest: plan.textOperations[0].currentDigest,
    intendedDigest: plan.textOperations[0].intendedDigest,
    requireClean: false,
  }]);
  assert.equal(coordinatorCalls.length, 1);
  assert.equal(coordinatorCalls[0].origin, "settlement");
  assert.equal(requests[0].kind, "prepare-settlement");
  assert.equal(requests[1].kind, "ack-settlement-text");
  assert.equal(requests[1].textProof.resources[0].intendedDigest, plan.textOperations[0].intendedDigest);
  assert.equal(leaseCalls.revalidate, 2);
  assert.equal(leaseCalls.apply, 1);
  assert.equal(leaseCalls.dispose, 1);
  assert.deepEqual(approvalCalls.accept, [`approval:${plan.operationDigest}`]);
  assert.equal(approvalCalls.release, 0);
});

test("transaction settlement consumes one review token and one durable human approval", async () => {
  const fixture = reviewFixture();
  let sequence = 0;
  const capabilities = createDocumentationCapabilityIssuer({
    clock: { now: () => 1_000 },
    randomUUID: () => `settlement-capability-${++sequence}`,
  });
  const scope = capabilities.issueScope({ uri: "file:///workspace", authority: "local", epoch: "epoch-a" });
  const scopeRecord = capabilities.consumeScope(scope);
  const registry = createReviewSnapshotRegistry({
    clock: { now: () => 1_000 },
    randomUUID: () => `settlement-review-${++sequence}`,
  });
  let pathSnapshots = 0;
  const requests = [];
  const adapter = {
    async snapshot(request) {
      if (request.kind === "documentation-state") return {
        kind: "documentation-state",
        epoch: "epoch-a",
        pages: [],
        state: {
          kind: "file",
          bytes: Buffer.from('{"schemaVersion":1,"generation":"0000000000000002","documents":{}}\n').toString("base64url"),
          sha256: sha256('{"schemaVersion":1,"generation":"0000000000000002","documents":{}}\n'),
          revision: `sha256:${sha256('{"schemaVersion":1,"generation":"0000000000000002","documents":{}}\n')}`,
        },
      };
      pathSnapshots++;
      return {
        kind: "snapshot",
        epoch: "epoch-a",
        entries: request.paths.map(path => ({
          path: `documentation/${path.value}`,
          type: "file",
          bytes: Buffer.from(fixture.currentText).toString("base64url"),
          sha256: sha256(fixture.currentText),
          revision: pathSnapshots === 1 ? revision(fixture.currentText) : openRevision(fixture.currentText, 7),
          dirty: true,
        })),
      };
    },
    async transact(request) {
      requests.push(request);
      if (request.kind === "prepare-settlement") return {
        kind: "awaiting-text",
        operationId: request.operationId,
        operationDigest: request.operationDigest,
        affectedResourceDigest: request.affectedResourceDigest,
        textOverlay: request.textOverlay,
        approvalAcceptanceProof: `sha256:${"a".repeat(64)}`,
      };
      return { kind: "settlement-committed", operationId: request.operationId, receipt: request.operationId };
    },
  };
  const uri = Object.freeze({ toString: () => "file:///workspace/documentation/topic.qmd" });
  const lease = {
    async revalidate() { return { kind: "valid" }; },
    async applyWorkspaceEdit() { return true; },
    dispose() {},
  };
  const transactions = createDocumentationTransactions({
    adapter,
    capabilities,
    scope,
    reviewRegistry: registry,
    workspaceView: { capture() { return { proofs: [] }; }, revalidate() {} },
    changeSetStore: {
      async loadGeneration() { return fixture.generation; },
      async loadCurrentRef() { return { kind: "current-generation", ref: fixture.generation.ref }; },
      async stageGeneration() { throw new Error("unexpected stage"); },
    },
    settlement: {
      barrier: { async acquire() { return lease; } },
      coordinator: {
        async applyVersionedTextEdits(input) {
          await input.applyWorkspaceEdit({});
          return { kind: "applied", operationId: input.operationId, versions: [{ uri, before: 7, after: 8 }] };
        },
      },
      uriFor: () => uri,
    },
  });
  const review = await transactions.review(fixture.generation.ref);
  const input = Object.freeze({
    reviewToken: review.reviewToken,
    reviewDigest: review.reviewDigest,
    decisions: Object.freeze(review.leaves.map(value => Object.freeze({ id: value.id, decision: "accept" }))),
    idempotencyKey: "settle-transaction-a",
  });
  const approval = capabilities.issueHumanApproval(scope, {
    digest: settlementApprovalDigest(input),
    expiresInMs: 30_000,
  });
  const result = await transactions.settle(approval, input);
  assert.equal(result.kind, "settlement-committed");
  assert.deepEqual(requests.map(value => value.kind), ["prepare-settlement", "ack-settlement-text"]);
  assert.equal(requests[0].approvalReservationDigest.startsWith("sha256:"), true);
  assert.throws(
    () => capabilities.consumeHumanApproval(approval, settlementApprovalDigest(input), { scope }),
    /already consumed/,
  );
  assert.equal(scopeRecord.epoch, "epoch-a");
});
