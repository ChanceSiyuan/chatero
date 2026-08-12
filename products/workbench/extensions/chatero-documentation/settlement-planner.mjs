import { createHash } from "node:crypto";

import { documentationPagePath, validateOperationPathSet } from "./documentation-path.mjs";
import { validateReviewDecisions } from "./review-decisions.mjs";
import {
  settlementAffectedResourceDigest,
  settlementOperationDigest,
} from "./settlement-protocol.mjs";
import { withChangeContext } from "./text-change-set.mjs";
import { threeWayReconcile } from "./three-way-reconcile.mjs";

const REVISION_RE = /^(?:sha256:[0-9a-f]{64}|text-document:(?:0|[1-9][0-9]*):sha256:[0-9a-f]{64})$/u;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function textDigest(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function revisionDigest(value) {
  return /sha256:([0-9a-f]{64})$/u.exec(value)?.[1] ?? null;
}

function currentDocument(value) {
  if (!value || typeof value !== "object" || typeof value.path !== "string") {
    throw new TypeError("current settlement document is invalid");
  }
  const path = documentationPagePath(value.path).value;
  if (value.absent === true) return Object.freeze({ path, absent: true });
  if (typeof value.text !== "string" || !REVISION_RE.test(value.revision)
    || revisionDigest(value.revision) !== textDigest(value.text).slice("sha256:".length)
    || typeof value.dirty !== "boolean") {
    throw new TypeError("current settlement document is invalid");
  }
  const version = /^text-document:([0-9]+):/u.exec(value.revision)?.[1];
  return Object.freeze({
    path,
    text: value.text,
    revision: value.revision,
    dirty: value.dirty,
    ...(version === undefined ? {} : { version: Number(version) }),
  });
}

function applySelectedHunks(baseText, hunks, decisions, selected) {
  let result = baseText;
  let boundary = baseText.length;
  const values = hunks
    .filter(hunk => selected.has(decisions.get(hunk.id)))
    .sort((left, right) => right.beforeStart - left.beforeStart || right.beforeEnd - left.beforeEnd);
  for (const hunk of values) {
    if (!Number.isSafeInteger(hunk.beforeStart) || !Number.isSafeInteger(hunk.beforeEnd)
      || hunk.beforeStart < 0 || hunk.beforeEnd < hunk.beforeStart || hunk.beforeEnd > boundary
      || baseText.slice(hunk.beforeStart, hunk.beforeEnd) !== hunk.beforeText) {
      throw new TypeError("review hunk no longer binds its base text");
    }
    result = `${result.slice(0, hunk.beforeStart)}${hunk.afterText}${result.slice(hunk.beforeEnd)}`;
    boundary = hunk.beforeStart;
  }
  return result;
}

function frozenChanges(values) {
  return Object.freeze(values.map(value => Object.freeze({ ...value })));
}

function settlementConflict(path, result) {
  return Object.freeze({
    kind: "settlement-conflict",
    path,
    evidenceRef: result.evidenceRef,
    base: result.base,
    current: result.current,
    proposed: result.proposed,
  });
}

function stale(path, reason) {
  return Object.freeze({ kind: "stale-review", path, reason });
}

function operationHunks(snapshot, operationId) {
  return snapshot.hunks.filter(value => value.operationId === operationId);
}

function structuralLeaf(snapshot, operationId) {
  const values = snapshot.leaves.filter(value => value.operationId === operationId && value.kind !== "hunk");
  if (values.length !== 1) throw new TypeError("structural review operation must have exactly one structural leaf");
  return values[0];
}

function deferredRecord(document, committedText, deferredText, deferredLeaves) {
  if (committedText === deferredText || deferredLeaves.length === 0) return null;
  return Object.freeze({
    operationId: document.operationId,
    path: document.kind === "rename" ? document.destination.value : document.path.value,
    baseText: committedText,
    baseRevision: textDigest(committedText),
    proposedText: deferredText,
    deferredLeaves: Object.freeze(deferredLeaves),
  });
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.documents)
    || !Array.isArray(snapshot.leaves) || !Array.isArray(snapshot.hunks)
    || typeof snapshot.reviewDigest !== "string" || typeof snapshot.generationDigest !== "string"
    || typeof snapshot.stateGeneration !== "string") {
    throw new TypeError("settlement review snapshot is invalid");
  }
}

export function planSettlement({ snapshot, decisions, currentDocuments, idempotencyKey } = {}) {
  try {
    validateSnapshot(snapshot);
    if (!IDEMPOTENCY_RE.test(idempotencyKey ?? "") || !Array.isArray(currentDocuments)) {
      throw new TypeError("settlement planning input is invalid");
    }
    const validated = validateReviewDecisions(snapshot, decisions);
    if (validated.kind !== "complete") return validated;
    const current = new Map();
    for (const document of currentDocuments.map(currentDocument)) {
      if (current.has(document.path)) throw new TypeError("current settlement documents contain a duplicate path");
      current.set(document.path, document);
    }
    const textOperations = [];
    const resourceOperations = [];
    const stateChanges = [];
    const deferredOperations = [];

    for (const document of snapshot.documents) {
      const path = document.path.value;
      const fresh = current.get(path);
      const hunks = operationHunks(snapshot, document.operationId);
      const acceptedHunks = hunks.filter(hunk => decisions.get(hunk.id) === "accept");
      const deferredHunks = hunks.filter(hunk => decisions.get(hunk.id) === "defer");
      if (document.kind === "edit") {
        if (!fresh || fresh.absent) return stale(path, "source-missing");
        const acceptedProposal = applySelectedHunks(document.baseText, hunks, decisions, new Set(["accept"]));
        const intended = threeWayReconcile({ base: document.baseText, current: fresh.text, proposed: acceptedProposal });
        if (intended.kind === "conflict") return settlementConflict(path, intended);
        if (acceptedHunks.length > 0) {
          textOperations.push(Object.freeze({
            operationId: document.operationId,
            path,
            currentText: fresh.text,
            currentRevision: fresh.revision,
            currentDigest: textDigest(fresh.text),
            intendedText: intended.text,
            intendedDigest: textDigest(intended.text),
            changes: frozenChanges(withChangeContext(fresh.text, intended.changes)),
            dirty: fresh.dirty,
            ...(fresh.version === undefined ? {} : { expectedVersion: fresh.version }),
          }));
          stateChanges.push(Object.freeze({ kind: "set", path, state: "working" }));
        }
        if (deferredHunks.length > 0) {
          const acceptedAndDeferred = applySelectedHunks(document.baseText, hunks, decisions, new Set(["accept", "defer"]));
          const deferred = threeWayReconcile({ base: document.baseText, current: intended.text, proposed: acceptedAndDeferred });
          if (deferred.kind === "conflict") return settlementConflict(path, deferred);
          const child = deferredRecord(document, intended.text, deferred.text, deferredHunks.map(value => value.id));
          if (child) deferredOperations.push(child);
        }
        continue;
      }

      const leaf = structuralLeaf(snapshot, document.operationId);
      const decision = decisions.get(leaf.id);
      if (decision === "reject") continue;
      if (decision === "defer") {
        deferredOperations.push(Object.freeze({
          operationId: document.operationId,
          kind: document.kind,
          path,
          ...(document.destination ? { destination: document.destination.value } : {}),
          baseText: document.baseText,
          proposedText: document.proposedText,
          deferredLeaves: Object.freeze([leaf.id, ...deferredHunks.map(value => value.id)]),
        }));
        continue;
      }
      if (document.kind === "create") {
        if (!fresh?.absent) return stale(path, "create-target-exists");
        resourceOperations.push(Object.freeze({
          kind: "create", operationId: document.operationId, path,
          intendedText: document.proposedText, intendedDigest: textDigest(document.proposedText),
        }));
        stateChanges.push(Object.freeze({ kind: "set", path, state: "working" }));
        continue;
      }
      if (!fresh || fresh.absent) return stale(path, "source-missing");
      if (fresh.dirty) return Object.freeze({ kind: "dirty-working-copy", paths: Object.freeze([path]) });
      if (document.kind === "delete") {
        const deletion = threeWayReconcile({ base: document.baseText, current: fresh.text, proposed: "" });
        if (deletion.kind === "conflict") return settlementConflict(path, deletion);
        resourceOperations.push(Object.freeze({
          kind: "delete", operationId: document.operationId, path,
          expectedRevision: fresh.revision, expectedDigest: textDigest(fresh.text),
        }));
        stateChanges.push(Object.freeze({ kind: "delete", path }));
        continue;
      }
      const destination = document.destination.value;
      if (!current.get(destination)?.absent) return stale(destination, "rename-target-exists");
      const acceptedProposal = applySelectedHunks(document.baseText, hunks, decisions, new Set(["accept"]));
      const intended = threeWayReconcile({ base: document.baseText, current: fresh.text, proposed: acceptedProposal });
      if (intended.kind === "conflict") return settlementConflict(path, intended);
      resourceOperations.push(Object.freeze({
        kind: "rename", operationId: document.operationId, from: path, to: destination,
        expectedRevision: fresh.revision, expectedDigest: textDigest(fresh.text),
        intendedText: intended.text, intendedDigest: textDigest(intended.text),
      }));
      stateChanges.push(Object.freeze({ kind: "delete", path }));
      stateChanges.push(Object.freeze({ kind: "set", path: destination, state: "working" }));
    }

    const paths = [
      ...textOperations.map(value => ({ kind: "edit", path: documentationPagePath(value.path) })),
      ...resourceOperations.map(value => value.kind === "rename"
        ? { kind: "rename", source: documentationPagePath(value.from), destination: documentationPagePath(value.to) }
        : { kind: value.kind, path: documentationPagePath(value.path) }),
    ];
    if (paths.length > 0) validateOperationPathSet(paths);
    textOperations.sort((left, right) => compareUtf8Bytes(left.path, right.path));
    resourceOperations.sort((left, right) => compareUtf8Bytes(left.path ?? left.from, right.path ?? right.from));
    stateChanges.sort((left, right) => compareUtf8Bytes(left.path, right.path) || compareUtf8Bytes(left.kind, right.kind));
    deferredOperations.sort((left, right) => compareUtf8Bytes(left.path, right.path));
    const decisionRecords = snapshot.leaves.map(leaf => Object.freeze({ id: leaf.id, decision: decisions.get(leaf.id) }))
      .sort((left, right) => compareUtf8Bytes(left.id, right.id));
    const operationId = `settle-${createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 32)}`;
    const identity = {
      schemaVersion: 1,
      operationId,
      idempotencyKey,
      reviewDigest: snapshot.reviewDigest,
      generationDigest: snapshot.generationDigest,
      stateGeneration: snapshot.stateGeneration,
      decisions: decisionRecords,
      textOperations: textOperations.map(value => ({
        operationId: value.operationId, path: value.path, currentRevision: value.currentRevision,
        currentDigest: value.currentDigest, intendedDigest: value.intendedDigest,
      })),
      resourceOperations: resourceOperations.map(value => ({ ...value, intendedText: undefined })),
      stateChanges,
      deferredOperations: deferredOperations.map(value => ({
        operationId: value.operationId, kind: value.kind ?? "edit", path: value.path,
        ...(value.destination ? { destination: value.destination } : {}),
        baseRevision: value.baseRevision ?? textDigest(value.baseText ?? ""),
        proposedDigest: textDigest(value.proposedText ?? ""), deferredLeaves: value.deferredLeaves,
      })),
    };
    const affectedResourceDigest = settlementAffectedResourceDigest(identity);
    const operationDigest = settlementOperationDigest({ ...identity, affectedResourceDigest });
    return Object.freeze({
      kind: "settlement-plan",
      ...identity,
      decisions: Object.freeze(decisionRecords),
      textOperations: Object.freeze(textOperations),
      resourceOperations: Object.freeze(resourceOperations),
      stateChanges: Object.freeze(stateChanges),
      deferredOperations: Object.freeze(deferredOperations),
      affectedResourceDigest,
      operationDigest,
    });
  }
  catch (error) {
    return Object.freeze({ kind: "invalid-settlement", message: error instanceof Error ? error.message : String(error) });
  }
}
