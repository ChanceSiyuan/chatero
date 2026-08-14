import assert from "node:assert/strict";
import { test } from "node:test";

import { createCoreAttachmentSourceRegistry } from "../../../chrome/content/zotero/xpcom/chateroCoreAttachmentSourceRegistry.mjs";

function source(bytes, closed) {
  return Object.freeze({
    size: bytes.length,
    async read(offset, length) { return bytes.slice(offset, offset + length); },
    async close() { closed.count += 1; },
  });
}

test("attachment sources are opaque, identity-bound, chunked, expiring, and explicitly closeable", async () => {
  let current = 1000;
  const timers = [];
  const closed = { count: 0 };
  const registry = createCoreAttachmentSourceRegistry({
    now: () => current,
    randomBytes: () => Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
  });

  const opened = registry.open({
    attachmentKey: "PDF00001",
    libraryId: 1,
    profileEpoch: "epoch-1",
    sessionToken: "session-token-0001",
    source: source(Uint8Array.from([1, 2, 3, 4]), closed),
  });
  assert.equal(opened.size, 4);
  assert.equal(opened.expiresAt, 61_000);
  assert.equal(Object.hasOwn(opened, "path"), false);
  assert.deepEqual(await registry.read({
    attachmentKey: "PDF00001",
    length: 2,
    libraryId: 1,
    offset: 1,
    profileEpoch: "epoch-1",
    sessionToken: "session-token-0001",
    sourceId: opened.sourceId,
  }), { bytesBase64url: "AgM", eof: false });
  assert.deepEqual(await registry.read({
    attachmentKey: "PDF00001",
    length: 1,
    libraryId: 1,
    offset: 3,
    profileEpoch: "epoch-1",
    sessionToken: "session-token-0001",
    sourceId: opened.sourceId,
  }), { bytesBase64url: "BA", eof: true });
  assert.deepEqual(await registry.close({ profileEpoch: "epoch-1", sessionToken: "session-token-0001", sourceId: opened.sourceId }), { closed: true });
  assert.equal(closed.count, 1);
  await assert.rejects(registry.read({
    attachmentKey: "PDF00001", length: 1, libraryId: 1, offset: 0, profileEpoch: "epoch-1", sessionToken: "session-token-0001", sourceId: opened.sourceId,
  }), error => error.code === "UNAVAILABLE");
});

test("wrong identity consumes a source and expiry closes it exactly once", async () => {
  const closed = { count: 0 };
  const timers = [];
  let sourceSequence = 6;
  const registry = createCoreAttachmentSourceRegistry({
    randomBytes: () => new Uint8Array(32).fill(++sourceSequence),
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
  });
  const opened = registry.open({ attachmentKey: "PDF00001", libraryId: 1, profileEpoch: "epoch-1", sessionToken: "session-token-0001", source: source(Uint8Array.of(1), closed) });

  await assert.rejects(registry.read({
    attachmentKey: "PDF00002", length: 1, libraryId: 1, offset: 0, profileEpoch: "epoch-1", sessionToken: "session-token-0001", sourceId: opened.sourceId,
  }), error => error.code === "UNAVAILABLE");
  await Promise.resolve();
  assert.equal(closed.count, 1);

  const expiring = registry.open({ attachmentKey: "PDF00001", libraryId: 1, profileEpoch: "epoch-1", sessionToken: "session-token-0001", source: source(Uint8Array.of(1), closed) });
  timers.at(-1)();
  await Promise.resolve();
  assert.equal(closed.count, 2);
  assert.deepEqual(await registry.close({ profileEpoch: "epoch-1", sessionToken: "session-token-0001", sourceId: expiring.sourceId }), { closed: false });
});

test("attachment source requests reject unknown fields and oversized reads", async () => {
  const registry = createCoreAttachmentSourceRegistry({ randomBytes: () => new Uint8Array(32).fill(9) });
  const opened = registry.open({ attachmentKey: "PDF00001", libraryId: 1, profileEpoch: "epoch-1", sessionToken: "session-token-0001", source: source(Uint8Array.of(1), { count: 0 }) });
  await assert.rejects(registry.read({
    attachmentKey: "PDF00001", extra: true, length: 1, libraryId: 1, offset: 0, profileEpoch: "epoch-1", sessionToken: "session-token-0001", sourceId: opened.sourceId,
  }), /unknown field/);
  await assert.rejects(registry.read({
    attachmentKey: "PDF00001", length: 524289, libraryId: 1, offset: 0, profileEpoch: "epoch-1", sessionToken: "session-token-0001", sourceId: opened.sourceId,
  }), /length/);
  await registry.dispose();
});

test("reads slide the source lease without exceeding its absolute lifetime", async () => {
  let current = 1000;
  const closed = { count: 0 };
  const timers = [];
  const registry = createCoreAttachmentSourceRegistry({
    now: () => current,
    randomBytes: () => new Uint8Array(32).fill(3),
    setTimeout: (callback, delay) => { timers.push({ armedAt: current, callback, delay }); return timers.length; },
    clearTimeout: () => {},
  });
  const opened = registry.open({
    attachmentKey: "PDF00001", libraryId: 1, profileEpoch: "epoch-1", sessionToken: "session-token-0001",
    source: source(Uint8Array.from([1, 2, 3, 4]), closed),
  });
  const ceiling = 1000 + 10 * 60_000;
  const read = () => registry.read({
    attachmentKey: "PDF00001", length: 1, libraryId: 1, offset: 0, profileEpoch: "epoch-1", sessionToken: "session-token-0001", sourceId: opened.sourceId,
  });

  // A read just before the original deadline slides it a full lifetime forward.
  current = 60_000;
  await read();
  assert.equal(timers.at(-1).delay, 60_000);

  // Continued reads keep the source usable far past that first deadline.
  while (current + 50_000 < ceiling) {
    current += 50_000;
    await read();
  }
  assert.equal(closed.count, 0);

  // The absolute ceiling still bounds every armed deadline, and expiry closes once.
  assert.ok(timers.every(timer => timer.armedAt + timer.delay <= ceiling));
  current = ceiling;
  await assert.rejects(read(), error => error.code === "UNAVAILABLE");
  await Promise.resolve();
  assert.equal(closed.count, 1);
});
