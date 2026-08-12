import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createLivePreviewHtml } from "../extensions/chatero-documentation/live-preview-html.mjs";

const require = createRequire(import.meta.url);
const providerPath = fileURLToPath(new URL("../extensions/chatero-documentation/live-preview-provider.cjs", import.meta.url));

function loadProvider() {
  delete require.cache[require.resolve(providerPath)];
  return require(providerPath);
}

class TestUri {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
  static joinPath(base, ...parts) {
    return new TestUri(`${base.toString().replace(/\/$/u, "")}/${parts.join("/")}`);
  }
}

function createPanel(cspSource = "vscode-webview-resource:") {
  const webview = {
    cspSource,
    html: "",
    options: undefined,
    asWebviewUri(value) { return new TestUri(`vscode-webview-resource:${value}`); },
  };
  return { webview };
}

function createVscode({ livePreview = true } = {}) {
  const commandCalls = [];
  const providerCalls = [];
  const errorMessages = [];
  return {
    commandCalls,
    errorMessages,
    providerCalls,
    vscode: {
      Position: class Position {},
      Range: class Range {},
      Uri: TestUri,
      WorkspaceEdit: class WorkspaceEdit {},
      commands: {
        async executeCommand(...args) { commandCalls.push(args); },
      },
      window: {
        registerCustomEditorProvider(...args) {
          providerCalls.push(args);
          return { dispose() {} };
        },
        async showErrorMessage(message) { errorMessages.push(message); },
      },
      workspace: {
        getConfiguration(section) {
          assert.equal(section, "chatero.documentation");
          return { get: (key, fallback) => key === "livePreview" ? livePreview : fallback };
        },
      },
    },
  };
}

test("contributes one optional Documentation QMD editor and preference", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extensions/chatero-documentation/package.json", import.meta.url), "utf8"));
  const editor = manifest.contributes.customEditors.find(
    value => value.viewType === "chatero.documentation.livePreview",
  );
  assert.deepEqual(editor, {
    viewType: "chatero.documentation.livePreview",
    displayName: "Chatero Live Preview",
    selector: [{ filenamePattern: "**/documentation/**/*.qmd" }],
    priority: "option",
  });
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.equal(manifest.contributes.configuration.properties["chatero.documentation.livePreview"].default, true);
  assert.ok(manifest.activationEvents.includes("onCustomEditor:chatero.documentation.livePreview"));
  assert.ok(manifest.contributes.commands.some(command => command.command === "chatero.documentation.open"));
});

test("creates fresh 144-bit nonces and exact restrictive HTML", () => {
  const { createLivePreviewNonce } = loadProvider();
  const first = createLivePreviewNonce(size => {
    assert.equal(size, 18);
    return Buffer.alloc(size, 1);
  });
  const second = createLivePreviewNonce(size => Buffer.alloc(size, 2));
  assert.match(first, /^[A-Za-z0-9_-]{24}$/);
  assert.match(second, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(first, second);

  const panel = createPanel();
  const html = createLivePreviewHtml({
    webview: panel.webview,
    scriptUri: new TestUri("vscode-webview-resource:/live-preview.js"),
    styleUri: new TestUri("vscode-webview-resource:/live-preview.css"),
    nonce: first,
  });
  const csp = `default-src 'none'; script-src 'nonce-${first}'; style-src ${panel.webview.cspSource} 'nonce-${first}'; font-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource};`;
  assert.match(html, new RegExp(`content="${csp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(html, new RegExp(`<script nonce="${first}" src="vscode-webview-resource:/live-preview\\.js"></script>`));
  assert.match(html, /<link rel="stylesheet" href="vscode-webview-resource:\/live-preview\.css">/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|\bdata:|\bblob:|https?:|on(?:click|load)=|style="|<iframe|<object|<embed/i);
  assert.equal((html.match(new RegExp(first, "g")) ?? []).length, 3);

  const currentDesktopCsp = createLivePreviewHtml({
    webview: { cspSource: "https://*.vscode-cdn.net" },
    scriptUri: "https://file+.vscode-resource.vscode-cdn.net/extension/live-preview.js",
    styleUri: "https://file+.vscode-resource.vscode-cdn.net/extension/live-preview.css",
    nonce: first,
  });
  assert.match(currentDesktopCsp, /style-src https:\/\/\*\.vscode-cdn\.net/);
  assert.throws(() => createLivePreviewHtml({
    webview: { cspSource: "https://*.vscode-cdn.net" },
    scriptUri: "https://evil.example/live-preview.js",
    styleUri: "https://file+.vscode-resource.vscode-cdn.net/extension/live-preview.css",
    nonce: first,
  }), /outside/);
});

test("provider confines resources and passes one unique nonce to each shared-bridge attachment", async () => {
  const { LivePreviewProvider } = loadProvider();
  const harness = createVscode();
  const context = { extensionUri: new TestUri("file:/extension"), subscriptions: [] };
  const attachments = [];
  let nonceSequence = 0;
  const provider = new LivePreviewProvider({
    vscode: harness.vscode,
    context,
    bridgeRegistry: {
      attach(document, panel, options) {
        attachments.push({ document, panel, options });
        return { dispose() {} };
      },
    },
    randomBytes(size) { return Buffer.alloc(size, ++nonceSequence); },
  });
  const document = { uri: new TestUri("file:/workspace/documentation/page.qmd"), getText: () => "# Page\n" };
  const first = createPanel();
  const second = createPanel();
  await provider.resolveCustomTextEditor(document, first, { isCancellationRequested: false });
  await provider.resolveCustomTextEditor(document, second, { isCancellationRequested: false });

  assert.equal(attachments.length, 2);
  assert.notEqual(attachments[0].options.cspNonce, attachments[1].options.cspNonce);
  for (const [index, panel] of [first, second].entries()) {
    const mediaRoot = panel.webview.options.localResourceRoots[0];
    assert.equal(mediaRoot.toString(), "file:/extension/media/documentation-webview");
    assert.deepEqual(panel.webview.options, { enableScripts: true, localResourceRoots: [mediaRoot] });
    const attachedNonce = attachments[index].options.cspNonce;
    assert.match(panel.webview.html, new RegExp(`script-src 'nonce-${attachedNonce}'`));
    assert.match(panel.webview.html, new RegExp(`style-src vscode-webview-resource: 'nonce-${attachedNonce}'`));
    assert.match(panel.webview.html, /font-src vscode-webview-resource:; img-src vscode-webview-resource:;/u);
    assert.match(panel.webview.html, new RegExp(`<script nonce="${attachedNonce}"`));
  }
});

test("provider grants each panel only its own derived image session root", async () => {
  const { LivePreviewProvider } = loadProvider();
  const harness = createVscode();
  const attachments = [];
  const roots = [];
  const provider = new LivePreviewProvider({
    vscode: harness.vscode,
    context: { extensionUri: new TestUri("file:/extension"), storageUri: new TestUri("file:/storage") },
    bridgeRegistry: {
      attach(document, panel, options) { attachments.push({ document, panel, options }); return { dispose() {} }; },
    },
    randomBytes: size => Buffer.alloc(size, 7),
    async imageResolverFactory({ sessionId }) {
      const rootUri = new TestUri(`file:/storage/live-preview-images/${sessionId}`);
      roots.push(rootUri);
      return { rootUri, async resolve() {}, async dispose() {} };
    },
  });
  const panel = createPanel();
  const document = { uri: new TestUri("file:/workspace/documentation/page.qmd"), getText: () => "![Plot](plot.png)\n" };
  await provider.resolveCustomTextEditor(document, panel, { isCancellationRequested: false });
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].options.imageResolver.rootUri, roots[0]);
  assert.deepEqual(panel.webview.options.localResourceRoots.map(uri => uri.toString()), [
    "file:/extension/media/documentation-webview",
    roots[0].toString(),
  ]);
  assert.doesNotMatch(JSON.stringify(panel.webview.options.localResourceRoots), /workspace\/documentation/u);
});

test("registers without a multiple-editor option and routes only Chatero opens by preference", async () => {
  const { LIVE_PREVIEW_VIEW_TYPE, openDocumentation, registerLivePreview } = loadProvider();
  const enabled = createVscode({ livePreview: true });
  const context = { extensionUri: new TestUri("file:/extension"), subscriptions: [] };
  const bridgeRegistry = { attach() { return { dispose() {} }; } };
  const registrations = await registerLivePreview({ vscode: enabled.vscode, context, bridgeRegistry });
  assert.equal(registrations.length, 1);
  assert.equal(enabled.providerCalls.length, 1);
  assert.equal(enabled.providerCalls[0].length, 2);
  assert.equal(enabled.providerCalls[0][0], LIVE_PREVIEW_VIEW_TYPE);

  const target = new TestUri("file:/workspace/documentation/page.qmd");
  await openDocumentation(enabled.vscode, target);
  assert.deepEqual(enabled.commandCalls.at(-1), ["vscode.openWith", target, LIVE_PREVIEW_VIEW_TYPE]);
  const disabled = createVscode({ livePreview: false });
  await openDocumentation(disabled.vscode, target);
  assert.deepEqual(disabled.commandCalls.at(-1), ["vscode.openWith", target, "default"]);
});

test("falls back to the standard editor without truncating an oversized source", async () => {
  const { LivePreviewProvider, MAX_SNAPSHOT_SOURCE_UTF8 } = loadProvider();
  const harness = createVscode();
  let attachments = 0;
  const provider = new LivePreviewProvider({
    vscode: harness.vscode,
    context: { extensionUri: new TestUri("file:/extension"), subscriptions: [] },
    bridgeRegistry: { attach() { attachments += 1; return { dispose() {} }; } },
  });
  const target = new TestUri("file:/workspace/documentation/large.qmd");
  const source = `${"😀".repeat(Math.floor(MAX_SNAPSHOT_SOURCE_UTF8 / 4))}x`;
  const panel = createPanel();
  await provider.resolveCustomTextEditor({ uri: target, getText: () => source }, panel, { isCancellationRequested: false });
  assert.equal(attachments, 0);
  assert.equal(panel.webview.html, "");
  assert.equal(harness.errorMessages.length, 1);
  assert.match(harness.errorMessages[0], /Live Preview size limit/);
  assert.deepEqual(harness.commandCalls, [["vscode.openWith", target, "default"]]);
});

test("scopes provider resolution failures and keeps source openable", async () => {
  const { LivePreviewProvider } = loadProvider();
  const harness = createVscode();
  const provider = new LivePreviewProvider({
    vscode: harness.vscode,
    context: { extensionUri: new TestUri("file:/extension"), subscriptions: [] },
    bridgeRegistry: { attach() { throw new Error("bridge unavailable"); } },
  });
  const target = new TestUri("file:/workspace/documentation/page.qmd");
  await provider.resolveCustomTextEditor({ uri: target, getText: () => "qmd" }, createPanel(), { isCancellationRequested: false });
  assert.equal(harness.errorMessages.length, 1);
  assert.match(harness.errorMessages[0], /Live Preview.*bridge unavailable/);
  assert.deepEqual(harness.commandCalls, [["vscode.openWith", target, "default"]]);
});

test("the browser mirror binds CodeMirror-generated styles to the initialize nonce", async () => {
  const source = await readFile(new URL("../extensions/chatero-documentation/webview/live-preview-editor.mjs", import.meta.url), "utf8");
  assert.match(source, /EditorView\.cspNonce\.of\(cspNonce\)/);
});
