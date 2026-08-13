const { randomBytes: nodeRandomBytes } = require("node:crypto");

const LIVE_PREVIEW_VIEW_TYPE = "chatero.documentation.livePreview";
const MAX_SNAPSHOT_SOURCE_UTF8 = 16 * 1024 * 1024;

function createLivePreviewNonce(randomBytes = nodeRandomBytes) {
  if (typeof randomBytes !== "function") throw new TypeError("randomBytes must be a function");
  const bytes = randomBytes(18);
  if (!bytes || typeof bytes.toString !== "function" || bytes.length !== 18) {
    throw new Error("Live Preview nonce source must return exactly 18 bytes");
  }
  const value = bytes.toString("base64url");
  if (!/^[A-Za-z0-9_-]{24}$/.test(value)) throw new Error("Live Preview nonce source returned invalid bytes");
  return value;
}

async function openDocumentation(vscode, uri) {
  const preferred = vscode.workspace
    .getConfiguration("chatero.documentation")
    .get("livePreview", true) === true;
  await vscode.commands.executeCommand(
    "vscode.openWith",
    uri,
    preferred ? LIVE_PREVIEW_VIEW_TYPE : "default",
  );
}

function activeQmdTab(vscode) {
  const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
  const uri = tab?.input?.uri;
  return uri?.path?.toLowerCase?.().endsWith(".qmd") ? { uri, viewType: tab.input.viewType } : null;
}

async function toggleActiveQmdView(vscode) {
  const tab = activeQmdTab(vscode);
  const sourceUri = vscode.window.activeTextEditor?.document?.uri;
  const uri = tab?.uri ?? (sourceUri?.path?.toLowerCase?.().endsWith(".qmd") ? sourceUri : null);
  if (!uri) {
    await vscode.window.showErrorMessage("Open a QMD file before toggling its editing view.");
    return null;
  }
  const viewType = tab?.viewType === LIVE_PREVIEW_VIEW_TYPE ? "default" : LIVE_PREVIEW_VIEW_TYPE;
  await vscode.commands.executeCommand("vscode.openWith", uri, viewType);
  return viewType;
}

class LivePreviewProvider {
  constructor({ vscode, context, bridgeRegistry, randomBytes = nodeRandomBytes, createHtml, imageResolverFactory }) {
    if (!vscode?.Uri || !vscode?.commands || !vscode?.window) throw new TypeError("Live Preview provider requires VS Code APIs");
    if (!context?.extensionUri) throw new TypeError("Live Preview provider requires context.extensionUri");
    if (!bridgeRegistry || typeof bridgeRegistry.attach !== "function") throw new TypeError("Live Preview provider requires a bridge registry");
    this.vscode = vscode;
    this.context = context;
    this.bridgeRegistry = bridgeRegistry;
    this.randomBytes = randomBytes;
    this.createHtml = createHtml;
    this.imageResolverFactory = imageResolverFactory;
  }

  async fallback(document, message) {
    await this.vscode.window.showErrorMessage(message);
    await this.vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
  }

  async resolveCustomTextEditor(document, panel, token) {
    if (token?.isCancellationRequested) return;
    const source = document.getText();
    if (new TextEncoder().encode(source).byteLength > MAX_SNAPSHOT_SOURCE_UTF8) {
      await this.fallback(document, "Chatero Live Preview size limit exceeded. The page was opened in the standard Text Editor.");
      return;
    }

    let attachment;
    let imageResolver;
    try {
      const mediaRoot = this.vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "documentation-webview",
      );
      const cspNonce = createLivePreviewNonce(this.randomBytes);
      if (this.imageResolverFactory) {
        try { imageResolver = await this.imageResolverFactory({ document, panel, sessionId: cspNonce }); }
        catch { imageResolver = undefined; }
      }
      const localResourceRoots = [mediaRoot];
      if (imageResolver?.rootUri) localResourceRoots.push(imageResolver.rootUri);
      panel.webview.options = Object.freeze({
        enableScripts: true,
        localResourceRoots: Object.freeze(localResourceRoots),
      });
      const scriptUri = panel.webview.asWebviewUri(this.vscode.Uri.joinPath(mediaRoot, "live-preview.js"));
      const styleUri = panel.webview.asWebviewUri(this.vscode.Uri.joinPath(mediaRoot, "live-preview.css"));
      const htmlFactory = this.createHtml
        ?? await import("./live-preview-html.mjs").then(module => module.createLivePreviewHtml);
      attachment = this.bridgeRegistry.attach(document, panel, { cspNonce, imageResolver });
      panel.webview.html = htmlFactory({ webview: panel.webview, scriptUri, styleUri, nonce: cspNonce });
    }
    catch (error) {
      attachment?.dispose();
      if (!attachment) await imageResolver?.dispose?.();
      const detail = error instanceof Error ? error.message : String(error);
      await this.fallback(document, `Chatero Live Preview could not open this page: ${detail}`);
    }
  }
}

async function registerLivePreview({ vscode, context, bridgeRegistry, createServices }) {
  let coordinator;
  let registry = bridgeRegistry;
  const owned = [];
  if (!registry) {
    const [{ createWorkingCopyCoordinator }, { createLivePreviewBridgeRegistry }] = await Promise.all([
      import("./working-copy-coordinator.mjs"),
      import("./live-preview-bridge.mjs"),
    ]);
    coordinator = createWorkingCopyCoordinator({
      workspace: vscode.workspace,
      WorkspaceEdit: vscode.WorkspaceEdit,
      Position: vscode.Position,
      Range: vscode.Range,
    });
    registry = createLivePreviewBridgeRegistry({
      workspace: vscode.workspace,
      commands: vscode.commands,
      coordinator,
    });
    owned.push(registry, coordinator);
  }
  let servicesPromise;
  const imageResolverFactory = context.storageUri && vscode.workspace?.fs
    ? async ({ panel, sessionId }) => {
      servicesPromise ??= createServices
        ? Promise.resolve(createServices())
        : import("./documentation-services.mjs").then(module => module.createProductionDocumentationServices({ vscode, context }));
      const services = await servicesPromise;
      const { createDocumentationImageResolver } = await import("./documentation-image-resolver.mjs");
      return createDocumentationImageResolver({
        scope: services.scope,
        snapshotPassiveImage: services.snapshotPassiveImage,
        workspace: vscode.workspace,
        Uri: vscode.Uri,
        storageUri: context.storageUri,
        webview: panel.webview,
        sessionId,
      });
    }
    : undefined;
  const provider = new LivePreviewProvider({
    vscode,
    context,
    bridgeRegistry: registry,
    imageResolverFactory,
  });
  let registration;
  try {
    registration = vscode.window.registerCustomEditorProvider(LIVE_PREVIEW_VIEW_TYPE, provider);
  }
  catch (error) {
    for (const value of owned.reverse()) value.dispose();
    throw error;
  }
  const toggle = vscode.commands.registerCommand(
    "chatero.documentation.toggleEditingView",
    () => toggleActiveQmdView(vscode),
  );
  return Object.freeze([registration, toggle, ...owned]);
}

module.exports = {
  LIVE_PREVIEW_VIEW_TYPE,
  MAX_SNAPSHOT_SOURCE_UTF8,
  LivePreviewProvider,
  createLivePreviewNonce,
  openDocumentation,
  registerLivePreview,
  toggleActiveQmdView,
};
