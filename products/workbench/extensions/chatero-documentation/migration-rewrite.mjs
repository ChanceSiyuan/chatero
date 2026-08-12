import { createHash } from "node:crypto";
import { posix } from "node:path";

import { isMap, isScalar, isSeq, parseDocument } from "./runtime/yaml-2.9.0.mjs";

const CHANGE_ROOT = "work/qlab-zotero/draft-changes";
const MAIN_SITE_FIELDS = new Set(["file", "href", "input", "page", "path", "route", "source", "target"]);
const WEBSITE_FIELDS = new Set(["contents", "file", "href", "path", "source"]);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const LEGACY_REVISION = /^(?:v2-[0-9a-f]{32}|[0-9a-f]{1,8})$/u;

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const member of Object.values(value)) deepFreeze(member);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("migration value is not canonical JSON");
  const keys = Object.keys(value).sort(compareUtf8Bytes);
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function exactBytes(value, label) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be bytes`);
  return Buffer.from(value);
}

function decodeUtf8(bytes, label) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new TypeError(`${label} is not valid UTF-8`); }
}

function safeRelativePath(value, label) {
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

function mappingIndex(mapping) {
  if (!mapping || !Array.isArray(mapping.pages) || !Array.isArray(mapping.assets)) {
    throw new TypeError("legacy migration mapping is invalid");
  }
  const values = new Map();
  for (const entry of [...mapping.pages, ...mapping.assets]) {
    if (!entry || !new Set(["knowledge", "drafts"]).has(entry.sourceRoot)
      || typeof entry.sourcePath !== "string" || typeof entry.destination?.value !== "string") {
      throw new TypeError("legacy migration mapping entry is invalid");
    }
    const source = `${entry.sourceRoot}/${entry.sourcePath}`;
    safeRelativePath(source, "legacy source path");
    safeRelativePath(entry.destination.value, "Documentation destination path");
    if (values.has(source)) throw new TypeError("legacy migration mapping has a duplicate source");
    values.set(source, entry);
  }
  return values;
}

function splitReference(value) {
  const index = value.search(/[?#]/u);
  return index < 0
    ? { path: value, suffix: "" }
    : { path: value.slice(0, index), suffix: value.slice(index) };
}

function resolveReference(value, sourcePath, destinationPath, index) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("#")) {
    return Object.freeze({ kind: "ignored" });
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) || value.startsWith("//")) {
    return Object.freeze({ kind: "ignored" });
  }
  const { path, suffix } = splitReference(value);
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("%")) {
    return Object.freeze({ kind: "ambiguous" });
  }
  const resolved = posix.normalize(posix.join(posix.dirname(sourcePath), path));
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved)) {
    return Object.freeze({ kind: "ambiguous" });
  }
  const target = index.get(resolved);
  if (!target) return Object.freeze({ kind: "ambiguous" });
  let replacement = posix.relative(posix.dirname(destinationPath), target.destination.value);
  if (!replacement) replacement = posix.basename(target.destination.value);
  return Object.freeze({ kind: "mapped", replacement: `${replacement}${suffix}` });
}

function frontMatterRange(text) {
  const first = /^(---)(\r?\n)/u.exec(text);
  if (!first) return null;
  let cursor = first[0].length;
  while (cursor <= text.length) {
    const end = text.indexOf("\n", cursor);
    const lineEnd = end < 0 ? text.length : end + 1;
    const line = text.slice(cursor, end < 0 ? text.length : end).replace(/\r$/u, "");
    if (line === "---" || line === "...") {
      return Object.freeze({
        start: 0,
        bodyStart: first[0].length,
        bodyEnd: cursor,
        end: lineEnd,
      });
    }
    if (end < 0) break;
    cursor = lineEnd;
  }
  return null;
}

function protectedRanges(text, frontMatter) {
  const ranges = [];
  if (frontMatter) ranges.push({ from: frontMatter.start, to: frontMatter.end, kind: "front-matter" });
  let cursor = 0;
  let fence = null;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/gu)) {
    if (line[0].length === 0) continue;
    const from = line.index;
    const to = from + line[0].length;
    if (frontMatter && from < frontMatter.end) { cursor = to; continue; }
    const content = line[0].replace(/\r?\n$/u, "");
    const opener = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(content);
    if (!fence && opener) {
      fence = { from, marker: opener[1][0], length: opener[1].length };
    }
    else if (fence) {
      const closing = new RegExp(`^[ \\t]{0,3}${fence.marker}{${fence.length},}[ \\t]*$`, "u");
      if (closing.test(content)) {
        ranges.push({ from: fence.from, to, kind: "fence" });
        fence = null;
      }
    }
    cursor = to;
  }
  if (fence) ranges.push({ from: fence.from, to: text.length, kind: "fence" });

  const inExisting = offset => ranges.some(range => offset >= range.from && offset < range.to);
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/gu)) {
    if (!line[0] || inExisting(line.index)) continue;
    const content = line[0].replace(/\r?\n$/u, "");
    let index = 0;
    while (index < content.length) {
      if (content[index] !== "`") { index++; continue; }
      let length = 1;
      while (content[index + length] === "`") length++;
      const marker = "`".repeat(length);
      const close = content.indexOf(marker, index + length);
      if (close < 0) break;
      ranges.push({
        from: line.index + index,
        to: line.index + close + length,
        kind: "inline-code",
      });
      index = close + length;
    }
  }
  return ranges.sort((left, right) => left.from - right.from);
}

function containingRange(ranges, from, to) {
  return ranges.find(range => from >= range.from && to <= range.to) ?? null;
}

function yamlScalarAllowed(path) {
  const keys = path.filter(value => typeof value === "string");
  if (keys[0] === "project" && keys[1] === "render") {
    return { allowed: true, syntax: "quarto-project" };
  }
  if (keys[0] === "website" && new Set(["navbar", "sidebar"]).has(keys[1])) {
    const field = keys.at(-1);
    if (WEBSITE_FIELDS.has(field)) return { allowed: true, syntax: "quarto-website" };
  }
  if (keys[0] === "chatero" && keys[1] === "main-site" && keys[2] === "routes"
    && MAIN_SITE_FIELDS.has(keys.at(-1))) {
    return { allowed: true, syntax: "main-site-route" };
  }
  return { allowed: false, syntax: null };
}

function visitYaml(node, path, callback) {
  if (isScalar(node)) callback(node, path);
  else if (isMap(node)) {
    for (const item of node.items) {
      if (!isScalar(item.key) || typeof item.key.value !== "string") continue;
      visitYaml(item.value, [...path, item.key.value], callback);
    }
  }
  else if (isSeq(node)) node.items.forEach((item, index) => visitYaml(item, [...path, index], callback));
}

function scalarReplacement(raw, value) {
  if (raw.startsWith("'") && raw.endsWith("'")) return `'${value.replaceAll("'", "''")}'`;
  if (raw.startsWith('"') && raw.endsWith('"')) return JSON.stringify(value);
  return value;
}

function markdownCandidates(text) {
  const values = [];
  const markdown = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))/gu;
  for (const match of text.matchAll(markdown)) {
    const value = match[1] ?? match[2];
    const local = match[0].indexOf(value);
    values.push({ from: match.index + local, to: match.index + local + value.length, value, syntax: "markdown-link" });
  }
  const qmd = /\{\{<\s*(?:include|embed)\s+(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>\}\}/gu;
  for (const match of text.matchAll(qmd)) {
    const value = match[1] ?? match[2] ?? match[3];
    const local = match[0].indexOf(value);
    values.push({
      from: match.index + local,
      to: match.index + local + value.length,
      value,
      syntax: "qmd-cross-reference",
    });
  }
  values.sort((left, right) => left.from - right.from || left.to - right.to);
  return values;
}

function byteOffsets(text, offsets) {
  const values = [...new Set(offsets)].sort((left, right) => left - right);
  const result = new Map();
  let character = 0;
  let bytes = 0;
  for (const offset of values) {
    bytes += Buffer.byteLength(text.slice(character, offset), "utf8");
    character = offset;
    result.set(offset, bytes);
  }
  return result;
}

function applyByteEdits(bytes, edits) {
  let output = Buffer.from(bytes);
  for (const edit of [...edits].sort((left, right) => right.from - left.from)) {
    output = Buffer.concat([
      output.subarray(0, edit.from),
      Buffer.from(edit.replacement, "utf8"),
      output.subarray(edit.to),
    ]);
  }
  return output;
}

export function rewriteLegacyReferences({ sourcePath, destinationPath, bytes, mapping }) {
  safeRelativePath(sourcePath, "legacy source path");
  const root = sourcePath.split("/")[0];
  if (!new Set(["knowledge", "drafts"]).has(root) || !sourcePath.toLowerCase().endsWith(".qmd")) {
    throw new TypeError("legacy source path must identify a QMD page");
  }
  const index = mappingIndex(mapping);
  const sourceEntry = index.get(sourcePath);
  if (!sourceEntry || sourceEntry.destination !== destinationPath) {
    throw new TypeError("legacy rewrite destination does not match the migration mapping");
  }
  const input = exactBytes(bytes, "legacy QMD");
  const text = decodeUtf8(input, "legacy QMD");
  const frontMatter = frontMatterRange(text);
  const protectedValues = protectedRanges(text, frontMatter);
  const edits = [];
  const followUps = [];

  if (frontMatter) {
    const yaml = text.slice(frontMatter.bodyStart, frontMatter.bodyEnd);
    const document = parseDocument(yaml, { keepSourceTokens: true, uniqueKeys: true });
    if (document.errors.length > 0) {
      followUps.push({
        from: frontMatter.bodyStart,
        to: frontMatter.bodyEnd,
        code: "malformed-yaml",
      });
    }
    else {
      visitYaml(document.contents, [], (node, path) => {
        if (typeof node.value !== "string" || !Array.isArray(node.range)) return;
        const from = frontMatter.bodyStart + node.range[0];
        const to = frontMatter.bodyStart + node.range[1];
        const resolution = resolveReference(node.value, sourcePath, destinationPath.value, index);
        const policy = yamlScalarAllowed(path);
        if (policy.allowed && resolution.kind === "mapped") {
          edits.push({
            from,
            to,
            replacement: scalarReplacement(text.slice(from, to), resolution.replacement),
            syntax: policy.syntax,
          });
        }
        else if (policy.allowed && resolution.kind === "ambiguous") {
          followUps.push({ from, to, code: "ambiguous-reference" });
        }
        else if (!policy.allowed && resolution.kind === "mapped") {
          followUps.push({ from, to, code: "ambiguous-yaml-reference" });
        }
      });
    }
  }

  for (const candidate of markdownCandidates(text)) {
    const protectedRange = containingRange(protectedValues, candidate.from, candidate.to);
    if (protectedRange?.kind === "front-matter") continue;
    const resolution = resolveReference(candidate.value, sourcePath, destinationPath.value, index);
    if (protectedRange) {
      if (resolution.kind === "mapped") {
        followUps.push({ from: candidate.from, to: candidate.to, code: "protected-reference" });
      }
    }
    else if (resolution.kind === "mapped") {
      edits.push({ ...candidate, replacement: resolution.replacement });
    }
    else if (resolution.kind === "ambiguous") {
      followUps.push({ from: candidate.from, to: candidate.to, code: "ambiguous-reference" });
    }
  }

  edits.sort((left, right) => left.from - right.from || left.to - right.to);
  for (let index = 1; index < edits.length; index++) {
    if (edits[index].from < edits[index - 1].to) throw new TypeError("legacy reference edits overlap");
  }
  followUps.sort((left, right) => left.from - right.from || left.to - right.to
    || compareUtf8Bytes(left.code, right.code));
  const offsets = byteOffsets(text, [
    ...edits.flatMap(edit => [edit.from, edit.to]),
    ...followUps.flatMap(value => [value.from, value.to]),
  ]);
  const byteEdits = edits.map(edit => Object.freeze({
    from: offsets.get(edit.from),
    to: offsets.get(edit.to),
    replacement: edit.replacement,
    syntax: edit.syntax,
  }));
  const byteFollowUps = followUps.map(value => Object.freeze({
    from: offsets.get(value.from),
    to: offsets.get(value.to),
    code: value.code,
  }));
  return Object.freeze({
    kind: "rewritten",
    bytes: new Uint8Array(applyByteEdits(input, byteEdits)),
    edits: Object.freeze(byteEdits),
    followUps: Object.freeze(byteFollowUps),
  });
}

function proposalBlobMap(blobs) {
  const values = blobs instanceof Map ? [...blobs.entries()]
    : Array.isArray(blobs) ? blobs.map(value => [value?.path, value?.bytes])
      : blobs && typeof blobs === "object" ? Object.entries(blobs) : null;
  if (!values) throw new TypeError("legacy proposal blobs are invalid");
  const result = new Map();
  for (const [path, bytes] of values) {
    safeRelativePath(path, "legacy proposal blob path");
    if (result.has(path)) throw new TypeError("legacy proposal blobs contain a duplicate path");
    result.set(path, exactBytes(bytes, "legacy proposal blob"));
  }
  return result;
}

function fnvRevision(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function strongLegacyRevision(value) {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const hex = value => (value >>> 0).toString(16).padStart(8, "0");
  return `v2-${hex(h1 ^ h2 ^ h3 ^ h4)}${hex(h2 ^ h1)}${hex(h3 ^ h1)}${hex(h4 ^ h1)}`;
}

function revisionMatches(bytes, revision) {
  if (SHA256.test(revision)) return sha256(bytes) === revision;
  if (!LEGACY_REVISION.test(revision)) return false;
  const text = decodeUtf8(bytes, "legacy proposal base");
  return revision.startsWith("v2-")
    ? strongLegacyRevision(text) === revision
    : fnvRevision(text) === revision;
}

function proposalManifest(record, blobs) {
  const path = safeRelativePath(record?.path, "legacy proposal manifest path");
  const bytes = exactBytes(record?.bytes, "legacy proposal manifest");
  const prefix = `${CHANGE_ROOT}/`;
  if (!path.startsWith(prefix) || !path.endsWith("/manifest.json")) {
    return { diagnostic: { recordPath: path, code: "unsafe-path" } };
  }
  const token = path.slice(prefix.length, -"/manifest.json".length);
  if (!token || token.includes("/") || token.startsWith(".")) {
    return { diagnostic: { recordPath: path, code: "unsafe-path" } };
  }
  let manifest;
  try { manifest = JSON.parse(decodeUtf8(bytes, "legacy proposal manifest")); }
  catch { return { diagnostic: { recordPath: path, code: "malformed-json" } }; }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { diagnostic: { recordPath: path, code: "malformed-json" } };
  }
  if (manifest.schemaVersion !== 2) {
    return { diagnostic: { recordPath: path, code: "unknown-schema" } };
  }
  try {
    safeRelativePath(manifest.originalPath, "legacy proposal original path");
    safeRelativePath(manifest.workingPath, "legacy proposal working path");
    safeRelativePath(manifest.basePath, "legacy proposal base path");
  }
  catch { return { diagnostic: { recordPath: path, code: "unsafe-path" } }; }
  const directory = path.slice(0, -"/manifest.json".length);
  if (!manifest.originalPath.startsWith("drafts/")
    || !manifest.originalPath.toLowerCase().endsWith(".qmd")
    || manifest.workingPath !== `${directory}/draft.qmd`
    || manifest.basePath !== `${directory}/base.qmd`
    || typeof manifest.baseRevision !== "string"
    || manifest.revision !== manifest.baseRevision) {
    return { diagnostic: { recordPath: path, code: "unsafe-path" } };
  }
  const base = blobs.get(manifest.basePath);
  const proposed = blobs.get(manifest.workingPath);
  if (!base || !proposed) return { diagnostic: { recordPath: path, code: "missing-blob" } };
  if (!revisionMatches(base, manifest.baseRevision)) {
    return { diagnostic: { recordPath: path, code: "digest-mismatch" } };
  }
  decodeUtf8(proposed, "legacy proposal working copy");
  return { path, manifest, base, proposed };
}

export function classifyLegacyProposals({ records, blobs, mapping }) {
  if (!Array.isArray(records)) throw new TypeError("legacy proposal records must be an array");
  const bodyMap = proposalBlobMap(blobs);
  const index = mappingIndex(mapping);
  const sorted = [...records].sort((left, right) => compareUtf8Bytes(left?.path ?? "", right?.path ?? ""));
  const proposals = [];
  const diagnostics = [];
  const duplicates = new Set();
  for (const record of sorted) {
    let parsed;
    try { parsed = proposalManifest(record, bodyMap); }
    catch {
      const recordPath = typeof record?.path === "string" ? record.path : "invalid-record";
      diagnostics.push(Object.freeze({ recordPath, code: "unsafe-path" }));
      continue;
    }
    if (parsed.diagnostic) {
      diagnostics.push(Object.freeze(parsed.diagnostic));
      continue;
    }
    const relative = parsed.manifest.originalPath.slice("drafts/".length);
    const target = index.get(parsed.manifest.originalPath);
    if (!target || target.sourceRoot !== "drafts" || target.sourcePath !== relative) {
      diagnostics.push(Object.freeze({ recordPath: parsed.path, code: "unmapped-original" }));
      continue;
    }
    const base = rewriteLegacyReferences({
      sourcePath: parsed.manifest.originalPath,
      destinationPath: target.destination,
      bytes: parsed.base,
      mapping,
    });
    const proposed = rewriteLegacyReferences({
      sourcePath: parsed.manifest.originalPath,
      destinationPath: target.destination,
      bytes: parsed.proposed,
      mapping,
    });
    const rawBaseDigest = sha256(parsed.base);
    const rawProposedDigest = sha256(parsed.proposed);
    const duplicateKey = `${parsed.manifest.originalPath}\0${rawBaseDigest}\0${rawProposedDigest}`;
    const classification = duplicates.has(duplicateKey) ? "exact-duplicate" : "valid";
    duplicates.add(duplicateKey);
    const summary = {
      schemaVersion: 1,
      recordPath: parsed.path,
      originalPath: parsed.manifest.originalPath,
      destinationPath: target.destination.value,
      classification,
      rawBaseDigest,
      rawProposedDigest,
      migratedBaseDigest: sha256(base.bytes),
      migratedProposedDigest: sha256(proposed.bytes),
      baseRewriteCount: base.edits.length,
      proposedRewriteCount: proposed.edits.length,
      followUpCount: base.followUps.length + proposed.followUps.length,
    };
    proposals.push(Object.freeze({
      ...summary,
      transformationDigest: sha256(Buffer.from(canonicalJson(summary), "utf8")),
    }));
  }
  diagnostics.sort((left, right) => compareUtf8Bytes(left.recordPath, right.recordPath)
    || compareUtf8Bytes(left.code, right.code));
  return deepFreeze({ proposals, diagnostics });
}
