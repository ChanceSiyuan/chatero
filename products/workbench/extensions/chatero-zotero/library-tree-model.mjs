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
    || typeof value.title !== "string") {
    throw new Error("Zotero Core returned an invalid item");
  }
  return Object.freeze({ ...value });
}

function validateAttachment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.attachmentKey !== "string" || value.attachmentKey.length === 0
    || typeof value.title !== "string" || value.title.length === 0
    || typeof value.path !== "string" || !value.path.startsWith("/")
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

export class LibraryTreeModel {
  #request;

  constructor({ request }) {
    if (typeof request !== "function") throw new Error("LibraryTreeModel requires a request function");
    this.#request = request;
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

  async items({ collectionKey, libraryId, query = "", limit = 50, cursor } = {}) {
    const result = await this.#request("library.search", {
      ...(collectionKey !== undefined && { collectionKey }),
      ...(cursor !== undefined && { cursor }),
      ...(libraryId !== undefined && { libraryId }),
      limit,
      query,
    });
    if (!result || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0) {
      throw new Error("Zotero Core returned invalid Library items");
    }
    return Object.freeze({
      items: Object.freeze(result.items.map(validateItem)),
      ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
      total: result.total,
    });
  }

  async note({ libraryId, noteKey }) {
    const result = await this.#request("library.note", { libraryId, noteKey });
    const summary = validateNoteSummary(result);
    if (typeof result.html !== "string") throw new Error("Zotero Core returned invalid Note HTML");
    return Object.freeze({ ...summary, html: result.html });
  }
}
