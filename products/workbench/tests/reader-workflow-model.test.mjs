import assert from "node:assert/strict";
import { test } from "node:test";

import { ReaderWorkflowModel } from "../extensions/chatero-zotero/reader-workflow-model.mjs";

const attachment = Object.freeze({
  annotationCount: 1,
  attachmentKey: "PDF00001",
  contentType: "application/pdf",
  filename: "paper.pdf",
  libraryId: 7,
  parentItemKey: "ITEM0001",
  title: "Paper",
  version: 4,
});

const annotation = Object.freeze({
  annotationKey: "ANN00001",
  color: "#ffd400",
  comment: "Initial",
  libraryId: 7,
  pageLabel: "3",
  positionJson: '{"pageIndex":2,"rects":[[1,2,3,4]]}',
  sortIndex: "00002|000001|00000",
  tags: ["evidence"],
  text: "Quoted text",
  type: "highlight",
  version: 2,
});

test("loads exact Reader state and annotations without a path", async () => {
  const calls = [];
  const core = {
    async attachment(identity) { calls.push(["attachment", identity]); return attachment; },
    async annotations(identity) { calls.push(["annotations", identity]); return [annotation]; },
    async request(method, params) {
      calls.push([method, params]);
      return { attachmentKey: "PDF00001", contentType: "application/pdf", libraryId: 7, pageIndex: 2, version: 4 };
    },
  };
  const model = new ReaderWorkflowModel({ core, idempotencyKey: () => "reader-test-key-0001" });

  const loaded = await model.load({ attachmentKey: "PDF00001", libraryId: 7 });
  assert.equal(Object.hasOwn(loaded.attachment, "path"), false);
  assert.equal(loaded.state.pageIndex, 2);
  assert.equal(loaded.annotations[0].tags[0], "evidence");
  assert.deepEqual(calls.map(value => value[0]), ["attachment", "reader.state", "annotations"]);
});

test("persists Reader position with exact version and idempotent revision retry", async () => {
  const calls = [];
  let stateReads = 0;
  const core = {
    attachment: async () => attachment,
    annotations: async () => [annotation],
    async request(method, params) {
      calls.push({ method, params });
      if (method === "reader.state" && ++stateReads === 1) return { attachmentKey: "PDF00001", contentType: "application/pdf", libraryId: 7, pageIndex: 0, version: 4 };
      if (method === "reader.state") return { attachmentKey: "PDF00001", contentType: "application/pdf", libraryId: 7, pageIndex: 1, version: 5 };
      if (calls.filter(value => value.method === "reader.state-update").length === 1) {
        const error = new Error("scope changed");
        error.code = "CONFLICT";
        error.details = { actualRevision: 8, kind: "REVISION_CONFLICT" };
        throw error;
      }
      return { ...params, contentType: "application/pdf", replayed: false, revision: 9, synced: false, version: 4 };
    },
  };
  const keys = ["reader-test-key-0001", "reader-test-key-0002"];
  const model = new ReaderWorkflowModel({ core, idempotencyKey: () => keys.shift() });
  await model.load({ attachmentKey: "PDF00001", libraryId: 7 });
  await assert.rejects(model.updateLocation({ pageIndex: 6, scrollYPercent: 0.25 }), /exactly pageIndex/);
  const result = await model.updateLocation({ pageIndex: 6 });

  const writes = calls.filter(value => value.method === "reader.state-update");
  assert.equal(writes.length, 2);
  assert.equal(writes[0].params.expectedVersion, 4);
  assert.equal(writes[0].params.expectedRevision, 0);
  assert.equal(writes[1].params.expectedRevision, 8);
  assert.notEqual(writes[0].params.idempotencyKey, writes[1].params.idempotencyKey);
  assert.equal(result.version, 4);
});

test("creates, edits, tags, trashes, restores, and undoes annotations through named Core transactions", async () => {
  const calls = [];
  let current = annotation;
  let revision = 0;
  const core = {
    attachment: async () => attachment,
    annotations: async () => [current],
    async request(method, params) {
      calls.push({ method, params });
      if (method === "reader.state") return { attachmentKey: "PDF00001", contentType: "application/pdf", libraryId: 7, pageIndex: 0, version: 4 };
      revision += 1;
      if (method === "library.annotation-mutate") {
        const key = params.annotationKey || "ANNNEW01";
        current = { ...current, ...params, annotationKey: key, libraryId: 7, version: (params.expectedVersion ?? 0) + 1 };
        return { action: params.action, annotation: current, deleted: params.action === "trash", replayed: false, revision, synced: false };
      }
      if (method === "library.annotations-update") {
        const update = params.updates[0];
        current = { ...current, ...update, version: update.expectedVersion + 1 };
        return { annotations: [{ annotationKey: current.annotationKey, libraryId: 7, synced: false, version: current.version }], replayed: false, revision };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const model = new ReaderWorkflowModel({ core, idempotencyKey: () => `reader-test-key-${String(calls.length).padStart(4, "0")}` });
  await model.load({ attachmentKey: "PDF00001", libraryId: 7 });
  await model.createAnnotation({ color: "#2ea8e5", comment: "New", pageLabel: "4", positionJson: '{"pageIndex":3,"rects":[[5,6,7,8]]}', sortIndex: "00003|000001|00000", tags: ["method"], text: "New quote", type: "highlight" });
  await model.updateAnnotations([{ annotationKey: "ANNNEW01", color: "#a28ae5", comment: "Edited", expectedVersion: 1, tags: ["reviewed"] }]);
  await model.mutateAnnotation({ action: "trash", annotationKey: "ANNNEW01", expectedVersion: 2 });
  await model.mutateAnnotation({ action: "restore", annotationKey: "ANNNEW01", expectedVersion: 3 });
  assert.equal(await model.undo(), true);

  assert.deepEqual(calls.filter(value => value.method.startsWith("library.annotation") || value.method === "library.annotations-update").map(value => value.method), [
    "library.annotation-mutate", "library.annotations-update", "library.annotation-mutate", "library.annotation-mutate", "library.annotation-mutate",
  ]);
  assert.equal(calls.at(-1).params.action, "trash");
  assert.ok(calls.every(value => JSON.stringify(value.params).includes("/Users/") === false));
});

test("applies reviewed annotation proposals as one same-library atomic batch", async () => {
  const calls = [];
  const core = {
    attachment: async () => attachment,
    annotations: async () => [annotation],
    request: async method => method === "reader.state"
      ? { attachmentKey: "PDF00001", contentType: "application/pdf", libraryId: 7, pageIndex: 0, version: 4 }
      : null,
    async batchMutate(value) { calls.push(value); return { replayed: false, results: value.operations.map(operation => ({ kind: operation.kind, result: {} })), revision: 1 }; },
  };
  const model = new ReaderWorkflowModel({ core });
  await model.load({ attachmentKey: "PDF00001", libraryId: 7 });
  const proposal = model.reviewProposal({
    proposalId: "proposal-0001",
    updates: [{ annotationKey: "ANN00001", comment: "Agent-reviewed", expectedVersion: 2 }],
  });
  assert.equal(proposal.status, "pending-review");
  await model.applyProposal("proposal-0001");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].libraryId, 7);
  assert.deepEqual(calls[0].operations.map(value => value.kind), ["annotations-update"]);
  assert.equal(model.proposals[0].status, "applied");
});

test("updates complete Notes and renders citations through Core only", async () => {
  const calls = [];
  const core = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "library.note") return { html: "<p>Old</p>", libraryId: 7, noteKey: "NOTE0001", parentItemKey: "ITEM0001", title: "Note", version: 3 };
      if (method === "library.note-update") return { libraryId: 7, noteKey: "NOTE0001", replayed: false, revision: 1, synced: false, version: 4 };
      if (method === "citation.render") return { html: "<p>(Lovelace, 2024)</p>", text: "(Lovelace, 2024)" };
      throw new Error(`unexpected ${method}`);
    },
  };
  const model = new ReaderWorkflowModel({ core, idempotencyKey: () => "reader-test-key-0001" });
  const note = await model.loadNote({ libraryId: 7, noteKey: "NOTE0001" });
  await model.updateNote({ ...note, html: "<p>New</p>" });
  const rendered = await model.renderCitation({ identities: [{ itemKey: "ITEM0001", libraryId: 7 }], mode: "citation", styleId: "apa" });
  assert.equal(rendered.text, "(Lovelace, 2024)");
  assert.equal(calls[1].params.expectedVersion, 3);
  assert.equal(Object.hasOwn(calls[1].params, "path"), false);
});
