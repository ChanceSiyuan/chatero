import assert from "node:assert/strict";
import { test } from "node:test";

import { withChangeContext } from "../extensions/chatero-documentation/text-change-set.mjs";
import {
  formatPendingConflict,
  rebasePendingOperations,
} from "../extensions/chatero-documentation/pending-edit-rebase.mjs";

test("maps a pending range after a non-overlapping insertion", () => {
  const base = "alpha beta gamma\n";
  const [change] = withChangeContext(base, [{ from: 6, to: 10, insert: "BETA" }]);
  const result = rebasePendingOperations({
    authoritativeText: "prefix alpha beta gamma\n",
    authoritativeVersion: 9,
    pendingOperations: [{ opId: "s:1", baseVersion: 7, changes: [change] }],
  });
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.replayable[0].changes.map(({ from, to }) => ({ from, to })), [{ from: 13, to: 17 }]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.replayable[0].changes[0]));
});

test("keeps a pending range stable when an authoritative deletion is after its context", () => {
  const base = `alpha beta ${"x".repeat(32)} tail\r\n`;
  const change = withChangeContext(base, [{ from: 6, to: 10, insert: "BETA" }])[0];
  const authoritative = base.replace(" tail", "");
  const result = rebasePendingOperations({
    authoritativeText: authoritative,
    authoritativeVersion: 8,
    pendingOperations: [{ opId: "s:1", baseVersion: 7, changes: [change] }],
  });
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.replayable[0].changes.map(({ from, to }) => ({ from, to })), [{ from: 6, to: 10 }]);
});

test("never guesses between repeated anchors", () => {
  const base = "x foo y x foo y";
  const change = withChangeContext(base, [{ from: 2, to: 5, insert: "FOO" }], 2)[0];
  const result = rebasePendingOperations({
    authoritativeText: `prefix ${base}`,
    authoritativeVersion: 3,
    pendingOperations: [{ opId: "s:1", baseVersion: 2, changes: [change] }],
  });
  assert.equal(result.replayable.length, 0);
  assert.equal(result.conflicts[0].reason, "ambiguous-anchor");
});

test("preserves an overlapping changed deletion as one visible source conflict", () => {
  const base = "alpha beta gamma\n";
  const changes = withChangeContext(base, [
    { from: 0, to: 5, insert: "ALPHA" },
    { from: 6, to: 10, insert: "BETA" },
  ]);
  const result = rebasePendingOperations({
    authoritativeText: "alpha BETX gamma\n",
    authoritativeVersion: 9,
    pendingOperations: [{ opId: "s:1", baseVersion: 7, changes }],
  });
  assert.equal(result.replayable.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual({
    opId: result.conflicts[0].opId,
    reason: result.conflicts[0].reason,
    deletedSource: result.conflicts[0].deletedSource,
    pendingInsert: result.conflicts[0].pendingInsert,
    leftContext: result.conflicts[0].leftContext,
    rightContext: result.conflicts[0].rightContext,
  }, {
    opId: "s:1",
    reason: "overlap",
    deletedSource: "beta",
    pendingInsert: "BETA",
    leftContext: "alpha ",
    rightContext: " gamma\n",
  });
  assert.match(result.conflicts[0].authoritativeExcerpt, /BETX/);
  const formatted = formatPendingConflict(result.conflicts[0]);
  assert.match(formatted, /Authoritative TextDocument source/);
  assert.match(formatted, /Unacknowledged Live Preview change/);
  assert.doesNotMatch(formatted, /<<<<<<<|=======|>>>>>>>/);
});

test("rebases multiple pending operations sequentially with Unicode and CRLF bytes intact", () => {
  const base = "😀 alpha\r\nbeta\r\n";
  const firstChanges = withChangeContext(base, [{ from: 3, to: 8, insert: "ALPHA" }]);
  const afterFirst = "😀 ALPHA\r\nbeta\r\n";
  const secondChanges = withChangeContext(afterFirst, [{ from: 10, to: 14, insert: "β" }]);
  const result = rebasePendingOperations({
    authoritativeText: `prefix ${base}`,
    authoritativeVersion: 12,
    pendingOperations: [
      { opId: "s:1", baseVersion: 10, changes: firstChanges },
      { opId: "s:2", baseVersion: 11, changes: secondChanges },
    ],
  });
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.replayable.map(operation => operation.opId), ["s:1", "s:2"]);
  assert.equal(result.replayable[0].changes[0].deletedText, "alpha");
  assert.equal(result.replayable[1].changes[0].deletedText, "beta");
  assert.equal(result.replayable[1].changes[0].insert, "β");
});

test("rejects content-free descriptors as replay input", () => {
  assert.throws(() => rebasePendingOperations({
    authoritativeText: "text",
    authoritativeVersion: 2,
    pendingOperations: [{
      opId: "s:1",
      baseVersion: 1,
      changeDigest: "a".repeat(64),
      shape: [{ from: 0, to: 1, insertedUtf8Bytes: 1, deletedUtf8Bytes: 1 }],
    }],
  }), /full pending operation|descriptor|changes/i);
});
