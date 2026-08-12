import {
  applyOffsetChanges,
  canonicalOffsetChangesBytes,
  withChangeContext,
} from "./text-change-set.mjs";

const MAX_PENDING_OPERATIONS = 64;

const mapped = (from, to) => Object.freeze({ kind: "mapped", from, to });
const unmapped = kind => Object.freeze({ kind });

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unknown field ${key}; a full pending operation with changes is required`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is not a full pending operation with changes`);
  }
}

function occurrences(text, needle) {
  if (needle.length === 0) return [];
  const found = [];
  let offset = 0;
  while (offset <= text.length - needle.length) {
    const index = text.indexOf(needle, offset);
    if (index < 0) break;
    found.push(index);
    offset = index + 1;
  }
  return found;
}

function contextMatches(text, from, to, change) {
  return text.slice(Math.max(0, from - change.leftContext.length), from) === change.leftContext
    && text.slice(to, to + change.rightContext.length) === change.rightContext;
}

function locateChangedRegion(text, change) {
  if (!change.leftContext || !change.rightContext) return undefined;
  const leftEnds = occurrences(text, change.leftContext).map(index => index + change.leftContext.length);
  const rightStarts = occurrences(text, change.rightContext);
  if (leftEnds.length > 1 || rightStarts.length > 1) return unmapped("ambiguous-anchor");
  if (leftEnds.length === 1 && rightStarts.length === 1 && leftEnds[0] <= rightStarts[0]) {
    return Object.freeze({ kind: "overlap", from: leftEnds[0], to: rightStarts[0] });
  }
  return undefined;
}

function locateInsertion(text, change) {
  const positions = [];
  if (change.leftContext) {
    positions.push(...occurrences(text, change.leftContext).map(index => index + change.leftContext.length));
  }
  if (change.rightContext) positions.push(...occurrences(text, change.rightContext));
  const unique = [...new Set(positions)];
  if (unique.length === 1) return mapped(unique[0], unique[0]);
  if (unique.length > 1) return unmapped("ambiguous-anchor");
  return unmapped("missing-anchor");
}

function locateChange(text, change) {
  if (change.to <= text.length
    && text.slice(change.from, change.to) === change.deletedText
    && contextMatches(text, change.from, change.to, change)) {
    return mapped(change.from, change.to);
  }

  const needle = change.leftContext + change.deletedText + change.rightContext;
  if (needle.length > 0) {
    const matches = occurrences(text, needle);
    if (matches.length > 1) return unmapped("ambiguous-anchor");
    if (matches.length === 1) {
      const from = matches[0] + change.leftContext.length;
      return mapped(from, from + change.deletedText.length);
    }
  }

  if (change.deletedText.length === 0) return locateInsertion(text, change);
  const deletedMatches = occurrences(text, change.deletedText);
  const anchored = deletedMatches.filter(from => {
    const to = from + change.deletedText.length;
    const leftMatches = change.leftContext.length > 0
      ? text.slice(Math.max(0, from - change.leftContext.length), from) === change.leftContext
      : change.from === 0 && from === 0;
    const rightMatches = change.rightContext.length > 0
      ? text.slice(to, to + change.rightContext.length) === change.rightContext
      : to === text.length;
    return leftMatches || rightMatches;
  });
  if (anchored.length === 1) return mapped(anchored[0], anchored[0] + change.deletedText.length);
  if (anchored.length > 1 || deletedMatches.length > 1) return unmapped("ambiguous-anchor");

  if (change.to <= text.length) {
    const leftMatches = text.slice(Math.max(0, change.from - change.leftContext.length), change.from) === change.leftContext;
    const rightMatches = text.slice(change.to, change.to + change.rightContext.length) === change.rightContext;
    if (leftMatches && rightMatches && text.slice(change.from, change.to) !== change.deletedText) {
      return Object.freeze({ kind: "overlap", from: change.from, to: change.to });
    }
  }
  return locateChangedRegion(text, change) ?? unmapped("missing-anchor");
}

function authoritativeExcerpt(text, location, change) {
  const center = location.from ?? Math.min(change.from, text.length);
  let start = Math.max(0, center - 128);
  let end = Math.min(text.length, Math.max(location.to ?? center, center) + 128);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start += 1;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

function normalizeOperations(pendingOperations) {
  if (!Array.isArray(pendingOperations)) throw new TypeError("pendingOperations must be an array");
  if (pendingOperations.length > MAX_PENDING_OPERATIONS) throw new RangeError("pendingOperations exceeds 64 operations");
  const seen = new Set();
  return Object.freeze(pendingOperations.map((operation, index) => {
    exactObject(operation, ["opId", "baseVersion", "changes"], `pendingOperations[${index}]`);
    if (typeof operation.opId !== "string" || operation.opId.length === 0) throw new TypeError(`pendingOperations[${index}] opId must be a string`);
    if (seen.has(operation.opId)) throw new TypeError("pendingOperations contains a duplicate operation ID");
    seen.add(operation.opId);
    if (!Number.isSafeInteger(operation.baseVersion) || operation.baseVersion < 0) {
      throw new TypeError(`pendingOperations[${index}] baseVersion must be a non-negative safe integer`);
    }
    canonicalOffsetChangesBytes(operation.changes);
    return Object.freeze({
      opId: operation.opId,
      baseVersion: operation.baseVersion,
      changes: Object.freeze(operation.changes.map(change => Object.freeze({ ...change }))),
    });
  }));
}

function createConflict(operation, change, location, text) {
  const reason = location.kind === "overlap" ? "overlap" : location.kind;
  return Object.freeze({
    opId: operation.opId,
    reason,
    authoritativeExcerpt: authoritativeExcerpt(text, location, change),
    deletedSource: change.deletedText,
    pendingInsert: change.insert,
    leftContext: change.leftContext,
    rightContext: change.rightContext,
    pendingOperation: operation,
  });
}

export function rebasePendingOperations({ authoritativeText, authoritativeVersion, pendingOperations }) {
  if (typeof authoritativeText !== "string") throw new TypeError("authoritativeText must be a string");
  if (!Number.isSafeInteger(authoritativeVersion) || authoritativeVersion < 0) {
    throw new TypeError("authoritativeVersion must be a non-negative safe integer");
  }
  const operations = normalizeOperations(pendingOperations);
  const replayable = [];
  const conflicts = [];
  let workingText = authoritativeText;

  for (const operation of operations) {
    const locations = [];
    let failed;
    for (const change of operation.changes) {
      const location = locateChange(workingText, change);
      if (location.kind !== "mapped") {
        failed = { change, location };
        break;
      }
      locations.push(location);
    }
    if (failed) {
      conflicts.push(createConflict(operation, failed.change, failed.location, workingText));
      continue;
    }
    const rawChanges = locations.map((location, index) => ({
      from: location.from,
      to: location.to,
      insert: operation.changes[index].insert,
    }));
    let mappedChanges;
    try {
      mappedChanges = withChangeContext(workingText, rawChanges);
    }
    catch {
      const change = operation.changes[0];
      conflicts.push(createConflict(operation, change, unmapped("ambiguous-anchor"), workingText));
      continue;
    }
    workingText = applyOffsetChanges(workingText, mappedChanges);
    replayable.push(Object.freeze({ opId: operation.opId, changes: mappedChanges }));
  }

  return Object.freeze({
    replayable: Object.freeze(replayable),
    conflicts: Object.freeze(conflicts),
  });
}

export function formatPendingConflict(conflict) {
  if (!conflict || typeof conflict !== "object" || !["overlap", "ambiguous-anchor", "missing-anchor"].includes(conflict.reason)) {
    throw new TypeError("PendingConflict is invalid");
  }
  return [
    `Pending Live Preview operation: ${conflict.opId}`,
    `Reason: ${conflict.reason}`,
    "",
    "Authoritative TextDocument source",
    "---------------------------------",
    conflict.authoritativeExcerpt,
    "",
    "Unacknowledged Live Preview change",
    "------------------------------------",
    `Delete: ${conflict.deletedSource}`,
    `Insert: ${conflict.pendingInsert}`,
    `Left context: ${conflict.leftContext}`,
    `Right context: ${conflict.rightContext}`,
  ].join("\n");
}
