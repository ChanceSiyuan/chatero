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
  constructor({ vscode, registry, getModel, resolveDocument, renderPdfEditorHTML, extensionUri }) {
    this.vscode = vscode;
    this.registry = registry;
    this.getModel = getModel;
    this.resolveDocument = resolveDocument || ((uri, kind) => registry.resolve(uri, kind));
    this.renderPdfEditorHTML = renderPdfEditorHTML;
    this.viewerRoot = vscode.Uri.joinPath(extensionUri, "media", "pdf-viewer");
  }

  async openCustomDocument(uri) {
    const record = await this.resolveDocument(uri, "pdf");
    return new EvidenceDocument(uri, record, () => this.registry.release(uri, "pdf", record));
  }

  async resolveCustomEditor(document, panel) {
    const model = this.getModel();
    if (!model) throw new Error("Start Zotero Core before opening a PDF");
    const record = document.record;
    const file = this.vscode.Uri.file(record.path);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.vscode.Uri.file(dirname(record.path)), this.viewerRoot],
    };
    const annotations = await model.annotations({ attachmentKey: record.attachmentKey, libraryId: record.libraryId });
    panel.webview.html = this.renderPdfEditorHTML({
      annotations,
      attachment: record,
      cspSource: panel.webview.cspSource,
      nonce: nonce(),
      pdfJsUri: panel.webview.asWebviewUri(this.vscode.Uri.joinPath(this.viewerRoot, "pdf.mjs")).toString(),
      pdfUri: panel.webview.asWebviewUri(file).toString(),
      viewerUri: panel.webview.asWebviewUri(this.vscode.Uri.joinPath(this.viewerRoot, "pdf-viewer.mjs")).toString(),
      workerUri: panel.webview.asWebviewUri(this.vscode.Uri.joinPath(this.viewerRoot, "pdf.worker.mjs")).toString(),
    });
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
