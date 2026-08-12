import { migrationBarrierResources } from "./migration-executor.mjs";

function terminalInspection(value) {
  return value?.kind === "no-active-migration" || value?.kind === "documentation-tamper"
    || value?.kind === "recovery-conflict" || value?.kind === "migration-committed";
}

export async function recoverMigration({ adapter, barrier, uriFor } = {}) {
  if (typeof adapter?.recover !== "function" || typeof barrier?.acquire !== "function"
    || typeof uriFor !== "function") {
    throw new TypeError("migration recovery dependencies are invalid");
  }
  const inspected = await adapter.recover(Object.freeze({
    kind: "inspect-migration",
    schemaVersion: 1,
  }));
  if (terminalInspection(inspected)) return inspected;
  if (!inspected || inspected.kind !== "migration-recovery-required"
    || typeof inspected.operationId !== "string" || typeof inspected.planDigest !== "string") {
    throw new TypeError("migration recovery inspection is invalid");
  }
  const resources = migrationBarrierResources(inspected, uriFor);
  const acquired = await barrier.acquire(Object.freeze({
    operationId: inspected.operationId,
    resources,
    reason: "recovery",
  }));
  if (acquired?.kind === "dirty-working-copy" || acquired?.kind === "barrier-conflict") return acquired;
  if (!acquired || typeof acquired.revalidate !== "function" || typeof acquired.dispose !== "function") {
    throw new TypeError("migration recovery barrier returned an invalid lease");
  }
  const lease = acquired;
  const valid = await lease.revalidate();
  if (valid?.kind !== "valid") {
    lease.dispose();
    return valid;
  }
  const result = await adapter.recover(Object.freeze({
    kind: "resolve-migration",
    schemaVersion: 1,
    operationId: inspected.operationId,
    planDigest: inspected.planDigest,
    resolution: "continue",
  }));
  if (result?.kind === "migration-committed") lease.dispose();
  return result;
}
