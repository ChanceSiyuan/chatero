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

const note = Object.freeze({
  libraryId: 7,
  noteKey: "NOTE0001",
  parentItemKey: "ITEM0001",
  title: "Reading Note",
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

test("strict evidence URIs restore exact PDF and Note identities after the registry is reset", async () => {
  const { EvidenceDocumentRegistry, parseEvidenceDocumentUri } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  const registry = new EvidenceDocumentRegistry();
  const pdfUri = registry.stage("pdf", attachment);
  const noteUri = registry.stage("note", note);
  registry.reset();
  const calls = [];

  const [restoredPdf, restoredNote] = await Promise.all([
    registry.resolveOrHydrate(pdfUri, "pdf", async identity => {
      calls.push(identity);
      return attachment;
    }),
    registry.resolveOrHydrate(noteUri, "note", async identity => {
      calls.push(identity);
      return note;
    }),
  ]);

  assert.equal(restoredPdf.path, "/tmp/private/paper.pdf");
  assert.equal(restoredNote, note);
  assert.deepEqual(calls, [
    { kind: "pdf", libraryId: 7, key: "PDF00001" },
    { kind: "note", libraryId: 7, key: "NOTE0001" },
  ]);
  assert.deepEqual(parseEvidenceDocumentUri(pdfUri), { kind: "pdf", libraryId: 7, key: "PDF00001" });
  assert.doesNotMatch(pdfUri, /tmp|private|paper\.pdf/);
});

test("evidence URI parsing rejects noncanonical authority, path, query, fragment, and identity forms", async () => {
  const { parseEvidenceDocumentUri } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  const invalid = [
    "chatero-zotero-pdf://remote/7/PDF00001/paper.chatero-zotero-pdf",
    "chatero-zotero-pdf:/07/PDF00001/paper.chatero-zotero-pdf",
    "chatero-zotero-pdf:/7/pdf00001/paper.chatero-zotero-pdf",
    "chatero-zotero-pdf:/7/PDF00001/wrong.chatero-zotero-pdf",
    "chatero-zotero-pdf:/7/PDF00001/paper.chatero-zotero-pdf?path=/tmp/private.pdf",
    "chatero-zotero-pdf:/7/PDF00001/paper.chatero-zotero-pdf#fragment",
    "chatero-zotero-note:/7/NOTE0001/note.chatero-zotero-note/extra",
  ];
  for (const uri of invalid) assert.throws(() => parseEvidenceDocumentUri(uri), /evidence URI/);
});

test("rehydration rejects missing or mismatched Core records without rebinding the tab", async () => {
  const { EvidenceDocumentRegistry } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  const registry = new EvidenceDocumentRegistry();
  const uri = registry.stage("pdf", attachment);
  registry.reset();

  await assert.rejects(registry.resolveOrHydrate(uri, "pdf", async () => {
    throw new Error("Zotero attachment 7/PDF00001 was not found");
  }), /not found/);
  assert.throws(() => registry.resolve(uri, "pdf"), /active Zotero Core session/);
  await assert.rejects(registry.resolveOrHydrate(uri, "pdf", async () => Object.freeze({
    ...attachment,
    attachmentKey: "PDF00002",
  })), /identity/);
  assert.throws(() => registry.resolve(uri, "pdf"), /active Zotero Core session/);
});

test("simultaneous restored PDF and Note tabs start Core once", async () => {
  const [{ EvidenceDocumentRegistry, createEnsureCore }, providers] = await Promise.all([
    import("../extensions/chatero-zotero/evidence-editor-registry.mjs"),
    import("../extensions/chatero-zotero/evidence-editors.cjs"),
  ]);
  const registry = new EvidenceDocumentRegistry();
  const pdfUriValue = registry.stage("pdf", attachment);
  const noteUriValue = registry.stage("note", note);
  registry.reset();
  let currentCore = null;
  let starts = 0;
  let releaseStart;
  const startBarrier = new Promise(resolve => { releaseStart = resolve; });
  const ensureCore = createEnsureCore({
    getCurrent: () => currentCore,
    start: async () => {
      starts += 1;
      await startBarrier;
      currentCore = { ready: true };
      return currentCore;
    },
  });
  const resolveDocument = (uri, kind) => registry.resolveOrHydrate(uri, kind, async identity => {
    await ensureCore();
    return identity.kind === "pdf" ? attachment : note;
  });
  const fileUri = value => ({ authority: "", fsPath: value, path: value, scheme: "file", value, toString: () => `file://${value}` });
  const pdf = new providers.PdfEditorProvider({
    extensionUri: fileUri("/extension"),
    getModel: () => null,
    registry,
    resolveDocument,
    renderPdfEditorHTML: () => "",
    vscode: { Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(`${base.value}/${parts.join("/")}`) } },
  });
  const noteProvider = new providers.NoteEditorProvider({
    getModel: () => null,
    registry,
    resolveDocument,
    renderNoteEditorHTML: () => "",
  });
  const pdfPending = pdf.openCustomDocument({ toString: () => pdfUriValue });
  const notePending = noteProvider.openCustomDocument({ toString: () => noteUriValue });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  releaseStart();

  const [pdfDocument, noteDocument] = await Promise.all([pdfPending, notePending]);
  assert.equal(pdfDocument.record, attachment);
  assert.equal(noteDocument.record, note);
  assert.equal(starts, 1);
});

test("restored document resolver fetches only the exact Core identity and discards Note HTML", async () => {
  const { EvidenceDocumentRegistry, createEvidenceDocumentResolver } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  const registry = new EvidenceDocumentRegistry();
  const pdfUri = registry.stage("pdf", attachment);
  const noteUri = registry.stage("note", note);
  registry.reset();
  const calls = [];
  const model = {
    attachment: async params => {
      calls.push({ method: "attachment", params });
      return attachment;
    },
    note: async params => {
      calls.push({ method: "note", params });
      return Object.freeze({ ...note, html: "<p>Do not retain this in the registry</p>" });
    },
  };
  const resolveDocument = createEvidenceDocumentResolver({
    ensureCore: async () => ({ ready: true }),
    getModel: () => model,
    registry,
  });

  const restoredPdf = await resolveDocument(pdfUri, "pdf");
  const restoredNote = await resolveDocument(noteUri, "note");
  assert.equal(restoredPdf.path, attachment.path);
  assert.deepEqual(restoredNote, note);
  assert.equal(Object.hasOwn(restoredNote, "html"), false);
  assert.deepEqual(calls, [
    { method: "attachment", params: { attachmentKey: "PDF00001", libraryId: 7 } },
    { method: "note", params: { libraryId: 7, noteKey: "NOTE0001" } },
  ]);
});

test("Library model resolves one validated attachment by exact identity", async () => {
  const { LibraryTreeModel } = await import("../extensions/chatero-zotero/library-tree-model.mjs");
  const calls = [];
  const model = new LibraryTreeModel({
    request: async (method, params) => {
      calls.push({ method, params });
      return attachment;
    },
  });

  assert.deepEqual(await model.attachment({ attachmentKey: "PDF00001", libraryId: 7 }), attachment);
  assert.deepEqual(calls, [{
    method: "library.attachment",
    params: { attachmentKey: "PDF00001", libraryId: 7 },
  }]);
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
  assert.deepEqual(manifest.extensionKind, ["ui"]);
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
  const fileUri = value => ({ authority: "", fsPath: value, path: value, scheme: "file", value, toString: () => `file://${value}` });
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
  const exposedUris = [];
  const panel = { webview: {
    asWebviewUri: value => {
      exposedUris.push(value);
      return { toString: () => `vscode-webview:${value.value}` };
    },
    cspSource: "vscode-webview://unit-test",
  } };

  const document = await provider.openCustomDocument(uri);
  await provider.resolveCustomEditor(document, panel);

  assert.equal(panel.webview.html, "<html>PDF</html>");
  assert.deepEqual(panel.webview.options.localResourceRoots.map(value => value.value), [
    "/tmp/private",
    "/extension/media/pdf-viewer",
  ]);
  assert.equal(rendering.pdfUri, "vscode-webview:/tmp/private/paper.pdf");
  const pdfSource = exposedUris.find(value => value.value === attachment.path);
  assert.equal(pdfSource.scheme, "file");
  assert.equal(pdfSource.authority, "");
  assert.equal(rendering.viewerUri, "vscode-webview:/extension/media/pdf-viewer/pdf-viewer.mjs");
  assert.equal(rendering.workerUri, "vscode-webview:/extension/media/pdf-viewer/pdf.worker.mjs");
});
