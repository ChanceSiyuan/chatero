import { documentationPagePath } from "./documentation-path.mjs";
import {
  canonicalSettlementJson,
  settlementTextProofDigest,
} from "./settlement-protocol.mjs";

function validateDependencies({ plan, adapter, barrier, coordinator, uriFor }) {
  if (!plan || plan.kind !== "settlement-plan" || !Array.isArray(plan.textOperations)
    || !Array.isArray(plan.resourceOperations) || typeof plan.operationId !== "string"
    || typeof plan.operationDigest !== "string" || typeof plan.affectedResourceDigest !== "string") {
    throw new TypeError("settlement plan is invalid");
  }
  if (typeof adapter?.transact !== "function" || typeof barrier?.acquire !== "function"
    || typeof coordinator?.applyVersionedTextEdits !== "function" || typeof uriFor !== "function") {
    throw new TypeError("settlement executor dependencies are invalid");
  }
  if (plan.resourceOperations.length > 0) {
    throw new TypeError("structural settlement requires the resource continuation");
  }
  if (plan.textOperations.some(operation => !Number.isSafeInteger(operation.expectedVersion))) {
    throw new TypeError("settlement text must bind an open TextDocument version");
  }
}

function textOverlay(plan) {
  return Object.freeze(plan.textOperations.map(operation => Object.freeze({
    path: operation.path,
    expectedVersion: operation.expectedVersion,
    currentRevision: operation.currentRevision,
    beforeDigest: operation.currentDigest,
    intendedText: operation.intendedText,
    intendedDigest: operation.intendedDigest,
  })));
}

function authorityPlan(plan, overlay) {
  return Object.freeze({
    kind: "prepare-settlement",
    schemaVersion: 1,
    operationId: plan.operationId,
    idempotencyKey: plan.idempotencyKey,
    operationDigest: plan.operationDigest,
    affectedResourceDigest: plan.affectedResourceDigest,
    reviewDigest: plan.reviewDigest,
    generationDigest: plan.generationDigest,
    expectedStateGeneration: plan.stateGeneration,
    decisions: plan.decisions,
    textOverlay: overlay,
    resourceOperations: plan.resourceOperations,
    stateChanges: plan.stateChanges,
    deferredOperations: plan.deferredOperations,
  });
}

function validatePrepared(value, plan, expectedOverlay) {
  if (!value || value.kind !== "awaiting-text" || value.operationId !== plan.operationId
    || value.operationDigest !== plan.operationDigest
    || value.affectedResourceDigest !== plan.affectedResourceDigest
    || typeof value.approvalAcceptanceProof !== "string"
    || canonicalSettlementJson(value.textOverlay) !== canonicalSettlementJson(expectedOverlay)) {
    throw new TypeError("authority returned an invalid prepared settlement");
  }
  return value;
}

function makeTextProof(plan, overlay, applied) {
  if (!applied || applied.kind !== "applied" || applied.operationId !== plan.operationId
    || !Array.isArray(applied.versions) || applied.versions.length !== overlay.length) {
    throw new TypeError("working-copy settlement proof is invalid");
  }
  const versions = new Map(applied.versions.map(value => [value.uri.toString(), value]));
  const resources = overlay.map(value => {
    const uri = value.uri;
    const version = versions.get(uri.toString());
    if (!version || version.before !== value.expectedVersion || version.after !== value.expectedVersion + 1) {
      throw new TypeError("working-copy settlement version proof does not match");
    }
    return Object.freeze({
      uri: uri.toString(),
      beforeVersion: version.before,
      afterVersion: version.after,
      beforeDigest: value.beforeDigest,
      intendedDigest: value.intendedDigest,
    });
  });
  const identity = Object.freeze({
    kind: "settlement-text-proof",
    operationId: plan.operationId,
    operationDigest: plan.operationDigest,
    resources: Object.freeze(resources),
  });
  return Object.freeze({ ...identity, proofDigest: settlementTextProofDigest(identity) });
}

function validationFailure(value) {
  return value?.kind === "dirty-working-copy" || value?.kind === "barrier-conflict";
}

export async function executeSettlement({ plan, adapter, barrier, coordinator, uriFor } = {}) {
  validateDependencies({ plan, adapter, barrier, coordinator, uriFor });
  const overlay = textOverlay(plan).map(value => Object.freeze({
    ...value,
    uri: uriFor(documentationPagePath(value.path)),
  }));
  const resources = Object.freeze(overlay.map(value => Object.freeze({
    uri: value.uri,
    expectedVersion: value.expectedVersion,
    expectedDigest: value.beforeDigest,
    intendedDigest: value.intendedDigest,
    requireClean: false,
  })));
  if (resources.length === 0) {
    throw new TypeError("empty settlement execution is not yet supported");
  }
  const acquired = await barrier.acquire(Object.freeze({
    operationId: plan.operationId,
    resources,
    reason: "settlement",
  }));
  if (validationFailure(acquired)) return acquired;
  if (!acquired || typeof acquired.revalidate !== "function"
    || typeof acquired.applyWorkspaceEdit !== "function" || typeof acquired.dispose !== "function") {
    throw new TypeError("Documentation barrier returned an invalid lease");
  }
  const lease = acquired;
  let prepared = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const valid = await lease.revalidate();
      if (valid?.kind !== "valid") {
        lease.dispose();
        return valid;
      }
    }
    const publicOverlay = Object.freeze(overlay.map(({ uri: _uri, ...value }) => Object.freeze(value)));
    const preparedResult = validatePrepared(
      await adapter.transact(authorityPlan(plan, publicOverlay)),
      plan,
      publicOverlay,
    );
    prepared = true;
    const applied = await coordinator.applyVersionedTextEdits(Object.freeze({
      operationId: plan.operationId,
      origin: "settlement",
      edits: Object.freeze(overlay.map(value => Object.freeze({
        uri: value.uri,
        baseVersion: value.expectedVersion,
        changes: plan.textOperations.find(operation => operation.path === value.path).changes,
      }))),
      applyWorkspaceEdit: edit => lease.applyWorkspaceEdit(edit),
    }));
    if (applied.kind !== "applied") {
      return Object.freeze({
        kind: "settlement-recovery-required",
        operationId: plan.operationId,
        operationDigest: plan.operationDigest,
        approvalAcceptanceProof: preparedResult.approvalAcceptanceProof,
        cause: applied,
      });
    }
    const proofOverlay = overlay.map(value => Object.freeze({ ...value, uri: value.uri }));
    const textProof = makeTextProof(plan, proofOverlay, applied);
    const result = await adapter.transact(Object.freeze({
      kind: "ack-settlement-text",
      schemaVersion: 1,
      operationId: plan.operationId,
      operationDigest: plan.operationDigest,
      affectedResourceDigest: plan.affectedResourceDigest,
      textProof,
    }));
    if (result?.kind !== "settlement-committed" || result.operationId !== plan.operationId) {
      return Object.freeze({
        kind: "settlement-recovery-required",
        operationId: plan.operationId,
        operationDigest: plan.operationDigest,
        approvalAcceptanceProof: preparedResult.approvalAcceptanceProof,
        cause: result,
      });
    }
    lease.dispose();
    return Object.freeze({ ...result });
  }
  catch (error) {
    if (!prepared) lease.dispose();
    throw error;
  }
}
