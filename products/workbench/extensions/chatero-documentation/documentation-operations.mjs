import { createHash } from "node:crypto";

import { documentationPagePath, validateOperationPathSet } from "./documentation-path.mjs";
import {
  nextStateGeneration,
  parseDocumentationState,
  serializeDocumentationState,
} from "./documentation-state.mjs";

const DIGEST_RE = /^[0-9a-f]{64}$/u;
const GENERATION_RE = /^[0-9a-f]{16}$/u;
const REVISION_RE = /^(?:sha256:[0-9a-f]{64}|text-document:(?:0|[1-9][0-9]*):sha256:[0-9a-f]{64})$/u;
const OPERATION_ID_RE = /^state-[0-9a-f]{32}$/u;
const STATES = new Set(["working", "reviewed"]);
const PHASES = new Set(["prepared", "applying", "metadata-applied", "committed"]);

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
    throw new TypeError(`${label} has an invalid schema`);
  }
  return value;
}

function boundedId(value, label) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 128
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function revisionDigest(value) {
  const match = /sha256:([0-9a-f]{64})$/u.exec(value);
  return match?.[1] ?? null;
}

function sameRevision(left, right) {
  return left === right || (revisionDigest(left) !== null && revisionDigest(left) === revisionDigest(right));
}

function validateStateInput(input) {
  exactObject(input, [
    "path",
    "expectedDocumentRevision",
    "expectedStateGeneration",
    "state",
    "idempotencyKey",
  ], "state operation input");
  validateOperationPathSet([{ kind: "edit", path: input.path }]);
  if (!REVISION_RE.test(input.expectedDocumentRevision)) {
    throw new TypeError("expected document revision is invalid");
  }
  if (!GENERATION_RE.test(input.expectedStateGeneration)) {
    throw new TypeError("expected state generation is invalid");
  }
  if (!STATES.has(input.state)) throw new TypeError("intended Documentation state is invalid");
  boundedId(input.idempotencyKey, "idempotency key");
  return input;
}

export function canonicalOperationDigest(input) {
  const value = validateStateInput(input);
  const fields = [
    "chatero-documentation-state-operation-v1",
    value.path.value,
    value.expectedDocumentRevision,
    value.expectedStateGeneration,
    value.state,
    value.idempotencyKey,
  ];
  return createHash("sha256")
    .update(fields.map(field => `${Buffer.byteLength(field, "utf8")}:${field}`).join("|"), "utf8")
    .digest("hex");
}

export function stateOperationId(idempotencyKey) {
  const value = boundedId(idempotencyKey, "idempotency key");
  return `state-${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32)}`;
}

function validateWorkingCopy(value, expectedRevision) {
  if (value === null) return null;
  exactObject(value, ["version", "dirty", "revision"], "working copy proof");
  if (!Number.isSafeInteger(value.version) || value.version < 0 || typeof value.dirty !== "boolean"
    || !REVISION_RE.test(value.revision) || !sameRevision(value.revision, expectedRevision)) {
    throw new TypeError("working copy proof is invalid");
  }
  return Object.freeze({ version: value.version, dirty: value.dirty, revision: value.revision });
}

function validateTransactionRequest(request) {
  exactObject(request, [
    "kind",
    "schemaVersion",
    "operationId",
    "idempotencyKey",
    "requestDigest",
    "workspaceEpoch",
    "workspaceScopeDigest",
    "path",
    "expectedDocumentRevision",
    "expectedStateGeneration",
    "intendedState",
    "workingCopy",
  ], "state transaction request");
  if (request.kind !== "set-document-state" || request.schemaVersion !== 1
    || !OPERATION_ID_RE.test(request.operationId) || !DIGEST_RE.test(request.requestDigest)
    || !DIGEST_RE.test(request.workspaceScopeDigest)) {
    throw new TypeError("state transaction identity is invalid");
  }
  boundedId(request.workspaceEpoch, "workspace epoch");
  const input = Object.freeze({
    path: documentationPagePath(request.path),
    expectedDocumentRevision: request.expectedDocumentRevision,
    expectedStateGeneration: request.expectedStateGeneration,
    state: request.intendedState,
    idempotencyKey: request.idempotencyKey,
  });
  const digest = canonicalOperationDigest(input);
  if (request.operationId !== stateOperationId(input.idempotencyKey) || request.requestDigest !== digest) {
    throw new TypeError("state transaction digest or operation id does not match");
  }
  return Object.freeze({
    ...request,
    path: input.path.value,
    workingCopy: validateWorkingCopy(request.workingCopy, input.expectedDocumentRevision),
  });
}

function stateEvidence(bytes) {
  const parsed = parseDocumentationState(bytes);
  if (parsed.kind === "missing") {
    return Object.freeze({
      kind: "valid",
      bytes: null,
      revision: "absent",
      generation: "0000000000000000",
      documents: Object.freeze({}),
    });
  }
  if (parsed.kind !== "valid") return Object.freeze({ kind: "invalid" });
  const snapshot = Buffer.from(bytes);
  return Object.freeze({
    kind: "valid",
    bytes: snapshot,
    revision: `sha256:${sha256Bytes(snapshot)}`,
    generation: parsed.state.generation,
    documents: parsed.state.documents,
  });
}

function intendedStateFrom(evidence, { path, intendedState }) {
  const generation = nextStateGeneration(evidence.generation);
  const documents = Object.fromEntries(Object.entries(evidence.documents).map(([key, value]) => [
    key,
    { state: value.state },
  ]));
  documents[path] = { state: intendedState };
  const bytes = serializeDocumentationState({ schemaVersion: 1, generation, documents });
  return Object.freeze({ bytes, generation, revision: `sha256:${sha256Bytes(bytes)}` });
}

function freezeOperationRecord(record) {
  return Object.freeze({
    ...record,
    before: Object.freeze({ ...record.before }),
    intended: Object.freeze({ ...record.intended }),
    result: record.result ? Object.freeze({ ...record.result }) : null,
  });
}

function makeOperationRecord(request, before, intended) {
  return freezeOperationRecord({
    schemaVersion: 1,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    requestDigest: request.requestDigest,
    workspaceEpoch: request.workspaceEpoch,
    phase: "prepared",
    before: {
      documentRevision: request.expectedDocumentRevision,
      stateGeneration: before.generation,
      stateRevision: before.revision,
    },
    intended: {
      path: request.path,
      state: request.intendedState,
      stateGeneration: intended.generation,
      stateRevision: intended.revision,
    },
    result: null,
  });
}

function withPhase(record, phase, result = record.result) {
  if (!PHASES.has(phase)) throw new TypeError("state operation phase is invalid");
  return freezeOperationRecord({ ...record, phase, result });
}

function committedResult(record) {
  return Object.freeze({
    kind: "state-committed",
    generation: record.intended.stateGeneration,
    receipt: record.idempotencyKey,
  });
}

function matchesCommittedResult(value, record) {
  const expected = committedResult(record);
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 3
    && value.kind === expected.kind
    && value.generation === expected.generation
    && value.receipt === expected.receipt;
}

function recoveryConflict(operationId) {
  return Object.freeze({
    kind: "recovery-conflict",
    evidenceRef: `documentation-operation:${operationId}`,
  });
}

function assertAuthority(authority) {
  for (const method of [
    "readOperation",
    "createOperation",
    "updateOperation",
    "readReceipt",
    "writeReceipt",
    "readState",
    "writeState",
    "readPageRevision",
  ]) {
    if (typeof authority?.[method] !== "function") {
      throw new TypeError(`state transaction authority is missing ${method}`);
    }
  }
}

export function createStateTransactionExecutor({ authority, afterPhase = async () => {} }) {
  assertAuthority(authority);
  if (typeof afterPhase !== "function") throw new TypeError("afterPhase must be a function");

  const persistPhase = async (record, phase, result) => {
    const next = withPhase(record, phase, result);
    await authority.updateOperation(next);
    await afterPhase(phase, next);
    return next;
  };

  const finishCommit = async record => {
    const result = committedResult(record);
    await authority.writeReceipt(record.operationId, result);
    const committed = await persistPhase(record, "committed", result);
    return committed.result;
  };

  const reconstructIntended = (record, current) => {
    if (current.kind !== "valid" || current.generation !== record.before.stateGeneration) return null;
    const intended = intendedStateFrom(current, {
      path: record.intended.path,
      intendedState: record.intended.state,
    });
    if (intended.generation !== record.intended.stateGeneration
      || intended.revision !== record.intended.stateRevision) return null;
    return intended;
  };

  const resume = async (record, workingCopy = null) => {
    const receipt = await authority.readReceipt(record.operationId);
    if (receipt) {
      if (!matchesCommittedResult(receipt, record)) {
        return recoveryConflict(record.operationId);
      }
      if (record.phase !== "committed") await persistPhase(record, "committed", receipt);
      return receipt;
    }
    if (record.phase === "committed") return record.result ?? committedResult(record);

    let current = stateEvidence(await authority.readState());
    if (current.kind !== "valid") return recoveryConflict(record.operationId);
    if (current.revision === record.intended.stateRevision) {
      if (record.phase !== "metadata-applied") record = await persistPhase(record, "metadata-applied");
      return finishCommit(record);
    }
    if (current.revision !== record.before.stateRevision) return recoveryConflict(record.operationId);

    const page = await authority.readPageRevision(record.intended.path, workingCopy);
    if (!page || page.dirty || !sameRevision(page.revision, record.before.documentRevision)) {
      return recoveryConflict(record.operationId);
    }
    const intended = reconstructIntended(record, current);
    if (!intended) return recoveryConflict(record.operationId);
    if (record.phase === "prepared") record = await persistPhase(record, "applying");
    current = stateEvidence(await authority.readState());
    if (current.kind !== "valid" || current.revision !== record.before.stateRevision) {
      if (current.kind === "valid" && current.revision === record.intended.stateRevision) {
        record = await persistPhase(record, "metadata-applied");
        return finishCommit(record);
      }
      return recoveryConflict(record.operationId);
    }
    await authority.writeState(intended.bytes);
    record = await persistPhase(record, "metadata-applied");
    return finishCommit(record);
  };

  const execute = async input => {
    const request = validateTransactionRequest(input);
    const existing = await authority.readOperation(request.operationId);
    if (existing) {
      if (existing.idempotencyKey !== request.idempotencyKey
        || existing.requestDigest !== request.requestDigest
        || existing.workspaceEpoch !== request.workspaceEpoch) {
        return Object.freeze({ kind: "idempotency-conflict", idempotencyKey: request.idempotencyKey });
      }
      return resume(existing, request.workingCopy);
    }

    const page = await authority.readPageRevision(request.path, request.workingCopy);
    if (!page || page.dirty) return Object.freeze({ kind: "dirty-working-copy", paths: [request.path] });
    if (!sameRevision(page.revision, request.expectedDocumentRevision)) {
      return Object.freeze({ kind: "stale-document" });
    }
    const before = stateEvidence(await authority.readState());
    if (before.kind !== "valid" || before.generation !== request.expectedStateGeneration) {
      return Object.freeze({ kind: "stale-state" });
    }
    const intended = intendedStateFrom(before, request);
    let record = makeOperationRecord(request, before, intended);
    await authority.createOperation(record);
    await afterPhase("prepared", record);
    record = await persistPhase(record, "applying");
    return resume(record, request.workingCopy);
  };

  const recover = async request => {
    exactObject(request, ["kind", "operationId", "workspaceEpoch"], "state recovery request");
    if (request.kind !== "recover-documentation-operation" || !OPERATION_ID_RE.test(request.operationId)) {
      throw new TypeError("state recovery request is invalid");
    }
    boundedId(request.workspaceEpoch, "workspace epoch");
    const record = await authority.readOperation(request.operationId);
    if (!record) return Object.freeze({ kind: "stale-recovery" });
    if (record.workspaceEpoch !== request.workspaceEpoch) return recoveryConflict(request.operationId);
    return resume(record);
  };

  return Object.freeze({ execute, recover });
}
