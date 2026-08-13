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

test("subscribed background events serialize after an in-flight response", async () => {
  const writes = [];
  let listener;
  const connection = createGeckoCoreConnection({
    profileEpoch: "epoch",
    router: {
      async handle(message) {
        if (message.method === "core.handshake") return { result: { eventSequence: 0 } };
        listener({ occurredAt: 10, payload: {}, profileEpoch: "epoch", sequence: 1, topic: "zotero.item.modify" });
        return { result: { ok: true } };
      },
    },
    subscribeEvents: value => { listener = value; return () => {}; },
    write: async bytes => writes.push(bytes),
  });

  await connection.push(encodeGeckoFrame({ id: "handshake", method: "core.handshake" }));
  await connection.push(encodeGeckoFrame({ id: "request-1" }));
  assert.deepEqual(decodeFrames(writes), [
    { id: "handshake", ok: true, result: { eventSequence: 0 } },
    { id: "request-1", ok: true, result: { ok: true } },
    { event: true, occurredAt: 10, payload: {}, profileEpoch: "epoch", sequence: 1, topic: "zotero.item.modify" },
  ]);
});

test("subscribed events are withheld before authentication", async () => {
  const writes = [];
  let listener;
  const connection = createGeckoCoreConnection({
    profileEpoch: "epoch",
    router: { async handle() { return { result: { eventSequence: 3 } }; } },
    subscribeEvents: value => { listener = value; return () => {}; },
    write: async bytes => writes.push(bytes),
  });

  listener({ occurredAt: 10, payload: {}, profileEpoch: "epoch", sequence: 3, topic: "zotero.item.modify" });
  await connection.push(encodeGeckoFrame({ id: "handshake", method: "core.handshake" }));
  assert.deepEqual(decodeFrames(writes), [{ id: "handshake", ok: true, result: { eventSequence: 3 } }]);
});

test("background write failures notify the transport fatal callback", async () => {
  let listener;
  let fatal;
  let writes = 0;
  const fatalPromise = new Promise(resolve => { fatal = resolve; });
  const connection = createGeckoCoreConnection({
    onFatal: fatal,
    profileEpoch: "epoch",
    router: { async handle() { return { result: { eventSequence: 0 } }; } },
    subscribeEvents: value => { listener = value; return () => {}; },
    write: async () => {
      writes += 1;
      if (writes > 1) throw new Error("socket write failed");
    },
  });
  await connection.push(encodeGeckoFrame({ id: "handshake", method: "core.handshake" }));
  listener({ occurredAt: 10, payload: {}, profileEpoch: "epoch", sequence: 1, topic: "zotero.item.modify" });
  assert.match((await fatalPromise).message, /socket write failed/);
});
