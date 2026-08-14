import { Buffer } from "node:buffer";

// Must stay in step with chateroCoreAttachmentSourceRegistry.mjs -- both sides validate it.
const MAX_READ_BYTES = 512 * 1024;
const SOURCE_ID = /^[A-Za-z0-9_-]{43}$/u;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function unavailable() {
  const error = new Error("The Zotero attachment source is unavailable");
  error.code = "UNAVAILABLE";
  return error;
}

function validateRecord(record) {
  const supportedContentTypes = new Set(["application/epub+zip", "application/pdf", "application/xhtml+xml", "text/html"]);
  if (!record || typeof record !== "object" || !Object.isFrozen(record)
      || !Number.isSafeInteger(record.libraryId) || record.libraryId < 1
      || typeof record.attachmentKey !== "string" || !/^[A-Z0-9]{8}$/u.test(record.attachmentKey)
      || !supportedContentTypes.has(record.contentType) || Object.hasOwn(record, "path")) {
    throw unavailable();
  }
}

function decodeChunk(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw unavailable();
  // Canonical unpadded base64url: the tail must not carry bits the decoded bytes drop.
  const remainder = value.length % 4;
  const trailing = BASE64URL_ALPHABET.indexOf(value[value.length - 1]);
  if (remainder === 1 || (remainder === 2 && trailing % 16 !== 0) || (remainder === 3 && trailing % 4 !== 0)) {
    throw unavailable();
  }
  // Copy out of the Buffer: Buffer.from(string) can hand back a slice of the shared pool.
  return Uint8Array.from(Buffer.from(value, "base64url"));
}

export async function openCoreAttachmentSource(record, { request } = {}) {
  validateRecord(record);
  if (typeof request !== "function") throw new TypeError("Core attachment source requires an RPC request function");
  const binding = Object.freeze({ attachmentKey: record.attachmentKey, libraryId: record.libraryId });
  const opened = await request("attachment.open", binding);
  if (!opened || typeof opened !== "object" || !SOURCE_ID.test(opened.sourceId)
      || !Number.isSafeInteger(opened.size) || opened.size < 1
      || !Number.isSafeInteger(opened.expiresAt) || opened.expiresAt <= Date.now()) {
    throw unavailable();
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await request("attachment.close", { sourceId: opened.sourceId });
  };
  return Object.freeze({
    size: opened.size,
    async read(offset, length) {
      if (closed || !Number.isSafeInteger(offset) || offset < 0 || offset >= opened.size
          || !Number.isSafeInteger(length) || length < 1 || length > MAX_READ_BYTES
          || offset + length > opened.size) {
        throw unavailable();
      }
      let result;
      try {
        result = await request("attachment.read", { ...binding, length, offset, sourceId: opened.sourceId });
      }
      catch (error) {
        closed = true;
        throw error;
      }
      const bytes = decodeChunk(result?.bytesBase64url);
      if (bytes.byteLength > length || offset + bytes.byteLength > opened.size
          || Boolean(result.eof) !== (offset + bytes.byteLength === opened.size)) {
        closed = true;
        throw unavailable();
      }
      return bytes;
    },
    close,
  });
}

export const CORE_ATTACHMENT_MAX_READ_BYTES = MAX_READ_BYTES;
