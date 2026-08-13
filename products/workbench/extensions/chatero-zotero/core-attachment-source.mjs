import { Buffer } from "node:buffer";

const MAX_READ_BYTES = 256 * 1024;
const SOURCE_ID = /^[A-Za-z0-9_-]{43}$/u;

function unavailable() {
  const error = new Error("The Zotero attachment source is unavailable");
  error.code = "UNAVAILABLE";
  return error;
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || !Object.isFrozen(record)
      || !Number.isSafeInteger(record.libraryId) || record.libraryId < 1
      || typeof record.attachmentKey !== "string" || !/^[A-Z0-9]{8}$/u.test(record.attachmentKey)
      || record.contentType !== "application/pdf" || Object.hasOwn(record, "path")) {
    throw unavailable();
  }
}

function decodeChunk(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw unavailable();
  const bytes = Buffer.from(value, "base64url");
  if (!bytes.length || bytes.toString("base64url") !== value) throw unavailable();
  return Uint8Array.from(bytes);
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
