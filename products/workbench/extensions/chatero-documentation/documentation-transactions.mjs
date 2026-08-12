import { createHash } from "node:crypto";

import { documentationPagePath, validateOperationPathSet } from "./documentation-path.mjs";
import {
  canonicalOperationDigest,
  stateOperationId,
} from "./documentation-operations.mjs";
import {
  parseDocumentationState,
  projectDocumentationState,
} from "./documentation-state.mjs";

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function revisionDigest(value) {
  return typeof value === "string" ? /sha256:([0-9a-f]{64})$/u.exec(value)?.[1] ?? null : null;
}

function sameRevision(left, right) {
  return left === right || (revisionDigest(left) !== null && revisionDigest(left) === revisionDigest(right));
}

function decodeStateEvidence(evidence) {
  if (evidence?.kind === "missing") return null;
  if (!evidence || evidence.kind !== "file" || typeof evidence.bytes !== "string"
    || !/^[A-Za-z0-9_-]*$/u.test(evidence.bytes) || !/^[0-9a-f]{64}$/u.test(evidence.sha256)) {
    throw new TypeError("Documentation state evidence is invalid");
  }
  const bytes = Buffer.from(evidence.bytes, "base64url");
  if (bytes.toString("base64url") !== evidence.bytes || sha256Bytes(bytes) !== evidence.sha256
    || evidence.revision !== `sha256:${evidence.sha256}`) {
    throw new TypeError("Documentation state evidence digest does not match");
  }
  return bytes;
}

function pagePathsFromSnapshot(result) {
  if (!Array.isArray(result.pages)) throw new TypeError("Documentation state page evidence is invalid");
  const pages = result.pages.map(page => {
    if (!page || typeof page !== "object" || typeof page.path !== "string" || typeof page.revision !== "string") {
      throw new TypeError("Documentation state page evidence is invalid");
    }
    return documentationPagePath(page.path);
  });
  validateOperationPathSet(pages.map(path => ({ kind: "edit", path })));
  return pages;
}

async function readProjectedState({ adapter, capabilities, scope }) {
  const record = capabilities.consumeScope(scope);
  const result = await adapter.snapshot({
    kind: "documentation-state",
    workspaceScopeDigest: record.workspaceScopeDigest,
  });
  if (!result || result.kind !== "documentation-state" || result.epoch !== record.epoch) {
    throw new TypeError("Documentation state snapshot scope does not match");
  }
  return projectDocumentationState({
    pages: pagePathsFromSnapshot(result),
    parsed: parseDocumentationState(decodeStateEvidence(result.state)),
  });
}

async function setDocumentState({ adapter, capabilities, workspaceView, approval, input }) {
  const requestDigest = canonicalOperationDigest(input);
  const record = capabilities.consumeHumanApproval(approval, requestDigest);
  const evidence = workspaceView.capture(record, [input.path]);
  const proof = evidence.proofs[0];
  let workingCopy = null;
  if (proof && !proof.absent) {
    if (proof.dirty) {
      return Object.freeze({ kind: "dirty-working-copy", paths: Object.freeze([input.path]) });
    }
    if (!sameRevision(proof.revision, input.expectedDocumentRevision)) {
      return Object.freeze({ kind: "stale-document" });
    }
    workingCopy = Object.freeze({
      version: proof.version,
      dirty: proof.dirty,
      revision: proof.revision,
    });
  }
  workspaceView.revalidate(evidence);
  const result = await adapter.transact(Object.freeze({
    kind: "set-document-state",
    schemaVersion: 1,
    operationId: stateOperationId(input.idempotencyKey),
    idempotencyKey: input.idempotencyKey,
    requestDigest,
    workspaceEpoch: record.epoch,
    workspaceScopeDigest: record.workspaceScopeDigest,
    path: input.path.value,
    expectedDocumentRevision: input.expectedDocumentRevision,
    expectedStateGeneration: input.expectedStateGeneration,
    intendedState: input.state,
    workingCopy,
  }));
  workspaceView.revalidate(evidence);
  return result;
}

export function createDocumentationTransactions({ adapter, capabilities, workspaceView, migrationPlanner }) {
  if (!adapter || typeof adapter.snapshot !== "function" || typeof adapter.transact !== "function"
    || !capabilities || typeof capabilities.consumeScope !== "function"
    || typeof capabilities.consumeHumanApproval !== "function"
    || !workspaceView || typeof workspaceView.capture !== "function"
    || typeof workspaceView.revalidate !== "function") {
    throw new TypeError("Documentation transaction dependencies are invalid");
  }
  if (migrationPlanner !== undefined && typeof migrationPlanner?.planMigration !== "function") {
    throw new TypeError("Documentation migration planner is invalid");
  }
  return Object.freeze({
    state: scope => readProjectedState({ adapter, capabilities, workspaceView, scope }),
    setDocumentState: (approval, input) => setDocumentState({
      adapter,
      capabilities,
      workspaceView,
      approval,
      input,
    }),
    ...(migrationPlanner ? {
      planMigration: scope => migrationPlanner.planMigration(scope),
    } : {}),
  });
}
