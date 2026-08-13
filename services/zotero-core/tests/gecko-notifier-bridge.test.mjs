import assert from "node:assert/strict";
import { test } from "node:test";

import { createZoteroNotifierBridge } from "../../../chrome/content/zotero/xpcom/chateroCoreNotifierBridge.mjs";

test("Zotero notifier bridge emits bounded composite identities without extra data", async () => {
  let observer;
  let unregistered;
  const published = [];
  const bridge = createZoteroNotifierBridge({
    Zotero: {
      Items: {
        get(ids) {
          return ids.map(id => id === 1
            ? { key: "ITEM0001", libraryID: 1 }
            : { key: "ITEM0002", libraryID: 2 });
        },
      },
      Notifier: {
        registerObserver(value, types, id) {
          observer = value;
          assert.deepEqual(types, ["collection", "search", "item", "file", "tag", "group", "trash", "relation", "feed", "feedItem", "sync"]);
          assert.equal(id, "chatero-core");
          return "observer-id";
        },
        unregisterObserver(id) { unregistered = id; },
      },
    },
    publish(topic, payload) { published.push({ payload, topic }); },
  });

  await observer.notify("modify", "item", [1, 2], { 1: { note: "must not leak" } });
  assert.deepEqual(published, [{
    payload: {
      action: "modify",
      identities: [
        { itemKey: "ITEM0001", libraryId: 1 },
        { itemKey: "ITEM0002", libraryId: 2 },
      ],
      objectType: "item",
      truncated: false,
    },
    topic: "zotero.item.modify",
  }]);
  bridge.dispose();
  assert.equal(unregistered, "observer-id");
});

test("Zotero notifier bridge ignores invalid notifications and bounds identity fanout", async () => {
  let observer;
  const published = [];
  createZoteroNotifierBridge({
    maxIdentities: 2,
    Zotero: {
      Items: { get: ids => ids.map(id => ({ key: `ITEM000${id}`, libraryID: 1 })) },
      Notifier: {
        registerObserver(value) { observer = value; return "observer-id"; },
        unregisterObserver() {},
      },
    },
    publish(topic, payload) { published.push({ payload, topic }); },
  });

  await observer.notify("modify", "item", [1, 2, 3], {});
  await observer.notify("bad action", "item", [1], {});
  assert.equal(published.length, 1);
  assert.equal(published[0].payload.identities.length, 2);
  assert.equal(published[0].payload.truncated, true);
});
