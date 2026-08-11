const supportedKinds = new Set(["pdf", "note"]);

function pathComponent(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Zotero evidence ${field} is invalid`);
  }
  return encodeURIComponent(value);
}

function documentIdentity(kind, record) {
  if (!supportedKinds.has(kind) || !record || typeof record !== "object" || !Object.isFrozen(record)) {
    throw new Error("Zotero evidence document is invalid");
  }
  if (!Number.isSafeInteger(record.libraryId) || record.libraryId < 1) {
    throw new Error("Zotero evidence library is invalid");
  }
  const key = kind === "pdf" ? record.attachmentKey : record.noteKey;
  const leaf = kind === "pdf" ? "paper.chatero-zotero-pdf" : "note.chatero-zotero-note";
  return `chatero-zotero-${kind}:/${record.libraryId}/${pathComponent(key, "key")}/${leaf}`;
}

export class EvidenceDocumentRegistry {
  #documents = new Map();

  stage(kind, record) {
    const uri = documentIdentity(kind, record);
    const existing = this.#documents.get(uri);
    if (existing && existing.record !== record) {
      throw new Error("A different Zotero evidence record already owns this document tab");
    }
    this.#documents.set(uri, Object.freeze({ kind, record }));
    return uri;
  }

  resolve(uri, kind) {
    const key = typeof uri === "string" ? uri : uri?.toString?.();
    const entry = this.#documents.get(key);
    if (!entry || entry.kind !== kind) {
      throw new Error("The evidence document does not belong to the active Zotero Core session");
    }
    return entry.record;
  }

  reset() {
    this.#documents.clear();
  }
}
