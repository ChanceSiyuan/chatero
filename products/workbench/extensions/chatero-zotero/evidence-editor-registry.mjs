const evidenceKinds = Object.freeze({
  note: Object.freeze({
    keyField: "noteKey",
    leaf: "note.chatero-zotero-note",
    scheme: "chatero-zotero-note",
  }),
  pdf: Object.freeze({
    keyField: "attachmentKey",
    leaf: "paper.chatero-zotero-pdf",
    scheme: "chatero-zotero-pdf",
  }),
});

function uriText(uri) {
  const value = typeof uri === "string" ? uri : uri?.toString?.();
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Zotero evidence URI is invalid");
  }
  return value;
}

function canonicalUri({ kind, libraryId, key }) {
  const descriptor = evidenceKinds[kind];
  return `${descriptor.scheme}:/${libraryId}/${key}/${descriptor.leaf}`;
}

function identityFromRecord(kind, record) {
  const descriptor = evidenceKinds[kind];
  if (!descriptor || !record || typeof record !== "object" || !Object.isFrozen(record)) {
    throw new Error("Zotero evidence document is invalid");
  }
  if (!Number.isSafeInteger(record.libraryId) || record.libraryId < 1) {
    throw new Error("Zotero evidence library is invalid");
  }
  const key = record[descriptor.keyField];
  if (typeof key !== "string" || !/^[A-Z0-9]{8}$/.test(key)) {
    throw new Error("Zotero evidence key is invalid");
  }
  return Object.freeze({ kind, libraryId: record.libraryId, key });
}

function sameIdentity(identity, record) {
  try {
    const actual = identityFromRecord(identity.kind, record);
    return actual.libraryId === identity.libraryId && actual.key === identity.key;
  }
  catch (_) {
    return false;
  }
}

export function parseEvidenceDocumentUri(uri) {
  const value = uriText(uri);
  const match = /^(chatero-zotero-(pdf|note)):\/([1-9][0-9]*)\/([A-Z0-9]{8})\/(paper\.chatero-zotero-pdf|note\.chatero-zotero-note)$/.exec(value);
  if (!match) throw new Error("Zotero evidence URI is not canonical");
  const [, scheme, kind, rawLibraryId, key, leaf] = match;
  const libraryId = Number(rawLibraryId);
  const descriptor = evidenceKinds[kind];
  if (!Number.isSafeInteger(libraryId) || libraryId < 1
      || descriptor.scheme !== scheme || descriptor.leaf !== leaf) {
    throw new Error("Zotero evidence URI is not canonical");
  }
  const identity = Object.freeze({ kind, libraryId, key });
  if (canonicalUri(identity) !== value) throw new Error("Zotero evidence URI is not canonical");
  return identity;
}

export function createEnsureCore({ getCurrent, start } = {}) {
  if (typeof getCurrent !== "function" || typeof start !== "function") {
    throw new Error("ensureCore requires current-Core and startup functions");
  }
  let pending = null;
  return async function ensureCore() {
    const current = getCurrent();
    if (current) return current;
    if (!pending) pending = Promise.resolve().then(start);
    const launch = pending;
    try {
      return await launch;
    }
    finally {
      if (pending === launch) pending = null;
    }
  };
}

export function createEvidenceDocumentResolver({ ensureCore, getModel, registry } = {}) {
  if (typeof ensureCore !== "function" || typeof getModel !== "function"
      || !(registry instanceof EvidenceDocumentRegistry)) {
    throw new Error("Zotero evidence resolver requires Core access and a document registry");
  }
  return (uri, kind) => registry.resolveOrHydrate(uri, kind, async identity => {
    await ensureCore();
    const model = getModel();
    if (!model) {
      throw new Error("Zotero Core setup is required before restoring this evidence tab");
    }
    if (identity.kind === "pdf") {
      return model.attachment({ attachmentKey: identity.key, libraryId: identity.libraryId });
    }
    const restored = await model.note({ libraryId: identity.libraryId, noteKey: identity.key });
    return Object.freeze({
      libraryId: restored.libraryId,
      noteKey: restored.noteKey,
      parentItemKey: restored.parentItemKey,
      title: restored.title,
    });
  });
}

export class EvidenceDocumentRegistry {
  #documents = new Map();
  #hydrations = new Map();
  #epoch = 0;

  stage(kind, record) {
    const identity = identityFromRecord(kind, record);
    const uri = canonicalUri(identity);
    const existing = this.#documents.get(uri);
    if (existing && existing.record !== record) {
      throw new Error("A different Zotero evidence record already owns this document tab");
    }
    this.#documents.set(uri, Object.freeze({ kind, record }));
    return uri;
  }

  resolve(uri, kind) {
    const identity = parseEvidenceDocumentUri(uri);
    const key = canonicalUri(identity);
    const entry = this.#documents.get(key);
    if (!entry || entry.kind !== kind || identity.kind !== kind) {
      throw new Error("The evidence document does not belong to the active Zotero Core session");
    }
    return entry.record;
  }

  async resolveOrHydrate(uri, kind, resolver) {
    const identity = parseEvidenceDocumentUri(uri);
    if (identity.kind !== kind || !evidenceKinds[kind]) {
      throw new Error("The evidence document kind does not match its canonical URI");
    }
    const key = canonicalUri(identity);
    const existing = this.#documents.get(key);
    if (existing) return this.resolve(key, kind);
    if (typeof resolver !== "function") throw new Error("Zotero evidence hydration requires a resolver");
    const active = this.#hydrations.get(key);
    if (active) return active;
    const epoch = this.#epoch;
    const hydration = Promise.resolve().then(async () => {
      const record = await resolver(identity);
      if (epoch !== this.#epoch) {
        throw new Error("The active Zotero Core session changed while restoring evidence");
      }
      if (!sameIdentity(identity, record)) {
        throw new Error("Zotero Core returned a different evidence identity");
      }
      if (this.stage(kind, record) !== key) {
        throw new Error("Zotero Core returned a noncanonical evidence identity");
      }
      return this.resolve(key, kind);
    });
    this.#hydrations.set(key, hydration);
    try {
      return await hydration;
    }
    finally {
      if (this.#hydrations.get(key) === hydration) this.#hydrations.delete(key);
    }
  }

  reset() {
    this.#epoch += 1;
    this.#documents.clear();
    this.#hydrations.clear();
  }
}
