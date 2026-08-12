import { createHash } from "node:crypto";

import { documentationPagePath } from "./documentation-path.mjs";

const GENERATION_RE = /^[0-9a-f]{16}$/u;
const REVISION_RE = /^(?:sha256:[0-9a-f]{64}|text-document:(?:0|[1-9][0-9]*):sha256:[0-9a-f]{64})$/u;

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("review evidence is not canonical");
  const keys = Object.keys(value).sort(compareUtf8Bytes);
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function structuralId(operation) {
  const identity = operation.kind === "rename"
    ? { kind: operation.kind, operationId: operation.operationId, from: operation.from.value, to: operation.to.value }
    : { kind: operation.kind, operationId: operation.operationId, path: operation.path.value };
  return `struct-${createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex")}`;
}

function snapshotDocument(value) {
  if (!value || typeof value !== "object" || typeof value.path !== "string") {
    throw new TypeError("current review document is invalid");
  }
  const path = documentationPagePath(value.path);
  if (value.absent === true) {
    if (Object.keys(value).some(key => !new Set(["path", "absent"]).has(key))) {
      throw new TypeError("absent review document is invalid");
    }
    return Object.freeze({ path, absent: true });
  }
  if (typeof value.text !== "string" || !REVISION_RE.test(value.revision) || typeof value.dirty !== "boolean") {
    throw new TypeError("current review document is invalid");
  }
  const revisionDigest = /sha256:([0-9a-f]{64})$/u.exec(value.revision)[1];
  const actual = createHash("sha256").update(value.text, "utf8").digest("hex");
  if (actual !== revisionDigest) throw new TypeError("current review document revision does not match");
  return Object.freeze({ path, text: value.text, revision: value.revision, dirty: value.dirty });
}

function operationDocument(operation, current) {
  const source = operation.kind === "rename" ? operation.from : operation.path;
  const target = operation.kind === "rename" ? operation.to : operation.path;
  const currentSource = current.get(source.value);
  const currentTarget = current.get(target.value);
  if (operation.kind === "create") {
    if (!currentTarget?.absent) throw new TypeError("review create target is no longer absent");
    return Object.freeze({
      operationId: operation.operationId, kind: operation.kind, path: target,
      baseText: "", currentText: "", proposedText: operation.proposedText,
      currentRevision: "absent", dirty: false, targetAbsent: true,
    });
  }
  if (!currentSource || currentSource.absent) throw new TypeError("review source document is absent");
  if (operation.kind === "rename" && !currentTarget?.absent) {
    throw new TypeError("review rename target is no longer absent");
  }
  return Object.freeze({
    operationId: operation.operationId,
    kind: operation.kind,
    path: source,
    ...(operation.kind === "rename" ? { destination: target, targetAbsent: true } : {}),
    baseText: operation.baseText,
    currentText: currentSource.text,
    proposedText: operation.kind === "delete" ? "" : operation.proposedText,
    currentRevision: currentSource.revision,
    dirty: currentSource.dirty,
  });
}

function operationLeaves(operation, generationHunks) {
  if (operation.kind === "edit") {
    return generationHunks.filter(hunk => hunk.operationId === operation.operationId).map(hunk => Object.freeze({
      id: hunk.id, kind: "hunk", operationId: operation.operationId,
      path: operation.path, dependsOn: hunk.dependsOn,
    }));
  }
  const id = structuralId(operation);
  const path = operation.kind === "rename" ? operation.from : operation.path;
  const leaves = [Object.freeze({
    id,
    kind: operation.kind,
    operationId: operation.operationId,
    path,
    ...(operation.kind === "rename" ? { destination: operation.to } : {}),
    dependsOn: Object.freeze([]),
  })];
  if (operation.kind === "rename" && operation.baseText !== operation.proposedText) {
    for (const hunk of generationHunks.filter(value => value.operationId === operation.operationId)) {
      leaves.push(Object.freeze({
        id: hunk.id, kind: "hunk", operationId: operation.operationId,
        path: operation.to, dependsOn: Object.freeze([...new Set([...hunk.dependsOn, id])]),
      }));
    }
  }
  return leaves;
}

export function createReviewSnapshotRegistry({ clock, randomUUID } = {}) {
  if (typeof clock?.now !== "function" || typeof randomUUID !== "function") {
    throw new TypeError("review registry dependencies are invalid");
  }
  const records = new Map();
  const consumed = new Set();
  const allocate = () => {
    const value = randomUUID();
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 128
      || records.has(value) || consumed.has(value)) throw new TypeError("review token is invalid or reused");
    return value;
  };
  const register = (snapshotWithoutToken, expiresInMs) => {
    if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1 || expiresInMs > 60 * 60 * 1000) {
      throw new TypeError("review expiry is invalid");
    }
    const reviewToken = allocate();
    const snapshot = Object.freeze({ ...snapshotWithoutToken, reviewToken });
    records.set(reviewToken, Object.freeze({ snapshot, expiresAt: clock.now() + expiresInMs }));
    return snapshot;
  };
  const consume = (reviewToken, reviewDigest) => {
    if (consumed.has(reviewToken)) throw new TypeError("review token was already consumed");
    const record = records.get(reviewToken);
    if (!record) throw new TypeError("unrecognized review token");
    if (clock.now() > record.expiresAt) {
      records.delete(reviewToken);
      consumed.add(reviewToken);
      throw new TypeError("review token has expired");
    }
    if (record.snapshot.reviewDigest !== reviewDigest) throw new TypeError("review digest does not match its token");
    records.delete(reviewToken);
    consumed.add(reviewToken);
    return Object.freeze({ snapshot: record.snapshot });
  };
  return Object.freeze({ register, consume });
}

export function createReviewSnapshot({
  registry,
  generation,
  currentDocuments,
  stateGeneration,
  expiresInMs = 15 * 60 * 1000,
} = {}) {
  if (!registry || typeof registry.register !== "function" || !generation || generation.status !== "open"
    || !Array.isArray(generation.operations) || typeof generation.generationDigest !== "string"
    || !GENERATION_RE.test(stateGeneration)
    || !Array.isArray(currentDocuments)) throw new TypeError("review snapshot input is invalid");
  const current = new Map();
  for (const value of currentDocuments.map(snapshotDocument)) {
    if (current.has(value.path.value)) throw new TypeError("current review documents contain a duplicate path");
    current.set(value.path.value, value);
  }
  const documents = Object.freeze(generation.operations.map(operation => operationDocument(operation, current)));
  const hunks = Object.freeze(generation.hunks.map(hunk => Object.freeze({
    id: hunk.id,
    operationId: hunk.operationId,
    beforeStart: hunk.beforeStart,
    beforeEnd: hunk.beforeEnd,
    afterStart: hunk.afterStart,
    afterEnd: hunk.afterEnd,
    beforeText: hunk.beforeText,
    afterText: hunk.afterText,
    contextBefore: hunk.contextBefore,
    contextAfter: hunk.contextAfter,
    dependsOn: Object.freeze([...hunk.dependsOn]),
  })));
  const leaves = Object.freeze(generation.operations.flatMap(operation => operationLeaves(operation, generation.hunks)));
  if (new Set(leaves.map(leaf => leaf.id)).size !== leaves.length) throw new TypeError("review leaves contain a duplicate identity");
  const identity = Object.freeze({
    ref: generation.ref,
    generationDigest: generation.generationDigest,
    stateGeneration,
    documents,
    hunks,
    leaves,
  });
  return registry.register(Object.freeze({ ...identity, reviewDigest: digest(identity) }), expiresInMs);
}
