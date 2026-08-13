const { dirname } = require("node:path");
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

class PdfEditorProvider {
  constructor({
    vscode,
    registry,
    getModel,
    resolveDocument,
    renderPdfEditorHTML,
    renderUpstreamReaderHTML = null,
    extensionUri,
    materializePdf = async () => { throw new Error("Zotero PDF materialization is unavailable"); },
    contextBroker = null,
    attachPdfContext = null,
    createReaderWorkflow = null,
    fromUpstreamReaderAnnotation = null,
    makePanelNonce = nonce,
    onContextError = () => {},
    readerLocationFromViewState = null,
    toUpstreamReaderAnnotation = null,
  }) {
    this.vscode = vscode;
    this.registry = registry;
    this.getModel = getModel;
    this.resolveDocument = resolveDocument || ((uri, kind) => registry.resolve(uri, kind));
    this.renderPdfEditorHTML = renderPdfEditorHTML;
    this.renderUpstreamReaderHTML = renderUpstreamReaderHTML;
    this.materializePdf = materializePdf;
    this.viewerRoot = vscode.Uri.joinPath(extensionUri, "media", "pdf-viewer");
    this.upstreamReaderRoot = vscode.Uri.joinPath(extensionUri, "media", "zotero-reader");
    this.contextBroker = contextBroker;
    this.attachPdfContext = attachPdfContext;
    this.createReaderWorkflow = createReaderWorkflow;
    this.fromUpstreamReaderAnnotation = fromUpstreamReaderAnnotation;
    this.readerLocationFromViewState = readerLocationFromViewState;
    this.toUpstreamReaderAnnotation = toUpstreamReaderAnnotation;
    this.makePanelNonce = makePanelNonce;
    this.onContextError = onContextError;
    if ((contextBroker === null) !== (attachPdfContext === null)
        || (createReaderWorkflow !== null && typeof createReaderWorkflow !== "function")
        || ([fromUpstreamReaderAnnotation, renderUpstreamReaderHTML, readerLocationFromViewState, toUpstreamReaderAnnotation]
          .filter(value => value !== null).length !== 0
          && ![fromUpstreamReaderAnnotation, renderUpstreamReaderHTML, readerLocationFromViewState, toUpstreamReaderAnnotation]
            .every(value => typeof value === "function"))
        || typeof makePanelNonce !== "function" || typeof onContextError !== "function") {
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
    const loaded = workflow ? await workflow.load(record) : null;
    const annotations = loaded?.annotations
      ?? await model.annotations({ attachmentKey: record.attachmentKey, libraryId: record.libraryId });
    const isPdf = record.contentType === "application/pdf";
    if (!isPdf && !this.renderUpstreamReaderHTML) throw new Error(`Reader content type ${record.contentType} is unavailable`);
    const materialized = await this.materializePdf(record);
    const file = this.vscode.Uri.file(materialized.path);
    const readerRoot = isPdf ? this.viewerRoot : this.upstreamReaderRoot;
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.vscode.Uri.file(dirname(materialized.path)), readerRoot] };
    const panelNonce = this.makePanelNonce();
    const contextLease = isPdf ? this.contextBroker?.open(document.uri, document.record, panelNonce, annotations) ?? null : null;
    let lastSequence = 0;
    let lastAttachSequence = 0;
    let lastSnapshot = null;
    let disposed = false;
    let readerWrite = Promise.resolve();
    const readerKeyMap = new Map();
    let lastReaderPage = loaded?.state?.pageIndex;
    let messageSubscription = null;
    let viewStateSubscription = null;
    let panelDisposeSubscription = null;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      let failure = null;
      for (const disposable of [messageSubscription, viewStateSubscription, panelDisposeSubscription, contextLease]) {
        try { disposable?.dispose(); } catch (error) { failure ||= error; }
      }
      void materialized.dispose().catch(this.onContextError);
      lastSnapshot = null;
      if (failure) throw failure;
    };
    try {
      this.contextBroker?.activate?.(document.uri, panelNonce, panel.active === true);
      messageSubscription = (this.contextBroker || workflow) && typeof panel.webview.onDidReceiveMessage === "function"
        ? panel.webview.onDidReceiveMessage(message => {
        const operation = (async () => {
          if (message?.type === "upstream-reader-state") {
            if (isPdf || !workflow || Object.keys(message).sort().join(",") !== "state,type") throw new TypeError("Upstream Reader state message is invalid");
            const location = this.readerLocationFromViewState(record.contentType, message.state);
            readerWrite = readerWrite.catch(() => {}).then(() => workflow.updateLocation(location));
            await readerWrite;
            return;
          }
          if (message?.type === "upstream-reader-save") {
            const sequence = message.sequence;
            try {
              if (isPdf || !workflow || !Number.isSafeInteger(sequence) || sequence < 1 || !Array.isArray(message.annotations)
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
              if (isPdf || !workflow || !Number.isSafeInteger(sequence) || sequence < 1 || !Array.isArray(message.ids)
                  || message.ids.length > 100 || new Set(message.ids).size !== message.ids.length
                  || Object.keys(message).sort().join(",") !== "ids,sequence,type") throw new TypeError("Upstream Reader delete message is invalid");
              const changes = message.ids.map(key => {
                const currentKey = readerKeyMap.get(key) || key;
                const current = workflow.annotations.find(annotation => annotation.annotationKey === currentKey);
                if (!current) throw new Error(`Reader annotation ${key} is unavailable`);
                return { action: "trash", annotationKey: currentKey, expectedVersion: current.version };
              });
              await workflow.applyAnnotationChanges(changes);
              for (const key of message.ids) readerKeyMap.delete(key);
              await panel.webview.postMessage?.({ sequence, type: "upstream-reader-saved" });
            }
            catch (error) {
              await panel.webview.postMessage?.({ message: error.message, sequence, type: "upstream-reader-error" });
              throw error;
            }
            return;
          }
          if (message?.type === "reader-state") {
            if (!isPdf || !workflow || !Number.isSafeInteger(message.pageIndex) || message.pageIndex < 0
                || Object.keys(message).sort().join(",") !== "pageIndex,type") {
              throw new TypeError("Reader state message is invalid");
            }
            if (message.pageIndex === lastReaderPage) return;
            readerWrite = readerWrite.catch(() => {}).then(() => workflow.updateLocation({ pageIndex: message.pageIndex }));
            await readerWrite;
            lastReaderPage = message.pageIndex;
            return;
          }
          if (message?.type === "annotation-create") {
            if (!workflow || typeof message.text !== "string" || typeof message.positionJson !== "string"
                || typeof message.pageLabel !== "string" || typeof message.sortIndex !== "string"
                || !["highlight", "image", "note", "underline"].includes(message.annotationType)
                || typeof message.color !== "string" || !Array.isArray(message.tags) || typeof message.comment !== "string"
                || Object.keys(message).sort().join(",") !== "annotationType,color,comment,pageLabel,positionJson,sortIndex,tags,text,type") {
              throw new TypeError("Reader annotation message is invalid");
            }
            const annotation = await workflow.createAnnotation({
              color: message.color, comment: message.comment, pageLabel: message.pageLabel,
              positionJson: message.positionJson, sortIndex: message.sortIndex,
              tags: message.tags, text: message.text, type: message.annotationType,
            });
            await panel.webview.postMessage?.({ annotation, type: "annotation-created" });
            return;
          }
          if (message?.type === "annotation-update") {
            if (!workflow || typeof message.annotationKey !== "string" || !Number.isSafeInteger(message.expectedVersion)
                || typeof message.comment !== "string" || typeof message.color !== "string" || !Array.isArray(message.tags)
                || Object.keys(message).sort().join(",") !== "annotationKey,color,comment,expectedVersion,tags,type") {
              throw new TypeError("Reader annotation update message is invalid");
            }
            const result = await workflow.updateAnnotations([{
              annotationKey: message.annotationKey, color: message.color, comment: message.comment,
              expectedVersion: message.expectedVersion, tags: message.tags,
            }]);
            const version = result.annotations.find(value => value.annotationKey === message.annotationKey)?.version;
            const annotation = workflow.annotations.find(value => value.annotationKey === message.annotationKey);
            await panel.webview.postMessage?.({ annotation: annotation && { ...annotation, version: version ?? annotation.version }, type: "annotation-updated" });
            return;
          }
          if (message?.type === "annotation-delete") {
            if (!workflow || typeof message.annotationKey !== "string" || !Number.isSafeInteger(message.expectedVersion)
                || Object.keys(message).sort().join(",") !== "annotationKey,expectedVersion,type") {
              throw new TypeError("Reader annotation delete message is invalid");
            }
            await workflow.mutateAnnotation({ action: "trash", annotationKey: message.annotationKey, expectedVersion: message.expectedVersion });
            await panel.webview.postMessage?.({ annotationKey: message.annotationKey, type: "annotation-deleted" });
            return;
          }
          if (message?.type === "annotation-undo") {
            if (!workflow || Object.keys(message).sort().join(",") !== "type") throw new TypeError("Reader annotation undo message is invalid");
            const changed = await workflow.undo();
            await panel.webview.postMessage?.({ annotations: workflow.annotations, changed, type: "annotation-undone" });
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
          if (message?.type === "pdf-export") {
            if (Object.keys(message).sort().join(",") !== "type") throw new TypeError("PDF export message is invalid");
            const destination = await this.vscode.window.showSaveDialog({
              defaultUri: this.vscode.Uri.file(record.filename || `${record.attachmentKey}.pdf`),
              filters: { PDF: ["pdf"] },
              saveLabel: "Export PDF",
            });
            if (destination) await this.vscode.workspace.fs.copy(file, destination, { overwrite: true });
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
          if (keys.length !== 3 || keys[0] !== "panelNonce" || keys[1] !== "sequence" || keys[2] !== "type"
              || message.panelNonce !== panelNonce
              || !Number.isSafeInteger(message.sequence)
              || message.sequence !== lastSequence
              || message.sequence <= lastAttachSequence
              || !lastSnapshot
              || lastSnapshot.kind !== "pdf-selection"
              || lastSnapshot.selectedText.trim().length === 0) {
            throw new Error("PDF context attach sequence is invalid");
          }
          lastAttachSequence = message.sequence;
          await this.attachPdfContext(lastSnapshot);
        })();
        void operation.catch(async error => {
          if (["annotation-create", "annotation-update", "annotation-delete", "annotation-undo"].includes(message?.type)) {
            try { await panel.webview.postMessage?.({ message: error.message, type: "annotation-error" }); } catch (_) {}
          }
          this.onContextError(error);
        });
        return operation;
      })
        : null;
      viewStateSubscription = typeof panel.onDidChangeViewState === "function"
        ? panel.onDidChangeViewState(event => {
          this.contextBroker?.activate?.(document.uri, panelNonce, event?.webviewPanel?.active === true);
        })
        : null;
      panelDisposeSubscription = panel.onDidDispose?.(cleanup) ?? null;
      const renderedNonce = nonce();
      panel.webview.html = isPdf ? this.renderPdfEditorHTML({
        annotations,
        attachment: record,
        cspSource: panel.webview.cspSource,
        nonce: renderedNonce,
        initialState: loaded?.state ?? {},
        panelNonce,
        pdfJsUri: panel.webview.asWebviewUri(this.vscode.Uri.joinPath(this.viewerRoot, "pdf.mjs")).toString(),
        pdfUri: panel.webview.asWebviewUri(file).toString(),
        viewerUri: panel.webview.asWebviewUri(this.vscode.Uri.joinPath(this.viewerRoot, "pdf-viewer.mjs")).toString(),
        workerUri: panel.webview.asWebviewUri(this.vscode.Uri.joinPath(this.viewerRoot, "pdf.worker.mjs")).toString(),
      }) : this.renderUpstreamReaderHTML({
        annotations: annotations.map(this.toUpstreamReaderAnnotation),
        attachment: record,
        cspSource: panel.webview.cspSource,
        documentUri: panel.webview.asWebviewUri(file).toString(),
        hostUri: panel.webview.asWebviewUri(this.vscode.Uri.joinPath(this.upstreamReaderRoot, "chatero-reader-host.mjs")).toString(),
        luaparseUri: panel.webview.asWebviewUri(this.vscode.Uri.joinPath(this.upstreamReaderRoot, "luaparse.js")).toString(),
        nonce: renderedNonce,
        readerCssUri: panel.webview.asWebviewUri(this.vscode.Uri.joinPath(this.upstreamReaderRoot, "reader.css")).toString(),
        readerJsUri: panel.webview.asWebviewUri(this.vscode.Uri.joinPath(this.upstreamReaderRoot, "reader.js")).toString(),
        readerType: record.contentType === "application/epub+zip" ? "epub" : "snapshot",
        state: loaded?.state ?? {},
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
          if (!workflow || message?.type !== "note-save" || !Number.isSafeInteger(message.sequence)
              || message.sequence <= lastSequence || typeof message.html !== "string"
              || Buffer.byteLength(message.html, "utf8") > 1024 * 1024
              || Object.keys(message).sort().join(",") !== "html,sequence,type") {
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
