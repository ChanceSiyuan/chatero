import { Buffer } from "node:buffer";

import { parseEvidenceDocumentUri } from "./evidence-editor-registry.mjs";

export const PDF_CONTEXT_LIMITS = Object.freeze({
  selectedText: 32 * 1024,
  pageText: 128 * 1024,
  annotationText: 64 * 1024,
  annotationsEnvelope: 72 * 1024,
  title: 4 * 1024,
  pageLabel: 256,
  annotationMetadata: 256,
  annotationCount: 64,
});

const PANEL_NONCE = /^[A-Za-z0-9_-]{24}$/;
const PAYLOAD_FIELDS = Object.freeze([
  "type",
  "panelNonce",
  "sequence",
  "pageIndex",
  "pageLabel",
  "pageText",
  "selectedText",
]);

function uriText(uri) {
  const value = typeof uri === "string" ? uri : uri?.toString?.();
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("PDF context document URI is invalid");
  }
  return value;
}

function utf8Width(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function utf8ByteLength(value) {
  if (typeof value !== "string") throw new TypeError("PDF context text must be a string");
  // Buffer.byteLength agrees with the per-code-point widths above for every JS string,
  // including lone surrogates (3 bytes as U+FFFD) and surrogate pairs (4 bytes).
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value, maxBytes) {
  if (typeof value !== "string") throw new TypeError("PDF context text must be a string");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("PDF context byte limit is invalid");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const width = utf8Width(character);
    if (bytes + width > maxBytes) break;
    result += character;
    bytes += width;
  }
  return result;
}

function exactPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("PDF context payload must be an object");
  }
  const keys = Object.keys(payload).sort();
  const expected = [...PAYLOAD_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("PDF context payload contains an unknown or missing field");
  }
  if (payload.type !== "pdf-context") throw new TypeError("PDF context payload type is invalid");
  if (!PANEL_NONCE.test(payload.panelNonce)) throw new TypeError("PDF context payload nonce is invalid");
  if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 1) {
    throw new TypeError("PDF context sequence is invalid");
  }
  if (!Number.isSafeInteger(payload.pageIndex) || payload.pageIndex < 0) {
    throw new TypeError("PDF context page index is invalid");
  }
  for (const field of ["pageLabel", "pageText", "selectedText"]) {
    if (typeof payload[field] !== "string") throw new TypeError(`PDF context ${field} must be a string`);
  }
  return payload;
}

function validateRecord(documentUri, record) {
  if (!record || typeof record !== "object" || !Object.isFrozen(record)) {
    throw new TypeError("PDF context trusted record must be frozen");
  }
  const identity = parseEvidenceDocumentUri(documentUri);
  if (identity.kind !== "pdf"
      || record.libraryId !== identity.libraryId
      || record.attachmentKey !== identity.key
      || typeof record.title !== "string"
      || record.title.length === 0) {
    throw new TypeError("PDF context trusted record does not match the document");
  }
  return identity;
}

function annotationPageIndex(annotation) {
  try {
    const position = JSON.parse(annotation.positionJson);
    return Number.isSafeInteger(position?.pageIndex) && position.pageIndex >= 0
      ? position.pageIndex
      : null;
  }
  catch {
    return null;
  }
}

function validateAnnotations(annotations) {
  if (!Array.isArray(annotations) || !Object.isFrozen(annotations)) {
    throw new TypeError("PDF context annotations must be a frozen Core snapshot");
  }
  for (const annotation of annotations) {
    if (!annotation || typeof annotation !== "object" || !Object.isFrozen(annotation)
        || !["annotationKey", "type", "pageLabel", "positionJson", "text", "comment"]
          .every(field => typeof annotation[field] === "string")) {
      throw new TypeError("PDF context annotation is invalid");
    }
  }
  return annotations;
}

function snapshotAnnotations(annotations, pageIndex) {
  const result = [];
  let remainingText = PDF_CONTEXT_LIMITS.annotationText;

  // JSON.stringify of an array costs 2 bracket bytes, one comma between elements and the
  // element bytes themselves, so the accumulated elements never need re-serializing.
  let usedElementBytes = 0;
  const elementBytes = value => utf8ByteLength(JSON.stringify(value));
  const envelopeFits = candidateBytes =>
    2 + usedElementBytes + result.length + candidateBytes <= PDF_CONTEXT_LIMITS.annotationsEnvelope;
  const fitField = (base, field, value) => {
    const characters = Array.from(value);
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = { ...base, [field]: characters.slice(0, middle).join("") };
      if (envelopeFits(elementBytes(candidate))) low = middle;
      else high = middle - 1;
    }
    return characters.slice(0, low).join("");
  };

  for (const annotation of annotations) {
    if (result.length >= PDF_CONTEXT_LIMITS.annotationCount || annotationPageIndex(annotation) !== pageIndex) continue;
    const base = {
      annotationKey: truncateUtf8(annotation.annotationKey, PDF_CONTEXT_LIMITS.annotationMetadata),
      type: truncateUtf8(annotation.type, PDF_CONTEXT_LIMITS.annotationMetadata),
      pageLabel: truncateUtf8(annotation.pageLabel, PDF_CONTEXT_LIMITS.pageLabel),
      text: "",
      comment: "",
    };
    if (!envelopeFits(elementBytes(base))) break;
    const text = fitField(base, "text", truncateUtf8(annotation.text, remainingText));
    remainingText -= utf8ByteLength(text);
    const withText = { ...base, text };
    const comment = fitField(withText, "comment", truncateUtf8(annotation.comment, remainingText));
    remainingText -= utf8ByteLength(comment);
    const entry = {
      annotationKey: base.annotationKey,
      type: base.type,
      pageLabel: base.pageLabel,
      text,
      comment,
    };
    usedElementBytes += elementBytes(entry);
    result.push(Object.freeze(entry));
  }
  return Object.freeze(result);
}

function freezeSnapshot(record, payload, annotations, capturedAt) {
  const selectedText = truncateUtf8(payload.selectedText, PDF_CONTEXT_LIMITS.selectedText);
  return Object.freeze({
    kind: selectedText.trim().length > 0 ? "pdf-selection" : "pdf-page",
    libraryId: record.libraryId,
    attachmentKey: record.attachmentKey,
    title: truncateUtf8(record.title, PDF_CONTEXT_LIMITS.title),
    pageIndex: payload.pageIndex,
    pageLabel: truncateUtf8(payload.pageLabel, PDF_CONTEXT_LIMITS.pageLabel),
    selectedText,
    pageText: truncateUtf8(payload.pageText, PDF_CONTEXT_LIMITS.pageText),
    annotations: snapshotAnnotations(annotations, payload.pageIndex),
    capturedAt,
  });
}

export class PdfContextBroker {
  #documents = new Map();
  #now;
  #activePanel = null;
  #snapshotOwners = new WeakMap();

  constructor({ now = Date.now } = {}) {
    if (typeof now !== "function") throw new TypeError("PDF context clock must be a function");
    this.#now = now;
  }

  open(documentUri, trustedRecord, panelNonce, annotations = Object.freeze([])) {
    const key = uriText(documentUri);
    validateRecord(key, trustedRecord);
    if (!PANEL_NONCE.test(panelNonce)) throw new TypeError("PDF context panel nonce is invalid");
    validateAnnotations(annotations);
    let panels = this.#documents.get(key);
    if (!panels) {
      panels = new Map();
      this.#documents.set(key, panels);
    }
    if (panels.has(panelNonce)) throw new Error("PDF context panel nonce is already active");
    const entry = {
      annotations,
      key,
      lastSequence: 0,
      panelNonce,
      record: trustedRecord,
      snapshot: null,
    };
    panels.set(panelNonce, entry);
    let disposed = false;
    return Object.freeze({
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.#activePanel?.entry === entry) this.#activePanel = null;
        if (panels.get(panelNonce) === entry) panels.delete(panelNonce);
        if (panels.size === 0 && this.#documents.get(key) === panels) this.#documents.delete(key);
      },
    });
  }

  update(documentUri, trustedRecord, panelNonce, value) {
    const key = uriText(documentUri);
    const panels = this.#documents.get(key);
    const entry = panels?.get(panelNonce);
    if (!entry) throw new Error("PDF context panel nonce is unavailable");
    if (entry.record !== trustedRecord) throw new Error("PDF context trusted record changed");
    const payload = exactPayload(value);
    if (payload.panelNonce !== panelNonce) throw new Error("PDF context payload nonce does not match its panel");
    if (payload.sequence !== entry.lastSequence + 1) throw new Error("PDF context sequence is not strictly monotonic");
    const capturedAt = new Date(this.#now()).toISOString();
    if (capturedAt === "Invalid Date") throw new Error("PDF context clock is invalid");
    const snapshot = freezeSnapshot(entry.record, payload, entry.annotations, capturedAt);
    entry.lastSequence = payload.sequence;
    entry.snapshot = snapshot;
    this.#snapshotOwners.set(snapshot, entry);
    return snapshot;
  }

  capture(documentUri, panelNonce) {
    const key = uriText(documentUri);
    const panels = this.#documents.get(key);
    let entry;
    if (panelNonce !== undefined) {
      if (!PANEL_NONCE.test(panelNonce)) throw new TypeError("PDF context panel nonce is invalid");
      entry = panels?.get(panelNonce);
    }
    else if (panels?.size === 1) {
      entry = panels.values().next().value;
    }
    if (!entry?.snapshot) throw new Error("PDF context is unavailable");
    return entry.snapshot;
  }

  activate(documentUri, panelNonce, active = true) {
    const key = uriText(documentUri);
    if (!PANEL_NONCE.test(panelNonce)) throw new TypeError("PDF context panel nonce is invalid");
    const entry = this.#documents.get(key)?.get(panelNonce);
    if (!entry) throw new Error("PDF context panel nonce is unavailable");
    if (active) this.#activePanel = { entry, key, panelNonce };
    else if (this.#activePanel?.entry === entry) this.#activePanel = null;
  }

  captureActive() {
    const active = this.#activePanel;
    if (!active || this.#documents.get(active.key)?.get(active.panelNonce) !== active.entry
        || !active.entry.snapshot) {
      throw new Error("Active PDF context is unavailable");
    }
    return active.entry.snapshot;
  }

  isAvailable(snapshot) {
    const entry = this.#snapshotOwners.get(snapshot);
    return !!entry && this.#documents.get(entry.key)?.get(entry.panelNonce) === entry;
  }

  list() {
    const snapshots = [];
    for (const panels of this.#documents.values()) {
      for (const entry of panels.values()) {
        if (entry.snapshot) snapshots.push(entry.snapshot);
      }
    }
    return Object.freeze(snapshots);
  }

  dispose() {
    this.#activePanel = null;
    this.#documents.clear();
  }
}
