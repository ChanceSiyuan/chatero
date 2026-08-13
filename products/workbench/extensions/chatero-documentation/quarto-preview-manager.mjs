import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { createQuartoPreviewHtml } from "./quarto-preview-html.mjs";
import { resolveVerifiedQuartoRuntime } from "./quarto-runtime.mjs";
import { SafeQuartoRenderer } from "./safe-quarto-renderer.mjs";
import { createQuartoStaticServer } from "./quarto-static-server.mjs";

const VIEW_TYPE = "chatero.documentation.quartoPreview";

function activeQmd(vscode) {
  const document = vscode.window.activeTextEditor?.document;
  const path = document?.uri?.fsPath;
  return typeof path === "string" && resolve(path) === path && path.toLowerCase().endsWith(".qmd") ? document : null;
}

export class QuartoPreviewManager {
  constructor({ vscode, runtimeResolver = resolveVerifiedQuartoRuntime, rendererFactory, staticServerFactory = createQuartoStaticServer } = {}) {
    if (!vscode?.window || !vscode?.workspace || !vscode?.env || typeof runtimeResolver !== "function"
      || typeof staticServerFactory !== "function") throw new TypeError("Quarto preview manager dependencies are invalid");
    this.vscode = vscode;
    this.runtimeResolver = runtimeResolver;
    this.rendererFactory = rendererFactory;
    this.staticServerFactory = staticServerFactory;
    this.sessions = new Map();
    this.disposed = false;
  }

  async open(document = activeQmd(this.vscode)) {
    if (this.disposed) throw new Error("Quarto preview manager is disposed");
    if (!this.vscode.workspace.isTrusted) {
      await this.vscode.window.showErrorMessage("Exact Quarto Preview requires a trusted workspace.");
      return Object.freeze({ kind: "preview-unavailable", reason: "untrusted-workspace" });
    }
    if (!document || document.uri?.scheme !== "file" || !document.uri.fsPath?.toLowerCase().endsWith(".qmd")) {
      await this.vscode.window.showErrorMessage("Open a local saved QMD source file before starting Exact Quarto Preview.");
      return Object.freeze({ kind: "preview-unavailable", reason: "no-active-qmd" });
    }
    if (document.isDirty) {
      const choice = await this.vscode.window.showWarningMessage("Save this QMD before creating an exact Quarto preview?", "Save and Preview", "Cancel");
      if (choice !== "Save and Preview" || !await document.save()) return Object.freeze({ kind: "cancelled" });
    }
    const key = document.uri.toString();
    let session = this.sessions.get(key);
    if (!session) {
      const runtime = await this.runtimeResolver();
      if (runtime.kind !== "verified-runtime") {
        await this.vscode.window.showErrorMessage(`Exact Quarto Preview is unavailable: ${runtime.reason}.`);
        return runtime;
      }
      const panel = this.vscode.window.createWebviewPanel(VIEW_TYPE, `Quarto Preview: ${document.uri.path.split("/").at(-1)}`, this.vscode.ViewColumn?.Beside, {
        enableScripts: false,
        retainContextWhenHidden: true,
      });
      const renderer = this.rendererFactory ? this.rendererFactory(runtime) : new SafeQuartoRenderer({ runtime });
      session = { document, panel, renderer, server: undefined, disposed: false };
      this.sessions.set(key, session);
      panel.onDidDispose(() => { void this.disposeSession(key, session); });
    }
    else session.panel.reveal?.(this.vscode.ViewColumn?.Beside, true);
    const result = await session.renderer.render({
      sourcePath: document.uri.fsPath,
      source: document.getText(),
      version: document.version,
    });
    const exact = result.kind === "rendered" ? result : result.lastGood;
    if (!exact) {
      await this.vscode.window.showErrorMessage(`Exact Quarto Preview failed: ${result.reason ?? result.diagnostic ?? result.kind}.`);
      return result;
    }
    if (result.kind === "rendered") {
      try {
        const candidate = await this.staticServerFactory({ entryPath: exact.entryPath, root: exact.root, token: randomBytes(32).toString("base64url") });
        const previous = session.server;
        session.server = candidate;
        session.servedRoot = exact.root;
        if (previous) await previous.dispose();
        await session.renderer.releaseExcept?.(exact.root);
      }
      catch (error) {
        if (!session.server) throw error;
        await this.vscode.window.showWarningMessage(`Quarto output was created but could not replace the last good preview: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    else if (exact.root !== session.servedRoot) {
      try {
        const candidate = await this.staticServerFactory({ entryPath: exact.entryPath, root: exact.root, token: randomBytes(32).toString("base64url") });
        const previous = session.server;
        session.server = candidate;
        session.servedRoot = exact.root;
        if (previous) await previous.dispose();
        await session.renderer.releaseExcept?.(exact.root);
      }
      catch {}
    }
    const externalUri = await this.vscode.env.asExternalUri(this.vscode.Uri.parse(session.server.url));
    const nonce = randomBytes(18).toString("base64url");
    session.panel.webview.html = createQuartoPreviewHtml({
      cspSource: session.panel.webview.cspSource,
      externalUri: externalUri.toString(),
      nonce,
    });
    if (result.kind === "failed-with-last-good") {
      await this.vscode.window.showWarningMessage(`Quarto refresh failed; the last good preview remains visible. ${result.diagnostic}`);
    }
    return result;
  }

  async disposeSession(key, session) {
    if (session.disposed) return;
    session.disposed = true;
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    await session.server?.dispose();
    await session.renderer.dispose();
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.sessions].map(([key, session]) => this.disposeSession(key, session)));
  }
}

export async function registerQuartoPreview({ vscode, context, manager } = {}) {
  const previewManager = manager ?? new QuartoPreviewManager({ vscode });
  return Object.freeze([
    vscode.commands.registerCommand("chatero.documentation.openQuartoPreview", () => previewManager.open()),
    previewManager,
  ]);
}
