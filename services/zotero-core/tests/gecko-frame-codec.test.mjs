import assert from "node:assert/strict";
import { test } from "node:test";

import { GeckoFrameDecoder, encodeGeckoFrame } from "../../../chrome/content/zotero/xpcom/chateroCoreFrameCodec.mjs";
import { encodeFrame } from "../transport/frame-codec.mjs";

test("Gecko and Node encode byte-identical Core frames", () => {
  const value = { id: "α", method: "profile.status", params: {} };
  assert.deepEqual(Buffer.from(encodeGeckoFrame(value)), encodeFrame(value));
});

test("Gecko decoder preserves arbitrary frame boundaries and multiple messages", () => {
  const first = encodeGeckoFrame({ id: "one" });
  const second = encodeGeckoFrame({ id: "two" });
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first);
  joined.set(second, first.length);
  const decoder = new GeckoFrameDecoder();

  assert.deepEqual(decoder.push(joined.slice(0, 3)), []);
  assert.deepEqual(decoder.push(joined.slice(3, first.length + 2)), [{ id: "one" }]);
  assert.deepEqual(decoder.push(joined.slice(first.length + 2)), [{ id: "two" }]);
  decoder.end();
});

test("Gecko decoder rejects duplicate keys, invalid UTF-8, oversized and truncated frames", () => {
  const duplicate = new TextEncoder().encode('{"id":"one","id":"two"}');
  const duplicateFrame = new Uint8Array(4 + duplicate.length);
  new DataView(duplicateFrame.buffer).setUint32(0, duplicate.length, false);
  duplicateFrame.set(duplicate, 4);
  assert.throws(() => new GeckoFrameDecoder().push(duplicateFrame), /duplicate JSON object key/);

  const invalid = Uint8Array.from([0, 0, 0, 2, 0xc3, 0x28]);
  assert.throws(() => new GeckoFrameDecoder().push(invalid), /valid UTF-8/);
  assert.throws(() => new GeckoFrameDecoder({ maxFrameBytes: 8 }).push(Uint8Array.from([0, 0, 0, 9])), /exceeds limit/);
  const decoder = new GeckoFrameDecoder();
  decoder.push(Uint8Array.from([0, 0, 0]));
  assert.throws(() => decoder.end(), /truncated frame header/);
});
