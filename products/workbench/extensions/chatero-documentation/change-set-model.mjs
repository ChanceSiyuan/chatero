import { createHash } from "node:crypto";

import { documentationPagePath, validateOperationPathSet } from "./documentation-path.mjs";
import { deriveStableHunks } from "./stable-hunks.mjs";

export const CHANGE_SET_GENERATION_ID_RE = /^[0-9a-f]{16}$/u;

const DIGEST_RE = /^(?:sha256:)?[0-9a-f]{64}$/u;
const REVISION_RE = /^(?:sha256:[0-9a-f]{64}|text-document:(?:0|[1-9][0-9]*):sha256:[0-9a-f]{64})$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FIRST_GENERATION = "0000000000000001";
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

function invalid(code, detail) {
  return Object.freeze({ kind: "invalid-proposal", code, ...(detail ? { detail } : {}) });
}

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("Change Set contains a non-canonical value");
  const keys = Object.keys(value).sort(compareUtf8Bytes);
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestValue(value) {
  return `sha256:${sha256(Buffer.from(canonicalJson(value), "utf8"))}`;
}

function revisionDigest(value) {
  return typeof value === "string" ? /sha256:([0-9a-f]{64})$/u.exec(value)?.[1] : undefined;
}

function validateTextRevision(text, revision) {
  return REVISION_RE.test(revision) && revisionDigest(revision) === sha256(Buffer.from(text, "utf8"));
}

function safeIdentity(value, label) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4096
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function safeId(value, label) {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function validateRef(value, label = "Change Set reference") {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, "lineageId")
    || !Object.hasOwn(value, "generationId")) throw new TypeError(`${label} is invalid`);
  safeId(value.lineageId, `${label} lineage`);
  if (changeSetGenerationId(value.generationId)?.kind === "invalid-proposal") {
    throw new TypeError(`${label} generation is invalid`);
  }
  return Object.freeze({ lineageId: value.lineageId, generationId: value.generationId });
}

function operationPathRecords(operation) {
  if (operation.kind === "rename") return [operation.from, operation.to];
  return [operation.path];
}

function operationSortPath(operation) {
  return operation.kind === "rename" ? operation.from.value : operation.path.value;
}

function cloneOperation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Change Set operation is invalid");
  safeId(value.operationId, "operation id");
  let operation;
  if (value.kind === "create") {
    if (value.targetAbsent !== true || typeof value.proposedText !== "string") throw new TypeError("create operation is invalid");
    operation = { kind: "create", operationId: value.operationId, path: value.path, targetAbsent: true, proposedText: value.proposedText };
  }
  else if (value.kind === "edit") {
    if (typeof value.baseText !== "string" || typeof value.proposedText !== "string"
      || !validateTextRevision(value.baseText, value.baseRevision) || value.baseText === value.proposedText) {
      throw new TypeError("edit operation is invalid");
    }
    operation = {
      kind: "edit", operationId: value.operationId, path: value.path,
      baseRevision: value.baseRevision, baseText: value.baseText, proposedText: value.proposedText,
    };
  }
  else if (value.kind === "rename") {
    if (value.targetAbsent !== true || typeof value.baseText !== "string" || typeof value.proposedText !== "string"
      || !validateTextRevision(value.baseText, value.baseRevision)) throw new TypeError("rename operation is invalid");
    operation = {
      kind: "rename", operationId: value.operationId, from: value.from, to: value.to,
      baseRevision: value.baseRevision, baseText: value.baseText, targetAbsent: true, proposedText: value.proposedText,
    };
  }
  else if (value.kind === "delete") {
    if (typeof value.baseText !== "string" || !validateTextRevision(value.baseText, value.baseRevision)) {
      throw new TypeError("delete operation is invalid");
    }
    operation = {
      kind: "delete", operationId: value.operationId, path: value.path,
      baseRevision: value.baseRevision, baseText: value.baseText,
    };
  }
  else throw new TypeError("Change Set operation kind is invalid");
  for (const path of operationPathRecords(operation)) {
    if (!path || path.kind !== "documentation-page" || typeof path.value !== "string") {
      throw new TypeError("Change Set operation path is invalid");
    }
  }
  const textBytes = [operation.baseText, operation.proposedText]
    .filter(value => value !== undefined)
    .reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
  if (textBytes > MAX_TEXT_BYTES) throw new TypeError("Change Set operation text is too large");
  return Object.freeze(operation);
}

function validatedOperations(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 128) throw new TypeError("Change Set operations are invalid");
  const operations = values.map(cloneOperation);
  const ids = new Set();
  for (const operation of operations) {
    if (ids.has(operation.operationId)) throw new TypeError("Change Set operation id is duplicated");
    ids.add(operation.operationId);
  }
  validateOperationPathSet(operations.map(operation => operation.kind === "rename"
    ? { kind: "rename", source: operation.from, destination: operation.to }
    : { kind: operation.kind, path: operation.path }));
  operations.sort((left, right) => compareUtf8Bytes(operationSortPath(left), operationSortPath(right))
    || compareUtf8Bytes(left.operationId, right.operationId));
  return Object.freeze(operations);
}

function withinGrant(path, prefixes) {
  return prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

export function validateChangeSetInput(input, grant) {
  try {
    if (!input || typeof input !== "object" || !grant || typeof grant !== "object") throw new TypeError("input is missing");
    const operations = validatedOperations(input.operations);
    if (!DIGEST_RE.test(grant.digest) || !Array.isArray(grant.pathPrefixes) || !Array.isArray(grant.operationKinds)
      || !Number.isSafeInteger(grant.maximumOperationCount) || !Number.isSafeInteger(grant.maximumProposedBytes)
      || operations.length > grant.maximumOperationCount) throw new TypeError("grant bounds are invalid");
    let proposedBytes = 0;
    for (const operation of operations) {
      if (!grant.operationKinds.includes(operation.kind)) throw new TypeError("operation kind exceeds grant");
      for (const path of operationPathRecords(operation)) {
        if (!withinGrant(path.value, grant.pathPrefixes)) throw new TypeError("operation path exceeds grant");
      }
      proposedBytes += Buffer.byteLength(operation.proposedText ?? "", "utf8");
    }
    if (proposedBytes > grant.maximumProposedBytes) throw new TypeError("proposed bytes exceed grant");
    return Object.freeze({ operations, grantDigest: grant.digest, proposedBytes });
  }
  catch (error) {
    return invalid("invalid-change-set-input", error.message);
  }
}

export function changeSetGenerationId(input) {
  return typeof input === "string" && CHANGE_SET_GENERATION_ID_RE.test(input)
    ? input : invalid("invalid-generation-id");
}

export function changeSetGenerationPaths(reference) {
  const ref = validateRef(reference);
  const directory = `work/qlab-zotero/documentation-changes/${ref.lineageId}/${ref.generationId}`;
  const operationPath = operationId => {
    safeId(operationId, "operation id");
    return `${directory}/blobs/${operationId}`;
  };
  return Object.freeze({
    directory,
    manifest: `${directory}/manifest.v1.json`,
    blobs: `${directory}/blobs`,
    baseBlob: operationId => `${operationPath(operationId)}.base`,
    proposedBlob: operationId => `${operationPath(operationId)}.proposed`,
  });
}

function validateGenerationParent(lineageId, generationId, parentRef) {
  if (generationId === FIRST_GENERATION) {
    if (parentRef !== undefined) throw new TypeError("first generation cannot have a parent");
    return undefined;
  }
  if (parentRef === undefined) throw new TypeError("child generation requires a parent");
  const parent = validateRef(parentRef, "parent reference");
  if (parent.lineageId !== lineageId || BigInt(`0x${parent.generationId}`) >= BigInt(`0x${generationId}`)) {
    throw new TypeError("parent reference does not precede the child generation");
  }
  return parent;
}

function generationIdentity(input, operations, hunks, parentRef) {
  return {
    schemaVersion: 1,
    ref: { lineageId: input.lineageId, generationId: input.generationId },
    ...(parentRef ? { parentRef } : {}),
    repositoryIdentity: input.repositoryIdentity,
    authorityIdentity: input.authorityIdentity,
    grantDigest: input.grantDigest,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt,
    stateGeneration: input.stateGeneration,
    operations,
    hunks,
  };
}

function blobDescriptor(path, text) {
  const bytes = Buffer.from(text, "utf8");
  return Object.freeze({ path, size: bytes.byteLength, sha256: sha256(bytes) });
}

function serializedOperation(operation, paths) {
  if (operation.kind === "create") return {
    kind: operation.kind, operationId: operation.operationId, path: operation.path.value,
    targetAbsent: true, proposedBlob: blobDescriptor(paths.proposedBlob(operation.operationId), operation.proposedText),
  };
  if (operation.kind === "edit") return {
    kind: operation.kind, operationId: operation.operationId, path: operation.path.value,
    baseRevision: operation.baseRevision,
    baseBlob: blobDescriptor(paths.baseBlob(operation.operationId), operation.baseText),
    proposedBlob: blobDescriptor(paths.proposedBlob(operation.operationId), operation.proposedText),
  };
  if (operation.kind === "rename") return {
    kind: operation.kind, operationId: operation.operationId, from: operation.from.value, to: operation.to.value,
    baseRevision: operation.baseRevision, targetAbsent: true,
    baseBlob: blobDescriptor(paths.baseBlob(operation.operationId), operation.baseText),
    proposedBlob: blobDescriptor(paths.proposedBlob(operation.operationId), operation.proposedText),
  };
  return {
    kind: operation.kind, operationId: operation.operationId, path: operation.path.value,
    baseRevision: operation.baseRevision,
    baseBlob: blobDescriptor(paths.baseBlob(operation.operationId), operation.baseText),
  };
}

function manifestRecord(generation) {
  const paths = changeSetGenerationPaths(generation.ref);
  return {
    schemaVersion: 1,
    ref: generation.ref,
    ...(generation.parentRef ? { parentRef: generation.parentRef } : {}),
    repositoryIdentity: generation.repositoryIdentity,
    authorityIdentity: generation.authorityIdentity,
    grantDigest: generation.grantDigest,
    idempotencyKey: generation.idempotencyKey,
    createdAt: generation.createdAt,
    stateGeneration: generation.stateGeneration,
    operations: generation.operations.map(operation => serializedOperation(operation, paths)),
    hunks: generation.hunks,
    generationDigest: generation.generationDigest,
    status: generation.status,
  };
}

export function serializeChangeSetGeneration(generation) {
  return canonicalBytes(manifestRecord(generation));
}

export function buildChangeSetGeneration(input) {
  try {
    if (!input || typeof input !== "object") throw new TypeError("Change Set generation input is invalid");
    safeId(input.lineageId, "lineage id");
    if (changeSetGenerationId(input.generationId)?.kind === "invalid-proposal") throw new TypeError("generation id is invalid");
    const parentRef = validateGenerationParent(input.lineageId, input.generationId, input.parentRef);
    const repositoryIdentity = safeIdentity(input.repositoryIdentity, "repository identity");
    const authorityIdentity = safeIdentity(input.authorityIdentity, "authority identity");
    if (!DIGEST_RE.test(input.grantDigest)) throw new TypeError("grant digest is invalid");
    safeId(input.idempotencyKey, "idempotency key");
    if (typeof input.createdAt !== "string" || new Date(input.createdAt).toISOString() !== input.createdAt) {
      throw new TypeError("creation timestamp is invalid");
    }
    if (!CHANGE_SET_GENERATION_ID_RE.test(input.stateGeneration)) throw new TypeError("state generation is invalid");
    if (typeof input.allocateStableChangeId !== "function") throw new TypeError("stable change allocator is invalid");
    const operations = validatedOperations(input.operations);
    const hunks = [];
    for (const operation of operations) {
      if (operation.kind !== "edit") continue;
      for (const hunk of deriveStableHunks({
        operationId: operation.operationId,
        baseText: operation.baseText,
        proposedText: operation.proposedText,
      })) {
        const allocated = input.allocateStableChangeId(hunk.id);
        if (typeof allocated !== "string" || allocated.length === 0) throw new TypeError("stable change id is invalid");
        hunks.push(Object.freeze({ ...hunk, id: allocated }));
      }
    }
    hunks.sort((left, right) => compareUtf8Bytes(left.operationId, right.operationId)
      || left.beforeStart - right.beforeStart || compareUtf8Bytes(left.id, right.id));
    const frozenHunks = Object.freeze(hunks);
    const identity = generationIdentity({ ...input, repositoryIdentity, authorityIdentity }, operations, frozenHunks, parentRef);
    const generation = Object.freeze({
      ...identity,
      ref: Object.freeze(identity.ref),
      ...(parentRef ? { parentRef } : {}),
      generationDigest: digestValue(identity),
      status: "open",
    });
    const paths = changeSetGenerationPaths(generation.ref);
    const outputs = [];
    for (const operation of operations) {
      if (operation.baseText !== undefined) {
        const bytes = Buffer.from(operation.baseText, "utf8");
        outputs.push(Object.freeze({ path: paths.baseBlob(operation.operationId), bytes, sha256: sha256(bytes) }));
      }
      if (operation.proposedText !== undefined) {
        const bytes = Buffer.from(operation.proposedText, "utf8");
        outputs.push(Object.freeze({ path: paths.proposedBlob(operation.operationId), bytes, sha256: sha256(bytes) }));
      }
    }
    const manifestBytes = serializeChangeSetGeneration(generation);
    outputs.push(Object.freeze({ path: paths.manifest, bytes: manifestBytes, sha256: sha256(manifestBytes) }));
    return Object.freeze({ generation, outputs: Object.freeze(outputs) });
  }
  catch (error) {
    return invalid("invalid-generation", error.message);
  }
}

function decodeCanonicalManifest(bytes) {
  const value = Buffer.from(bytes);
  if (value.byteLength > MAX_TEXT_BYTES || value.at(-1) !== 0x0a) throw new TypeError("generation manifest is invalid");
  const text = value.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(value)) throw new TypeError("generation manifest is not UTF-8");
  const parsed = JSON.parse(text.slice(0, -1));
  if (!canonicalBytes(parsed).equals(value)) throw new TypeError("generation manifest is not canonical");
  return parsed;
}

async function readBoundBlob(readBlob, descriptor, expectedPath) {
  if (!descriptor || typeof descriptor !== "object" || descriptor.path !== expectedPath
    || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0 || descriptor.size > MAX_TEXT_BYTES
    || typeof descriptor.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(descriptor.sha256)) {
    throw new TypeError("generation blob descriptor is invalid");
  }
  const value = await readBlob(expectedPath);
  if (!(value instanceof Uint8Array)) throw new TypeError("generation blob is missing");
  const bytes = Buffer.from(value);
  if (bytes.byteLength !== descriptor.size || sha256(bytes) !== descriptor.sha256) throw new TypeError("generation blob digest does not match");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new TypeError("generation text blob is not UTF-8");
  return text;
}

export async function parseChangeSetGeneration({ manifestBytes, readBlob } = {}) {
  try {
    if (!(manifestBytes instanceof Uint8Array) || typeof readBlob !== "function") throw new TypeError("generation parser input is invalid");
    const manifest = decodeCanonicalManifest(manifestBytes);
    if (manifest.schemaVersion !== 1 || manifest.status !== "open" || !Array.isArray(manifest.operations)
      || !Array.isArray(manifest.hunks)) throw new TypeError("generation manifest schema is invalid");
    const ref = validateRef(manifest.ref);
    const paths = changeSetGenerationPaths(ref);
    const operations = [];
    for (const value of manifest.operations) {
      safeId(value.operationId, "operation id");
      if (value.kind === "create") operations.push({
        kind: "create", operationId: value.operationId, path: documentationPagePath(value.path), targetAbsent: value.targetAbsent,
        proposedText: await readBoundBlob(readBlob, value.proposedBlob, paths.proposedBlob(value.operationId)),
      });
      else if (value.kind === "edit") operations.push({
        kind: "edit", operationId: value.operationId, path: documentationPagePath(value.path), baseRevision: value.baseRevision,
        baseText: await readBoundBlob(readBlob, value.baseBlob, paths.baseBlob(value.operationId)),
        proposedText: await readBoundBlob(readBlob, value.proposedBlob, paths.proposedBlob(value.operationId)),
      });
      else if (value.kind === "rename") operations.push({
        kind: "rename", operationId: value.operationId, from: documentationPagePath(value.from), to: documentationPagePath(value.to),
        baseRevision: value.baseRevision, targetAbsent: value.targetAbsent,
        baseText: await readBoundBlob(readBlob, value.baseBlob, paths.baseBlob(value.operationId)),
        proposedText: await readBoundBlob(readBlob, value.proposedBlob, paths.proposedBlob(value.operationId)),
      });
      else if (value.kind === "delete") operations.push({
        kind: "delete", operationId: value.operationId, path: documentationPagePath(value.path), baseRevision: value.baseRevision,
        baseText: await readBoundBlob(readBlob, value.baseBlob, paths.baseBlob(value.operationId)),
      });
      else throw new TypeError("generation operation kind is invalid");
    }
    const rebuilt = buildChangeSetGeneration({
      lineageId: ref.lineageId,
      generationId: ref.generationId,
      ...(manifest.parentRef ? { parentRef: manifest.parentRef } : {}),
      repositoryIdentity: manifest.repositoryIdentity,
      authorityIdentity: manifest.authorityIdentity,
      grantDigest: manifest.grantDigest,
      idempotencyKey: manifest.idempotencyKey,
      createdAt: manifest.createdAt,
      stateGeneration: manifest.stateGeneration,
      operations,
      allocateStableChangeId: value => value,
    });
    if (rebuilt.kind === "invalid-proposal" || rebuilt.generation.generationDigest !== manifest.generationDigest
      || canonicalJson(rebuilt.generation.hunks) !== canonicalJson(manifest.hunks)
      || !serializeChangeSetGeneration(rebuilt.generation).equals(Buffer.from(manifestBytes))) {
      throw new TypeError("generation manifest does not match its bound content");
    }
    return rebuilt.generation;
  }
  catch (error) {
    return invalid("invalid-generation-storage", error.message);
  }
}
