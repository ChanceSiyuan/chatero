const CHANGE_FIELDS = Object.freeze([
  "from",
  "to",
  "insert",
  "deletedText",
  "leftContext",
  "rightContext",
]);
const CHANGE_FIELD_SET = new Set(CHANGE_FIELDS);
const DEFAULT_CONTEXT_UNITS = 16;

function freezeChanges(changes) {
  return Object.freeze(changes.map(change => Object.freeze({ ...change })));
}

function requireText(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
}

function requireOffset(value, label) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} offset must be a finite safe integer`);
}

function isUtf16Boundary(text, offset) {
  if (offset <= 0 || offset >= text.length) return true;
  const left = text.charCodeAt(offset - 1);
  const right = text.charCodeAt(offset);
  return !(left >= 0xD800 && left <= 0xDBFF && right >= 0xDC00 && right <= 0xDFFF);
}

function normalizeCanonicalChanges(changes) {
  if (!Array.isArray(changes)) throw new TypeError("changes must be an array");
  let previousTo = 0;
  return freezeChanges(changes.map((change, index) => {
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      throw new TypeError(`change ${index} must be an object`);
    }
    for (const key of Object.keys(change)) {
      if (!CHANGE_FIELD_SET.has(key)) throw new TypeError(`change ${index} has unknown field ${key}`);
    }
    for (const field of CHANGE_FIELDS) {
      if (!Object.hasOwn(change, field)) throw new TypeError(`change ${index} is missing ${field}`);
    }
    requireOffset(change.from, `change ${index} from`);
    requireOffset(change.to, `change ${index} to`);
    if (change.from < 0 || change.to < change.from) throw new RangeError(`change ${index} has an invalid offset range`);
    if (index > 0 && change.from < previousTo) {
      throw new RangeError("changes must be in ascending, non-overlapping source order");
    }
    for (const field of ["insert", "deletedText", "leftContext", "rightContext"]) {
      requireText(change[field], `change ${index} ${field}`);
    }
    previousTo = change.to;
    return {
      from: change.from,
      to: change.to,
      insert: change.insert,
      deletedText: change.deletedText,
      leftContext: change.leftContext,
      rightContext: change.rightContext,
    };
  }));
}

export function validateOffsetChanges(text, changes) {
  requireText(text, "source text");
  const normalized = normalizeCanonicalChanges(changes);
  for (const [index, change] of normalized.entries()) {
    if (change.to > text.length) throw new RangeError(`change ${index} offset is outside the source text`);
    if (!isUtf16Boundary(text, change.from) || !isUtf16Boundary(text, change.to)) {
      throw new RangeError(`change ${index} offset is not a UTF-16 boundary`);
    }
    if (text.slice(change.from, change.to) !== change.deletedText) {
      throw new Error(`change ${index} deleted text does not match the source`);
    }
  }
  return normalized;
}

function boundedContextStart(text, offset, contextUnits) {
  let start = Math.max(0, offset - contextUnits);
  if (!isUtf16Boundary(text, start)) start += 1;
  return start;
}

function boundedContextEnd(text, offset, contextUnits) {
  let end = Math.min(text.length, offset + contextUnits);
  if (!isUtf16Boundary(text, end)) end -= 1;
  return end;
}

export function withChangeContext(text, changes, contextUnits = DEFAULT_CONTEXT_UNITS) {
  requireText(text, "source text");
  if (!Number.isSafeInteger(contextUnits) || contextUnits < 0) {
    throw new RangeError("contextUnits must be a non-negative safe integer");
  }
  if (!Array.isArray(changes)) throw new TypeError("changes must be an array");
  const contextual = changes.map((change, index) => {
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      throw new TypeError(`change ${index} must be an object`);
    }
    requireOffset(change.from, `change ${index} from`);
    requireOffset(change.to, `change ${index} to`);
    requireText(change.insert, `change ${index} insert`);
    if (change.from < 0 || change.to < change.from || change.to > text.length) {
      throw new RangeError(`change ${index} has an invalid offset range`);
    }
    if (!isUtf16Boundary(text, change.from) || !isUtf16Boundary(text, change.to)) {
      throw new RangeError(`change ${index} offset is not a UTF-16 boundary`);
    }
    return {
      from: change.from,
      to: change.to,
      insert: change.insert,
      deletedText: text.slice(change.from, change.to),
      leftContext: text.slice(boundedContextStart(text, change.from, contextUnits), change.from),
      rightContext: text.slice(change.to, boundedContextEnd(text, change.to, contextUnits)),
    };
  });
  return validateOffsetChanges(text, contextual);
}

export function applyOffsetChanges(text, changes) {
  const valid = validateOffsetChanges(text, changes);
  let result = text;
  for (const change of [...valid].reverse()) {
    result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  }
  return result;
}

export function toWorkspaceTextEdits(document, changes, Range) {
  if (!document || typeof document.getText !== "function" || typeof document.positionAt !== "function") {
    throw new TypeError("document must expose getText() and positionAt()");
  }
  if (typeof Range !== "function") throw new TypeError("Range must be a constructor");
  return Object.freeze(validateOffsetChanges(document.getText(), changes).map(change => Object.freeze({
    range: new Range(document.positionAt(change.from), document.positionAt(change.to)),
    newText: change.insert,
  })));
}

export function canonicalOffsetChangesBytes(changes) {
  const normalized = normalizeCanonicalChanges(changes);
  return new TextEncoder().encode(JSON.stringify(normalized.map(change => [
    change.from,
    change.to,
    change.insert,
    change.deletedText,
    change.leftContext,
    change.rightContext,
  ])));
}

export async function sha256Hex(bytes, subtle = globalThis.crypto?.subtle) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("SHA-256 input must be a Uint8Array");
  if (!subtle || typeof subtle.digest !== "function") throw new Error("SubtleCrypto SHA-256 is unavailable");
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function digestOffsetChanges(changes, subtle) {
  return sha256Hex(canonicalOffsetChangesBytes(changes), subtle);
}

export function digestSourceText(text, subtle) {
  requireText(text, "source text");
  return sha256Hex(new TextEncoder().encode(text), subtle);
}
