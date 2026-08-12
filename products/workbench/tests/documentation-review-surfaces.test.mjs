import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);

class TestUri {
  constructor({ scheme, path, query = "" }) { Object.assign(this, { scheme, path, query, authority: "" }); }
  toString() { return `${this.scheme}:${this.path}?${this.query}`; }
  static from(value) { return new TestUri(value); }
}

test("one human-only review command projects one snapshot into diff and settlement", async () => {
  const { registerDocumentationReview } = require("../extensions/chatero-documentation/documentation-review.cjs");
  const commands = new Map();
  const executed = [];
  const providers = new Map();
  const vscode = {
    Uri: TestUri,
    workspace: {
      isTrusted: true,
      registerTextDocumentContentProvider(scheme, provider) {
        providers.set(scheme, provider);
        return { dispose() { providers.delete(scheme); } };
      },
    },
    commands: {
      registerCommand(id, callback) {
        commands.set(id, callback);
        return { dispose() { commands.delete(id); } };
      },
      async executeCommand(...args) { executed.push(args); },
    },
    window: {
      async showQuickPick(items) { return items.find(value => value.value === "accept"); },
      async showInformationMessage(_message, _options, action) { return action; },
      async showErrorMessage() {},
    },
  };
  const snapshot = Object.freeze({
    reviewToken: "review-token-a",
    reviewDigest: `sha256:${"a".repeat(64)}`,
    generationDigest: `sha256:${"b".repeat(64)}`,
    documents: Object.freeze([Object.freeze({
      operationId: "edit-a",
      kind: "edit",
      path: Object.freeze({ kind: "documentation-page", value: "topic.qmd" }),
      baseText: "before\n",
      currentText: "human\nbefore\n",
      proposedText: "after\n",
    })]),
    leaves: Object.freeze([Object.freeze({
      id: "hunk-a",
      kind: "hunk",
      operationId: "edit-a",
      path: Object.freeze({ kind: "documentation-page", value: "topic.qmd" }),
      dependsOn: Object.freeze([]),
    })]),
  });
  const calls = { review: [], settle: [], approvals: [] };
  const services = {
    randomUUID: () => "review-command-a",
    scope: Object.freeze({ kind: "opaque-workspace-scope" }),
    transactions: {
      async review(ref) { calls.review.push(ref); return snapshot; },
      async settle(approval, input) {
        calls.settle.push({ approval, input });
        return { kind: "settlement-committed", operationId: "settle-a", receipt: "receipt-a" };
      },
    },
    capabilities: {
      issueHumanApproval(scope, input) {
        calls.approvals.push({ scope, input });
        return Object.freeze({ kind: "human-approval" });
      },
    },
  };
  const registrations = await registerDocumentationReview({ vscode, services });
  const result = await commands.get("chatero.documentation.reviewChangeSet")({
    lineageId: "review-a",
    generationId: "0000000000000001",
  });

  assert.equal(result.kind, "settlement-committed");
  assert.deepEqual(calls.review, [{ lineageId: "review-a", generationId: "0000000000000001" }]);
  assert.equal(executed.length, 1);
  assert.equal(executed[0][0], "vscode.diff");
  assert.equal(providers.size, 1);
  assert.equal(providers.values().next().value.provideTextDocumentContent(executed[0][1]), "human\nbefore\n");
  assert.equal(providers.values().next().value.provideTextDocumentContent(executed[0][2]), "after\n");
  assert.deepEqual(calls.settle[0].input.decisions, [{ id: "hunk-a", decision: "accept" }]);
  assert.match(calls.approvals[0].input.digest, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(registrations.every(value => typeof value.dispose === "function"));
});
