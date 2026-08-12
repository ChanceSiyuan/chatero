import {
  createPendingDescriptor,
  parseHostMessage,
  parseViewMessage,
} from "./live-preview-protocol.mjs";
import { rebasePendingOperations } from "./pending-edit-rebase.mjs";
import {
  applyOffsetChanges,
  digestOffsetChanges,
  digestSourceText,
  withChangeContext,
} from "./text-change-set.mjs";

function uriKey(uri) {
  if (!uri || typeof uri.toString !== "function") throw new TypeError("Live Preview URI must expose toString()");
  const value = uri.toString();
  if (!value) throw new TypeError("Live Preview URI must not be empty");
  return value;
}

function nonce(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(value)) {
    throw new TypeError("Live Preview CSP nonce must be exactly 24 base64url characters");
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function freezeOperation(message) {
  return Object.freeze({
    opId: message.opId,
    baseVersion: message.baseVersion,
    changes: message.changes,
  });
}

class PerUriLivePreviewBridge {
  constructor({ document, commands, coordinator, onEmpty }) {
    this.document = document;
    this.uri = document.uri;
    this.commands = commands;
    this.coordinator = coordinator;
    this.onEmpty = onEmpty;
    this.source = document.getText();
    this.version = document.version;
    this.digest = undefined;
    this.panels = new Map();
    this.pending = new Map();
    this.expectedHead = undefined;
    this.eventCandidate = undefined;
    this.eventTail = Promise.resolve();
    this.operationTail = Promise.resolve();
    this.disposed = false;
  }

  get panelCount() {
    return this.panels.size;
  }

  async currentDigest() {
    if (this.digest) return this.digest;
    const source = this.source;
    const version = this.version;
    const value = await digestSourceText(source);
    if (this.source === source && this.version === version) this.digest = value;
    return value;
  }

  async post(panelState, message) {
    if (panelState.disposed || !panelState.sessionId) return false;
    const parsed = parseHostMessage({ ...message, sessionId: panelState.sessionId });
    return panelState.panel.webview.postMessage(parsed);
  }

  async postAll(message, excludedSessionId) {
    await Promise.all([...this.panels.values()].map(panelState => {
      if (!panelState.sessionId || panelState.sessionId === excludedSessionId) return undefined;
      return this.post(panelState, message);
    }));
  }

  attach(panel, { cspNonce }) {
    if (this.disposed) throw new Error("Live Preview bridge is disposed");
    if (!panel?.webview || typeof panel.webview.onDidReceiveMessage !== "function"
      || typeof panel.webview.postMessage !== "function" || typeof panel.onDidDispose !== "function") {
      throw new TypeError("Live Preview panel must expose webview messaging and disposal APIs");
    }
    if (this.panels.has(panel)) throw new Error("Live Preview panel is already attached");
    const state = {
      panel,
      cspNonce: nonce(cspNonce),
      sessionId: undefined,
      initialized: false,
      disposed: false,
      messageTail: Promise.resolve(),
    };
    const messageSubscription = panel.webview.onDidReceiveMessage(value => {
      state.messageTail = state.messageTail.catch(() => {}).then(() => this.receive(state, value));
      return state.messageTail;
    });
    let attachment;
    let panelSubscription;
    const detach = notify => {
      if (state.disposed) return;
      state.disposed = true;
      messageSubscription.dispose();
      panelSubscription?.dispose();
      this.panels.delete(panel);
      if (notify && !this.disposed && this.panels.size === 0) this.onEmpty(this);
    };
    attachment = Object.freeze({
      dispose: () => detach(true),
    });
    panelSubscription = panel.onDidDispose(() => attachment.dispose());
    state.attachment = attachment;
    state.detach = detach;
    this.panels.set(panel, state);
    return attachment;
  }

  panelForSession(sessionId) {
    return [...this.panels.values()].find(state => state.sessionId === sessionId && !state.disposed);
  }

  async receive(panelState, rawMessage) {
    if (this.disposed || panelState.disposed) return;
    const message = parseViewMessage(rawMessage);
    if (message.type === "ready") {
      await this.ready(panelState, message);
      return;
    }
    if (!panelState.initialized || panelState.sessionId !== message.sessionId) {
      throw new Error("Live Preview message belongs to a foreign or uninitialized session");
    }
    if (message.type === "edit") {
      const operation = () => this.applyPanelEdit(panelState, message);
      const current = this.operationTail.catch(() => {}).then(operation);
      this.operationTail = current.catch(() => {});
      await current;
      return;
    }
    if (message.type === "history") {
      await this.coordinator.drain(this.uri);
      await this.commands.executeCommand(message.direction);
    }
  }

  async ready(panelState, message) {
    if (panelState.initialized) throw new Error("Live Preview panel sent ready more than once");
    const duplicate = this.panelForSession(message.sessionId);
    if (duplicate && duplicate !== panelState) throw new Error("duplicate Live Preview session ID");
    panelState.sessionId = message.sessionId;
    panelState.initialized = true;
    const descriptorById = new Map(message.pendingDescriptors.map(value => [value.opId, value]));
    const reassociatedPendingOperations = [];
    for (const record of this.pending.values()) {
      if (record.sessionId !== message.sessionId || record.reflected) continue;
      const descriptor = descriptorById.get(record.operation.opId);
      if (!descriptor) continue;
      const actual = await record.descriptor;
      if (sameValue(actual, descriptor)) reassociatedPendingOperations.push(record.operation);
    }
    await this.post(panelState, {
      type: "initialize",
      source: this.source,
      version: this.version,
      digest: await this.currentDigest(),
      cspNonce: panelState.cspNonce,
      reassociatedPendingOperations,
    });
  }

  async expectedFingerprint(message) {
    if (message.baseVersion !== this.version) return undefined;
    const changes = withChangeContext(this.source, message.changes.map(change => ({
      from: change.from,
      to: change.to,
      insert: change.insert,
    })));
    const result = applyOffsetChanges(this.source, changes);
    const [changesDigest, afterDigest] = await Promise.all([
      digestOffsetChanges(changes),
      digestSourceText(result),
    ]);
    return Object.freeze({
      sessionId: message.sessionId,
      opId: message.opId,
      beforeVersion: message.baseVersion,
      afterVersion: message.baseVersion + 1,
      changesDigest,
      afterDigest,
    });
  }

  async applyPanelEdit(panelState, message) {
    if (this.pending.has(message.opId)) throw new Error("duplicate Live Preview operation ID");
    const operation = freezeOperation(message);
    const record = {
      sessionId: message.sessionId,
      operation,
      descriptor: createPendingDescriptor(operation),
      reflected: false,
    };
    this.pending.set(message.opId, record);
    let fingerprint;
    try {
      fingerprint = await this.expectedFingerprint(message);
    }
    catch {
      await this.sendResync(panelState, "version-conflict");
      return;
    }
    if (fingerprint) {
      if (this.expectedHead) throw new Error("Live Preview expected-event head is already occupied");
      this.expectedHead = fingerprint;
      this.eventCandidate = undefined;
    }

    let result;
    try {
      result = await this.coordinator.applyVersionedTextEdits({
        operationId: message.opId,
        origin: "live-preview",
        edits: [{ uri: this.uri, baseVersion: message.baseVersion, changes: message.changes }],
      });
    }
    catch (error) {
      result = Object.freeze({
        kind: "apply-failed",
        operationId: message.opId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await this.eventTail;
    const candidate = this.eventCandidate;
    const expected = this.expectedHead;

    if (result.kind === "applied"
      && expected?.opId === message.opId
      && candidate?.opId === message.opId
      && candidate.beforeVersion === expected.beforeVersion
      && candidate.afterVersion === expected.afterVersion
      && this.version === candidate.afterVersion
      && result.versions.length === 1
      && result.versions[0].before === candidate.beforeVersion
      && result.versions[0].after === candidate.afterVersion) {
      this.expectedHead = undefined;
      this.eventCandidate = undefined;
      this.pending.delete(message.opId);
      await this.post(panelState, {
        type: "operationAcknowledged",
        opId: message.opId,
        afterVersion: candidate.afterVersion,
        digest: candidate.afterDigest,
      });
      return;
    }

    this.expectedHead = undefined;
    this.eventCandidate = undefined;
    await this.sendResync(panelState, result.kind === "apply-failed" ? "apply-failed" : "version-conflict");
  }

  async sendResync(panelState, reason) {
    await this.post(panelState, {
      type: "resync",
      source: this.source,
      version: this.version,
      digest: await this.currentDigest(),
      reason,
    });
    const operations = [...this.pending.values()]
      .filter(record => record.sessionId === panelState.sessionId && !record.reflected)
      .map(record => record.operation);
    const rebased = rebasePendingOperations({
      authoritativeText: this.source,
      authoritativeVersion: this.version,
      pendingOperations: operations,
    });
    for (const conflict of rebased.conflicts) {
      await this.post(panelState, {
        type: "pendingConflict",
        opId: conflict.opId,
        reason: conflict.reason,
        authoritativeExcerpt: conflict.authoritativeExcerpt,
        pendingInsert: conflict.pendingInsert,
      });
    }
  }

  enqueueEvent(event) {
    if (this.disposed) return;
    const snapshot = Object.freeze({
      afterVersion: event.document.version,
      afterText: event.document.getText(),
      contentChanges: Object.freeze(Array.from(event.contentChanges ?? [], change => Object.freeze({
        rangeOffset: change.rangeOffset,
        rangeLength: change.rangeLength,
        text: change.text,
      }))),
    });
    this.eventTail = this.eventTail.catch(() => {}).then(() => this.processEvent(snapshot));
  }

  async resyncAllFromEvent(snapshot) {
    this.source = snapshot.afterText;
    this.version = snapshot.afterVersion;
    this.digest = await digestSourceText(snapshot.afterText);
    await this.postAll({
      type: "resync",
      source: this.source,
      version: this.version,
      digest: this.digest,
      reason: "external-change",
    });
  }

  async processEvent(snapshot) {
    if (this.disposed) return;
    const beforeSource = this.source;
    const beforeVersion = this.version;
    if (snapshot.afterVersion !== beforeVersion + 1 || snapshot.contentChanges.length === 0) {
      await this.resyncAllFromEvent(snapshot);
      return;
    }
    let changes;
    let computedText;
    try {
      const raw = snapshot.contentChanges
        .map(change => ({
          from: change.rangeOffset,
          to: change.rangeOffset + change.rangeLength,
          insert: change.text,
        }))
        .sort((left, right) => left.from - right.from || left.to - right.to);
      changes = withChangeContext(beforeSource, raw);
      computedText = applyOffsetChanges(beforeSource, changes);
    }
    catch {
      await this.resyncAllFromEvent(snapshot);
      return;
    }
    if (computedText !== snapshot.afterText) {
      await this.resyncAllFromEvent(snapshot);
      return;
    }
    const [changesDigest, afterDigest] = await Promise.all([
      digestOffsetChanges(changes),
      digestSourceText(snapshot.afterText),
    ]);
    this.source = snapshot.afterText;
    this.version = snapshot.afterVersion;
    this.digest = afterDigest;
    const expected = this.expectedHead;
    const matches = expected
      && expected.beforeVersion === beforeVersion
      && expected.afterVersion === snapshot.afterVersion
      && expected.changesDigest === changesDigest
      && expected.afterDigest === afterDigest;
    if (matches) {
      const record = this.pending.get(expected.opId);
      if (record) record.reflected = true;
      this.eventCandidate = Object.freeze({
        opId: expected.opId,
        beforeVersion,
        afterVersion: snapshot.afterVersion,
        changesDigest,
        afterDigest,
      });
      await this.postAll({
        type: "documentChanged",
        beforeVersion,
        afterVersion: snapshot.afterVersion,
        changes,
        digest: afterDigest,
      }, expected.sessionId);
      return;
    }
    await this.postAll({
      type: "documentChanged",
      beforeVersion,
      afterVersion: snapshot.afterVersion,
      changes,
      digest: afterDigest,
    });
  }

  drainEvents() {
    return this.eventTail;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of [...this.panels.values()]) {
      state.detach?.(false);
    }
    this.panels.clear();
    this.pending.clear();
    this.expectedHead = undefined;
    this.eventCandidate = undefined;
  }
}

export class LivePreviewBridgeRegistry {
  constructor({ workspace, commands, coordinator }) {
    if (!workspace || typeof workspace.onDidChangeTextDocument !== "function") {
      throw new TypeError("Live Preview bridge requires workspace.onDidChangeTextDocument");
    }
    if (!commands || typeof commands.executeCommand !== "function") {
      throw new TypeError("Live Preview bridge requires commands.executeCommand");
    }
    if (!coordinator || typeof coordinator.applyVersionedTextEdits !== "function" || typeof coordinator.drain !== "function") {
      throw new TypeError("Live Preview bridge requires a WorkingCopyCoordinator");
    }
    this.workspace = workspace;
    this.commands = commands;
    this.coordinator = coordinator;
    this.bridges = new Map();
    this.disposed = false;
    this.changeSubscription = workspace.onDidChangeTextDocument(event => this.#broadcastChange(event));
  }

  get bridgeCount() {
    return this.bridges.size;
  }

  attach(document, panel, { cspNonce }) {
    if (this.disposed) throw new Error("LivePreviewBridgeRegistry is disposed");
    const key = uriKey(document.uri);
    let bridge = this.bridges.get(key);
    if (!bridge) {
      bridge = new PerUriLivePreviewBridge({
        document,
        commands: this.commands,
        coordinator: this.coordinator,
        onEmpty: candidate => this.#deleteBridgeWhenEmpty(key, candidate),
      });
      this.bridges.set(key, bridge);
    }
    return bridge.attach(panel, { cspNonce });
  }

  #broadcastChange(event) {
    const bridge = this.bridges.get(uriKey(event.document.uri));
    bridge?.enqueueEvent(event);
  }

  #deleteBridgeWhenEmpty(key, bridge) {
    if (bridge.panelCount !== 0) return;
    bridge.dispose();
    if (this.bridges.get(key) === bridge) this.bridges.delete(key);
  }

  drain(uri) {
    const bridge = this.bridges.get(uriKey(uri));
    return bridge?.drainEvents() ?? Promise.resolve();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.changeSubscription.dispose();
    for (const bridge of this.bridges.values()) bridge.dispose();
    this.bridges.clear();
  }
}

export function createLivePreviewBridgeRegistry(dependencies) {
  return new LivePreviewBridgeRegistry(dependencies);
}
