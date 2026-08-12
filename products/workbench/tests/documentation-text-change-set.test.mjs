import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";

import {
  applyOffsetChanges,
  canonicalOffsetChangesBytes,
  digestOffsetChanges,
  digestSourceText,
  sha256Hex,
  toWorkspaceTextEdits,
  validateOffsetChanges,
  withChangeContext,
} from "../extensions/chatero-documentation/text-change-set.mjs";

test("validates and applies exact UTF-16 offset changes without normalizing bytes", () => {
  const source = "A😀e\u0301\r\nB\n";
  const changes = withChangeContext(source, [{ from: 1, to: 3, insert: "λ" }], 4);
  assert.equal(changes[0].deletedText, "😀");
  assert.equal(changes[0].leftContext, "A");
  assert.equal(changes[0].rightContext, "e\u0301\r\n");
  assert.equal(applyOffsetChanges(source, changes), "Aλe\u0301\r\nB\n");
  assert.throws(
    () => validateOffsetChanges(source, [{ ...changes[0], from: 2 }]),
    /UTF-16 boundary|deleted text/,
  );

  const disjoint = withChangeContext(source, [
    { from: 0, to: 1, insert: "α" },
    { from: 7, to: 8, insert: "β" },
    { from: source.length, to: source.length, insert: "tail\n" },
  ]);
  assert.equal(applyOffsetChanges(source, disjoint), "α😀e\u0301\r\nβ\ntail\n");
  assert.equal(applyOffsetChanges("abc", withChangeContext("abc", [{ from: 1, to: 2, insert: "" }])), "ac");

  for (const invalid of [
    [{ from: -1, to: 0, insert: "" }],
    [{ from: 2, to: 1, insert: "" }],
    [{ from: 0, to: source.length + 1, insert: "" }],
    [{ from: 0.5, to: 1, insert: "" }],
    [{ from: 7, to: 8, insert: "x" }, { from: 0, to: 1, insert: "y" }],
    [{ from: 0, to: 3, insert: "x" }, { from: 2, to: 4, insert: "y" }],
  ]) {
    assert.throws(() => withChangeContext(source, invalid), /offset|range|ascending|overlap/i);
  }
  assert.throws(() => validateOffsetChanges(source, [{ ...changes[0], deletedText: "wrong" }]), /deleted text/i);
  assert.throws(() => withChangeContext(source, [{ from: 0, to: 1, insert: 42 }]), /insert/i);
});

test("context windows never split a surrogate pair and normalized records are immutable", () => {
  const source = "x😀y😀z";
  const changes = withChangeContext(source, [{ from: 3, to: 4, insert: "Y" }], 2);
  assert.equal(changes[0].leftContext, "😀");
  assert.equal(changes[0].rightContext, "😀");
  assert.ok(Object.isFrozen(changes));
  assert.ok(Object.isFrozen(changes[0]));
  assert.throws(() => changes.push({}), TypeError);
  const caller = [{ ...changes[0] }];
  const validated = validateOffsetChanges(source, caller);
  caller[0].insert = "mutated";
  assert.equal(validated[0].insert, "Y");
});

test("converts each source range into one minimal WorkspaceEdit replacement", () => {
  const source = "one\r\ntwo\nthree";
  const calls = [];
  const document = {
    getText: () => source,
    positionAt(offset) {
      calls.push(offset);
      return Object.freeze({ offset });
    },
  };
  class Range {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  }
  const changes = withChangeContext(source, [
    { from: 0, to: 3, insert: "ONE" },
    { from: 5, to: 8, insert: "TWO" },
  ]);
  const edits = toWorkspaceTextEdits(document, changes, Range);
  assert.deepEqual(calls, [0, 3, 5, 8]);
  assert.deepEqual(edits.map(edit => [edit.range.start.offset, edit.range.end.offset, edit.newText]), [
    [0, 3, "ONE"],
    [5, 8, "TWO"],
  ]);
  assert.equal(edits.some(edit => edit.range.start.offset === 0 && edit.range.end.offset === source.length), false);
});

test("encodes canonical field-ordered bytes and hashes in browser-compatible SubtleCrypto", async () => {
  const source = "before value after";
  const changes = withChangeContext(source, [{ from: 7, to: 12, insert: "next" }], 3);
  const expectedJson = '[[7,12,"next","value","re "," af"]]';
  assert.deepEqual(canonicalOffsetChangesBytes(changes), new TextEncoder().encode(expectedJson));

  let digestCalls = 0;
  const subtle = {
    async digest(algorithm, bytes) {
      digestCalls += 1;
      assert.equal(algorithm, "SHA-256");
      return webcrypto.subtle.digest(algorithm, bytes);
    },
  };
  const digest = await digestOffsetChanges(changes, subtle);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(await digestOffsetChanges(changes, subtle), digest);
  assert.match(await digestSourceText(source, subtle), /^[0-9a-f]{64}$/);
  assert.match(await sha256Hex(new TextEncoder().encode("bytes"), subtle), /^[0-9a-f]{64}$/);
  assert.equal(digestCalls, 4);

  for (const changed of [
    [{ ...changes[0], from: 6 }],
    [{ ...changes[0], to: 13 }],
    [{ ...changes[0], insert: "other" }],
    [{ ...changes[0], deletedText: "VALUE" }],
    [{ ...changes[0], leftContext: "x" }],
    [{ ...changes[0], rightContext: "x" }],
  ]) {
    assert.notEqual(await digestOffsetChanges(changed, subtle), digest);
  }
});
