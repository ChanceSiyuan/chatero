import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..", "..");
const extensionRoot = join(root, "products", "workbench", "extensions", "chatero-zotero");

test("declares native Library source and item-table views with Stage 3 commands", async () => {
  const manifest = JSON.parse(await readFile(join(extensionRoot, "package.json"), "utf8"));
  const commands = new Set(manifest.contributes.commands.map(value => value.command));

  assert.equal(manifest.name, "chatero-zotero");
  assert.equal(manifest.publisher, "chatero");
  assert.equal(manifest.engines.vscode, "^1.132.0");
  assert.ok(manifest.activationEvents.includes("onView:chatero.zotero.library"));
  assert.ok(manifest.activationEvents.includes("onView:chatero.zotero.items"));
  for (const command of [
    "chatero.zotero.addPdfContextToChat",
    "chatero.zotero.batchMoveToCollection",
    "chatero.zotero.batchRestore",
    "chatero.zotero.batchTrash",
    "chatero.zotero.exportItems",
    "chatero.zotero.importItems",
    "chatero.zotero.loadMoreItems",
    "chatero.zotero.lookupIdentifier",
    "chatero.zotero.openAttachment",
    "chatero.zotero.openNote",
    "chatero.zotero.refreshLibrary",
    "chatero.zotero.retrySync",
    "chatero.zotero.searchLibrary",
    "chatero.zotero.selectCoreExecutable",
    "chatero.zotero.selectProfile",
    "chatero.zotero.sendFullPaperToRemote",
    "chatero.zotero.showItemDetails",
    "chatero.zotero.sortItems",
    "chatero.zotero.startCore",
    "chatero.zotero.stopCore",
  ]) assert.ok(commands.has(command), `missing ${command}`);
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, "chatero-zotero");
  assert.equal(manifest.contributes.views["chatero-zotero"][0].id, "chatero.zotero.library");
  assert.equal(manifest.contributes.views["chatero-zotero"][1].id, "chatero.zotero.items");
  assert.equal(manifest.contributes.views["chatero-zotero"][1].accessibilityHelpContent, "chatero.zotero.items.accessibilityHelp");
  assert.equal(manifest.contributes.configuration.properties["chatero.zotero.coreExecutable"].type, "string");
  assert.deepEqual(manifest.contributes.configuration.properties["chatero.zotero.itemTableColumns"].default, ["creators", "year", "itemType"]);
  assert.equal(manifest.contributes.configuration.properties["chatero.zotero.itemTablePageSize"].maximum, 100);
  assert.ok(manifest.contributes.keybindings.some(value => value.command === "chatero.zotero.batchTrash"));
  assert.equal(Object.hasOwn(manifest.contributes, "webviewPanel"), false);
});

test("extension mounts virtualized multi-select TreeViews with drag/drop and state restoration", async () => {
  const source = await readFile(join(extensionRoot, "extension.cjs"), "utf8");
  assert.match(source, /createTreeView\("chatero\.zotero\.library"/);
  assert.match(source, /createTreeView\("chatero\.zotero\.items"/);
  assert.match(source, /canSelectMany: true/);
  assert.match(source, /dragAndDropController:/);
  assert.match(source, /onDidChangeSelection/);
  assert.match(source, /workspaceState\.(get|update)/);
  assert.match(source, /withProgress\(/);
});

test("source tree materializes libraries, groups, collections, searches, duplicates, feeds, trash, and sync", async () => {
  const { LibrarySourceTreeModel } = await import("../extensions/chatero-zotero/library-source-tree-model.mjs");
  const core = {
    async libraries() { return [
      { libraryId: 1, libraryType: "user", name: "My Library" },
      { groupId: 8, libraryId: 2, libraryType: "group", name: "Team" },
    ]; },
    async collections({ libraryId, parentKey } = {}) {
      if (parentKey) return [{ collectionKey: "CHILD001", libraryId, name: "Nested", parentKey }];
      return [{ collectionKey: "ROOT0001", libraryId: 1, name: "Papers" }];
    },
    async feeds() { return [{ libraryId: 9, name: "Journal Feed", unreadCount: 3 }]; },
    async savedSearches({ libraryId }) { return [{ libraryId, name: "Unread", searchKey: "SEARCH01" }]; },
    async syncStatus() { return { enabled: true, inProgress: false, libraries: [], offline: false, status: "Up to date" }; },
  };
  const tree = new LibrarySourceTreeModel({ core });
  const roots = await tree.roots();
  assert.deepEqual(roots.map(value => value.kind), ["sync", "library", "library", "feedGroup"]);
  assert.equal(roots[2].value.groupId, 8);
  const children = await tree.children(roots[1]);
  assert.deepEqual(children.map(value => value.kind), ["collection", "savedSearch", "duplicates", "unfiled", "trash"]);
  assert.equal((await tree.children(children[0]))[0].value.name, "Nested");
  assert.equal((await tree.children(roots[3]))[0].kind, "feed");
});

test("Library model lazily loads validated PDF, Note, and annotation records", async () => {
  const { LibraryTreeModel } = await import("../extensions/chatero-zotero/library-tree-model.mjs");
  const calls = [];
  const model = new LibraryTreeModel({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "library.item-children") {
        return {
          attachments: [{
            annotationCount: 1,
            attachmentKey: "PDF00001",
            contentType: "application/pdf",
            filename: "paper.pdf",
            libraryId: 7,
            parentItemKey: "ITEM0001",
            title: "Paper PDF",
          }],
          notes: [{ libraryId: 7, noteKey: "NOTE0001", parentItemKey: "ITEM0001", title: "Reading note" }],
        };
      }
      if (method === "library.annotations") return { annotations: [{
        annotationKey: "ANN00001",
        color: "#ffd400",
        comment: "Evidence",
        libraryId: 7,
        pageLabel: "3",
        positionJson: '{"pageIndex":2}',
        sortIndex: "00002|000001|00000",
        text: "Text",
        type: "highlight",
      }] };
      return { html: "<p>Reading note</p>", libraryId: 7, noteKey: "NOTE0001", parentItemKey: "ITEM0001", title: "Reading note" };
    },
  });

  const children = await model.children({ itemKey: "ITEM0001", libraryId: 7 });
  assert.equal(children.attachments[0].attachmentKey, "PDF00001");
  assert.equal(children.notes[0].noteKey, "NOTE0001");
  assert.equal((await model.annotations({ attachmentKey: "PDF00001", libraryId: 7 }))[0].annotationKey, "ANN00001");
  assert.equal((await model.note({ libraryId: 7, noteKey: "NOTE0001" })).html, "<p>Reading note</p>");
  assert.deepEqual(calls.map(value => value.method), [
    "library.item-children",
    "library.annotations",
    "library.note",
  ]);
});

test("Library model fetches and validates read-only item metadata", async () => {
  const { LibraryTreeModel } = await import("../extensions/chatero-zotero/library-tree-model.mjs");
  const calls = [];
  const model = new LibraryTreeModel({
    request: async (method, params) => {
      calls.push({ method, params });
      return {
        abstractNote: "Abstract",
        creators: ["Ada Lovelace"],
        date: "2024-01-15",
        doi: "10.1234/alpha",
        itemKey: "ITEM0001",
        itemType: "journalArticle",
        libraryId: 7,
        publicationTitle: "Journal of Methods",
        tags: ["methods", "reading"],
        title: "Alpha Methods",
        url: "https://example.org/alpha",
        year: 2024,
      };
    },
  });

  assert.deepEqual(await model.metadata({ itemKey: "ITEM0001", libraryId: 7 }), {
    abstractNote: "Abstract",
    creators: ["Ada Lovelace"],
    date: "2024-01-15",
    doi: "10.1234/alpha",
    itemKey: "ITEM0001",
    itemType: "journalArticle",
    libraryId: 7,
    publicationTitle: "Journal of Methods",
    tags: ["methods", "reading"],
    title: "Alpha Methods",
    url: "https://example.org/alpha",
    year: 2024,
  });
  assert.deepEqual(calls, [
    { method: "library.item-metadata", params: { itemKey: "ITEM0001", libraryId: 7 } },
  ]);
});

test("item metadata HTML escapes hostile values and admits no scripts or remote resources", async () => {
  const { renderItemMetadataHTML } = await import("../extensions/chatero-zotero/item-metadata-html.mjs");
  const html = renderItemMetadataHTML({
    abstractNote: "<script>alert(1)</script>",
    creators: ["Ada & Bob", "<img src=x onerror=alert(1)>"],
    date: "2024-01-15",
    doi: "10.1234/alpha",
    itemKey: "ITEM0001",
    itemType: "journalArticle",
    libraryId: 7,
    publicationTitle: "",
    tags: [],
    title: "Alpha \"Methods\"",
    url: "https://example.org/<x>",
    year: 2024,
  });

  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<(script|img|iframe|object|embed|a)[\s>]/);
  assert.match(html, /Alpha &quot;Methods&quot;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /https:\/\/example\.org\/&lt;x&gt;/);
  assert.doesNotMatch(html, /Publication|Tags/);
  assert.throws(() => renderItemMetadataHTML(null), /must be an object/);
});

test("item details command renders validated metadata through a scriptless webview", async () => {
  const source = await readFile(join(extensionRoot, "extension.cjs"), "utf8");
  assert.match(source, /registerCommand\("chatero\.zotero\.showItemDetails"/);
  assert.match(source, /createWebviewPanel\(/);
  assert.match(source, /enableScripts: false/);
  assert.match(source, /renderItemMetadataHTML/);
  assert.doesNotMatch(source, /executeCommand\(["']vscode\.open["']|openExternal|child_process/);
});

test("Library open commands keep Core-originated evidence inside native workbench editors", async () => {
  const source = await readFile(join(extensionRoot, "extension.cjs"), "utf8");

  assert.match(source, /registerCommand\("chatero\.zotero\.openAttachment"/);
  assert.match(source, /registerCommand\("chatero\.zotero\.openNote"/);
  assert.match(source, /executeCommand\("vscode\.openWith"/);
  assert.doesNotMatch(source, /openExternal|executeCommand\(["']vscode\.open["']|child_process/);
});

test("evidence command authority accepts only the exact active Core record", async () => {
  const { EvidenceRecordAuthority } = await import("../extensions/chatero-zotero/evidence-authority.mjs");
  const authority = new EvidenceRecordAuthority();
  const attachment = Object.freeze({ attachmentKey: "PDF00001", libraryId: 7 });
  authority.register(attachment, "attachment");

  assert.equal(authority.authorize(attachment, "attachment"), attachment);
  assert.throws(() => authority.authorize({ ...attachment }, "attachment"), /active Zotero Core session/);
  assert.throws(() => authority.authorize(attachment, "note"), /active Zotero Core session/);
  authority.reset();
  assert.throws(() => authority.authorize(attachment, "attachment"), /active Zotero Core session/);
});

test("Library model queries root collections, nested collections, and collection items", async () => {
  const { LibraryTreeModel } = await import("../extensions/chatero-zotero/library-tree-model.mjs");
  const calls = [];
  const model = new LibraryTreeModel({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "library.collections") {
        return { collections: params.parentKey
          ? [{ collectionKey: "CHILD", libraryId: 7, name: "Child" }]
          : [{ collectionKey: "ROOT", libraryId: 7, name: "Root" }] };
      }
      return { items: [{ attachmentCount: 0, creators: [], itemKey: "ITEM", itemType: "book", libraryId: 7, title: "Paper", version: 1 }], total: 1 };
    },
  });

  assert.deepEqual(await model.collections(), [{ collectionKey: "ROOT", libraryId: 7, name: "Root" }]);
  assert.deepEqual(await model.collections({ libraryId: 7, parentKey: "ROOT" }), [{ collectionKey: "CHILD", libraryId: 7, name: "Child" }]);
  assert.deepEqual(await model.items({ collectionKey: "ROOT", libraryId: 7, query: "tensor", limit: 50 }), {
    items: [{ attachmentCount: 0, creators: [], itemKey: "ITEM", itemType: "book", libraryId: 7, title: "Paper", version: 1 }],
    total: 1,
  });
  assert.deepEqual(calls, [
    { method: "library.collections", params: {} },
    { method: "library.collections", params: { libraryId: 7, parentKey: "ROOT" } },
    { method: "library.search", params: { collectionKey: "ROOT", libraryId: 7, limit: 50, query: "tensor" } },
  ]);
});

test("Library model forwards sortable search fields to the Core", async () => {
  const { LibraryTreeModel } = await import("../extensions/chatero-zotero/library-tree-model.mjs");
  const calls = [];
  const model = new LibraryTreeModel({
    request: async (method, params) => {
      calls.push({ method, params });
      return { items: [], total: 0 };
    },
  });

  await model.items({ query: "", limit: 50, sortBy: "year", sortDirection: "desc" });
  assert.deepEqual(calls, [
    { method: "library.search", params: { limit: 50, query: "", sortBy: "year", sortDirection: "desc" } },
  ]);
});

test("Library model rejects malformed Core rows before presenting them", async () => {
  const { LibraryTreeModel } = await import("../extensions/chatero-zotero/library-tree-model.mjs");
  const model = new LibraryTreeModel({
    request: async () => ({ collections: [{ collectionKey: "", name: "Broken" }] }),
  });

  await assert.rejects(model.collections(), /invalid collection/);
});

test("Library model exposes every Stage 3 source through validated Core calls", async () => {
  const { LibraryTreeModel } = await import("../extensions/chatero-zotero/library-tree-model.mjs");
  const calls = [];
  const model = new LibraryTreeModel({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "library.libraries") return { libraries: [{
        allowsLinkedFiles: true, archived: false, editable: true, filesEditable: true,
        lastSync: 10, libraryId: 1, libraryType: "user", libraryVersion: 4,
        name: "My Library", storageVersion: 3, syncable: true,
      }] };
      if (method === "library.saved-searches") return { searches: [{
        libraryId: 1, name: "Unread", searchKey: "SEARCH01", synced: true, version: 2,
      }] };
      if (method === "library.feeds") return { feeds: [{
        cleanupReadAfter: 30, cleanupUnreadAfter: 90, lastCheck: 1, lastCheckError: "",
        lastUpdate: 2, libraryId: 9, name: "Journal Feed", refreshInterval: 60,
        unreadCount: 3, updating: false, url: "https://example.org/feed",
      }] };
      if (method === "sync.status") return {
        enabled: true, inProgress: false, lastSyncAt: 10, libraries: [{
          errors: [], lastSync: 10, libraryId: 1, libraryVersion: 4, storageVersion: 3,
        }], offline: false, status: "Up to date",
      };
      throw new Error(`unexpected method ${method}`);
    },
  });

  assert.equal((await model.libraries())[0].name, "My Library");
  assert.equal((await model.savedSearches({ libraryId: 1 }))[0].searchKey, "SEARCH01");
  assert.equal((await model.feeds())[0].unreadCount, 3);
  assert.equal((await model.syncStatus()).status, "Up to date");
  assert.deepEqual(calls.map(value => value.method), [
    "library.libraries", "library.saved-searches", "library.feeds", "sync.status",
  ]);
});

test("Library source queries cover libraries, saved searches, duplicates, unfiled items, and trash", async () => {
  const { LibraryTreeModel } = await import("../extensions/chatero-zotero/library-tree-model.mjs");
  const calls = [];
  const model = new LibraryTreeModel({
    request: async (method, params) => {
      calls.push({ method, params });
      return { items: [], total: 0 };
    },
  });

  await model.sourceItems({ source: { kind: "library", libraryId: 1 }, limit: 25, query: "graph" });
  await model.sourceItems({ source: { kind: "savedSearch", libraryId: 1, searchKey: "SEARCH01" }, limit: 25 });
  await model.sourceItems({ source: { kind: "duplicates", libraryId: 1 }, limit: 25 });
  await model.sourceItems({ source: { kind: "unfiled", libraryId: 1 }, limit: 25 });
  await model.sourceItems({ source: { kind: "trash", libraryId: 1 }, limit: 25 });

  assert.deepEqual(calls, [
    { method: "library.search", params: { libraryId: 1, limit: 25, query: "graph", scope: "library" } },
    { method: "library.saved-search-items", params: { libraryId: 1, limit: 25, searchKey: "SEARCH01" } },
    { method: "library.duplicates", params: { libraryId: 1, limit: 25 } },
    { method: "library.search", params: { libraryId: 1, limit: 25, query: "", scope: "unfiled" } },
    { method: "library.search", params: { libraryId: 1, limit: 25, query: "", scope: "trash" } },
  ]);
});

test("item table session paginates, sorts, restores stable selection, and batches same-library mutations", async () => {
  const { LibraryItemTableModel } = await import("../extensions/chatero-zotero/library-item-table-model.mjs");
  const calls = [];
  const pages = [
    { items: [{ creators: ["Ada"], itemKey: "ITEM0001", itemType: "book", libraryId: 1, title: "Alpha", version: 2 }], nextCursor: "1", total: 2 },
    { items: [{ creators: ["Grace"], itemKey: "ITEM0002", itemType: "article", libraryId: 1, title: "Beta", version: 7 }], total: 2 },
  ];
  const core = {
    async sourceItems(options) { calls.push(["sourceItems", options]); return pages.shift(); },
    async batchMutate(options) { calls.push(["batchMutate", options]); return { replayed: false, results: [], revision: 1 }; },
  };
  const table = new LibraryItemTableModel({ core, pageSize: 1 });
  await table.open({ kind: "library", libraryId: 1 });
  table.select(["1/ITEM0001"]);
  await table.loadNext();
  table.select(["1/ITEM0001", "1/ITEM0002"]);
  const snapshot = table.snapshot();

  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.selectedRows.map(value => value.itemKey), ["ITEM0001", "ITEM0002"]);
  assert.equal(snapshot.nextCursor, undefined);
  await table.batch("trash");
  assert.deepEqual(calls.at(-1), ["batchMutate", {
    libraryId: 1,
    operations: [
      { kind: "item-mutate", params: { action: "trash", expectedVersion: 2, itemKey: "ITEM0001", libraryId: 1 } },
      { kind: "item-mutate", params: { action: "trash", expectedVersion: 7, itemKey: "ITEM0002", libraryId: 1 } },
    ],
  }]);

  const restored = new LibraryItemTableModel({ core, pageSize: 1 });
  restored.restore(snapshot);
  assert.deepEqual(restored.selectedRows.map(value => value.itemKey), ["ITEM0001", "ITEM0002"]);
  assert.equal(restored.sortBy, "title");
  assert.equal(restored.sortDirection, "asc");
});

test("batch mutation learns a Core scope revision and retries once with a fresh idempotency key", async () => {
  const { LibraryTreeModel } = await import("../extensions/chatero-zotero/library-tree-model.mjs");
  const calls = [];
  let keys = 0;
  const model = new LibraryTreeModel({
    idempotencyKey: () => `chatero-stage3-key-${++keys}`,
    request: async (method, params) => {
      calls.push({ method, params });
      if (calls.length === 1) {
        const error = new Error("revision conflict");
        error.code = "CONFLICT";
        error.details = { actualRevision: 5, expectedRevision: 0, kind: "REVISION_CONFLICT" };
        throw error;
      }
      return { replayed: false, results: [], revision: 6 };
    },
  });
  const operations = [{ kind: "item-mutate", params: { action: "trash", expectedVersion: 2, itemKey: "ITEM0001", libraryId: 1 } }];

  assert.equal((await model.batchMutate({ libraryId: 1, operations })).revision, 6);
  assert.deepEqual(calls.map(value => ({ expectedRevision: value.params.expectedRevision, idempotencyKey: value.params.idempotencyKey })), [
    { expectedRevision: 0, idempotencyKey: "chatero-stage3-key-1" },
    { expectedRevision: 5, idempotencyKey: "chatero-stage3-key-2" },
  ]);
});
