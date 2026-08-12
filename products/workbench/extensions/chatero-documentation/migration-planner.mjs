import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import { documentationPlanningEvidence } from "./documentation-workspace.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const GENERATION = /^[0-9a-f]{16}$/u;
const PLAN_TOKEN = /^mp_[A-Za-z0-9_-]{43}$/u;
const TOKEN_LIFETIME_MS = 5 * 60 * 1000;
export const MIGRATION_PLANNER_VERSION = "documentation-migration-v2";
const OUTPUT_KINDS = new Set([
  "canonical-page",
  "canonical-asset",
  "workflow-state",
  "change-set-manifest",
  "change-set-blob",
  "quarantine-evidence",
]);
const FORBIDDEN_FIELDS = new Set([
  "body",
  "bytes",
  "content",
  "dirty",
  "text",
  "version",
  "workingCopyProofs",
]);

export const MIGRATION_PLAN_LIMITS = Object.freeze({
  maximumEntries: 50_000,
  maximumBlobBytes: 16 * 1024 * 1024,
  maximumAggregateBytes: 64 * 1024 * 1024,
  maximumReportBytes: 2 * 1024 * 1024,
});

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("migration plan is not canonical JSON");
  const keys = Object.keys(value).sort(compareUtf8Bytes);
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function canonicalMigrationPlanDigest(planRecord) {
  return `sha256:${createHash("sha256").update(canonicalJson(planRecord), "utf8").digest("hex")}`;
}

export function migrationApprovalDigest({ operationId, planDigest, idempotencyKey } = {}) {
  if (!/^migration-[0-9a-f]{32}$/u.test(operationId ?? "") || !DIGEST.test(planDigest ?? "")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(idempotencyKey ?? "")) {
    throw new TypeError("migration approval identity is invalid");
  }
  return `sha256:${createHash("sha256").update(canonicalJson({
    kind: "migration-approval-v2",
    operationId,
    planDigest,
    idempotencyKey,
  }), "utf8").digest("hex")}`;
}

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !allowed.has(key))) {
    throw new TypeError(`${label} has an invalid schema`);
  }
  return value;
}

function safePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/")
    || value.includes("\\") || /[%:?#\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is unsafe`);
  }
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")
    || parts.map(part => part.normalize("NFC")).join("/") !== value) {
    throw new TypeError(`${label} is unsafe`);
  }
  return value;
}

function boundedString(value, label, maximumBytes = 4096) {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function validateNoBodies(value, path = "migration result", depth = 0) {
  if (depth > 64) throw new TypeError("migration result is too deeply nested");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${path} contains an invalid number`);
    return;
  }
  if (typeof value === "string") {
    if (/^(?:[A-Za-z]:[\\/]|\/)/u.test(value) || /(?:file|vscode-remote):\/\//u.test(value)) {
      throw new TypeError(`${path} contains an absolute path`);
    }
    if (/[\u0000\u007f]/u.test(value)) throw new TypeError(`${path} contains control data`);
    return;
  }
  if (Array.isArray(value)) {
    for (const member of value) validateNoBodies(member, path, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") throw new TypeError(`${path} is not JSON data`);
  for (const [key, member] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key)) throw new TypeError(`${path} contains forbidden field ${key}`);
    validateNoBodies(member, `${path}.${key}`, depth + 1);
  }
}

function validateReadOnlyFailure(result, scope) {
  if (result.kind === "migration-limit") {
    exactKeys(result, ["kind", "workspaceEpoch", "code"], [], "migration limit result");
  }
  else if (result.kind === "stale-plan-evidence") {
    exactKeys(result, ["kind", "workspaceEpoch", "code"], [], "stale migration evidence result");
  }
  else if (result.kind === "migration-conflict") {
    exactKeys(result, ["kind", "workspaceEpoch", "code", "paths"], [], "migration conflict result");
    if (!Array.isArray(result.paths)) throw new TypeError("migration conflict paths are invalid");
    let previous = null;
    for (const path of result.paths) {
      safePath(path, "migration conflict path");
      if (previous !== null && compareUtf8Bytes(previous, path) >= 0) {
        throw new TypeError("migration conflict paths must be unique and bytewise sorted");
      }
      previous = path;
    }
  }
  else throw new TypeError("migration authority failure kind is unsupported");
  if (result.workspaceEpoch !== scope.epoch) throw new TypeError("migration failure epoch does not match");
  boundedString(result.code, "migration failure code");
  validateNoBodies(result);
  return result;
}

function validatePathProofs(pathProofs, affectedPaths) {
  if (!Array.isArray(pathProofs) || pathProofs.length > MIGRATION_PLAN_LIMITS.maximumEntries) {
    throw new TypeError("migration path proofs are invalid");
  }
  let previous = null;
  const paths = [];
  for (const proof of pathProofs) {
    exactKeys(proof, ["path", "role", "requireClean"], [
      "directoryGeneration", "expectedDigest", "intendedDigest", "targetAbsent",
    ], "migration path proof");
    safePath(proof.path, "migration proof path");
    if (!new Set(["source", "target"]).has(proof.role) || proof.requireClean !== true) {
      throw new TypeError("migration path proof role or clean requirement is invalid");
    }
    for (const field of ["directoryGeneration", "expectedDigest", "intendedDigest"]) {
      if (proof[field] !== undefined && !DIGEST.test(proof[field])) {
        throw new TypeError(`migration path proof ${field} is invalid`);
      }
    }
    if (proof.targetAbsent !== undefined && proof.targetAbsent !== true) {
      throw new TypeError("migration target absence proof is invalid");
    }
    const hasBefore = proof.expectedDigest !== undefined || proof.directoryGeneration !== undefined
      || proof.targetAbsent === true;
    if (!hasBefore || (proof.role === "source" && proof.targetAbsent === true)) {
      throw new TypeError("migration path proof has no usable precondition");
    }
    if (previous !== null && compareUtf8Bytes(previous, proof.path) >= 0) {
      throw new TypeError("migration path proofs must be unique and bytewise sorted");
    }
    previous = proof.path;
    paths.push(proof.path);
  }
  if (!Array.isArray(affectedPaths) || affectedPaths.length !== paths.length
    || affectedPaths.some((path, index) => path !== paths[index])) {
    throw new TypeError("migration affected paths do not exactly project path proofs");
  }
}

function validateMappings(values) {
  if (!Array.isArray(values)) throw new TypeError("migration mappings must be an array");
  let previous = null;
  for (const value of values) {
    const page = value?.kind === "page";
    exactKeys(value, [
      "kind", "sourceRoot", "sourcePath", "sourceRevision", "destinationPath", "reason",
      ...(page ? ["state"] : []),
    ], [], "migration mapping");
    if (!new Set(["page", "asset"]).has(value.kind)
      || !new Set(["knowledge", "drafts"]).has(value.sourceRoot)
      || !DIGEST.test(value.sourceRevision)) {
      throw new TypeError("migration mapping identity is invalid");
    }
    safePath(value.sourcePath, "migration mapping source");
    safePath(value.destinationPath, "migration mapping destination");
    boundedString(value.reason, "migration mapping reason");
    if (page && !new Set(["working", "reviewed"]).has(value.state)) {
      throw new TypeError("migration page state is invalid");
    }
    const key = { sourceRoot: value.sourceRoot, sourcePath: value.sourcePath };
    const comparison = previous === null ? 1
      : ({ knowledge: 0, drafts: 1 })[previous.sourceRoot]
        - ({ knowledge: 0, drafts: 1 })[key.sourceRoot]
        || compareUtf8Bytes(previous.sourcePath, key.sourcePath);
    if (previous !== null && comparison >= 0) {
      throw new TypeError("migration mappings must be unique and bytewise sorted");
    }
    previous = key;
  }
}

function validateStateOutput(value) {
  exactKeys(value, ["generation", "documents"], [], "migration state output");
  if (!GENERATION.test(value.generation) || !Array.isArray(value.documents)) {
    throw new TypeError("migration state output is invalid");
  }
  let previous = null;
  for (const document of value.documents) {
    exactKeys(document, ["path", "state"], [], "migration state document");
    safePath(document.path, "migration state document path");
    if (!document.path.toLowerCase().endsWith(".qmd")
      || !new Set(["working", "reviewed"]).has(document.state)
      || (previous !== null && compareUtf8Bytes(previous, document.path) >= 0)) {
      throw new TypeError("migration state documents are not unique and sorted");
    }
    previous = document.path;
  }
}

function validateCoordinateSummary(value, label) {
  exactKeys(value, ["from", "to", label === "rewrite edit" ? "syntax" : "code"], [], label);
  if (!Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.to)
    || value.from < 0 || value.to <= value.from) {
    throw new TypeError(`${label} coordinates are invalid`);
  }
  boundedString(value.syntax ?? value.code, `${label} classification`);
}

function validateRewrites(values) {
  if (!Array.isArray(values)) throw new TypeError("migration rewrite summaries are invalid");
  for (const value of values) {
    exactKeys(value, [
      "sourcePath", "destinationPath", "sourceDigest", "migratedDigest", "edits", "followUps",
    ], [], "migration rewrite summary");
    safePath(value.sourcePath, "migration rewrite source");
    safePath(value.destinationPath, "migration rewrite destination");
    if (!DIGEST.test(value.sourceDigest) || !DIGEST.test(value.migratedDigest)
      || !Array.isArray(value.edits) || !Array.isArray(value.followUps)) {
      throw new TypeError("migration rewrite summary is invalid");
    }
    value.edits.forEach(entry => validateCoordinateSummary(entry, "rewrite edit"));
    value.followUps.forEach(entry => validateCoordinateSummary(entry, "rewrite follow-up"));
  }
}

function validateProposalSummaries(values) {
  if (!Array.isArray(values)) throw new TypeError("migration proposal summaries are invalid");
  for (const value of values) {
    exactKeys(value, [
      "schemaVersion", "recordPath", "originalPath", "destinationPath", "classification",
      "rawBaseDigest", "rawProposedDigest", "migratedBaseDigest", "migratedProposedDigest",
      "baseRewriteCount", "proposedRewriteCount", "followUpCount", "transformationDigest",
    ], [], "migration proposal summary");
    if (value.schemaVersion !== 1 || !new Set(["valid", "exact-duplicate"]).has(value.classification)) {
      throw new TypeError("migration proposal classification is invalid");
    }
    for (const path of [value.recordPath, value.originalPath, value.destinationPath]) {
      safePath(path, "migration proposal path");
    }
    for (const field of [
      "rawBaseDigest", "rawProposedDigest", "migratedBaseDigest", "migratedProposedDigest",
      "transformationDigest",
    ]) {
      if (!DIGEST.test(value[field])) throw new TypeError("migration proposal digest is invalid");
    }
    for (const field of ["baseRewriteCount", "proposedRewriteCount", "followUpCount"]) {
      if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
        throw new TypeError("migration proposal count is invalid");
      }
    }
  }
}

function validateDiagnostics(values) {
  if (!Array.isArray(values)) throw new TypeError("migration diagnostics are invalid");
  for (const value of values) {
    exactKeys(value, ["code"], ["path", "recordPath"], "migration diagnostic");
    boundedString(value.code, "migration diagnostic code");
    if (value.path !== undefined) safePath(value.path, "migration diagnostic path");
    if (value.recordPath !== undefined) safePath(value.recordPath, "migration diagnostic record path");
  }
}

function validateCollisions(values) {
  if (!Array.isArray(values)) throw new TypeError("migration collisions are invalid");
  for (const value of values) {
    exactKeys(value, [
      "kind", "path", "contentRelation", "knowledgeRevision", "draftRevision", "draftDestination",
    ], [], "migration collision");
    if (value.kind !== "knowledge-draft" || !new Set(["equal", "different"]).has(value.contentRelation)
      || !DIGEST.test(value.knowledgeRevision) || !DIGEST.test(value.draftRevision)) {
      throw new TypeError("migration collision is invalid");
    }
    safePath(value.path, "migration collision path");
    safePath(value.draftDestination, "migration collision destination");
  }
}

function validatePlanRecord(value) {
  exactKeys(value, [
    "schemaVersion", "plannerVersion", "operationId", "createdAt",
    "sourceSnapshotDigest", "verificationSnapshotDigest", "affectedPaths",
    "pathProofs", "mappings", "stateOutput", "collisions", "rewrites", "proposals", "diagnostics",
    "intendedOutputManifest",
  ], [], "MigrationPlanV2");
  if (value.schemaVersion !== 2 || value.plannerVersion !== MIGRATION_PLANNER_VERSION
    || !/^migration-[0-9a-f]{32}$/u.test(value.operationId)
    || typeof value.createdAt !== "string" || new Date(value.createdAt).toISOString() !== value.createdAt
    || !DIGEST.test(value.sourceSnapshotDigest)
    || value.sourceSnapshotDigest !== value.verificationSnapshotDigest) {
    throw new TypeError("MigrationPlanV2 snapshot evidence is stale or invalid");
  }
  validatePathProofs(value.pathProofs, value.affectedPaths);
  validateMappings(value.mappings);
  validateStateOutput(value.stateOutput);
  validateCollisions(value.collisions);
  validateRewrites(value.rewrites);
  validateProposalSummaries(value.proposals);
  validateDiagnostics(value.diagnostics);
  validateIntendedOutputManifest(value.intendedOutputManifest, value.pathProofs);
  validateNoBodies(value);
  return value;
}

function validateIntendedOutputManifest(values, pathProofs) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MIGRATION_PLAN_LIMITS.maximumEntries) {
    throw new TypeError("migration intended output manifest is invalid");
  }
  const targets = new Map(pathProofs.filter(value => value.role === "target")
    .map(value => [value.path, value]));
  let previous = null;
  for (const value of values) {
    exactKeys(value, ["path", "kind", "size", "sha256"], [], "migration intended output");
    safePath(value.path, "migration intended output path");
    if (!OUTPUT_KINDS.has(value.kind) || !Number.isSafeInteger(value.size) || value.size < 0
      || value.size > MIGRATION_PLAN_LIMITS.maximumBlobBytes || !DIGEST.test(value.sha256)) {
      throw new TypeError("migration intended output is invalid");
    }
    if (previous !== null && compareUtf8Bytes(previous, value.path) >= 0) {
      throw new TypeError("migration intended outputs must be unique and bytewise sorted");
    }
    const proof = targets.get(value.path);
    if (!proof || proof.intendedDigest !== value.sha256) {
      throw new TypeError("migration intended output is not bound to its target proof");
    }
    previous = value.path;
  }
}

function validateReportModel(value, maximumBytes) {
  exactKeys(value, ["schemaVersion", "title", "summary", "sections"], [], "migration report model");
  if (value.schemaVersion !== 1) throw new TypeError("migration report schema is unsupported");
  boundedString(value.title, "migration report title");
  exactKeys(value.summary, ["pages", "assets", "collisions", "proposals", "followUps"], [], "migration report summary");
  for (const count of Object.values(value.summary)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("migration report count is invalid");
  }
  if (!Array.isArray(value.sections)) throw new TypeError("migration report sections are invalid");
  for (const section of value.sections) {
    exactKeys(section, ["heading", "items"], [], "migration report section");
    boundedString(section.heading, "migration report heading");
    if (!Array.isArray(section.items)) throw new TypeError("migration report items are invalid");
    section.items.forEach(item => boundedString(item, "migration report item", 16 * 1024));
  }
  validateNoBodies(value, "migration report");
  if (Buffer.byteLength(canonicalJson(value), "utf8") > maximumBytes) {
    throw new RangeError("migration report exceeds its fixed limit");
  }
  return value;
}

function expectedReportModel(planRecord) {
  const followUps = planRecord.rewrites.reduce((count, value) => count + value.followUps.length, 0)
    + planRecord.diagnostics.length;
  return {
    schemaVersion: 1,
    title: "Documentation migration dry run",
    summary: {
      pages: planRecord.mappings.filter(value => value.kind === "page").length,
      assets: planRecord.mappings.filter(value => value.kind === "asset").length,
      collisions: planRecord.collisions.length,
      proposals: planRecord.proposals.length,
      followUps,
    },
    sections: [
      {
        heading: "Planned mappings",
        items: planRecord.mappings.map(value =>
          `${value.sourceRoot}/${value.sourcePath} -> documentation/${value.destinationPath}`),
      },
      {
        heading: "Conflicts and follow-ups",
        items: [
          ...planRecord.collisions.map(value =>
            `${value.path}: ${value.contentRelation} Knowledge/Draft collision`),
          ...planRecord.diagnostics.map(value =>
            `${value.path ?? value.recordPath}: ${value.code}`),
        ],
      },
    ],
  };
}

function immutableClone(value) {
  const clone = structuredClone(value);
  const freeze = member => {
    if (!member || typeof member !== "object" || Object.isFrozen(member)) return member;
    Object.values(member).forEach(freeze);
    return Object.freeze(member);
  };
  return freeze(clone);
}

function validateAuthorityPlan(result, scope, limits) {
  exactKeys(result, [
    "kind", "schemaVersion", "plannerVersion", "workspaceEpoch", "planDigest", "planRecord", "reportModel",
  ], [], "migration authority result");
  if (result.kind !== "migration-plan-v2" || result.schemaVersion !== 2
    || result.plannerVersion !== MIGRATION_PLANNER_VERSION || result.workspaceEpoch !== scope.epoch
    || !DIGEST.test(result.planDigest)) {
    throw new TypeError("migration authority result identity is invalid");
  }
  const planRecord = validatePlanRecord(result.planRecord);
  if (canonicalMigrationPlanDigest(planRecord) !== result.planDigest) {
    throw new TypeError("migration plan digest does not cover its exact record");
  }
  validateReportModel(result.reportModel, limits.maximumReportBytes);
  if (canonicalJson(result.reportModel) !== canonicalJson(expectedReportModel(planRecord))) {
    throw new TypeError("migration report is not the exact projection of its plan record");
  }
  return Object.freeze({
    planRecord: immutableClone(planRecord),
    planDigest: result.planDigest,
    reportModel: immutableClone(result.reportModel),
  });
}

function renderReport(model) {
  const lines = [
    `# ${model.title}`,
    "",
    "This report is a read-only dry run. It does not authorize or execute migration.",
    "",
    `- Pages: ${model.summary.pages}`,
    `- Assets: ${model.summary.assets}`,
    `- Collisions preserved: ${model.summary.collisions}`,
    `- Legacy proposals: ${model.summary.proposals}`,
    `- Human follow-ups: ${model.summary.followUps}`,
  ];
  for (const section of model.sections) {
    lines.push("", `## ${section.heading}`, "");
    if (section.items.length === 0) lines.push("None.");
    else for (const item of section.items) lines.push(`- ${item}`);
  }
  return `${lines.join("\n")}\n`;
}

function currentTime(clock) {
  const now = typeof clock?.now === "function" ? clock.now.bind(clock)
    : typeof clock === "function" ? clock : null;
  if (typeof now !== "function") throw new TypeError("migration planner clock is invalid");
  return () => {
    const value = now();
    if (!Number.isFinite(value)) throw new TypeError("migration planner clock returned an invalid time");
    return value;
  };
}

function evidencePath(uri, scopeUri) {
  let value;
  let root;
  try { value = new URL(uri); root = new URL(scopeUri); }
  catch { throw new TypeError("migration working copy URI is invalid"); }
  const prefix = root.pathname === "/" ? "/" : `${root.pathname.replace(/\/+$/u, "")}/`;
  if (value.protocol !== root.protocol || value.host !== root.host || !value.pathname.startsWith(prefix)) {
    throw new TypeError("migration working copy is outside the workspace");
  }
  let relative;
  try { relative = decodeURIComponent(value.pathname.slice(prefix.length)); }
  catch { throw new TypeError("migration working copy URI encoding is invalid"); }
  return safePath(relative, "migration working copy path");
}

function defaultWorkingCopyEvidence(adapter, result) {
  const read = adapter?.[documentationPlanningEvidence];
  return typeof read === "function" ? read(result) : [];
}

export function createMigrationPlanner({
  adapter,
  capabilities,
  clock = Date,
  limits = MIGRATION_PLAN_LIMITS,
  randomBytes = nodeRandomBytes,
  isWorkspaceTrusted,
  workingCopyEvidence = defaultWorkingCopyEvidence,
}) {
  if (typeof adapter?.snapshot !== "function" || typeof capabilities?.consumeScope !== "function"
    || typeof randomBytes !== "function" || typeof isWorkspaceTrusted !== "function"
    || typeof workingCopyEvidence !== "function"
    || canonicalJson(limits) !== canonicalJson(MIGRATION_PLAN_LIMITS)) {
    throw new TypeError("migration planner dependencies are invalid");
  }
  const now = currentTime(clock);
  const tokens = new Map();

  const planMigration = async scope => {
    if (isWorkspaceTrusted() !== true) return Object.freeze({ kind: "workspace-untrusted" });
    const scopeRecord = capabilities.consumeScope(scope);
    const result = await adapter.snapshot({
      kind: "plan-migration-v2",
      limits,
      plannerVersion: MIGRATION_PLANNER_VERSION,
    });
    if (isWorkspaceTrusted() !== true) return Object.freeze({ kind: "workspace-untrusted" });
    if (new Set(["migration-limit", "migration-conflict", "stale-plan-evidence"]).has(result?.kind)) {
      return immutableClone(validateReadOnlyFailure(result, scopeRecord));
    }
    const validated = validateAuthorityPlan(result, scopeRecord, limits);
    const dirtyPaths = [];
    for (const proof of workingCopyEvidence(adapter, result)) {
      if (proof?.dirty !== true) continue;
      const path = evidencePath(proof.uri, scopeRecord.uri);
      if (validated.planRecord.affectedPaths.includes(path)) dirtyPaths.push(path);
    }
    dirtyPaths.sort(compareUtf8Bytes);
    if (dirtyPaths.length > 0) {
      return Object.freeze({ kind: "dirty-working-copy", paths: Object.freeze([...new Set(dirtyPaths)]) });
    }
    const tokenBytes = Buffer.from(randomBytes(32));
    if (tokenBytes.byteLength !== 32) throw new TypeError("migration plan token entropy is invalid");
    const planToken = `mp_${tokenBytes.toString("base64url")}`;
    if (!PLAN_TOKEN.test(planToken) || tokens.has(planToken)) {
      throw new TypeError("migration plan token is invalid or reused");
    }
    const plan = immutableClone({
      ...validated.planRecord,
      digest: validated.planDigest,
      workspaceEpoch: scopeRecord.epoch,
    });
    tokens.set(planToken, Object.freeze({
      scope,
      authority: scopeRecord.authority,
      workspaceEpoch: scopeRecord.epoch,
      workspaceScopeDigest: scopeRecord.workspaceScopeDigest,
      planDigest: validated.planDigest,
      planRecord: validated.planRecord,
      expiresAt: now() + TOKEN_LIFETIME_MS,
    }));
    return Object.freeze({
      kind: "planned",
      plan,
      planToken,
      report: renderReport(validated.reportModel),
    });
  };

  const resolvePlanToken = (token, scope) => {
    if (typeof token !== "string" || !PLAN_TOKEN.test(token)) {
      return Object.freeze({ kind: "invalid-plan-token" });
    }
    const binding = tokens.get(token);
    if (!binding || binding.scope !== scope) return Object.freeze({ kind: "invalid-plan-token" });
    let current;
    try { current = capabilities.consumeScope(scope); }
    catch { return Object.freeze({ kind: "invalid-plan-token" }); }
    if (now() > binding.expiresAt || current.authority !== binding.authority
      || current.epoch !== binding.workspaceEpoch
      || current.workspaceScopeDigest !== binding.workspaceScopeDigest
      || canonicalMigrationPlanDigest(binding.planRecord) !== binding.planDigest) {
      tokens.delete(token);
      return Object.freeze({ kind: "invalid-plan-token" });
    }
    return Object.freeze({ binding, current });
  };

  const inspectPlanToken = (token, scope) => {
    const resolved = resolvePlanToken(token, scope);
    if (resolved.kind === "invalid-plan-token") return resolved;
    return Object.freeze({
      kind: "planned-token",
      planDigest: resolved.binding.planDigest,
      workspaceEpoch: resolved.binding.workspaceEpoch,
      plan: immutableClone({
        ...resolved.binding.planRecord,
        digest: resolved.binding.planDigest,
        workspaceEpoch: resolved.binding.workspaceEpoch,
      }),
    });
  };

  const consumePlanToken = (token, scope) => {
    const resolved = resolvePlanToken(token, scope);
    if (resolved.kind === "invalid-plan-token") return resolved;
    const binding = resolved.binding;
    tokens.delete(token);
    return Object.freeze({
      kind: "consumed-plan",
      planDigest: binding.planDigest,
      workspaceEpoch: binding.workspaceEpoch,
      planRecord: binding.planRecord,
    });
  };

  return Object.freeze({ planMigration, inspectPlanToken, consumePlanToken });
}

export class MigrationReportContentProvider {
  constructor({ maximumBytes = MIGRATION_PLAN_LIMITS.maximumReportBytes } = {}) {
    this.maximumBytes = maximumBytes;
    this.reports = new Map();
  }

  publish(plan, report, Uri) {
    if (!plan || !DIGEST.test(plan.digest) || typeof report !== "string"
      || Buffer.byteLength(report, "utf8") > this.maximumBytes
      || typeof Uri?.parse !== "function") {
      throw new TypeError("migration report publication is invalid");
    }
    const id = plan.digest.slice("sha256:".length);
    const existing = this.reports.get(id);
    if (existing !== undefined && existing !== report) throw new Error("migration report digest conflicts");
    this.reports.set(id, report);
    return Uri.parse(`chatero-documentation-report:/${id}.md`);
  }

  provideTextDocumentContent(uri) {
    const match = /^\/([0-9a-f]{64})\.md$/u.exec(uri?.path ?? "");
    if (!match || !this.reports.has(match[1])) throw new TypeError("migration report URI is unknown");
    return this.reports.get(match[1]);
  }

  dispose() {
    this.reports.clear();
  }
}
