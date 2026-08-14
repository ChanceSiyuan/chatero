import assert from "node:assert/strict";
import { test } from "node:test";

function fakeCore({ nonAdvancingFromOffset, failCommit } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      if (method === "attachment.upload-open") return { expiresAt: 1, nextOffset: 0, uploadId: "upload-1" };
      if (method === "attachment.upload-write") {
        if (nonAdvancingFromOffset !== undefined && params.offset >= nonAdvancingFromOffset) {
          return { complete: false, nextOffset: params.offset };
        }
        const bytes = Buffer.from(params.bytesBase64url, "base64url");
        return { complete: false, nextOffset: params.offset + bytes.length };
      }
      if (method === "attachment.upload-abort") return {};
      throw new Error(`unexpected request ${method}`);
    },
    async transact(method, params, options) {
      calls.push({ method, options, params });
      if (failCommit) throw new Error("catalog rejected the upload");
      return { attachmentKey: "ATTACH01", libraryId: params.libraryId, replayed: false, revision: 7 };
    },
  };
}

test("maps reader-supported extensions to exact content types and validates filenames", async () => {
  const { attachmentContentType, validateAttachmentFilename } = await import("../extensions/chatero-zotero/attachment-import.mjs");
  assert.equal(attachmentContentType("demo.epub"), "application/epub+zip");
  assert.equal(attachmentContentType("Paper.PDF"), "application/pdf");
  assert.equal(attachmentContentType("snapshot.html"), "text/html");
  assert.equal(attachmentContentType("data.bin"), "application/octet-stream");
  assert.equal(attachmentContentType("no-extension"), "application/octet-stream");
  assert.equal(validateAttachmentFilename("demo.epub"), "demo.epub");
  for (const bad of ["", "a/b.pdf", "a\\b.pdf", "nul\0.pdf", "x".repeat(256)]) {
    assert.throws(() => validateAttachmentFilename(bad), /attachment filename is invalid/u, JSON.stringify(bad));
  }
});

test("streams bounded sequential chunks and commits through the transaction journal", async () => {
  const { importFileAttachment } = await import("../extensions/chatero-zotero/attachment-import.mjs");
  const core = fakeCore();
  const bytes = new Uint8Array(10).map((_, index) => index + 1);

  const result = await importFileAttachment({
    core,
    libraryId: 3,
    collectionKey: "COLL0001",
    filename: "demo.epub",
    bytes,
    chunkBytes: 4,
  });

  assert.deepEqual(result, { attachmentKey: "ATTACH01", libraryId: 3 });
  assert.ok(Object.isFrozen(result));
  const open = core.calls[0];
  assert.equal(open.method, "attachment.upload-open");
  assert.deepEqual(open.params, { byteCount: 10, contentType: "application/epub+zip", filename: "demo.epub" });
  const writes = core.calls.filter(call => call.method === "attachment.upload-write");
  assert.deepEqual(writes.map(call => call.params.offset), [0, 4, 8]);
  const reassembled = Buffer.concat(writes.map(call => Buffer.from(call.params.bytesBase64url, "base64url")));
  assert.deepEqual([...reassembled], [...bytes]);
  for (const call of writes) assert.equal(call.params.bytesBase64url.includes("="), false);
  const commit = core.calls.at(-1);
  assert.equal(commit.method, "attachment.upload-commit");
  assert.deepEqual(commit.params, { collectionKeys: ["COLL0001"], libraryId: 3, uploadId: "upload-1" });
  assert.deepEqual(commit.options, { scope: "library:3/attachment:catalog" });
  assert.equal(core.calls.some(call => call.method === "attachment.upload-abort"), false);
});

test("omits collectionKeys for library-level imports", async () => {
  const { importFileAttachment } = await import("../extensions/chatero-zotero/attachment-import.mjs");
  const core = fakeCore();
  await importFileAttachment({ core, libraryId: 1, filename: "paper.pdf", bytes: new Uint8Array([1, 2, 3]) });
  const commit = core.calls.at(-1);
  assert.deepEqual(commit.params, { libraryId: 1, uploadId: "upload-1" });
});

test("aborts the upload when the Core stops advancing or the commit fails", async () => {
  const { importFileAttachment } = await import("../extensions/chatero-zotero/attachment-import.mjs");

  const stalled = fakeCore({ nonAdvancingFromOffset: 4 });
  await assert.rejects(importFileAttachment({
    core: stalled, libraryId: 1, filename: "paper.pdf", bytes: new Uint8Array(10), chunkBytes: 4,
  }), /non-advancing attachment upload/u);
  assert.equal(stalled.calls.at(-1).method, "attachment.upload-abort");
  assert.deepEqual(stalled.calls.at(-1).params, { uploadId: "upload-1" });

  const rejected = fakeCore({ failCommit: true });
  await assert.rejects(importFileAttachment({
    core: rejected, libraryId: 1, filename: "paper.pdf", bytes: new Uint8Array(3),
  }), /catalog rejected the upload/u);
  assert.equal(rejected.calls.at(-1).method, "attachment.upload-abort");
});

test("rejects invalid clients, libraries, byte payloads, and chunk sizes before opening an upload", async () => {
  const { importFileAttachment } = await import("../extensions/chatero-zotero/attachment-import.mjs");
  const core = fakeCore();
  await assert.rejects(importFileAttachment({ core: {}, libraryId: 1, filename: "a.pdf", bytes: new Uint8Array(1) }), /Zotero Core client/u);
  await assert.rejects(importFileAttachment({ core, libraryId: 0, filename: "a.pdf", bytes: new Uint8Array(1) }), /libraryId is invalid/u);
  await assert.rejects(importFileAttachment({ core, libraryId: 1, filename: "a.pdf", bytes: new Uint8Array(0) }), /bytes are empty/u);
  await assert.rejects(importFileAttachment({ core, libraryId: 1, filename: "a.pdf", bytes: new Uint8Array(1), chunkBytes: 512 * 1024 }), /chunk size is invalid/u);
  assert.deepEqual(core.calls, []);
});

test("parses dropped uri-lists into local file uris only", async () => {
  const { parseDroppedFileUris } = await import("../extensions/chatero-zotero/attachment-import.mjs");
  const parseUri = value => {
    const match = /^([a-z+-]+):\/\/(.*)$/u.exec(value);
    if (!match) throw new Error("invalid uri");
    return { scheme: match[1], path: `/${match[2].replace(/^\/+/u, "")}` };
  };
  const text = [
    "# dragged from Finder",
    "file:///Users/dev/demo.epub\r",
    "https://example.invalid/paper.pdf",
    "",
    "not a uri",
    "file:///Users/dev/paper.pdf",
  ].join("\n");
  const uris = parseDroppedFileUris(text, parseUri);
  assert.deepEqual(uris.map(uri => uri.path), ["/Users/dev/demo.epub", "/Users/dev/paper.pdf"]);
  assert.deepEqual(parseDroppedFileUris(undefined, parseUri), []);
  assert.deepEqual(parseDroppedFileUris("file:///x", "not-a-function"), []);
});
