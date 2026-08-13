import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createGeckoCoreRequestRouter,
  mapGeckoCoreError,
} from "../../../chrome/content/zotero/xpcom/chateroCoreRequestRouter.mjs";

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
    async collections(params) { calls.push(["collections", params]); return { collections: [] }; },
    async feeds(params) { calls.push(["feeds", params]); return { feeds: [] }; },
    async itemChildren(params) { calls.push(["itemChildren", params]); return { attachments: [], notes: [] }; },
    async itemMetadata(params) { calls.push(["itemMetadata", params]); return { itemKey: params.itemKey, libraryId: params.libraryId }; },
    async itemFacts(params) { calls.push(["itemFacts", params]); return { citationWarning: false, itemKey: params.itemKey, libraryId: params.libraryId, relations: [], retracted: false, synced: true, version: 1 }; },
    async updateItem(params) { calls.push(["updateItem", params]); return { itemKey: params.itemKey, libraryId: params.libraryId, synced: false, version: params.expectedVersion + 1 }; },
    async libraries(params) { calls.push(["libraries", params]); return { libraries: [] }; },
    async note(params) { calls.push(["note", params]); return { html: "<p>Note</p>", libraryId: 1, noteKey: "NOTE0001", parentItemKey: "ITEM0001", title: "Note" }; },
    async updateNote(params) { calls.push(["updateNote", params]); return { libraryId: params.libraryId, noteKey: params.noteKey, synced: false, version: params.expectedVersion + 1 }; },
    async profileBackup() { calls.push(["profileBackup"]); return { backupCreated: true, completedAt: 1234 }; },
    async profileStatus() { calls.push(["profileStatus"]); return { compatibilityVersion: 10, integrityCheckRequired: false, profileEpoch: "profile-epoch", profileName: "Disposable Profile", quickCheckPassed: true, readOnly: false, schemaVersion: 142, upstreamVersion: "7.1-real" }; },
    async savedSearches(params) { calls.push(["savedSearches", params]); return { searches: [] }; },
    async savedSearchItems(params) { calls.push(["savedSearchItems", params]); return { items: [], total: 0 }; },
    async search(params, options) { calls.push(["search", params, options]); return { items: [], total: 0 }; },
    async syncStatus(params) { calls.push(["syncStatus", params]); return { enabled: true, inProgress: false, libraries: [], offline: false, status: "" }; },
    async retrySync(params) { calls.push(["retrySync", params]); return { completed: true, libraryIds: params.libraryIds }; },
    async tags(params) { calls.push(["tags", params]); return { tags: [], total: 0 }; },
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
});

test("sync retry is a separately authorized idempotent transaction", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router, ["sync:write"]);
  const params = { expectedRevision: 0, idempotencyKey: "sync-retry-key-0001", libraryIds: [1, 2] };
  const first = await router.handle(request(session, "sync.retry", params));
  const replay = await router.handle(request(session, "sync.retry", params));
  assert.deepEqual(first.result, { completed: true, libraryIds: [1, 2], replayed: false, revision: 1 });
  assert.equal(first.event.topic, "sync.completed");
  assert.equal(replay.result.replayed, true);
  assert.equal(calls.filter(value => value[0] === "retrySync").length, 1);
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
