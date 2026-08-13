import { randomBytes as nodeRandomBytes } from "node:crypto";
import { openCoreAttachmentSource } from "./core-attachment-source.mjs";

const GRANT_LIFETIME_MS = 60_000;
const MAX_READ_BYTES = 256 * 1024;
const GRANT_ID = /^[A-Za-z0-9_-]{43}$/u;
const TARGET_ID = /^profile:[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,253}[A-Za-z0-9])?$/u;
const HOST_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}=?$/u;

function unavailable() {
  const error = new Error("The authorized PDF source is unavailable");
  error.code = "UNAVAILABLE";
  return error;
}

function isCanonicalGrantId(value) {
  if (typeof value !== "string" || !GRANT_ID.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

function assertBinding(targetId, hostFingerprint) {
  if (typeof targetId !== "string" || !TARGET_ID.test(targetId)
      || typeof hostFingerprint !== "string" || !HOST_FINGERPRINT.test(hostFingerprint)) {
    throw unavailable();
  }
}

function assertRedeemRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)
      || Object.getPrototypeOf(request) !== Object.prototype
      || Object.keys(request).sort().join(",") !== "grantId,hostFingerprint,targetId"
      || !isCanonicalGrantId(request.grantId)) {
    throw unavailable();
  }
  assertBinding(request.targetId, request.hostFingerprint);
  return request;
}

function assertSource(source) {
  if (!source || typeof source !== "object"
      || !Number.isSafeInteger(source.size) || source.size < 1
      || typeof source.read !== "function" || typeof source.close !== "function"
      || Object.keys(source).sort().join(",") !== "close,read,size") {
    throw new TypeError("authorized PDF source is invalid");
  }
  return source;
}

function makeControlledSource(source, onClose) {
  let closed = false;
  let closePromise = null;
  const close = () => {
    if (!closePromise) {
      closed = true;
      closePromise = Promise.resolve().then(() => source.close()).finally(onClose);
    }
    return closePromise;
  };
  return Object.freeze({
    size: source.size,
    async read(offset, length) {
      if (closed) throw unavailable();
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.size
          || !Number.isSafeInteger(length) || length < 1 || length > MAX_READ_BYTES
          || offset + length > source.size) {
        throw new TypeError("authorized PDF read range is invalid");
      }
      const chunk = await source.read(offset, length);
      if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1 || chunk.byteLength > length
          || offset + chunk.byteLength > source.size) {
        throw new Error("authorized PDF source returned invalid bytes");
      }
      return Uint8Array.from(chunk);
    },
    close,
  });
}

export async function openAuthorizedPdfSource(record, { request } = {}) {
  return openCoreAttachmentSource(record, { request });
}

export class AuthorizedPdfSourceRegistry {
  #active = new Set();
  #clearTimeout;
  #closing = new Set();
  #disposed = false;
  #now;
  #pending = new Map();
  #randomBytes;
  #setTimeout;
  #spent = new Set();

  constructor({
    now = Date.now,
    randomBytes = nodeRandomBytes,
    setTimeout = globalThis.setTimeout,
    clearTimeout = globalThis.clearTimeout,
  } = {}) {
    if (typeof now !== "function" || typeof randomBytes !== "function"
        || typeof setTimeout !== "function" || typeof clearTimeout !== "function") {
      throw new TypeError("authorized PDF registry dependencies are invalid");
    }
    this.#now = now;
    this.#randomBytes = randomBytes;
    this.#setTimeout = setTimeout;
    this.#clearTimeout = clearTimeout;
  }

  #trackClose(source) {
    const closing = Promise.resolve().then(() => source.close());
    this.#closing.add(closing);
    void closing.finally(() => this.#closing.delete(closing)).catch(() => {});
    return closing;
  }

  #consume(grantId, { close = false } = {}) {
    const entry = this.#pending.get(grantId);
    if (!entry) return null;
    this.#pending.delete(grantId);
    this.#spent.add(grantId);
    this.#clearTimeout(entry.timer);
    if (close) this.#trackClose(entry.source);
    return entry;
  }

  issue({ source, targetId, hostFingerprint } = {}) {
    assertSource(source);
    try {
      if (this.#disposed) throw unavailable();
      assertBinding(targetId, hostFingerprint);
      let grantId;
      for (let attempt = 0; attempt < 8; attempt++) {
        const entropy = this.#randomBytes(32);
        if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 32) {
          throw new Error("PDF grant entropy source returned invalid material");
        }
        grantId = Buffer.from(entropy).toString("base64url");
        if (isCanonicalGrantId(grantId) && !this.#pending.has(grantId)
            && !this.#spent.has(grantId)) break;
        grantId = null;
      }
      if (!grantId) throw new Error("Could not allocate a unique PDF grant");
      const expiresAt = this.#now() + GRANT_LIFETIME_MS;
      const timer = this.#setTimeout(() => {
        this.#consume(grantId, { close: true });
      }, GRANT_LIFETIME_MS);
      timer?.unref?.();
      this.#pending.set(grantId, Object.freeze({
        expiresAt,
        hostFingerprint,
        source,
        targetId,
        timer,
      }));
      return grantId;
    }
    catch (error) {
      this.#trackClose(source);
      throw error;
    }
  }

  redeem(rawRequest) {
    const { grantId, targetId, hostFingerprint } = assertRedeemRequest(rawRequest);
    if (this.#disposed) throw unavailable();
    const entry = this.#consume(grantId);
    if (!entry) throw unavailable();
    if (this.#now() >= entry.expiresAt
        || targetId !== entry.targetId || hostFingerprint !== entry.hostFingerprint) {
      this.#trackClose(entry.source);
      throw unavailable();
    }
    let controlled;
    controlled = makeControlledSource(entry.source, () => {
      this.#active.delete(controlled);
    });
    this.#active.add(controlled);
    return controlled;
  }

  async revokePending() {
    const entries = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [grantId, entry] of entries) {
      this.#clearTimeout(entry.timer);
      this.#spent.add(grantId);
      this.#trackClose(entry.source);
    }
    await this.drain();
  }

  async drain() {
    while (this.#closing.size) {
      await Promise.allSettled([...this.#closing]);
    }
  }

  async revoke(grantId) {
    if (!isCanonicalGrantId(grantId)) throw unavailable();
    const entry = this.#consume(grantId, { close: true });
    await this.drain();
    return Boolean(entry);
  }

  async dispose() {
    if (!this.#disposed) {
      this.#disposed = true;
      const pending = [...this.#pending.values()];
      this.#pending.clear();
      for (const entry of pending) {
        this.#clearTimeout(entry.timer);
        this.#trackClose(entry.source);
      }
      for (const source of [...this.#active]) this.#trackClose(source);
      this.#spent.clear();
    }
    await this.drain();
  }
}

export const AUTHORIZED_PDF_GRANT_LIFETIME_MS = GRANT_LIFETIME_MS;
