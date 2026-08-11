import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

test("decodes multiple objects across arbitrary frame boundaries", async () => {
  const { FrameDecoder, encodeFrame } = await import("../transport/frame-codec.mjs");
  const first = encodeFrame({ id: "one", value: "α" });
  const second = encodeFrame({ id: "two", value: 2 });
  const bytes = Buffer.concat([first, second]);
  const decoder = new FrameDecoder();
  const messages = [];

  for (let index = 0; index < bytes.length; index += 3) {
    messages.push(...decoder.push(bytes.subarray(index, index + 3)));
  }
  decoder.end();

  assert.deepEqual(messages, [
    { id: "one", value: "α" },
    { id: "two", value: 2 },
  ]);
});

test("rejects non-objects, oversized input, invalid UTF-8, and duplicate keys", async () => {
  const { FrameDecoder, encodeFrame } = await import("../transport/frame-codec.mjs");
  assert.throws(() => encodeFrame(null), /plain object/);
  assert.throws(() => encodeFrame([]), /plain object/);
  assert.throws(() => encodeFrame({ value: "too large" }, { maxFrameBytes: 4 }), /exceeds/);

  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(9, 0);
  assert.throws(() => new FrameDecoder({ maxFrameBytes: 8 }).push(oversized), /exceeds/);

  const invalidUtf8 = Buffer.from([0xc3, 0x28]);
  const invalidFrame = Buffer.alloc(4 + invalidUtf8.length);
  invalidFrame.writeUInt32BE(invalidUtf8.length, 0);
  invalidUtf8.copy(invalidFrame, 4);
  assert.throws(() => new FrameDecoder().push(invalidFrame), /UTF-8/);

  const duplicate = Buffer.from('{"id":"one","id":"two"}', "utf8");
  const duplicateFrame = Buffer.alloc(4 + duplicate.length);
  duplicateFrame.writeUInt32BE(duplicate.length, 0);
  duplicate.copy(duplicateFrame, 4);
  assert.throws(() => new FrameDecoder().push(duplicateFrame), /duplicate JSON object key id/);
});

test("end rejects truncated headers and bodies", async () => {
  const { FrameDecoder, encodeFrame } = await import("../transport/frame-codec.mjs");
  const headerOnly = Buffer.alloc(4);
  headerOnly.writeUInt32BE(10, 0);
  const bodyDecoder = new FrameDecoder();
  bodyDecoder.push(headerOnly);
  assert.throws(() => bodyDecoder.end(), /truncated frame body/);

  const frame = encodeFrame({ ok: true });
  const headerDecoder = new FrameDecoder();
  headerDecoder.push(frame.subarray(0, 2));
  assert.throws(() => headerDecoder.end(), /truncated frame header/);
});

test("writeFrame waits for backpressure before resolving", async () => {
  const { writeFrame } = await import("../transport/frame-codec.mjs");
  class BackpressuredStream extends EventEmitter {
    writes = [];
    write(bytes) {
      this.writes.push(Buffer.from(bytes));
      return false;
    }
  }
  const stream = new BackpressuredStream();
  let resolved = false;
  const pending = writeFrame(stream, { id: "request" }).then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  stream.emit("drain");
  await pending;
  assert.equal(resolved, true);
  assert.equal(stream.writes.length, 1);
});
