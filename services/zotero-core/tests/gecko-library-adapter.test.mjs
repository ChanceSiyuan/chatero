import assert from "node:assert/strict";
import { test } from "node:test";

import { createZoteroLibraryAdapter } from "../../../chrome/content/zotero/xpcom/chateroCoreLibraryAdapter.mjs";

function creator(name) {
  return name.includes(" ")
    ? { firstName: name.split(" ")[0], lastName: name.split(" ").slice(1).join(" ") }
    : { name };
}

function item({
  id,
  key,
  libraryID,
  title,
  type = "journalArticle",
  year,
  abstractNote = "",
  date = "",
  doi = "",
  url = "",
  publicationTitle = "",
  tags = [],
  creators = [],
  collectionIDs = [],
  attachments = [],
  notes = [],
  annotations = [],
  parentItemID,
  path,
  contentType = "",
  filename = "",
  noteHTML = "",
  annotation = {},
  deleted = false,
  inTrash = false,
  relations = {},
  synced = true,
  version = 1,
	clientVersion = version,
  attachmentSyncState = 2,
}) {
  let currentTitle = title;
  let currentCreators = creators.map(creator);
  let currentTags = tags.map(value => ({ ...value }));
  let currentRelations = structuredClone(relations);
  let currentNoteHTML = noteHTML;
  let currentAnnotation = { ...annotation };
  let currentVersion = version;
	let currentClientVersion = clientVersion;
  let currentSynced = synced;
  const value = {
    attachmentSyncState,
    deleted,
    id,
    itemTypeID: type,
    key,
    libraryID,
    parentItemID,
    attachmentContentType: contentType,
    attachmentFilename: filename,
    get annotationColor() { return currentAnnotation.color || ""; },
    set annotationColor(value) { currentAnnotation.color = value; },
    get annotationComment() { return currentAnnotation.comment || ""; },
    set annotationComment(value) { currentAnnotation.comment = value; },
    get annotationPageLabel() { return currentAnnotation.pageLabel || ""; },
    get annotationPosition() { return currentAnnotation.positionJson || ""; },
    get annotationSortIndex() { return currentAnnotation.sortIndex || ""; },
    get annotationText() { return currentAnnotation.text || ""; },
    set annotationText(value) { currentAnnotation.text = value; },
    get annotationType() { return currentAnnotation.type || ""; },
    getAttachments: () => attachments.slice(),
    getAnnotations: () => annotations.slice(),
    getCollections: () => collectionIDs.slice(),
    getCreatorsJSON: () => structuredClone(currentCreators),
    getDisplayTitle: () => currentTitle,
    getField: field => ({
      DOI: doi,
      abstractNote,
      date,
      publicationTitle,
      url,
      year,
    }[field] ?? ""),
    getFilePathAsync: async () => path || false,
    getNote: () => currentNoteHTML,
    getNotes: () => notes.slice(),
    getRelations: () => structuredClone(currentRelations),
    getTags: () => structuredClone(currentTags),
    isAnnotation: () => type === "annotation",
    isAttachment: () => type === "attachment",
    isFileAttachment: () => type === "attachment" && Boolean(path),
    isInTrash: () => inTrash,
    isNote: () => type === "note",
    isRegularItem: () => !["attachment", "note", "annotation"].includes(type),
    async reload() {},
		async save() { currentClientVersion += 1; currentSynced = false; return true; },
    async saveTx() { return value.save(); },
    setCreators: values => { currentCreators = structuredClone(values); },
    setField: (field, value) => {
      if (field === "title") currentTitle = value;
      else throw new Error(`Unknown field '${field}'`);
    },
    setRelations: value => { currentRelations = structuredClone(value); },
    setNote: value => { currentNoteHTML = value; },
    setTags: value => { currentTags = structuredClone(value); },
    get synced() { return currentSynced; },
		get clientVersion() { return currentClientVersion; },
    get version() { return currentVersion; },
  };
  return Object.freeze(value);
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

function fixture({
  attachmentDeleted = false,
  attachmentInTrash = false,
  noteDeleted = false,
  noteInTrash = false,
} = {}) {
  const syncCalls = [];
	const exportCalls = [];
  const importCalls = [];
	const droppedTables = [];
	const indexCalls = [];
  const highlight = item({
    id: 92,
    key: "ANN00001",
    libraryID: 1,
    title: "Highlight",
    type: "annotation",
    parentItemID: 90,
    annotation: {
      color: "#ffd400",
      comment: "Key evidence",
      pageLabel: "7",
      positionJson: '{"pageIndex":6,"rects":[[1,2,3,4]]}',
      sortIndex: "00006|000001|00000",
      text: "Renormalization closes the flow.",
      type: "highlight",
    },
  });
  const attachment = item({
    id: 90,
    key: "PDF00001",
    libraryID: 1,
    title: "Accepted manuscript",
    type: "attachment",
    parentItemID: 11,
    annotations: [highlight],
    path: "/Users/example/Zotero/storage/PDF00001/paper.pdf",
    contentType: "application/pdf",
    filename: "paper.pdf",
    deleted: attachmentDeleted,
    inTrash: attachmentInTrash,
  });
  const childNote = item({
    id: 93,
    key: "NOTE0002",
    libraryID: 1,
    title: "RG reading note",
    type: "note",
    parentItemID: 11,
    noteHTML: "<div data-schema-version=\"9\"><p>Trusted Zotero note</p></div>",
    deleted: noteDeleted,
    inTrash: noteInTrash,
  });
  const alpha = item({
    id: 11,
    key: "ITEM0001",
    libraryID: 1,
    title: "Alpha Methods",
    type: "journalArticle",
    year: "2024",
    abstractNote: "A foundational method.",
    date: "2024-01-15",
    doi: "10.1234/alpha",
    url: "https://example.org/alpha",
    publicationTitle: "Journal of Methods",
    tags: [{ tag: "methods" }, { tag: "reading" }],
    creators: ["Ada Lovelace", "Collaboration"],
    attachments: [attachment.id],
    notes: [childNote.id],
    collectionIDs: [101, 102],
    relations: {
      "dc:relation": ["http://zotero.org/users/local/abc/items/ITEM0002"],
      "owl:sameAs": "https://doi.org/10.1234/alpha",
    },
    synced: false,
    version: 17,
  });
  const beta = item({ id: 12, key: "ITEM0002", libraryID: 1, title: "Beta Result", type: "book", year: "in press", creators: ["Emmy Noether"], collectionIDs: [101] });
  const groupAttachment = item({
    id: 91,
    key: "PDF00001",
    libraryID: 2,
    title: "Group PDF",
    type: "attachment",
    parentItemID: 21,
    path: "/Users/example/Zotero/storage/GROUPPDF/group.pdf",
    contentType: "application/pdf",
    filename: "group.pdf",
  });
  const groupAlpha = item({ id: 21, key: "ITEM0001", libraryID: 2, title: "Group Alpha", creators: ["Group Author"], collectionIDs: [201], attachments: [groupAttachment.id] });
  const note = item({ id: 22, key: "NOTE0001", libraryID: 2, title: "Not a paper", type: "note", collectionIDs: [201] });

  const nested = collection({ id: 102, key: "NESTED01", libraryID: 1, name: "Renormalization", parentKey: "SHARED01", childItems: [alpha] });
  const personal = collection({ id: 101, key: "SHARED01", libraryID: 1, name: "Physics", childCollections: [nested], childItems: [beta, alpha] });
  const group = collection({ id: 201, key: "SHARED01", libraryID: 2, name: "Team Physics", childItems: [note, groupAlpha] });
  const collections = [personal, nested, group];
  const items = [attachment, groupAttachment, highlight, childNote, alpha, beta, groupAlpha, note];
  const searches = [
    Object.freeze({ key: "SEARCH01", libraryID: 1, name: "Unread methods", search: async () => [12, 11, 90], synced: true, version: 4 }),
    Object.freeze({ key: "SEARCH01", libraryID: 2, name: "Group unread", search: async () => [21], synced: false, version: 2 }),
  ];

  const Zotero = {
    Collections: {
      get: id => collections.find(value => value.id === id) || false,
      getByLibrary: libraryId => collections.filter(value => value.libraryID === libraryId && !value.parentKey),
      getByLibraryAndKey: (libraryId, key) => collections.find(value => value.libraryID === libraryId && value.key === key) || false,
    },
    Items: {
      get: id => Array.isArray(id)
        ? id.map(value => items.find(itemValue => itemValue.id === value)).filter(Boolean)
        : items.find(value => value.id === id) || false,
			getAll: async (libraryId, onlyTopLevel = false) => items.filter(value => value.libraryID === libraryId && (onlyTopLevel ? value.isRegularItem() : true)),
      getByLibraryAndKey: (libraryId, key) => items.find(value => value.libraryID === libraryId && value.key === key) || false,
    },
    ItemTypes: { getName: itemTypeID => itemTypeID },
		Libraries: {
			get: libraryId => Zotero.Libraries.getAll().find(value => value.libraryID === libraryId) || false,
			getAll: () => [
				{ allowsLinkedFiles: false, archived: false, editable: true, filesEditable: false, groupID: 20, lastSync: 200, libraryID: 2, libraryType: "group", libraryVersion: 8, name: "Group", storageVersion: 7, syncable: true },
				{ allowsLinkedFiles: true, archived: false, editable: true, filesEditable: true, lastSync: 100, libraryID: 1, libraryType: "user", libraryVersion: 10, name: "My Library", storageVersion: 9, syncable: true },
			],
		},
    Searches: {
      getAll: async libraryId => searches.filter(value => value.libraryID === libraryId),
      getByLibraryAndKey: (libraryId, key) => searches.find(value => value.libraryID === libraryId && value.key === key) || false,
    },
    Tags: { getAll: async libraryId => libraryId === 1
      ? [{ tag: "Methods" }, { tag: "reading", type: 1 }, { tag: "Renormalization" }]
      : [{ tag: "Group" }] },
    Feeds: { getAll: () => [{
      cleanupReadAfter: 30,
      cleanupUnreadAfter: 90,
      lastCheck: 300,
      lastCheckError: "",
      lastUpdate: 250,
      libraryID: 3,
      name: "Research feed",
      refreshInterval: 60,
      unreadCount: 4,
      updating: false,
      url: "https://example.org/feed.xml",
    }] },
    Fulltext: {
      INDEX_STATE_INDEXED: 3,
      getIndexedState: async value => value.id === 90 ? 3 : 1,
      getItemVersion: async value => value === 90 ? 6 : false,
      getPages: async value => value === 90 ? { indexedPages: 12, total: 12 } : false,
      findTextInItems: async (ids, query) => query === "flow" && ids.includes(90) ? [{ id: 90 }] : [],
			indexItems: async (ids, options) => { indexCalls.push({ ids: ids.slice(), options: structuredClone(options) }); },
    },
		Duplicates: class {
			constructor(libraryId) { this.libraryId = libraryId; }
			async getSearchObject() {
				return {
					getConditions: () => ({ 1: { condition: "tempTable", value: "tmpDuplicates_safe123" } }),
					search: async () => this.libraryId === 1 ? [12, 11] : [],
				};
			}
		},
    Retractions: {
      isRetracted: value => value.id === 11,
      shouldShowCitationWarning: value => value.id === 11,
    },
		Translators: {
			get: id => ({
				"9cb70025-a888-4a29-a210-93ec52da40d4": { translatorID: id, translatorType: 2 },
				"32d59d2d-b65a-4da4-b0a3-bf57b3d0c6f8": { translatorID: id, translatorType: 1 },
			}[id] || false),
			getAllForType: async kind => kind === "export" ? [
				{ browserSupport: "g", creator: "Simon Kornblith", label: "BibTeX", lastUpdated: "2026-01-01 00:00:00", priority: 100, target: "bib", translatorID: "9cb70025-a888-4a29-a210-93ec52da40d4", translatorType: 2 },
				{ browserSupport: "g", creator: "Zotero", label: "CSL JSON", lastUpdated: "2025-01-01 00:00:00", priority: 100, target: "json", translatorID: "bc03b4fe-436d-4a1f-ba59-de4d2d7a63f7", translatorType: 2 },
			] : [],
		},
		Styles: {
			get: styleId => styleId === "http://www.zotero.org/styles/apa" ? { styleID: styleId } : false,
			getVisible: () => [
				{ citationFormat: "author-date", styleID: "http://www.zotero.org/styles/apa", title: "American Psychological Association 7th edition" },
			],
		},
		QuickCopy: {
			getContentFromItems: (selected, format, _callback, modified) => ({
				html: modified ? `<span>(${selected.map(value => value.getDisplayTitle()).join("; ")})</span>` : `<div>${selected.map(value => value.getDisplayTitle()).join("; ")}</div>`,
				text: modified ? `(${selected.map(value => value.getDisplayTitle()).join("; ")})` : selected.map(value => value.getDisplayTitle()).join("; "),
			}),
		},
		Translate: {
			Export: class {
				setItems(items) { this.items = items; }
				setTranslator(translator) { this.translator = translator; }
				async translate() {
					exportCalls.push({ items: this.items.map(value => [value.libraryID, value.key]), translatorId: this.translator.translatorID });
					this.string = this.items.map(value => `@article{${value.key},\n  title = {${value.getDisplayTitle()}}\n}`).join("\n");
				}
			},
			Import: class {
				setString(content) { this.content = content; }
				setTranslator(translator) { this.translator = translator; }
				async translate(options) {
					importCalls.push({ content: this.content, options: structuredClone(options), translatorId: this.translator.translatorID });
					return [item({ id: 301, key: "IMPORT01", libraryID: options.libraryID, title: "Imported Paper", version: 0, clientVersion: 31 })];
				}
			},
		},
		DB: {
			executeTransaction: async callback => callback(),
			queryAsync: async sql => { droppedTables.push(sql); },
		},
    Sync: {
			Data: { Local: { getLastSyncTime: () => new Date(400_000) } },
      Runner: {
        enabled: true,
        getErrorsByLibrary: libraryId => libraryId === 2 ? [{ errorType: "warning", message: "Storage quota warning" }] : [],
        lastSyncStatus: "Waiting",
        syncInProgress: false,
        async sync(options) { syncCalls.push(structuredClone(options)); return true; },
      },
			Storage: { Local: {
        SYNC_STATE_FORCE_DOWNLOAD: 4,
        SYNC_STATE_FORCE_UPLOAD: 3,
        SYNC_STATE_IN_CONFLICT: 5,
        SYNC_STATE_IN_SYNC: 2,
        SYNC_STATE_TO_DOWNLOAD: 1,
        SYNC_STATE_TO_UPLOAD: 0,
				downloadAsNeeded: libraryId => libraryId === 1,
				getConflicts: async libraryId => libraryId === 1 ? [{
					left: { dateModified: "2026-08-13T10:00:00Z", key: "PDF00001" },
					right: { dateModified: "2026-08-13T11:00:00Z", key: "PDF00001" },
				}] : [],
				getEnabledForLibrary: libraryId => libraryId === 1,
				getModeForLibrary: libraryId => libraryId === 1 ? "webdav" : "zfs",
      } },
    },
  };
  return { droppedTables, exportCalls, importCalls, indexCalls, syncCalls, Zotero };
}

test("lists libraries, saved searches, and paginated tags without database or path data", async () => {
  const adapter = createZoteroLibraryAdapter(fixture());

  assert.deepEqual(await adapter.libraries({}), { libraries: [
    { allowsLinkedFiles: true, archived: false, editable: true, filesEditable: true, lastSync: 100, libraryId: 1, libraryType: "user", libraryVersion: 10, name: "My Library", storageVersion: 9, syncable: true },
    { allowsLinkedFiles: false, archived: false, editable: true, filesEditable: false, groupId: 20, lastSync: 200, libraryId: 2, libraryType: "group", libraryVersion: 8, name: "Group", storageVersion: 7, syncable: true },
  ] });
  assert.deepEqual(await adapter.savedSearches({ libraryId: 2 }), { searches: [
    { libraryId: 2, name: "Group unread", searchKey: "SEARCH01", synced: false, version: 2 },
  ] });
  assert.deepEqual(await adapter.tags({ cursor: "1", libraryId: 1, limit: 1, query: "r" }), {
    tags: [{ name: "Renormalization", type: 0 }],
    total: 2,
  });
  assert.deepEqual(await adapter.savedSearchItems({ libraryId: 1, limit: 1, searchKey: "SEARCH01" }), {
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
    nextCursor: "1",
    total: 2,
  });
  assert.deepEqual(await adapter.feeds({}), { feeds: [{
    cleanupReadAfter: 30,
    cleanupUnreadAfter: 90,
    lastCheck: 300,
    lastCheckError: "",
    lastUpdate: 250,
    libraryId: 3,
    name: "Research feed",
    refreshInterval: 60,
    unreadCount: 4,
    updating: false,
    url: "https://example.org/feed.xml",
  }] });
});

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

test("exposes bounded item facts and attachment availability without leaking paths", async () => {
  const adapter = createZoteroLibraryAdapter(fixture());

  assert.deepEqual(await adapter.itemFacts({ libraryId: 1, itemKey: "ITEM0001" }), {
    citationWarning: true,
    itemKey: "ITEM0001",
    libraryId: 1,
    relations: [
      { object: "http://zotero.org/users/local/abc/items/ITEM0002", predicate: "dc:relation" },
      { object: "https://doi.org/10.1234/alpha", predicate: "owl:sameAs" },
    ],
    retracted: true,
    synced: false,
    version: 17,
  });
  const state = await adapter.attachmentState({ attachmentKey: "PDF00001", libraryId: 1 });
  assert.deepEqual(state, {
    attachmentKey: "PDF00001",
    fileAvailable: true,
    fulltextIndexState: "indexed",
    fulltextVersion: 6,
    indexedPages: 12,
    libraryId: 1,
    storageSyncState: "in-sync",
    totalPages: 12,
  });
  assert.equal(JSON.stringify(state).includes("/Users/example"), false);
});

test("atomically updates fields, creators, tags, and relations at an expected Zotero client version", async () => {
  const adapter = createZoteroLibraryAdapter(fixture());
  const updated = await adapter.updateItem({
    creators: [{ creatorType: "author", firstName: "Grace", lastName: "Hopper" }],
    expectedVersion: 17,
    fields: [{ field: "title", value: "Compiler Methods" }],
    itemKey: "ITEM0001",
    libraryId: 1,
    relations: [{ object: "https://doi.org/10.1234/compiler", predicate: "owl:sameAs" }],
    tags: [{ name: "compilers", type: 0 }],
  });
  assert.deepEqual(updated, {
    itemKey: "ITEM0001",
    libraryId: 1,
    synced: false,
    version: 18,
  });
  assert.equal((await adapter.itemMetadata({ libraryId: 1, itemKey: "ITEM0001" })).title, "Compiler Methods");
  assert.deepEqual((await adapter.itemFacts({ libraryId: 1, itemKey: "ITEM0001" })).relations, [
    { object: "https://doi.org/10.1234/compiler", predicate: "owl:sameAs" },
  ]);
  await assert.rejects(adapter.updateItem({
    expectedVersion: 17,
    fields: [{ field: "title", value: "Stale overwrite" }],
    itemKey: "ITEM0001",
    libraryId: 1,
  }), error => error.code === "REVISION_CONFLICT" && error.actualRevision === 18);
});

test("updates Note HTML only at the exact Zotero object client version", async () => {
  const adapter = createZoteroLibraryAdapter(fixture());
  assert.deepEqual(await adapter.updateNote({
    expectedVersion: 1,
    html: '<div data-schema-version="9"><p>Revised note</p></div>',
    libraryId: 1,
    noteKey: "NOTE0002",
  }), { libraryId: 1, noteKey: "NOTE0002", synced: false, version: 2 });
  assert.equal((await adapter.note({ libraryId: 1, noteKey: "NOTE0002" })).html.includes("Revised note"), true);
  await assert.rejects(adapter.updateNote({
    expectedVersion: 1,
    html: "<p>stale</p>",
    libraryId: 1,
    noteKey: "NOTE0002",
  }), error => error.code === "REVISION_CONFLICT" && error.actualRevision === 2);
});

test("updates a batch of annotations after validating every object version", async () => {
  const adapter = createZoteroLibraryAdapter(fixture());
  assert.deepEqual(await adapter.updateAnnotations({
    attachmentKey: "PDF00001",
    libraryId: 1,
    updates: [{ annotationKey: "ANN00001", color: "#ff0000", comment: "Revised", expectedVersion: 1, text: "Updated evidence" }],
  }), { annotations: [{ annotationKey: "ANN00001", libraryId: 1, synced: false, version: 2 }] });
  assert.deepEqual((await adapter.annotations({ attachmentKey: "PDF00001", libraryId: 1 })).annotations[0], {
    annotationKey: "ANN00001",
    color: "#ff0000",
    comment: "Revised",
    libraryId: 1,
    pageLabel: "7",
    positionJson: '{"pageIndex":6,"rects":[[1,2,3,4]]}',
    sortIndex: "00006|000001|00000",
    text: "Updated evidence",
    type: "highlight",
		version: 2,
  });
});

test("reports bounded offline-aware sync status without credentials", async () => {
  const adapter = createZoteroLibraryAdapter({ ...fixture(), isOffline: () => true });
  assert.deepEqual(await adapter.syncStatus({}), {
    enabled: true,
    inProgress: false,
    lastSyncAt: 400000,
    libraries: [
      { errors: [], lastSync: 100, libraryId: 1, libraryVersion: 10, storageVersion: 9 },
      { errors: [{ message: "Storage quota warning", type: "warning" }], lastSync: 200, libraryId: 2, libraryVersion: 8, storageVersion: 7 },
    ],
    offline: true,
    status: "Waiting",
  });
  assert.equal(JSON.stringify(await adapter.syncStatus({})).includes("apiKey"), false);
});

test("runs an explicit sync only for validated syncable libraries", async () => {
  const source = fixture();
  const adapter = createZoteroLibraryAdapter({ ...source, isOffline: () => false });
  assert.deepEqual(await adapter.retrySync({ libraryIds: [2, 1] }), {
    completed: true,
    libraryIds: [1, 2],
  });
  assert.deepEqual(source.syncCalls, [{ background: true, libraries: [1, 2] }]);
  await assert.rejects(adapter.retrySync({ libraryIds: [99] }), /not syncable/);
  const offline = createZoteroLibraryAdapter({ ...fixture(), isOffline: () => true });
  await assert.rejects(offline.retrySync({ libraryIds: [1] }), error => error.code === "UNAVAILABLE");
});

test("reports storage mode and bounded file conflicts without credentials or paths", async () => {
	const adapter = createZoteroLibraryAdapter(fixture());
	assert.deepEqual(await adapter.syncStorageStatus({ libraryId: 1 }), {
		conflictCount: 1,
		downloadAsNeeded: true,
		enabled: true,
		libraryId: 1,
		mode: "webdav",
	});
	assert.deepEqual(await adapter.syncConflicts({ libraryId: 1 }), { conflicts: [{
		attachmentKey: "PDF00001",
		libraryId: 1,
		localModifiedAt: "2026-08-13T10:00:00Z",
		remoteModifiedAt: "2026-08-13T11:00:00Z",
	}] });
	const serialized = JSON.stringify(await adapter.syncConflicts({ libraryId: 1 }));
	assert.equal(serialized.includes("password"), false);
	assert.equal(serialized.includes("path"), false);
});

test("returns paged duplicate candidates and cleans Zotero's temporary table", async () => {
	const source = fixture();
	const adapter = createZoteroLibraryAdapter(source);
	assert.deepEqual(await adapter.duplicates({ libraryId: 1, limit: 1 }), {
		items: [{
			attachmentCount: 1, collectionKeys: ["NESTED01", "SHARED01"], creators: ["Ada Lovelace", "Collaboration"],
			itemKey: "ITEM0001", itemType: "journalArticle", libraryId: 1, title: "Alpha Methods", year: 2024,
		}],
		nextCursor: "1",
		total: 2,
	});
	assert.deepEqual(source.droppedTables, ["DROP TABLE IF EXISTS tmpDuplicates_safe123"]);
});

test("searches bounded full text and returns attachment-parent identities without paths", async () => {
	const adapter = createZoteroLibraryAdapter(fixture());
	assert.deepEqual(await adapter.fulltextSearch({ libraryId: 1, limit: 10, query: "flow" }), {
		matches: [{ attachmentKey: "PDF00001", libraryId: 1, parentItemKey: "ITEM0001", title: "Accepted manuscript" }],
		total: 1,
	});
	await assert.rejects(adapter.fulltextSearch({ libraryId: 1, limit: 10, query: "" }), /query/);
});

test("reindexes an exact bounded attachment batch through Zotero Fulltext", async () => {
	const source = fixture();
	const adapter = createZoteroLibraryAdapter(source);
	assert.deepEqual(await adapter.indexFulltext({
		attachments: [{ attachmentKey: "PDF00001", libraryId: 1 }, { attachmentKey: "PDF00001", libraryId: 2 }],
		complete: true,
	}), {
		attachments: [{ attachmentKey: "PDF00001", libraryId: 1 }, { attachmentKey: "PDF00001", libraryId: 2 }],
		complete: true,
	});
	assert.deepEqual(source.indexCalls, [{ ids: [90, 91], options: { complete: true, ignoreErrors: false } }]);
	await assert.rejects(adapter.indexFulltext({ attachments: [{ attachmentKey: "NOTE0002", libraryId: 1 }], complete: false }), /file attachment/);
});

test("lists bounded Zotero translator metadata without executable code or paths", async () => {
	const adapter = createZoteroLibraryAdapter(fixture());
	assert.deepEqual(await adapter.translators({ kind: "export" }), { translators: [
		{ browserSupport: "g", creator: "Simon Kornblith", kind: "export", label: "BibTeX", lastUpdated: "2026-01-01 00:00:00", priority: 100, target: "bib", translatorId: "9cb70025-a888-4a29-a210-93ec52da40d4" },
		{ browserSupport: "g", creator: "Zotero", kind: "export", label: "CSL JSON", lastUpdated: "2025-01-01 00:00:00", priority: 100, target: "json", translatorId: "bc03b4fe-436d-4a1f-ba59-de4d2d7a63f7" },
	] });
	assert.equal(JSON.stringify(await adapter.translators({ kind: "export" })).includes("code"), false);
	await assert.rejects(adapter.translators({ kind: "filesystem" }), /kind/);
});

test("lists installed CSL styles and renders bibliography or citation through Quick Copy", async () => {
	const adapter = createZoteroLibraryAdapter(fixture());
	assert.deepEqual(await adapter.citationStyles({}), { styles: [{
		citationFormat: "author-date",
		styleId: "http://www.zotero.org/styles/apa",
		title: "American Psychological Association 7th edition",
	}] });
	const identities = [{ itemKey: "ITEM0001", libraryId: 1 }, { itemKey: "ITEM0001", libraryId: 2 }];
	assert.deepEqual(await adapter.renderCitation({ identities, locale: "en-US", mode: "bibliography", styleId: "http://www.zotero.org/styles/apa" }), {
		html: "<div>Alpha Methods; Group Alpha</div>",
		text: "Alpha Methods; Group Alpha",
	});
	assert.deepEqual(await adapter.renderCitation({ identities: identities.slice(0, 1), mode: "citation", styleId: "http://www.zotero.org/styles/apa" }), {
		html: "<span>(Alpha Methods)</span>",
		text: "(Alpha Methods)",
	});
	await assert.rejects(adapter.renderCitation({ identities, mode: "bibliography", styleId: "file:///tmp/evil.csl" }), /installed/);
});

test("exports exact items in memory through an installed Zotero export translator", async () => {
	const source = fixture();
	const adapter = createZoteroLibraryAdapter(source);
	assert.deepEqual(await adapter.exportItems({
		identities: [{ itemKey: "ITEM0001", libraryId: 1 }, { itemKey: "ITEM0001", libraryId: 2 }],
		translatorId: "9cb70025-a888-4a29-a210-93ec52da40d4",
	}), {
		content: "@article{ITEM0001,\n  title = {Alpha Methods}\n}\n@article{ITEM0001,\n  title = {Group Alpha}\n}",
		itemCount: 2,
		translatorId: "9cb70025-a888-4a29-a210-93ec52da40d4",
	});
	assert.deepEqual(source.exportCalls, [{ items: [[1, "ITEM0001"], [2, "ITEM0001"]], translatorId: "9cb70025-a888-4a29-a210-93ec52da40d4" }]);
	await assert.rejects(adapter.exportItems({ identities: [{ itemKey: "ITEM0001", libraryId: 1 }], translatorId: "missing" }), /installed export translator/);
});

test("imports bounded bibliographic text into an editable library with attachments disabled", async () => {
	const source = fixture();
	const adapter = createZoteroLibraryAdapter(source);
	assert.deepEqual(await adapter.importItems({
		content: "TY  - JOUR\nTI  - Imported Paper\nER  -",
		libraryId: 2,
		translatorId: "32d59d2d-b65a-4da4-b0a3-bf57b3d0c6f8",
	}), {
		items: [{ itemKey: "IMPORT01", libraryId: 2, title: "Imported Paper", version: 31 }],
		translatorId: "32d59d2d-b65a-4da4-b0a3-bf57b3d0c6f8",
	});
	assert.deepEqual(source.importCalls, [{
		content: "TY  - JOUR\nTI  - Imported Paper\nER  -",
		options: { libraryID: 2, saveAttachments: false },
		translatorId: "32d59d2d-b65a-4da4-b0a3-bf57b3d0c6f8",
	}]);
	await assert.rejects(adapter.importItems({ content: "x", libraryId: 2, translatorId: "missing" }), /installed import translator/);
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
      attachmentCount: 1,
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

test("sorts search results by title, year, creators, and item type", async () => {
  const adapter = createZoteroLibraryAdapter(fixture());

  assert.deepEqual(
    (await adapter.search({ limit: 10, query: "", sortBy: "year", sortDirection: "asc" })).items.map(value => value.title),
    ["Alpha Methods", "Beta Result", "Group Alpha"],
  );
  assert.deepEqual(
    (await adapter.search({ limit: 10, query: "", sortBy: "creators", sortDirection: "asc" })).items.map(value => value.title),
    ["Alpha Methods", "Beta Result", "Group Alpha"],
  );
  assert.deepEqual(
    (await adapter.search({ limit: 10, query: "", sortBy: "itemType", sortDirection: "asc" })).items.map(value => value.title),
    ["Beta Result", "Alpha Methods", "Group Alpha"],
  );
  assert.deepEqual(
    (await adapter.search({ limit: 10, query: "", sortBy: "title", sortDirection: "desc" })).items.map(value => value.title),
    ["Group Alpha", "Beta Result", "Alpha Methods"],
  );
  await assert.rejects(adapter.search({ limit: 10, query: "", sortBy: "bogus" }), /sortBy/);
  await assert.rejects(adapter.search({ limit: 10, query: "", sortDirection: "sideways" }), /sortDirection/);
});

test("returns PDF and Note children with Zotero composite identity", async () => {
  const adapter = createZoteroLibraryAdapter(fixture());

  assert.deepEqual(await adapter.itemChildren({ libraryId: 1, itemKey: "ITEM0001" }), {
    attachments: [{
      annotationCount: 1,
      attachmentKey: "PDF00001",
      contentType: "application/pdf",
      filename: "paper.pdf",
      libraryId: 1,
      parentItemKey: "ITEM0001",
      title: "Accepted manuscript",
    }],
    notes: [{
      libraryId: 1,
      noteKey: "NOTE0002",
      parentItemKey: "ITEM0001",
      title: "RG reading note",
		version: 1,
    }],
  });
  assert.equal(Object.hasOwn((await adapter.itemChildren({ libraryId: 2, itemKey: "ITEM0001" })).attachments[0], "path"), false);
});

test("returns full read-only metadata for a regular item", async () => {
  const adapter = createZoteroLibraryAdapter(fixture());

  assert.deepEqual(await adapter.itemMetadata({ libraryId: 1, itemKey: "ITEM0001" }), {
    abstractNote: "A foundational method.",
    creators: ["Ada Lovelace", "Collaboration"],
    date: "2024-01-15",
    doi: "10.1234/alpha",
    itemKey: "ITEM0001",
    itemType: "journalArticle",
    libraryId: 1,
    publicationTitle: "Journal of Methods",
    tags: ["methods", "reading"],
    title: "Alpha Methods",
    url: "https://example.org/alpha",
    year: 2024,
  });
  await assert.rejects(adapter.itemMetadata({ libraryId: 1, itemKey: "NOTE0002" }), /regular item/);
});

test("looks up one file attachment by exact composite identity", async () => {
  const adapter = createZoteroLibraryAdapter(fixture());

  assert.deepEqual(await adapter.attachment({ libraryId: 1, attachmentKey: "PDF00001" }), {
    annotationCount: 1,
    attachmentKey: "PDF00001",
    contentType: "application/pdf",
    filename: "paper.pdf",
    libraryId: 1,
    parentItemKey: "ITEM0001",
    title: "Accepted manuscript",
  });
  assert.equal((await adapter.attachment({ libraryId: 2, attachmentKey: "PDF00001" })).title, "Group PDF");
  await assert.rejects(adapter.attachment({ libraryId: 1, attachmentKey: "NOTE0002" }), /file attachment/);
  await assert.rejects(
    adapter.attachment({ libraryId: 3, attachmentKey: "PDF00001" }),
    error => error?.code === "UNAVAILABLE" && /not found/.test(error.message),
  );
});

test("opens attachment bytes internally without returning a filesystem path", async () => {
  const opened = [];
  const attachmentSource = Object.freeze({ size: 4, async read() {}, async close() {} });
  const adapter = createZoteroLibraryAdapter({
    ...fixture(),
    openAttachmentFile(path) {
      opened.push(path);
      return attachmentSource;
    },
  });

  assert.equal(await adapter.attachmentSource({ libraryId: 1, attachmentKey: "PDF00001" }), attachmentSource);
  assert.deepEqual(opened, ["/Users/example/Zotero/storage/PDF00001/paper.pdf"]);
});

test("exact attachment and Note lookup rejects deleted or trashed Zotero items as unavailable", async () => {
  const cases = [
    ["attachment", { attachmentDeleted: true }, { attachmentKey: "PDF00001", libraryId: 1 }],
    ["attachment", { attachmentInTrash: true }, { attachmentKey: "PDF00001", libraryId: 1 }],
    ["note", { noteDeleted: true }, { libraryId: 1, noteKey: "NOTE0002" }],
    ["note", { noteInTrash: true }, { libraryId: 1, noteKey: "NOTE0002" }],
  ];

  for (const [method, fixtureOptions, params] of cases) {
    const adapter = createZoteroLibraryAdapter(fixture(fixtureOptions));
    await assert.rejects(adapter[method](params), error =>
      error?.code === "UNAVAILABLE" && /unavailable/.test(error.message));
  }
});

test("returns a Note and PDF annotations without crossing libraries", async () => {
  const adapter = createZoteroLibraryAdapter(fixture());

  assert.deepEqual(await adapter.note({ libraryId: 1, noteKey: "NOTE0002" }), {
    html: "<div data-schema-version=\"9\"><p>Trusted Zotero note</p></div>",
    libraryId: 1,
    noteKey: "NOTE0002",
    parentItemKey: "ITEM0001",
    title: "RG reading note",
		version: 1,
  });
  assert.deepEqual(await adapter.annotations({ libraryId: 1, attachmentKey: "PDF00001" }), {
    annotations: [{
      annotationKey: "ANN00001",
      color: "#ffd400",
      comment: "Key evidence",
      libraryId: 1,
      pageLabel: "7",
      positionJson: '{"pageIndex":6,"rects":[[1,2,3,4]]}',
      sortIndex: "00006|000001|00000",
      text: "Renormalization closes the flow.",
      type: "highlight",
		version: 1,
    }],
  });
  assert.deepEqual(await adapter.annotations({ libraryId: 2, attachmentKey: "PDF00001" }), { annotations: [] });
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
  await assert.rejects(adapter.itemChildren({ libraryId: 1, itemKey: "" }), /itemKey/);
  await assert.rejects(adapter.attachment({ libraryId: 1, attachmentKey: "pdf00001" }), /attachmentKey/);
  await assert.rejects(
    adapter.note({ libraryId: 2, noteKey: "NOTE0002" }),
    error => error?.code === "UNAVAILABLE" && /not found/.test(error.message),
  );
  await assert.rejects(adapter.annotations({ attachmentKey: "PDF00001", libraryId: 1, extra: true }), /unknown field/);
  assert.equal(calls, 0);
});
