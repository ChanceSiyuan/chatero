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
    extensionUri,
    materializePdf = async () => { throw new Error("Zotero PDF materialization is unavailable"); },
    contextBroker = null,
    attachPdfContext = null,
    createReaderWorkflow = null,
    makePanelNonce = nonce,
    onContextError = () => {},
  }) {
    this.vscode = vscode;
    this.registry = registry;
    this.getModel = getModel;
    this.resolveDocument = resolveDocument || ((uri, kind) => registry.resolve(uri, kind));
    this.renderPdfEditorHTML = renderPdfEditorHTML;
    this.materializePdf = materializePdf;
    this.viewerRoot = vscode.Uri.joinPath(extensionUri, "media", "pdf-viewer");
    this.contextBroker = contextBroker;
    this.attachPdfContext = attachPdfContext;
    this.createReaderWorkflow = createReaderWorkflow;
    this.makePanelNonce = makePanelNonce;
    this.onContextError = onContextError;
    if ((contextBroker === null) !== (attachPdfContext === null)
        || (createReaderWorkflow !== null && typeof createReaderWorkflow !== "function")
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
    const materialized = await this.materializePdf(record);
    const file = this.vscode.Uri.file(materialized.path);
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.vscode.Uri.file(dirname(materialized.path)), this.viewerRoot] };
    const panelNonce = this.makePanelNonce();
    const contextLease = this.contextBroker?.open(document.uri, document.record, panelNonce, annotations) ?? null;
    let lastSequence = 0;
    let lastAttachSequence = 0;
    let lastSnapshot = null;
    let disposed = false;
    let readerWrite = Promise.resolve();
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
          if (message?.type === "reader-state") {
            if (!workflow || !Number.isSafeInteger(message.pageIndex) || message.pageIndex < 0
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
                || typeof message.pageLabel !== "string" || typeof message.sortIndex !== "string") {
              throw new TypeError("Reader annotation message is invalid");
            }
            const annotation = await workflow.createAnnotation({
              color: "#ffd400", comment: "", pageLabel: message.pageLabel,
              positionJson: message.positionJson, sortIndex: message.sortIndex,
              tags: [], text: message.text, type: "highlight",
            });
            await panel.webview.postMessage?.({ annotation, type: "annotation-created" });
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
        void operation.catch(this.onContextError);
        return operation;
      })
        : null;
      viewStateSubscription = typeof panel.onDidChangeViewState === "function"
        ? panel.onDidChangeViewState(event => {
          this.contextBroker?.activate?.(document.uri, panelNonce, event?.webviewPanel?.active === true);
        })
        : null;
      panelDisposeSubscription = panel.onDidDispose?.(cleanup) ?? null;
      panel.webview.html = this.renderPdfEditorHTML({
        annotations,
        attachment: record,
        cspSource: panel.webview.cspSource,
        nonce: nonce(),
        initialState: loaded?.state ?? {},
        panelNonce,
        pdfJsUri: panel.webview.asWebviewUri(this.vscode.Uri.joinPath(this.viewerRoot, "pdf.mjs")).toString(),
        pdfUri: panel.webview.asWebviewUri(file).toString(),
        viewerUri: panel.webview.asWebviewUri(this.vscode.Uri.joinPath(this.viewerRoot, "pdf-viewer.mjs")).toString(),
        workerUri: panel.webview.asWebviewUri(this.vscode.Uri.joinPath(this.viewerRoot, "pdf.worker.mjs")).toString(),
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
