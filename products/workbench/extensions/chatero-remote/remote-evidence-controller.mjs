import { makeRemoteCacheAttachment } from "./evidence-cache.mjs";

function exactEvent(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function digestKey(targetId, digest) {
  return `${targetId}:${digest}`;
}

export class RemoteEvidenceController {
  #attach;
  #chips = new Map();
  #remove;
  #service;

  constructor({ service, attachTextContext, removeTextContext }) {
    if (!service || typeof service.stageEvidence !== "function"
        || typeof service.revokeEvidence !== "function" || typeof service.dispose !== "function"
        || typeof attachTextContext !== "function" || typeof removeTextContext !== "function") {
      throw new TypeError("remote evidence controller dependencies are invalid");
    }
    this.#service = service;
    this.#attach = attachTextContext;
    this.#remove = removeTextContext;
  }

  async stageEvidence(request, signal, onProgress) {
    const result = await this.#service.stageEvidence(request, signal, onProgress);
    let attachmentId;
    try {
      attachmentId = await this.#attach(makeRemoteCacheAttachment(result));
      if (typeof attachmentId !== "string" || attachmentId.length === 0) {
        throw new Error("native Chat did not return an attachment id");
      }
    }
    catch (_) {
      await this.#service.revokeEvidence({
        digest: result.digest,
        targetId: result.targetId,
      }).catch(() => {});
      throw new Error("Could not attach the remote PDF cache to native Chat");
    }
    const key = digestKey(result.targetId, result.digest);
    let paths = this.#chips.get(key);
    if (!paths) this.#chips.set(key, paths = new Map());
    let ids = paths.get(result.remotePath);
    if (!ids) paths.set(result.remotePath, ids = new Set());
    ids.add(attachmentId);
    return result;
  }

  async revokeEvidence(request, signal) {
    await this.#service.revokeEvidence(request, signal);
    await this.#removeDigest(request.targetId, request.digest);
  }

  async handleRevoked(rawEvent) {
    const event = exactEvent(rawEvent, ["digest", "hostFingerprint", "targetId"], "revoke event");
    await this.#removeDigest(event.targetId, event.digest);
  }

  async handleExpired(rawEvent) {
    const event = exactEvent(
      rawEvent,
      ["digest", "hostFingerprint", "remotePath", "targetId"],
      "expiry event",
    );
    const key = digestKey(event.targetId, event.digest);
    const paths = this.#chips.get(key);
    const ids = paths?.get(event.remotePath);
    if (!ids) return;
    paths.delete(event.remotePath);
    if (!paths.size) this.#chips.delete(key);
    await this.#removeIds(ids);
  }

  async #removeDigest(targetId, digest) {
    const key = digestKey(targetId, digest);
    const paths = this.#chips.get(key);
    if (!paths) return;
    this.#chips.delete(key);
    await this.#removeIds(new Set([...paths.values()].flatMap(ids => [...ids])));
  }

  async #removeIds(ids) {
    await Promise.allSettled([...ids].map(id => this.#remove(id)));
  }

  async dispose() {
    const ids = new Set();
    for (const paths of this.#chips.values()) {
      for (const values of paths.values()) for (const id of values) ids.add(id);
    }
    this.#chips.clear();
    await Promise.allSettled([this.#removeIds(ids), this.#service.dispose()]);
  }
}
