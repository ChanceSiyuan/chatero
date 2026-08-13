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
    this.makePanelNonce = makePanelNonce;
    this.onContextError = onContextError;
    if ((contextBroker === null) !== (attachPdfContext === null)
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
    const annotations = await model.annotations({ attachmentKey: record.attachmentKey, libraryId: record.libraryId });
    const materialized = await this.materializePdf(record);
    const file = this.vscode.Uri.file(materialized.path);
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.vscode.Uri.file(dirname(materialized.path)), this.viewerRoot] };
    const panelNonce = this.makePanelNonce();
    const contextLease = this.contextBroker?.open(document.uri, document.record, panelNonce, annotations) ?? null;
    let lastSequence = 0;
    let lastAttachSequence = 0;
    let lastSnapshot = null;
    let disposed = false;
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
      messageSubscription = this.contextBroker && typeof panel.webview.onDidReceiveMessage === "function"
        ? panel.webview.onDidReceiveMessage(message => {
        const operation = (async () => {
          if (message?.type === "pdf-context") {
            lastSnapshot = this.contextBroker.update(document.uri, document.record, panelNonce, message);
            lastSequence = message.sequence;
            return;
          }
          if (message?.type !== "pdf-context-attach") {
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
  constructor({ registry, getModel, resolveDocument, renderNoteEditorHTML }) {
    this.registry = registry;
    this.getModel = getModel;
    this.resolveDocument = resolveDocument || ((uri, kind) => registry.resolve(uri, kind));
    this.renderNoteEditorHTML = renderNoteEditorHTML;
  }

  async openCustomDocument(uri) {
    const record = await this.resolveDocument(uri, "note");
    return new EvidenceDocument(uri, record, () => this.registry.release(uri, "note", record));
  }

  async resolveCustomEditor(document, panel) {
    const model = this.getModel();
    if (!model) throw new Error("Start Zotero Core before opening a Note");
    panel.webview.options = { enableScripts: false, localResourceRoots: [] };
    const note = await model.note({ libraryId: document.record.libraryId, noteKey: document.record.noteKey });
    panel.webview.html = this.renderNoteEditorHTML({ note, cspSource: panel.webview.cspSource });
  }
}

module.exports = { NoteEditorProvider, PdfEditorProvider };
