const { randomBytes } = require("node:crypto");

class EvidenceDocument {
  constructor(uri, record, release) {
    this.uri = uri;
    this.record = record;
    this.release = release;
  }

  dispose() {
    const release = this.release;
    this.release = null;
    release?.();
  }
}

function nonce() {
  return randomBytes(18).toString("base64url");
}

// Only the view-location fields reach the renderer; the Core state record also
// carries the library identity, which must never enter webview config.
function projectReaderViewState(state) {
  const value = {};
  for (const field of ["cfi", "pageIndex", "scrollYPercent"]) {
    if (state[field] !== undefined) value[field] = state[field];
  }
  return value;
}

class PdfEditorProvider {
  constructor({
    vscode,
    registry,
    getModel,
    resolveDocument,
    renderUpstreamReaderHTML,
    extensionUri,
    materializePdf = async () => { throw new Error("Zotero PDF materialization is unavailable"); },
    contextBroker = null,
    attachPdfContext = null,
    createReaderWorkflow = null,
    fromUpstreamReaderAnnotation,
    makePanelNonce = nonce,
    onActiveReaderChanged = () => {},
    onContextError = () => {},
    onReaderError = () => {},
    readerLocationFromViewState,
    readerServer,
    toUpstreamReaderAnnotation,
  }) {
    this.vscode = vscode;
    this.registry = registry;
    this.getModel = getModel;
    this.resolveDocument = resolveDocument || ((uri, kind) => registry.resolve(uri, kind));
    this.renderUpstreamReaderHTML = renderUpstreamReaderHTML;
    this.materializePdf = materializePdf;
    this.upstreamReaderRoot = vscode.Uri.joinPath(extensionUri, "media", "zotero-reader");
    this.contextBroker = contextBroker;
    this.attachPdfContext = attachPdfContext;
    this.createReaderWorkflow = createReaderWorkflow;
    this.fromUpstreamReaderAnnotation = fromUpstreamReaderAnnotation;
    this.readerLocationFromViewState = readerLocationFromViewState;
    this.readerServer = readerServer;
    this.toUpstreamReaderAnnotation = toUpstreamReaderAnnotation;
    this.makePanelNonce = makePanelNonce;
    this.onActiveReaderChanged = onActiveReaderChanged;
    this.onContextError = onContextError;
    this.onReaderError = onReaderError;
    if ((contextBroker === null) !== (attachPdfContext === null)
        || (createReaderWorkflow !== null && typeof createReaderWorkflow !== "function")
        || ![fromUpstreamReaderAnnotation, renderUpstreamReaderHTML, readerLocationFromViewState, toUpstreamReaderAnnotation]
          .every(value => typeof value === "function")
        || typeof readerServer?.lease !== "function"
        || typeof makePanelNonce !== "function" || typeof onActiveReaderChanged !== "function"
        || typeof onContextError !== "function" || typeof onReaderError !== "function") {
      throw new TypeError("PDF editor context bridge configuration is invalid");
    }
  }

  async openCustomDocument(uri) {
    const record = await this.resolveDocument(uri, "pdf");
    return new EvidenceDocument(uri, record, () => this.registry.release(uri, "pdf", record));
  }

  async resolveCustomEditor(document, panel) {
    const model = this.getModel();
    if (!model) throw new Error("Start Zotero Core before opening a PDF");
    const record = document.record;
    const workflow = this.createReaderWorkflow?.(model) ?? null;
    // The reader RPCs and the whole-file copy share no data, so they run concurrently.
    const loading = workflow
      ? workflow.load(record)
      : model.annotations({ attachmentKey: record.attachmentKey, libraryId: record.libraryId });
    const materializing = this.materializePdf(record);
    let annotations;
    let loaded = null;
    let materialized;
    try {
      const [loadResult, handle] = await Promise.all([loading, materializing]);
      materialized = handle;
      loaded = workflow ? loadResult : null;
      annotations = loaded?.annotations
        ?? (workflow ? await model.annotations({ attachmentKey: record.attachmentKey, libraryId: record.libraryId }) : loadResult);
    }
    catch (error) {
      void materializing.then(value => value?.dispose?.(), () => {}).catch(() => {});
      throw error;
    }
    const isPdf = record.contentType === "application/pdf";
    const file = this.vscode.Uri.file(materialized.path);
    let serverLease;
    try {
      serverLease = await this.readerServer.lease({ contentType: record.contentType, path: materialized.path });
    }
    catch (error) {
      void materialized.dispose().catch(() => {});
      throw error;
    }
    // The reader page and the materialized bytes come from the loopback reader
    // server, so the webview itself needs no resource roots at all.
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    const panelNonce = this.makePanelNonce();
    let contextLease = isPdf ? this.contextBroker?.open(document.uri, document.record, panelNonce, annotations) ?? null : null;
    const readerPublication = Object.freeze({ file, record });
    // Clearing is guarded on identity: with two reader tabs, a stale panel's
    // deactivation or disposal must not clobber the newly active publication.
    const publishActiveReader = active => {
      if (active) {
        this.activeReaderPublication = readerPublication;
        this.onActiveReaderChanged(readerPublication);
      }
      else if (this.activeReaderPublication === readerPublication) {
        this.activeReaderPublication = null;
        this.onActiveReaderChanged(null);
      }
    };
    const activateContext = active => {
      if (contextLease) this.contextBroker.activate(document.uri, panelNonce, active);
      publishActiveReader(active);
    };
    let lastSequence = 0;
    let lastAttachSequence = 0;
    let lastSnapshot = null;
    const initialLocationKey = (() => {
      try { return JSON.stringify(this.readerLocationFromViewState(record.contentType, loaded?.state ?? {})); }
      catch { return null; }
    })();
    let lastLocationKey = initialLocationKey;
    let disposed = false;
    let readerWrite = Promise.resolve();
    const readerKeyMap = new Map();
    let messageSubscription = null;
    let viewStateSubscription = null;
    let panelDisposeSubscription = null;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      let failure = null;
      for (const disposable of [messageSubscription, viewStateSubscription, panelDisposeSubscription, contextLease, serverLease]) {
        try { disposable?.dispose(); } catch (error) { failure ||= error; }
      }
      try { publishActiveReader(false); } catch (error) { failure ||= error; }
      void materialized.dispose().catch(error => this.onReaderError(error, "materialized-pdf-cleanup"));
      lastSnapshot = null;
      if (failure) throw failure;
    };
    try {
      activateContext(panel.active === true);
      messageSubscription = (this.contextBroker || workflow) && typeof panel.webview.onDidReceiveMessage === "function"
        ? panel.webview.onDidReceiveMessage(message => {
        const operation = (async () => {
          if (message?.type === "chatero-reader-ready") {
            if (Object.keys(message).sort().join(",") !== "type") throw new TypeError("Reader ready message is invalid");
            // A webview content reload re-evaluates the child page, restarting
            // its context sequence and re-emitting the open-time state; reset
            // the extension-side counters to match.
            if (contextLease) {
              contextLease.dispose();
              contextLease = this.contextBroker.open(document.uri, document.record, panelNonce, annotations);
              lastSequence = 0;
              lastAttachSequence = 0;
              lastSnapshot = null;
            }
            lastLocationKey = initialLocationKey;
            return;
          }
          if (message?.type === "upstream-reader-state") {
            if (!workflow || Object.keys(message).sort().join(",") !== "state,type") throw new TypeError("Upstream Reader state message is invalid");
            const location = this.readerLocationFromViewState(record.contentType, message.state);
            const locationKey = JSON.stringify(location);
            if (locationKey === lastLocationKey) return;
            // Dedupe against the last enqueued location, not the last committed
            // one, so A -> B -> A commits the return to A.
            const previousKey = lastLocationKey;
            lastLocationKey = locationKey;
            readerWrite = readerWrite.catch(() => {}).then(() => workflow.updateLocation(location));
            try {
              await readerWrite;
            }
            catch (error) {
              if (lastLocationKey === locationKey) lastLocationKey = previousKey;
              throw error;
            }
            return;
          }
          if (message?.type === "upstream-reader-save") {
            const sequence = message.sequence;
            try {
              if (!workflow || !Number.isSafeInteger(sequence) || sequence < 1 || !Array.isArray(message.annotations)
                  || message.annotations.length > 100 || Object.keys(message).sort().join(",") !== "annotations,sequence,type") {
                throw new TypeError("Upstream Reader save message is invalid");
              }
              const pendingChanges = [];
              const pendingKeys = [];
              for (const value of message.annotations) {
                const key = typeof value?.id === "string" ? value.id : "";
                const currentKey = readerKeyMap.get(key) || key;
                const current = workflow.annotations.find(annotation => annotation.annotationKey === currentKey);
                const change = this.fromUpstreamReaderAnnotation(value, current);
                if (change.action === "create" || Object.keys(change).length > 2) {
                  pendingKeys.push(key);
                  pendingChanges.push(change);
                }
              }
              if (pendingChanges.length) {
                const saved = await workflow.applyAnnotationChanges(pendingChanges);
                for (const created of saved.created) readerKeyMap.set(pendingKeys[created.changeIndex], created.annotation.annotationKey);
              }
              await panel.webview.postMessage?.({ sequence, type: "upstream-reader-saved" });
            }
            catch (error) {
              await panel.webview.postMessage?.({ message: error.message, sequence, type: "upstream-reader-error" });
              throw error;
            }
            return;
          }
          if (message?.type === "upstream-reader-delete") {
            const sequence = message.sequence;
            try {
              if (!workflow || !Number.isSafeInteger(sequence) || sequence < 1 || !Array.isArray(message.ids)
                  || message.ids.length > 100 || new Set(message.ids).size !== message.ids.length
                  || Object.keys(message).sort().join(",") !== "ids,sequence,type") throw new TypeError("Upstream Reader delete message is invalid");
              // The reader batches saves: a create-only batch still calls
              // onDeleteAnnotations([]), and a delete that cancels a not-yet
              // persisted create names an id Core never saw. Both are no-ops.
              const changes = [];
              for (const key of message.ids) {
                const currentKey = readerKeyMap.get(key) || key;
                const current = workflow.annotations.find(annotation => annotation.annotationKey === currentKey);
                if (current) changes.push({ action: "trash", annotationKey: currentKey, expectedVersion: current.version });
              }
              if (changes.length) await workflow.applyAnnotationChanges(changes);
              for (const key of message.ids) readerKeyMap.delete(key);
              await panel.webview.postMessage?.({ sequence, type: "upstream-reader-saved" });
            }
            catch (error) {
              await panel.webview.postMessage?.({ message: error.message, sequence, type: "upstream-reader-error" });
              throw error;
            }
            return;
          }
          if (message?.type === "pdf-open-link") {
            if (typeof message.url !== "string" || Object.keys(message).sort().join(",") !== "type,url") {
              throw new TypeError("PDF link message is invalid");
            }
            const target = this.vscode.Uri.parse(message.url, true);
            if (!["http", "https", "mailto"].includes(target.scheme)) throw new Error("PDF link scheme is not allowed");
            await this.vscode.env.openExternal(target);
            return;
          }
          if (message?.type === "reader-unsupported") {
            if (typeof message.feature !== "string" || message.feature.length > 64
                || Object.keys(message).sort().join(",") !== "feature,type") {
              throw new TypeError("Reader capability message is invalid");
            }
            void this.vscode.window.showWarningMessage(`Chatero does not support ${message.feature} yet.`);
            return;
          }
          if (message?.type === "pdf-context") {
            if (!this.contextBroker) throw new TypeError("PDF context bridge is unavailable");
            lastSnapshot = this.contextBroker.update(document.uri, document.record, panelNonce, message);
            lastSequence = message.sequence;
            return;
          }
          if (message?.type !== "pdf-context-attach" || !this.contextBroker) {
            throw new TypeError("PDF editor message type is invalid");
          }
          const keys = Object.keys(message).sort();
          // Both snapshot kinds attach: a selection when one exists, otherwise
          // the current page -- matching chatero.zotero.addActiveContextToChat.
          if (keys.length !== 3 || keys[0] !== "panelNonce" || keys[1] !== "sequence" || keys[2] !== "type"
              || message.panelNonce !== panelNonce
              || !Number.isSafeInteger(message.sequence)
              || message.sequence !== lastSequence
              || message.sequence <= lastAttachSequence
              || !lastSnapshot) {
            throw new Error("PDF context attach sequence is invalid");
          }
          lastAttachSequence = message.sequence;
          await this.attachPdfContext(lastSnapshot);
        })();
        void operation.catch(async error => {
          if (message?.type === "pdf-context") {
            try { await panel.webview.postMessage?.({ type: "pdf-context-error" }); } catch (_) {}
          }
          if (message?.type === "pdf-context-attach") this.onContextError(error);
          else this.onReaderError(error, message?.type || "unknown");
        });
        return operation;
      })
        : null;
      viewStateSubscription = typeof panel.onDidChangeViewState === "function"
        ? panel.onDidChangeViewState(event => {
          activateContext(event?.webviewPanel?.active === true);
        })
        : null;
      panelDisposeSubscription = panel.onDidDispose?.(cleanup) ?? null;
      panel.webview.html = this.renderUpstreamReaderHTML({
        annotations: annotations.map(this.toUpstreamReaderAnnotation),
        attachment: record,
        documentUri: serverLease.documentUrl,
        frameOrigin: serverLease.origin,
        nonce: nonce(),
        panelNonce,
        readerPageUri: serverLease.readerPageUrl,
        readerType: isPdf ? "pdf" : record.contentType === "application/epub+zip" ? "epub" : "snapshot",
        state: projectReaderViewState(loaded?.state ?? {}),
      });
    }
    catch (error) {
      try { cleanup(); } catch (_) {}
      throw error;
    }
  }
}

class NoteEditorProvider {
  constructor({ registry, getModel, resolveDocument, renderNoteEditorHTML, createReaderWorkflow = null, onError = () => {} }) {
    this.registry = registry;
    this.getModel = getModel;
    this.resolveDocument = resolveDocument || ((uri, kind) => registry.resolve(uri, kind));
    this.renderNoteEditorHTML = renderNoteEditorHTML;
    this.createReaderWorkflow = createReaderWorkflow;
    this.onError = onError;
    if ((createReaderWorkflow !== null && typeof createReaderWorkflow !== "function") || typeof onError !== "function") {
      throw new TypeError("Note editor workflow configuration is invalid");
    }
  }

  async openCustomDocument(uri) {
    const record = await this.resolveDocument(uri, "note");
    return new EvidenceDocument(uri, record, () => this.registry.release(uri, "note", record));
  }

  async resolveCustomEditor(document, panel) {
    const model = this.getModel();
    if (!model) throw new Error("Start Zotero Core before opening a Note");
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
    const workflow = this.createReaderWorkflow?.(model) ?? null;
    let note = workflow
      ? await workflow.loadNote({ libraryId: document.record.libraryId, noteKey: document.record.noteKey })
      : await model.note({ libraryId: document.record.libraryId, noteKey: document.record.noteKey });
    let lastSequence = 0;
    let write = Promise.resolve();
    const subscription = typeof panel.webview.onDidReceiveMessage === "function"
      ? panel.webview.onDidReceiveMessage(message => {
        const operation = (async () => {
          if (!workflow || !Number.isSafeInteger(message?.sequence)
              || message.sequence <= lastSequence || typeof message.html !== "string"
              || Buffer.byteLength(message.html, "utf8") > 1024 * 1024
              || message.type !== "note-save" || Object.keys(message).sort().join(",") !== "html,sequence,type") {
            if (workflow && message?.type === "note-reload" && Number.isSafeInteger(message.sequence)
                && message.sequence > lastSequence && Object.keys(message).sort().join(",") === "sequence,type") {
              lastSequence = message.sequence;
              note = await workflow.loadNote({ libraryId: document.record.libraryId, noteKey: document.record.noteKey });
              await panel.webview.postMessage?.({ html: note.html, sequence: message.sequence, type: "note-reloaded", version: note.version });
              return;
            }
            throw new TypeError("Note editor message is invalid");
          }
          lastSequence = message.sequence;
          const sequence = message.sequence;
          write = write.catch(() => {}).then(async () => {
            const result = await workflow.updateNote({ ...note, html: message.html });
            note = Object.freeze({ ...note, html: message.html, version: result.version });
            await panel.webview.postMessage?.({ sequence, type: "note-saved", version: note.version });
          });
          await write;
        })();
        void operation.catch(async error => {
          this.onError(error);
          await panel.webview.postMessage?.({ message: error.message, sequence: message?.sequence, type: "note-error" });
        });
        return operation;
      }) : null;
    panel.onDidDispose?.(() => subscription?.dispose());
    panel.webview.html = this.renderNoteEditorHTML({ note, cspSource: panel.webview.cspSource, nonce: nonce() });
  }
}

module.exports = { NoteEditorProvider, PdfEditorProvider };
