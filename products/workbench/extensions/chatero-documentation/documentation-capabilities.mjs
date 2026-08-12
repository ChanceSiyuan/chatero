import { createHash } from "node:crypto";

import { validateOperationPathSet } from "./documentation-path.mjs";

const AGENT_OPERATION_KINDS = new Set(["create", "edit", "rename", "delete"]);
const DIGEST_RE = /^(?:sha256:)?[0-9a-f]{64}$/u;

function freezeRecord(value) {
  for (const member of Object.values(value)) {
    if (Array.isArray(member) && !Object.isFrozen(member)) Object.freeze(member);
    if (member instanceof Set && !Object.isFrozen(member)) Object.freeze(member);
  }
  return Object.freeze(value);
}

function canonicalWorkspaceIdentity({ uri, authority, epoch }) {
  if (typeof uri !== "string" || typeof authority !== "string" || typeof epoch !== "string"
    || authority.length === 0 || epoch.length === 0
    || /[\u0000-\u001f\u007f]/u.test(authority + epoch)) {
    throw new TypeError("workspace identity is invalid");
  }
  let parsed;
  try {
    parsed = new URL(uri);
  }
  catch {
    throw new TypeError("workspace URI is invalid");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.startsWith("/")) {
    throw new TypeError("workspace URI is invalid");
  }
  if (parsed.protocol === "file:") {
    if (parsed.host || authority !== "local") throw new TypeError("workspace authority does not match its URI");
  }
  else if (parsed.protocol === "vscode-remote:") {
    if (!parsed.host || parsed.host !== authority) throw new TypeError("workspace authority does not match its URI");
  }
  else {
    throw new TypeError("workspace URI scheme is unsupported");
  }
  const canonicalUri = parsed.toString();
  const workspaceScopeDigest = createHash("sha256")
    .update([canonicalUri, authority, epoch]
      .map(value => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|"), "utf8")
    .digest("hex");
  return freezeRecord({
    authority,
    epoch,
    uri: canonicalUri,
    workspaceKey: `${canonicalUri}\0${authority}`,
    workspaceScopeDigest,
  });
}

function validateDigest(digest) {
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
    throw new TypeError("canonical request digest is invalid");
  }
  return digest;
}

function validateExpiry(expiresInMs) {
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs <= 0) {
    throw new TypeError("capability expiry is invalid");
  }
  return expiresInMs;
}

function validateLimit(value, label, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function validateOperationKinds(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("Agent operation kinds are invalid");
  }
  const kinds = [];
  const seen = new Set();
  for (const value of values) {
    if (!AGENT_OPERATION_KINDS.has(value) || seen.has(value)) {
      throw new TypeError("Agent operation kinds are invalid");
    }
    seen.add(value);
    kinds.push(value);
  }
  return Object.freeze(kinds.sort());
}

function validateBrandedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new TypeError("Agent paths are invalid");
  validateOperationPathSet(paths.map(path => ({ kind: "edit", path })));
  return Object.freeze(paths.map(path => path.value).sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))));
}

function grantDigest(record) {
  const tuple = [
    "chatero-agent-proposal-grant-v1",
    record.capabilityId,
    record.uri,
    record.authority,
    record.epoch,
    ...record.pathPrefixes,
    ...record.operationKinds,
    String(record.maximumOperationCount),
    String(record.maximumProposedBytes),
    String(record.expiresAt),
  ];
  const encoded = tuple.map(value => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

export function createDocumentationCapabilityIssuer({ clock, randomUUID }) {
  const now = typeof clock === "function" ? clock : clock?.now?.bind(clock);
  if (typeof now !== "function" || typeof randomUUID !== "function") {
    throw new TypeError("capability issuer dependencies are invalid");
  }
  const scopeRecords = new WeakMap();
  const grantRecords = new WeakMap();
  const humanApprovalRecords = new WeakMap();
  const migrationApprovalRecords = new WeakMap();
  const recoveryApprovalRecords = new WeakMap();
  const consumed = new WeakSet();
  const issuedIds = new Set();
  const currentEpochs = new Map();

  const timestamp = () => {
    const value = now();
    if (!Number.isFinite(value)) throw new TypeError("capability clock returned an invalid time");
    return value;
  };
  const allocateId = () => {
    const value = randomUUID();
    if (typeof value !== "string" || value.length === 0 || issuedIds.has(value)) {
      throw new TypeError("capability id is invalid or reused");
    }
    issuedIds.add(value);
    return value;
  };
  const token = (kind, records, record) => {
    const value = Object.freeze({ kind });
    records.set(value, record);
    return value;
  };
  const resolve = (records, value) => {
    if (!value || typeof value !== "object" || !records.has(value)) {
      throw new TypeError("unrecognized capability");
    }
    return records.get(value);
  };
  const assertCurrentEpoch = record => {
    if (currentEpochs.get(record.workspaceKey) !== record.epoch) {
      throw new TypeError("capability workspace epoch is no longer current");
    }
  };
  const resolveScope = value => {
    const record = resolve(scopeRecords, value);
    assertCurrentEpoch(record);
    return record;
  };
  const expectedScopeFrom = options => {
    if (!options) return null;
    const value = scopeRecords.has(options) ? options : options.scope;
    return value ? resolveScope(value) : null;
  };
  const assertExpectedScope = (record, options) => {
    const expected = expectedScopeFrom(options);
    if (!expected) return;
    if (record.authority !== expected.authority || record.uri !== expected.uri) {
      throw new TypeError("capability workspace authority does not match");
    }
    if (record.epoch !== expected.epoch) {
      throw new TypeError("capability workspace epoch does not match");
    }
  };
  const assertUsable = (capability, record, options) => {
    if (consumed.has(capability)) throw new TypeError("capability was already consumed");
    assertCurrentEpoch(record);
    assertExpectedScope(record, options);
    if (timestamp() > record.expiresAt) throw new TypeError("capability has expired");
  };

  function issueScope(identity) {
    const workspace = canonicalWorkspaceIdentity(identity);
    const record = freezeRecord({
      kind: "workspace-scope",
      capabilityId: allocateId(),
      ...workspace,
    });
    currentEpochs.set(record.workspaceKey, record.epoch);
    return token("opaque-workspace-scope", scopeRecords, record);
  }

  function consumeScope(scope) {
    return resolveScope(scope);
  }

  function issueAgentProposalGrant(scope, input) {
    const workspace = resolveScope(scope);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("Agent grant input is invalid");
    }
    const capabilityId = allocateId();
    const base = {
      kind: "agent-proposal-grant",
      capabilityId,
      uri: workspace.uri,
      authority: workspace.authority,
      epoch: workspace.epoch,
      workspaceKey: workspace.workspaceKey,
      workspaceScopeDigest: workspace.workspaceScopeDigest,
      pathPrefixes: validateBrandedPaths(input.paths),
      operationKinds: validateOperationKinds(input.operationKinds),
      maximumOperationCount: validateLimit(input.maximumOperationCount, "maximum operation count"),
      maximumProposedBytes: validateLimit(input.maximumProposedBytes, "maximum proposed bytes"),
      expiresAt: timestamp() + validateExpiry(input.expiresInMs),
    };
    const record = freezeRecord({ ...base, digest: grantDigest(base) });
    return token("agent-proposal-grant", grantRecords, record);
  }

  function consumeAgentProposalGrant(grant, request) {
    const record = resolve(grantRecords, grant);
    if (consumed.has(grant)) throw new TypeError("capability was already consumed");
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError("Agent grant request is invalid");
    }
    assertUsable(grant, record, { scope: request.scope });
    const requestedPaths = validateBrandedPaths(request.paths);
    const requestedKinds = validateOperationKinds(request.operationKinds);
    const operationCount = validateLimit(request.operationCount, "Agent operation count");
    const proposedBytes = validateLimit(request.proposedBytes, "Agent proposed bytes", { allowZero: true });
    if (operationCount > record.maximumOperationCount || proposedBytes > record.maximumProposedBytes
      || requestedKinds.some(kind => !record.operationKinds.includes(kind))
      || requestedPaths.some(path => !record.pathPrefixes.some(prefix =>
        path === prefix || path.startsWith(`${prefix}/`)))) {
      throw new TypeError("Agent request exceeds its proposal grant");
    }
    consumed.add(grant);
    return record;
  }

  function issueApproval(kind, records, scope, input) {
    const workspace = resolveScope(scope);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError(`${kind} input is invalid`);
    }
    const record = freezeRecord({
      kind,
      capabilityId: allocateId(),
      uri: workspace.uri,
      authority: workspace.authority,
      epoch: workspace.epoch,
      workspaceKey: workspace.workspaceKey,
      workspaceScopeDigest: workspace.workspaceScopeDigest,
      digest: validateDigest(input.digest),
      expiresAt: timestamp() + validateExpiry(input.expiresInMs),
    });
    return token(kind, records, record);
  }

  function consumeApproval(kind, records, approval, digest, options) {
    const record = resolve(records, approval);
    if (record.kind !== kind) throw new TypeError("unrecognized capability");
    if (consumed.has(approval)) throw new TypeError("capability was already consumed");
    assertCurrentEpoch(record);
    if (record.digest !== validateDigest(digest)) throw new TypeError("capability request digest does not match");
    assertExpectedScope(record, options);
    if (timestamp() > record.expiresAt) throw new TypeError("capability has expired");
    consumed.add(approval);
    return record;
  }

  function issueHumanApproval(scope, input) {
    return issueApproval("human-approval", humanApprovalRecords, scope, input);
  }
  function consumeHumanApproval(approval, digest, options) {
    return consumeApproval("human-approval", humanApprovalRecords, approval, digest, options);
  }
  function issueMigrationApproval(scope, input) {
    return issueApproval("migration-approval", migrationApprovalRecords, scope, input);
  }
  function consumeMigrationApproval(approval, digest, options) {
    return consumeApproval("migration-approval", migrationApprovalRecords, approval, digest, options);
  }
  function issueRecoveryApproval(scope, input) {
    return issueApproval("recovery-approval", recoveryApprovalRecords, scope, input);
  }
  function consumeRecoveryApproval(approval, digest, options) {
    return consumeApproval("recovery-approval", recoveryApprovalRecords, approval, digest, options);
  }

  return Object.freeze({
    issueScope,
    consumeScope,
    issueAgentProposalGrant,
    consumeAgentProposalGrant,
    issueHumanApproval,
    consumeHumanApproval,
    issueMigrationApproval,
    consumeMigrationApproval,
    issueRecoveryApproval,
    consumeRecoveryApproval,
  });
}
