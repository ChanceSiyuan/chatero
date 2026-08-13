import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createGeckoCoreRequestRouter,
  mapGeckoCoreError,
} from "../../../chrome/content/zotero/xpcom/chateroCoreRequestRouter.mjs";
import { createCoreAttachmentUploadRegistry } from "../../../chrome/content/zotero/xpcom/chateroCoreAttachmentUploadRegistry.mjs";

function request(session, method, params = {}, overrides = {}) {
  return {
    cancellationId: `cancel-${method}`,
    deadline: 1100,
    id: `id-${method}`,
    method,
    params,
    profileEpoch: session.profileEpoch,
    sessionToken: session.sessionToken,
    ...overrides,
  };
}

async function handshake(router, requestedCapabilities = ["library:read", "library:search", "profile:read"]) {
  return (await router.handle({
    cancellationId: "cancel-handshake",
    deadline: 1100,
    id: "id-handshake",
    method: "core.handshake",
    params: {
      bootstrapToken: "bootstrap-token-with-enough-entropy",
      protocolVersion: "1.0",
      requestedCapabilities,
    },
  })).result;
}

function createRouter(overrides = {}) {
  const calls = [];
  const adapter = {
    async annotations(params) { calls.push(["annotations", params]); return { annotations: [] }; },
    async updateAnnotations(params) { calls.push(["updateAnnotations", params]); return { annotations: params.updates.map(value => ({ annotationKey: value.annotationKey, libraryId: params.libraryId, synced: false, version: value.expectedVersion + 1 })) }; },
    async attachment(params) { calls.push(["attachment", params]); return { annotationCount: 0, attachmentKey: "PDF00001", contentType: "application/pdf", filename: "paper.pdf", libraryId: 1, parentItemKey: "ITEM0001", title: "Paper" }; },
    async attachmentState(params) { calls.push(["attachmentState", params]); return { attachmentKey: params.attachmentKey, fileAvailable: true, fulltextIndexState: "indexed", libraryId: params.libraryId, storageSyncState: "in-sync" }; },
    async attachmentSource(params) { calls.push(["attachmentSource", params]); return { size: 4, async read(offset, length) { return Uint8Array.from([1, 2, 3, 4]).slice(offset, offset + length); }, async close() {} }; },
    async importAttachment(params, upload) { calls.push(["importAttachment", params, upload.byteCount]); return { attachmentKey: "UPLOAD01", libraryId: params.libraryId, parentItemKey: params.parentItemKey, synced: false, version: 1 }; },
    async mutateAttachment(params) { calls.push(["mutateAttachment", params]); return { action: params.action, attachmentKey: params.attachmentKey, deleted: true, libraryId: params.libraryId, parentItemKey: "ITEM0001", synced: false, version: params.expectedVersion + 1 }; },
    async collections(params) { calls.push(["collections", params]); return { collections: [] }; },
    async mutateCollection(params) { calls.push(["mutateCollection", params]); return { action: params.action, collectionKey: "NEWCOL01", deleted: false, libraryId: params.libraryId, name: params.name, synced: false, version: 1 }; },
		async citationStyles(params) { calls.push(["citationStyles", params]); return { styles: [] }; },
		async citationItems(params) { calls.push(["citationItems", params]); return { items: [] }; },
		async renderCitation(params) { calls.push(["renderCitation", params]); return { html: "<div>Reference</div>", text: "Reference" }; },
		async exportItems(params) { calls.push(["exportItems", params]); return { content: "@article{}", itemCount: params.identities.length, translatorId: params.translatorId }; },
		async importItems(params) { calls.push(["importItems", params]); return { items: [{ itemKey: "IMPORT01", libraryId: params.libraryId, title: "Imported", version: 1 }], translatorId: params.translatorId }; },
		async lookupIdentifiers(params) { calls.push(["lookupIdentifiers", params]); return { candidates: [], identifiers: [] }; },
    async feeds(params) { calls.push(["feeds", params]); return { feeds: [] }; },
		async duplicates(params) { calls.push(["duplicates", params]); return { items: [], total: 0 }; },
		async fulltextSearch(params) { calls.push(["fulltextSearch", params]); return { matches: [], total: 0 }; },
		async indexFulltext(params) { calls.push(["indexFulltext", params]); return { attachments: params.attachments, complete: params.complete }; },
    async itemChildren(params) { calls.push(["itemChildren", params]); return { attachments: [], notes: [] }; },
    async itemMetadata(params) { calls.push(["itemMetadata", params]); return { itemKey: params.itemKey, libraryId: params.libraryId }; },
    async itemFacts(params) { calls.push(["itemFacts", params]); return { citationWarning: false, itemKey: params.itemKey, libraryId: params.libraryId, relations: [], retracted: false, synced: true, version: 1 }; },
    async updateItem(params) { calls.push(["updateItem", params]); return { itemKey: params.itemKey, libraryId: params.libraryId, synced: false, version: params.expectedVersion + 1 }; },
    async mutateItem(params) { calls.push(["mutateItem", params]); return { action: params.action, collectionKeys: params.collectionKeys || [], deleted: false, itemKey: "NEWITEM1", libraryId: params.libraryId, synced: false, version: 1 }; },
    async libraries(params) { calls.push(["libraries", params]); return { libraries: [] }; },
		async note(params) { calls.push(["note", params]); return { html: "<p>Note</p>", libraryId: 1, noteKey: "NOTE0001", parentItemKey: "ITEM0001", title: "Note", version: 1 }; },
    async updateNote(params) { calls.push(["updateNote", params]); return { libraryId: params.libraryId, noteKey: params.noteKey, synced: false, version: params.expectedVersion + 1 }; },
    async mutateNote(params) { calls.push(["mutateNote", params]); return { action: params.action, deleted: false, libraryId: params.libraryId, noteKey: "NEWNOTE1", parentItemKey: params.parentItemKey, synced: false, version: 1 }; },
    async readerState(params) { calls.push(["readerState", params]); return { attachmentKey: params.attachmentKey, contentType: "application/pdf", libraryId: params.libraryId, pageIndex: 0, version: 1 }; },
    async updateReaderState(params) { calls.push(["updateReaderState", params]); return { attachmentKey: params.attachmentKey, contentType: "application/pdf", libraryId: params.libraryId, pageIndex: params.pageIndex, synced: false, version: params.expectedVersion + 1 }; },
    async profileBackup() { calls.push(["profileBackup"]); return { backupCreated: true, completedAt: 1234 }; },
		async profileMigrate() { calls.push(["profileMigrate"]); return { compatibilityVersion: 10, migrated: true, schemaVersion: 142 }; },
    async profileStatus() { calls.push(["profileStatus"]); return { compatibilityVersion: 10, integrityCheckRequired: false, profileEpoch: "profile-epoch", profileName: "Disposable Profile", quickCheckPassed: true, readOnly: false, schemaVersion: 142, upstreamVersion: "7.1-real" }; },
    async savedSearches(params) { calls.push(["savedSearches", params]); return { searches: [] }; },
    async mutateSavedSearch(params) { calls.push(["mutateSavedSearch", params]); return { action: params.action, deleted: false, libraryId: params.libraryId, name: params.name, searchKey: "NEWSEA01", synced: false, version: 1 }; },
    async savedSearchItems(params) { calls.push(["savedSearchItems", params]); return { items: [], total: 0 }; },
    async search(params, options) { calls.push(["search", params, options]); return { items: [], total: 0 }; },
    async syncStatus(params) { calls.push(["syncStatus", params]); return { enabled: true, inProgress: false, libraries: [], offline: false, status: "" }; },
		async syncStorageStatus(params) { calls.push(["syncStorageStatus", params]); return { conflictCount: 0, downloadAsNeeded: true, enabled: true, libraryId: params.libraryId, mode: "zfs" }; },
		async syncConflicts(params) { calls.push(["syncConflicts", params]); return { conflicts: [] }; },
    async retrySync(params) { calls.push(["retrySync", params]); return { completed: true, errors: [], libraryIds: params.libraryIds, successfulLibraryIds: params.libraryIds }; },
    async tags(params) { calls.push(["tags", params]); return { tags: [], total: 0 }; },
		async translators(params) { calls.push(["translators", params]); return { translators: [] }; },
  };
  const selectedAdapter = { ...adapter, ...(overrides.adapter || {}) };
  return {
    calls,
    router: createGeckoCoreRequestRouter({
      bootstrapToken: "bootstrap-token-with-enough-entropy",
      now: () => 1000,
      profileEpoch: "profile-epoch",
      profileName: "Disposable Profile",
      randomToken: () => "session-token-with-enough-entropy",
      schemaVersion: 1,
      upstreamVersion: "7.1-real",
      ...overrides,
      adapter: selectedAdapter,
    }),
  };
}

test("exchanges the one-time bootstrap token and routes authenticated read methods", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router);

  assert.deepEqual(session, {
    capabilities: ["library:read", "library:search", "profile:read"],
    eventSequence: 0,
    expiresAt: 301000,
    profileEpoch: "profile-epoch",
    protocolVersion: "1.0",
    sessionToken: "session-token-with-enough-entropy",
    upstreamVersion: "7.1-real",
  });
  assert.deepEqual((await router.handle(request(session, "profile.status"))).result, {
    compatibilityVersion: 10,
    integrityCheckRequired: false,
    profileEpoch: "profile-epoch",
    profileName: "Disposable Profile",
    quickCheckPassed: true,
    readOnly: false,
    schemaVersion: 142,
    upstreamVersion: "7.1-real",
  });
  assert.deepEqual((await router.handle(request(session, "library.collections", { libraryId: 1, parentKey: "ROOT" }))).result, { collections: [] });
  assert.deepEqual((await router.handle(request(session, "library.search", { limit: 50, query: "tensor" }))).result, { items: [], total: 0 });
  assert.deepEqual(calls.map(value => value.slice(0, 2)), [
    ["profileStatus"],
    ["collections", { libraryId: 1, parentKey: "ROOT" }],
    ["search", { limit: 50, query: "tensor" }],
  ]);
  await assert.rejects(handshake(router), /already consumed/);
});

test("profile backup is idempotent, revision-checked, capability-gated, and evented", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router, ["events:read", "profile:write"]);
  const params = { expectedRevision: 0, idempotencyKey: "profile-backup-key-0001" };

  const first = await router.handle(request(session, "profile.backup", params));
  const replay = await router.handle(request(session, "profile.backup", params));
  assert.deepEqual(first.result, { backupCreated: true, completedAt: 1234, replayed: false, revision: 1 });
  assert.deepEqual(replay.result, { backupCreated: true, completedAt: 1234, replayed: true, revision: 1 });
  assert.equal(first.event.topic, "profile.backup.completed");
  assert.equal(replay.event, undefined);
  assert.equal(calls.filter(value => value[0] === "profileBackup").length, 1);

  await assert.rejects(
    router.handle(request(session, "profile.backup", { expectedRevision: 0, idempotencyKey: "profile-backup-key-0002" })),
    error => error.code === "REVISION_CONFLICT",
  );
});

test("collection mutations are idempotent, capability-gated, and evented", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router, ["library:write"]);
  const params = { action: "create", expectedRevision: 0, idempotencyKey: "collection-create-key-0001", libraryId: 1, name: "Reading" };
  const first = await router.handle(request(session, "library.collection-mutate", params));
  const replay = await router.handle(request(session, "library.collection-mutate", params));
  assert.deepEqual(first.result, { action: "create", collectionKey: "NEWCOL01", deleted: false, libraryId: 1, name: "Reading", replayed: false, revision: 1, synced: false, version: 1 });
  assert.equal(first.event.topic, "library.collection.changed");
  assert.equal(replay.result.replayed, true);
  assert.equal(calls.filter(value => value[0] === "mutateCollection").length, 1);
});

test("saved-search mutations are one idempotent evented transaction", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router, ["library:write"]);
  const params = { action: "create", conditions: [{ condition: "title", operator: "contains", value: "quantum" }], expectedRevision: 0, idempotencyKey: "saved-search-key-0001", libraryId: 1, name: "Quantum" };
  const first = await router.handle(request(session, "library.saved-search-mutate", params));
  const replay = await router.handle(request(session, "library.saved-search-mutate", params));
  assert.equal(first.event.topic, "library.saved-search.changed");
  assert.equal(replay.result.replayed, true);
  assert.equal(calls.filter(value => value[0] === "mutateSavedSearch").length, 1);
});

test("profile migration is an idempotent Zotero-owned schema transaction", async () => {
	const { calls, router } = createRouter();
	const session = await handshake(router, ["profile:write"]);
	const params = { expectedRevision: 0, idempotencyKey: "profile-migrate-key-0001" };
	const first = await router.handle(request(session, "profile.migrate", params));
	const replay = await router.handle(request(session, "profile.migrate", params));
	assert.deepEqual(first.result, { compatibilityVersion: 10, migrated: true, replayed: false, revision: 1, schemaVersion: 142 });
	assert.equal(first.event.topic, "profile.migration.completed");
	assert.equal(replay.result.replayed, true);
	assert.equal(calls.filter(value => value[0] === "profileMigrate").length, 1);
});

test("item update is capability-gated, idempotent, revision-checked, and evented", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router, ["events:read", "library:write"]);
  const params = {
    expectedRevision: 0,
    expectedVersion: 4,
    fields: [{ field: "title", value: "Updated" }],
    idempotencyKey: "item-update-key-0001",
    itemKey: "ITEM0001",
    libraryId: 1,
  };
  const first = await router.handle(request(session, "library.item-update", params));
  const replay = await router.handle(request(session, "library.item-update", params));
  assert.deepEqual(first.result, { itemKey: "ITEM0001", libraryId: 1, replayed: false, revision: 1, synced: false, version: 5 });
  assert.deepEqual(replay.result, { itemKey: "ITEM0001", libraryId: 1, replayed: true, revision: 1, synced: false, version: 5 });
  assert.equal(first.event.topic, "library.item.changed");
  assert.equal(replay.event, undefined);
  assert.equal(calls.filter(value => value[0] === "updateItem").length, 1);
});

test("item lifecycle mutations are one idempotent evented transaction", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router, ["library:write"]);
  const params = {
    action: "create", collectionKeys: [], expectedRevision: 0, fields: [{ field: "title", value: "Created" }],
    idempotencyKey: "item-create-key-0001", itemType: "journalArticle", libraryId: 1,
  };
  const first = await router.handle(request(session, "library.item-mutate", params));
  const replay = await router.handle(request(session, "library.item-mutate", params));
  assert.deepEqual(first.result, { action: "create", collectionKeys: [], deleted: false, itemKey: "NEWITEM1", libraryId: 1, replayed: false, revision: 1, synced: false, version: 1 });
  assert.equal(first.event.topic, "library.item.changed");
  assert.equal(replay.result.replayed, true);
  assert.equal(calls.filter(value => value[0] === "mutateItem").length, 1);
});

test("Note update is an idempotent object-version transaction", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router, ["library:write"]);
  const params = {
    expectedRevision: 0,
    expectedVersion: 3,
    html: "<p>Updated note</p>",
    idempotencyKey: "note-update-key-0001",
    libraryId: 1,
    noteKey: "NOTE0001",
  };
  const first = await router.handle(request(session, "library.note-update", params));
  const replay = await router.handle(request(session, "library.note-update", params));
  assert.deepEqual(first.result, { libraryId: 1, noteKey: "NOTE0001", replayed: false, revision: 1, synced: false, version: 4 });
  assert.equal(first.event.topic, "library.note.changed");
  assert.equal(replay.result.replayed, true);
  assert.equal(calls.filter(value => value[0] === "updateNote").length, 1);
});

test("Note lifecycle mutations are one idempotent evented transaction", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router, ["library:write"]);
  const params = { action: "create", expectedRevision: 0, html: "<p>New</p>", idempotencyKey: "note-create-key-0001", libraryId: 1, parentItemKey: "ITEM0001" };
  const first = await router.handle(request(session, "library.note-mutate", params));
  const replay = await router.handle(request(session, "library.note-mutate", params));
  assert.equal(first.event.topic, "library.note.changed");
  assert.equal(replay.result.replayed, true);
  assert.equal(calls.filter(value => value[0] === "mutateNote").length, 1);
});

test("Reader state read and update use separate capabilities and one versioned transaction", async () => {
  const { calls, router } = createRouter();
  const readSession = await handshake(router, ["library:read", "library:write"]);
  assert.equal((await router.handle(request(readSession, "reader.state", { attachmentKey: "PDF00001", libraryId: 1 }))).result.pageIndex, 0);
  const params = { attachmentKey: "PDF00001", expectedRevision: 0, expectedVersion: 1, idempotencyKey: "reader-state-key-0001", libraryId: 1, pageIndex: 4 };
  const first = await router.handle(request(readSession, "reader.state-update", params));
  const replay = await router.handle(request(readSession, "reader.state-update", params));
  assert.equal(first.event.topic, "reader.state.changed");
  assert.equal(replay.result.replayed, true);
  assert.equal(calls.filter(value => value[0] === "updateReaderState").length, 1);
});

test("annotation batches are one idempotent transaction with one event", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router, ["library:write"]);
  const params = {
    attachmentKey: "PDF00001",
    expectedRevision: 0,
    idempotencyKey: "annotation-batch-key-0001",
    libraryId: 1,
    updates: [{ annotationKey: "ANN00001", comment: "Revised", expectedVersion: 3 }],
  };
  const first = await router.handle(request(session, "library.annotations-update", params));
  const replay = await router.handle(request(session, "library.annotations-update", params));
  assert.deepEqual(first.result, { annotations: [{ annotationKey: "ANN00001", libraryId: 1, synced: false, version: 4 }], replayed: false, revision: 1 });
  assert.equal(first.event.topic, "library.annotation.changed");
  assert.equal(replay.result.replayed, true);
  assert.equal(calls.filter(value => value[0] === "updateAnnotations").length, 1);
});

test("enforces capabilities, profile epoch, session, and deadline before adapter access", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router, ["library:read"]);

  await assert.rejects(router.handle(request(session, "library.search", { limit: 50, query: "" })), /missing capability/);
  await assert.rejects(router.handle(request(session, "library.collections", {}, { profileEpoch: "other" })), /profile epoch/);
  await assert.rejects(router.handle(request(session, "library.collections", {}, { sessionToken: "wrong" })), /session authentication/);
  await assert.rejects(router.handle(request(session, "library.collections", {}, { deadline: 1000 })), /deadline expired/);
  assert.deepEqual(calls, []);
});

test("sync status has a separate read capability and returns no credentials", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router, ["sync:read"]);
  const result = (await router.handle(request(session, "sync.status", {}))).result;
  assert.deepEqual(result, { enabled: true, inProgress: false, libraries: [], offline: false, status: "" });
  assert.equal(JSON.stringify(result).includes("apiKey"), false);
  assert.deepEqual(calls, [["syncStatus", {}]]);
	assert.deepEqual((await router.handle(request(session, "sync.storage-status", { libraryId: 1 }))).result, {
		conflictCount: 0, downloadAsNeeded: true, enabled: true, libraryId: 1, mode: "zfs",
	});
	assert.deepEqual((await router.handle(request(session, "sync.conflicts", { libraryId: 1 }))).result, { conflicts: [] });
});

test("sync retry is a separately authorized idempotent transaction", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router, ["sync:write"]);
  const params = { expectedRevision: 0, idempotencyKey: "sync-retry-key-0001", libraryIds: [1, 2] };
  const first = await router.handle(request(session, "sync.retry", params));
  const replay = await router.handle(request(session, "sync.retry", params));
  assert.deepEqual(first.result, { completed: true, errors: [], libraryIds: [1, 2], replayed: false, revision: 1, successfulLibraryIds: [1, 2] });
  assert.equal(first.event.topic, "sync.completed");
  assert.equal(replay.result.replayed, true);
  assert.equal(calls.filter(value => value[0] === "retrySync").length, 1);
});

test("routes translator catalog and citation rendering through separate read capabilities", async () => {
	const { calls, router } = createRouter();
	const session = await handshake(router, ["citation:read", "translation:read"]);
	assert.deepEqual((await router.handle(request(session, "translation.translators", { kind: "export" }))).result, { translators: [] });
	assert.deepEqual((await router.handle(request(session, "translation.export", {
		identities: [{ itemKey: "ITEM0001", libraryId: 1 }], translatorId: "bibtex",
	}))).result, { content: "@article{}", itemCount: 1, translatorId: "bibtex" });
	assert.deepEqual((await router.handle(request(session, "translation.lookup", { text: "10.1234/example" }))).result, { candidates: [], identifiers: [] });
	assert.deepEqual((await router.handle(request(session, "citation.styles", {}))).result, { styles: [] });
	assert.deepEqual((await router.handle(request(session, "citation.items", { identities: [{ itemKey: "ITEM0001", libraryId: 1 }] }))).result, { items: [] });
	assert.deepEqual((await router.handle(request(session, "citation.render", {
		identities: [{ itemKey: "ITEM0001", libraryId: 1 }],
		mode: "bibliography",
		styleId: "http://www.zotero.org/styles/apa",
	}))).result, { html: "<div>Reference</div>", text: "Reference" });
	assert.deepEqual(calls.map(value => value[0]), ["translators", "exportItems", "lookupIdentifiers", "citationStyles", "citationItems", "renderCitation"]);
});

test("translation import is capability-gated, idempotent, revision-checked, and evented", async () => {
	const { calls, router } = createRouter();
	const session = await handshake(router, ["translation:write"]);
	const params = {
		content: "TY  - JOUR\nER  -",
		expectedRevision: 0,
		idempotencyKey: "translation-import-key-0001",
		libraryId: 1,
		translatorId: "ris",
	};
	const first = await router.handle(request(session, "translation.import", params));
	const replay = await router.handle(request(session, "translation.import", params));
	assert.deepEqual(first.result, {
		items: [{ itemKey: "IMPORT01", libraryId: 1, title: "Imported", version: 1 }],
		replayed: false,
		revision: 1,
		translatorId: "ris",
	});
	assert.equal(first.event.topic, "library.items.imported");
	assert.equal(replay.result.replayed, true);
	assert.equal(calls.filter(value => value[0] === "importItems").length, 1);
});

test("routes read-only PDF, item facts, Note, and annotation methods through library:read", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router);

  assert.deepEqual((await router.handle(request(session, "library.item-children", { libraryId: 1, itemKey: "ITEM0001" }))).result, { attachments: [], notes: [] });
  assert.equal(Object.hasOwn((await router.handle(request(session, "library.attachment", { attachmentKey: "PDF00001", libraryId: 1 }))).result, "path"), false);
  assert.equal((await router.handle(request(session, "library.attachment-state", { attachmentKey: "PDF00001", libraryId: 1 }))).result.storageSyncState, "in-sync");
  assert.equal((await router.handle(request(session, "library.item-facts", { itemKey: "ITEM0001", libraryId: 1 }))).result.version, 1);
  assert.deepEqual((await router.handle(request(session, "library.annotations", { attachmentKey: "PDF00001", libraryId: 1 }))).result, { annotations: [] });
  assert.equal((await router.handle(request(session, "library.note", { libraryId: 1, noteKey: "NOTE0001" }))).result.html, "<p>Note</p>");
  assert.deepEqual(calls.map(value => value[0]), ["itemChildren", "attachment", "attachmentState", "itemFacts", "annotations", "note"]);
});

test("routes duplicates and full-text search through read and search capabilities", async () => {
	const { calls, router } = createRouter();
	const session = await handshake(router);
	assert.deepEqual((await router.handle(request(session, "library.duplicates", { libraryId: 1, limit: 50 }))).result, { items: [], total: 0 });
	assert.deepEqual((await router.handle(request(session, "library.fulltext-search", { libraryId: 1, limit: 50, query: "flow" }))).result, { matches: [], total: 0 });
	assert.deepEqual(calls.map(value => value[0]), ["duplicates", "fulltextSearch"]);
});

test("full-text indexing is an idempotent, evented write transaction", async () => {
	const { calls, router } = createRouter();
	const session = await handshake(router, ["library:write"]);
	const params = {
		attachments: [{ attachmentKey: "PDF00001", libraryId: 1 }], complete: true,
		expectedRevision: 0, idempotencyKey: "fulltext-index-key-0001",
	};
	const first = await router.handle(request(session, "library.fulltext-index", params));
	const replay = await router.handle(request(session, "library.fulltext-index", params));
	assert.deepEqual(first.result, { attachments: params.attachments, complete: true, replayed: false, revision: 1 });
	assert.equal(first.event.topic, "library.fulltext.indexed");
	assert.equal(replay.result.replayed, true);
	assert.equal(calls.filter(value => value[0] === "indexFulltext").length, 1);
});

test("routes attachment chunks through a session-bound attachment:read capability", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router, ["attachment:read"]);
  const opened = (await router.handle(request(session, "attachment.open", { attachmentKey: "PDF00001", libraryId: 1 }))).result;

  assert.equal(opened.size, 4);
  assert.equal(typeof opened.sourceId, "string");
  assert.deepEqual((await router.handle(request(session, "attachment.read", {
    attachmentKey: "PDF00001", length: 2, libraryId: 1, offset: 1, sourceId: opened.sourceId,
  }))).result, { bytesBase64url: "AgM", eof: false });
  assert.deepEqual((await router.handle(request(session, "attachment.close", { sourceId: opened.sourceId }))).result, { closed: true });
  assert.deepEqual(calls.map(value => value[0]), ["attachmentSource"]);
  await router.dispose();
});

test("uploads attachment chunks through a session-bound idempotent commit", async () => {
  const bytes = [];
  const attachmentUploads = createCoreAttachmentUploadRegistry({
    createSink: () => ({ close() {}, finish() { return { close() {}, bytes: Uint8Array.from(bytes) }; }, write(chunk) { bytes.push(...chunk); } }),
    now: () => 1000,
    randomBytes: () => new Uint8Array(32).fill(8),
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  const { calls, router } = createRouter({ attachmentUploads });
  const session = await handshake(router, ["attachment:write"]);
  const opened = (await router.handle(request(session, "attachment.upload-open", { byteCount: 4, contentType: "application/pdf", filename: "paper.pdf" }))).result;
  assert.deepEqual((await router.handle(request(session, "attachment.upload-write", { bytesBase64url: "AQIDBA", offset: 0, uploadId: opened.uploadId }))).result, { complete: true, nextOffset: 4 });
  const params = { expectedRevision: 0, idempotencyKey: "attachment-upload-key-0001", libraryId: 1, parentItemKey: "ITEM0001", title: "Evidence", uploadId: opened.uploadId };
  const committed = await router.handle(request(session, "attachment.upload-commit", params));
  const replay = await router.handle(request(session, "attachment.upload-commit", params));
  assert.deepEqual(committed.result, { attachmentKey: "UPLOAD01", libraryId: 1, parentItemKey: "ITEM0001", replayed: false, revision: 1, synced: false, version: 1 });
  assert.equal(committed.event.topic, "library.attachment.changed");
  assert.equal(replay.result.replayed, true);
  assert.equal(calls.filter(value => value[0] === "importAttachment").length, 1);
  await router.dispose();
});

test("attachment lifecycle is one versioned idempotent evented transaction", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router, ["library:write"]);
  const params = { action: "trash", attachmentKey: "PDF00001", expectedRevision: 0, expectedVersion: 1, idempotencyKey: "attachment-trash-key-0001", libraryId: 1 };
  const first = await router.handle(request(session, "library.attachment-mutate", params));
  const replay = await router.handle(request(session, "library.attachment-mutate", params));
  assert.equal(first.event.topic, "library.attachment.changed");
  assert.equal(replay.result.replayed, true);
  assert.equal(calls.filter(value => value[0] === "mutateAttachment").length, 1);
});

test("maps deleted or trashed exact-item failures to an unavailable response", async () => {
  const unavailable = Object.assign(new Error("Zotero attachment 1/PDF00001 is unavailable"), {
    code: "UNAVAILABLE",
  });
  const { router } = createRouter({
    adapter: { async attachment() { throw unavailable; } },
  });
  const session = await handshake(router);

  await assert.rejects(
    router.handle(request(session, "library.attachment", { attachmentKey: "PDF00001", libraryId: 1 })),
    error => error === unavailable,
  );
  assert.deepEqual(mapGeckoCoreError(unavailable), {
    code: "UNAVAILABLE",
    message: "Zotero attachment 1/PDF00001 is unavailable",
    retriable: false,
  });
});

test("maps interrupted transaction reservations to a non-retriable recovery error", () => {
  const recovery = Object.assign(new Error("Core transaction outcome is ambiguous"), {
    code: "TRANSACTION_RECOVERY_REQUIRED",
    scope: "library:1/item:ITEM0001",
  });
  assert.deepEqual(mapGeckoCoreError(recovery), {
    code: "CORE_ERROR",
    details: {
      kind: "TRANSACTION_RECOVERY_REQUIRED",
      scope: "library:1/item:ITEM0001",
    },
    message: "Core transaction outcome is ambiguous",
    retriable: false,
  });
});

test("cancels an in-flight search without changing the session", async () => {
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const adapter = {
    async collections() { return { collections: [] }; },
    async search(_params, { signal }) {
      started();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.code = "CANCELLED";
          reject(error);
        }, { once: true });
      });
    },
  };
  const { router } = createRouter({ adapter });
  const session = await handshake(router);
  const pending = router.handle(request(session, "library.search", { limit: 50, query: "" }, { cancellationId: "active-search" }));
  await startedPromise;

  assert.deepEqual((await router.handle(request(session, "core.cancel", { cancellationId: "active-search" }))).result, { cancelled: true });
  await assert.rejects(pending, error => error.code === "CANCELLED");
  assert.deepEqual((await router.handle(request(session, "core.cancel", { cancellationId: "missing" }))).result, { cancelled: false });
});

test("publishes Core-global events and serves capability-gated bounded replay", async () => {
  const { router } = createRouter();
  const session = await handshake(router, ["events:read", "library:search"]);

  assert.equal(session.eventSequence, 0);
  const searched = await router.handle(request(session, "library.search", { limit: 50, query: "tensor" }));
  assert.equal(searched.event.sequence, 1);
  assert.equal(searched.event.profileEpoch, session.profileEpoch);
  assert.deepEqual((await router.handle(request(session, "core.events", {
    afterSequence: 0,
    limit: 50,
  }))).result.events, [searched.event]);

  const { router: forbidden } = createRouter();
  const withoutEvents = await handshake(forbidden, ["library:read"]);
  await assert.rejects(
    forbidden.handle(request(withoutEvents, "core.events", { afterSequence: 0, limit: 50 })),
    /missing capability events:read/,
  );
});

test("resumes an authenticated session and returns bounded missed events", async () => {
	const { router } = createRouter();
	const session = await handshake(router, ["library:search"]);
	await router.handle(request(session, "library.search", { limit: 50, query: "tensor" }));
	const resumed = (await router.handle({
		id: "resume-1",
		method: "core.resume",
		params: {
			afterSequence: 0,
			limit: 100,
			profileEpoch: session.profileEpoch,
			protocolVersion: "1.0",
			sessionToken: session.sessionToken,
		},
	})).result;
	assert.equal(resumed.events.length, 1);
	assert.equal(resumed.events[0].topic, "library.search.completed");
	assert.equal(resumed.latestSequence, 1);
	assert.deepEqual(resumed.capabilities, ["library:search"]);
	await assert.rejects(router.handle({ id: "resume-bad", method: "core.resume", params: {
		afterSequence: 0, limit: 100, profileEpoch: "other", protocolVersion: "1.0", sessionToken: session.sessionToken,
	} }), /profile epoch/);
});
