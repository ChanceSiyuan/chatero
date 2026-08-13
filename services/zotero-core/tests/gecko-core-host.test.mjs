import assert from "node:assert/strict";
import { test } from "node:test";

import { GeckoFrameDecoder, encodeGeckoFrame } from "../../../chrome/content/zotero/xpcom/chateroCoreFrameCodec.mjs";
import { createGeckoCoreConnection } from "../../../chrome/content/zotero/xpcom/chateroCoreHost.mjs";

function decodeFrames(frames) {
  const decoder = new GeckoFrameDecoder();
  const messages = frames.flatMap(frame => decoder.push(frame));
  decoder.end();
  return messages;
}

test("connection emits a response followed by the Core-global monotonic event", async () => {
  const writes = [];
  const connection = createGeckoCoreConnection({
    profileEpoch: "epoch",
    router: {
      async handle(message) {
        return {
          event: { occurredAt: 10, payload: { source: message.id }, profileEpoch: "epoch", sequence: 7, topic: "library.changed" },
          result: { echoed: message.id },
        };
      },
    },
    write: async bytes => writes.push(bytes),
  });

  await connection.push(encodeGeckoFrame({ id: "request-1" }));
  assert.deepEqual(decodeFrames(writes), [
    { id: "request-1", ok: true, result: { echoed: "request-1" } },
    { event: true, occurredAt: 10, payload: { source: "request-1" }, profileEpoch: "epoch", sequence: 7, topic: "library.changed" },
  ]);
  connection.end();
});

test("connection bounds structured errors and remains usable", async () => {
  const writes = [];
  const connection = createGeckoCoreConnection({
    profileEpoch: "epoch",
    router: {
      async handle(message) {
        if (message.id === "bad") throw new Error("request params are invalid");
        return { result: { ok: true } };
      },
    },
    write: async bytes => writes.push(bytes),
  });
  const first = encodeGeckoFrame({ id: "bad" });
  const second = encodeGeckoFrame({ id: "good" });
  const bytes = new Uint8Array(first.length + second.length);
  bytes.set(first);
  bytes.set(second, first.length);

  await connection.push(bytes);
  assert.deepEqual(decodeFrames(writes), [
    { error: { code: "INVALID_PARAMS", message: "request params are invalid", retriable: false }, id: "bad", ok: false },
    { id: "good", ok: true, result: { ok: true } },
  ]);
  connection.end();
});

test("connection rejects malformed frames before invoking the router", async () => {
  let calls = 0;
  const connection = createGeckoCoreConnection({
    profileEpoch: "epoch",
    router: { async handle() { calls++; return { result: {} }; } },
    write: async () => {},
  });

  await assert.rejects(connection.push(Uint8Array.from([0, 0, 0, 0])), /cannot be zero/);
  assert.equal(calls, 0);
});

test("connection rejects a stale or cross-profile router event", async () => {
  const connection = createGeckoCoreConnection({
    profileEpoch: "epoch",
    router: {
      async handle() {
        return {
          event: { occurredAt: 10, payload: {}, profileEpoch: "other", sequence: 1, topic: "library.changed" },
          result: {},
        };
      },
    },
    write: async () => {},
  });

  await assert.rejects(connection.push(encodeGeckoFrame({ id: "request-1" })), /invalid event sequence/);
});
