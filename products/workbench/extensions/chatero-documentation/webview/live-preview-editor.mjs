import { Annotation, Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import {
  MAX_PENDING_REASSOCIATION_UTF8,
  createOperationId,
  createPendingDescriptor,
  parseHostMessage,
  parsePersistedState,
  parseViewMessage,
} from "../live-preview-protocol.mjs";
import { formatPendingConflict, rebasePendingOperations } from "../pending-edit-rebase.mjs";
import { applyOffsetChanges, withChangeContext } from "../text-change-set.mjs";

export const hostSync = Annotation.define();

const textEncoder = new TextEncoder();

function serializedUtf8Bytes(value) {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function descriptorShape(changes) {
  return Object.freeze(changes.map(change => Object.freeze({
    from: change.from,
    to: change.to,
    insertedUtf8Bytes: textEncoder.encode(change.insert).byteLength,
    deletedUtf8Bytes: textEncoder.encode(change.deletedText).byteLength,
  })));
}

function transactionChanges(startState, changeSet) {
  const source = startState.doc.toString();
  const changes = [];
  changeSet.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  return withChangeContext(source, changes);
}

function sameDescriptor(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function operationSequence(opId) {
  return Number(opId.slice(opId.lastIndexOf(":") + 1));
}

function createStatusElement(parent) {
  const status = parent.ownerDocument.createElement("div");
  status.className = "documentation-editor-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  parent.append(status);
  return status;
}

function createConflictElement(parent, message) {
  const panel = parent.ownerDocument.createElement("section");
  panel.className = "documentation-pending-conflict";
  panel.setAttribute("role", "note");
  const heading = parent.ownerDocument.createElement("h2");
  heading.textContent = "Unacknowledged Live Preview change";
  const detail = parent.ownerDocument.createElement("pre");
  detail.textContent = message;
  panel.append(heading, detail);
  parent.append(panel);
  return panel;
}

export async function createLivePreviewEditor({
  parent,
  initial,
  cspNonce,
  postMessage,
  persistState,
  persistedState,
  subtle,
}) {
  if (!parent || typeof parent.append !== "function") throw new TypeError("Live Preview parent element is required");
  if (typeof postMessage !== "function" || typeof persistState !== "function") {
    throw new TypeError("Live Preview message and persistence functions are required");
  }
  const initialized = parseHostMessage(initial);
  if (initialized.type !== "initialize") throw new TypeError("Live Preview requires an initialize message");
  if (initialized.cspNonce !== cspNonce) throw new Error("Live Preview CSP nonce changed during initialization");
  const restored = persistedState === undefined
    ? parsePersistedState({ sessionId: initialized.sessionId, nextSequence: 1, pendingDescriptors: [] })
    : parsePersistedState(persistedState);
  if (restored.sessionId !== initialized.sessionId) throw new Error("Live Preview initialize belongs to a foreign session");

  const restoredById = new Map(restored.pendingDescriptors.map(descriptor => [descriptor.opId, descriptor]));
  const pendingOperations = new Map();
  const pendingMetadata = new Map();
  let displaySource = initialized.source;
  for (const operation of initialized.reassociatedPendingOperations) {
    const actualDescriptor = await createPendingDescriptor(operation, subtle);
    const restoredDescriptor = restoredById.get(operation.opId);
    if (!restoredDescriptor || !sameDescriptor(restoredDescriptor, actualDescriptor)) continue;
    displaySource = applyOffsetChanges(displaySource, operation.changes);
    pendingOperations.set(operation.opId, operation);
    pendingMetadata.set(operation.opId, { descriptor: actualDescriptor, shape: actualDescriptor.shape });
  }

  let authoritativeSource = initialized.source;
  let authoritativeVersion = initialized.version;
  let authoritativeDigest = initialized.digest;
  let nextSequence = Math.max(
    restored.nextSequence,
    ...Array.from(pendingOperations, ([opId]) => operationSequence(opId) + 1),
  );
  let disposed = false;
  let outboundTail = Promise.resolve();
  let view;
  const editable = new Compartment();
  const status = createStatusElement(parent);
  const conflictPanels = new Set();

  function actualDescriptors() {
    return Array.from(pendingMetadata.values(), metadata => metadata.descriptor).filter(Boolean);
  }

  function persistedValue() {
    return parsePersistedState({
      sessionId: initialized.sessionId,
      nextSequence,
      pendingDescriptors: actualDescriptors(),
    });
  }

  function persist() {
    const value = persistedValue();
    persistState(value);
    return value;
  }

  function setWaiting(waiting) {
    if (disposed) return;
    status.textContent = waiting ? "Waiting for TextDocument acknowledgement" : "";
    if (view) view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!waiting)) });
  }

  function predictedBaseVersion() {
    let version = authoritativeVersion;
    for (const operation of pendingOperations.values()) version = Math.max(version, operation.baseVersion + 1);
    return version;
  }

  function provisionalDescriptor(operation) {
    return Object.freeze({
      opId: operation.opId,
      baseVersion: operation.baseVersion,
      changeDigest: "0".repeat(64),
      shape: descriptorShape(operation.changes),
    });
  }

  function canAccept(changes) {
    const opId = createOperationId(initialized.sessionId, nextSequence);
    const operation = Object.freeze({ opId, baseVersion: predictedBaseVersion(), changes });
    const descriptors = [
      ...Array.from(pendingMetadata.values(), metadata => metadata.descriptor ?? metadata.provisional),
      provisionalDescriptor(operation),
    ];
    parsePersistedState({
      sessionId: initialized.sessionId,
      nextSequence: nextSequence + 1,
      pendingDescriptors: descriptors,
    });
    const bodies = [...pendingOperations.values(), operation];
    if (serializedUtf8Bytes(bodies) > MAX_PENDING_REASSOCIATION_UTF8) {
      throw new RangeError("pending Live Preview bodies exceed 12 MiB");
    }
    parseViewMessage({ type: "edit", sessionId: initialized.sessionId, ...operation });
    return true;
  }

  function queueUserOperation(changes) {
    const opId = createOperationId(initialized.sessionId, nextSequence);
    nextSequence += 1;
    const operation = Object.freeze({
      opId,
      baseVersion: predictedBaseVersion(),
      changes,
    });
    pendingOperations.set(opId, operation);
    const provisional = provisionalDescriptor(operation);
    pendingMetadata.set(opId, { descriptor: undefined, provisional, shape: provisional.shape });
    outboundTail = outboundTail.then(async () => {
      const descriptor = await createPendingDescriptor(operation, subtle);
      const metadata = pendingMetadata.get(opId);
      if (!metadata || !pendingOperations.has(opId)) return;
      metadata.descriptor = descriptor;
      persist();
      await postMessage(parseViewMessage({
        type: "edit",
        sessionId: initialized.sessionId,
        ...operation,
      }));
    }).catch(error => {
      status.textContent = `Live Preview edit was not sent: ${error instanceof Error ? error.message : String(error)}`;
      setWaiting(true);
    });
  }

  const rejectOverLimitTransactions = EditorState.transactionFilter.of(transaction => {
    if (!transaction.docChanged || transaction.annotation(hostSync)) return transaction;
    try {
      canAccept(transactionChanges(transaction.startState, transaction.changes));
      return transaction;
    }
    catch {
      queueMicrotask(() => setWaiting(true));
      return [];
    }
  });

  const forwardUserChanges = EditorView.updateListener.of(update => {
    if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(hostSync))) {
      queueUserOperation(transactionChanges(update.startState, update.changes));
    }
    if (update.selectionSet) {
      const selection = update.state.selection.main;
      void postMessage(parseViewMessage({
        type: "focus",
        sessionId: initialized.sessionId,
        anchor: selection.anchor,
        head: selection.head,
      }));
    }
  });

  function sendHistory(direction) {
    void postMessage(parseViewMessage({ type: "history", sessionId: initialized.sessionId, direction }));
    return true;
  }

  const workbenchHistoryKeys = Prec.highest(keymap.of([
    { key: "Mod-z", run: () => sendHistory("undo") },
    { key: "Shift-Mod-z", run: () => sendHistory("redo") },
    { key: "Mod-y", run: () => sendHistory("redo") },
  ]));

  const state = EditorState.create({
    doc: displaySource,
    extensions: [
      editable.of(EditorView.editable.of(true)),
      EditorView.lineWrapping,
      EditorView.cspNonce.of(cspNonce),
      rejectOverLimitTransactions,
      forwardUserChanges,
      workbenchHistoryKeys,
    ],
  });
  view = new EditorView({ parent, state });
  persist();

  async function receiveHostMessage(rawMessage) {
    const message = parseHostMessage(rawMessage);
    if (message.sessionId !== initialized.sessionId) throw new Error("host message belongs to a foreign Live Preview session");
    if (message.type === "initialize") throw new Error("Live Preview cannot be initialized twice");
    if (message.type === "documentChanged") {
      authoritativeSource = applyOffsetChanges(authoritativeSource, message.changes);
      authoritativeVersion = message.afterVersion;
      authoritativeDigest = message.digest;
      view.dispatch({
        changes: message.changes.map(change => ({ from: change.from, to: change.to, insert: change.insert })),
        annotations: hostSync.of(true),
      });
      return;
    }
    if (message.type === "operationAcknowledged") {
      const operation = pendingOperations.get(message.opId);
      if (operation) authoritativeSource = applyOffsetChanges(authoritativeSource, operation.changes);
      pendingOperations.delete(message.opId);
      pendingMetadata.delete(message.opId);
      authoritativeVersion = message.afterVersion;
      authoritativeDigest = message.digest;
      persist();
      setWaiting(false);
      return;
    }
    if (message.type === "resync") {
      authoritativeSource = message.source;
      authoritativeVersion = message.version;
      authoritativeDigest = message.digest;
      const rebased = rebasePendingOperations({
        authoritativeText: message.source,
        authoritativeVersion: message.version,
        pendingOperations: [...pendingOperations.values()],
      });
      let display = message.source;
      let replayVersion = message.version;
      for (const replay of rebased.replayable) {
        display = applyOffsetChanges(display, replay.changes);
        const operation = Object.freeze({
          opId: replay.opId,
          baseVersion: replayVersion,
          changes: replay.changes,
        });
        replayVersion += 1;
        pendingOperations.set(replay.opId, operation);
        const descriptor = await createPendingDescriptor(operation, subtle);
        pendingMetadata.set(replay.opId, { descriptor, shape: descriptor.shape });
      }
      for (const panel of conflictPanels) panel.remove();
      conflictPanels.clear();
      for (const conflict of rebased.conflicts) {
        const panel = createConflictElement(parent, formatPendingConflict(conflict));
        conflictPanels.add(panel);
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: display },
        annotations: hostSync.of(true),
      });
      persist();
      return;
    }
    if (message.type === "pendingConflict") {
      const panel = createConflictElement(parent, [
        "Authoritative TextDocument source",
        message.authoritativeExcerpt,
        "",
        "Unacknowledged Live Preview change",
        message.pendingInsert,
      ].join("\n"));
      conflictPanels.add(panel);
      return;
    }
    if (message.type === "connectionState") {
      status.textContent = message.state === "connected" ? "" : `Documentation connection: ${message.state}`;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    view.destroy();
    status.remove();
    for (const panel of conflictPanels) panel.remove();
    conflictPanels.clear();
  }

  return Object.freeze({
    dispose,
    get source() { return view.state.doc.toString(); },
    get authoritative() {
      return Object.freeze({ source: authoritativeSource, version: authoritativeVersion, digest: authoritativeDigest });
    },
    receiveHostMessage,
  });
}

function newSessionId(window) {
  const crypto = window.crypto ?? globalThis.crypto;
  if (!crypto || typeof crypto.randomUUID !== "function") throw new Error("secure Live Preview session generation is unavailable");
  return crypto.randomUUID();
}

export function startLivePreview({ vscode, window, document }) {
  const mount = document.querySelector("[data-documentation-editor]");
  if (!mount) throw new Error("Documentation editor mount is missing");
  let restored;
  try {
    restored = parsePersistedState(vscode.getState());
  }
  catch {
    restored = parsePersistedState({ sessionId: newSessionId(window), nextSequence: 1, pendingDescriptors: [] });
    vscode.setState(restored);
  }
  let editor;
  let initializedNonce;
  let messageTail = Promise.resolve();

  async function receive(raw) {
    const message = parseHostMessage(raw);
    if (message.sessionId !== restored.sessionId) throw new Error("host message belongs to a foreign Live Preview session");
    if (message.type === "initialize") {
      if (editor || initializedNonce !== undefined) throw new Error("Live Preview cannot be initialized twice");
      initializedNonce = message.cspNonce;
      editor = await createLivePreviewEditor({
        parent: mount,
        initial: message,
        cspNonce: initializedNonce,
        postMessage: value => vscode.postMessage(value),
        persistState: value => vscode.setState(value),
        persistedState: restored,
      });
      return;
    }
    if (!editor) throw new Error("Live Preview received a host message before initialize");
    await editor.receiveHostMessage(message);
  }

  const listener = event => {
    messageTail = messageTail.then(() => receive(event.data)).catch(error => {
      mount.textContent = `Live Preview protocol error: ${error instanceof Error ? error.message : String(error)}`;
    });
  };
  window.addEventListener("message", listener);
  void vscode.postMessage(parseViewMessage({
    type: "ready",
    sessionId: restored.sessionId,
    pendingDescriptors: restored.pendingDescriptors,
  }));
  return Object.freeze({
    dispose() {
      window.removeEventListener("message", listener);
      editor?.dispose();
    },
  });
}
