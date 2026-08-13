import { randomUUID } from "node:crypto";

function exactObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function safeInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be a safe integer of at least ${minimum}`);
  return value;
}

function boundedString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > 16 * 1024) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function validateCollection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.collectionKey !== "string" || value.collectionKey.length === 0
    || typeof value.name !== "string" || value.name.length === 0) {
    throw new Error("Zotero Core returned an invalid collection");
  }
  return Object.freeze({ ...value });
}

function validateItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.itemKey !== "string" || value.itemKey.length === 0
    || typeof value.title !== "string"
    || !Number.isSafeInteger(value.libraryId) || value.libraryId < 1
    || !Array.isArray(value.creators) || value.creators.some(creator => typeof creator !== "string")
    || typeof value.itemType !== "string" || value.itemType.length === 0
    || (value.version !== undefined && (!Number.isSafeInteger(value.version) || value.version < 0))) {
    throw new Error("Zotero Core returned an invalid item");
  }
  return Object.freeze({ ...value });
}

function validateLibrary(value) {
  exactObject(value, "Zotero library");
  for (const field of ["allowsLinkedFiles", "archived", "editable", "filesEditable", "syncable"]) {
    if (typeof value[field] !== "boolean") throw new Error(`Zotero library ${field} is invalid`);
  }
  for (const field of ["lastSync", "libraryId", "libraryVersion", "storageVersion"]) {
    safeInteger(value[field], `Zotero library ${field}`, { minimum: field === "libraryId" ? 1 : 0 });
  }
  boundedString(value.libraryType, "Zotero library type");
  boundedString(value.name, "Zotero library name");
  if (value.groupId !== undefined) safeInteger(value.groupId, "Zotero group id", { minimum: 1 });
  return Object.freeze({ ...value });
}

function validateSavedSearch(value) {
  exactObject(value, "Zotero saved search");
  safeInteger(value.libraryId, "Zotero saved search libraryId", { minimum: 1 });
  boundedString(value.name, "Zotero saved search name");
  boundedString(value.searchKey, "Zotero saved search key");
  if (typeof value.synced !== "boolean") throw new Error("Zotero saved search synced is invalid");
  safeInteger(value.version, "Zotero saved search version");
  return Object.freeze({ ...value });
}

function validateFeed(value) {
  exactObject(value, "Zotero feed");
  for (const field of ["cleanupReadAfter", "cleanupUnreadAfter", "lastCheck", "lastUpdate", "libraryId", "refreshInterval", "unreadCount"]) {
    safeInteger(value[field], `Zotero feed ${field}`, { minimum: field === "libraryId" ? 1 : 0 });
  }
  for (const field of ["lastCheckError", "name", "url"]) boundedString(value[field], `Zotero feed ${field}`, { allowEmpty: field === "lastCheckError" });
  if (typeof value.updating !== "boolean") throw new Error("Zotero feed updating is invalid");
  return Object.freeze({ ...value });
}

function validateSyncStatus(value) {
  exactObject(value, "Zotero sync status");
  if (!["enabled", "inProgress", "offline"].every(field => typeof value[field] === "boolean")
    || !Array.isArray(value.libraries) || typeof value.status !== "string") {
    throw new Error("Zotero Core returned invalid sync status");
  }
  const libraries = value.libraries.map(entry => {
    exactObject(entry, "Zotero sync library status");
    for (const field of ["lastSync", "libraryId", "libraryVersion", "storageVersion"]) {
      safeInteger(entry[field], `Zotero sync library ${field}`, { minimum: field === "libraryId" ? 1 : 0 });
    }
    if (!Array.isArray(entry.errors) || entry.errors.some(error => !error || typeof error.message !== "string" || typeof error.type !== "string")) {
      throw new Error("Zotero Core returned invalid sync errors");
    }
    return Object.freeze({ ...entry, errors: Object.freeze(entry.errors.map(error => Object.freeze({ ...error }))) });
  });
  if (value.lastSyncAt !== undefined) safeInteger(value.lastSyncAt, "Zotero sync lastSyncAt");
  return Object.freeze({ ...value, libraries: Object.freeze(libraries) });
}

function validateSearchResult(result) {
  if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0
    || (result.nextCursor !== undefined && typeof result.nextCursor !== "string")) {
    throw new Error("Zotero Core returned invalid Library items");
  }
  return Object.freeze({
    items: Object.freeze(result.items.map(validateItem)),
    ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
    total: result.total,
  });
}

function validateAttachment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.attachmentKey !== "string" || value.attachmentKey.length === 0
    || typeof value.title !== "string" || value.title.length === 0
    || Object.hasOwn(value, "path")
    || typeof value.contentType !== "string" || value.contentType.length === 0
    || !Number.isSafeInteger(value.annotationCount) || value.annotationCount < 0
    || !Number.isSafeInteger(value.libraryId) || value.libraryId < 1
    || typeof value.parentItemKey !== "string" || value.parentItemKey.length === 0) {
    throw new Error("Zotero Core returned an invalid attachment");
  }
  return Object.freeze({ ...value });
}

function validateNoteSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isSafeInteger(value.libraryId) || value.libraryId < 1
    || typeof value.noteKey !== "string" || value.noteKey.length === 0
    || typeof value.parentItemKey !== "string" || value.parentItemKey.length === 0
    || typeof value.title !== "string" || value.title.length === 0) {
    throw new Error("Zotero Core returned an invalid Note");
  }
  return Object.freeze({ ...value });
}

function validateAnnotation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.annotationKey !== "string" || value.annotationKey.length === 0
    || !Number.isSafeInteger(value.libraryId) || value.libraryId < 1
    || !["color", "comment", "pageLabel", "positionJson", "sortIndex", "text", "type"]
      .every(field => typeof value[field] === "string")) {
    throw new Error("Zotero Core returned an invalid annotation");
  }
  return Object.freeze({ ...value });
}

function validateItemMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.abstractNote !== "string"
    || !Array.isArray(value.creators) || value.creators.some(creator => typeof creator !== "string")
    || typeof value.date !== "string"
    || typeof value.itemKey !== "string" || value.itemKey.length === 0
    || typeof value.itemType !== "string" || value.itemType.length === 0
    || !Number.isSafeInteger(value.libraryId) || value.libraryId < 1
    || !Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== "string")
    || typeof value.title !== "string") {
    throw new Error("Zotero Core returned invalid item metadata");
  }
  for (const field of ["doi", "publicationTitle", "url"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`Zotero Core returned invalid item metadata ${field}`);
    }
  }
  if (value.year !== undefined && (!Number.isSafeInteger(value.year) || value.year < 0)) {
    throw new Error("Zotero Core returned invalid item metadata year");
  }
  return Object.freeze({ ...value });
}

export class LibraryTreeModel {
  #request;
  #idempotencyKey;
  #batchRevisions = new Map();
  #transactionRevisions = new Map();

  constructor({ request, idempotencyKey = () => `chatero-library-${randomUUID()}` }) {
    if (typeof request !== "function") throw new Error("LibraryTreeModel requires a request function");
    if (typeof idempotencyKey !== "function") throw new Error("LibraryTreeModel idempotencyKey must be a function");
    this.#request = request;
    this.#idempotencyKey = idempotencyKey;
  }

  async libraries() {
    const result = await this.#request("library.libraries", {});
    if (!result || !Array.isArray(result.libraries)) throw new Error("Zotero Core returned invalid libraries");
    return Object.freeze(result.libraries.map(validateLibrary));
  }

  async savedSearches({ libraryId }) {
    safeInteger(libraryId, "libraryId", { minimum: 1 });
    const result = await this.#request("library.saved-searches", { libraryId });
    if (!result || !Array.isArray(result.searches)) throw new Error("Zotero Core returned invalid saved searches");
    return Object.freeze(result.searches.map(validateSavedSearch));
  }

  async feeds() {
    const result = await this.#request("library.feeds", {});
    if (!result || !Array.isArray(result.feeds)) throw new Error("Zotero Core returned invalid feeds");
    return Object.freeze(result.feeds.map(validateFeed));
  }

  async syncStatus() {
    return validateSyncStatus(await this.#request("sync.status", {}));
  }

  request(method, params, options) {
    return this.#request(method, params, options);
  }

  async transact(method, params, { scope, options } = {}) {
    boundedString(method, "transaction method");
    boundedString(scope, "transaction scope");
    exactObject(params, "transaction params");
    const run = () => this.#request(method, {
      ...params,
      expectedRevision: this.#transactionRevisions.get(scope) || 0,
      idempotencyKey: this.#idempotencyKey(),
    }, options);
    let result;
    try { result = await run(); }
    catch (error) {
      const actual = error?.code === "CONFLICT" && error?.details?.kind === "REVISION_CONFLICT"
        ? error.details.actualRevision : undefined;
      if (!Number.isSafeInteger(actual) || actual < 0) throw error;
      this.#transactionRevisions.set(scope, actual);
      result = await run();
    }
    if (!result || !Number.isSafeInteger(result.revision) || result.revision < 1 || typeof result.replayed !== "boolean") {
      throw new Error("Zotero Core returned invalid transaction results");
    }
    this.#transactionRevisions.set(scope, result.revision);
    return result;
  }

  async collections({ libraryId, parentKey } = {}) {
    const result = await this.#request("library.collections", {
      ...(libraryId !== undefined && { libraryId }),
      ...(parentKey !== undefined && { parentKey }),
    });
    if (!result || !Array.isArray(result.collections)) throw new Error("Zotero Core returned invalid collections");
    return Object.freeze(result.collections.map(validateCollection));
  }

  async annotations({ attachmentKey, libraryId }) {
    const result = await this.#request("library.annotations", { attachmentKey, libraryId });
    if (!result || !Array.isArray(result.annotations)) throw new Error("Zotero Core returned invalid annotations");
    return Object.freeze(result.annotations.map(validateAnnotation));
  }

  async attachment({ attachmentKey, libraryId }) {
    const result = await this.#request("library.attachment", { attachmentKey, libraryId });
    return validateAttachment(result);
  }

  async children({ itemKey, libraryId }) {
    const result = await this.#request("library.item-children", { itemKey, libraryId });
    if (!result || !Array.isArray(result.attachments) || !Array.isArray(result.notes)) {
      throw new Error("Zotero Core returned invalid item children");
    }
    return Object.freeze({
      attachments: Object.freeze(result.attachments.map(validateAttachment)),
      notes: Object.freeze(result.notes.map(validateNoteSummary)),
    });
  }

  async items({ collectionKey, libraryId, query = "", limit = 50, cursor, sortBy, sortDirection } = {}) {
    const result = await this.#request("library.search", {
      ...(collectionKey !== undefined && { collectionKey }),
      ...(cursor !== undefined && { cursor }),
      ...(libraryId !== undefined && { libraryId }),
      ...(sortBy !== undefined && { sortBy }),
      ...(sortDirection !== undefined && { sortDirection }),
      limit,
      query,
    });
    return validateSearchResult(result);
  }

  async sourceItems({ source, query = "", limit = 50, cursor, sortBy, sortDirection } = {}) {
    exactObject(source, "Library source");
    safeInteger(source.libraryId, "Library source libraryId", { minimum: 1 });
    const page = {
      ...(cursor !== undefined && { cursor }),
      libraryId: source.libraryId,
      limit,
    };
    if (source.kind === "savedSearch") {
      boundedString(source.searchKey, "Library source searchKey");
      return validateSearchResult(await this.#request("library.saved-search-items", { ...page, searchKey: source.searchKey }));
    }
    if (source.kind === "duplicates") return validateSearchResult(await this.#request("library.duplicates", page));
    if (!["collection", "library", "trash", "unfiled", "feed"].includes(source.kind)) throw new Error("Library source kind is invalid");
    return validateSearchResult(await this.#request("library.search", {
      ...(source.collectionKey !== undefined && { collectionKey: source.collectionKey }),
      ...page,
      query,
      ...(source.kind !== "collection" && { scope: source.kind }),
      ...(sortBy !== undefined && { sortBy }),
      ...(sortDirection !== undefined && { sortDirection }),
    }));
  }

  async batchMutate({ libraryId, operations }) {
    safeInteger(libraryId, "batch libraryId", { minimum: 1 });
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 100) throw new Error("batch operations must contain 1 through 100 entries");
    for (const [index, operation] of operations.entries()) {
      if (!operation || typeof operation.kind !== "string" || !operation.params || operation.params.libraryId !== libraryId) {
        throw new Error(`batch operation ${index} must target library ${libraryId}`);
      }
    }
    const run = () => this.#request("library.batch-mutate", {
      expectedRevision: this.#batchRevisions.get(libraryId) || 0,
      idempotencyKey: this.#idempotencyKey(),
      libraryId,
      operations,
    });
    let result;
    try {
      result = await run();
    }
    catch (error) {
      const actual = error?.code === "CONFLICT" && error?.details?.kind === "REVISION_CONFLICT"
        ? error.details.actualRevision : undefined;
      if (!Number.isSafeInteger(actual) || actual < 0) throw error;
      this.#batchRevisions.set(libraryId, actual);
      result = await run();
    }
    if (!result || !Number.isSafeInteger(result.revision) || result.revision < 1 || !Array.isArray(result.results) || typeof result.replayed !== "boolean") {
      throw new Error("Zotero Core returned invalid batch mutation results");
    }
    this.#batchRevisions.set(libraryId, result.revision);
    return Object.freeze({ ...result, results: Object.freeze(result.results.map(value => Object.freeze({ ...value }))) });
  }

  async note({ libraryId, noteKey }) {
    const result = await this.#request("library.note", { libraryId, noteKey });
    const summary = validateNoteSummary(result);
    if (typeof result.html !== "string") throw new Error("Zotero Core returned invalid Note HTML");
    return Object.freeze({ ...summary, html: result.html });
  }

  async metadata({ itemKey, libraryId }) {
    const result = await this.#request("library.item-metadata", { itemKey, libraryId });
    return validateItemMetadata(result);
  }
}
