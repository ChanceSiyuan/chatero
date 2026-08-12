import { createHash } from "node:crypto";

import { documentationPagePath, validateOperationPathSet } from "./documentation-path.mjs";
import { buildChangeSetGeneration, changeSetGenerationId } from "./change-set-model.mjs";
import { createReviewSnapshot } from "./review-snapshot.mjs";
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

function invalidProposal(code, detail) {
  return Object.freeze({ kind: "invalid-proposal", code, ...(detail ? { detail } : {}) });
}

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some(key => !allowed.has(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} schema is invalid`);
  }
  return value;
}

function boundedText(value, label, maximum = 8 * 1024 * 1024) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum) throw new TypeError(`${label} is invalid`);
  return value;
}

function boundedIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function rawChangeSetRef(value) {
  exactKeys(value, ["lineageId", "generationId"], [], "parent reference");
  boundedIdentifier(value.lineageId, "lineage id");
  if (changeSetGenerationId(value.generationId)?.kind === "invalid-proposal") {
    throw new TypeError("parent generation id is invalid");
  }
  return Object.freeze({ lineageId: value.lineageId, generationId: value.generationId });
}

function normalizeAgentOperation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Agent operation is invalid");
  if (value.kind === "create") {
    exactKeys(value, ["kind", "path", "proposedText"], [], "create operation");
    return Object.freeze({ kind: "create", path: documentationPagePath(value.path), proposedText: boundedText(value.proposedText, "proposed text") });
  }
  if (value.kind === "edit") {
    exactKeys(value, ["kind", "path", "baseRevision", "proposedText"], [], "edit operation");
    if (revisionDigest(value.baseRevision) === null) throw new TypeError("edit base revision is invalid");
    return Object.freeze({
      kind: "edit", path: documentationPagePath(value.path), baseRevision: value.baseRevision,
      proposedText: boundedText(value.proposedText, "proposed text"),
    });
  }
  if (value.kind === "rename") {
    exactKeys(value, ["kind", "from", "to", "baseRevision"], ["proposedText"], "rename operation");
    if (revisionDigest(value.baseRevision) === null) throw new TypeError("rename base revision is invalid");
    return Object.freeze({
      kind: "rename", from: documentationPagePath(value.from), to: documentationPagePath(value.to),
      baseRevision: value.baseRevision,
      ...(value.proposedText === undefined ? {} : { proposedText: boundedText(value.proposedText, "proposed text") }),
    });
  }
  if (value.kind === "delete") {
    exactKeys(value, ["kind", "path", "baseRevision"], [], "delete operation");
    if (revisionDigest(value.baseRevision) === null) throw new TypeError("delete base revision is invalid");
    return Object.freeze({ kind: "delete", path: documentationPagePath(value.path), baseRevision: value.baseRevision });
  }
  throw new TypeError("Agent operation kind is invalid");
}

export function validateAgentStageInput(input) {
  try {
    exactKeys(input, ["idempotencyKey", "operations"], ["parentRef", "expectedGeneration"], "Agent stage input");
    boundedIdentifier(input.idempotencyKey, "idempotency key");
    if (!Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > 128) {
      throw new TypeError("Agent operations are invalid");
    }
    const operations = Object.freeze(input.operations.map(normalizeAgentOperation));
    validateOperationPathSet(operations.map(operation => operation.kind === "rename"
      ? { kind: "rename", source: operation.from, destination: operation.to }
      : { kind: operation.kind, path: operation.path }));
    const parentRef = input.parentRef === undefined ? undefined : rawChangeSetRef(input.parentRef);
    if ((parentRef === undefined) !== (input.expectedGeneration === undefined)) {
      throw new TypeError("parent reference and expected generation must be supplied together");
    }
    if (input.expectedGeneration !== undefined
      && (changeSetGenerationId(input.expectedGeneration)?.kind === "invalid-proposal"
        || input.expectedGeneration !== parentRef.generationId)) {
      throw new TypeError("expected generation does not match the parent");
    }
    return Object.freeze({
      idempotencyKey: input.idempotencyKey,
      operations,
      ...(parentRef ? { parentRef, expectedGeneration: input.expectedGeneration } : {}),
    });
  }
  catch (error) {
    return invalidProposal("invalid-stage-input", error.message);
  }
}

function agentOperationPaths(operation) {
  return operation.kind === "rename" ? [operation.from, operation.to] : [operation.path];
}

function snapshotText(entry) {
  if (!entry || entry.type !== "file" || typeof entry.bytes !== "string" || typeof entry.revision !== "string") {
    throw new TypeError("Agent base snapshot is not a file");
  }
  const bytes = Buffer.from(entry.bytes, "base64url");
  if (bytes.toString("base64url") !== entry.bytes || sha256Bytes(bytes) !== entry.sha256) {
    throw new TypeError("Agent base snapshot digest does not match");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new TypeError("Agent base snapshot is not UTF-8");
  return Object.freeze({ text, revision: entry.revision });
}

function nextGenerationId(parentRef) {
  if (!parentRef) return "0000000000000001";
  const next = BigInt(`0x${parentRef.generationId}`) + 1n;
  const value = next.toString(16).padStart(16, "0");
  if (!/^[0-9a-f]{16}$/u.test(value)) throw new RangeError("Change Set generation overflowed");
  return value;
}

function lineageFor(idempotencyKey) {
  return `cs-${createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 32)}`;
}

function stateGenerationFromSnapshot(result) {
  if (!result || result.kind !== "documentation-state") throw new TypeError("Documentation state snapshot is invalid");
  if (result.state?.kind === "missing") return "0000000000000000";
  const bytes = decodeStateEvidence(result.state);
  const parsed = parseDocumentationState(bytes);
  if (parsed.kind !== "valid") throw new TypeError("Documentation state is invalid");
  return parsed.state.generation;
}

async function retryResult(store, current, input) {
  if (current?.kind !== "current-generation" || typeof store.loadGeneration !== "function") return null;
  const generation = await store.loadGeneration(current.ref);
  if (generation?.kind === "generation-missing" || generation.idempotencyKey !== input.idempotencyKey) return null;
  return Object.freeze({
    kind: "generation-staged",
    ref: generation.ref,
    generationDigest: generation.generationDigest,
    reused: true,
  });
}

async function stageAgentGeneration({ adapter, capabilities, store, clock, grant, input }) {
  const normalized = validateAgentStageInput(input);
  if (normalized.kind === "invalid-proposal") return normalized;
  const brandedPaths = normalized.operations.flatMap(agentOperationPaths);
  const proposedBytes = normalized.operations.reduce((total, operation) =>
    total + Buffer.byteLength(operation.proposedText ?? "", "utf8"), 0);
  let grantRecord;
  try {
    grantRecord = capabilities.consumeAgentProposalGrant(grant, {
      paths: brandedPaths,
      operationKinds: [...new Set(normalized.operations.map(operation => operation.kind))],
      operationCount: normalized.operations.length,
      proposedBytes,
    });
  }
  catch (error) {
    return invalidProposal("proposal-grant-rejected", error.message);
  }
  const lineageId = normalized.parentRef?.lineageId ?? lineageFor(normalized.idempotencyKey);
  const current = await store.loadCurrentRef(lineageId);
  if (normalized.parentRef) {
    if (current.kind !== "current-generation" || current.ref.generationId !== normalized.expectedGeneration) {
      return await retryResult(store, current, normalized)
        ?? Object.freeze({ kind: "stale-generation", currentRef: current.ref ?? null });
    }
  }
  else if (current.kind === "current-generation") {
    return await retryResult(store, current, normalized)
      ?? Object.freeze({ kind: "stale-generation", currentRef: current.ref });
  }

  const uniquePaths = [];
  const seen = new Set();
  for (const path of brandedPaths) {
    if (!seen.has(path.value)) { seen.add(path.value); uniquePaths.push(path); }
  }
  const [snapshot, state] = await Promise.all([
    adapter.snapshot({ kind: "paths", paths: uniquePaths }),
    adapter.snapshot({ kind: "documentation-state", workspaceScopeDigest: grantRecord.workspaceScopeDigest }),
  ]);
  if (snapshot?.kind !== "snapshot") return invalidProposal("invalid-base-snapshot");
  const entries = new Map(snapshot.entries.map(entry => [entry.path.replace(/^documentation\//u, ""), entry]));
  const operations = [];
  for (let index = 0; index < normalized.operations.length; index++) {
    const operation = normalized.operations[index];
    const operationId = `op-${String(index + 1).padStart(4, "0")}-${createHash("sha256")
      .update(`${normalized.idempotencyKey}\0${operation.kind}\0${agentOperationPaths(operation).map(path => path.value).join("\0")}`, "utf8")
      .digest("hex").slice(0, 24)}`;
    if (operation.kind === "create") {
      if (entries.get(operation.path.value)?.type !== "absent") return invalidProposal("create-target-exists", operation.path.value);
      operations.push({ kind: "create", operationId, path: operation.path, targetAbsent: true, proposedText: operation.proposedText });
      continue;
    }
    const sourcePath = operation.kind === "rename" ? operation.from : operation.path;
    let base;
    try { base = snapshotText(entries.get(sourcePath.value)); }
    catch (error) { return invalidProposal("base-is-unavailable", error.message); }
    if (!sameRevision(base.revision, operation.baseRevision)) return invalidProposal("stale-base", sourcePath.value);
    if (operation.kind === "edit") operations.push({
      kind: "edit", operationId, path: operation.path, baseRevision: base.revision,
      baseText: base.text, proposedText: operation.proposedText,
    });
    else if (operation.kind === "delete") operations.push({
      kind: "delete", operationId, path: operation.path, baseRevision: base.revision, baseText: base.text,
    });
    else {
      if (entries.get(operation.to.value)?.type !== "absent") return invalidProposal("rename-target-exists", operation.to.value);
      operations.push({
        kind: "rename", operationId, from: operation.from, to: operation.to,
        baseRevision: base.revision, baseText: base.text, targetAbsent: true,
        proposedText: operation.proposedText ?? base.text,
      });
    }
  }
  const timestamp = new Date(clock.now()).toISOString();
  const built = buildChangeSetGeneration({
    lineageId,
    generationId: nextGenerationId(normalized.parentRef),
    ...(normalized.parentRef ? { parentRef: normalized.parentRef } : {}),
    repositoryIdentity: grantRecord.uri,
    authorityIdentity: grantRecord.authority,
    grantDigest: grantRecord.digest,
    idempotencyKey: normalized.idempotencyKey,
    createdAt: timestamp,
    stateGeneration: stateGenerationFromSnapshot(state),
    operations,
    allocateStableChangeId: value => value,
  });
  if (built.kind === "invalid-proposal") return built;
  return store.stageGeneration(built);
}

function reviewPathValues(operation) {
  return operation.kind === "rename" ? [operation.from, operation.to] : [operation.path];
}

async function createBoundReview({ adapter, capabilities, scope, store, registry, ref }) {
  const generation = await store.loadGeneration(ref);
  if (generation?.kind === "generation-missing") return generation;
  const paths = [];
  const seen = new Set();
  for (const operation of generation.operations) {
    for (const path of reviewPathValues(operation)) {
      if (!seen.has(path.value)) { seen.add(path.value); paths.push(path); }
    }
  }
  const [snapshot, state] = await Promise.all([
    adapter.snapshot({ kind: "paths", paths }),
    adapter.snapshot({
      kind: "documentation-state",
      workspaceScopeDigest: capabilities.consumeScope(scope).workspaceScopeDigest,
    }),
  ]);
  if (snapshot?.kind !== "snapshot") throw new TypeError("review source snapshot is invalid");
  const documents = snapshot.entries.map(entry => {
    const path = entry.path.replace(/^documentation\//u, "");
    if (entry.type === "absent") return Object.freeze({ path, absent: true });
    if (entry.type !== "file") throw new TypeError("review path is not a regular file");
    const bytes = Buffer.from(entry.bytes, "base64url");
    const text = bytes.toString("utf8");
    if (bytes.toString("base64url") !== entry.bytes || !Buffer.from(text, "utf8").equals(bytes)
      || sha256Bytes(bytes) !== entry.sha256) throw new TypeError("review source bytes are invalid");
    return Object.freeze({
      path,
      text,
      revision: entry.revision,
      dirty: entry.dirty ?? entry.revision.startsWith("text-document:"),
    });
  });
  return createReviewSnapshot({
    registry,
    generation,
    currentDocuments: documents,
    stateGeneration: stateGenerationFromSnapshot(state),
  });
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

export function createDocumentationTransactions({
  adapter,
  capabilities,
  workspaceView,
  migrationPlanner,
  changeSetStore,
  reviewRegistry,
  scope,
  clock = Date,
}) {
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
  if (changeSetStore !== undefined && (typeof changeSetStore?.stageGeneration !== "function"
    || typeof changeSetStore?.loadCurrentRef !== "function") || typeof clock?.now !== "function") {
    throw new TypeError("Documentation Change Set dependencies are invalid");
  }
  if (reviewRegistry !== undefined && (typeof reviewRegistry?.register !== "function" || !scope)) {
    throw new TypeError("Documentation review registry is invalid");
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
    ...(changeSetStore ? {
      stage: (grant, input) => stageAgentGeneration({
        adapter,
        capabilities,
        store: changeSetStore,
        clock,
        grant,
        input,
      }),
      ...(reviewRegistry && typeof changeSetStore.loadGeneration === "function" ? {
        review: ref => createBoundReview({
          adapter,
          capabilities,
          scope,
          store: changeSetStore,
          registry: reviewRegistry,
          ref,
        }),
      } : {}),
    } : {}),
  });
}
