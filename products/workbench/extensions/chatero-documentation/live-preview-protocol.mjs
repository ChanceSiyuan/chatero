import { digestOffsetChanges } from "./text-change-set.mjs";

export const MAX_OPERATION_ID_UTF8 = 128;
export const MAX_CHANGE_COUNT = 256;
export const MAX_CHANGE_TEXT_FIELD_UTF8 = 4 * 1024 * 1024;
export const MAX_CHANGE_CONTEXT_FIELD_UTF8 = 256;
export const MAX_EDIT_FRAME_UTF8 = 12 * 1024 * 1024;
export const MAX_SNAPSHOT_SOURCE_UTF8 = 16 * 1024 * 1024;
export const MAX_PENDING_REASSOCIATION_UTF8 = 12 * 1024 * 1024;
export const MAX_HOST_FRAME_UTF8 = 32 * 1024 * 1024;
export const MAX_PERSISTED_PENDING_OPERATIONS = 64;
export const MAX_PERSISTED_CHANGE_SHAPES = 256;
export const MAX_PERSISTED_STATE_UTF8 = 32 * 1024;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const SESSION_PATTERN = /^[A-Za-z0-9_-]+$/;
const CHANGE_KEYS = Object.freeze(["from", "to", "insert", "deletedText", "leftContext", "rightContext"]);
const SHAPE_KEYS = Object.freeze(["from", "to", "insertedUtf8Bytes", "deletedUtf8Bytes"]);
const DESCRIPTOR_KEYS = Object.freeze(["opId", "baseVersion", "changeDigest", "shape"]);
const OPERATION_KEYS = Object.freeze(["opId", "baseVersion", "changes"]);

export const VIEW_KEYS = Object.freeze({
  ready: Object.freeze(["type", "sessionId", "pendingDescriptors"]),
  edit: Object.freeze(["type", "sessionId", "opId", "baseVersion", "changes"]),
  history: Object.freeze(["type", "sessionId", "direction"]),
  focus: Object.freeze(["type", "sessionId", "anchor", "head"]),
  imageRequest: Object.freeze(["type", "sessionId", "requestId", "target"]),
});

export const HOST_KEYS = Object.freeze({
  initialize: Object.freeze(["type", "sessionId", "source", "version", "digest", "cspNonce", "reassociatedPendingOperations"]),
  documentChanged: Object.freeze(["type", "sessionId", "beforeVersion", "afterVersion", "changes", "digest"]),
  operationAcknowledged: Object.freeze(["type", "sessionId", "opId", "afterVersion", "digest"]),
  resync: Object.freeze(["type", "sessionId", "source", "version", "digest", "reason"]),
  pendingConflict: Object.freeze(["type", "sessionId", "opId", "reason", "authoritativeExcerpt", "pendingInsert"]),
  connectionState: Object.freeze(["type", "sessionId", "state"]),
  imageResult: Object.freeze(["type", "sessionId", "requestId", "resolution"]),
});

const RESYNC_REASONS = new Set([
  "version-conflict",
  "apply-failed",
  "external-change",
  "reassociation-mismatch",
  "event-mismatch",
  "connection-restored",
]);
const CONFLICT_REASONS = new Set(["overlap", "ambiguous-anchor", "missing-anchor"]);
const CONNECTION_STATES = new Set(["connected", "disconnected", "reconnecting"]);
const IMAGE_PLACEHOLDER_REASONS = new Set(["missing", "unsafe", "too-large", "mime-mismatch", "unsupported-type", "unavailable"]);
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const textEncoder = new TextEncoder();

function utf8Length(value) {
  return textEncoder.encode(value).byteLength;
}

function exactObject(value, allowedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unknown field ${key}`);
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing field ${key}`);
  }
}

function boundedString(value, label, maximum) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (utf8Length(value) > maximum) throw new RangeError(`${label} exceeds ${maximum === MAX_CHANGE_TEXT_FIELD_UTF8 ? "4 MiB" : `${maximum} UTF-8 bytes`}`);
  return value;
}

function safeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new TypeError(`${label} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  return value;
}

function digest(value, label = "digest") {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new TypeError(`${label} must be 64 lowercase hexadecimal characters`);
  return value;
}

function sessionId(value) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("sessionId must be a non-empty string");
  if (utf8Length(value) > MAX_OPERATION_ID_UTF8) throw new RangeError("sessionId exceeds 128 UTF-8 bytes");
  if (!SESSION_PATTERN.test(value)) throw new TypeError("sessionId must use base64url-safe characters and contain no colon");
  return value;
}

function operationId(value, expectedSession) {
  if (typeof value !== "string" || value.length === 0 || utf8Length(value) > MAX_OPERATION_ID_UTF8) {
    throw new TypeError("operation ID must be a non-empty string of at most 128 UTF-8 bytes");
  }
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) throw new TypeError("operation ID is malformed");
  const owner = value.slice(0, separator);
  const sequenceText = value.slice(separator + 1);
  sessionId(owner);
  if (expectedSession !== undefined && owner !== expectedSession) throw new TypeError("operation ID belongs to a foreign session");
  if (!/^[1-9][0-9]*$/.test(sequenceText) || !Number.isSafeInteger(Number(sequenceText))) {
    throw new TypeError("operation ID sequence is malformed");
  }
  return Object.freeze({ value, sessionId: owner, sequence: Number(sequenceText) });
}

function imageRequestId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new TypeError("image request ID is invalid");
  return value;
}

function imageResolution(value) {
  if (value?.kind === "placeholder") {
    exactObject(value, ["kind", "target", "reason"], "image placeholder");
    if (!IMAGE_PLACEHOLDER_REASONS.has(value.reason)) throw new TypeError("image placeholder reason is unsupported");
    const target = boundedString(value.target, "image target", 4096);
    if (!target) throw new TypeError("image target is empty");
    return Object.freeze({
      kind: "placeholder",
      target,
      reason: value.reason,
    });
  }
  exactObject(value, ["kind", "target", "src", "mime", "size", "revision"], "image resolution");
  if (value.kind !== "ready" || !IMAGE_MIME.has(value.mime) || !/^sha256:[0-9a-f]{64}$/u.test(value.revision)) {
    throw new TypeError("image resolution metadata is invalid");
  }
  const src = boundedString(value.src, "derived image URI", 16 * 1024);
  let parsed;
  try { parsed = new URL(src); }
  catch { throw new TypeError("derived image URI is invalid"); }
  const vscodeHttps = parsed.protocol.length === 6
    && parsed.protocol.slice(0, 5) === "https"
    && parsed.hostname.endsWith(".vscode-cdn.net");
  if (!vscodeHttps && parsed.protocol !== "vscode-webview-resource:" && parsed.protocol !== "chatero-test-webview:") {
    throw new TypeError("derived image URI authority is unsupported");
  }
  const target = boundedString(value.target, "image target", 4096);
  const size = safeInteger(value.size, "image size");
  if (!target || size > 20 * 1024 * 1024) throw new TypeError("image resolution exceeds the fixed policy");
  return Object.freeze({
    kind: "ready",
    target,
    src,
    mime: value.mime,
    size,
    revision: value.revision,
  });
}

function serializedBytes(value, label, maximum) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  }
  catch (error) {
    throw new TypeError(`${label} must be finite JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (serialized === undefined) throw new TypeError(`${label} must be finite JSON`);
  const bytes = utf8Length(serialized);
  if (bytes > maximum) {
    const display = maximum === MAX_EDIT_FRAME_UTF8
      ? "12 MiB"
      : maximum === MAX_HOST_FRAME_UTF8
        ? "32 MiB"
        : maximum === MAX_PENDING_REASSOCIATION_UTF8
          ? "12 MiB"
          : maximum === MAX_PERSISTED_STATE_UTF8
            ? "32 KiB"
            : `${maximum} UTF-8 bytes`;
    throw new RangeError(`${label} exceeds ${display}`);
  }
  return bytes;
}

function parseChanges(value, label = "changes") {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  if (value.length > MAX_CHANGE_COUNT) throw new RangeError(`${label} exceeds 256 changes`);
  let previousTo = 0;
  const changes = value.map((change, index) => {
    exactObject(change, CHANGE_KEYS, `${label}[${index}]`);
    const from = safeInteger(change.from, `${label}[${index}] from offset`);
    const to = safeInteger(change.to, `${label}[${index}] to offset`);
    if (to < from) throw new RangeError(`${label}[${index}] has an inverted offset range`);
    if (index > 0 && from < previousTo) throw new RangeError(`${label} must be ascending and non-overlapping`);
    previousTo = to;
    return Object.freeze({
      from,
      to,
      insert: boundedString(change.insert, `${label}[${index}] insert`, MAX_CHANGE_TEXT_FIELD_UTF8),
      deletedText: boundedString(change.deletedText, `${label}[${index}] deletedText`, MAX_CHANGE_TEXT_FIELD_UTF8),
      leftContext: boundedString(change.leftContext, `${label}[${index}] left context`, MAX_CHANGE_CONTEXT_FIELD_UTF8),
      rightContext: boundedString(change.rightContext, `${label}[${index}] right context`, MAX_CHANGE_CONTEXT_FIELD_UTF8),
    });
  });
  return Object.freeze(changes);
}

function parseShape(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  if (value.length > MAX_CHANGE_COUNT) throw new RangeError(`${label} exceeds 256 change shapes`);
  let previousTo = 0;
  return Object.freeze(value.map((shape, index) => {
    exactObject(shape, SHAPE_KEYS, `${label}[${index}]`);
    const from = safeInteger(shape.from, `${label}[${index}] from offset`);
    const to = safeInteger(shape.to, `${label}[${index}] to offset`);
    if (to < from) throw new RangeError(`${label}[${index}] has an inverted offset range`);
    if (index > 0 && from < previousTo) throw new RangeError(`${label} must be ascending and non-overlapping`);
    previousTo = to;
    const insertedUtf8Bytes = safeInteger(shape.insertedUtf8Bytes, `${label}[${index}] insertedUtf8Bytes`);
    const deletedUtf8Bytes = safeInteger(shape.deletedUtf8Bytes, `${label}[${index}] deletedUtf8Bytes`);
    if (insertedUtf8Bytes > MAX_CHANGE_TEXT_FIELD_UTF8 || deletedUtf8Bytes > MAX_CHANGE_TEXT_FIELD_UTF8) {
      throw new RangeError(`${label}[${index}] text byte count exceeds 4 MiB`);
    }
    return Object.freeze({ from, to, insertedUtf8Bytes, deletedUtf8Bytes });
  }));
}

function parseDescriptor(value, expectedSession, label = "pending descriptor") {
  exactObject(value, DESCRIPTOR_KEYS, label);
  const parsedId = operationId(value.opId, expectedSession);
  return Object.freeze({
    opId: parsedId.value,
    baseVersion: safeInteger(value.baseVersion, `${label} baseVersion`),
    changeDigest: digest(value.changeDigest, `${label} changeDigest`),
    shape: parseShape(value.shape, `${label} shape`),
  });
}

function parseDescriptors(value, expectedSession, label = "pendingDescriptors") {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > MAX_PERSISTED_PENDING_OPERATIONS) throw new RangeError(`${label} exceeds 64 descriptors`);
  const seen = new Set();
  let shapes = 0;
  const descriptors = value.map((item, index) => {
    const parsed = parseDescriptor(item, expectedSession, `${label}[${index}]`);
    if (seen.has(parsed.opId)) throw new TypeError(`${label} contains a duplicate operation ID`);
    seen.add(parsed.opId);
    shapes += parsed.shape.length;
    return parsed;
  });
  if (shapes > MAX_PERSISTED_CHANGE_SHAPES) throw new RangeError(`${label} exceeds 256 change shapes`);
  return Object.freeze(descriptors);
}

function parsePendingOperation(value, expectedSession, label = "pending operation") {
  exactObject(value, OPERATION_KEYS, label);
  const parsedId = operationId(value.opId, expectedSession);
  return Object.freeze({
    opId: parsedId.value,
    baseVersion: safeInteger(value.baseVersion, `${label} baseVersion`),
    changes: parseChanges(value.changes, `${label} changes`),
  });
}

function parsePendingOperations(value, expectedSession) {
  if (!Array.isArray(value)) throw new TypeError("reassociatedPendingOperations must be an array");
  if (value.length > MAX_PERSISTED_PENDING_OPERATIONS) throw new RangeError("reassociatedPendingOperations exceeds 64 operations");
  serializedBytes(value, "aggregate pending reassociation bodies", MAX_PENDING_REASSOCIATION_UTF8);
  const seen = new Set();
  const operations = value.map((item, index) => {
    const parsed = parsePendingOperation(item, expectedSession, `reassociatedPendingOperations[${index}]`);
    if (seen.has(parsed.opId)) throw new TypeError("reassociatedPendingOperations contains a duplicate operation ID");
    seen.add(parsed.opId);
    return parsed;
  });
  return Object.freeze(operations);
}

export function createOperationId(owner, sequence) {
  const validSession = sessionId(owner);
  safeInteger(sequence, "operation sequence", { positive: true });
  const value = `${validSession}:${sequence}`;
  if (utf8Length(value) > MAX_OPERATION_ID_UTF8) throw new RangeError("operation ID exceeds 128 UTF-8 bytes");
  return value;
}

export async function createPendingDescriptor(operation, subtle) {
  if (!operation || typeof operation !== "object" || typeof operation.opId !== "string") {
    throw new TypeError("pending operation is malformed");
  }
  const parsedId = operationId(operation.opId);
  const parsed = parsePendingOperation(operation, parsedId.sessionId);
  const descriptor = {
    opId: parsed.opId,
    baseVersion: parsed.baseVersion,
    changeDigest: await digestOffsetChanges(parsed.changes, subtle),
    shape: parsed.changes.map(change => ({
      from: change.from,
      to: change.to,
      insertedUtf8Bytes: utf8Length(change.insert),
      deletedUtf8Bytes: utf8Length(change.deletedText),
    })),
  };
  return parseDescriptor(descriptor, parsedId.sessionId);
}

export function parsePersistedState(value) {
  exactObject(value, ["sessionId", "nextSequence", "pendingDescriptors"], "persisted Live Preview state");
  serializedBytes(value, "persisted Live Preview state", MAX_PERSISTED_STATE_UTF8);
  const owner = sessionId(value.sessionId);
  const nextSequence = safeInteger(value.nextSequence, "nextSequence", { positive: true });
  const pendingDescriptors = parseDescriptors(value.pendingDescriptors, owner);
  for (const descriptorValue of pendingDescriptors) {
    if (operationId(descriptorValue.opId, owner).sequence >= nextSequence) {
      throw new TypeError("pending descriptor operation sequence must precede nextSequence");
    }
  }
  return Object.freeze({ sessionId: owner, nextSequence, pendingDescriptors });
}

export function parseViewMessage(value) {
  serializedBytes(value, "view message", MAX_HOST_FRAME_UTF8);
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") {
    throw new TypeError("view message must be an object with a message type");
  }
  const keys = VIEW_KEYS[value.type];
  if (!keys) throw new TypeError(`unsupported view message type ${value.type}`);
  exactObject(value, keys, `${value.type} view message`);
  const owner = sessionId(value.sessionId);
  if (value.type === "ready") {
    return Object.freeze({ type: "ready", sessionId: owner, pendingDescriptors: parseDescriptors(value.pendingDescriptors, owner) });
  }
  if (value.type === "edit") {
    serializedBytes(value, "edit frame", MAX_EDIT_FRAME_UTF8);
    const id = operationId(value.opId, owner).value;
    return Object.freeze({
      type: "edit",
      sessionId: owner,
      opId: id,
      baseVersion: safeInteger(value.baseVersion, "edit baseVersion"),
      changes: parseChanges(value.changes, "edit changes"),
    });
  }
  if (value.type === "history") {
    if (value.direction !== "undo" && value.direction !== "redo") throw new TypeError("history direction must be undo or redo");
    return Object.freeze({ type: "history", sessionId: owner, direction: value.direction });
  }
  if (value.type === "imageRequest") {
    const target = boundedString(value.target, "image target", 4096);
    if (!target) throw new TypeError("image target is empty");
    return Object.freeze({
      type: "imageRequest",
      sessionId: owner,
      requestId: imageRequestId(value.requestId),
      target,
    });
  }
  return Object.freeze({
    type: "focus",
    sessionId: owner,
    anchor: safeInteger(value.anchor, "focus anchor offset"),
    head: safeInteger(value.head, "focus head offset"),
  });
}

export function parseHostMessage(value) {
  serializedBytes(value, "host frame", MAX_HOST_FRAME_UTF8);
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") {
    throw new TypeError("host message must be an object with a message type");
  }
  const keys = HOST_KEYS[value.type];
  if (!keys) throw new TypeError(`unsupported host message type ${value.type}`);
  exactObject(value, keys, `${value.type} host message`);
  const owner = sessionId(value.sessionId);
  if (value.type === "initialize") {
    const source = boundedString(value.source, "initialize source", MAX_SNAPSHOT_SOURCE_UTF8);
    if (!NONCE_PATTERN.test(value.cspNonce)) throw new TypeError("initialize CSP nonce must be exactly 24 base64url characters");
    return Object.freeze({
      type: "initialize",
      sessionId: owner,
      source,
      version: safeInteger(value.version, "initialize version"),
      digest: digest(value.digest),
      cspNonce: value.cspNonce,
      reassociatedPendingOperations: parsePendingOperations(value.reassociatedPendingOperations, owner),
    });
  }
  if (value.type === "documentChanged") {
    const beforeVersion = safeInteger(value.beforeVersion, "documentChanged beforeVersion");
    const afterVersion = safeInteger(value.afterVersion, "documentChanged afterVersion");
    if (afterVersion !== beforeVersion + 1) throw new TypeError("documentChanged versions must be consecutive");
    return Object.freeze({
      type: "documentChanged",
      sessionId: owner,
      beforeVersion,
      afterVersion,
      changes: parseChanges(value.changes, "documentChanged changes"),
      digest: digest(value.digest),
    });
  }
  if (value.type === "operationAcknowledged") {
    return Object.freeze({
      type: "operationAcknowledged",
      sessionId: owner,
      opId: operationId(value.opId, owner).value,
      afterVersion: safeInteger(value.afterVersion, "operationAcknowledged afterVersion"),
      digest: digest(value.digest),
    });
  }
  if (value.type === "resync") {
    if (!RESYNC_REASONS.has(value.reason)) throw new TypeError("resync reason is unsupported");
    return Object.freeze({
      type: "resync",
      sessionId: owner,
      source: boundedString(value.source, "resync source", MAX_SNAPSHOT_SOURCE_UTF8),
      version: safeInteger(value.version, "resync version"),
      digest: digest(value.digest),
      reason: value.reason,
    });
  }
  if (value.type === "pendingConflict") {
    if (!CONFLICT_REASONS.has(value.reason)) throw new TypeError("pendingConflict reason is unsupported");
    return Object.freeze({
      type: "pendingConflict",
      sessionId: owner,
      opId: operationId(value.opId, owner).value,
      reason: value.reason,
      authoritativeExcerpt: boundedString(value.authoritativeExcerpt, "pendingConflict authoritative excerpt", MAX_CHANGE_TEXT_FIELD_UTF8),
      pendingInsert: boundedString(value.pendingInsert, "pendingConflict pending insert", MAX_CHANGE_TEXT_FIELD_UTF8),
    });
  }
  if (value.type === "imageResult") {
    return Object.freeze({
      type: "imageResult",
      sessionId: owner,
      requestId: imageRequestId(value.requestId),
      resolution: imageResolution(value.resolution),
    });
  }
  if (!CONNECTION_STATES.has(value.state)) throw new TypeError("connectionState state is unsupported");
  return Object.freeze({ type: "connectionState", sessionId: owner, state: value.state });
}
