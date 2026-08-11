export class EvidenceRecordAuthority {
  #records = new WeakMap();

  register(record, kind) {
    if (!record || typeof record !== "object" || !Object.isFrozen(record)) {
      throw new Error("Zotero evidence records must be frozen objects");
    }
    if (!new Set(["attachment", "note"]).has(kind)) {
      throw new Error("Zotero evidence record kind is invalid");
    }
    this.#records.set(record, kind);
    return record;
  }

  authorize(record, kind) {
    if (!record || typeof record !== "object" || this.#records.get(record) !== kind) {
      throw new Error("The evidence record does not belong to the active Zotero Core session");
    }
    return record;
  }

  reset() {
    this.#records = new WeakMap();
  }
}
