import { migrationApprovalDigest } from "./migration-planner.mjs";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function failedBarrier(value) {
  return value?.kind === "dirty-working-copy" || value?.kind === "barrier-conflict";
}

function resourceForProof(proof, uriFor) {
  if (!proof || typeof proof.path !== "string" || proof.requireClean !== true
    || !new Set(["source", "target"]).has(proof.role)) {
    throw new TypeError("migration path proof is invalid");
  }
  return Object.freeze({
    uri: uriFor(proof.path),
    ...(proof.expectedDigest ? { expectedDigest: proof.expectedDigest } : {}),
    ...(proof.intendedDigest ? { intendedDigest: proof.intendedDigest } : {}),
    ...(proof.directoryGeneration ? { expectedDirectoryGeneration: proof.directoryGeneration } : {}),
    requireClean: true,
    ...(proof.targetAbsent === true ? { targetAbsent: true } : {}),
  });
}

export function migrationBarrierResources(plan, uriFor) {
  if (!plan || !Array.isArray(plan.pathProofs) || !Array.isArray(plan.affectedPaths)
    || plan.pathProofs.length !== plan.affectedPaths.length
    || plan.pathProofs.some((proof, index) => proof.path !== plan.affectedPaths[index])
    || typeof uriFor !== "function") {
    throw new TypeError("migration plan path proofs are incomplete");
  }
  return Object.freeze(plan.pathProofs.map(proof => resourceForProof(proof, uriFor)));
}

export function migrationApprovalRequest({ planToken, idempotencyKey, planner, scope } = {}) {
  if (!ID_RE.test(idempotencyKey ?? "") || typeof planner?.inspectPlanToken !== "function") {
    throw new TypeError("migration approval request is invalid");
  }
  const inspected = planner.inspectPlanToken(planToken, scope);
  if (inspected?.kind !== "planned-token") return inspected;
  return Object.freeze({
    kind: "migration-approval-request",
    operationId: inspected.plan.operationId,
    planDigest: inspected.planDigest,
    idempotencyKey,
    digest: migrationApprovalDigest({
      operationId: inspected.plan.operationId,
      planDigest: inspected.planDigest,
      idempotencyKey,
    }),
  });
}

export async function executeMigration({
  planToken,
  idempotencyKey,
  approval,
  planner,
  capabilities,
  scope,
  adapter,
  barrier,
  uriFor,
} = {}) {
  if (!ID_RE.test(idempotencyKey ?? "") || typeof planner?.inspectPlanToken !== "function"
    || typeof planner?.consumePlanToken !== "function"
    || typeof capabilities?.consumeMigrationApproval !== "function"
    || typeof adapter?.transact !== "function" || typeof barrier?.acquire !== "function"
    || typeof uriFor !== "function") {
    throw new TypeError("migration executor dependencies are invalid");
  }
  const inspected = planner.inspectPlanToken(planToken, scope);
  if (inspected?.kind !== "planned-token") return inspected;
  const { plan, planDigest } = inspected;
  const resources = migrationBarrierResources(plan, uriFor);
  const acquired = await barrier.acquire(Object.freeze({
    operationId: plan.operationId,
    resources,
    reason: "migration",
  }));
  if (failedBarrier(acquired)) return acquired;
  if (!acquired || typeof acquired.revalidate !== "function" || typeof acquired.dispose !== "function") {
    throw new TypeError("migration barrier returned an invalid lease");
  }
  const lease = acquired;
  let dispatched = false;
  try {
    const valid = await lease.revalidate();
    if (valid?.kind !== "valid") {
      lease.dispose();
      return valid;
    }
    const approvalDigest = migrationApprovalDigest({
      operationId: plan.operationId,
      planDigest,
      idempotencyKey,
    });
    const approvalRecord = capabilities.consumeMigrationApproval(approval, approvalDigest, { scope });
    if (approvalRecord.epoch !== plan.workspaceEpoch) {
      lease.dispose();
      throw new TypeError("migration approval workspace epoch does not match its plan");
    }
    const consumed = planner.consumePlanToken(planToken, scope);
    if (consumed?.kind !== "consumed-plan" || consumed.planDigest !== planDigest
      || consumed.workspaceEpoch !== plan.workspaceEpoch) {
      lease.dispose();
      throw new TypeError("migration plan token changed before execution");
    }
    dispatched = true;
    const transaction = Object.freeze({
      kind: "execute-migration",
      schemaVersion: 1,
      operationId: plan.operationId,
      workspaceEpoch: plan.workspaceEpoch,
      planDigest,
      planRecord: consumed.planRecord,
      approvalDigest,
      idempotencyKey,
    });
    let result;
    try { result = await adapter.transact(transaction); }
    catch { result = await adapter.transact(transaction); }
    if (result?.kind === "migration-committed" || result?.kind === "stale-plan"
      || result?.kind === "idempotency-conflict") lease.dispose();
    return result;
  }
  catch (error) {
    if (!dispatched) lease.dispose();
    else {
      return Object.freeze({
        kind: "migration-recovery-required",
        operationId: plan.operationId,
        planDigest,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}
