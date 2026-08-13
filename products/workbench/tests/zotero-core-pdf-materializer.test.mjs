import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openCoreAttachmentSource } from "../extensions/chatero-zotero/core-attachment-source.mjs";
import { CoreAttachmentMaterializer, CorePdfMaterializer } from "../extensions/chatero-zotero/pdf-materializer.mjs";

const record = Object.freeze({
  annotationCount: 0,
  attachmentKey: "PDF00001",
  contentType: "application/pdf",
  filename: "paper.pdf",
  libraryId: 7,
  parentItemKey: "ITEM0001",
  title: "Paper",
});

function rpc(bytes, calls) {
  const sourceId = Buffer.alloc(32, 1).toString("base64url");
  return async (method, params) => {
    calls.push([method, params]);
    if (method === "attachment.open") return { expiresAt: Date.now() + 60_000, size: bytes.length, sourceId };
    if (method === "attachment.read") {
      const chunk = bytes.subarray(params.offset, params.offset + params.length);
      return { bytesBase64url: chunk.toString("base64url"), eof: params.offset + chunk.length === bytes.length };
    }
    if (method === "attachment.close") return { closed: true };
    throw new Error(`unexpected method ${method}`);
  };
}

test("Core attachment source exposes bounded bytes without accepting a filesystem path", async () => {
  const calls = [];
  const source = await openCoreAttachmentSource(record, { request: rpc(Buffer.from("%PDF"), calls) });
  assert.deepEqual(await source.read(0, 4), Uint8Array.from(Buffer.from("%PDF")));
  await source.close();
  assert.deepEqual(calls.map(value => value[0]), ["attachment.open", "attachment.read", "attachment.close"]);
  await assert.rejects(openCoreAttachmentSource(Object.freeze({ ...record, path: "/private/paper.pdf" }), {
    request: async () => { throw new Error("must not call Core"); },
  }), error => error.code === "UNAVAILABLE");
});

test("PDF materializer writes owner-only disposable content from bounded Core chunks", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "chatero-materializer-test-"));
  const rootDirectory = join(temporary, "cache");
  const bytes = Buffer.alloc(300_000, 0x41);
  bytes.set(Buffer.from("%PDF"), 0);
  const calls = [];
  const materializer = new CorePdfMaterializer({ request: rpc(bytes, calls), rootDirectory });
  const result = await materializer.materialize(record);

  assert.deepEqual(await readFile(result.path), bytes);
  assert.equal((await stat(rootDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  assert.equal(calls.filter(value => value[0] === "attachment.read").length, 2);
  assert.equal(calls.at(-1)[0], "attachment.close");
  await result.dispose();
  await assert.rejects(stat(result.path), error => error.code === "ENOENT");
});

test("attachment materializer accepts only Reader-supported Core content and never a path", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "chatero-reader-materializer-test-"));
  for (const [contentType, extension] of [["application/epub+zip", "epub"], ["text/html", "html"], ["application/xhtml+xml", "xhtml"]]) {
    const calls = [];
    const materializer = new CoreAttachmentMaterializer({ request: rpc(Buffer.from("reader"), calls), rootDirectory: join(temporary, extension) });
    const result = await materializer.materialize(Object.freeze({ ...record, contentType }));
    assert.match(result.path, new RegExp(`document\\.${extension}$`));
    assert.equal(Object.hasOwn(result, "record"), false);
    await result.dispose();
  }
  const materializer = new CoreAttachmentMaterializer({ request: async () => { throw new Error("must not call Core"); }, rootDirectory: temporary });
  await assert.rejects(materializer.materialize(Object.freeze({ ...record, contentType: "image/png" })), /unsupported/);
});
