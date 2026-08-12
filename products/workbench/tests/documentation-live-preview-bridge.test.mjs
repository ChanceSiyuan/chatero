import assert from "node:assert/strict";
import { test } from "node:test";

import { createLivePreviewBridgeRegistry } from "../extensions/chatero-documentation/live-preview-bridge.mjs";
import { createPendingDescriptor } from "../extensions/chatero-documentation/live-preview-protocol.mjs";
import { digestSourceText, withChangeContext } from "../extensions/chatero-documentation/text-change-set.mjs";
import { createWorkingCopyCoordinator } from "../extensions/chatero-documentation/working-copy-coordinator.mjs";

const NONCE_A = "A".repeat(24);
const NONCE_B = "B".repeat(24);

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function uri(path) {
  return Object.freeze({ path, toString: () => `file://${path}` });
}

class Position {
  constructor(offset) { this.offset = offset; }
}

class Range {
  constructor(start, end) { this.start = start; this.end = end; }
}

class WorkspaceEdit {
  constructor() { this.replacements = []; }
  replace(target, range, newText) { this.replacements.push({ uri: target, range, newText }); }
}

function createWorkspace(target, text = "qmd", version = 1, options = {}) {
  const changeListeners = new Set();
  const appliedEdits = [];
  let injected = false;
  const document = {
    uri: target,
    version,
    text,
    getText() { return document.text; },
    positionAt(offset) {
      if (!injected && options.injectEqualExternalOnPosition) {
        injected = true;
        workspace.externalEdit(options.injectEqualExternalOnPosition);
      }
      return new Position(offset);
    },
    isDirty: false,
  };

  function emit(contentChanges) {
    const event = Object.freeze({ document, contentChanges: Object.freeze(contentChanges) });
    for (const listener of [...changeListeners]) listener(event);
  }

  function applyChanges(changes) {
    const ascending = [...changes].sort((left, right) => left.from - right.from);
    let next = document.text;
    for (const change of [...ascending].reverse()) {
      next = next.slice(0, change.from) + change.insert + next.slice(change.to);
    }
    document.text = next;
    document.version += 1;
    document.isDirty = true;
    emit(ascending.map(change => Object.freeze({
      rangeOffset: change.from,
      rangeLength: change.to - change.from,
      text: change.insert,
    })));
  }

  const workspace = {
    appliedEdits,
    textDocuments: [document],
    onDidChangeTextDocument(listener) {
      changeListeners.add(listener);
      return Object.freeze({ dispose: () => changeListeners.delete(listener) });
    },
    async openTextDocument(opened) {
      assert.equal(opened.toString(), target.toString());
      return document;
    },
    async applyEdit(edit) {
      appliedEdits.push(edit);
      if (options.applyResult === false) return false;
      applyChanges(edit.replacements.map(replacement => ({
        from: replacement.range.start.offset,
        to: replacement.range.end.offset,
        insert: replacement.newText,
      })));
      return true;
    },
    externalEdit(change) { applyChanges([change]); },
  };
  return { document, workspace };
}

function createPanel(name) {
  const messageListeners = new Set();
  const disposeListeners = new Set();
  const messages = [];
  let disposed = false;
  return {
    name,
    messages,
    webview: {
      async postMessage(message) {
        if (disposed) return false;
        messages.push(message);
        return true;
      },
      onDidReceiveMessage(listener) {
        messageListeners.add(listener);
        return Object.freeze({ dispose: () => messageListeners.delete(listener) });
      },
    },
    onDidDispose(listener) {
      disposeListeners.add(listener);
      return Object.freeze({ dispose: () => disposeListeners.delete(listener) });
    },
    async receive(message) {
      await Promise.all([...messageListeners].map(listener => listener(message)));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const listener of [...disposeListeners]) listener();
      disposeListeners.clear();
      messageListeners.clear();
    },
  };
}

async function attachReady(registry, document, panel, sessionId, cspNonce) {
  const attachment = registry.attach(document, panel, { cspNonce });
  await panel.receive({ type: "ready", sessionId, pendingDescriptors: [] });
  assert.equal(panel.messages.at(-1).type, "initialize");
  assert.equal(panel.messages.at(-1).sessionId, sessionId);
  return attachment;
}

test("binds passive image requests to the attached document and disposes the panel resolver", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  const { coordinator, document, registry } = createComposition(target);
  const panel = createPanel("image");
  const calls = [];
  let disposed = 0;
  const imageResolver = {
    async resolve(pageUri, imageTarget) {
      calls.push({ pageUri, imageTarget });
      return Object.freeze({ kind: "placeholder", target: imageTarget, reason: "missing" });
    },
    dispose() { disposed += 1; },
  };
  registry.attach(document, panel, { cspNonce: NONCE_A, imageResolver });
  await panel.receive({ type: "ready", sessionId: "image", pendingDescriptors: [] });
  panel.messages.length = 0;
  await panel.receive({ type: "imageRequest", sessionId: "image", requestId: "image_1", target: "assets/plot.png" });
  assert.deepEqual(calls, [{ pageUri: target, imageTarget: "assets/plot.png" }]);
  assert.deepEqual(panel.messages.at(-1), {
    type: "imageResult",
    sessionId: "image",
    requestId: "image_1",
    resolution: { kind: "placeholder", target: "assets/plot.png", reason: "missing" },
  });
  panel.dispose();
  assert.equal(disposed, 1);
  registry.dispose();
  coordinator.dispose();
});

function createComposition(target, text = "qmd", version = 1, options = {}) {
  const { document, workspace } = createWorkspace(target, text, version, options);
  const commands = {
    calls: [],
    async executeCommand(command) { commands.calls.push(command); },
  };
  const coordinator = createWorkingCopyCoordinator({ workspace, WorkspaceEdit, Position, Range });
  const registry = createLivePreviewBridgeRegistry({ workspace, commands, coordinator });
  return { commands, coordinator, document, registry, workspace };
}

test("suppresses the authoritative echo only for the optimistic origin", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  const { coordinator, document, registry, workspace } = createComposition(target);
  const panelA = createPanel("A");
  const panelB = createPanel("B");
  await attachReady(registry, document, panelA, "a", NONCE_A);
  await attachReady(registry, document, panelB, "b", NONCE_B);
  panelA.messages.length = 0;
  panelB.messages.length = 0;

  await panelA.receive({
    type: "edit",
    sessionId: "a",
    opId: "a:1",
    baseVersion: document.version,
    changes: withChangeContext(document.getText(), [{ from: 0, to: 1, insert: "Q" }]),
  });
  assert.equal(workspace.appliedEdits.length, 1);
  assert.equal(document.isDirty, true);
  assert.equal(panelA.messages.filter(message => message.type === "operationAcknowledged").length, 1);
  assert.equal(panelA.messages.filter(message => message.type === "documentChanged").length, 0);
  assert.equal(panelB.messages.filter(message => message.type === "operationAcknowledged").length, 0);
  assert.equal(panelB.messages.at(-1).type, "documentChanged");
  assert.equal(panelA.messages.at(-1).afterVersion, document.version);
  assert.equal(panelA.messages.at(-1).digest, await digestSourceText(document.getText()));
  assert.equal(document.getText(), "Qmd");
  registry.dispose();
  coordinator.dispose();
});

test("serializes interleaved panels and broadcasts each transaction once", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  const { coordinator, document, registry, workspace } = createComposition(target, "abcd", 3);
  const panelA = createPanel("A");
  const panelB = createPanel("B");
  await attachReady(registry, document, panelA, "a", NONCE_A);
  await attachReady(registry, document, panelB, "b", NONCE_B);
  panelA.messages.length = 0;
  panelB.messages.length = 0;

  await panelA.receive({ type: "edit", sessionId: "a", opId: "a:1", baseVersion: 3, changes: withChangeContext("abcd", [{ from: 1, to: 1, insert: "X" }]) });
  await panelB.receive({ type: "edit", sessionId: "b", opId: "b:1", baseVersion: 4, changes: withChangeContext("aXbcd", [
    { from: 0, to: 1, insert: "A" },
    { from: 4, to: 5, insert: "D" },
  ]) });
  assert.equal(document.getText(), "AXbcD");
  assert.equal(workspace.appliedEdits.length, 2);
  assert.equal(panelA.messages.filter(message => message.type === "operationAcknowledged").length, 1);
  assert.equal(panelA.messages.filter(message => message.type === "documentChanged").length, 1);
  assert.equal(panelB.messages.filter(message => message.type === "operationAcknowledged").length, 1);
  assert.equal(panelB.messages.filter(message => message.type === "documentChanged").length, 1);
  registry.dispose();
  coordinator.dispose();
});

test("broadcasts unmatched standard-editor changes to every attached view", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  const { coordinator, document, registry, workspace } = createComposition(target, "text", 1);
  const panelA = createPanel("A");
  const panelB = createPanel("B");
  await attachReady(registry, document, panelA, "a", NONCE_A);
  await attachReady(registry, document, panelB, "b", NONCE_B);
  panelA.messages.length = 0;
  panelB.messages.length = 0;
  workspace.externalEdit({ from: 0, to: 4, insert: "TEXT" });
  await registry.drain(target);
  assert.equal(panelA.messages.at(-1).type, "documentChanged");
  assert.equal(panelB.messages.at(-1).type, "documentChanged");
  assert.deepEqual(panelA.messages.at(-1).changes, panelB.messages.at(-1).changes);
  registry.dispose();
  coordinator.dispose();
});

test("rejects an equal-byte external event as ownership and resynchronizes the origin", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  const intended = { from: 6, to: 11, insert: "world" };
  const { coordinator, document, registry, workspace } = createComposition(target, "hello there", 3, {
    injectEqualExternalOnPosition: intended,
  });
  const panelA = createPanel("A");
  const panelB = createPanel("B");
  await attachReady(registry, document, panelA, "a", NONCE_A);
  await attachReady(registry, document, panelB, "b", NONCE_B);
  panelA.messages.length = 0;
  panelB.messages.length = 0;
  await panelA.receive({
    type: "edit", sessionId: "a", opId: "a:1", baseVersion: 3,
    changes: withChangeContext("hello there", [intended]),
  });
  assert.equal(workspace.appliedEdits.length, 0);
  assert.equal(document.getText(), "hello world");
  assert.equal(panelA.messages.some(message => message.type === "operationAcknowledged"), false);
  assert.equal(panelA.messages.some(message => message.type === "resync" && message.source === "hello world"), true);
  assert.equal(panelB.messages.filter(message => message.type === "documentChanged").length, 1);
  registry.dispose();
  coordinator.dispose();
});

test("drains URI edits before invoking normal Workbench undo and redo", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  const order = [];
  const { document, workspace } = createWorkspace(target);
  const coordinator = {
    async drain(received) { assert.equal(received, target); order.push("drain"); },
    async applyVersionedTextEdits() { throw new Error("not used"); },
  };
  const commands = { async executeCommand(command) { order.push(command); } };
  const registry = createLivePreviewBridgeRegistry({ workspace, commands, coordinator });
  const panel = createPanel("A");
  await attachReady(registry, document, panel, "a", NONCE_A);
  await panel.receive({ type: "history", sessionId: "a", direction: "undo" });
  await panel.receive({ type: "history", sessionId: "a", direction: "redo" });
  assert.deepEqual(order, ["drain", "undo", "drain", "redo"]);
  registry.dispose();
});

test("reassociates an exact descriptor only while the same bridge holds the body", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  const { document, workspace } = createWorkspace(target, "text", 1);
  const gate = deferred();
  let received;
  const coordinator = {
    async drain() {},
    async applyVersionedTextEdits(input) {
      received = input;
      await gate.promise;
      return { kind: "apply-failed", operationId: input.operationId, message: "disconnected" };
    },
  };
  const commands = { async executeCommand() {} };
  const registry = createLivePreviewBridgeRegistry({ workspace, commands, coordinator });
  const keeper = createPanel("keeper");
  const first = createPanel("first");
  await attachReady(registry, document, keeper, "keeper", NONCE_B);
  await attachReady(registry, document, first, "a", NONCE_A);
  const changes = withChangeContext("text", [{ from: 0, to: 1, insert: "T" }]);
  const operation = { opId: "a:1", baseVersion: 1, changes };
  const descriptor = await createPendingDescriptor(operation);
  const pendingReceive = first.receive({ type: "edit", sessionId: "a", ...operation });
  while (!received) await new Promise(resolve => setImmediate(resolve));
  first.dispose();

  const reloaded = createPanel("reload");
  registry.attach(document, reloaded, { cspNonce: NONCE_A });
  await reloaded.receive({ type: "ready", sessionId: "a", pendingDescriptors: [descriptor] });
  assert.deepEqual(reloaded.messages.at(-1).reassociatedPendingOperations, [operation]);
  gate.resolve();
  await pendingReceive;
  registry.dispose();

  const restarted = createLivePreviewBridgeRegistry({ workspace, commands, coordinator });
  const afterRestart = createPanel("after-restart");
  restarted.attach(document, afterRestart, { cspNonce: NONCE_A });
  await afterRestart.receive({ type: "ready", sessionId: "a", pendingDescriptors: [descriptor] });
  assert.deepEqual(afterRestart.messages.at(-1).reassociatedPendingOperations, []);
  restarted.dispose();
});

test("tears down panel and bridge listeners without disposing the shared coordinator", async () => {
  const target = uri("/workspace/documentation/page.qmd");
  const { coordinator, document, registry, workspace } = createComposition(target);
  const panel = createPanel("A");
  const attachment = await attachReady(registry, document, panel, "a", NONCE_A);
  assert.equal(registry.bridgeCount, 1);
  attachment.dispose();
  assert.equal(registry.bridgeCount, 0);
  workspace.externalEdit({ from: 0, to: 1, insert: "Q" });
  assert.equal(panel.messages.filter(message => message.type === "documentChanged").length, 0);
  registry.dispose();
  await coordinator.drain(target);
  coordinator.dispose();
});
