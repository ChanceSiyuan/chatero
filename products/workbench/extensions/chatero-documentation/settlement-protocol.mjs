import { createHash } from "node:crypto";

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function canonicalSettlementJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalSettlementJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("settlement value is not canonical JSON");
  const keys = Object.keys(value).sort(compareUtf8Bytes);
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalSettlementJson(value[key])}`).join(",")}}`;
}

export function digestSettlementValue(value) {
  return `sha256:${createHash("sha256").update(canonicalSettlementJson(value), "utf8").digest("hex")}`;
}

function textIdentity(value) {
  return Object.freeze({
    operationId: value.operationId,
    path: value.path,
    expectedVersion: value.expectedVersion ?? null,
    currentRevision: value.currentRevision,
    beforeDigest: value.beforeDigest ?? value.currentDigest,
    intendedDigest: value.intendedDigest,
  });
}

function resourceIdentity(value) {
  const identity = {};
  for (const [key, member] of Object.entries(value)) {
    if (!new Set(["intendedText", "baseText", "proposedText"]).has(key)) identity[key] = member;
  }
  return Object.freeze(identity);
}

export function settlementAffectedResourceDigest(value) {
  const text = value.textOverlay ?? value.textOperations;
  return digestSettlementValue({
    text: text.map(textIdentity),
    resources: value.resourceOperations.map(resourceIdentity),
  });
}

export function settlementOperationDigest(value) {
  const text = value.textOverlay ?? value.textOperations;
  return digestSettlementValue({
    schemaVersion: 1,
    operationId: value.operationId,
    idempotencyKey: value.idempotencyKey,
    reviewDigest: value.reviewDigest,
    generationDigest: value.generationDigest,
    expectedStateGeneration: value.expectedStateGeneration ?? value.stateGeneration,
    decisions: value.decisions,
    textOverlay: text.map(textIdentity),
    resourceOperations: value.resourceOperations.map(resourceIdentity),
    stateChanges: value.stateChanges,
    deferredOperations: value.deferredOperations,
    affectedResourceDigest: value.affectedResourceDigest,
  });
}

export function settlementTextProofDigest(value) {
  return digestSettlementValue({
    kind: "settlement-text-proof",
    operationId: value.operationId,
    operationDigest: value.operationDigest,
    resources: value.resources,
  });
}

export function settlementApprovalDigest(value) {
  if (!value || typeof value.reviewDigest !== "string" || typeof value.idempotencyKey !== "string"
    || !Array.isArray(value.decisions)) {
    throw new TypeError("settlement approval input is invalid");
  }
  return digestSettlementValue({
    kind: "settlement-human-approval",
    reviewDigest: value.reviewDigest,
    idempotencyKey: value.idempotencyKey,
    decisions: [...value.decisions]
      .map(decision => ({ id: decision.id, decision: decision.decision }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.id, "utf8"), Buffer.from(right.id, "utf8"))),
  });
}
