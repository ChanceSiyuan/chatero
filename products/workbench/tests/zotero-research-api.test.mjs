import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  ZOTERO_RESEARCH_COMMANDS,
  createZoteroResearchApi,
  registerZoteroResearchCommands,
} from "../extensions/chatero-zotero/research-api.mjs";

const row = Object.freeze({
  attachmentCount: 1,
  creators: Object.freeze(["Ada Lovelace"]),
  itemKey: "ITEM0001",
  itemType: "journalArticle",
  libraryId: 7,
  title: "Analytical Engine",
  version: 12,
  year: 1843,
});

test("selection snapshots contain immutable Zotero identity revisions and no private fields", async () => {
  const api = createZoteroResearchApi({
    getSelectedRows: () => [row],
    getActiveSource: () => ({ kind: "library", libraryId: 7 }),
    getCore: () => ({}),
  });
  const snapshot = await api.getSelectionSnapshot();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot[0]), true);
  assert.deepEqual(Object.keys(snapshot[0]), ["creators", "itemKey", "libraryId", "revision", "title", "year"]);
  assert.match(snapshot[0].revision, /^sha256:[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(snapshot), /path|profile|bytes|token|html/iu);
});

test("active research objects use selected item identity and reject injected rows", async () => {
  const api = createZoteroResearchApi({
    getSelectedRows: () => [row], getActiveSource: () => null, getCore: () => ({}),
  });
  assert.deepEqual(await api.getActiveResearchObject(), {
    kind: "item", itemKey: "ITEM0001", libraryId: 7, title: "Analytical Engine",
  });
  const unsafe = createZoteroResearchApi({
    getSelectedRows: () => [{ ...row, path: "/Users/alice/paper.pdf" }],
    getActiveSource: () => null,
    getCore: () => ({}),
  });
  await assert.rejects(() => unsafe.getSelectionSnapshot(), /unknown field path/u);
});

test("active Note snapshots are re-read through Core and remain path-free", async () => {
  const calls = [];
  const api = createZoteroResearchApi({
    getSelectedRows: () => [], getActiveSource: () => null,
    getActiveNoteIdentity: () => ({ libraryId: 7, noteKey: "NOTE0001" }),
    getCore: () => ({
      async note(identity) {
        calls.push(identity);
        return Object.freeze({ ...identity, parentItemKey: "ITEM0001", title: "Note", html: "<p>Evidence</p>", version: 3 });
      },
    }),
  });
  assert.deepEqual(await api.getActiveNoteSnapshot(), {
    html: "<p>Evidence</p>", itemKey: "NOTE0001", libraryId: 7, title: "Note", version: 3,
  });
  assert.deepEqual(calls, [{ libraryId: 7, noteKey: "NOTE0001" }]);
});

test("bibliography export asks Core for BibTeX and returns a bounded create snapshot", async () => {
  const requests = [];
  const api = createZoteroResearchApi({
    getSelectedRows: () => [row], getActiveSource: () => ({ kind: "library", libraryId: 7 }),
    getCore: () => ({
      async request(method, params) {
        requests.push({ method, params });
        if (method === "translation.translators") return { translators: [{ label: "BibTeX", translatorId: "BIBTEX01" }] };
        return { content: "@article{engine,title={Analytical Engine}}\n", itemCount: 1 };
      },
    }),
    readCurrentBibliography: async () => null,
  });
  const result = await api.exportBibliographySnapshot();
  assert.equal(result.bibliographyText, "@article{engine,title={Analytical Engine}}\n");
  assert.equal(result.current, null);
  assert.equal(result.records.length, 1);
  assert.deepEqual(requests.map(value => value.method), ["translation.translators", "translation.export"]);
  assert.deepEqual(requests[1].params.identities, [{ itemKey: "ITEM0001", libraryId: 7 }]);
});

test("research snapshots cross extension hosts only through hidden path-free commands", async () => {
  const registered = new Map();
  const disposables = registerZoteroResearchCommands({
    api: Object.fromEntries(ZOTERO_RESEARCH_COMMANDS.map(([, method]) => [method, async () => ({ method })])),
    commands: {
      registerCommand(id, handler) {
        registered.set(id, handler);
        return { dispose() {} };
      },
    },
  });
  assert.equal(disposables.length, 4);
  assert.deepEqual([...registered.keys()], ZOTERO_RESEARCH_COMMANDS.map(([id]) => id));
  for (const [id, method] of ZOTERO_RESEARCH_COMMANDS) {
    assert.deepEqual(await registered.get(id)(), { method });
  }
  assert.doesNotMatch(JSON.stringify([...registered.keys()]), /path|profile|sqlite|attachment/iu);
});

test("every hidden Research command activates the UI-side Zotero extension on demand", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extensions/chatero-zotero/package.json", import.meta.url), "utf8"));
  assert.deepEqual(
    manifest.activationEvents.filter(value => value.startsWith("onCommand:chatero.zotero.research.")),
    ZOTERO_RESEARCH_COMMANDS.map(([id]) => `onCommand:${id}`),
  );
});
