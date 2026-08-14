// Streams a local file into the Zotero Core attachment catalog over the
// attachment.upload-open/write/commit RPC surface. The Core caps each write at
// 256 KiB of raw bytes; this stays under it and follows the Core-reported
// nextOffset so a validated prefix is never resent.
const DEFAULT_CHUNK_BYTES = 192 * 1024;
const MAX_FILENAME_BYTES = 255;

const CONTENT_TYPES = Object.freeze({
  epub: "application/epub+zip",
  htm: "text/html",
  html: "text/html",
  pdf: "application/pdf",
});

export function attachmentContentType(filename) {
  const extension = /\.([A-Za-z0-9]+)$/u.exec(filename)?.[1]?.toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export function validateAttachmentFilename(filename) {
  if (typeof filename !== "string" || filename.length === 0 || filename.length > MAX_FILENAME_BYTES
      || /[\\/\0]/u.test(filename)) {
    throw new Error("attachment filename is invalid");
  }
  return filename;
}

export async function importFileAttachment({ core, libraryId, collectionKey, filename, bytes, chunkBytes = DEFAULT_CHUNK_BYTES } = {}) {
  if (!core || typeof core.request !== "function" || typeof core.transact !== "function") {
    throw new Error("attachment import requires a Zotero Core client");
  }
  if (!Number.isSafeInteger(libraryId) || libraryId < 1) throw new Error("attachment import libraryId is invalid");
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error("attachment import bytes are empty");
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 256 * 1024) throw new Error("attachment import chunk size is invalid");
  validateAttachmentFilename(filename);
  const opened = await core.request("attachment.upload-open", {
    byteCount: bytes.length,
    contentType: attachmentContentType(filename),
    filename,
  });
  if (typeof opened?.uploadId !== "string" || !opened.uploadId) throw new Error("Zotero Core did not open an attachment upload");
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes));
      const written = await core.request("attachment.upload-write", {
        bytesBase64url: Buffer.from(chunk).toString("base64url"),
        offset,
        uploadId: opened.uploadId,
      });
      if (!Number.isSafeInteger(written?.nextOffset) || written.nextOffset <= offset || written.nextOffset > bytes.length) {
        throw new Error("Zotero Core reported a non-advancing attachment upload");
      }
      offset = written.nextOffset;
    }
    const committed = await core.transact("attachment.upload-commit", {
      ...(collectionKey !== undefined && { collectionKeys: [collectionKey] }),
      libraryId,
      uploadId: opened.uploadId,
    }, { scope: `library:${libraryId}/attachment:catalog` });
    if (typeof committed?.attachmentKey !== "string" || !committed.attachmentKey) {
      throw new Error("Zotero Core did not report an imported attachment key");
    }
    return Object.freeze({ attachmentKey: committed.attachmentKey, libraryId: committed.libraryId });
  }
  catch (error) {
    await core.request("attachment.upload-abort", { uploadId: opened.uploadId }).catch(() => {});
    throw error;
  }
}

export function parseDroppedFileUris(text, parseUri) {
  if (typeof text !== "string" || typeof parseUri !== "function") return [];
  return text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .flatMap(line => {
      try {
        const uri = parseUri(line);
        return uri?.scheme === "file" ? [uri] : [];
      }
      catch {
        return [];
      }
    });
}
