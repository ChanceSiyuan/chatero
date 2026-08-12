import { createHash } from "node:crypto";

import { documentationPagePath, validateOperationPathSet } from "./documentation-path.mjs";
import {
  compareUtf8Bytes,
  parseDocumentationState,
  projectDocumentationState,
} from "./documentation-state.mjs";

const MAX_RESULT_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_RESULTS = 32;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cancelled(token) {
  if (token?.isCancellationRequested === true) {
    const error = new Error("Documentation retrieval was cancelled");
    error.name = "CancellationError";
    throw error;
  }
}

function terms(value) {
  return value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function requestValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.query !== "string" || value.query.trim().length === 0
    || Buffer.byteLength(value.query, "utf8") > 4096) throw new TypeError("Documentation retrieval request is invalid");
  const limit = value.limit ?? value.maximumResults ?? 12;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new TypeError("Documentation retrieval limit is invalid");
  const explicitPaths = value.explicitPaths ?? [];
  if (!Array.isArray(explicitPaths)) throw new TypeError("Documentation retrieval explicit paths are invalid");
  const paths = explicitPaths.map(path => path?.kind === "documentation-page" ? path : documentationPagePath(path));
  if (value.currentPath !== undefined) paths.push(value.currentPath?.kind === "documentation-page"
    ? value.currentPath : documentationPagePath(value.currentPath));
  if (paths.length > 0) validateOperationPathSet(paths.map(path => ({ kind: "edit", path })));
  return Object.freeze({
    query: value.query,
    queryTerms: Object.freeze(terms(value.query)),
    limit,
    explicitPaths: Object.freeze(paths),
    includeWorking: value.includeWorking === true,
    background: value.background ?? (paths.length === 0 && value.includeWorking !== true),
  });
}

function stateBytes(evidence) {
  if (evidence?.kind === "missing") return null;
  if (!evidence || evidence.kind !== "file" || typeof evidence.bytes !== "string") {
    throw new TypeError("Documentation retrieval state evidence is invalid");
  }
  const bytes = Buffer.from(evidence.bytes, "base64url");
  if (bytes.toString("base64url") !== evidence.bytes || sha256(bytes) !== evidence.sha256
    || evidence.revision !== `sha256:${evidence.sha256}`) {
    throw new TypeError("Documentation retrieval state evidence digest does not match");
  }
  return bytes;
}

function projectedState(result) {
  if (!result || result.kind !== "documentation-state" || !Array.isArray(result.pages)) {
    throw new TypeError("Documentation retrieval state snapshot is unavailable");
  }
  const pages = result.pages.map(value => documentationPagePath(value.path));
  validateOperationPathSet(pages.map(path => ({ kind: "edit", path })));
  return projectDocumentationState({ pages, parsed: parseDocumentationState(stateBytes(result.state)) });
}

function decodedDocument(entry) {
  if (!entry || entry.type !== "file" || typeof entry.path !== "string" || typeof entry.bytes !== "string"
    || typeof entry.revision !== "string") throw new TypeError("Documentation retrieval page snapshot is invalid");
  const path = documentationPagePath(entry.path.replace(/^documentation\//u, ""));
  const bytes = Buffer.from(entry.bytes, "base64url");
  if (bytes.toString("base64url") !== entry.bytes || sha256(bytes) !== entry.sha256) {
    throw new TypeError("Documentation retrieval page digest does not match");
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new TypeError("Documentation retrieval page is not UTF-8");
  return Object.freeze({
    path,
    text,
    revision: entry.revision,
    dirty: entry.dirty === true,
  });
}

function boundedPassage(text, offset) {
  let start = Math.max(0, offset - Math.floor(MAX_RESULT_BYTES / 4));
  let end = Math.min(text.length, start + Math.floor(MAX_RESULT_BYTES / 2));
  while (Buffer.byteLength(text.slice(start, end), "utf8") > MAX_RESULT_BYTES && end > start) end--;
  return Object.freeze({ text: text.slice(start, end), offset: start });
}

function scoreText(text, queryTerms) {
  const normalized = text.normalize("NFKC").toLowerCase();
  let score = 0;
  let first = Number.POSITIVE_INFINITY;
  for (const term of queryTerms) {
    let offset = normalized.indexOf(term);
    while (offset >= 0) {
      score++;
      first = Math.min(first, offset);
      offset = normalized.indexOf(term, offset + Math.max(1, term.length));
    }
  }
  return Object.freeze({ score, first: Number.isFinite(first) ? first : -1 });
}

function comparePassages(left, right) {
  return Number(right.state === "reviewed") - Number(left.state === "reviewed")
    || right.score - left.score
    || compareUtf8Bytes(left.path.value, right.path.value)
    || left.offset - right.offset;
}

export function retrievalEligibility({ state, isCurrent, isExplicit, includeWorking, background }) {
  if (state === "reviewed") return true;
  if (background) return false;
  return isCurrent === true || isExplicit === true || includeWorking === true;
}

export function formatRetrievedPassage(value) {
  if (!value || value.path?.kind !== "documentation-page" || typeof value.text !== "string") {
    throw new TypeError("retrieved Documentation passage is invalid");
  }
  const workflow = value.state === "reviewed" ? "Reviewed" : "Working — not reviewed";
  const dirty = value.dirty ? ` · Dirty buffer v${/^text-document:([0-9]+):/u.exec(value.revision)?.[1] ?? "?"}` : "";
  return `[${value.path.value} · ${workflow}${dirty} · ${value.revision}]\n${value.text}`;
}

export function createDocumentationRetrieval({ adapter, capabilities, scope } = {}) {
  if (typeof adapter?.snapshot !== "function" || typeof capabilities?.consumeScope !== "function" || !scope) {
    throw new TypeError("Documentation retrieval dependencies are invalid");
  }
  const scopeRecord = capabilities.consumeScope(scope);

  const retrieve = async (rawRequest, token) => {
    const request = requestValue(rawRequest);
    cancelled(token);
    if (request.queryTerms.length === 0) return Object.freeze([]);
    const stateResult = await adapter.snapshot({
      kind: "documentation-state",
      workspaceScopeDigest: scopeRecord.workspaceScopeDigest,
      includeOpenBuffers: false,
    });
    cancelled(token);
    const state = projectedState(stateResult);
    const allPaths = Object.keys(state.documents).filter(path => state.documents[path].orphan !== true).map(documentationPagePath);
    const explicit = new Set(request.explicitPaths.map(path => path.value));
    const candidates = request.explicitPaths.length > 0 ? request.explicitPaths : allPaths;
    const selected = candidates.filter(path => {
      const entry = state.documents[path.value];
      return entry && entry.orphan !== true && retrievalEligibility({
        state: entry.state,
        isCurrent: request.explicitPaths.at(-1)?.value === path.value,
        isExplicit: explicit.has(path.value),
        includeWorking: request.includeWorking,
        background: request.background,
      });
    });
    if (selected.length === 0) return Object.freeze([]);
    const overlayPaths = selected.filter(path => explicit.has(path.value) && !request.background);
    const savedPaths = selected.filter(path => !overlayPaths.some(value => value.value === path.value));
    const snapshots = await Promise.all([
      ...(savedPaths.length > 0 ? [adapter.snapshot({ kind: "paths", paths: savedPaths, includeOpenBuffers: false })] : []),
      ...(overlayPaths.length > 0 ? [adapter.snapshot({ kind: "paths", paths: overlayPaths, includeOpenBuffers: true })] : []),
    ]);
    cancelled(token);
    const documents = snapshots.flatMap(snapshot => {
      if (snapshot?.kind !== "snapshot" || !Array.isArray(snapshot.entries)) {
        throw new TypeError("Documentation retrieval path snapshot is unavailable");
      }
      return snapshot.entries.map(decodedDocument);
    });
    const results = [];
    for (const document of documents) {
      const match = scoreText(document.text, request.queryTerms);
      if (match.score === 0) continue;
      const passage = boundedPassage(document.text, match.first);
      const workflow = state.documents[document.path.value]?.state ?? "working";
      results.push(Object.freeze({
        path: document.path,
        state: workflow,
        dirty: document.dirty,
        revision: document.revision,
        score: workflow === "reviewed" ? match.score : match.score * 0.5,
        offset: passage.offset,
        text: passage.text,
      }));
    }
    results.sort(comparePassages);
    const bounded = [];
    let total = 0;
    for (const result of results.slice(0, request.limit)) {
      const size = Buffer.byteLength(formatRetrievedPassage(result), "utf8");
      if (total + size > MAX_TOTAL_BYTES) break;
      bounded.push(result);
      total += size;
    }
    return Object.freeze(bounded);
  };

  const indexSaved = async () => {
    const result = await adapter.snapshot({
      kind: "documentation-state",
      workspaceScopeDigest: scopeRecord.workspaceScopeDigest,
      includeOpenBuffers: false,
    });
    const state = projectedState(result);
    const reviewed = Object.entries(state.documents)
      .filter(([, value]) => value.state === "reviewed" && value.orphan !== true)
      .map(([path]) => path).sort(compareUtf8Bytes);
    return Object.freeze({
      kind: "retrieval-indexed",
      generation: state.generation,
      reviewedPages: reviewed.length,
      indexDigest: `sha256:${sha256(Buffer.from(reviewed.join("\n"), "utf8"))}`,
    });
  };

  return Object.freeze({ retrieve, indexSaved });
}
