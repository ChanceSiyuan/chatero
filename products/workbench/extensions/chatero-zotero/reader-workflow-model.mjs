import { randomUUID } from "node:crypto";

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${label} must be a safe integer of at least ${minimum}`);
  return value;
}

function string(value, label, { empty = false, maximum = 1024 * 1024 } = {}) {
  if (typeof value !== "string" || (!empty && !value.length) || Buffer.byteLength(value, "utf8") > maximum) {
    throw new TypeError(`${label} must be a bounded string`);
  }
  return value;
}

function identity(value, label) {
  object(value, label);
  integer(value.libraryId, `${label} libraryId`, 1);
  string(value.attachmentKey, `${label} attachmentKey`, { maximum: 128 });
  return Object.freeze({ attachmentKey: value.attachmentKey, libraryId: value.libraryId });
}

function validateTags(value, label = "annotation tags") {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100 || value.some(tag => typeof tag !== "string" || !tag.length || Buffer.byteLength(tag, "utf8") > 1024)) {
    throw new TypeError(`${label} must be a bounded string array`);
  }
  return Object.freeze([...new Set(value)]);
}

function validateAttachment(value) {
  object(value, "Reader attachment");
  if (Object.hasOwn(value, "path")) throw new TypeError("Reader attachment must not expose a path");
  identity(value, "Reader attachment");
  string(value.contentType, "Reader contentType", { maximum: 256 });
  string(value.title, "Reader title");
  return Object.freeze({ ...value });
}

function validateState(value) {
  object(value, "Reader state");
  identity(value, "Reader state");
  string(value.contentType, "Reader state contentType", { maximum: 256 });
  integer(value.version, "Reader state version");
  if (value.pageIndex !== undefined) integer(value.pageIndex, "Reader state pageIndex");
  if (value.cfi !== undefined) string(value.cfi, "Reader state cfi", { maximum: 16 * 1024 });
  if (value.scrollYPercent !== undefined && (!Number.isFinite(value.scrollYPercent) || value.scrollYPercent < 0 || value.scrollYPercent > 100)) {
    throw new TypeError("Reader state scrollYPercent is invalid");
  }
  return Object.freeze({ ...value });
}

function validateAnnotation(value) {
  object(value, "Reader annotation");
  integer(value.libraryId, "Reader annotation libraryId", 1);
  integer(value.version, "Reader annotation version");
  for (const field of ["annotationKey", "color", "comment", "pageLabel", "positionJson", "sortIndex", "text", "type"]) {
    string(value[field], `Reader annotation ${field}`, { empty: ["comment", "pageLabel", "text"].includes(field), maximum: field === "positionJson" ? 256 * 1024 : 64 * 1024 });
  }
  for (const field of ["authorName", "dateCreated", "dateModified"]) {
    if (value[field] !== undefined) string(value[field], `Reader annotation ${field}`, { empty: field === "authorName", maximum: 64 * 1024 });
  }
  const tags = validateTags(value.tags) || Object.freeze([]);
  return Object.freeze({ ...value, tags });
}

function validateNote(value) {
  object(value, "Zotero Note");
  integer(value.libraryId, "Zotero Note libraryId", 1);
  integer(value.version, "Zotero Note version");
  for (const field of ["html", "noteKey", "parentItemKey", "title"]) string(value[field], `Zotero Note ${field}`, { empty: field === "html", maximum: field === "html" ? 1024 * 1024 : 16 * 1024 });
  return Object.freeze({ ...value });
}

function validateCitation(value) {
  object(value, "citation result");
  string(value.html, "citation html", { empty: true, maximum: 1024 * 1024 });
  string(value.text, "citation text", { empty: true, maximum: 1024 * 1024 });
  return Object.freeze({ html: value.html, text: value.text });
}

export class ReaderWorkflowModel {
  #core;
  #idempotencyKey;
  #revisions = new Map();
  #undo = [];
  #proposals = new Map();
  #identity = null;
  #attachment = null;
  #state = null;
  #annotations = [];

  constructor({ core, idempotencyKey = () => `chatero-reader-${randomUUID()}` }) {
    if (!core || typeof core.request !== "function") throw new TypeError("ReaderWorkflowModel requires a Core model");
    if (typeof idempotencyKey !== "function") throw new TypeError("ReaderWorkflowModel idempotencyKey must be a function");
    this.#core = core;
    this.#idempotencyKey = idempotencyKey;
  }

  get attachment() { return this.#attachment; }
  get state() { return this.#state; }
  get annotations() { return this.#annotations; }
  get proposals() { return Object.freeze([...this.#proposals.values()]); }

  async #transact(method, params, scope) {
    const run = () => this.#core.request(method, {
      ...params,
      expectedRevision: this.#revisions.get(scope) || 0,
      idempotencyKey: this.#idempotencyKey(),
    });
    let result;
    try { result = await run(); }
    catch (error) {
      const actual = error?.code === "CONFLICT" && error?.details?.kind === "REVISION_CONFLICT" ? error.details.actualRevision : undefined;
      if (!Number.isSafeInteger(actual) || actual < 0) throw error;
      this.#revisions.set(scope, actual);
      result = await run();
    }
    object(result, `${method} result`);
    integer(result.revision, `${method} revision`, 1);
    if (typeof result.replayed !== "boolean") throw new TypeError(`${method} replay state is invalid`);
    this.#revisions.set(scope, result.revision);
    return result;
  }

  async load(value) {
    if (typeof this.#core.attachment !== "function" || typeof this.#core.annotations !== "function") {
      throw new Error("Reader loading requires Core attachment and annotation capabilities");
    }
    const target = identity(value, "Reader identity");
    const [attachment, state, annotations] = await Promise.all([
      this.#core.attachment(target),
      this.#core.request("reader.state", target),
      this.#core.annotations(target),
    ]);
    this.#identity = target;
    this.#attachment = validateAttachment(attachment);
    this.#state = validateState(state);
    if (!Array.isArray(annotations)) throw new TypeError("Reader annotations must be an array");
    this.#annotations = Object.freeze(annotations.map(validateAnnotation));
    this.#undo = [];
    return Object.freeze({ annotations: this.#annotations, attachment: this.#attachment, state: this.#state });
  }

  async updateLocation({ cfi, pageIndex, scrollYPercent }) {
    if (!this.#identity || !this.#state) throw new Error("Reader is not loaded");
    if (pageIndex !== undefined) integer(pageIndex, "Reader pageIndex");
    if (cfi !== undefined) string(cfi, "Reader cfi", { maximum: 16 * 1024 });
    if (scrollYPercent !== undefined && (!Number.isFinite(scrollYPercent) || scrollYPercent < 0 || scrollYPercent > 100)) throw new TypeError("Reader scrollYPercent is invalid");
    const location = { cfi, pageIndex, scrollYPercent };
    const provided = Object.entries(location).filter(([, value]) => value !== undefined);
    const expected = this.#state.contentType === "application/pdf" ? "pageIndex"
      : this.#state.contentType === "application/epub+zip" ? "cfi" : "scrollYPercent";
    if (provided.length !== 1 || provided[0][0] !== expected) throw new TypeError(`Reader ${this.#state.contentType} location requires exactly ${expected}`);
    const scope = `library:${this.#identity.libraryId}/reader:${this.#identity.attachmentKey}`;
    const result = await this.#transact("reader.state-update", {
      ...this.#identity,
      expectedVersion: this.#state.version,
      ...(cfi !== undefined && { cfi }),
      ...(pageIndex !== undefined && { pageIndex }),
      ...(scrollYPercent !== undefined && { scrollYPercent }),
    }, scope);
    this.#state = validateState(result);
    return this.#state;
  }

  async #reloadAnnotations() {
    const annotations = await this.#core.annotations(this.#identity);
    if (!Array.isArray(annotations)) throw new TypeError("Reader annotations must be an array");
    this.#annotations = Object.freeze(annotations.map(validateAnnotation));
  }

  async createAnnotation(value) {
    if (!this.#identity) throw new Error("Reader is not loaded");
    object(value, "annotation create");
    const scope = `library:${this.#identity.libraryId}/attachment:${this.#identity.attachmentKey}`;
    const result = await this.#transact("library.annotation-mutate", {
      action: "create", ...this.#identity,
      color: string(value.color, "annotation color", { maximum: 32 }),
      comment: string(value.comment ?? "", "annotation comment", { empty: true, maximum: 64 * 1024 }),
      pageLabel: string(value.pageLabel ?? "", "annotation pageLabel", { empty: true, maximum: 1024 }),
      positionJson: string(value.positionJson, "annotation position", { maximum: 256 * 1024 }),
      sortIndex: string(value.sortIndex, "annotation sortIndex", { maximum: 1024 }),
      tags: validateTags(value.tags) || [],
      text: string(value.text ?? "", "annotation text", { empty: true, maximum: 64 * 1024 }),
      type: string(value.type, "annotation type", { maximum: 64 }),
    }, scope);
    const created = validateAnnotation(result.annotation);
    this.#annotations = Object.freeze([...this.#annotations, created]);
    this.#undo.push({ action: "trash", annotationKey: created.annotationKey, expectedVersion: created.version });
    return created;
  }

  async updateAnnotations(updates) {
    if (!this.#identity) throw new Error("Reader is not loaded");
    if (!Array.isArray(updates) || !updates.length || updates.length > 100) throw new TypeError("annotation updates must contain 1 through 100 entries");
    const prior = new Map(this.#annotations.map(value => [value.annotationKey, value]));
    const normalized = updates.map((value, index) => {
      object(value, `annotation update ${index}`);
      const before = prior.get(string(value.annotationKey, `annotation update ${index} key`, { maximum: 128 }));
      if (!before) throw new Error(`annotation ${value.annotationKey} is not loaded`);
      integer(value.expectedVersion, `annotation update ${index} expectedVersion`);
      const tags = validateTags(value.tags);
      if (!["color", "comment", "pageLabel", "positionJson", "sortIndex", "text", "type"].some(field => value[field] !== undefined) && tags === undefined) throw new TypeError(`annotation update ${index} has no changes`);
      return {
        annotationKey: value.annotationKey,
        expectedVersion: value.expectedVersion,
        ...(value.color !== undefined && { color: string(value.color, "annotation color", { maximum: 32 }) }),
        ...(value.comment !== undefined && { comment: string(value.comment, "annotation comment", { empty: true, maximum: 64 * 1024 }) }),
        ...(value.pageLabel !== undefined && { pageLabel: string(value.pageLabel, "annotation pageLabel", { empty: true, maximum: 1024 }) }),
        ...(value.positionJson !== undefined && { positionJson: string(value.positionJson, "annotation position", { maximum: 256 * 1024 }) }),
        ...(value.sortIndex !== undefined && { sortIndex: string(value.sortIndex, "annotation sortIndex", { maximum: 1024 }) }),
        ...(tags !== undefined && { tags }),
        ...(value.text !== undefined && { text: string(value.text, "annotation text", { empty: true, maximum: 64 * 1024 }) }),
        ...(value.type !== undefined && { type: string(value.type, "annotation type", { maximum: 64 }) }),
      };
    });
    const scope = `library:${this.#identity.libraryId}/attachment:${this.#identity.attachmentKey}`;
    const result = await this.#transact("library.annotations-update", { ...this.#identity, updates: normalized }, scope);
    const versions = new Map(result.annotations.map(value => [value.annotationKey, value.version]));
    this.#undo.push({ updates: normalized.map(value => {
      const before = prior.get(value.annotationKey);
      return { annotationKey: value.annotationKey, color: before.color, comment: before.comment, expectedVersion: versions.get(value.annotationKey), pageLabel: before.pageLabel, positionJson: before.positionJson, sortIndex: before.sortIndex, tags: before.tags, text: before.text, type: before.type };
    }) });
    await this.#reloadAnnotations();
    return result;
  }

  async mutateAnnotation({ action, annotationKey, expectedVersion }) {
    if (!this.#identity) throw new Error("Reader is not loaded");
    if (!new Set(["trash", "restore"]).has(action)) throw new TypeError("annotation action is invalid");
    string(annotationKey, "annotation key", { maximum: 128 });
    integer(expectedVersion, "annotation expectedVersion");
    const scope = `library:${this.#identity.libraryId}/attachment:${this.#identity.attachmentKey}`;
    const result = await this.#transact("library.annotation-mutate", { action, ...this.#identity, annotationKey, expectedVersion }, scope);
    this.#undo.push({ action: action === "trash" ? "restore" : "trash", annotationKey, expectedVersion: result.annotation.version });
    await this.#reloadAnnotations();
    return result;
  }

  async undo() {
    const operation = this.#undo.pop();
    if (!operation) return false;
    const restore = this.#undo;
    if (operation.updates) await this.updateAnnotations(operation.updates);
    else await this.mutateAnnotation(operation);
    restore.pop();
    return true;
  }

  reviewProposal(value) {
    object(value, "annotation proposal");
    string(value.proposalId, "annotation proposal id", { maximum: 128 });
    if (this.#proposals.has(value.proposalId)) throw new Error("annotation proposal id already exists");
    if (!Array.isArray(value.updates) || !value.updates.length || value.updates.length > 100) throw new TypeError("annotation proposal updates are invalid");
    const proposal = Object.freeze({ proposalId: value.proposalId, status: "pending-review", updates: Object.freeze(value.updates.map(update => Object.freeze({ ...update }))) });
    this.#proposals.set(proposal.proposalId, proposal);
    return proposal;
  }

  async applyProposal(proposalId) {
    const proposal = this.#proposals.get(proposalId);
    if (!proposal || proposal.status !== "pending-review") throw new Error("annotation proposal is unavailable");
    if (!this.#identity || typeof this.#core.batchMutate !== "function") throw new Error("Reader batch mutation is unavailable");
    const result = await this.#core.batchMutate({ libraryId: this.#identity.libraryId, operations: [{
      kind: "annotations-update",
      params: { ...this.#identity, updates: proposal.updates },
    }] });
    this.#proposals.set(proposalId, Object.freeze({ ...proposal, status: "applied" }));
    await this.#reloadAnnotations();
    return result;
  }

  async loadNote({ libraryId, noteKey }) {
    integer(libraryId, "Note libraryId", 1);
    string(noteKey, "Note key", { maximum: 128 });
    return validateNote(await this.#core.request("library.note", { libraryId, noteKey }));
  }

  async updateNote(value) {
    const note = validateNote(value);
    const scope = `library:${note.libraryId}/note:${note.noteKey}`;
    return this.#transact("library.note-update", {
      expectedVersion: note.version,
      html: note.html,
      libraryId: note.libraryId,
      noteKey: note.noteKey,
    }, scope);
  }

  async renderCitation({ identities, locale, mode, styleId }) {
    if (!Array.isArray(identities) || !identities.length || identities.length > 100) throw new TypeError("citation identities are invalid");
    for (const [index, value] of identities.entries()) {
      object(value, `citation identity ${index}`);
      integer(value.libraryId, `citation identity ${index} libraryId`, 1);
      string(value.itemKey, `citation identity ${index} itemKey`, { maximum: 128 });
    }
    if (!new Set(["bibliography", "citation"]).has(mode)) throw new TypeError("citation mode is invalid");
    string(styleId, "citation styleId", { maximum: 1024 });
    if (locale !== undefined) string(locale, "citation locale", { maximum: 64 });
    return validateCitation(await this.#core.request("citation.render", { identities, ...(locale !== undefined && { locale }), mode, styleId }));
  }
}
