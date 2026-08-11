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
  assert.deepEqual(manifest.activationEvents, ["onView:chatero.zotero.library"]);
  assert.deepEqual(commands, [
    "chatero.zotero.refreshLibrary",
    "chatero.zotero.searchLibrary",
    "chatero.zotero.selectProfile",
    "chatero.zotero.startCore",
    "chatero.zotero.stopCore",
  ]);
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, "chatero-zotero");
  assert.equal(manifest.contributes.views["chatero-zotero"][0].id, "chatero.zotero.library");
  assert.equal(Object.hasOwn(manifest.contributes, "webviewPanel"), false);
});

test("Library model queries root collections, nested collections, and collection items", async () => {
  const { LibraryTreeModel } = await import("../extensions/chatero-zotero/library-tree-model.mjs");
  const calls = [];
  const model = new LibraryTreeModel({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "library.collections") {
        return { collections: params.parentKey ? [{ collectionKey: "CHILD", name: "Child" }] : [{ collectionKey: "ROOT", name: "Root" }] };
      }
      return { items: [{ itemKey: "ITEM", title: "Paper" }], total: 1 };
    },
  });

  assert.deepEqual(await model.collections(), [{ collectionKey: "ROOT", name: "Root" }]);
  assert.deepEqual(await model.collections("ROOT"), [{ collectionKey: "CHILD", name: "Child" }]);
  assert.deepEqual(await model.items({ collectionKey: "ROOT", query: "tensor", limit: 50 }), {
    items: [{ itemKey: "ITEM", title: "Paper" }],
    total: 1,
  });
  assert.deepEqual(calls, [
    { method: "library.collections", params: {} },
    { method: "library.collections", params: { parentKey: "ROOT" } },
    { method: "library.search", params: { collectionKey: "ROOT", limit: 50, query: "tensor" } },
  ]);
});

test("Library model rejects malformed Core rows before presenting them", async () => {
  const { LibraryTreeModel } = await import("../extensions/chatero-zotero/library-tree-model.mjs");
  const model = new LibraryTreeModel({
    request: async () => ({ collections: [{ collectionKey: "", name: "Broken" }] }),
  });

  await assert.rejects(model.collections(), /invalid collection/);
});
