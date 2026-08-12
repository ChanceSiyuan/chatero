import { createHash } from "node:crypto";

const MAX_DECODED_BYTES = 96 * 1024 * 1024;
const MAX_ENCODED_BYTES = 128 * 1024 * 1024;
const MAX_DEPTH = 128;
const MAX_PATHS = 50_000;
const DIGEST_RE = /^[0-9a-f]{64}$/u;
const REVISION_RE = /^sha256:([0-9a-f]{64})$/u;
const OPEN_REVISION_RE = /^text-document:(0|[1-9][0-9]*):sha256:([0-9a-f]{64})$/u;

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactObject(value, required, optional, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unknown field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing field ${key}`);
  }
  return value;
}

function boundedString(value, label, maximumBytes = 128) {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function safeInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function validateWorkspaceUri(value, label = "workspace URI") {
  boundedString(value, label, 16 * 1024);
  let parsed;
  try {
    parsed = new URL(value);
  }
  catch {
    throw new TypeError(`${label} is invalid`);
  }
  if (!new Set(["file:", "vscode-remote:"]).has(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || !parsed.pathname.startsWith("/")
    || (parsed.protocol === "file:" && parsed.host)
    || (parsed.protocol === "vscode-remote:" && !parsed.host)) {
    throw new TypeError(`${label} is invalid`);
  }
  return parsed;
}

function validateRelativePath(value, label = "authority path") {
  boundedString(value, label, 4096);
  if (value.startsWith("/") || /[\\%:?#]/u.test(value)) throw new TypeError(`${label} is unsafe`);
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")
    || parts.map(part => part.normalize("NFC")).join("/") !== value) {
    throw new TypeError(`${label} is unsafe`);
  }
  return value;
}

function assertBase64url(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)
    || !/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new TypeError(`${label} must be canonical base64url`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new TypeError(`${label} must be canonical base64url`);
  return bytes;
}

function validateUniquePaths(paths, label) {
  if (!Array.isArray(paths) || paths.length > MAX_PATHS) throw new TypeError(`${label} must be an array`);
  const exact = new Set();
  const folded = new Map();
  for (const path of paths) {
    validateRelativePath(path, `${label} entry`);
    if (exact.has(path)) throw new TypeError(`${label} contains a duplicate path`);
    exact.add(path);
    const key = path.toLowerCase();
    if (folded.has(key)) throw new TypeError(`${label} contains a case-fold alias`);
    folded.set(key, path);
  }
  return paths;
}

function validateOverlay(value) {
  exactObject(value, ["uri", "version", "dirty", "text", "revision"], [], "TextDocument overlay");
  validateWorkspaceUri(value.uri, "overlay URI");
  safeInteger(value.version, "overlay version");
  if (typeof value.dirty !== "boolean" || typeof value.text !== "string") {
    throw new TypeError("TextDocument overlay fields are invalid");
  }
  const sha256 = createHash("sha256").update(value.text, "utf8").digest("hex");
  if (value.revision !== `text-document:${value.version}:sha256:${sha256}`) {
    throw new TypeError("TextDocument overlay revision does not match its exact text");
  }
  return value;
}

function validateOverlays(values, workspace) {
  if (!Array.isArray(values) || values.length > MAX_PATHS) throw new TypeError("snapshot overlays must be an array");
  const workspaceUri = validateWorkspaceUri(workspace);
  const seen = new Set();
  for (const value of values) {
    validateOverlay(value);
    if (seen.has(value.uri)) throw new TypeError("snapshot overlays contain a duplicate URI");
    seen.add(value.uri);
    const uri = validateWorkspaceUri(value.uri, "overlay URI");
    const root = workspaceUri.pathname === "/" ? "/" : `${workspaceUri.pathname.replace(/\/+$/u, "")}/`;
    if (uri.protocol !== workspaceUri.protocol || uri.host !== workspaceUri.host
      || (uri.pathname !== workspaceUri.pathname && !uri.pathname.startsWith(root))) {
      throw new TypeError("overlay URI is outside the workspace scope");
    }
  }
  return values;
}

function validateLimits(value) {
  exactObject(value, [
    "maximumEntries",
    "maximumBlobBytes",
    "maximumAggregateBytes",
    "maximumReportBytes",
  ], [], "migration limits");
  safeInteger(value.maximumEntries, "maximum entries", { minimum: 1, maximum: 50_000 });
  safeInteger(value.maximumBlobBytes, "maximum blob bytes", { minimum: 1, maximum: 16 * 1024 * 1024 });
  safeInteger(value.maximumAggregateBytes, "maximum aggregate bytes", { minimum: 1, maximum: 64 * 1024 * 1024 });
  safeInteger(value.maximumReportBytes, "maximum report bytes", { minimum: 1, maximum: 2 * 1024 * 1024 });
  return value;
}

function validateSnapshotPayload(value, workspace) {
  if (!value || typeof value !== "object") throw new TypeError("snapshot payload must be an object");
  if (value.kind === "paths") {
    exactObject(value, ["kind", "paths", "overlays"], [], "path snapshot payload");
    validateUniquePaths(value.paths, "snapshot paths");
  }
  else if (value.kind === "plan-migration") {
    exactObject(value, ["kind", "limits", "overlays"], [], "migration snapshot payload");
    validateLimits(value.limits);
  }
  else if (value.kind === "documentation-state") {
    exactObject(value, ["kind", "overlays"], [], "Documentation state snapshot payload");
  }
  else {
    throw new TypeError("snapshot payload kind is unsupported");
  }
  validateOverlays(value.overlays, workspace);
  return value;
}

function validateJsonValue(value, label, depth = 0) {
  if (depth > MAX_DEPTH) throw new TypeError(`${label} is too deeply nested`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return safeInteger(value, label);
  if (Array.isArray(value)) {
    for (const member of value) validateJsonValue(member, label, depth + 1);
    return value;
  }
  if (!value || typeof value !== "object") throw new TypeError(`${label} contains a non-JSON value`);
  for (const [key, member] of Object.entries(value)) {
    boundedString(key, `${label} key`, 256);
    validateJsonValue(member, `${label}.${key}`, depth + 1);
  }
  return value;
}

function validateTaggedPayload(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  boundedString(value.kind, `${label} kind`);
  return validateJsonValue(value, label);
}

function validateAuthorityRequest(value) {
  if (!value || typeof value !== "object") throw new TypeError("authority request must be an object");
  const payload = value.kind === "snapshot" ? "snapshot"
    : value.kind === "transact" ? "transaction"
      : value.kind === "recover" ? "recovery" : null;
  if (!payload) throw new TypeError("authority request kind is unsupported");
  exactObject(value, ["protocolVersion", "requestId", "kind", "workspace", "epoch", payload], [], "authority request");
  if (value.protocolVersion !== 1) throw new TypeError("authority protocol version is unsupported");
  boundedString(value.requestId, "authority request id");
  validateWorkspaceUri(value.workspace);
  boundedString(value.epoch, "workspace epoch");
  if (payload === "snapshot") validateSnapshotPayload(value.snapshot, value.workspace);
  else validateTaggedPayload(value[payload], `authority ${payload}`);
  return value;
}

function validateSnapshotEntry(value) {
  if (!value || typeof value !== "object") throw new TypeError("snapshot entry must be an object");
  if (value.type === "absent") {
    exactObject(value, ["path", "type"], [], "absent snapshot entry");
  }
  else if (value.type === "directory") {
    exactObject(value, ["path", "type", "directoryGeneration"], [], "directory snapshot entry");
    if (!REVISION_RE.test(value.directoryGeneration)) throw new TypeError("directory generation is invalid");
  }
  else if (value.type === "file") {
    exactObject(value, ["path", "type", "bytes", "sha256", "revision"], [], "file snapshot entry");
    if (!DIGEST_RE.test(value.sha256)) throw new TypeError("file snapshot digest is invalid");
    const bytes = assertBase64url(value.bytes, "file snapshot bytes", { allowEmpty: true });
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== value.sha256) throw new TypeError("file snapshot digest does not match its exact bytes");
    const saved = REVISION_RE.exec(value.revision);
    const open = OPEN_REVISION_RE.exec(value.revision);
    if ((!saved || saved[1] !== actual) && (!open || open[2] !== actual)) {
      throw new TypeError("file snapshot revision does not match its exact bytes");
    }
  }
  else if (value.type === "symlink") {
    exactObject(value, ["path", "type", "target"], [], "symlink snapshot entry");
    boundedString(value.target, "symlink target", 4096);
  }
  else {
    throw new TypeError("snapshot entry type is unsupported");
  }
  validateRelativePath(value.path, "snapshot entry path");
  return value;
}

function validateSnapshotResult(value) {
  exactObject(value, ["kind", "epoch", "entries"], [], "workspace snapshot result");
  boundedString(value.epoch, "snapshot epoch");
  if (!Array.isArray(value.entries) || value.entries.length > MAX_PATHS) {
    throw new TypeError("snapshot entries must be an array");
  }
  let previous = null;
  const folded = new Set();
  for (const entry of value.entries) {
    validateSnapshotEntry(entry);
    if (previous !== null && compareUtf8Bytes(previous, entry.path) >= 0) {
      throw new TypeError("snapshot entries must be unique and bytewise sorted");
    }
    const key = entry.path.toLowerCase();
    if (folded.has(key)) throw new TypeError("snapshot entries contain a case-fold alias");
    folded.add(key);
    previous = entry.path;
  }
  return value;
}

function validateRevision(value, label) {
  if (typeof value !== "string" || (!REVISION_RE.test(value) && !OPEN_REVISION_RE.test(value))) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function validateDocumentationStateResult(value) {
  exactObject(value, ["kind", "epoch", "pages", "state"], [], "Documentation state result");
  boundedString(value.epoch, "Documentation state epoch");
  if (!Array.isArray(value.pages) || value.pages.length > MAX_PATHS) {
    throw new TypeError("Documentation state pages must be an array");
  }
  let previous = null;
  const aliases = new Set();
  for (const page of value.pages) {
    exactObject(page, ["path", "revision"], [], "Documentation state page");
    validateRelativePath(page.path, "Documentation state page path");
    if (!page.path.toLowerCase().endsWith(".qmd")) throw new TypeError("Documentation state page must use .qmd");
    validateRevision(page.revision, "Documentation state page revision");
    if (previous !== null && compareUtf8Bytes(previous, page.path) >= 0) {
      throw new TypeError("Documentation state pages must be unique and bytewise sorted");
    }
    const folded = page.path.toLowerCase();
    if (aliases.has(folded)) throw new TypeError("Documentation state pages contain a case-fold alias");
    aliases.add(folded);
    previous = page.path;
  }
  if (value.state?.kind === "missing") {
    exactObject(value.state, ["kind"], [], "missing Documentation state evidence");
  }
  else if (value.state?.kind === "file") {
    exactObject(value.state, ["kind", "bytes", "sha256", "revision"], [], "Documentation state file evidence");
    if (!DIGEST_RE.test(value.state.sha256)) throw new TypeError("Documentation state digest is invalid");
    const bytes = assertBase64url(value.state.bytes, "Documentation state bytes", { allowEmpty: true });
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== value.state.sha256 || value.state.revision !== `sha256:${actual}`) {
      throw new TypeError("Documentation state digest or revision does not match its exact bytes");
    }
  }
  else {
    throw new TypeError("Documentation state file evidence is invalid");
  }
  return value;
}

function validateAuthorityResponse(value) {
  exactObject(value, ["protocolVersion", "requestId", "result"], [], "authority response");
  if (value.protocolVersion !== 1) throw new TypeError("authority protocol version is unsupported");
  boundedString(value.requestId, "authority request id");
  if (value.result?.kind === "snapshot") validateSnapshotResult(value.result);
  else if (value.result?.kind === "documentation-state") validateDocumentationStateResult(value.result);
  else validateTaggedPayload(value.result, "authority result");
  return value;
}

function canonicalJson(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new TypeError("authority value is too deeply nested");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(member => canonicalJson(member, depth + 1)).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("authority value is not canonical JSON");
  const keys = Object.keys(value).sort(compareUtf8Bytes);
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(",")}}`;
}

function parseJsonWithoutDuplicateKeys(text) {
  let index = 0;
  const whitespace = () => {
    while (/[\u0009\u000a\u000d\u0020]/u.test(text[index] ?? "")) index++;
  };
  const parseString = () => {
    const start = index;
    if (text[index++] !== '"') throw new SyntaxError("expected JSON string");
    while (index < text.length) {
      const character = text[index++];
      if (character === '"') return JSON.parse(text.slice(start, index));
      if (character === "\\") {
        const escape = text[index++];
        if (escape === "u") {
          const digits = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) throw new SyntaxError("invalid JSON Unicode escape");
          index += 4;
        }
        else if (!'"\\/bfnrt'.includes(escape ?? "")) throw new SyntaxError("invalid JSON escape");
      }
      else if (character.charCodeAt(0) < 0x20) throw new SyntaxError("invalid JSON control character");
    }
    throw new SyntaxError("unterminated JSON string");
  };
  const parseValue = depth => {
    if (depth > MAX_DEPTH) throw new SyntaxError("JSON is too deeply nested");
    whitespace();
    const character = text[index];
    if (character === '"') return parseString();
    if (character === "{") {
      index++;
      whitespace();
      const result = {};
      const keys = new Set();
      if (text[index] === "}") { index++; return result; }
      while (index < text.length) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) throw new SyntaxError(`duplicate JSON key ${key}`);
        keys.add(key);
        whitespace();
        if (text[index++] !== ":") throw new SyntaxError("expected JSON colon");
        result[key] = parseValue(depth + 1);
        whitespace();
        const delimiter = text[index++];
        if (delimiter === "}") return result;
        if (delimiter !== ",") throw new SyntaxError("expected JSON object delimiter");
      }
      throw new SyntaxError("unterminated JSON object");
    }
    if (character === "[") {
      index++;
      whitespace();
      const result = [];
      if (text[index] === "]") { index++; return result; }
      while (index < text.length) {
        result.push(parseValue(depth + 1));
        whitespace();
        const delimiter = text[index++];
        if (delimiter === "]") return result;
        if (delimiter !== ",") throw new SyntaxError("expected JSON array delimiter");
      }
      throw new SyntaxError("unterminated JSON array");
    }
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, index)) { index += literal.length; return value; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(index));
    if (!match) throw new SyntaxError("invalid JSON value");
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new SyntaxError("invalid JSON number");
    return value;
  };
  const value = parseValue(0);
  whitespace();
  if (index !== text.length) throw new SyntaxError("unexpected JSON trailing data");
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const member of Object.values(value)) deepFreeze(member);
  return Object.freeze(value);
}

function encodeFrame(value, validate, label) {
  const validated = validate(value);
  const bytes = Buffer.from(canonicalJson(validated), "utf8");
  if (bytes.byteLength > MAX_DECODED_BYTES) throw new RangeError(`${label} is too large`);
  const frame = bytes.toString("base64url");
  if (Buffer.byteLength(frame, "ascii") > MAX_ENCODED_BYTES) throw new RangeError(`${label} frame is too large`);
  return frame;
}

function decodeFrame(frame, validate, label) {
  if (typeof frame !== "string" || Buffer.byteLength(frame, "ascii") > MAX_ENCODED_BYTES) {
    throw new RangeError(`${label} frame is too large`);
  }
  const bytes = assertBase64url(frame, `${label} frame`);
  if (bytes.byteLength > MAX_DECODED_BYTES) throw new RangeError(`${label} is too large`);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new TypeError(`${label} is not valid UTF-8`);
  const validated = validate(parseJsonWithoutDuplicateKeys(text));
  if (canonicalJson(validated) !== text) throw new TypeError(`${label} is not canonical JSON`);
  return deepFreeze(validated);
}

export function encodeAuthorityRequest(request) {
  return encodeFrame(request, validateAuthorityRequest, "authority request");
}

export function decodeAuthorityRequest(frame) {
  return decodeFrame(frame, validateAuthorityRequest, "authority request");
}

export function encodeAuthorityResponse(response) {
  return encodeFrame(response, validateAuthorityResponse, "authority response");
}

export function decodeAuthorityResponse(frame) {
  return decodeFrame(frame, validateAuthorityResponse, "authority response");
}
