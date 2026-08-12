import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  decodeAuthorityRequest,
  decodeAuthorityResponse,
  encodeAuthorityRequest,
  encodeAuthorityResponse,
} from "../documentation-authority/protocol.mjs";
import { createDocumentationCapabilityIssuer } from "../extensions/chatero-documentation/documentation-capabilities.mjs";
import { documentationPagePath } from "../extensions/chatero-documentation/documentation-path.mjs";
import {
  createDocumentationWorkspaceView,
  createWorkspaceTransactionAdapter,
} from "../extensions/chatero-documentation/documentation-workspace.mjs";
import { canonicalOperationDigest } from "../extensions/chatero-documentation/documentation-operations.mjs";
import { createDocumentationTransactions } from "../extensions/chatero-documentation/documentation-transactions.mjs";

const digest = value => createHash("sha256").update(value, "utf8").digest("hex");

class TestUri {
  constructor({ scheme, authority = "", path, query = "", fragment = "" }) {
    Object.assign(this, { scheme, authority, path, query, fragment });
  }

  with(changes) {
    return new TestUri({ ...this, ...changes });
  }

  toString() {
    const authority = this.authority ? `//${this.authority}` : "//";
    return `${this.scheme}:${authority}${this.path}`;
  }
}

function createScope(uri = "vscode-remote://chatero-remote+lab/srv/research", epoch = "epoch-1") {
  let sequence = 0;
  const capabilities = createDocumentationCapabilityIssuer({
    clock: { now: () => 1_000 },
    randomUUID: () => `scope-${++sequence}`,
  });
  const authority = new URL(uri).host || "local";
  return capabilities.consumeScope(capabilities.issueScope({ uri, authority, epoch }));
}

test("authority frames are canonical base64url with exact outer and snapshot fields", () => {
  const request = {
    protocolVersion: 1,
    requestId: "request-1",
    kind: "snapshot",
    workspace: "vscode-remote://chatero-remote+lab/srv/research",
    epoch: "epoch-1",
    snapshot: { kind: "paths", paths: [], overlays: [] },
  };
  const frame = encodeAuthorityRequest(request);
  assert.match(frame, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeAuthorityRequest(frame), request);
  assert.equal(encodeAuthorityRequest(decodeAuthorityRequest(frame)), frame);

  const response = {
    protocolVersion: 1,
    requestId: "request-1",
    result: { kind: "snapshot", epoch: "epoch-1", entries: [] },
  };
  assert.deepEqual(decodeAuthorityResponse(encodeAuthorityResponse(response)), response);

  const duplicateJson = '{"protocolVersion":1,"protocolVersion":1,"requestId":"request-1","kind":"snapshot","workspace":"vscode-remote://chatero-remote+lab/srv/research","epoch":"epoch-1","snapshot":{"kind":"paths","paths":[],"overlays":[]}}';
  assert.throws(
    () => decodeAuthorityRequest(Buffer.from(duplicateJson, "utf8").toString("base64url")),
    /duplicate JSON key/,
  );
  assert.throws(() => encodeAuthorityRequest({ ...request, unexpected: true }), /unknown field/);
  assert.throws(() => encodeAuthorityRequest({
    ...request,
    snapshot: { ...request.snapshot, outputRoot: "/tmp/output" },
  }), /unknown field/);
  assert.throws(() => decodeAuthorityRequest("not+base64"), /base64url/);
});

test("snapshot entries bind exact bytes, absence, and directory generations", () => {
  const bytes = "exact bytes\n";
  const sha256 = digest(bytes);
  const response = {
    protocolVersion: 1,
    requestId: "request-2",
    result: {
      kind: "snapshot",
      epoch: "epoch-1",
      entries: [
        {
          path: "documentation",
          type: "directory",
          directoryGeneration: `sha256:${"b".repeat(64)}`,
        },
        {
          path: "documentation/index.qmd",
          type: "file",
          bytes: Buffer.from(bytes, "utf8").toString("base64url"),
          sha256,
          revision: `sha256:${sha256}`,
        },
        { path: "documentation/missing.qmd", type: "absent" },
      ],
    },
  };
  assert.deepEqual(decodeAuthorityResponse(encodeAuthorityResponse(response)), response);
  assert.throws(() => encodeAuthorityResponse({
    ...response,
    result: {
      ...response.result,
      entries: response.result.entries.map(entry => entry.type === "file"
        ? { ...entry, sha256: "c".repeat(64) }
        : entry),
    },
  }), /digest/);
});

test("adapter sends dirty TextDocument evidence in one complete snapshot frame", async () => {
  const folder = {
    epoch: "epoch-1",
    uri: new TestUri({
      scheme: "vscode-remote",
      authority: "chatero-remote+lab",
      path: "/srv/research",
    }),
  };
  const document = {
    uri: folder.uri.with({ path: "/srv/research/documentation/topic.qmd" }),
    version: 9,
    isDirty: true,
    getText: () => "dirty buffer\n",
  };
  const scope = createScope();
  const workspaceView = createDocumentationWorkspaceView({
    workspaceFolders: [folder],
    textDocuments: [document],
  });
  const frames = [];
  const transport = {
    async request(frame) {
      const request = decodeAuthorityRequest(frame);
      frames.push(request);
      return encodeAuthorityResponse({
        protocolVersion: 1,
        requestId: request.requestId,
        result: { kind: "snapshot", epoch: "epoch-1", entries: [] },
      });
    },
  };
  const adapter = createWorkspaceTransactionAdapter({ scope, transport, workspaceView });
  assert.deepEqual(Object.keys(adapter), ["snapshot", "transact", "recover"]);
  assert.equal(adapter.read, undefined);
  assert.equal(adapter.write, undefined);
  assert.equal(adapter.exists, undefined);
  assert.equal(adapter.realpath, undefined);

  const result = await adapter.snapshot({
    kind: "paths",
    paths: [documentationPagePath("topic.qmd"), documentationPagePath("missing.qmd")],
  });
  assert.equal(result.kind, "snapshot");
  assert.deepEqual(frames.map(frame => frame.kind), ["snapshot"]);
  assert.deepEqual(frames[0].snapshot.paths, [
    "documentation/topic.qmd",
    "documentation/missing.qmd",
  ]);
  assert.deepEqual(frames[0].snapshot.overlays, [{
    uri: "vscode-remote://chatero-remote+lab/srv/research/documentation/topic.qmd",
    version: 9,
    dirty: true,
    text: "dirty buffer\n",
    revision: `text-document:9:sha256:${digest("dirty buffer\n")}`,
  }]);
});

test("adapter rejects changed overlays, workspace epochs, and foreign scopes", async () => {
  const folder = {
    epoch: "epoch-1",
    uri: new TestUri({ scheme: "file", path: "/srv/research" }),
  };
  let text = "before\n";
  const document = {
    uri: folder.uri.with({ path: "/srv/research/documentation/index.qmd" }),
    version: 1,
    isDirty: false,
    getText: () => text,
  };
  const scope = createScope("file:///srv/research");
  const workspaceView = createDocumentationWorkspaceView({
    workspaceFolders: [folder],
    textDocuments: [document],
  });
  const changingTransport = {
    async request(frame) {
      const request = decodeAuthorityRequest(frame);
      document.version = 2;
      document.isDirty = true;
      text = "after\n";
      return encodeAuthorityResponse({
        protocolVersion: 1,
        requestId: request.requestId,
        result: { kind: "snapshot", epoch: "epoch-1", entries: [] },
      });
    },
  };
  await assert.rejects(
    createWorkspaceTransactionAdapter({ scope, transport: changingTransport, workspaceView })
      .snapshot({ kind: "paths", paths: [documentationPagePath("index.qmd")] }),
    /working copy changed/,
  );

  document.version = 1;
  document.isDirty = false;
  text = "before\n";
  const epochTransport = {
    async request(frame) {
      const request = decodeAuthorityRequest(frame);
      folder.epoch = "epoch-2";
      return encodeAuthorityResponse({
        protocolVersion: 1,
        requestId: request.requestId,
        result: { kind: "snapshot", epoch: "epoch-1", entries: [] },
      });
    },
  };
  await assert.rejects(
    createWorkspaceTransactionAdapter({ scope, transport: epochTransport, workspaceView })
      .snapshot({ kind: "paths", paths: [documentationPagePath("index.qmd")] }),
    /workspace epoch changed/,
  );

  const foreignScope = createScope("file:///srv/other");
  await assert.rejects(
    createWorkspaceTransactionAdapter({ scope: foreignScope, transport: changingTransport, workspaceView })
      .snapshot({ kind: "paths", paths: [] }),
    /workspace scope is unavailable/,
  );
});

test("state facade binds a clean reviewed command to scope, revision, and generation", async () => {
  let sequence = 0;
  const capabilities = createDocumentationCapabilityIssuer({
    clock: { now: () => 1_000 },
    randomUUID: () => `capability-${++sequence}`,
  });
  const scope = capabilities.issueScope({
    uri: "file:///srv/research",
    authority: "local",
    epoch: "epoch-1",
  });
  const scopeRecord = capabilities.consumeScope(scope);
  const folder = {
    epoch: "epoch-1",
    uri: new TestUri({ scheme: "file", path: "/srv/research" }),
  };
  const pageText = "# Inspected\n";
  const pageRevision = `text-document:3:sha256:${digest(pageText)}`;
  const document = {
    uri: folder.uri.with({ path: "/srv/research/documentation/index.qmd" }),
    version: 3,
    isDirty: false,
    getText: () => pageText,
  };
  const stateBytes = Buffer.from(
    '{"schemaVersion":1,"generation":"0000000000000001","documents":{"index.qmd":{"state":"working"}}}\n',
  );
  const transactionRequests = [];
  const adapter = {
    async snapshot(request) {
      assert.deepEqual(request, {
        kind: "documentation-state",
        workspaceScopeDigest: scopeRecord.workspaceScopeDigest,
      });
      return {
        kind: "documentation-state",
        epoch: "epoch-1",
        pages: [{ path: "index.qmd", revision: pageRevision }],
        state: {
          kind: "file",
          bytes: stateBytes.toString("base64url"),
          sha256: digest(stateBytes),
          revision: `sha256:${digest(stateBytes)}`,
        },
      };
    },
    async transact(request) {
      transactionRequests.push(request);
      return {
        kind: "state-committed",
        generation: "0000000000000002",
        receipt: "state-index-reviewed-1",
      };
    },
    async recover() { throw new Error("unexpected recovery"); },
  };
  const workspaceView = createDocumentationWorkspaceView({
    workspaceFolders: [folder],
    textDocuments: [document],
  });
  const transactions = createDocumentationTransactions({ adapter, capabilities, workspaceView });
  assert.deepEqual(Object.keys(transactions), ["state", "setDocumentState"]);
  const projected = await transactions.state(scope);
  assert.equal(projected.documents["index.qmd"].state, "working");

  const input = Object.freeze({
    path: documentationPagePath("index.qmd"),
    expectedDocumentRevision: pageRevision,
    expectedStateGeneration: "0000000000000001",
    state: "reviewed",
    idempotencyKey: "state-index-reviewed-1",
  });
  const requestDigest = canonicalOperationDigest(input);
  const approval = capabilities.issueHumanApproval(scope, { digest: requestDigest, expiresInMs: 30_000 });
  assert.deepEqual(await transactions.setDocumentState(approval, input), {
    kind: "state-committed",
    generation: "0000000000000002",
    receipt: "state-index-reviewed-1",
  });
  assert.equal(transactionRequests.length, 1);
  assert.deepEqual(transactionRequests[0], {
    kind: "set-document-state",
    schemaVersion: 1,
    operationId: transactionRequests[0].operationId,
    idempotencyKey: input.idempotencyKey,
    requestDigest,
    workspaceEpoch: "epoch-1",
    workspaceScopeDigest: scopeRecord.workspaceScopeDigest,
    path: "index.qmd",
    expectedDocumentRevision: pageRevision,
    expectedStateGeneration: "0000000000000001",
    intendedState: "reviewed",
    workingCopy: {
      version: 3,
      dirty: false,
      revision: pageRevision,
    },
  });
  assert.doesNotMatch(JSON.stringify(transactionRequests[0]), /approval|\/srv\/research/);
});

test("state facade refuses dirty and stale working copies before adapter mutation", async () => {
  let sequence = 0;
  const capabilities = createDocumentationCapabilityIssuer({
    clock: { now: () => 1_000 },
    randomUUID: () => `capability-${++sequence}`,
  });
  const scope = capabilities.issueScope({ uri: "file:///srv/research", authority: "local", epoch: "epoch-1" });
  const folder = { epoch: "epoch-1", uri: new TestUri({ scheme: "file", path: "/srv/research" }) };
  const document = {
    uri: folder.uri.with({ path: "/srv/research/documentation/index.qmd" }),
    version: 4,
    isDirty: true,
    getText: () => "dirty\n",
  };
  let mutations = 0;
  const transactions = createDocumentationTransactions({
    adapter: {
      async snapshot() { throw new Error("unexpected snapshot"); },
      async transact() { mutations++; },
      async recover() { mutations++; },
    },
    capabilities,
    workspaceView: createDocumentationWorkspaceView({ workspaceFolders: [folder], textDocuments: [document] }),
  });
  const input = {
    path: documentationPagePath("index.qmd"),
    expectedDocumentRevision: `text-document:4:sha256:${digest("dirty\n")}`,
    expectedStateGeneration: "0000000000000001",
    state: "reviewed",
    idempotencyKey: "dirty-reviewed-1",
  };
  const approval = capabilities.issueHumanApproval(scope, {
    digest: canonicalOperationDigest(input),
    expiresInMs: 30_000,
  });
  assert.deepEqual(await transactions.setDocumentState(approval, input), {
    kind: "dirty-working-copy",
    paths: [input.path],
  });
  assert.equal(mutations, 0);
});
