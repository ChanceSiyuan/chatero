import assert from "node:assert/strict";
import { test } from "node:test";

import { createCoreAttachmentUploadRegistry } from "../../../chrome/content/zotero/xpcom/chateroCoreAttachmentUploadRegistry.mjs";

function harness() {
  const closed = [];
  const chunks = [];
  const registry = createCoreAttachmentUploadRegistry({
    createSink: byteCount => ({
      close() { closed.push(byteCount); },
      finish() { return { bytes: Uint8Array.from(chunks.flat()), close() {} }; },
      write(bytes) { chunks.push([...bytes]); },
    }),
    now: () => 1000,
    randomBytes: () => new Uint8Array(32).fill(7),
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  return { chunks, closed, registry };
}

test("attachment upload is session-bound, sequential, exact-length, and committed once", async () => {
  const { chunks, closed, registry } = harness();
  const binding = { profileEpoch: "epoch-1", sessionToken: "session-token-0001" };
  const opened = registry.open({ ...binding, byteCount: 4, contentType: "application/pdf", filename: "paper.pdf" });
  assert.deepEqual(registry.write({ ...binding, bytesBase64url: "AQI", offset: 0, uploadId: opened.uploadId }), { complete: false, nextOffset: 2 });
  await assert.rejects(async () => registry.write({ ...binding, bytesBase64url: "Aw", offset: 0, uploadId: opened.uploadId }), /sequential/);
  assert.deepEqual(registry.write({ ...binding, bytesBase64url: "AwQ", offset: 2, uploadId: opened.uploadId }), { complete: true, nextOffset: 4 });
  const result = await registry.commit({ ...binding, uploadId: opened.uploadId }, async entry => ({ byteCount: entry.byteCount, bytes: [...entry.stream.bytes] }));
  assert.deepEqual(result, { byteCount: 4, bytes: [1, 2, 3, 4] });
  assert.deepEqual(chunks, [[1, 2], [3, 4]]);
  assert.deepEqual(closed, [4]);
  await assert.rejects(registry.commit({ ...binding, uploadId: opened.uploadId }, async () => {}), error => error.code === "UNAVAILABLE");
});

test("incomplete, oversized, malformed, wrong-session, and aborted uploads fail closed", async () => {
  const { closed, registry } = harness();
  const binding = { profileEpoch: "epoch-1", sessionToken: "session-token-0001" };
  const opened = registry.open({ ...binding, byteCount: 2, contentType: "text/plain", filename: "note.txt" });
  registry.write({ ...binding, bytesBase64url: "AQ", offset: 0, uploadId: opened.uploadId });
  await assert.rejects(registry.commit({ ...binding, uploadId: opened.uploadId }, async () => {}), /incomplete/);
  assert.throws(() => registry.write({ ...binding, bytesBase64url: "***", offset: 1, uploadId: opened.uploadId }), /base64url/);
  assert.throws(() => registry.write({ ...binding, bytesBase64url: "AgM", offset: 1, uploadId: opened.uploadId }), /byteCount/);
  assert.throws(() => registry.abort({ ...binding, sessionToken: "wrong-session-0000", uploadId: opened.uploadId }), error => error.code === "UNAVAILABLE");
  assert.deepEqual(closed, [2]);
});
