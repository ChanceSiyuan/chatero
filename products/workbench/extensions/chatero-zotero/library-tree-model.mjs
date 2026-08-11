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

export class LibraryTreeModel {
  #request;

  constructor({ request }) {
    if (typeof request !== "function") throw new Error("LibraryTreeModel requires a request function");
    this.#request = request;
  }

  async collections(parentKey) {
    const result = await this.#request("library.collections", {
      ...(parentKey !== undefined && { parentKey }),
    });
    if (!result || !Array.isArray(result.collections)) throw new Error("Zotero Core returned invalid collections");
    return Object.freeze(result.collections.map(validateCollection));
  }

  async items({ collectionKey, query = "", limit = 50, cursor } = {}) {
    const result = await this.#request("library.search", {
      ...(collectionKey !== undefined && { collectionKey }),
      ...(cursor !== undefined && { cursor }),
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
}
