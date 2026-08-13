import assert from "node:assert/strict";
import { test } from "node:test";

import { createCoreEventJournal } from "../../../chrome/content/zotero/xpcom/chateroCoreEventJournal.mjs";

test("Core events are globally monotonic, immutable, and replayed from a bounded cursor", () => {
  let now = 100;
  const journal = createCoreEventJournal({
    capacity: 3,
    now: () => ++now,
    profileEpoch: "epoch-1",
  });

  const mutable = { itemKeys: ["ITEM0001"] };
  assert.deepEqual(journal.publish("library.item.changed", mutable), {
    occurredAt: 101,
    payload: { itemKeys: ["ITEM0001"] },
    profileEpoch: "epoch-1",
    sequence: 1,
    topic: "library.item.changed",
  });
  mutable.itemKeys[0] = "FORGED01";
  journal.publish("library.item.changed", { itemKeys: ["ITEM0002"] });
  journal.publish("sync.status.changed", { state: "idle" });
  journal.publish("library.item.changed", { itemKeys: ["ITEM0003"] });

  assert.deepEqual(journal.replay({ afterSequence: 1, limit: 2 }), {
    events: [
      {
        occurredAt: 102,
        payload: { itemKeys: ["ITEM0002"] },
        profileEpoch: "epoch-1",
        sequence: 2,
        topic: "library.item.changed",
      },
      {
        occurredAt: 103,
        payload: { state: "idle" },
        profileEpoch: "epoch-1",
        sequence: 3,
        topic: "sync.status.changed",
      },
    ],
    latestSequence: 4,
    oldestSequence: 2,
    truncated: false,
  });
  assert.equal(journal.replay({ afterSequence: 0, limit: 10 }).truncated, true);
  assert.equal(journal.latestSequence, 4);
});

test("Core event replay rejects malformed cursors, topics, and oversized payloads", () => {
  const journal = createCoreEventJournal({
    maxPayloadBytes: 64,
    profileEpoch: "epoch-1",
  });

  assert.throws(() => journal.publish("bad topic", {}), /topic/);
  assert.throws(() => journal.publish("library.changed", { value: "x".repeat(128) }), /payload/);
  assert.throws(() => journal.publish("library.changed", { value: undefined }), /JSON/);
  const repeated = { ok: true };
  assert.deepEqual(journal.publish("library.changed", { shared: [repeated, repeated] }).payload, {
    shared: [{ ok: true }, { ok: true }],
  });
  assert.throws(() => journal.replay({ afterSequence: -1, limit: 1 }), /afterSequence/);
  assert.throws(() => journal.replay({ afterSequence: 0, limit: 0 }), /limit/);
  assert.throws(() => journal.replay({ afterSequence: 0, limit: 1, extra: true }), /unknown field/);
});

test("Core event subscribers observe each published immutable record and can detach", () => {
  const journal = createCoreEventJournal({ profileEpoch: "epoch-1" });
  const received = [];
  const dispose = journal.subscribe(event => received.push(event));

  const first = journal.publish("library.item.changed", { identities: [] });
  dispose();
  journal.publish("library.item.changed", { identities: [] });

  assert.deepEqual(received, [first]);
  assert.throws(() => journal.subscribe(null), /listener/);
});

test("one failing event subscriber cannot break journal publication", () => {
  const journal = createCoreEventJournal({ profileEpoch: "epoch", now: () => 10 });
  const seen = [];
  journal.subscribe(() => { throw new Error("subscriber failed"); });
  journal.subscribe(event => seen.push(event));

  const published = journal.publish("library.changed", { libraryId: 1 });
  assert.deepEqual(seen, [published]);
  assert.equal(journal.latestSequence, 1);
});
