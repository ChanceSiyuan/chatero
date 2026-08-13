import { createHash } from "node:crypto";

const ITEM_FIELDS = new Set(["attachmentCount", "creators", "itemKey", "itemType", "libraryId", "title", "version", "year"]);

export const ZOTERO_RESEARCH_COMMANDS = Object.freeze([
  Object.freeze(["chatero.zotero.research.selection", "getSelectionSnapshot"]),
  Object.freeze(["chatero.zotero.research.activeObject", "getActiveResearchObject"]),
  Object.freeze(["chatero.zotero.research.activeNote", "getActiveNoteSnapshot"]),
  Object.freeze(["chatero.zotero.research.bibliography", "exportBibliographySnapshot"]),
]);

export function registerZoteroResearchCommands({ commands, api } = {}) {
  if (typeof commands?.registerCommand !== "function" || !api
      || ZOTERO_RESEARCH_COMMANDS.some(([, method]) => typeof api[method] !== "function")) {
    throw new TypeError("Zotero Research command dependencies are invalid");
  }
  return Object.freeze(ZOTERO_RESEARCH_COMMANDS.map(([id, method]) =>
    commands.registerCommand(id, () => api[method]())));
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  const unknown = Object.keys(value).find(key => !fields.has(key));
  if (unknown) throw new TypeError(`${label} contains unknown field ${unknown}`);
  return value;
}

function bounded(value, label, maximum = 16 * 1024) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maximum) throw new TypeError(`${label} is invalid`);
  return value;
}

function identity(row) {
  exact(row, ITEM_FIELDS, "Zotero selection row");
  if (!/^[A-Z0-9]{8}$/u.test(row.itemKey) || !Number.isSafeInteger(row.libraryId) || row.libraryId < 1
      || !Number.isSafeInteger(row.version) || row.version < 0 || !Array.isArray(row.creators)
      || row.creators.some(value => typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024)
      || row.year !== undefined && (!Number.isSafeInteger(row.year) || row.year < 0 || row.year > 9999)) {
    throw new TypeError("Zotero selection row identity is invalid");
  }
  const payload = {
    creators: Object.freeze([...row.creators]),
    itemKey: row.itemKey,
    libraryId: row.libraryId,
    title: bounded(row.title, "Zotero item title"),
    ...(row.year !== undefined && { year: row.year }),
  };
  const revisionPayload = JSON.stringify({ ...payload, version: row.version });
  return Object.freeze({
    creators: payload.creators,
    itemKey: payload.itemKey,
    libraryId: payload.libraryId,
    revision: `sha256:${createHash("sha256").update(revisionPayload).digest("hex")}`,
    title: payload.title,
    ...(payload.year !== undefined && { year: payload.year }),
  });
}

function dependencies(value) {
  if (!value || typeof value.getSelectedRows !== "function" || typeof value.getActiveSource !== "function"
      || typeof value.getCore !== "function") throw new TypeError("Zotero Research API dependencies are invalid");
  return value;
}

export function createZoteroResearchApi(input = {}) {
  const deps = dependencies(input);
  const selection = () => {
    const rows = deps.getSelectedRows();
    if (!Array.isArray(rows) || rows.length > 32) throw new TypeError("Zotero selection is invalid");
    return Object.freeze(rows.map(identity));
  };
  const core = () => {
    const value = deps.getCore();
    if (!value || typeof value !== "object") throw new Error("Zotero Core is unavailable");
    return value;
  };
  return Object.freeze({
    async getSelectionSnapshot() { return selection(); },

    async getActiveResearchObject() {
      const selected = selection();
      if (selected.length > 0) {
        const { itemKey, libraryId, title } = selected[0];
        return Object.freeze({ kind: "item", itemKey, libraryId, title });
      }
      const source = deps.getActiveSource();
      if (!source) return null;
      exact(source, new Set(["collectionKey", "kind", "libraryId", "name"]), "Zotero source");
      if (!Number.isSafeInteger(source.libraryId) || source.libraryId < 1 || typeof source.kind !== "string") {
        throw new TypeError("Zotero source is invalid");
      }
      return Object.freeze({
        kind: "collection",
        itemKey: source.collectionKey ?? "LIBRARY0",
        libraryId: source.libraryId,
        title: bounded(source.name ?? "Zotero Library", "Zotero source title"),
      });
    },

    async getActiveNoteSnapshot() {
      if (typeof deps.getActiveNoteIdentity !== "function") throw new Error("No active Zotero Note");
      const value = deps.getActiveNoteIdentity();
      if (!value || !Number.isSafeInteger(value.libraryId) || value.libraryId < 1 || !/^[A-Z0-9]{8}$/u.test(value.noteKey)) {
        throw new TypeError("active Zotero Note identity is invalid");
      }
      const note = await core().note({ libraryId: value.libraryId, noteKey: value.noteKey });
      if (!note || note.libraryId !== value.libraryId || note.noteKey !== value.noteKey
          || !Number.isSafeInteger(note.version) || note.version < 0 || typeof note.html !== "string") {
        throw new TypeError("Zotero Core returned an invalid Note snapshot");
      }
      return Object.freeze({
        html: note.html,
        itemKey: note.noteKey,
        libraryId: note.libraryId,
        title: bounded(note.title, "Zotero Note title"),
        version: note.version,
      });
    },

    async exportBibliographySnapshot() {
      const records = selection();
      if (records.length === 0) throw new Error("Select at least one Zotero item");
      const model = core();
      if (typeof model.request !== "function") throw new Error("Zotero Core translation is unavailable");
      const result = await model.request("translation.translators", { kind: "export" });
      const bibtex = result?.translators?.find(value => /bibtex/iu.test(value?.label));
      if (!bibtex || typeof bibtex.translatorId !== "string") throw new Error("Zotero BibTeX translator is unavailable");
      const exported = await model.request("translation.export", {
        identities: records.map(value => ({ itemKey: value.itemKey, libraryId: value.libraryId })),
        translatorId: bibtex.translatorId,
      });
      if (typeof exported?.content !== "string" || Buffer.byteLength(exported.content, "utf8") > 16 * 1024 * 1024) {
        throw new TypeError("Zotero bibliography export is invalid");
      }
      const current = typeof deps.readCurrentBibliography === "function"
        ? await deps.readCurrentBibliography() : null;
      return Object.freeze({ bibliographyText: exported.content, current, records });
    },
  });
}
