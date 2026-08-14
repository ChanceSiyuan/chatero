import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..", "..");
const extensionRoot = join(root, "products", "workbench", "extensions", "chatero-zotero");
const require = createRequire(import.meta.url);

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2000);
      }),
    ]);
  }
  finally {
    clearTimeout(timer);
  }
}

function fakeVscode(withProgress) {
  const commands = new Map();
  class EventEmitter {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    dispose() {}
    fire() {}
  }
  return {
    chat: {
      registerChatAttachContextProvider: () => ({ dispose() {} }),
    },
    commands: {
      executeCommand: async () => {},
      registerCommand(command, handler) {
        commands.set(command, handler);
        return { dispose() {} };
      },
    },
    commandsForTest: commands,
    ConfigurationTarget: { Global: 1 },
    EventEmitter,
    extensions: { getExtension: () => undefined },
    ProgressLocation: { Window: 1 },
    ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } },
    TreeItem: class TreeItem { constructor(label) { this.label = label; } },
    TreeItemCollapsibleState: { Collapsed: 1, None: 0 },
    Uri: {
      file: fsPath => ({ authority: "", fsPath, path: fsPath, scheme: "file", toString: () => `file://${fsPath}` }),
      joinPath: (base, ...parts) => ({ ...base, fsPath: `${base.fsPath ?? base.path}/${parts.join("/")}`, path: `${base.path}/${parts.join("/")}` }),
      parse: value => ({ toString: () => value }),
    },
    window: {
      createTreeView: () => ({
        dispose() {},
        onDidChangeSelection: () => ({ dispose() {} }),
      }),
      registerCustomEditorProvider: () => ({ dispose() {} }),
      registerTreeDataProvider: () => ({ dispose() {} }),
      showErrorMessage: async () => {},
      showInformationMessage: async () => {},
      showInputBox: async () => undefined,
      showOpenDialog: async () => undefined,
      withProgress,
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({
        get: (_key, fallback) => fallback,
        inspect: key => ({
          globalValue: key === "profilePath" ? "/tmp/chatero-profile"
            : key === "coreExecutable" ? "/tmp/chatero-core"
              : false,
        }),
        update: async () => {},
      }),
    },
  };
}

function fakeReaderServer({ origin = "http://127.0.0.1:44100" } = {}) {
  const disposals = [];
  const requests = [];
  return {
    disposals,
    requests,
    async lease(request) {
      requests.push(request);
      const leaseId = `LEASE0000${requests.length}`;
      return Object.freeze({
        dispose: () => disposals.push(leaseId),
        documentUrl: `${origin}/token/doc/${leaseId}`,
        origin,
        readerPageUrl: `${origin}/token/reader/chatero-reader.html`,
      });
    },
  };
}

function loadExtension(vscode) {
  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  const extensionPath = join(extensionRoot, "extension.cjs");
  delete require.cache[require.resolve(extensionPath)];
  try {
    return require(extensionPath);
  }
  finally {
    Module._load = originalLoad;
  }
}

const attachment = Object.freeze({
  annotationCount: 1,
  attachmentKey: "PDF00001",
  contentType: "application/pdf",
  filename: "paper.pdf",
  libraryId: 7,
  parentItemKey: "ITEM0001",
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

  assert.equal(restoredPdf, attachment);
  assert.equal(Object.hasOwn(restoredPdf, "path"), false);
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
    throw Object.assign(new Error("Zotero attachment 7/PDF00001 was not found"), { code: "UNAVAILABLE" });
  }), error => error?.code === "UNAVAILABLE" && /not found/.test(error.message));
  assert.throws(() => registry.resolve(uri, "pdf"), /active Zotero Core session/);
  await assert.rejects(registry.resolveOrHydrate(uri, "pdf", async () => Object.freeze({
    ...attachment,
    attachmentKey: "PDF00002",
  })), error => error?.code === "UNAVAILABLE" && /identity/.test(error.message));
  assert.throws(() => registry.resolve(uri, "pdf"), /active Zotero Core session/);
});

test("rehydration keeps deleted or trashed exact records unavailable", async () => {
  const { EvidenceDocumentRegistry, createEvidenceDocumentResolver } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  const registry = new EvidenceDocumentRegistry();
  const pdfUri = registry.stage("pdf", attachment);
  const noteUri = registry.stage("note", note);
  registry.reset();
  const lookups = [];
  const unavailable = kind => Object.assign(new Error(`Zotero ${kind} is unavailable`), { code: "UNAVAILABLE" });
  const resolveDocument = createEvidenceDocumentResolver({
    ensureCore: async () => ({ ready: true }),
    getModel: () => ({
      async attachment(params) {
        lookups.push(["attachment", params]);
        throw unavailable("attachment");
      },
      async note(params) {
        lookups.push(["note", params]);
        throw unavailable("note");
      },
    }),
    registry,
  });

  await assert.rejects(resolveDocument(pdfUri, "pdf"), error => error?.code === "UNAVAILABLE");
  await assert.rejects(resolveDocument(noteUri, "note"), error => error?.code === "UNAVAILABLE");
  assert.deepEqual(lookups, [
    ["attachment", { attachmentKey: "PDF00001", libraryId: 7 }],
    ["note", { libraryId: 7, noteKey: "NOTE0001" }],
  ]);
  assert.throws(() => registry.resolve(pdfUri, "pdf"), /active Zotero Core session/);
  assert.throws(() => registry.resolve(noteUri, "note"), /active Zotero Core session/);
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
    fromUpstreamReaderAnnotation: () => { throw new Error("not reached"); },
    getModel: () => null,
    readerLocationFromViewState: () => { throw new Error("not reached"); },
    readerServer: fakeReaderServer(),
    registry,
    resolveDocument,
    renderUpstreamReaderHTML: () => "",
    toUpstreamReaderAnnotation: value => value,
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

test("stop waits for an in-flight Core launch, suppresses publication, and releases its lease", async () => {
  const { createCoreLifecycle } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  let releaseLaunch;
  const launchBarrier = new Promise(resolve => { releaseLaunch = resolve; });
  let starts = 0;
  let stops = 0;
  let publications = 0;
  let unpublishes = 0;
  const core = {
    async stop() { stops += 1; },
    whenStopped: new Promise(() => {}),
  };
  const lifecycle = createCoreLifecycle({
    start: async () => {
      starts += 1;
      await launchBarrier;
      return core;
    },
    publish: () => { publications += 1; },
    unpublish: () => { unpublishes += 1; },
  });

  const launching = lifecycle.ensureCore();
  await new Promise(resolve => setImmediate(resolve));
  const stopping = lifecycle.stopCore();
  releaseLaunch();

  assert.equal(await launching, null);
  await stopping;
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(publications, 0);
  assert.equal(unpublishes, 1);
  assert.equal(lifecycle.getCurrent(), null);
});

test("dispose fences a pending Core launch and prevents future activation", async () => {
  const { createCoreLifecycle } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  let releaseLaunch;
  const launchBarrier = new Promise(resolve => { releaseLaunch = resolve; });
  let stops = 0;
  const core = {
    async stop() { stops += 1; },
    whenStopped: new Promise(() => {}),
  };
  const lifecycle = createCoreLifecycle({
    start: async () => {
      await launchBarrier;
      return core;
    },
  });

  const launching = lifecycle.ensureCore();
  await new Promise(resolve => setImmediate(resolve));
  const disposing = lifecycle.dispose();
  releaseLaunch();

  assert.equal(await launching, null);
  await disposing;
  assert.equal(stops, 1);
  await assert.rejects(lifecycle.ensureCore(), /disposed/);
});

test("ready Core disposal is idempotent and does not resolve before lease cleanup", async () => {
  const { createCoreLifecycle } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  let releaseStop;
  const stopBarrier = new Promise(resolve => { releaseStop = resolve; });
  let stops = 0;
  const core = {
    async stop() {
      stops += 1;
      await stopBarrier;
    },
    whenStopped: new Promise(() => {}),
  };
  const lifecycle = createCoreLifecycle({ start: async () => core });
  await lifecycle.ensureCore();

  const first = lifecycle.dispose();
  const second = lifecycle.dispose();
  assert.equal(first, second);
  let settled = false;
  void first.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  releaseStop();
  await first;
  assert.equal(stops, 1);
  assert.equal(lifecycle.getCurrent(), null);
});

test("restart waits for stop and a late old-Core exit cannot clear the new Core", async () => {
  const { createCoreLifecycle } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  let releaseFirstStop;
  const firstStopBarrier = new Promise(resolve => { releaseFirstStop = resolve; });
  let resolveFirstStopped;
  const firstWhenStopped = new Promise(resolve => { resolveFirstStopped = resolve; });
  let resolveSecondStopped;
  const secondWhenStopped = new Promise(resolve => { resolveSecondStopped = resolve; });
  const first = {
    id: "first",
    async stop() { await firstStopBarrier; },
    whenStopped: firstWhenStopped,
  };
  const second = {
    id: "second",
    async stop() { resolveSecondStopped({ expected: true }); },
    whenStopped: secondWhenStopped,
  };
  const available = [first, second];
  const published = [];
  let starts = 0;
  let unexpectedStops = 0;
  const lifecycle = createCoreLifecycle({
    start: async () => {
      starts += 1;
      return available.shift();
    },
    publish: core => { published.push(core.id); },
    onUnexpectedStop: () => { unexpectedStops += 1; },
  });
  assert.equal(await lifecycle.ensureCore(), first);

  const stopping = lifecycle.stopCore();
  const restarting = lifecycle.ensureCore();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  releaseFirstStop();
  await stopping;
  assert.equal(await restarting, second);
  resolveFirstStopped({ expected: false });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(lifecycle.getCurrent(), second);
  assert.deepEqual(published, ["first", "second"]);
  assert.equal(unexpectedStops, 0);
  await lifecycle.dispose();
});

test("publication callback failures cannot bypass Core stop", async () => {
  const { createCoreLifecycle } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  let publishStops = 0;
  const publishCore = {
    async stop() { publishStops += 1; },
    whenStopped: new Promise(() => {}),
  };
  const publishFailure = createCoreLifecycle({
    start: async () => publishCore,
    publish: () => { throw new Error("publish failed"); },
  });
  await assert.rejects(publishFailure.ensureCore(), /publish failed/);
  assert.equal(publishStops, 1);

  let unpublishStops = 0;
  const unpublishCore = {
    async stop() { unpublishStops += 1; },
    whenStopped: new Promise(() => {}),
  };
  const unpublishFailure = createCoreLifecycle({
    start: async () => unpublishCore,
    unpublish: () => { throw new Error("unpublish failed"); },
  });
  await unpublishFailure.ensureCore();
  await assert.rejects(unpublishFailure.stopCore(), /unpublish failed/);
  assert.equal(unpublishStops, 1);
});

test("extension deactivate awaits the same cleanup for pending and ready Core reloads", async () => {
  for (const state of ["pending", "ready"]) {
    const launch = deferred();
    const stop = deferred();
    const enteredProgress = deferred();
    let eventSubscriptions = 0;
    let eventDisposals = 0;
    let stops = 0;
    const core = {
      client: {
        onEvent() {
          eventSubscriptions += 1;
          return () => { eventDisposals += 1; };
        },
        request: async () => {},
      },
      async stop() {
        stops += 1;
        if (state === "ready") await stop.promise;
      },
      whenStopped: new Promise(() => {}),
    };
    const vscode = fakeVscode(async () => {
      enteredProgress.resolve();
      return state === "pending" ? launch.promise : core;
    });
    const extension = loadExtension(vscode);
    const context = {
      extensionUri: { authority: "", path: "/extension", scheme: "file" },
      subscriptions: [],
      workspaceState: {
        get: () => undefined,
        update: async () => {},
      },
    };
    await extension.activate(context);
    const starting = vscode.commandsForTest.get("chatero.zotero.startCore")();
    await within(enteredProgress.promise, `${state} progress`);
    if (state === "ready") await within(starting, "ready startup");

    assert.equal(context.subscriptions.at(-1).dispose(), undefined);
    const firstCleanup = extension.deactivate();
    const secondCleanup = extension.deactivate();
    assert.equal(firstCleanup, secondCleanup);
    let settled = false;
    void firstCleanup.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);

    if (state === "pending") launch.resolve(core);
    else stop.resolve();
    await within(firstCleanup, `${state} cleanup`);
    await within(starting, `${state} startup completion`);
    assert.equal(stops, 1);
    assert.equal(eventSubscriptions, state === "ready" ? 1 : 0);
    assert.equal(eventDisposals, state === "ready" ? 1 : 0);
  }
});

test("extension activation exposes only one frozen path-free Research API", async () => {
  const vscode = fakeVscode(async () => null);
  const extension = loadExtension(vscode);
  const context = {
    extensionUri: { authority: "", path: "/extension", scheme: "file" },
    subscriptions: [],
    workspaceState: { get: () => undefined, update: async () => {} },
  };
  const api = await extension.activate(context);
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api).sort(), [
    "exportBibliographySnapshot", "getActiveNoteSnapshot", "getActiveResearchObject", "getSelectionSnapshot", "redeemFullPdfGrant",
  ]);
  assert.doesNotMatch(JSON.stringify(api), /profilePath|coreExecutable|path|client|request/iu);
});

test("attachment export is a workbench command bound to the active reader, not a webview message", async () => {
  const [manifest, providersSource, extensionSource] = await Promise.all([
    readFile(join(extensionRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(extensionRoot, "evidence-editors.cjs"), "utf8"),
    readFile(join(extensionRoot, "extension.cjs"), "utf8"),
  ]);
  assert.deepEqual(manifest.contributes.commands.filter(value => value.command === "chatero.zotero.exportActivePdf"), [{
    category: "Chatero",
    command: "chatero.zotero.exportActivePdf",
    title: "Export Copy of Active Zotero Attachment…",
  }]);
  assert.doesNotMatch(providersSource, /pdf-export/);
  assert.match(extensionSource, /onActiveReaderChanged: value => \{ activeReaderExport = value; \}/);
  assert.match(extensionSource, /registerCommand\("chatero\.zotero\.exportActivePdf"[\s\S]{0,600}?workspace\.fs\.copy\(file, destination, \{ overwrite: true \}\)/);

  const vscode = fakeVscode(async () => null);
  const informations = [];
  const dialogs = [];
  const copies = [];
  vscode.window.showInformationMessage = async value => { informations.push(value); };
  vscode.window.showSaveDialog = async options => { dialogs.push(options); return undefined; };
  vscode.workspace.fs = { copy: async (...values) => { copies.push(values); } };
  const extension = loadExtension(vscode);
  await extension.activate({
    extensionUri: { authority: "", path: "/extension", scheme: "file" },
    subscriptions: [],
    workspaceState: { get: () => undefined, update: async () => {} },
  });

  const exportCommand = vscode.commandsForTest.get("chatero.zotero.exportActivePdf");
  assert.equal(typeof exportCommand, "function");
  await exportCommand();
  assert.deepEqual(informations, ["Open a Zotero attachment to export a copy of it."]);
  assert.deepEqual(dialogs, []);
  assert.deepEqual(copies, []);
  await extension.deactivate();
});

test("an unexpected Core stop invalidates evidence before restart and forces exact lookup", async () => {
  const {
    EvidenceDocumentRegistry,
    createCoreLifecycle,
    createEvidenceDocumentResolver,
  } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  const registry = new EvidenceDocumentRegistry();
  let crashFirst;
  const firstStopped = new Promise(resolve => { crashFirst = resolve; });
  let secondStopped;
  const secondWhenStopped = new Promise(resolve => { secondStopped = resolve; });
  let lookups = 0;
  const cores = [{
    client: { model: { attachment: async () => attachment } },
    async stop() {},
    whenStopped: firstStopped,
  }, {
    client: { model: { attachment: async () => {
      lookups += 1;
      throw Object.assign(new Error("Zotero attachment is unavailable"), { code: "UNAVAILABLE" });
    } } },
    async stop() { secondStopped({ expected: true }); },
    whenStopped: secondWhenStopped,
  }];
  let model = null;
  let unexpectedStops = 0;
  const lifecycle = createCoreLifecycle({
    start: async () => cores.shift(),
    publish: core => { model = core.client.model; },
    unpublish: () => {
      model = null;
      registry.reset();
    },
    onUnexpectedStop: () => { unexpectedStops += 1; },
  });
  const resolveDocument = createEvidenceDocumentResolver({
    ensureCore: lifecycle.ensureCore,
    getModel: () => model,
    registry,
  });

  await lifecycle.ensureCore();
  const uri = registry.stage("pdf", attachment);
  crashFirst({ expected: false });
  await new Promise(resolve => setImmediate(resolve));

  await assert.rejects(resolveDocument(uri, "pdf"), error => error?.code === "UNAVAILABLE");
  assert.equal(unexpectedStops, 1);
  assert.equal(lookups, 1);
  assert.throws(() => registry.resolve(uri, "pdf"), /active Zotero Core session/);
  await lifecycle.dispose();
});

test("a fresh tree record can replace a rehydrated identity and reopen after close", async () => {
  const [{ EvidenceDocumentRegistry }, providers] = await Promise.all([
    import("../extensions/chatero-zotero/evidence-editor-registry.mjs"),
    import("../extensions/chatero-zotero/evidence-editors.cjs"),
  ]);
  const registry = new EvidenceDocumentRegistry();
  const uriValue = registry.stage("pdf", attachment);
  registry.reset();
  let hydrationRecord = attachment;
  let hydrations = 0;
  const resolveDocument = (uri, kind) => registry.resolveOrHydrate(uri, kind, async () => {
    hydrations += 1;
    return hydrationRecord;
  });
  const provider = new providers.PdfEditorProvider({
    extensionUri: { value: "/extension" },
    fromUpstreamReaderAnnotation: () => { throw new Error("not reached"); },
    getModel: () => null,
    readerLocationFromViewState: () => { throw new Error("not reached"); },
    readerServer: fakeReaderServer(),
    registry,
    resolveDocument,
    renderUpstreamReaderHTML: () => "",
    toUpstreamReaderAnnotation: value => value,
    vscode: { Uri: { joinPath: (base, ...parts) => ({ value: `${base.value}/${parts.join("/")}` }) } },
  });
  const uri = { toString: () => uriValue };
  const restored = await provider.openCustomDocument(uri);
  assert.equal(restored.record, attachment);
  const fresh = Object.freeze({
    ...attachment,
    filename: "refreshed-paper.pdf",
    title: "Refreshed Paper",
  });
  hydrationRecord = fresh;

  assert.equal(registry.stage("pdf", fresh), uriValue);
  restored.dispose();
  const first = await provider.openCustomDocument(uri);
  assert.equal(first.record, fresh);
  first.dispose();
  assert.throws(() => registry.resolve(uri, "pdf"), /active Zotero Core session/);
  const reopened = await provider.openCustomDocument(uri);
  assert.equal(reopened.record, fresh);
  assert.equal(hydrations, 2);
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
  assert.equal(Object.hasOwn(restoredPdf, "path"), false);
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

test("remote workspace overrides cannot select a local Core executable or profile", async () => {
  const { readCoreLaunchConfiguration } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  const values = {
    coreExecutable: {
      globalValue: "/Applications/Chatero.app/Contents/MacOS/chatero",
      workspaceFolderValue: "/tmp/hostile-folder-core",
      workspaceValue: "/tmp/hostile-workspace-core",
    },
    developerFixtureCore: {
      globalValue: false,
      workspaceFolderValue: true,
      workspaceValue: true,
    },
    profilePath: {
      globalValue: "/Users/safe/Library/Application Support/Chatero/Profiles/research",
      workspaceFolderValue: "/tmp/hostile-folder-profile",
      workspaceValue: "/tmp/hostile-workspace-profile",
    },
  };
  const configuration = { inspect: key => values[key] };

  assert.deepEqual(readCoreLaunchConfiguration(configuration), {
    coreExecutable: "/Applications/Chatero.app/Contents/MacOS/chatero",
    developerFixtureCore: false,
    profilePath: "/Users/safe/Library/Application Support/Chatero/Profiles/research",
  });
  assert.deepEqual(readCoreLaunchConfiguration({
    inspect: key => ({ workspaceFolderValue: values[key].workspaceFolderValue, workspaceValue: values[key].workspaceValue }),
  }), {
    coreExecutable: "",
    developerFixtureCore: false,
    profilePath: "",
  });
});

test("production Core resolution binds the packaged headless Gecko executable without a user setting", async () => {
  const { resolveCoreExecutable } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  const extensionPath = "/Applications/Chatero.app/Contents/Resources/app/extensions/chatero-zotero";
  const bundled = "/Applications/Chatero.app/Contents/Resources/chatero-core/Chatero Core.app/Contents/MacOS/zotero";
  assert.equal(await resolveCoreExecutable({
    configuredPath: "/tmp/hostile-user-core",
    extensionPath,
    platform: "darwin",
    isFile: async path => path === bundled,
  }), bundled);
  assert.equal(await resolveCoreExecutable({
    configuredPath: "/tmp/development-core",
    extensionPath: "/tmp/code-oss/extensions/chatero-zotero",
    platform: "darwin",
    isFile: async path => path === "/tmp/development-core",
  }), "/tmp/development-core");
  await assert.rejects(resolveCoreExecutable({
    configuredPath: "/tmp/missing",
    extensionPath,
    platform: "darwin",
    isFile: async () => false,
  }), /bundled Zotero Core is unavailable/iu);
});

test("complete Zotero compatibility mode uses the same private profile without headless Core flags", async () => {
  const { buildZoteroCompatibilityLaunchPlan } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  assert.deepEqual(buildZoteroCompatibilityLaunchPlan({
    geckoExecutable: "/Applications/Chatero.app/Contents/Resources/chatero-core/Chatero Core.app/Contents/MacOS/zotero",
    profileDirectory: "/Users/safe/Library/Application Support/Chatero/Profiles/research",
  }), {
    args: [
      "-no-remote",
      "-profile",
      "/Users/safe/Library/Application Support/Chatero/Profiles/research",
      "-datadir",
      "profile",
    ],
    executable: "/Applications/Chatero.app/Contents/Resources/chatero-core/Chatero Core.app/Contents/MacOS/zotero",
    profileDirectory: "/Users/safe/Library/Application Support/Chatero/Profiles/research",
  });
  assert.throws(() => buildZoteroCompatibilityLaunchPlan({
    geckoExecutable: "relative/zotero",
    profileDirectory: "/Users/safe/profile",
  }), /absolute/iu);
});

test("complete Zotero compatibility process owns the profile lease until exit", async () => {
  const { EventEmitter } = await import("node:events");
  const { launchZoteroCompatibilityMode } = await import("../extensions/chatero-zotero/zotero-compatibility-launcher.mjs");
  const child = new EventEmitter();
  child.pid = 4321;
  child.kill = () => true;
  const calls = [];
  let released = 0;
  const launched = launchZoteroCompatibilityMode({
    args: ["-profile", "/private/profile"],
    executable: "/private/zotero",
    profileDirectory: "/private/profile",
  }, {
    acquireLease: async value => {
      calls.push(value);
      return { async release() { released += 1; } };
    },
    spawnProcess(executable, args, options) {
      assert.equal(executable, "/private/zotero");
      assert.deepEqual(args, ["-profile", "/private/profile"]);
      assert.deepEqual(options, { detached: false, stdio: "ignore" });
      return child;
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, undefined);
  assert.equal(calls[0].profileDirectory, "/private/profile");
  child.emit("exit", 0, null);
  assert.equal(await launched, 0);
  assert.equal(released, 1);
});

test("Core setup pickers reject remote URIs before persisting local paths", async () => {
  const { selectLocalCoreConfigurationPath } = await import("../extensions/chatero-zotero/evidence-editor-registry.mjs");
  const localDefault = { authority: "", fsPath: "/Users/safe", scheme: "file" };
  const hostile = {
    authority: "chatero-remote+dGFyZ2V0",
    fsPath: "/srv/hostile",
    path: "/srv/hostile",
    scheme: "vscode-remote",
  };

  for (const dialogOptions of [
    { canSelectFiles: false, canSelectFolders: true, title: "Select profile" },
    { canSelectFiles: true, canSelectFolders: false, title: "Select executable" },
  ]) {
    const writes = [];
    let receivedOptions;
    await assert.rejects(selectLocalCoreConfigurationPath({
      defaultUri: localDefault,
      dialogOptions,
      label: dialogOptions.title,
      showOpenDialog: async options => {
        receivedOptions = options;
        return [hostile];
      },
      update: async value => { writes.push(value); },
    }), /local file/);
    assert.equal(receivedOptions.defaultUri, localDefault);
    assert.equal(receivedOptions.defaultUri.scheme, "file");
    assert.deepEqual(writes, []);
  }
});

test("PDF editor HTML relays the packaged upstream Reader page with bounded annotation data", async () => {
  const { renderUpstreamReaderHTML } = await import("../extensions/chatero-zotero/evidence-editor-html.mjs");
  const annotation = Object.freeze({
    color: "#ffd400",
    comment: "Evidence </script><script>alert(1)</script>",
    id: "ANN00001",
    pageLabel: "3",
    position: { pageIndex: 2, rects: [[1, 2, 3, 4]] },
    sortIndex: "00002|000001|00000",
    tags: [],
    text: "Quoted <claim>",
    type: "highlight",
  });
  const html = renderUpstreamReaderHTML({
    annotations: [annotation],
    attachment,
    documentUri: "http://127.0.0.1:44100/token/doc/LEASE00001",
    frameOrigin: "http://127.0.0.1:44100",
    nonce: "fixed-nonce",
    panelNonce: "AAAAAAAAAAAAAAAAAAAAAAAA",
    readerPageUri: "http://127.0.0.1:44100/token/reader/chatero-reader.html",
    readerType: "pdf",
    state: { pageIndex: 2 },
  });

  assert.match(html, /content="default-src 'none'; frame-src http:\/\/127\.0\.0\.1:44100; style-src 'nonce-fixed-nonce'; script-src 'nonce-fixed-nonce'"/);
  assert.match(html, /<iframe id="reader-frame" src="http:\/\/127\.0\.0\.1:44100\/token\/reader\/chatero-reader\.html" title="Paper &lt;PDF&gt;"/);
  assert.match(html, /<title>Paper &lt;PDF&gt;<\/title>/);
  assert.deepEqual(JSON.parse(html.match(/<script id="reader-config" type="application\/json">(.*?)<\/script>/su)[1]), {
    annotations: [annotation],
    documentUri: "http://127.0.0.1:44100/token/doc/LEASE00001",
    panelNonce: "AAAAAAAAAAAAAAAAAAAAAAAA",
    readerType: "pdf",
    state: { pageIndex: 2 },
    title: "Paper <PDF>",
  });
  assert.match(html, /const childOrigin = new URL\(frame\.src\)\.origin/);
  assert.match(html, /if \(event\.origin !== childOrigin\) return;/);
  assert.match(html, /"chatero-reader-ready"/);
  assert.match(html, /postMessage\(\{ type: "chatero-reader-init", \.\.\.config \}, childOrigin\)/);
  assert.match(html, /const KEY_FIELDS = \["altKey", "code", "ctrlKey", "key", "keyCode", "metaKey", "repeat", "shiftKey"\]/);
  assert.match(html, /event\.data\?\.type === "chatero-reader-key"/);
  assert.match(html, /if \(event\.data\.eventType !== "keydown" && event\.data\.eventType !== "keyup"\) return;/);
  assert.match(html, /window\.dispatchEvent\(new KeyboardEvent\(event\.data\.eventType, init\)\)/);
  assert.match(html, /acquireVsCodeApi\(\)/);
  assert.match(html, /\\u003c\/script>/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /createReader|reader\.js|pdf\.worker|libraryId|attachmentKey/);
  for (const url of html.match(/https?:\/\/[^"' ;]+/gu)) assert.ok(url.startsWith("http://127.0.0.1:44100"), `unexpected remote URL ${url}`);
});

test("Note editor HTML provides a sanitized rich-text round-trip editor with conflict recovery", async () => {
  const { renderNoteEditorHTML } = await import("../extensions/chatero-zotero/evidence-editor-html.mjs");
  const html = renderNoteEditorHTML({
    cspSource: "vscode-webview://unit-test",
    nonce: "fixed-note-nonce",
    note: {
      html: '<p>Reading note</p><script>alert(1)</script>',
      libraryId: 7,
      noteKey: "NOTE0001",
      parentItemKey: "ITEM0001",
      title: "Reading Note",
    },
  });

  assert.match(html, /id="note-editor" contenteditable="true"/);
  assert.match(html, /id="note-data" type="application\/json"/);
  assert.match(html, /setHTML\(JSON\.parse/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-fixed-note-nonce'/);
  assert.match(html, /type:"note-save"/);
  assert.match(html, /type:"note-reload"/);
  assert.match(html, /function sanitize/);
  assert.match(html, /aria-readonly/);
  assert.match(html, /id="save-note"/);
});

test("Note provider serializes versioned saves and acknowledges only accepted messages", async () => {
  const providers = await import("../extensions/chatero-zotero/evidence-editors.cjs");
  const calls = [];
  let receiveMessage;
  let disposeListener;
  let subscriptionDisposals = 0;
  const workflow = {
    async loadNote(identity) {
      calls.push(["load", identity]);
      return { ...note, html: "<p>Original</p>", version: 4 };
    },
    async updateNote(value) {
      calls.push(["update", value]);
      return { ...value, replayed: false, revision: calls.length, synced: false, version: value.version + 1 };
    },
  };
  const posted = [];
  const provider = new providers.NoteEditorProvider({
    createReaderWorkflow: model => { assert.deepEqual(model, { ready: true }); return workflow; },
    getModel: () => ({ ready: true }),
    registry: { release() {} },
    renderNoteEditorHTML: value => { calls.push(["render", value]); return "<html>Note</html>"; },
  });
  const panel = {
    onDidDispose(listener) { disposeListener = listener; return { dispose() {} }; },
    webview: {
      cspSource: "vscode-webview://unit-test",
      onDidReceiveMessage(listener) { receiveMessage = listener; return { dispose() { subscriptionDisposals += 1; } }; },
      async postMessage(message) { posted.push(message); },
    },
  };

  await provider.resolveCustomEditor({ record: note }, panel);
  assert.equal(panel.webview.options.enableScripts, true);
  assert.equal(panel.webview.html, "<html>Note</html>");
  await receiveMessage({ type: "note-save", sequence: 1, html: "<p>First</p>" });
  await receiveMessage({ type: "note-save", sequence: 2, html: "<p>Second</p>" });
  assert.deepEqual(calls.filter(value => value[0] === "update").map(value => value[1].version), [4, 5]);
  assert.deepEqual(posted.map(value => ({ sequence: value.sequence, type: value.type, version: value.version })), [
    { sequence: 1, type: "note-saved", version: 5 },
    { sequence: 2, type: "note-saved", version: 6 },
  ]);
  await assert.rejects(receiveMessage({ type: "note-save", sequence: 2, html: "replay" }), /invalid/);
  await receiveMessage({ type: "note-reload", sequence: 3 });
  assert.deepEqual(posted.at(-1), { html: "<p>Original</p>", sequence: 3, type: "note-reloaded", version: 4 });
  disposeListener();
  assert.equal(subscriptionDisposals, 1);
});

test("extension declares native PDF and Note custom editor tabs", async () => {
  const [manifest, source, providersSource, packaging] = await Promise.all([
    readFile(join(extensionRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(extensionRoot, "extension.cjs"), "utf8"),
    readFile(join(extensionRoot, "evidence-editors.cjs"), "utf8"),
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
  assert.match(providersSource, /\["http", "https", "mailto"\]/);
  assert.match(providersSource, /openExternal/);
  assert.doesNotMatch(source, /executeCommand\(["']vscode\.open["']/);
  for (const key of ["profilePath", "coreExecutable", "developerFixtureCore"]) {
    assert.ok(["application", "machine"].includes(manifest.contributes.configuration.properties[`chatero.zotero.${key}`].scope));
  }
  assert.match(source, /readCoreLaunchConfiguration/);
  assert.match(source, /function deactivate\(\)\s*{[^}]*\.dispose\(\)/s);
  const destinations = packaging.extensions.find(value => value.id === "chatero.zotero").files.map(value => value.destination);
  assert.ok(destinations.includes("extensions/chatero-zotero/media/zotero-reader/pdf/build/pdf.mjs"));
  assert.ok(destinations.includes("extensions/chatero-zotero/media/zotero-reader/pdf/build/pdf.worker.mjs"));
  assert.ok(destinations.includes("extensions/chatero-zotero/media/zotero-reader/pdf/web/viewer.html"));
  assert.ok(destinations.includes("extensions/chatero-zotero/media/zotero-reader/pdf/web/viewer.mjs"));
  assert.ok(destinations.includes("extensions/chatero-zotero/media/zotero-reader/pdf/web/viewer.css"));
  assert.ok(destinations.includes("extensions/chatero-zotero/media/zotero-reader/chatero-reader.html"));
  assert.ok(destinations.includes("extensions/chatero-zotero/media/zotero-reader/chatero-reader-host.mjs"));
  assert.ok(destinations.includes("extensions/chatero-zotero/media/zotero-reader/reader.js"));
  assert.ok(destinations.includes("extensions/chatero-zotero/media/zotero-reader/reader.css"));
  assert.ok(destinations.includes("extensions/chatero-zotero/media/zotero-reader/ZOTERO-AGPL-3.0.txt"));
  assert.ok(destinations.includes("extensions/chatero-zotero/upstream-reader-bridge.mjs"));
  assert.ok(destinations.includes("extensions/chatero-zotero/reader-server.cjs"));
  assert.equal(
    destinations.indexOf("extensions/chatero-zotero/reader-server.cjs"),
    destinations.indexOf("extensions/chatero-zotero/evidence-editors.cjs") + 1,
  );
  assert.deepEqual(destinations.filter(value => value.includes("/media/pdf-viewer/")), []);
  assert.equal(new Set(destinations).size, destinations.length);
});

test("EPUB provider uses the pinned upstream Reader and commits exact CFI state", async () => {
  const providers = await import("../extensions/chatero-zotero/evidence-editors.cjs");
  const epub = Object.freeze({ ...attachment, contentType: "application/epub+zip", filename: "paper.epub" });
  const calls = [];
  const workflow = {
    annotations: [],
    async load() { return { annotations: [], attachment: epub, state: { attachmentKey: "PDF00001", contentType: "application/epub+zip", libraryId: 7, version: 2 } }; },
    async updateLocation(value) { calls.push(["state", value]); return { ...value, version: 2 }; },
  };
  const fileUri = value => ({ authority: "", fsPath: value, path: value, scheme: "file", value, toString: () => `file://${value}` });
  const readerServer = fakeReaderServer();
  const provider = new providers.PdfEditorProvider({
    createReaderWorkflow: () => workflow,
    extensionUri: fileUri("/extension"),
    fromUpstreamReaderAnnotation: () => { throw new Error("not reached"); },
    getModel: () => ({ ready: true }),
    materializePdf: async () => ({ path: "/tmp/private/document.epub", async dispose() {} }),
    readerLocationFromViewState: (_contentType, state) => ({ cfi: state.cfi }),
    readerServer,
    registry: { release() {} },
    renderUpstreamReaderHTML: value => { calls.push(["render", value]); return "<html>EPUB</html>"; },
    toUpstreamReaderAnnotation: value => value,
    vscode: {
      Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(`${base.value}/${parts.join("/")}`), parse: value => ({ scheme: value.split(":")[0] }) },
      env: { async openExternal() {} }, window: {}, workspace: {},
    },
  });
  let receiveMessage;
  const panel = { active: true, onDidDispose() { return { dispose() {} }; }, webview: {
    asWebviewUri: value => ({ toString: () => `vscode-webview:${value.value}` }), cspSource: "vscode-webview://unit-test",
    onDidReceiveMessage(listener) { receiveMessage = listener; return { dispose() {} }; },
  } };
  await provider.resolveCustomEditor({ record: epub, uri: { toString: () => "chatero-zotero-pdf:/7/PDF00001/paper.chatero-zotero-pdf" } }, panel);
  assert.equal(panel.webview.html, "<html>EPUB</html>");
  const rendered = calls.find(value => value[0] === "render")[1];
  assert.equal(rendered.readerType, "epub");
  assert.deepEqual(panel.webview.options, { enableScripts: true, localResourceRoots: [] });
  assert.deepEqual(readerServer.requests, [{ contentType: "application/epub+zip", path: "/tmp/private/document.epub" }]);
  assert.equal(rendered.documentUri, "http://127.0.0.1:44100/token/doc/LEASE00001");
  assert.equal(rendered.frameOrigin, "http://127.0.0.1:44100");
  assert.equal(rendered.readerPageUri, "http://127.0.0.1:44100/token/reader/chatero-reader.html");
  await receiveMessage({ type: "upstream-reader-state", state: { cfi: "epubcfi(/6/2)" } });
  assert.deepEqual(calls.at(-1), ["state", { cfi: "epubcfi(/6/2)" }]);
});

test("upstream Reader saves and deletes use one atomic batch and preserve created key identity", async () => {
  const providers = await import("../extensions/chatero-zotero/evidence-editors.cjs");
  const epub = Object.freeze({ ...attachment, contentType: "application/epub+zip", filename: "paper.epub" });
  const existing = Object.freeze({ annotationKey: "ANN00001", color: "#ffd400", comment: "Old", libraryId: 7, pageLabel: "1", positionJson: '{"type":"CssSelector","value":"#old"}', sortIndex: "00001", tags: [], text: "Old", type: "highlight", version: 2 });
  const created = Object.freeze({ ...existing, annotationKey: "ANNNEW01", comment: "New", version: 1 });
  const batches = [];
  const workflow = {
    annotations: [existing],
    async load() { return { annotations: this.annotations, attachment: epub, state: { attachmentKey: "PDF00001", contentType: "application/epub+zip", libraryId: 7, version: 2 } }; },
    async applyAnnotationChanges(changes) {
      batches.push(changes);
      if (changes.some(value => value.action === "create")) this.annotations = [existing, created];
      return { created: changes.flatMap((value, index) => value.action === "create" ? [{ changeIndex: index, annotation: created }] : []), replayed: false, results: [], revision: batches.length };
    },
  };
  const fileUri = value => ({ authority: "", fsPath: value, path: value, scheme: "file", value, toString: () => `file://${value}` });
  const provider = new providers.PdfEditorProvider({
    createReaderWorkflow: () => workflow,
    extensionUri: fileUri("/extension"),
    fromUpstreamReaderAnnotation: (value, current) => current
      ? { annotationKey: current.annotationKey, comment: value.comment, expectedVersion: current.version }
      : { action: "create", color: value.color, comment: value.comment, pageLabel: value.pageLabel, positionJson: JSON.stringify(value.position), sortIndex: value.sortIndex, tags: [], text: value.text, type: value.type },
    getModel: () => ({ ready: true }),
    materializePdf: async () => ({ path: "/tmp/private/document.epub", async dispose() {} }),
    readerLocationFromViewState: (_contentType, state) => state,
    readerServer: fakeReaderServer(),
    registry: { release() {} },
    renderUpstreamReaderHTML: () => "<html>EPUB</html>",
    toUpstreamReaderAnnotation: value => value,
    vscode: { Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(`${base.value}/${parts.join("/")}`), parse: value => ({ scheme: value.split(":")[0] }) }, env: { async openExternal() {} }, window: {}, workspace: {} },
  });
  let receiveMessage;
  const posted = [];
  const panel = { active: true, onDidDispose() { return { dispose() {} }; }, webview: {
    asWebviewUri: value => ({ toString: () => `vscode-webview:${value.value}` }), cspSource: "vscode-webview://unit-test",
    onDidReceiveMessage(listener) { receiveMessage = listener; return { dispose() {} }; },
    async postMessage(message) { posted.push(message); },
  } };
  await provider.resolveCustomEditor({ record: epub, uri: { toString: () => "chatero-zotero-pdf:/7/PDF00001/paper.chatero-zotero-pdf" } }, panel);

  const upstream = (id, comment) => ({ id, color: "#ffd400", comment, pageLabel: "1", position: { type: "CssSelector", value: `#${id}` }, sortIndex: "00001", tags: [], text: comment, type: "highlight" });
  await receiveMessage({ type: "upstream-reader-save", annotations: [upstream("temp-1", "New"), upstream("ANN00001", "Edited")], sequence: 1 });
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(value => value.action || "update"), ["create", "update"]);
  await receiveMessage({ type: "upstream-reader-delete", ids: ["temp-1"], sequence: 2 });
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[1], [{ action: "trash", annotationKey: "ANNNEW01", expectedVersion: 1 }]);
  // A reader delete of a never-persisted create, and the empty batch the reader
  // pairs with a create-only save, acknowledge without touching Core.
  await receiveMessage({ type: "upstream-reader-delete", ids: ["temp-2"], sequence: 3 });
  await receiveMessage({ type: "upstream-reader-delete", ids: [], sequence: 4 });
  assert.equal(batches.length, 2);
  assert.deepEqual(posted.map(value => [value.type, value.sequence]), [
    ["upstream-reader-saved", 1], ["upstream-reader-saved", 2], ["upstream-reader-saved", 3], ["upstream-reader-saved", 4],
  ]);
});

test("upstream Reader host exposes unawaited delete failures and locks further edits", async () => {
  const [host, readerPage] = await Promise.all([
    readFile(join(extensionRoot, "media", "zotero-reader", "chatero-reader-host.mjs"), "utf8"),
    readFile(join(extensionRoot, "media", "zotero-reader", "chatero-reader.html"), "utf8"),
  ]);
  assert.match(host, /function exposeWriteFailure/);
  assert.match(host, /setReadOnly\(true\)/);
  assert.match(host, /pending\.set\(requestSequence, \{\}\)/);
  assert.match(host, /if \(!operation\) \{[\s\S]*exposeWriteFailure/);
  assert.match(host, /document\.getElementById\("reader-error"\)/);
  assert.match(host, /if \(!Array\.isArray\(ids\) \|\| !ids\.length\) return;/);
  assert.match(readerPage, /id="reader-error" role="alert" hidden/);
  assert.match(readerPage, /<script type="module" src="\.\/chatero-reader-host\.mjs"><\/script>/);
});

test("PDF documents route to the loopback-served upstream Reader page whose host relays keys and context", async () => {
  const [providers, host, readerPage, readerBundle] = await Promise.all([
    import("../extensions/chatero-zotero/evidence-editors.cjs"),
    readFile(join(extensionRoot, "media", "zotero-reader", "chatero-reader-host.mjs"), "utf8"),
    readFile(join(extensionRoot, "media", "zotero-reader", "chatero-reader.html"), "utf8"),
    readFile(join(extensionRoot, "media", "zotero-reader", "reader.js"), "utf8"),
  ]);
  const rendered = [];
  const workflow = {
    annotations: [],
    async load() { return { annotations: [], attachment, state: { attachmentKey: "PDF00001", contentType: "application/pdf", libraryId: 7, pageIndex: 4, version: 3 } }; },
    async updateLocation(value) { return { ...value, version: 3 }; },
  };
  const fileUri = value => ({ authority: "", fsPath: value, path: value, scheme: "file", value, toString: () => `file://${value}` });
  const readerServer = fakeReaderServer();
  const provider = new providers.PdfEditorProvider({
    createReaderWorkflow: () => workflow,
    extensionUri: fileUri("/extension"),
    fromUpstreamReaderAnnotation: () => { throw new Error("not reached"); },
    getModel: () => ({ ready: true }),
    materializePdf: async () => ({ path: "/tmp/private/document.pdf", async dispose() {} }),
    readerLocationFromViewState: (_contentType, state) => ({ pageIndex: state.pageIndex }),
    readerServer,
    registry: { release() {} },
    renderUpstreamReaderHTML: value => { rendered.push(value); return "<html>PDF</html>"; },
    toUpstreamReaderAnnotation: value => value,
    vscode: {
      Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(`${base.value}/${parts.join("/")}`), parse: value => ({ scheme: value.split(":")[0] }) },
      env: { async openExternal() {} }, window: {}, workspace: {},
    },
  });
  const panel = { active: true, onDidDispose() { return { dispose() {} }; }, webview: {
    asWebviewUri: value => ({ toString: () => `vscode-webview:${value.value}` }), cspSource: "vscode-webview://unit-test",
    onDidReceiveMessage() { return { dispose() {} }; },
  } };
  await provider.resolveCustomEditor({ record: attachment, uri: { toString: () => "chatero-zotero-pdf:/7/PDF00001/paper.chatero-zotero-pdf" } }, panel);

  assert.equal(panel.webview.html, "<html>PDF</html>");
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].readerType, "pdf");
  assert.deepEqual(readerServer.requests, [{ contentType: "application/pdf", path: "/tmp/private/document.pdf" }]);
  assert.equal(rendered[0].documentUri, "http://127.0.0.1:44100/token/doc/LEASE00001");
  assert.equal(rendered[0].frameOrigin, "http://127.0.0.1:44100");
  assert.equal(rendered[0].readerPageUri, "http://127.0.0.1:44100/token/reader/chatero-reader.html");
  assert.equal(rendered[0].attachment, attachment);
  assert.deepEqual(rendered[0].state, { pageIndex: 4 });

  assert.match(readerPage, /<script src="\.\/reader\.js"><\/script>/);
  assert.match(readerPage, /script-src 'self'; worker-src 'self' blob:/);
  assert.match(host, /window\.parent\.postMessage\(\{ type: "chatero-reader-ready" \}, "\*"\)/);
  assert.match(host, /event\.data\?\.type !== "chatero-reader-init"/);
  assert.match(host, /const parentOrigin = init\.origin/);
  assert.match(host, /window\.parent\.postMessage\(message, parentOrigin\)/);
  assert.match(host, /const response = await fetch\(documentUri\)/);
  assert.match(host, /new Uint8Array\(await response\.arrayBuffer\(\)\)/);
  assert.match(host, /window\.createReader\(\{/);
  assert.match(host, /data: \{ buf: data \}/);
  assert.match(host, /scale: "page-width"/);
  assert.match(host, /scrollMode: 0/);
  assert.match(host, /pageIndex: Number\.isSafeInteger\(state\?\.pageIndex\) && state\.pageIndex >= 0 \? state\.pageIndex : 0/);
  assert.doesNotMatch(host, /workerSrc|createObjectURL|pdf\.worker\.mjs/);
  assert.match(host, /const KEY_FIELDS = \["altKey", "code", "ctrlKey", "key", "keyCode", "metaKey", "repeat", "shiftKey"\]/);
  assert.match(host, /function wireKeyRelay\(doc, beforeKeydown = null\) \{/);
  assert.match(host, /if \(!event\.isTrusted\) return;/);
  assert.match(host, /const message = \{ eventType, type: "chatero-reader-key" \}/);
  assert.match(host, /wireKeyRelay\(candidate\.document, onKeydown\);/);
  assert.match(host, /wireKeyRelay\(document, pdfContext\?\.onKeydown \?\? null\);/);
  assert.match(host, /onRotatePages\(\) \{ send\(\{ feature: "page rotation", type: "reader-unsupported" \}\); \}/);
  assert.match(host, /document\.querySelectorAll\("#split-view iframe"\)/);
  assert.match(host, /new MutationObserver/);
  assert.doesNotMatch(host, /observer\.disconnect\(\)/);
  assert.match(host, /const wiredFrames = new WeakSet\(\);/);
  assert.match(host, /page\.getTextContent\(\)/);
  assert.match(host, /const PAGE_TEXT_MAX_BYTES = 128 \* 1024/);
  assert.match(host, /const SELECTED_TEXT_MAX_BYTES = 32 \* 1024/);
  assert.match(host, /const PAGE_LABEL_MAX_BYTES = 256/);
  assert.match(host, /const pdfContext = type === "pdf" \? createPdfContext\(\) : null;/);
  assert.doesNotMatch(host, /acquireVsCodeApi|libraryId|attachmentKey/);
  assert.doesNotMatch(host, /fetch\(["']https?:|openExternal/);
  for (const behavior of ["getOutline", "getDestination", "convertToPdfPoint", "print", "sortIndex", "underline", "image", "ink"]) {
    assert.ok(readerBundle.includes(behavior), `packaged Reader omits ${behavior}`);
  }
});

test("PDF Reader saves and deletes use exact Core versions and reject the retired annotation protocol", async () => {
  const [providers, bridge] = await Promise.all([
    import("../extensions/chatero-zotero/evidence-editors.cjs"),
    import("../extensions/chatero-zotero/upstream-reader-bridge.mjs"),
  ]);
  const existing = Object.freeze({ annotationKey: "ANN00001", color: "#ffd400", comment: "Original", libraryId: 7, pageLabel: "3", positionJson: '{"pageIndex":2,"rects":[[1,2,3,4]]}', sortIndex: "00002|000001|00000", tags: [], text: "Quote", type: "highlight", version: 3 });
  const created = Object.freeze({ ...existing, annotationKey: "ANNNEW01", comment: "Created", type: "underline", version: 1 });
  const batches = [];
  const errors = [];
  const warnings = [];
  const workflow = {
    annotations: [existing],
    async load() { return { annotations: this.annotations, attachment, state: { attachmentKey: "PDF00001", contentType: "application/pdf", libraryId: 7, pageIndex: 2, version: 4 } }; },
    async applyAnnotationChanges(changes) {
      batches.push(changes);
      if (changes.some(value => value.action === "create")) this.annotations = [existing, created];
      return { created: changes.flatMap((value, index) => value.action === "create" ? [{ changeIndex: index, annotation: created }] : []), replayed: false, results: [], revision: batches.length };
    },
  };
  const fileUri = value => ({ authority: "", fsPath: value, path: value, scheme: "file", value, toString: () => `file://${value}` });
  let rendered;
  const provider = new providers.PdfEditorProvider({
    createReaderWorkflow: () => workflow,
    extensionUri: fileUri("/extension"),
    fromUpstreamReaderAnnotation: bridge.fromUpstreamReaderAnnotation,
    getModel: () => ({ ready: true }),
    materializePdf: async () => ({ path: "/tmp/private/document.pdf", async dispose() {} }),
    onReaderError: error => errors.push(error.message),
    readerLocationFromViewState: bridge.readerLocationFromViewState,
    readerServer: fakeReaderServer(),
    registry: { release() {} },
    renderUpstreamReaderHTML: value => { rendered = value; return "<html>PDF</html>"; },
    toUpstreamReaderAnnotation: bridge.toUpstreamReaderAnnotation,
    vscode: {
      Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(`${base.value}/${parts.join("/")}`), parse: value => ({ scheme: value.split(":")[0] }) },
      env: {}, window: { showWarningMessage: async value => { warnings.push(value); } }, workspace: {},
    },
  });
  let receiveMessage;
  const posted = [];
  const panel = { active: true, onDidDispose() { return { dispose() {} }; }, webview: {
    asWebviewUri: value => ({ toString: () => `vscode-webview:${value.value}` }), cspSource: "vscode-webview://unit-test",
    onDidReceiveMessage(listener) { receiveMessage = listener; return { dispose() {} }; },
    async postMessage(value) { posted.push(value); },
  } };
  await provider.resolveCustomEditor({ record: attachment, uri: { toString: () => "chatero-zotero-pdf:/7/PDF00001/paper.chatero-zotero-pdf" } }, panel);

  assert.equal(rendered.readerType, "pdf");
  assert.deepEqual(rendered.annotations.map(value => [value.id, value.position]), [["ANN00001", { pageIndex: 2, rects: [[1, 2, 3, 4]] }]]);

  const upstream = (id, overrides) => ({ color: "#ffd400", comment: "Original", id, pageLabel: "3", position: { pageIndex: 2, rects: [[1, 2, 3, 4]] }, sortIndex: "00002|000001|00000", tags: [], text: "Quote", type: "highlight", ...overrides });
  await receiveMessage({ type: "upstream-reader-save", annotations: [upstream("ANN00001")], sequence: 1 });
  assert.deepEqual(batches, []);
  assert.deepEqual(posted.at(-1), { sequence: 1, type: "upstream-reader-saved" });

  await receiveMessage({ type: "upstream-reader-save", annotations: [
    upstream("temp-1", { comment: "Created", type: "underline" }),
    upstream("ANN00001", { color: "#2ea8e5", comment: "Reviewed", tags: [{ name: "reviewed" }] }),
  ], sequence: 2 });
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0][0], { action: "create", color: "#ffd400", comment: "Created", pageLabel: "3", positionJson: '{"pageIndex":2,"rects":[[1,2,3,4]]}', sortIndex: "00002|000001|00000", tags: [], text: "Quote", type: "underline" });
  assert.deepEqual(batches[0][1], { annotationKey: "ANN00001", color: "#2ea8e5", comment: "Reviewed", expectedVersion: 3, tags: ["reviewed"] });

  await receiveMessage({ type: "upstream-reader-delete", ids: ["temp-1"], sequence: 3 });
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[1], [{ action: "trash", annotationKey: "ANNNEW01", expectedVersion: 1 }]);
  assert.deepEqual(posted.map(value => [value.type, value.sequence]), [
    ["upstream-reader-saved", 1], ["upstream-reader-saved", 2], ["upstream-reader-saved", 3],
  ]);

  // The reader repeats deletes for ids Core never stored; they acknowledge
  // without a second trash of the same annotation.
  await receiveMessage({ type: "upstream-reader-delete", ids: ["temp-1"], sequence: 4 });
  assert.equal(batches.length, 2);
  assert.deepEqual(posted.at(-1), { sequence: 4, type: "upstream-reader-saved" });

  await receiveMessage({ type: "reader-unsupported", feature: "page rotation" });
  assert.deepEqual(warnings, ["Chatero does not support page rotation yet."]);
  await assert.rejects(receiveMessage({ type: "reader-unsupported", feature: "x".repeat(65) }), /Reader capability message is invalid/);
  await assert.rejects(receiveMessage({ type: "reader-unsupported" }), /Reader capability message is invalid/);
  assert.equal(warnings.length, 1);

  await assert.rejects(receiveMessage({ type: "upstream-reader-save", annotations: [], sequence: 5, extra: true }), /Upstream Reader save message is invalid/);
  for (const type of ["annotation-create", "annotation-update", "annotation-delete", "annotation-undo", "reader-state", "pdf-export"]) {
    await assert.rejects(receiveMessage({ type }), /PDF editor message type is invalid/);
  }
  assert.equal(batches.length, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, [
    "Reader capability message is invalid",
    "Reader capability message is invalid",
    "Upstream Reader save message is invalid",
    ...["annotation-create", "annotation-update", "annotation-delete", "annotation-undo", "reader-state", "pdf-export"].map(() => "PDF editor message type is invalid"),
  ]);
});

test("PDF view state maps to exact page locations and repeated pages commit once", async () => {
  const [providers, { readerLocationFromViewState }] = await Promise.all([
    import("../extensions/chatero-zotero/evidence-editors.cjs"),
    import("../extensions/chatero-zotero/upstream-reader-bridge.mjs"),
  ]);
  assert.deepEqual(readerLocationFromViewState("application/pdf", { pageIndex: 3 }), { pageIndex: 3 });
  assert.deepEqual(readerLocationFromViewState("application/pdf", { pageIndex: 3, scale: "page-width", scrollMode: 0 }), { pageIndex: 3 });
  assert.equal(Object.isFrozen(readerLocationFromViewState("application/pdf", { pageIndex: 0 })), true);
  for (const state of [{ pageIndex: -1 }, { pageIndex: 1.5 }, { pageIndex: "3" }, { pageIndex: Number.NaN }, {}]) {
    assert.throws(() => readerLocationFromViewState("application/pdf", state), /Reader page location is invalid/);
  }

  const locations = [];
  const workflow = {
    annotations: [],
    async load() { return { annotations: [], attachment, state: { attachmentKey: "PDF00001", contentType: "application/pdf", libraryId: 7, pageIndex: 6, version: 4 } }; },
    async updateLocation(value) { locations.push(value); return { ...value, version: 5 }; },
  };
  const fileUri = value => ({ authority: "", fsPath: value, path: value, scheme: "file", value, toString: () => `file://${value}` });
  const provider = new providers.PdfEditorProvider({
    createReaderWorkflow: () => workflow,
    extensionUri: fileUri("/extension"),
    fromUpstreamReaderAnnotation: () => { throw new Error("not reached"); },
    getModel: () => ({ ready: true }),
    materializePdf: async () => ({ path: "/tmp/private/document.pdf", async dispose() {} }),
    readerLocationFromViewState,
    readerServer: fakeReaderServer(),
    registry: { release() {} },
    renderUpstreamReaderHTML: () => "<html>PDF</html>",
    toUpstreamReaderAnnotation: value => value,
    vscode: { Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(`${base.value}/${parts.join("/")}`), parse: value => ({ scheme: value.split(":")[0] }) }, env: {}, window: {}, workspace: {} },
  });
  let receiveMessage;
  const panel = { active: true, onDidDispose() { return { dispose() {} }; }, webview: {
    asWebviewUri: value => ({ toString: () => `vscode-webview:${value.value}` }), cspSource: "vscode-webview://unit-test",
    onDidReceiveMessage(listener) { receiveMessage = listener; return { dispose() {} }; },
    async postMessage() {},
  } };
  await provider.resolveCustomEditor({ record: attachment, uri: { toString: () => "chatero-zotero-pdf:/7/PDF00001/paper.chatero-zotero-pdf" } }, panel);

  // The reader reports the restored page as its first view state, and the
  // seeded location keeps that echo from rewriting the same page in Core.
  await receiveMessage({ type: "upstream-reader-state", state: { pageIndex: 6, scale: "page-width" } });
  assert.deepEqual(locations, []);
  await receiveMessage({ type: "upstream-reader-state", state: { pageIndex: 3, scale: "page-width" } });
  await receiveMessage({ type: "upstream-reader-state", state: { pageIndex: 3, scrollMode: 0 } });
  assert.deepEqual(locations, [{ pageIndex: 3 }]);
  await receiveMessage({ type: "upstream-reader-state", state: { pageIndex: 6 } });
  assert.deepEqual(locations, [{ pageIndex: 3 }, { pageIndex: 6 }]);
  await assert.rejects(receiveMessage({ type: "upstream-reader-state", state: { pageIndex: -1 } }), /Reader page location is invalid/);
  await assert.rejects(receiveMessage({ type: "upstream-reader-state", state: { pageIndex: 4 }, sequence: 1 }), /Upstream Reader state message is invalid/);
  assert.deepEqual(locations, [{ pageIndex: 3 }, { pageIndex: 6 }]);
});

test("PDF provider grants no webview resource roots and serves the document only through its lease", async () => {
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
  const readerServer = fakeReaderServer();
  const provider = new providers.PdfEditorProvider({
    extensionUri: fileUri("/extension"),
    fromUpstreamReaderAnnotation: () => { throw new Error("not reached"); },
    getModel: () => ({ annotations: async params => {
      assert.deepEqual(params, { attachmentKey: "PDF00001", libraryId: 7 });
      return [];
    } }),
    readerLocationFromViewState: () => { throw new Error("not reached"); },
    readerServer,
    registry,
    materializePdf: async () => ({ path: "/tmp/private/materialized-paper.pdf", async dispose() {} }),
    renderUpstreamReaderHTML: value => { rendering = value; return "<html>PDF</html>"; },
    toUpstreamReaderAnnotation: value => value,
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
  assert.deepEqual(panel.webview.options, { enableScripts: true, localResourceRoots: [] });
  assert.deepEqual(exposedUris, []);
  assert.deepEqual(readerServer.requests, [{ contentType: "application/pdf", path: "/tmp/private/materialized-paper.pdf" }]);
  assert.equal(rendering.readerType, "pdf");
  assert.equal(rendering.documentUri, "http://127.0.0.1:44100/token/doc/LEASE00001");
  assert.equal(rendering.readerPageUri, "http://127.0.0.1:44100/token/reader/chatero-reader.html");
  assert.equal(new URL(rendering.documentUri).origin, rendering.frameOrigin);
  assert.equal(new URL(rendering.readerPageUri).origin, rendering.frameOrigin);
  assert.equal(Object.hasOwn(rendering, "cspSource"), false);
  assert.doesNotMatch(JSON.stringify(rendering.documentUri), /materialized-paper|tmp/);
});

test("reader server serves the packaged reader and leased document from loopback and rejects everything else", async () => {
  const { ReaderServer } = await import("../extensions/chatero-zotero/reader-server.cjs");
  const mediaRoot = join(extensionRoot, "media", "zotero-reader");
  const documentPath = join(mediaRoot, "chatero-reader.html");
  const server = new ReaderServer({ mediaRoot });
  try {
    const lease = await server.lease({ contentType: "application/pdf", path: documentPath });
    assert.equal(Object.isFrozen(lease), true);
    assert.equal(new URL(lease.origin).hostname, "127.0.0.1");
    assert.equal(new URL(lease.readerPageUrl).origin, lease.origin);
    assert.equal(new URL(lease.documentUrl).origin, lease.origin);
    const token = new URL(lease.readerPageUrl).pathname.split("/")[1];
    assert.match(token, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(new URL(lease.readerPageUrl).pathname, `/${token}/reader/chatero-reader.html`);

    const page = await fetch(lease.readerPageUrl);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("cache-control"), "private, max-age=0, must-revalidate");
    assert.match(await page.text(), /id="reader-error"/);
    const host = await fetch(`${lease.origin}/${token}/reader/chatero-reader-host.mjs`);
    assert.equal(host.status, 200);
    assert.equal(host.headers.get("content-type"), "text/javascript; charset=utf-8");
    const documentResponse = await fetch(lease.documentUrl);
    assert.equal(documentResponse.status, 200);
    assert.equal(documentResponse.headers.get("content-type"), "application/octet-stream");
    assert.equal(documentResponse.headers.get("content-disposition"), "attachment");
    assert.equal(documentResponse.headers.get("content-security-policy"), "sandbox");

    for (const url of [
      `${lease.origin}/${token}/reader/../../../package.json`,
      `${lease.origin}/${token}/reader/%2e%2e%2f%2e%2e%2fpackage.json`,
      `${lease.origin}/${token}/reader/`,
      `${lease.origin}/${token}/reader`,
      `${lease.origin}/${token}/doc/${"A".repeat(24)}`,
      `${lease.origin}/${token}/secrets/chatero-reader.html`,
      `${lease.origin}/AAAAAAAAAAAAAAAAAAAAAAAA/reader/chatero-reader.html`,
      lease.documentUrl.replace(`/${token}/`, "/forged-token/"),
    ]) {
      assert.equal((await fetch(url)).status, 404, `expected 404 for ${url}`);
    }
    for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
      assert.equal((await fetch(lease.readerPageUrl, { method })).status, 404, `expected 404 for ${method}`);
    }

    lease.dispose();
    assert.equal((await fetch(lease.documentUrl)).status, 404);
    assert.equal((await fetch(lease.readerPageUrl)).status, 200);
    lease.dispose();

    const second = await server.lease({ contentType: "application/pdf", path: documentPath });
    assert.equal(second.origin, lease.origin);
    assert.notEqual(second.documentUrl, lease.documentUrl);
    for (const request of [{ contentType: "application/pdf" }, { path: documentPath }, { contentType: "", path: documentPath }]) {
      await assert.rejects(server.lease(request), /Reader server lease request is invalid/);
    }
  }
  finally {
    server.dispose();
  }
  assert.throws(() => new ReaderServer({ mediaRoot: "" }), /Reader server media root is invalid/);
});

test("reader server never follows a symbolic link out of the packaged reader root", async () => {
  const { ReaderServer } = await import("../extensions/chatero-zotero/reader-server.cjs");
  const mediaRoot = await mkdtemp(join(tmpdir(), "chatero-reader-server-"));
  try {
    await writeFile(join(mediaRoot, "chatero-reader.html"), "<!doctype html><title>fixture</title>\n");
    await symlink(join(root, "package.json"), join(mediaRoot, "escape.json"));
    const server = new ReaderServer({ mediaRoot });
    try {
      const lease = await server.lease({ contentType: "application/pdf", path: join(mediaRoot, "chatero-reader.html") });
      const token = new URL(lease.readerPageUrl).pathname.split("/")[1];
      assert.equal((await fetch(lease.readerPageUrl)).status, 200);
      assert.equal((await fetch(`${lease.origin}/${token}/reader/escape.json`)).status, 404);
      assert.equal((await fetch(`${lease.origin}/${token}/reader/missing.html`)).status, 404);
    }
    finally {
      server.dispose();
    }
  }
  finally {
    await rm(mediaRoot, { force: true, recursive: true });
  }
});

test("PDF editor messages use the host document identity and never attach on passive updates", async () => {
  const providers = await import("../extensions/chatero-zotero/evidence-editors.cjs");
  const panelNonce = "AAAAAAAAAAAAAAAAAAAAAAAA";
  const trustedAnnotations = Object.freeze([]);
  const brokerCalls = [];
  const attached = [];
  let releaseAttachment;
  const attachmentBarrier = new Promise(resolve => { releaseAttachment = resolve; });
  let disposed = 0;
  const snapshot = Object.freeze({
    kind: "pdf-selection",
    libraryId: 7,
    attachmentKey: "PDF00001",
    title: "Paper",
    pageIndex: 6,
    pageLabel: "7",
    selectedText: "bounded evidence",
    pageText: "whole page",
    annotations: Object.freeze([]),
    capturedAt: "2026-08-11T12:00:00.000Z",
  });
  const pageSnapshot = Object.freeze({ ...snapshot, kind: "pdf-page", selectedText: "" });
  const activations = [];
  const contextBroker = {
    activate(uri, nonceValue, active) {
      activations.push([uri, nonceValue, active]);
    },
    open(uri, record, nonceValue, trustedAnnotations) {
      brokerCalls.push(["open", uri, record, nonceValue, trustedAnnotations]);
      return { dispose() { disposed += 1; } };
    },
    update(uri, record, nonceValue, message) {
      brokerCalls.push(["update", uri, record, nonceValue, message]);
      return message.selectedText ? snapshot : pageSnapshot;
    },
  };
  const fileUri = value => ({ authority: "", fsPath: value, path: value, scheme: "file", value, toString: () => `file://${value}` });
  const activeReaders = [];
  const readerServer = fakeReaderServer();
  const provider = new providers.PdfEditorProvider({
    attachPdfContext: async value => { attached.push(value); await attachmentBarrier; },
    contextBroker,
    extensionUri: fileUri("/extension"),
    fromUpstreamReaderAnnotation: () => { throw new Error("not reached"); },
    getModel: () => ({ annotations: async () => trustedAnnotations }),
    makePanelNonce: () => panelNonce,
    materializePdf: async () => ({ path: "/tmp/private/materialized-paper.pdf", async dispose() {} }),
    onActiveReaderChanged: value => { activeReaders.push(value); },
    readerLocationFromViewState: () => { throw new Error("not reached"); },
    readerServer,
    registry: { release: () => true },
    renderUpstreamReaderHTML: value => { brokerCalls.push(["render", value]); return "<html>PDF</html>"; },
    toUpstreamReaderAnnotation: value => value,
    vscode: { Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(`${base.value}/${parts.join("/")}`) } },
  });
  const document = { record: attachment, uri: { toString: () => "chatero-zotero-pdf:/7/PDF00001/paper.chatero-zotero-pdf" } };
  let receiveMessage;
  let disposePanel;
  let changeViewState;
  const panel = {
    active: true,
    onDidChangeViewState(listener) { changeViewState = listener; return { dispose() {} }; },
    onDidDispose(listener) { disposePanel = listener; return { dispose() {} }; },
    webview: {
      asWebviewUri: value => ({ toString: () => `vscode-webview:${value.value}` }),
      cspSource: "vscode-webview://unit-test",
      onDidReceiveMessage(listener) { receiveMessage = listener; return { dispose() {} }; },
    },
  };

  await provider.resolveCustomEditor(document, panel);
  assert.equal(brokerCalls[0][0], "open");
  assert.equal(brokerCalls[0][1], document.uri);
  assert.equal(brokerCalls[0][2], document.record);
  assert.equal(brokerCalls[0][3], panelNonce);
  assert.equal(brokerCalls[0][4], trustedAnnotations);
  assert.equal(brokerCalls[1][1].panelNonce, panelNonce);
  assert.equal(brokerCalls[1][1].readerType, "pdf");
  assert.deepEqual(activations, [[document.uri, panelNonce, true]]);
  assert.equal(activeReaders.length, 1);
  assert.equal(activeReaders[0].record, attachment);
  assert.equal(activeReaders[0].file.fsPath, "/tmp/private/materialized-paper.pdf");
  assert.equal(activeReaders[0].file.scheme, "file");

  const update = {
    type: "pdf-context",
    panelNonce,
    sequence: 1,
    pageIndex: 6,
    pageLabel: "7",
    pageText: "whole page",
    selectedText: "bounded evidence",
  };
  await receiveMessage(update);
  assert.equal(attached.length, 0);
  assert.deepEqual(brokerCalls.at(-1), ["update", document.uri, document.record, panelNonce, update]);
  changeViewState({ webviewPanel: { active: false } });
  assert.equal(attached.length, 0);
  assert.deepEqual(activations, [[document.uri, panelNonce, true], [document.uri, panelNonce, false]]);
  assert.equal(activeReaders.at(-1), null);

  const firstAttach = receiveMessage({ type: "pdf-context-attach", panelNonce, sequence: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const replayAttach = receiveMessage({ type: "pdf-context-attach", panelNonce, sequence: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const attachmentCountBeforeRelease = attached.length;
  releaseAttachment();
  const [firstResult, replayResult] = await Promise.allSettled([firstAttach, replayAttach]);
  assert.equal(attachmentCountBeforeRelease, 1);
  assert.equal(firstResult.status, "fulfilled");
  assert.equal(replayResult.status, "rejected");
  assert.deepEqual(attached, [snapshot]);
  await assert.rejects(receiveMessage({ type: "pdf-context-attach", panelNonce, sequence: 2 }), /sequence/);

  // Without a selection the broker keeps the current page, and that snapshot
  // attaches too -- the chord matches chatero.zotero.addActiveContextToChat.
  await receiveMessage({ ...update, sequence: 2, selectedText: "" });
  await receiveMessage({ type: "pdf-context-attach", panelNonce, sequence: 2 });
  assert.deepEqual(attached, [snapshot, pageSnapshot]);
  await assert.rejects(receiveMessage({ type: "pdf-context-attach", panelNonce, sequence: 3 }), /sequence/);
  assert.deepEqual(attached, [snapshot, pageSnapshot]);

  disposePanel();
  assert.equal(disposed, 1);
  assert.deepEqual(readerServer.disposals, ["LEASE00001"]);
  assert.equal(activeReaders.at(-1), null);
});

test("PDF context setup rolls back its broker lease and listeners when editor rendering fails", async () => {
  const providers = await import("../extensions/chatero-zotero/evidence-editors.cjs");
  const fileUri = value => ({ authority: "", fsPath: value, path: value, scheme: "file", value, toString: () => `file://${value}` });
  for (const failure of ["render", "assignment", "lease"]) {
    let leaseDisposals = 0;
    let listenerDisposals = 0;
    let materializedDisposals = 0;
    const activeReaders = [];
    const readerServer = fakeReaderServer();
    const provider = new providers.PdfEditorProvider({
      attachPdfContext: async () => {},
      contextBroker: {
        activate() {},
        open() { return { dispose() { leaseDisposals += 1; } }; },
        update() { throw new Error("not reached"); },
      },
      extensionUri: fileUri("/extension"),
      fromUpstreamReaderAnnotation: () => { throw new Error("not reached"); },
      getModel: () => ({ annotations: async () => Object.freeze([]) }),
      makePanelNonce: () => "AAAAAAAAAAAAAAAAAAAAAAAA",
      materializePdf: async () => ({ path: "/tmp/private/materialized-paper.pdf", async dispose() { materializedDisposals += 1; } }),
      onActiveReaderChanged: value => { activeReaders.push(value); },
      readerLocationFromViewState: () => { throw new Error("not reached"); },
      readerServer: failure === "lease"
        ? { lease: async () => { throw new Error("lease failed"); } }
        : readerServer,
      registry: { release: () => true },
      renderUpstreamReaderHTML: () => {
        if (failure === "render") throw new Error("render failed");
        return "<html>PDF</html>";
      },
      toUpstreamReaderAnnotation: value => value,
      vscode: { Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(`${base.value}/${parts.join("/")}`) } },
    });
    const webview = {
      asWebviewUri: value => ({ toString: () => `vscode-webview:${value.value}` }),
      cspSource: "vscode-webview://unit-test",
      onDidReceiveMessage() { return { dispose() { listenerDisposals += 1; } }; },
    };
    if (failure === "assignment") {
      Object.defineProperty(webview, "html", { set() { throw new Error("assignment failed"); } });
    }
    const panel = {
      active: true,
      onDidChangeViewState() { return { dispose() { listenerDisposals += 1; } }; },
      onDidDispose() { return { dispose() { listenerDisposals += 1; } }; },
      webview,
    };
    await assert.rejects(provider.resolveCustomEditor({ record: attachment, uri: { toString: () => "chatero-zotero-pdf:/7/PDF00001/paper.chatero-zotero-pdf" } }, panel), new RegExp(`${failure} failed`));
    await new Promise(resolve => setImmediate(resolve));
    if (failure === "lease") {
      // The lease is taken before any listener or broker lease exists, so the
      // only thing to roll back is the materialized copy.
      assert.equal(leaseDisposals, 0);
      assert.equal(listenerDisposals, 0);
      assert.deepEqual(activeReaders, []);
    }
    else {
      assert.equal(leaseDisposals, 1);
      assert.equal(listenerDisposals, 3);
      assert.deepEqual(readerServer.disposals, ["LEASE00001"]);
      assert.equal(activeReaders.length, 2);
      assert.equal(activeReaders[0].file.fsPath, "/tmp/private/materialized-paper.pdf");
      assert.equal(activeReaders[0].record, attachment);
      assert.equal(activeReaders[1], null);
    }
    assert.equal(materializedDisposals, 1);
  }
});
