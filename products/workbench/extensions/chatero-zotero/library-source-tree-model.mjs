function source(kind, value, extra = {}) {
  return Object.freeze({ kind, value: Object.freeze({ ...value }), ...extra });
}

export class LibrarySourceTreeModel {
  #core;
  #feeds = [];
  #collections = null;

  constructor({ core } = {}) {
    if (!core || !["libraries", "collections", "feeds", "savedSearches", "syncStatus"].every(method => typeof core[method] === "function")) {
      throw new Error("Library source tree requires a complete Core model");
    }
    this.#core = core;
  }

  async roots() {
    this.#collections = null;
    const [libraries, feeds, sync] = await Promise.all([
      this.#core.libraries(),
      this.#core.feeds(),
      this.#core.syncStatus(),
    ]);
    this.#feeds = feeds;
    return Object.freeze([
      source("sync", sync),
      ...libraries.filter(value => value.libraryType !== "feed" && !value.archived)
        .map(value => source("library", value)),
      ...(feeds.length ? [source("feedGroup", { name: "Feeds", unreadCount: feeds.reduce((total, value) => total + value.unreadCount, 0) })] : []),
    ]);
  }

  async children(element) {
    if (!element || typeof element.kind !== "string") throw new Error("Library source tree element is invalid");
    if (element.kind === "feedGroup") return Object.freeze(this.#feeds.map(value => source("feed", value)));
    if (element.kind === "collection") {
      const collections = await this.#core.collections({ libraryId: element.value.libraryId, parentKey: element.value.collectionKey });
      return Object.freeze(collections.map(value => source("collection", value)));
    }
    if (element.kind !== "library") return Object.freeze([]);
    if (!this.#collections) {
      const pending = Promise.resolve(this.#core.collections()).catch(error => {
        if (this.#collections === pending) this.#collections = null;
        throw error;
      });
      this.#collections = pending;
    }
    const [collections, searches] = await Promise.all([
      this.#collections,
      this.#core.savedSearches({ libraryId: element.value.libraryId }),
    ]);
    const libraryCollections = collections.filter(value => value.libraryId === element.value.libraryId && !value.parentKey);
    return Object.freeze([
      ...libraryCollections.map(value => source("collection", value)),
      ...searches.map(value => source("savedSearch", value)),
      source("duplicates", { libraryId: element.value.libraryId, name: "Duplicate Items" }),
      source("unfiled", { libraryId: element.value.libraryId, name: "Unfiled Items" }),
      source("trash", { libraryId: element.value.libraryId, name: "Trash" }),
    ]);
  }

  toItemSource(element) {
    if (!element || !["collection", "duplicates", "feed", "library", "savedSearch", "trash", "unfiled"].includes(element.kind)) return null;
    return Object.freeze({
      kind: element.kind,
      libraryId: element.value.libraryId,
      ...(element.value.collectionKey && { collectionKey: element.value.collectionKey }),
      ...(element.value.searchKey && { searchKey: element.value.searchKey }),
    });
  }
}
