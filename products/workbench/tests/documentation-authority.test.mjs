import assert from "node:assert/strict";
import { test } from "node:test";

import {
  documentationAssetPath,
  documentationPagePath,
  documentationWorkspaceUri,
  validateOperationPathSet,
} from "../extensions/chatero-documentation/documentation-path.mjs";
import {
  createDocumentationCapabilityIssuer,
} from "../extensions/chatero-documentation/documentation-capabilities.mjs";

const requestDigest = "a".repeat(64);
const workspaceUri = "vscode-remote://chatero-remote+lab/srv/research";

test("Documentation paths are normalized relative branded values", () => {
  for (const value of [
    "",
    "/index.qmd",
    "file:///index.qmd",
    "..\\index.qmd",
    "a/../b.qmd",
    "../index.qmd",
    "%2e%2e/index.qmd",
    "a/%2F/b.qmd",
    "a//b.qmd",
    "a\0b.qmd",
    "a\nb.qmd",
    "a?query.qmd",
    "a#fragment.qmd",
    "C:/index.qmd",
  ]) {
    assert.throws(() => documentationPagePath(value), { name: "TypeError" });
  }

  const index = documentationPagePath("index.qmd");
  const nested = documentationPagePath("topics/result.qmd");
  assert.deepEqual(index, { kind: "documentation-page", value: "index.qmd" });
  assert.equal(nested.value, "topics/result.qmd");
  assert.equal(Object.isFrozen(nested), true);
  assert.equal(documentationPagePath("topics/e\u0301.qmd").value, "topics/é.qmd");
  assert.throws(() => documentationPagePath("topics/result.md"), /\.qmd/);

  const asset = documentationAssetPath("assets/figure.png");
  assert.deepEqual(asset, { kind: "documentation-asset", value: "assets/figure.png" });
  assert.equal(Object.isFrozen(asset), true);
  assert.throws(() => documentationAssetPath("assets/source.qmd"), /page path/);
});

test("Documentation workspace URIs preserve the trusted workspace authority", () => {
  const workspace = {
    scheme: "vscode-remote",
    authority: "chatero-remote+lab",
    path: "/srv/research",
    query: "",
    fragment: "",
    with(changes) { return { ...this, ...changes }; },
  };
  const result = documentationWorkspaceUri(workspace, documentationPagePath("topics/result.qmd"));
  assert.equal(result.scheme, "vscode-remote");
  assert.equal(result.authority, "chatero-remote+lab");
  assert.equal(result.path, "/srv/research/documentation/topics/result.qmd");
  assert.equal(Object.isFrozen(result), true);
  assert.throws(
    () => documentationWorkspaceUri(workspace, structuredClone(documentationPagePath("index.qmd"))),
    /unrecognized Documentation path/,
  );
  assert.throws(
    () => documentationWorkspaceUri({ ...workspace, query: "changed=1" }, documentationPagePath("index.qmd")),
    /query or fragment/,
  );
});

test("operation path sets reject aliases and structural ambiguity", () => {
  const a = documentationPagePath("a.qmd");
  const b = documentationPagePath("b.qmd");
  const c = documentationPagePath("c.qmd");
  const valid = validateOperationPathSet([
    { kind: "edit", path: a },
    { kind: "rename", source: b, destination: c },
  ]);
  assert.equal(Object.isFrozen(valid), true);
  assert.equal(valid.length, 2);

  const invalidSets = [
    [
      { kind: "edit", path: a },
      { kind: "delete", path: a },
    ],
    [
      { kind: "create", path: documentationPagePath("Topic.qmd") },
      { kind: "create", path: documentationPagePath("topic.qmd") },
    ],
    [
      { kind: "create", path: documentationAssetPath("topic") },
      { kind: "create", path: documentationPagePath("topic/result.qmd") },
    ],
    [
      { kind: "rename", source: a, destination: b },
      { kind: "rename", source: b, destination: a },
    ],
    [
      { kind: "create", path: b },
      { kind: "rename", source: a, destination: b },
    ],
    [
      { kind: "rename", source: a, destination: b },
      { kind: "edit", path: a },
    ],
  ];
  for (const operations of invalidSets) {
    assert.throws(() => validateOperationPathSet(operations), TypeError);
  }
  assert.throws(
    () => validateOperationPathSet([{ kind: "edit", path: { kind: "documentation-page", value: "a.qmd" } }]),
    /unrecognized Documentation path/,
  );
});

function createIssuerHarness() {
  let now = 1_000;
  let sequence = 0;
  const issuer = createDocumentationCapabilityIssuer({
    clock: { now: () => now },
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  return {
    issuer,
    setNow(value) { now = value; },
  };
}

test("approval capabilities reject clones, wrong scopes, expiry, and replay", () => {
  const harness = createIssuerHarness();
  const { issuer } = harness;
  assert.deepEqual(Object.keys(issuer), [
    "issueScope",
    "consumeScope",
    "issueAgentProposalGrant",
    "consumeAgentProposalGrant",
    "issueHumanApproval",
    "consumeHumanApproval",
    "issueMigrationApproval",
    "consumeMigrationApproval",
    "issueRecoveryApproval",
    "consumeRecoveryApproval",
  ]);
  assert.doesNotMatch(Object.keys(issuer).join(" "), /constructor|map|root|read|write|file/i);

  const scope = issuer.issueScope({ uri: workspaceUri, authority: "chatero-remote+lab", epoch: "epoch-1" });
  assert.deepEqual(Object.keys(scope), ["kind"]);
  assert.equal(Object.isFrozen(scope), true);
  assert.equal(JSON.stringify(scope).includes("/srv/research"), false);
  assert.equal(issuer.consumeScope(scope).epoch, "epoch-1");
  assert.throws(() => issuer.consumeScope(structuredClone(scope)), /unrecognized capability/);

  const approval = issuer.issueHumanApproval(scope, { digest: requestDigest, expiresInMs: 30_000 });
  assert.throws(() => issuer.consumeHumanApproval(structuredClone(approval), requestDigest), /unrecognized capability/);
  assert.throws(() => issuer.consumeHumanApproval(approval, "b".repeat(64)), /digest/);

  const otherAuthority = issuer.issueScope({
    uri: "vscode-remote://chatero-remote+other/srv/research",
    authority: "chatero-remote+other",
    epoch: "epoch-1",
  });
  assert.throws(
    () => issuer.consumeHumanApproval(approval, requestDigest, { scope: otherAuthority }),
    /authority/,
  );
  const nextEpoch = issuer.issueScope({ uri: workspaceUri, authority: "chatero-remote+lab", epoch: "epoch-2" });
  assert.throws(
    () => issuer.consumeHumanApproval(approval, requestDigest, { scope: nextEpoch }),
    /epoch/,
  );

  const currentApproval = issuer.issueHumanApproval(nextEpoch, { digest: requestDigest, expiresInMs: 30_000 });
  assert.equal(issuer.consumeHumanApproval(currentApproval, requestDigest, { scope: nextEpoch }).epoch, "epoch-2");
  assert.throws(() => issuer.consumeHumanApproval(currentApproval, requestDigest), /already consumed/);

  const expired = issuer.issueHumanApproval(nextEpoch, { digest: requestDigest, expiresInMs: 10 });
  harness.setNow(1_011);
  assert.throws(() => issuer.consumeHumanApproval(expired, requestDigest), /expired/);
});

test("migration, recovery, and Agent grants stay type- and scope-bound", () => {
  const { issuer } = createIssuerHarness();
  const scope = issuer.issueScope({ uri: "file:///srv/research", authority: "local", epoch: "epoch-local" });

  const migration = issuer.issueMigrationApproval(scope, { digest: requestDigest, expiresInMs: 30_000 });
  const recovery = issuer.issueRecoveryApproval(scope, { digest: requestDigest, expiresInMs: 30_000 });
  assert.throws(() => issuer.consumeRecoveryApproval(migration, requestDigest), /unrecognized capability/);
  assert.equal(issuer.consumeMigrationApproval(migration, requestDigest, { scope }).kind, "migration-approval");
  assert.equal(issuer.consumeRecoveryApproval(recovery, requestDigest, { scope }).kind, "recovery-approval");

  const grant = issuer.issueAgentProposalGrant(scope, {
    paths: [documentationAssetPath("topics")],
    operationKinds: ["create", "edit"],
    maximumOperationCount: 2,
    maximumProposedBytes: 64,
    expiresInMs: 30_000,
  });
  const record = issuer.consumeAgentProposalGrant(grant, {
    scope,
    paths: [documentationPagePath("topics/new.qmd")],
    operationKinds: ["create"],
    operationCount: 1,
    proposedBytes: 32,
  });
  assert.equal(record.kind, "agent-proposal-grant");
  assert.match(record.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(record.pathPrefixes, ["topics"]);
  assert.throws(() => issuer.consumeAgentProposalGrant(grant, {
    scope,
    paths: [documentationPagePath("topics/again.qmd")],
    operationKinds: ["create"],
    operationCount: 1,
    proposedBytes: 1,
  }), /already consumed/);

  for (const request of [
    {
      paths: [documentationPagePath("outside.qmd")],
      operationKinds: ["create"], operationCount: 1, proposedBytes: 1,
    },
    {
      paths: [documentationPagePath("topics/new.qmd")],
      operationKinds: ["delete"], operationCount: 1, proposedBytes: 1,
    },
    {
      paths: [documentationPagePath("topics/new.qmd")],
      operationKinds: ["create"], operationCount: 3, proposedBytes: 1,
    },
    {
      paths: [documentationPagePath("topics/new.qmd")],
      operationKinds: ["create"], operationCount: 1, proposedBytes: 65,
    },
  ]) {
    const bounded = issuer.issueAgentProposalGrant(scope, {
      paths: [documentationAssetPath("topics")],
      operationKinds: ["create", "edit"],
      maximumOperationCount: 2,
      maximumProposedBytes: 64,
      expiresInMs: 30_000,
    });
    assert.throws(() => issuer.consumeAgentProposalGrant(bounded, { scope, ...request }), /grant/);
  }

  const otherIssuer = createIssuerHarness().issuer;
  assert.throws(() => otherIssuer.issueHumanApproval(scope, {
    digest: requestDigest,
    expiresInMs: 30_000,
  }), /unrecognized capability/);
});
