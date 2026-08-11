import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..", "..");
const extensionRoot = join(root, "products", "workbench", "extensions", "chatero-zotero");

const attachment = Object.freeze({
  annotationCount: 1,
  attachmentKey: "PDF00001",
  contentType: "application/pdf",
  filename: "paper.pdf",
  libraryId: 7,
  parentItemKey: "ITEM0001",
  path: "/tmp/private/paper.pdf",
  title: "Paper <PDF>",
});

test("evidence document registry publishes stable opaque URIs and rejects forged tabs", async () => {
  const { EvidenceDocumentRegistry } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  const registry = new EvidenceDocumentRegistry();
  const first = registry.stage("pdf", attachment);
  const second = registry.stage("pdf", attachment);

  assert.equal(first, second);
  assert.match(first, /^chatero-zotero-pdf:\/7\/PDF00001\//);
  assert.doesNotMatch(first, /tmp|private/);
  assert.equal(registry.resolve(first, "pdf"), attachment);
  assert.throws(() => registry.resolve(first.replace("PDF00001", "FORGED01"), "pdf"), /active Zotero Core session/);
  registry.reset();
  assert.throws(() => registry.resolve(first, "pdf"), /active Zotero Core session/);
});

test("PDF editor HTML boots the packaged PDF.js viewer with bounded annotation data", async () => {
  const { renderPdfEditorHTML } = await import("../extensions/chatero-zotero/evidence-editor-html.mjs");
  const html = renderPdfEditorHTML({
    annotations: [{
      annotationKey: "ANN00001",
      color: "#ffd400",
      comment: "Evidence </script><script>alert(1)</script>",
      libraryId: 7,
      pageLabel: "3",
      positionJson: '{"pageIndex":2,"rects":[[1,2,3,4]]}',
      sortIndex: "00002|000001|00000",
      text: "Quoted <claim>",
      type: "highlight",
    }],
    attachment,
    cspSource: "vscode-webview://unit-test",
    nonce: "fixed-nonce",
    pdfUri: "vscode-webview://unit-test/paper.pdf",
    viewerUri: "vscode-webview://unit-test/pdf-viewer.mjs",
    workerUri: "vscode-webview://unit-test/pdf.worker.mjs",
  });

  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-fixed-nonce'/);
  assert.match(html, /<canvas[^>]+id="pdf-canvas"/);
  assert.match(html, /<script[^>]+type="module"[^>]+src="vscode-webview:\/\/unit-test\/pdf-viewer\.mjs"/);
  assert.match(html, /data-worker-uri="vscode-webview:\/\/unit-test\/pdf\.worker\.mjs"/);
  assert.match(html, /data-page-index="2"/);
  assert.match(html, /Quoted &lt;claim&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("Note editor HTML confines Zotero HTML to a scriptless sandbox", async () => {
  const { renderNoteEditorHTML } = await import("../extensions/chatero-zotero/evidence-editor-html.mjs");
  const html = renderNoteEditorHTML({
    cspSource: "vscode-webview://unit-test",
    note: {
      html: '<p>Reading note</p><script>alert(1)</script>',
      libraryId: 7,
      noteKey: "NOTE0001",
      parentItemKey: "ITEM0001",
      title: "Reading Note",
    },
  });

  assert.match(html, /<iframe[^>]+sandbox=""/);
  assert.match(html, /&lt;p&gt;Reading note&lt;\/p&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /default-src 'none'/);
});

test("extension declares native PDF and Note custom editor tabs", async () => {
  const [manifest, source, packaging] = await Promise.all([
    readFile(join(extensionRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(extensionRoot, "extension.cjs"), "utf8"),
    readFile(join(root, "products", "workbench", "first-party-extensions.json"), "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(manifest.contributes.customEditors.map(value => value.viewType).sort(), [
    "chatero.zotero.note",
    "chatero.zotero.pdf",
  ]);
  assert.match(source, /registerCustomEditorProvider\("chatero\.zotero\.pdf"/);
  assert.match(source, /registerCustomEditorProvider\("chatero\.zotero\.note"/);
  assert.match(source, /executeCommand\("vscode\.openWith"/);
  assert.doesNotMatch(source, /openExternal|executeCommand\(["']vscode\.open["']/);
  const destinations = packaging.extensions.find(value => value.id === "chatero.zotero").files.map(value => value.destination);
  assert.ok(destinations.includes("extensions/chatero-zotero/media/pdf-viewer/pdf.mjs"));
  assert.ok(destinations.includes("extensions/chatero-zotero/media/pdf-viewer/pdf.worker.mjs"));
  assert.ok(destinations.includes("extensions/chatero-zotero/media/pdf-viewer/pdf-viewer.mjs"));
});

test("packaged PDF viewer renders one page at a time and owns the highlight overlay", async () => {
  const source = await readFile(join(extensionRoot, "media", "pdf-viewer", "pdf-viewer.mjs"), "utf8");
  assert.match(source, /getDocument/);
  assert.match(source, /getPage/);
  assert.match(source, /annotation-layer/);
  assert.match(source, /pageIndex/);
  assert.doesNotMatch(source, /fetch\(["']https?:|openExternal/);
});

test("PDF provider exposes only the authorized file and packaged viewer roots", async () => {
  const [{ EvidenceDocumentRegistry }, providers] = await Promise.all([
    import("../extensions/chatero-zotero/evidence-editor-registry.mjs"),
    import("../extensions/chatero-zotero/evidence-editors.cjs"),
  ]);
  const registry = new EvidenceDocumentRegistry();
  const uriValue = registry.stage("pdf", attachment);
  const uri = { toString: () => uriValue };
  const fileUri = value => ({ fsPath: value, value, toString: () => `file://${value}` });
  const vscode = { Uri: {
    file: fileUri,
    joinPath: (base, ...parts) => fileUri(`${base.value}/${parts.join("/")}`),
  } };
  let rendering;
  const provider = new providers.PdfEditorProvider({
    extensionUri: fileUri("/extension"),
    getModel: () => ({ annotations: async params => {
      assert.deepEqual(params, { attachmentKey: "PDF00001", libraryId: 7 });
      return [];
    } }),
    registry,
    renderPdfEditorHTML: value => { rendering = value; return "<html>PDF</html>"; },
    vscode,
  });
  const panel = { webview: {
    asWebviewUri: value => ({ toString: () => `vscode-webview:${value.value}` }),
    cspSource: "vscode-webview://unit-test",
  } };

  const document = provider.openCustomDocument(uri);
  await provider.resolveCustomEditor(document, panel);

  assert.equal(panel.webview.html, "<html>PDF</html>");
  assert.deepEqual(panel.webview.options.localResourceRoots.map(value => value.value), [
    "/tmp/private",
    "/extension/media/pdf-viewer",
  ]);
  assert.equal(rendering.pdfUri, "vscode-webview:/tmp/private/paper.pdf");
  assert.equal(rendering.viewerUri, "vscode-webview:/extension/media/pdf-viewer/pdf-viewer.mjs");
  assert.equal(rendering.workerUri, "vscode-webview:/extension/media/pdf-viewer/pdf.worker.mjs");
});
