import { createHash } from "node:crypto";

import { documentationPagePath } from "./documentation-path.mjs";
import {
  nextStateGeneration,
  parseDocumentationState,
  serializeDocumentationState,
} from "./documentation-state.mjs";
import {
  canonicalSettlementJson,
  digestSettlementValue,
  settlementAffectedResourceDigest,
  settlementOperationDigest,
  settlementTextProofDigest,
} from "./settlement-protocol.mjs";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const GENERATION_RE = /^[0-9a-f]{16}$/u;
const OPERATION_RE = /^settle-[0-9a-f]{32}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DECISIONS = new Set(["accept", "reject", "defer"]);
const STATES = new Set(["working", "reviewed"]);
const PHASES = new Set([
  "private-staged",
  "marker-committed",
  "awaiting-text",
  "text-proved",
  "metadata-applied",
  "committed",
  "recovery-conflict",
]);

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
    throw new TypeError(`${label} schema is invalid`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function utf8Digest(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function decisions(values) {
  if (!Array.isArray(values)) throw new TypeError("settlement decisions are invalid");
  const result = [];
  const seen = new Set();
  for (const value of values) {
    exactObject(value, ["id", "decision"], "settlement decision");
    identifier(value.id, "settlement decision id");
    if (!DECISIONS.has(value.decision) || seen.has(value.id)) throw new TypeError("settlement decision is invalid");
    seen.add(value.id);
    result.push(Object.freeze({ id: value.id, decision: value.decision }));
  }
  return Object.freeze(result);
}

function textOverlay(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 128) {
    throw new TypeError("settlement text overlay is invalid");
  }
  const result = [];
  const seen = new Set();
  for (const value of values) {
    exactObject(value, [
      "operationId", "path", "expectedVersion", "currentRevision", "beforeDigest", "intendedText", "intendedDigest",
    ], "settlement text overlay entry");
    const path = documentationPagePath(value.path).value;
    identifier(value.operationId, "settlement text operation id");
    if (seen.has(path) || !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 0
      || typeof value.intendedText !== "string" || Buffer.byteLength(value.intendedText, "utf8") > 8 * 1024 * 1024) {
      throw new TypeError("settlement text overlay entry is invalid");
    }
    seen.add(path);
    digest(value.beforeDigest, "settlement before digest");
    digest(value.intendedDigest, "settlement intended digest");
    if (value.currentRevision !== `text-document:${value.expectedVersion}:${value.beforeDigest}`
      || utf8Digest(value.intendedText) !== value.intendedDigest) {
      throw new TypeError("settlement text overlay evidence does not match");
    }
    result.push(Object.freeze({ ...value, path }));
  }
  return Object.freeze(result);
}

function stateChanges(values) {
  if (!Array.isArray(values) || values.length > 256) throw new TypeError("settlement state changes are invalid");
  return Object.freeze(values.map(value => {
    if (value?.kind === "set") {
      exactObject(value, ["kind", "path", "state"], "settlement state change");
      if (!STATES.has(value.state)) throw new TypeError("settlement state is invalid");
      return Object.freeze({ kind: "set", path: documentationPagePath(value.path).value, state: value.state });
    }
    exactObject(value, ["kind", "path"], "settlement state change");
    if (value.kind !== "delete") throw new TypeError("settlement state change is invalid");
    return Object.freeze({ kind: "delete", path: documentationPagePath(value.path).value });
  }));
}

function prepareRequest(value) {
  exactObject(value, [
    "kind", "schemaVersion", "operationId", "idempotencyKey", "operationDigest",
    "affectedResourceDigest", "approvalReservationDigest", "reviewDigest", "generationDigest", "expectedStateGeneration",
    "decisions", "textOverlay", "resourceOperations", "stateChanges", "deferredOperations",
  ], "prepare settlement request");
  if (value.kind !== "prepare-settlement" || value.schemaVersion !== 1 || !OPERATION_RE.test(value.operationId)
    || !GENERATION_RE.test(value.expectedStateGeneration)) {
    throw new TypeError("prepare settlement identity is invalid");
  }
  identifier(value.idempotencyKey, "settlement idempotency key");
  for (const [member, label] of [
    [value.operationDigest, "settlement operation digest"],
    [value.affectedResourceDigest, "settlement affected resource digest"],
    [value.approvalReservationDigest, "settlement approval reservation digest"],
    [value.reviewDigest, "settlement review digest"],
    [value.generationDigest, "settlement generation digest"],
  ]) digest(member, label);
  if (!Array.isArray(value.resourceOperations) || value.resourceOperations.length !== 0
    || !Array.isArray(value.deferredOperations) || value.deferredOperations.length !== 0) {
    throw new TypeError("this authority version supports text-only settlement");
  }
  const normalized = Object.freeze({
    ...value,
    decisions: decisions(value.decisions),
    textOverlay: textOverlay(value.textOverlay),
    resourceOperations: Object.freeze([]),
    stateChanges: stateChanges(value.stateChanges),
    deferredOperations: Object.freeze([]),
  });
  if (settlementAffectedResourceDigest(normalized) !== normalized.affectedResourceDigest
    || settlementOperationDigest(normalized) !== normalized.operationDigest) {
    throw new TypeError("settlement request digest does not match its exact plan");
  }
  return normalized;
}

function statePlan(bytes, expectedGeneration, changes) {
  const parsed = parseDocumentationState(bytes);
  let generation;
  let documents;
  if (parsed.kind === "missing") {
    generation = "0000000000000000";
    documents = {};
  }
  else if (parsed.kind === "valid") {
    generation = parsed.state.generation;
    documents = Object.fromEntries(Object.entries(parsed.state.documents).map(([path, value]) => [path, { state: value.state }]));
  }
  else throw new TypeError("Documentation state is invalid");
  if (generation !== expectedGeneration) return Object.freeze({ kind: "stale-state", generation });
  for (const change of changes) {
    if (change.kind === "delete") delete documents[change.path];
    else documents[change.path] = { state: change.state };
  }
  const intendedGeneration = nextStateGeneration(generation);
  const intendedBytes = serializeDocumentationState({ schemaVersion: 1, generation: intendedGeneration, documents });
  const beforeBytes = bytes === null ? null : Buffer.from(bytes);
  return Object.freeze({
    kind: "state-plan",
    beforeBytes: beforeBytes?.toString("base64url") ?? null,
    beforeRevision: beforeBytes ? utf8Digest(beforeBytes.toString("utf8")) : "absent",
    intendedBytes: intendedBytes.toString("base64url"),
    intendedRevision: utf8Digest(intendedBytes.toString("utf8")),
    intendedGeneration,
  });
}

function makeJournal(request, state) {
  const staged = {
    schemaVersion: 1,
    kind: "settlement",
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    operationDigest: request.operationDigest,
    affectedResourceDigest: request.affectedResourceDigest,
    approvalReservationDigest: request.approvalReservationDigest,
    phase: "private-staged",
    markerCommitted: false,
    canonicalMutationStarted: false,
    request,
    state,
    textProof: null,
    result: null,
  };
  const journalDigest = digestSettlementValue({
    schemaVersion: staged.schemaVersion,
    kind: staged.kind,
    operationId: staged.operationId,
    idempotencyKey: staged.idempotencyKey,
    operationDigest: staged.operationDigest,
    affectedResourceDigest: staged.affectedResourceDigest,
    approvalReservationDigest: staged.approvalReservationDigest,
    request: staged.request,
    state: staged.state,
  });
  return Object.freeze({ ...staged, journalDigest });
}

function withJournal(record, changes) {
  const next = Object.freeze({ ...record, ...changes });
  if (!PHASES.has(next.phase) || next.journalDigest !== record.journalDigest) {
    throw new TypeError("settlement journal transition is invalid");
  }
  return next;
}

function markerFor(record) {
  return Object.freeze({
    schemaVersion: 1,
    kind: "settlement",
    operationId: record.operationId,
    operationDigest: record.operationDigest,
    affectedResourceDigest: record.affectedResourceDigest,
    journalDigest: record.journalDigest,
    approvalReservationDigest: record.approvalReservationDigest,
  });
}

function acceptanceProof(record) {
  return digestSettlementValue({
    kind: "settlement-approval-accepted",
    operationId: record.operationId,
    operationDigest: record.operationDigest,
    journalDigest: record.journalDigest,
    approvalReservationDigest: record.approvalReservationDigest,
  });
}

function awaitingResult(record) {
  return Object.freeze({
    kind: "awaiting-text",
    operationId: record.operationId,
    operationDigest: record.operationDigest,
    affectedResourceDigest: record.affectedResourceDigest,
    textOverlay: record.request.textOverlay,
    approvalAcceptanceProof: acceptanceProof(record),
  });
}

function committedResult(record) {
  return Object.freeze({
    kind: "settlement-committed",
    operationId: record.operationId,
    receipt: record.idempotencyKey,
  });
}

function sameMarker(left, right) {
  return left !== null && canonicalSettlementJson(left) === canonicalSettlementJson(right);
}

function sameRequest(record, request) {
  return record.kind === "settlement" && record.operationId === request.operationId
    && record.idempotencyKey === request.idempotencyKey
    && record.operationDigest === request.operationDigest
    && record.affectedResourceDigest === request.affectedResourceDigest
    && record.approvalReservationDigest === request.approvalReservationDigest
    && canonicalSettlementJson(record.request) === canonicalSettlementJson(request);
}

function resourceUri(workspace, path) {
  const uri = new URL(workspace);
  const prefix = uri.pathname === "/" ? "/" : `${uri.pathname.replace(/\/+$/u, "")}/`;
  uri.pathname = `${prefix}documentation/${path.split("/").map(encodeURIComponent).join("/")}`;
  uri.search = "";
  uri.hash = "";
  return uri.toString();
}

function textProof(value, record, workspace) {
  exactObject(value, ["kind", "operationId", "operationDigest", "resources", "proofDigest"], "settlement text proof");
  if (value.kind !== "settlement-text-proof" || value.operationId !== record.operationId
    || value.operationDigest !== record.operationDigest || !Array.isArray(value.resources)
    || value.resources.length !== record.request.textOverlay.length
    || settlementTextProofDigest(value) !== value.proofDigest) {
    throw new TypeError("settlement text proof identity is invalid");
  }
  for (let index = 0; index < value.resources.length; index++) {
    const proof = value.resources[index];
    const overlay = record.request.textOverlay[index];
    exactObject(proof, [
      "uri", "beforeVersion", "afterVersion", "beforeDigest", "intendedDigest",
    ], "settlement text proof resource");
    if (proof.uri !== resourceUri(workspace, overlay.path)
      || proof.beforeVersion !== overlay.expectedVersion || proof.afterVersion !== overlay.expectedVersion + 1
      || proof.beforeDigest !== overlay.beforeDigest || proof.intendedDigest !== overlay.intendedDigest) {
      throw new TypeError("settlement text proof resource does not match its overlay");
    }
  }
  return Object.freeze({ ...value, resources: Object.freeze(value.resources.map(item => Object.freeze({ ...item }))) });
}

function ackRequest(value) {
  exactObject(value, [
    "kind", "schemaVersion", "operationId", "operationDigest", "affectedResourceDigest", "textProof",
  ], "ack settlement request");
  if (value.kind !== "ack-settlement-text" || value.schemaVersion !== 1 || !OPERATION_RE.test(value.operationId)) {
    throw new TypeError("ack settlement identity is invalid");
  }
  digest(value.operationDigest, "settlement operation digest");
  digest(value.affectedResourceDigest, "settlement affected resource digest");
  return value;
}

function stateRevision(bytes) {
  return bytes === null ? "absent" : utf8Digest(Buffer.from(bytes).toString("utf8"));
}

function assertAuthority(authority) {
  for (const method of [
    "readOperation", "createOperation", "updateOperation", "readReceipt", "writeReceipt",
    "readState", "writeState", "readActiveMarker", "createActiveMarker", "removeActiveMarker",
  ]) {
    if (typeof authority?.[method] !== "function") throw new TypeError(`settlement authority is missing ${method}`);
  }
}

export function createSettlementTransactionExecutor({ authority, workspace } = {}) {
  assertAuthority(authority);
  if (typeof workspace !== "string") throw new TypeError("settlement workspace is invalid");

  const persist = async (record, changes) => {
    const next = withJournal(record, changes);
    await authority.updateOperation(next);
    return next;
  };

  const publishMarker = async record => {
    const intended = markerFor(record);
    const active = await authority.readActiveMarker();
    if (active !== null && !sameMarker(active, intended)) {
      return Object.freeze({ kind: "operation-active", operationId: active.operationId ?? null });
    }
    if (active === null) await authority.createActiveMarker(intended);
    record = await persist(record, { phase: "marker-committed", markerCommitted: true });
    return persist(record, { phase: "awaiting-text" });
  };

  const prepare = async input => {
    const request = prepareRequest(input);
    let record = await authority.readOperation(request.operationId);
    if (record) {
      if (!sameRequest(record, request)) {
        return Object.freeze({ kind: "idempotency-conflict", idempotencyKey: request.idempotencyKey });
      }
      const receipt = await authority.readReceipt(request.operationId);
      if (receipt) return receipt;
      if (record.phase === "private-staged") {
        record = await publishMarker(record);
        if (record.kind === "operation-active") return record;
      }
      else if (record.phase === "marker-committed") record = await persist(record, { phase: "awaiting-text" });
      if (record.phase === "awaiting-text") return awaitingResult(record);
      if (record.phase === "recovery-conflict") {
        return Object.freeze({ kind: "recovery-conflict", operationId: record.operationId, evidenceRef: `documentation-operation:${record.operationId}` });
      }
      return Object.freeze({ kind: "settlement-recovery-required", operationId: record.operationId, operationDigest: record.operationDigest });
    }
    const plannedState = statePlan(await authority.readState(), request.expectedStateGeneration, request.stateChanges);
    if (plannedState.kind === "stale-state") return plannedState;
    record = makeJournal(request, plannedState);
    await authority.createOperation(record);
    record = await publishMarker(record);
    if (record.kind === "operation-active") return record;
    return awaitingResult(record);
  };

  const ack = async input => {
    const request = ackRequest(input);
    let record = await authority.readOperation(request.operationId);
    if (!record || record.kind !== "settlement") return Object.freeze({ kind: "stale-settlement" });
    if (record.operationDigest !== request.operationDigest
      || record.affectedResourceDigest !== request.affectedResourceDigest) {
      return Object.freeze({ kind: "idempotency-conflict", idempotencyKey: record.idempotencyKey });
    }
    const expectedResult = committedResult(record);
    const receipt = await authority.readReceipt(record.operationId);
    if (receipt) {
      if (canonicalSettlementJson(receipt) !== canonicalSettlementJson(expectedResult)) {
        return Object.freeze({ kind: "recovery-conflict", operationId: record.operationId, evidenceRef: `documentation-operation:${record.operationId}` });
      }
      const active = await authority.readActiveMarker();
      if (sameMarker(active, markerFor(record))) await authority.removeActiveMarker(active);
      if (record.phase !== "committed") await persist(record, { phase: "committed", result: receipt });
      return receipt;
    }
    const active = await authority.readActiveMarker();
    if (!sameMarker(active, markerFor(record)) || !record.markerCommitted) {
      return Object.freeze({ kind: "recovery-conflict", operationId: record.operationId, evidenceRef: `documentation-operation:${record.operationId}` });
    }
    const proof = textProof(request.textProof, record, workspace);
    if (record.phase === "awaiting-text") record = await persist(record, { phase: "text-proved", textProof: proof });
    else if (record.textProof && canonicalSettlementJson(record.textProof) !== canonicalSettlementJson(proof)) {
      return Object.freeze({ kind: "recovery-conflict", operationId: record.operationId, evidenceRef: `documentation-operation:${record.operationId}` });
    }
    const current = await authority.readState();
    const currentRevision = stateRevision(current);
    if (currentRevision === record.state.beforeRevision) {
      if (!record.canonicalMutationStarted) record = await persist(record, { canonicalMutationStarted: true });
      await authority.writeState(Buffer.from(record.state.intendedBytes, "base64url"));
    }
    else if (currentRevision !== record.state.intendedRevision) {
      record = await persist(record, { phase: "recovery-conflict" });
      return Object.freeze({ kind: "recovery-conflict", operationId: record.operationId, evidenceRef: `documentation-operation:${record.operationId}` });
    }
    if (record.phase !== "metadata-applied") record = await persist(record, { phase: "metadata-applied", canonicalMutationStarted: true });
    await authority.writeReceipt(record.operationId, expectedResult);
    record = await persist(record, { phase: "committed", result: expectedResult });
    await authority.removeActiveMarker(markerFor(record));
    return expectedResult;
  };

  return Object.freeze({ prepare, ack });
}
