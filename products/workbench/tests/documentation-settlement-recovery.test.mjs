import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { recoverSettlement } from "../extensions/chatero-documentation/settlement-recovery.mjs";

const digest = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function uri(value) {
  return Object.freeze({ value, toString() { return this.value; } });
}

test("recovery reapplies exact before text under one barrier and acknowledges intended bytes", async () => {
  const target = uri("file:///workspace/documentation/topic.qmd");
  const before = "before\n";
  const intended = "after\n";
  const document = {
    uri: target,
    version: 3,
    isDirty: false,
    text: before,
    getText() { return this.text; },
  };
  const calls = { acquire: [], edits: [], transact: [] };
  const lease = {
    async revalidate() { return { kind: "valid" }; },
    async applyWorkspaceEdit() { return true; },
    dispose() {},
  };
  const adapter = {
    async recover(request) {
      assert.deepEqual(request, { kind: "inspect-settlement", schemaVersion: 1 });
      return {
        kind: "awaiting-text",
        operationId: "settle-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        operationDigest: `sha256:${"a".repeat(64)}`,
        affectedResourceDigest: `sha256:${"b".repeat(64)}`,
        textOverlay: [{
          operationId: "edit-a",
          path: "topic.qmd",
          expectedVersion: 7,
          currentRevision: `text-document:7:${digest(before)}`,
          beforeDigest: digest(before),
          intendedText: intended,
          intendedDigest: digest(intended),
        }],
        approvalAcceptanceProof: `sha256:${"c".repeat(64)}`,
      };
    },
    async transact(request) {
      calls.transact.push(request);
      return { kind: "settlement-committed", operationId: request.operationId, receipt: "receipt-a" };
    },
  };
  const result = await recoverSettlement({
    adapter,
    barrier: { async acquire(input) { calls.acquire.push(input); return lease; } },
    coordinator: {
      async applyVersionedTextEdits(input) {
        calls.edits.push(input);
        document.text = intended;
        document.version++;
        return { kind: "applied", operationId: input.operationId, versions: [{ uri: target, before: 3, after: 4 }] };
      },
    },
    uriFor: () => target,
    openDocuments: async () => [document],
  });
  assert.equal(result.kind, "settlement-committed");
  assert.equal(calls.acquire.length, 1);
  assert.equal(calls.acquire[0].reason, "recovery");
  assert.equal(calls.edits.length, 1);
  assert.equal(calls.transact[0].textProof.kind, "settlement-recovery-text-proof");
  assert.equal(calls.transact[0].textProof.resources[0].action, "apply-intended");
  assert.equal(calls.transact[0].textProof.resources[0].observedDigest, digest(before));
});

test("recovery preserves unknown human bytes and keeps the barrier active", async () => {
  const target = uri("file:///workspace/documentation/topic.qmd");
  const document = {
    uri: target,
    version: 9,
    isDirty: true,
    getText: () => "third-party\n",
  };
  let disposed = 0;
  let mutations = 0;
  const result = await recoverSettlement({
    adapter: {
      async recover() {
        return {
          kind: "awaiting-text",
          operationId: "settle-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          operationDigest: `sha256:${"d".repeat(64)}`,
          affectedResourceDigest: `sha256:${"e".repeat(64)}`,
          textOverlay: [{
            operationId: "edit-b", path: "topic.qmd", expectedVersion: 1,
            currentRevision: `text-document:1:${digest("before\n")}`,
            beforeDigest: digest("before\n"), intendedText: "after\n", intendedDigest: digest("after\n"),
          }],
          approvalAcceptanceProof: `sha256:${"f".repeat(64)}`,
        };
      },
      async transact() { mutations++; },
    },
    barrier: {
      async acquire() {
        return {
          async revalidate() { return { kind: "valid" }; },
          async applyWorkspaceEdit() { mutations++; },
          dispose() { disposed++; },
        };
      },
    },
    coordinator: { async applyVersionedTextEdits() { mutations++; } },
    uriFor: () => target,
    openDocuments: async () => [document],
  });
  assert.equal(result.kind, "recovery-conflict");
  assert.equal(result.resources[0].classification, "unknown");
  assert.equal(mutations, 0);
  assert.equal(disposed, 0);
});
