import assert from "node:assert/strict";
import { test } from "node:test";

import { createZoteroLibraryAdapter } from "../../../chrome/content/zotero/xpcom/chateroCoreLibraryAdapter.mjs";

function creator(name) {
  return name.includes(" ")
    ? { firstName: name.split(" ")[0], lastName: name.split(" ").slice(1).join(" ") }
    : { name };
}

function item({ id, key, libraryID, title, type = "journalArticle", year, creators = [], collectionIDs = [], attachments = [] }) {
  return Object.freeze({
    id,
    itemTypeID: type,
    key,
    libraryID,
    getAttachments: () => attachments.slice(),
    getCollections: () => collectionIDs.slice(),
    getCreatorsJSON: () => creators.map(creator),
    getDisplayTitle: () => title,
    getField: field => field === "year" ? year : "",
    isRegularItem: () => !["attachment", "note", "annotation"].includes(type),
  });
}

function collection({ id, key, libraryID, name, parentKey, childCollections = [], childItems = [] }) {
  return Object.freeze({
    id,
    key,
    libraryID,
    name,
    parentKey,
    getChildCollections: asIDs => asIDs ? childCollections.map(value => value.id) : childCollections.slice(),
    getChildItems: asIDs => asIDs ? childItems.map(value => value.id) : childItems.slice(),
  });
}

function fixture() {
  const attachment = item({ id: 90, key: "PDF00001", libraryID: 1, title: "PDF", type: "attachment" });
  const alpha = item({
    id: 11,
    key: "ITEM0001",
    libraryID: 1,
    title: "Alpha Methods",
    type: "journalArticle",
    year: "2024",
    creators: ["Ada Lovelace", "Collaboration"],
    attachments: [attachment.id],
    collectionIDs: [101, 102],
  });
  const beta = item({ id: 12, key: "ITEM0002", libraryID: 1, title: "Beta Result", type: "book", year: "in press", creators: ["Emmy Noether"], collectionIDs: [101] });
  const groupAlpha = item({ id: 21, key: "ITEM0001", libraryID: 2, title: "Group Alpha", creators: ["Group Author"], collectionIDs: [201] });
  const note = item({ id: 22, key: "NOTE0001", libraryID: 2, title: "Not a paper", type: "note", collectionIDs: [201] });

  const nested = collection({ id: 102, key: "NESTED01", libraryID: 1, name: "Renormalization", parentKey: "SHARED01", childItems: [alpha] });
  const personal = collection({ id: 101, key: "SHARED01", libraryID: 1, name: "Physics", childCollections: [nested], childItems: [beta, alpha] });
  const group = collection({ id: 201, key: "SHARED01", libraryID: 2, name: "Team Physics", childItems: [note, groupAlpha] });
  const collections = [personal, nested, group];
  const items = [attachment, alpha, beta, groupAlpha, note];

  const Zotero = {
    Collections: {
      get: id => collections.find(value => value.id === id) || false,
      getByLibrary: libraryId => collections.filter(value => value.libraryID === libraryId && !value.parentKey),
      getByLibraryAndKey: (libraryId, key) => collections.find(value => value.libraryID === libraryId && value.key === key) || false,
    },
    Items: {
      get: id => items.find(value => value.id === id) || false,
      getAll: async libraryId => items.filter(value => value.libraryID === libraryId && value.isRegularItem()),
    },
    ItemTypes: { getName: itemTypeID => itemTypeID },
    Libraries: { getAll: () => [{ libraryID: 2, name: "Group" }, { libraryID: 1, name: "My Library" }] },
  };
  return { Zotero };
}

test("normalizes root and nested collections with composite library identity", async () => {
  const adapter = createZoteroLibraryAdapter(fixture());

  assert.deepEqual(await adapter.collections({}), {
    collections: [
      { childCount: 1, collectionKey: "SHARED01", itemCount: 2, libraryId: 1, name: "Physics" },
      { childCount: 0, collectionKey: "SHARED01", itemCount: 2, libraryId: 2, name: "Team Physics" },
    ],
  });
  assert.deepEqual(await adapter.collections({ libraryId: 1, parentKey: "SHARED01" }), {
    collections: [
      { childCount: 0, collectionKey: "NESTED01", itemCount: 1, libraryId: 1, name: "Renormalization", parentKey: "SHARED01" },
    ],
  });
  await assert.rejects(adapter.collections({ parentKey: "SHARED01" }), /libraryId/);
});

test("search isolates duplicate collection keys and emits protocol-exact item summaries", async () => {
  const adapter = createZoteroLibraryAdapter(fixture());

  assert.deepEqual(await adapter.search({ collectionKey: "SHARED01", libraryId: 1, limit: 50, query: "ada" }), {
    items: [{
      attachmentCount: 1,
      collectionKeys: ["NESTED01", "SHARED01"],
      creators: ["Ada Lovelace", "Collaboration"],
      itemKey: "ITEM0001",
      itemType: "journalArticle",
      libraryId: 1,
      title: "Alpha Methods",
      year: 2024,
    }],
    total: 1,
  });
  assert.deepEqual(await adapter.search({ collectionKey: "SHARED01", libraryId: 2, limit: 50, query: "" }), {
    items: [{
      attachmentCount: 0,
      collectionKeys: ["SHARED01"],
      creators: ["Group Author"],
      itemKey: "ITEM0001",
      itemType: "journalArticle",
      libraryId: 2,
      title: "Group Alpha",
    }],
    total: 1,
  });
});

test("search across libraries is deterministic and cursor pagination is stable", async () => {
  const adapter = createZoteroLibraryAdapter(fixture());

  assert.deepEqual(await adapter.search({ limit: 2, query: "" }), {
    items: [
      {
        attachmentCount: 1,
        collectionKeys: ["NESTED01", "SHARED01"],
        creators: ["Ada Lovelace", "Collaboration"],
        itemKey: "ITEM0001",
        itemType: "journalArticle",
        libraryId: 1,
        title: "Alpha Methods",
        year: 2024,
      },
      {
        attachmentCount: 0,
        collectionKeys: ["SHARED01"],
        creators: ["Emmy Noether"],
        itemKey: "ITEM0002",
        itemType: "book",
        libraryId: 1,
        title: "Beta Result",
      },
    ],
    nextCursor: "2",
    total: 3,
  });
  assert.deepEqual((await adapter.search({ cursor: "2", limit: 2, query: "" })).items.map(value => value.title), ["Group Alpha"]);
});

test("rejects malformed requests before touching Zotero APIs", async () => {
  let calls = 0;
  const { Zotero } = fixture();
  const original = Zotero.Libraries.getAll;
  Zotero.Libraries.getAll = () => { calls++; return original(); };
  const adapter = createZoteroLibraryAdapter({ Zotero });

  await assert.rejects(adapter.search({ collectionKey: "SHARED01", limit: 50, query: "" }), /libraryId/);
  await assert.rejects(adapter.search({ cursor: "-1", limit: 50, query: "" }), /cursor/);
  await assert.rejects(adapter.search({ limit: 0, query: "" }), /limit/);
  await assert.rejects(adapter.collections({ libraryId: 1 }), /parentKey/);
  assert.equal(calls, 0);
});
