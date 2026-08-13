import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..", "..");
const extensionRoot = join(root, "products", "workbench", "extensions", "chatero-zotero");

test("declares native Library views and commands without a webview", async () => {
  const manifest = JSON.parse(await readFile(join(extensionRoot, "package.json"), "utf8"));
  const commands = manifest.contributes.commands.map(value => value.command).sort();

  assert.equal(manifest.name, "chatero-zotero");
  assert.equal(manifest.publisher, "chatero");
  assert.equal(manifest.engines.vscode, "^1.132.0");
  assert.deepEqual(manifest.activationEvents.sort(), [
    "onChatContextProvider:chatero.chatero-zotero-zotero-pdf-evidence",
    "onChatContextProvider:zotero-pdf-evidence",
    "onCustomEditor:chatero.zotero.note",
    "onCustomEditor:chatero.zotero.pdf",
    "onView:chatero.zotero.library",
  ]);
  assert.deepEqual(commands, [
    "chatero.zotero.addPdfContextToChat",
    "chatero.zotero.openAttachment",
    "chatero.zotero.openNote",
    "chatero.zotero.refreshLibrary",
    "chatero.zotero.searchLibrary",
    "chatero.zotero.selectCoreExecutable",
    "chatero.zotero.selectProfile",
    "chatero.zotero.sendFullPaperToRemote",
    "chatero.zotero.startCore",
    "chatero.zotero.stopCore",
  ]);
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, "chatero-zotero");
  assert.equal(manifest.contributes.views["chatero-zotero"][0].id, "chatero.zotero.library");
  assert.equal(manifest.contributes.configuration.properties["chatero.zotero.coreExecutable"].type, "string");
  assert.equal(Object.hasOwn(manifest.contributes, "webviewPanel"), false);
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
            path: "/tmp/paper.pdf",
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
  const attachment = Object.freeze({ attachmentKey: "PDF00001", libraryId: 7, path: "/tmp/paper.pdf" });
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
      return { items: [{ itemKey: "ITEM", libraryId: 7, title: "Paper" }], total: 1 };
    },
  });

  assert.deepEqual(await model.collections(), [{ collectionKey: "ROOT", libraryId: 7, name: "Root" }]);
  assert.deepEqual(await model.collections({ libraryId: 7, parentKey: "ROOT" }), [{ collectionKey: "CHILD", libraryId: 7, name: "Child" }]);
  assert.deepEqual(await model.items({ collectionKey: "ROOT", libraryId: 7, query: "tensor", limit: 50 }), {
    items: [{ itemKey: "ITEM", libraryId: 7, title: "Paper" }],
    total: 1,
  });
  assert.deepEqual(calls, [
    { method: "library.collections", params: {} },
    { method: "library.collections", params: { libraryId: 7, parentKey: "ROOT" } },
    { method: "library.search", params: { collectionKey: "ROOT", libraryId: 7, limit: 50, query: "tensor" } },
  ]);
});

test("Library model rejects malformed Core rows before presenting them", async () => {
  const { LibraryTreeModel } = await import("../extensions/chatero-zotero/library-tree-model.mjs");
  const model = new LibraryTreeModel({
    request: async () => ({ collections: [{ collectionKey: "", name: "Broken" }] }),
  });

  await assert.rejects(model.collections(), /invalid collection/);
});
