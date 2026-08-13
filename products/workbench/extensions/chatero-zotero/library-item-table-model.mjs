const SORT_FIELDS = new Set(["creators", "itemType", "title", "year"]);
const SORT_DIRECTIONS = new Set(["asc", "desc"]);
const SOURCE_KINDS = new Set(["collection", "duplicates", "feed", "library", "savedSearch", "trash", "unfiled"]);

function identity(row) {
  return `${row.libraryId}/${row.itemKey}`;
}

function validateSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source) || !SOURCE_KINDS.has(source.kind)
    || !Number.isSafeInteger(source.libraryId) || source.libraryId < 1) {
    throw new Error("Library item table source is invalid");
  }
  return Object.freeze({ ...source });
}

function validateSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.rows) || !Array.isArray(value.selection)
    || !SORT_FIELDS.has(value.sortBy) || !SORT_DIRECTIONS.has(value.sortDirection)
    || typeof value.query !== "string" || !Number.isSafeInteger(value.total) || value.total < 0) {
    throw new Error("Library item table snapshot is invalid");
  }
  validateSource(value.source);
  if (value.nextCursor !== undefined && typeof value.nextCursor !== "string") throw new Error("Library item table cursor is invalid");
  const ids = new Set();
  for (const row of value.rows) {
    if (!row || !Number.isSafeInteger(row.libraryId) || typeof row.itemKey !== "string") throw new Error("Library item table row is invalid");
    if (ids.has(identity(row))) throw new Error("Library item table rows must be unique");
    ids.add(identity(row));
  }
  if (value.selection.some(id => typeof id !== "string" || !ids.has(id))) throw new Error("Library item table selection is invalid");
}

export class LibraryItemTableModel {
  #core;
  #pageSize;
  #rows = [];
  #selection = new Set();
  #source;
  #query = "";
  #nextCursor;
  #total = 0;
  #sortBy = "title";
  #sortDirection = "asc";

  constructor({ core, pageSize = 50 } = {}) {
    if (!core || typeof core.sourceItems !== "function" || typeof core.batchMutate !== "function") throw new Error("Library item table requires a Core model");
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("Library item table pageSize must be 1 through 100");
    this.#core = core;
    this.#pageSize = pageSize;
  }

  get rows() { return Object.freeze([...this.#rows]); }
  get core() { return this.#core; }
  get selectedRows() { return Object.freeze(this.#rows.filter(row => this.#selection.has(identity(row)))); }
  get source() { return this.#source; }
  get query() { return this.#query; }
  get nextCursor() { return this.#nextCursor; }
  get total() { return this.#total; }
  get sortBy() { return this.#sortBy; }
  get sortDirection() { return this.#sortDirection; }

  async open(source, { query = "", sortBy = "title", sortDirection = "asc" } = {}) {
    this.#source = validateSource(source);
    if (typeof query !== "string" || query.length > 1000) throw new Error("Library table query must be bounded");
    if (!SORT_FIELDS.has(sortBy) || !SORT_DIRECTIONS.has(sortDirection)) throw new Error("Library table sort is invalid");
    this.#query = query;
    this.#sortBy = sortBy;
    this.#sortDirection = sortDirection;
    this.#rows = [];
    this.#selection.clear();
    this.#nextCursor = undefined;
    this.#total = 0;
    await this.#load(undefined);
    return this.snapshot();
  }

  async #load(cursor) {
    const result = await this.#core.sourceItems({
      ...(cursor !== undefined && { cursor }),
      limit: this.#pageSize,
      query: this.#query,
      sortBy: this.#sortBy,
      sortDirection: this.#sortDirection,
      source: this.#source,
    });
    const existing = new Set(this.#rows.map(identity));
    for (const row of result.items) {
      if (existing.has(identity(row))) throw new Error("Zotero Core returned a duplicate paged item");
      existing.add(identity(row));
      this.#rows.push(row);
    }
    this.#nextCursor = result.nextCursor;
    this.#total = result.total;
  }

  async loadNext() {
    if (this.#nextCursor === undefined) return false;
    await this.#load(this.#nextCursor);
    return true;
  }

  async sort(sortBy, sortDirection = this.#sortDirection) {
    return this.open(this.#source, { query: this.#query, sortBy, sortDirection });
  }

  async search(query) {
    return this.open(this.#source, { query, sortBy: this.#sortBy, sortDirection: this.#sortDirection });
  }

  select(identities) {
    if (!Array.isArray(identities)) throw new Error("Library item table selection must be an array");
    const available = new Set(this.#rows.map(identity));
    if (identities.some(value => !available.has(value))) throw new Error("Library item table selection contains an unavailable row");
    this.#selection = new Set(identities);
  }

  async batch(action, { collectionKeys } = {}) {
    if (!["collections", "restore", "trash"].includes(action)) throw new Error("Library item batch action is invalid");
    const selected = this.selectedRows;
    if (!selected.length) throw new Error("Select at least one Zotero item");
    const libraryId = selected[0].libraryId;
    if (selected.some(row => row.libraryId !== libraryId)) throw new Error("Batch operations cannot cross Zotero libraries");
    if (selected.some(row => !Number.isSafeInteger(row.version) || row.version < 0)) throw new Error("Selected Zotero items are missing versions");
    if (action === "collections" && (!Array.isArray(collectionKeys) || collectionKeys.some(key => typeof key !== "string"))) {
      throw new Error("Batch collection keys are invalid");
    }
    return this.#core.batchMutate({
      libraryId,
      operations: selected.map(row => ({
        kind: "item-mutate",
        params: {
          action,
          ...(action === "collections" && { collectionKeys: [...collectionKeys] }),
          expectedVersion: row.version,
          itemKey: row.itemKey,
          libraryId,
        },
      })),
    });
  }

  snapshot() {
    if (!this.#source) throw new Error("Library item table has no active source");
    return Object.freeze({
      schemaVersion: 1,
      source: Object.freeze({ ...this.#source }),
      query: this.#query,
      sortBy: this.#sortBy,
      sortDirection: this.#sortDirection,
      rows: Object.freeze(this.#rows.map(row => Object.freeze({ ...row }))),
      selection: Object.freeze([...this.#selection]),
      ...(this.#nextCursor !== undefined && { nextCursor: this.#nextCursor }),
      total: this.#total,
    });
  }

  restore(snapshot) {
    validateSnapshot(snapshot);
    this.#source = Object.freeze({ ...snapshot.source });
    this.#query = snapshot.query;
    this.#sortBy = snapshot.sortBy;
    this.#sortDirection = snapshot.sortDirection;
    this.#rows = snapshot.rows.map(row => Object.freeze({ ...row }));
    this.#selection = new Set(snapshot.selection);
    this.#nextCursor = snapshot.nextCursor;
    this.#total = snapshot.total;
  }
}
