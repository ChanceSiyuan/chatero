import assert from "node:assert/strict";
import { test } from "node:test";

import { createGeckoCoreRequestRouter } from "../../../chrome/content/zotero/xpcom/chateroCoreRequestRouter.mjs";

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
    async collections(params) { calls.push(["collections", params]); return { collections: [] }; },
    async itemChildren(params) { calls.push(["itemChildren", params]); return { attachments: [], notes: [] }; },
    async note(params) { calls.push(["note", params]); return { html: "<p>Note</p>", libraryId: 1, noteKey: "NOTE0001", parentItemKey: "ITEM0001", title: "Note" }; },
    async search(params, options) { calls.push(["search", params, options]); return { items: [], total: 0 }; },
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
    expiresAt: 301000,
    profileEpoch: "profile-epoch",
    protocolVersion: "1.0",
    sessionToken: "session-token-with-enough-entropy",
    upstreamVersion: "7.1-real",
  });
  assert.deepEqual((await router.handle(request(session, "profile.status"))).result, {
    profileEpoch: "profile-epoch",
    profileName: "Disposable Profile",
    readOnly: true,
    schemaVersion: 1,
    upstreamVersion: "7.1-real",
  });
  assert.deepEqual((await router.handle(request(session, "library.collections", { libraryId: 1, parentKey: "ROOT" }))).result, { collections: [] });
  assert.deepEqual((await router.handle(request(session, "library.search", { limit: 50, query: "tensor" }))).result, { items: [], total: 0 });
  assert.deepEqual(calls.map(value => value.slice(0, 2)), [
    ["collections", { libraryId: 1, parentKey: "ROOT" }],
    ["search", { limit: 50, query: "tensor" }],
  ]);
  await assert.rejects(handshake(router), /already consumed/);
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

test("routes read-only PDF children, Note, and annotation methods through library:read", async () => {
  const { calls, router } = createRouter();
  const session = await handshake(router);

  assert.deepEqual((await router.handle(request(session, "library.item-children", { libraryId: 1, itemKey: "ITEM0001" }))).result, { attachments: [], notes: [] });
  assert.deepEqual((await router.handle(request(session, "library.annotations", { attachmentKey: "PDF00001", libraryId: 1 }))).result, { annotations: [] });
  assert.equal((await router.handle(request(session, "library.note", { libraryId: 1, noteKey: "NOTE0001" }))).result.html, "<p>Note</p>");
  assert.deepEqual(calls.map(value => value[0]), ["itemChildren", "annotations", "note"]);
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
