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
  const picks = [];
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
      async showQuickPick(items, options) {
        picks.push({ items, options });
        return items.filter(value => value.picked === true);
      },
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
  assert.equal(picks.length, 1);
  assert.equal(picks[0].options.canPickMany, true);
  assert.deepEqual(picks[0].items.map(value => value.leaf.id), ["hunk-a"]);
});

test("one batched picker collects accept, reject and defer without a modal per decision leaf", async () => {
  const { registerDocumentationReview } = require("../extensions/chatero-documentation/documentation-review.cjs");
  const commands = new Map();
  const picks = [];
  const vscode = {
    Uri: TestUri,
    QuickPickItemKind: { Separator: -1 },
    workspace: {
      isTrusted: true,
      registerTextDocumentContentProvider() { return { dispose() {} }; },
    },
    commands: {
      registerCommand(id, callback) { commands.set(id, callback); return { dispose() {} }; },
      async executeCommand() {},
    },
    window: {
      async showQuickPick(items, options) {
        picks.push({ items, options });
        const selectable = items.filter(value => value.leaf);
        // First picker accepts only "hunk-a"; second picker defers "hunk-b" and rejects "hunk-c".
        return picks.length === 1
          ? selectable.filter(value => value.leaf.id === "hunk-a")
          : selectable.filter(value => value.leaf.id === "hunk-b");
      },
      async showInformationMessage(message, _options, action) { picks.push({ message }); return action; },
      async showErrorMessage() {},
    },
  };
  const leaf = (id, value) => Object.freeze({
    id,
    kind: "hunk",
    operationId: "edit-a",
    path: Object.freeze({ kind: "documentation-page", value }),
    dependsOn: Object.freeze([]),
  });
  const snapshot = Object.freeze({
    reviewToken: "review-token-b",
    reviewDigest: `sha256:${"c".repeat(64)}`,
    documents: Object.freeze([]),
    leaves: Object.freeze([leaf("hunk-a", "topic.qmd"), leaf("hunk-b", "topic.qmd"), leaf("hunk-c", "other.qmd")]),
  });
  const settled = [];
  const services = {
    randomUUID: () => "review-command-b",
    scope: Object.freeze({ kind: "opaque-workspace-scope" }),
    transactions: {
      async review() { return snapshot; },
      async settle(_approval, input) { settled.push(input); return { kind: "settlement-committed" }; },
    },
    capabilities: { issueHumanApproval: () => Object.freeze({ kind: "human-approval" }) },
  };
  await registerDocumentationReview({ vscode, services });
  const result = await commands.get("chatero.documentation.reviewChangeSet")({
    lineageId: "review-b",
    generationId: "0000000000000002",
  });

  assert.equal(result.kind, "settlement-committed");
  assert.deepEqual(settled[0].decisions, [
    { id: "hunk-a", decision: "accept" },
    { id: "hunk-b", decision: "defer" },
    { id: "hunk-c", decision: "reject" },
  ]);
  assert.equal(picks.filter(value => value.options).length, 2);
  assert.equal(picks[0].items.filter(value => value.kind === -1).length, 2);
  assert.deepEqual(picks[1].items.filter(value => value.leaf).map(value => value.leaf.id), ["hunk-b", "hunk-c"]);
  assert.match(picks[2].message, /Apply 1 accepted Documentation change and defer 1\?/u);
});
