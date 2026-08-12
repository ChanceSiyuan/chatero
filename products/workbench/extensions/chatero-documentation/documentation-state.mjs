import { documentationPagePath, validateOperationPathSet } from "./documentation-path.mjs";

const STATE_PATH = ".chatero/documentation-state.v1.json";
const GENERATION_RE = /^[0-9a-f]{16}$/u;
const STATES = new Set(["working", "reviewed"]);
const MAX_STATE_BYTES = 4 * 1024 * 1024;

export function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
    throw new TypeError(`${label} has an invalid schema`);
  }
  return value;
}

function assertGeneration(value) {
  if (typeof value !== "string" || !GENERATION_RE.test(value)) {
    throw new TypeError("state generation must be 16 lowercase hexadecimal characters");
  }
  return value;
}

function validateState(value) {
  exactObject(value, ["schemaVersion", "generation", "documents"], "Documentation state");
  if (value.schemaVersion !== 1) throw new TypeError("Documentation state schema is unsupported");
  const generation = assertGeneration(value.generation);
  if (!value.documents || typeof value.documents !== "object" || Array.isArray(value.documents)) {
    throw new TypeError("Documentation state documents must be an object");
  }
  const documents = {};
  const aliases = new Set();
  for (const [path, entry] of Object.entries(value.documents)) {
    const normalized = documentationPagePath(path);
    if (normalized.value !== path) throw new TypeError("Documentation state path is not normalized");
    const folded = path.toLowerCase();
    if (aliases.has(folded)) throw new TypeError("Documentation state contains a case-fold alias");
    aliases.add(folded);
    exactObject(entry, ["state"], `Documentation state entry ${path}`);
    if (!STATES.has(entry.state)) throw new TypeError(`Documentation state entry ${path} has an invalid state`);
    documents[path] = Object.freeze({ state: entry.state });
  }
  return Object.freeze({
    schemaVersion: 1,
    generation,
    documents: Object.freeze(documents),
  });
}

function diagnostic(code, path, message) {
  return Object.freeze({ code, path, message });
}

function invalidState(message) {
  return Object.freeze({
    kind: "invalid",
    diagnostic: diagnostic("documentation-state-invalid", STATE_PATH, message),
  });
}

export function serializeDocumentationState(state) {
  const validated = validateState(state);
  const documents = Object.fromEntries(
    Object.entries(validated.documents).sort(([left], [right]) => compareUtf8Bytes(left, right)),
  );
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    generation: validated.generation,
    documents,
  })}\n`, "utf8");
}

export function parseDocumentationState(bytes) {
  if (bytes === null || bytes === undefined) {
    return Object.freeze({
      kind: "missing",
      diagnostic: diagnostic(
        "documentation-state-missing",
        STATE_PATH,
        "Documentation state file is missing; all pages default to working.",
      ),
    });
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_STATE_BYTES) {
    return invalidState("Documentation state is not a bounded UTF-8 byte snapshot.");
  }
  try {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = buffer.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buffer) || !text.endsWith("\n") || text.endsWith("\n\n")) {
      throw new TypeError("Documentation state is not canonical UTF-8 JSON");
    }
    const state = validateState(JSON.parse(text.slice(0, -1)));
    if (!serializeDocumentationState(state).equals(buffer)) {
      throw new TypeError("Documentation state keys or JSON encoding are not canonical");
    }
    return Object.freeze({ kind: "valid", state });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : "Documentation state is invalid";
    return invalidState(message);
  }
}

function workingDocuments(pages) {
  return Object.fromEntries(pages.map(path => [path.value, Object.freeze({ state: "working" })]));
}

export function projectDocumentationState({ pages, parsed }) {
  if (!Array.isArray(pages)) throw new TypeError("Documentation pages must be an array");
  validateOperationPathSet(pages.map(path => ({ kind: "edit", path })));
  const sortedPages = [...pages].sort((left, right) => compareUtf8Bytes(left.value, right.value));
  if (!parsed || parsed.kind !== "valid") {
    const fallback = parsed?.diagnostic ?? diagnostic(
      "documentation-state-invalid",
      STATE_PATH,
      "Documentation state snapshot is unavailable; all pages default to working.",
    );
    return Object.freeze({
      schemaVersion: 1,
      generation: "0000000000000000",
      documents: Object.freeze(workingDocuments(sortedPages)),
      diagnostics: Object.freeze([fallback]),
    });
  }

  const current = new Set(sortedPages.map(path => path.value));
  const entries = [];
  for (const path of sortedPages) {
    entries.push([
      path.value,
      parsed.state.documents[path.value] ?? Object.freeze({ state: "working" }),
    ]);
  }
  const diagnostics = [];
  for (const [path, entry] of Object.entries(parsed.state.documents)) {
    if (current.has(path)) continue;
    entries.push([path, Object.freeze({ state: entry.state, orphan: true })]);
    diagnostics.push(diagnostic(
      "documentation-state-orphan",
      path,
      "State entry has no current Documentation page.",
    ));
  }
  entries.sort(([left], [right]) => compareUtf8Bytes(left, right));
  diagnostics.sort((left, right) => compareUtf8Bytes(left.path, right.path));
  return Object.freeze({
    schemaVersion: 1,
    generation: parsed.state.generation,
    documents: Object.freeze(Object.fromEntries(entries)),
    diagnostics: Object.freeze(diagnostics),
  });
}

export function nextStateGeneration(value) {
  const next = BigInt(`0x${assertGeneration(value)}`) + 1n;
  if (next > 0xffffffffffffffffn) throw new RangeError("state generation overflow");
  return next.toString(16).padStart(16, "0");
}
