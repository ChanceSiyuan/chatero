import assert from "node:assert/strict";
import { test } from "node:test";

import { withChangeContext } from "../extensions/chatero-documentation/text-change-set.mjs";
import { createWorkingCopyCoordinator } from "../extensions/chatero-documentation/working-copy-coordinator.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

function uri(path) {
  return Object.freeze({ path, toString: () => `file://${path}` });
}

class Position {
  constructor(offset) {
    this.offset = offset;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class WorkspaceEdit {
  constructor() {
    this.replacements = [];
  }

  replace(target, range, newText) {
    this.replacements.push({ uri: target, range, newText });
  }
}

function createFakeWorkspace(initialDocuments, options = {}) {
  const listeners = new Set();
  const appliedEdits = [];
  const openLog = [];
  const documents = new Map(initialDocuments.map(input => {
    const document = {
      uri: input.uri,
      version: input.version,
      text: input.text,
      positionAt(offset) {
        options.onPositionAt?.({ document, offset, workspace });
        return new Position(offset);
      },
      getText() { return document.text; },
    };
    return [input.uri.toString(), document];
  }));

  function emit(document, contentChanges) {
    const event = Object.freeze({ document, contentChanges: Object.freeze(contentChanges) });
    for (const listener of [...listeners]) listener(event);
  }

  function externalEdit(target, changes) {
    const document = documents.get(target.toString());
    const before = document.text;
    const normalized = [...changes].sort((left, right) => left.from - right.from);
    let after = before;
    for (const change of [...normalized].reverse()) {
      after = after.slice(0, change.from) + change.insert + after.slice(change.to);
    }
    document.text = after;
    document.version += 1;
    emit(document, normalized.map(change => Object.freeze({
      rangeOffset: change.from,
      rangeLength: change.to - change.from,
      text: change.insert,
    })));
  }

  const workspace = {
    appliedEdits,
    documents,
    openLog,
    textDocuments: [...documents.values()],
    onDidChangeTextDocument(listener) {
      listeners.add(listener);
      return Object.freeze({ dispose: () => listeners.delete(listener) });
    },
    async openTextDocument(target) {
      openLog.push(target.toString());
      const document = documents.get(target.toString());
      if (!document) throw new Error(`missing document ${target}`);
      return document;
    },
    applyEdit(edit) {
      appliedEdits.push(edit);
      options.applyStarted?.resolve();
      options.beforeOwnedEvents?.({ edit, workspace });
      if (options.applyResult === false) return Promise.resolve(false);
      if (options.applyError) return Promise.reject(options.applyError);
      const grouped = new Map();
      for (const replacement of edit.replacements) {
        const key = replacement.uri.toString();
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(replacement);
      }
      for (const [key, replacements] of grouped) {
        const document = documents.get(key);
        const before = document.text;
        const ascending = [...replacements].sort((left, right) => left.range.start.offset - right.range.start.offset);
        let after = before;
        for (const replacement of [...ascending].reverse()) {
          after = after.slice(0, replacement.range.start.offset)
            + replacement.newText
            + after.slice(replacement.range.end.offset);
        }
        document.text = after;
        document.version += 1;
        emit(document, ascending.map(replacement => Object.freeze({
          rangeOffset: replacement.range.start.offset,
          rangeLength: replacement.range.end.offset - replacement.range.start.offset,
          text: replacement.newText,
        })));
      }
      if (options.responseGate && appliedEdits.length === 1) {
        return options.responseGate.promise.then(() => true);
      }
      return Promise.resolve(true);
    },
    emit,
    externalEdit,
  };
  return workspace;
}

function coordinatorFor(workspace) {
  return createWorkingCopyCoordinator({ workspace, WorkspaceEdit, Position, Range });
}

test("settles an event-before-promise edit exactly once", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  const workspace = createFakeWorkspace([{ uri: target, version: 7, text: "hello there" }]);
  const document = workspace.documents.get(target.toString());
  const coordinator = coordinatorFor(workspace);
  const result = await coordinator.applyVersionedTextEdits({
    operationId: "op-1",
    origin: "live-preview",
    edits: [{
      uri: document.uri,
      baseVersion: 7,
      changes: withChangeContext(document.getText(), [{ from: 6, to: 11, insert: "world" }]),
    }],
  });
  assert.deepEqual(result, {
    kind: "applied",
    operationId: "op-1",
    versions: [{ uri: document.uri, before: 7, after: 8 }],
  });
  assert.equal(workspace.appliedEdits.length, 1);
  assert.equal(document.getText(), "hello world");
  coordinator.dispose();
});

test("serializes same-URI callers and drain behind the current tail", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  const responseGate = deferred();
  const applyStarted = deferred();
  const workspace = createFakeWorkspace([{ uri: target, version: 7, text: "hello there" }], { applyStarted, responseGate });
  const coordinator = coordinatorFor(workspace);
  const first = coordinator.applyVersionedTextEdits({
    operationId: "fifo-1",
    origin: "live-preview",
    edits: [{ uri: target, baseVersion: 7, changes: withChangeContext("hello there", [{ from: 6, to: 11, insert: "world" }]) }],
  });
  const second = coordinator.applyVersionedTextEdits({
    operationId: "fifo-2",
    origin: "human-apply",
    edits: [{ uri: target, baseVersion: 8, changes: withChangeContext("hello world", [{ from: 0, to: 5, insert: "goodbye" }]) }],
  });
  let drained = false;
  const drain = coordinator.drain(target).then(() => { drained = true; });
  await applyStarted.promise;
  assert.equal(workspace.appliedEdits.length, 1);
  assert.equal(drained, false);
  responseGate.resolve();
  assert.equal((await first).kind, "applied");
  assert.equal((await second).kind, "applied");
  await drain;
  assert.equal(workspace.documents.get(target.toString()).getText(), "goodbye world");
  coordinator.dispose();
});

test("takes reversed multi-URI requests in one sorted order without deadlock", async () => {
  const a = uri("/workspace/documentation/a.qmd");
  const b = uri("/workspace/documentation/b.qmd");
  const workspace = createFakeWorkspace([
    { uri: a, version: 1, text: "a" },
    { uri: b, version: 1, text: "b" },
  ]);
  const coordinator = coordinatorFor(workspace);
  const gate = deferred();
  const entered = [];
  const first = coordinator.withUris([b, a], async () => {
    entered.push("first");
    await gate.promise;
  });
  const second = coordinator.withUris([a, b], async () => { entered.push("second"); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(entered, ["first"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(entered, ["first", "second"]);
  assert.deepEqual(workspace.openLog, [a.toString(), b.toString(), a.toString(), b.toString()]);
  await assert.rejects(coordinator.withUris([a, a], async () => {}), /duplicate URI/i);
  coordinator.dispose();
});

test("uses one WorkspaceEdit for a multi-document settlement", async () => {
  const a = uri("/workspace/documentation/a.qmd");
  const b = uri("/workspace/documentation/b.qmd");
  const workspace = createFakeWorkspace([
    { uri: a, version: 2, text: "alpha" },
    { uri: b, version: 4, text: "beta" },
  ]);
  const coordinator = coordinatorFor(workspace);
  const result = await coordinator.applyVersionedTextEdits({
    operationId: "settle-1",
    origin: "settlement",
    edits: [
      { uri: b, baseVersion: 4, changes: withChangeContext("beta", [{ from: 0, to: 4, insert: "B" }]) },
      { uri: a, baseVersion: 2, changes: withChangeContext("alpha", [{ from: 0, to: 5, insert: "A" }]) },
    ],
  });
  assert.equal(result.kind, "applied");
  assert.equal(workspace.appliedEdits.length, 1);
  assert.equal(workspace.appliedEdits[0].replacements.length, 2);
  assert.deepEqual(result.versions, [
    { uri: b, before: 4, after: 5 },
    { uri: a, before: 2, after: 3 },
  ]);
  coordinator.dispose();
});

test("returns authoritative conflicts and never applies stale or invalid ranges", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  const workspace = createFakeWorkspace([{ uri: target, version: 9, text: "authoritative" }]);
  const coordinator = coordinatorFor(workspace);
  assert.deepEqual(await coordinator.applyVersionedTextEdits({
    operationId: "stale",
    origin: "live-preview",
    edits: [{ uri: target, baseVersion: 8, changes: withChangeContext("authoritative", [{ from: 0, to: 1, insert: "A" }]) }],
  }), {
    kind: "version-conflict",
    operationId: "stale",
    documents: [{ uri: target, expectedVersion: 8, actualVersion: 9, text: "authoritative" }],
  });
  assert.equal(workspace.appliedEdits.length, 0);

  await assert.rejects(coordinator.applyVersionedTextEdits({
    operationId: "bad-range",
    origin: "live-preview",
    edits: [{
      uri: target,
      baseVersion: 9,
      changes: [{ from: 1, to: 2, insert: "x", deletedText: "", leftContext: "", rightContext: "" }],
    }],
  }), /deleted text|UTF-16 boundary/i);
  assert.equal(workspace.appliedEdits.length, 0);
  coordinator.dispose();
});

test("reports apply false and thrown apply failures without treating the boolean as an event", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  for (const options of [{ applyResult: false }, { applyError: new Error("bulk edit failed") }]) {
    const workspace = createFakeWorkspace([{ uri: target, version: 1, text: "old" }], options);
    const coordinator = coordinatorFor(workspace);
    const result = await coordinator.applyVersionedTextEdits({
      operationId: "failure",
      origin: "live-preview",
      edits: [{ uri: target, baseVersion: 1, changes: withChangeContext("old", [{ from: 0, to: 3, insert: "new" }]) }],
    });
    assert.equal(result.kind, "apply-failed");
    assert.equal(result.operationId, "failure");
    assert.match(result.message, /false|bulk edit failed/i);
    coordinator.dispose();
  }
});

test("ignores unrelated events while matching exact owned event fingerprints", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  const unrelated = uri("/workspace/documentation/unrelated.qmd");
  let fired = false;
  const workspace = createFakeWorkspace([
    { uri: target, version: 1, text: "old" },
    { uri: unrelated, version: 4, text: "other" },
  ], {
    beforeOwnedEvents({ workspace: active }) {
      if (fired) return;
      fired = true;
      active.externalEdit(unrelated, [{ from: 0, to: 5, insert: "OTHER" }]);
    },
  });
  const coordinator = coordinatorFor(workspace);
  const result = await coordinator.applyVersionedTextEdits({
    operationId: "unrelated",
    origin: "live-preview",
    edits: [{ uri: target, baseVersion: 1, changes: withChangeContext("old", [{ from: 0, to: 3, insert: "new" }]) }],
  });
  assert.equal(result.kind, "applied");
  coordinator.dispose();
});

test("catches a standard-editor mutation during range conversion", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  let injected = false;
  const workspace = createFakeWorkspace([{ uri: target, version: 3, text: "hello there" }], {
    onPositionAt({ workspace: active }) {
      if (injected) return;
      injected = true;
      active.externalEdit(target, [{ from: 0, to: 5, insert: "HELLO" }]);
    },
  });
  const coordinator = coordinatorFor(workspace);
  const result = await coordinator.applyVersionedTextEdits({
    operationId: "conversion-race",
    origin: "live-preview",
    edits: [{ uri: target, baseVersion: 3, changes: withChangeContext("hello there", [{ from: 6, to: 11, insert: "world" }]) }],
  });
  assert.equal(result.kind, "version-conflict");
  assert.equal(result.documents[0].actualVersion, 4);
  assert.equal(result.documents[0].text, "HELLO there");
  assert.equal(workspace.appliedEdits.length, 0);
  coordinator.dispose();
});

test("does not mis-correlate an equal-byte external event as coordinator-owned", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  let injected = false;
  const intended = { from: 6, to: 11, insert: "world" };
  const workspace = createFakeWorkspace([{ uri: target, version: 3, text: "hello there" }], {
    onPositionAt({ workspace: active }) {
      if (injected) return;
      injected = true;
      active.externalEdit(target, [intended]);
    },
  });
  const coordinator = coordinatorFor(workspace);
  const result = await coordinator.applyVersionedTextEdits({
    operationId: "equal-race",
    origin: "live-preview",
    edits: [{ uri: target, baseVersion: 3, changes: withChangeContext("hello there", [intended]) }],
  });
  assert.equal(result.kind, "version-conflict");
  assert.equal(result.documents[0].text, "hello world");
  assert.equal(workspace.appliedEdits.length, 0);
  assert.equal(workspace.documents.get(target.toString()).getText(), "hello world");
  coordinator.dispose();
});

test("disposal closes the coordinator and rejected work does not poison queues", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  const workspace = createFakeWorkspace([{ uri: target, version: 1, text: "text" }]);
  const coordinator = coordinatorFor(workspace);
  await assert.rejects(coordinator.withUris([target], async () => { throw new Error("task failed"); }), /task failed/);
  await coordinator.withUris([target], async documents => {
    assert.equal(documents.get(target.toString()).getText(), "text");
  });
  coordinator.dispose();
  await assert.rejects(coordinator.withUris([target], async () => {}), /disposed/i);
  assert.throws(() => coordinator.drain(target), /disposed/i);
});
