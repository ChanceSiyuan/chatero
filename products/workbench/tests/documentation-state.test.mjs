import assert from "node:assert/strict";
import { test } from "node:test";

import { documentationPagePath } from "../extensions/chatero-documentation/documentation-path.mjs";
import {
  compareUtf8Bytes,
  nextStateGeneration,
  parseDocumentationState,
  projectDocumentationState,
  serializeDocumentationState,
} from "../extensions/chatero-documentation/documentation-state.mjs";
import {
  canonicalOperationDigest,
  createStateTransactionExecutor,
  stateOperationId,
} from "../extensions/chatero-documentation/documentation-operations.mjs";

const STATE_PATH = ".chatero/documentation-state.v1.json";

test("parses and serializes only the exact canonical state snapshot", () => {
  const bytes = Buffer.from(
    '{"schemaVersion":1,"generation":"0000000000000001","documents":{"index.qmd":{"state":"reviewed"}}}\n',
  );
  const valid = parseDocumentationState(bytes);
  assert.equal(valid.kind, "valid");
  assert.equal(valid.state.documents["index.qmd"].state, "reviewed");
  assert.equal(Object.isFrozen(valid.state.documents), true);
  assert.deepEqual(serializeDocumentationState(valid.state), bytes);

  const state = {
    schemaVersion: 1,
    generation: "000000000000000a",
    documents: {
      "中.qmd": { state: "working" },
      "ä.qmd": { state: "reviewed" },
      "z.qmd": { state: "working" },
    },
  };
  const serialized = serializeDocumentationState(state).toString("utf8");
  assert.ok(serialized.indexOf('"z.qmd"') < serialized.indexOf('"ä.qmd"'));
  assert.ok(serialized.indexOf('"ä.qmd"') < serialized.indexOf('"中.qmd"'));
  assert.equal(compareUtf8Bytes("ä.qmd", "中.qmd") < 0, true);
});

test("invalid or missing state snapshots project every current page as working", () => {
  const pages = [documentationPagePath("index.qmd"), documentationPagePath("topics/result.qmd")];
  const invalidBytes = [
    Buffer.from("{"),
    Buffer.from('{"schemaVersion":2}\n'),
    Buffer.from('{"schemaVersion":1,"generation":"1","documents":{}}\n'),
    Buffer.from('{"schemaVersion":1,"generation":"0000000000000001","documents":{"index.qmd":{"state":"reviewed","extra":true}}}\n'),
    Buffer.from('{"schemaVersion":1,"generation":"0000000000000001","documents":{"../index.qmd":{"state":"reviewed"}}}\n'),
    Buffer.from('{"schemaVersion":1,"generation":"0000000000000001","documents":{"Topic.qmd":{"state":"reviewed"},"topic.qmd":{"state":"working"}}}\n'),
    Buffer.from('{"schemaVersion":1,"generation":"0000000000000001","documents":{"index.qmd":{"state":"reviewed"}},"extra":true}\n'),
    Buffer.from('{"generation":"0000000000000001","schemaVersion":1,"documents":{}}\n'),
  ];

  for (const bytes of [null, ...invalidBytes]) {
    const projected = projectDocumentationState({ pages, parsed: parseDocumentationState(bytes) });
    assert.deepEqual(projected.documents, {
      "index.qmd": { state: "working" },
      "topics/result.qmd": { state: "working" },
    });
    assert.equal(projected.diagnostics.length, 1);
    assert.equal(projected.diagnostics[0].path, STATE_PATH);
  }
});

test("valid state preserves same-path edits and reports external structural changes", () => {
  const parsed = parseDocumentationState(Buffer.from(
    '{"schemaVersion":1,"generation":"0000000000000002","documents":{"old.qmd":{"state":"reviewed"},"stable.qmd":{"state":"reviewed"}}}\n',
  ));
  const samePaths = projectDocumentationState({
    pages: [documentationPagePath("old.qmd"), documentationPagePath("stable.qmd")],
    parsed,
  });
  assert.equal(samePaths.documents["old.qmd"].state, "reviewed");
  assert.equal(samePaths.documents["stable.qmd"].state, "reviewed");
  assert.deepEqual(samePaths.diagnostics, []);

  const renamed = projectDocumentationState({
    pages: [documentationPagePath("new.qmd"), documentationPagePath("stable.qmd")],
    parsed,
  });
  assert.deepEqual(renamed.documents, {
    "new.qmd": { state: "working" },
    "old.qmd": { state: "reviewed", orphan: true },
    "stable.qmd": { state: "reviewed" },
  });
  assert.deepEqual(renamed.diagnostics, [{
    code: "documentation-state-orphan",
    path: "old.qmd",
    message: "State entry has no current Documentation page.",
  }]);
});

test("state generations increment without changing width or numeric representation", () => {
  assert.equal(nextStateGeneration("0000000000000000"), "0000000000000001");
  assert.equal(nextStateGeneration("000000000000000f"), "0000000000000010");
  for (const value of [
    "1",
    "000000000000000A",
    "+000000000000001",
    "0x00000000000001",
    "00000000000000000",
  ]) {
    assert.throws(() => nextStateGeneration(value), TypeError);
  }
  assert.throws(() => nextStateGeneration("ffffffffffffffff"), /overflow/);
});

test("state operation digests bind every reviewed precondition", () => {
  const input = Object.freeze({
    path: documentationPagePath("index.qmd"),
    expectedDocumentRevision: `sha256:${"a".repeat(64)}`,
    expectedStateGeneration: "0000000000000001",
    state: "reviewed",
    idempotencyKey: "state-index-reviewed-1",
  });
  const digest = canonicalOperationDigest(input);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(canonicalOperationDigest(input), digest);
  assert.notEqual(canonicalOperationDigest({ ...input, state: "working" }), digest);
  assert.notEqual(canonicalOperationDigest({
    ...input,
    path: documentationPagePath("other.qmd"),
  }), digest);
  assert.match(stateOperationId(input.idempotencyKey), /^state-[0-9a-f]{32}$/);
});

function createMemoryOperationAuthority({ stateBytes, pageRevision }) {
  const operations = new Map();
  const receipts = new Map();
  const history = [];
  return {
    operations,
    receipts,
    history,
    get stateBytes() { return stateBytes; },
    set stateBytes(value) { stateBytes = value; },
    async readOperation(operationId) { return operations.get(operationId) ?? null; },
    async createOperation(record) {
      if (operations.has(record.operationId)) throw new Error("operation already exists");
      operations.set(record.operationId, record);
      history.push(record.phase);
    },
    async updateOperation(record) {
      operations.set(record.operationId, record);
      history.push(record.phase);
    },
    async readReceipt(operationId) { return receipts.get(operationId) ?? null; },
    async writeReceipt(operationId, result) {
      const existing = receipts.get(operationId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(result)) throw new Error("receipt conflict");
      receipts.set(operationId, result);
    },
    async readState() { return stateBytes; },
    async writeState(value) { stateBytes = Buffer.from(value); },
    async readPageRevision(_path, workingCopy) {
      return { revision: workingCopy?.revision ?? pageRevision, dirty: workingCopy?.dirty ?? false };
    },
  };
}

function makeStateTransactionRequest(overrides = {}) {
  const input = {
    path: documentationPagePath("index.qmd"),
    expectedDocumentRevision: `sha256:${"d".repeat(64)}`,
    expectedStateGeneration: "0000000000000001",
    state: "reviewed",
    idempotencyKey: "state-index-reviewed-1",
  };
  const request = {
    kind: "set-document-state",
    schemaVersion: 1,
    operationId: stateOperationId(input.idempotencyKey),
    idempotencyKey: input.idempotencyKey,
    requestDigest: canonicalOperationDigest(input),
    workspaceEpoch: "epoch-1",
    workspaceScopeDigest: "e".repeat(64),
    path: input.path.value,
    expectedDocumentRevision: input.expectedDocumentRevision,
    expectedStateGeneration: input.expectedStateGeneration,
    intendedState: input.state,
    workingCopy: null,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "requestDigest")) {
    request.requestDigest = canonicalOperationDigest({
      path: documentationPagePath(request.path),
      expectedDocumentRevision: request.expectedDocumentRevision,
      expectedStateGeneration: request.expectedStateGeneration,
      state: request.intendedState,
      idempotencyKey: request.idempotencyKey,
    });
  }
  if (!Object.hasOwn(overrides, "operationId")) request.operationId = stateOperationId(request.idempotencyKey);
  return Object.freeze(request);
}

test("state executor resumes exactly after every durable operation phase", async () => {
  const initial = Buffer.from(
    '{"schemaVersion":1,"generation":"0000000000000001","documents":{"index.qmd":{"state":"working"}}}\n',
  );
  const phases = ["prepared", "applying", "metadata-applied", "committed"];
  for (const crashPhase of phases) {
    const authority = createMemoryOperationAuthority({
      stateBytes: Buffer.from(initial),
      pageRevision: `sha256:${"d".repeat(64)}`,
    });
    let crashed = false;
    const crashing = createStateTransactionExecutor({
      authority,
      async afterPhase(phase) {
        if (!crashed && phase === crashPhase) {
          crashed = true;
          throw new Error(`crash after ${phase}`);
        }
      },
    });
    const request = makeStateTransactionRequest();
    await assert.rejects(crashing.execute(request), new RegExp(`crash after ${crashPhase}`));

    const resumed = createStateTransactionExecutor({ authority });
    assert.deepEqual(await resumed.execute(request), {
      kind: "state-committed",
      generation: "0000000000000002",
      receipt: "state-index-reviewed-1",
    });
    const parsed = parseDocumentationState(authority.stateBytes);
    assert.equal(parsed.state.documents["index.qmd"].state, "reviewed");
    assert.equal(authority.operations.get(request.operationId).phase, "committed");
    assert.deepEqual(await resumed.execute(request), authority.receipts.get(request.operationId));
    for (const phase of phases) assert.equal(authority.history.includes(phase), true);
  }
});

test("state executor rejects stale preconditions, key conflicts, and unknown recovery bytes", async () => {
  const initial = Buffer.from(
    '{"schemaVersion":1,"generation":"0000000000000001","documents":{"index.qmd":{"state":"working"}}}\n',
  );
  const staleDocument = createMemoryOperationAuthority({
    stateBytes: initial,
    pageRevision: `sha256:${"f".repeat(64)}`,
  });
  assert.deepEqual(await createStateTransactionExecutor({ authority: staleDocument })
    .execute(makeStateTransactionRequest()), { kind: "stale-document" });
  assert.equal(staleDocument.operations.size, 0);

  const staleState = createMemoryOperationAuthority({
    stateBytes: initial,
    pageRevision: `sha256:${"d".repeat(64)}`,
  });
  assert.deepEqual(await createStateTransactionExecutor({ authority: staleState })
    .execute(makeStateTransactionRequest({ expectedStateGeneration: "0000000000000000" })), {
    kind: "stale-state",
  });
  assert.equal(staleState.operations.size, 0);

  const authority = createMemoryOperationAuthority({
    stateBytes: Buffer.from(initial),
    pageRevision: `sha256:${"d".repeat(64)}`,
  });
  const executor = createStateTransactionExecutor({ authority });
  const request = makeStateTransactionRequest();
  await executor.execute(request);
  const differentInput = {
    path: documentationPagePath("index.qmd"),
    expectedDocumentRevision: request.expectedDocumentRevision,
    expectedStateGeneration: request.expectedStateGeneration,
    state: "working",
    idempotencyKey: request.idempotencyKey,
  };
  const conflict = makeStateTransactionRequest({
    intendedState: "working",
    requestDigest: canonicalOperationDigest(differentInput),
  });
  assert.deepEqual(await executor.execute(conflict), {
    kind: "idempotency-conflict",
    idempotencyKey: request.idempotencyKey,
  });

  const recoveryAuthority = createMemoryOperationAuthority({
    stateBytes: Buffer.from(initial),
    pageRevision: `sha256:${"d".repeat(64)}`,
  });
  let stopped = false;
  const interrupted = createStateTransactionExecutor({
    authority: recoveryAuthority,
    async afterPhase(phase) {
      if (!stopped && phase === "prepared") {
        stopped = true;
        throw new Error("stop");
      }
    },
  });
  await assert.rejects(interrupted.execute(request), /stop/);
  recoveryAuthority.stateBytes = Buffer.from(
    '{"schemaVersion":1,"generation":"0000000000000009","documents":{"index.qmd":{"state":"working"}}}\n',
  );
  const recovery = createStateTransactionExecutor({ authority: recoveryAuthority });
  assert.deepEqual(await recovery.recover({
    kind: "recover-documentation-operation",
    operationId: request.operationId,
    workspaceEpoch: "epoch-1",
  }), {
    kind: "recovery-conflict",
    evidenceRef: `documentation-operation:${request.operationId}`,
  });
});
