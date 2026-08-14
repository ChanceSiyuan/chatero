import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { createQuartoPreviewHtml } from "./quarto-preview-html.mjs";
import { resolveVerifiedQuartoRuntime } from "./quarto-runtime.mjs";
import { SafeQuartoRenderer } from "./safe-quarto-renderer.mjs";
import { createQuartoStaticServer } from "./quarto-static-server.mjs";

const VIEW_TYPE = "chatero.documentation.quartoPreview";
const REMOTE_AUTHORITY_PREFIX = "chatero-remote+";

function previewableQmdUri(uri) {
  if (!uri || typeof uri.fsPath !== "string" || resolve(uri.fsPath) !== uri.fsPath
      || !uri.fsPath.toLowerCase().endsWith(".qmd")) return false;
  if (uri.scheme === "file") return true;
  // In a Chatero remote workspace this extension runs on the remote extension
  // host, so the document bytes and the Quarto process are both on that
  // machine; asExternalUri tunnels the preview back to the client.
  return uri.scheme === "vscode-remote"
    && typeof uri.authority === "string"
    && uri.authority.startsWith(REMOTE_AUTHORITY_PREFIX);
}

function activeQmd(vscode) {
  const document = vscode.window.activeTextEditor?.document;
  if (document && previewableQmdUri(document.uri)) return document;
  // With the Live Preview custom editor focused there is no active text
  // editor; fall back to the active tab's resource, whose TextDocument the
  // custom editor keeps open.
  const tabUri = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input?.uri;
  if (tabUri && previewableQmdUri(tabUri)) {
    return vscode.workspace.textDocuments?.find(candidate => candidate.uri?.toString() === tabUri.toString()) ?? null;
  }
  return null;
}

export class QuartoPreviewManager {
  constructor({ vscode, executionMode = "forbid", runtimeResolver = resolveVerifiedQuartoRuntime, rendererFactory, staticServerFactory = createQuartoStaticServer } = {}) {
    if (!vscode?.window || !vscode?.workspace || !vscode?.env || typeof runtimeResolver !== "function"
      || typeof staticServerFactory !== "function"
      || !(typeof executionMode === "function" || ["forbid", "sandboxed"].includes(executionMode))) {
      throw new TypeError("Quarto preview manager dependencies are invalid");
    }
    this.vscode = vscode;
    this.executionMode = executionMode;
    this.runtimeResolver = runtimeResolver;
    this.rendererFactory = rendererFactory;
    this.staticServerFactory = staticServerFactory;
    this.sessions = new Map();
    this.disposed = false;
  }

  #resolveExecutionMode() {
    const mode = typeof this.executionMode === "function" ? this.executionMode() : this.executionMode;
    return mode === "sandboxed" ? "sandboxed" : "forbid";
  }

  async open(document = activeQmd(this.vscode)) {
    if (this.disposed) throw new Error("Quarto preview manager is disposed");
    if (!this.vscode.workspace.isTrusted) {
      await this.vscode.window.showErrorMessage("Exact Quarto Preview requires a trusted workspace.");
      return Object.freeze({ kind: "preview-unavailable", reason: "untrusted-workspace" });
    }
    if (!document || !previewableQmdUri(document.uri)) {
      await this.vscode.window.showErrorMessage("Open a saved QMD source file (local, or in a Chatero remote workspace) before starting Exact Quarto Preview.");
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
      const panel = this.vscode.window.createWebviewPanel(VIEW_TYPE, `Quarto Preview: ${document.uri.path.split("/").at(-1)}`, {
        preserveFocus: true,
        viewColumn: this.vscode.ViewColumn?.Beside,
      }, {
        enableScripts: false,
        retainContextWhenHidden: true,
      });
      const renderer = this.rendererFactory
        ? this.rendererFactory(runtime)
        : new SafeQuartoRenderer({ runtime, executionMode: () => this.#resolveExecutionMode() });
      session = { document, panel, renderer, server: undefined, disposed: false, next: undefined, pump: undefined };
      this.sessions.set(key, session);
      panel.onDidDispose(() => { void this.disposeSession(key, session); });
    }
    else session.panel.reveal?.(this.vscode.ViewColumn?.Beside, true);
    return this.#schedule(session, document, false);
  }

  async refreshSaved(document) {
    if (this.disposed || !document || !previewableQmdUri(document.uri)) return;
    const session = this.sessions.get(document.uri.toString());
    if (!session || session.disposed) return;
    await this.#schedule(session, document, true);
  }

  // Renders for one session are serialized through a single pump: concurrent
  // requests coalesce into the pending slot (an interactive request keeps
  // quiet=false), so saves arriving mid-render are never dropped and an open()
  // issued during a background refresh still yields a real render result.
  #schedule(session, document, quiet) {
    session.next = { document, quiet: session.next ? session.next.quiet && quiet : quiet };
    if (!session.pump) {
      session.pump = (async () => {
        let result = Object.freeze({ kind: "refresh-in-flight" });
        try {
          while (session.next && !session.disposed) {
            const request = session.next;
            session.next = undefined;
            result = await this.#present(session, request.document, request.quiet);
          }
        }
        finally { session.pump = undefined; }
        return result;
      })();
    }
    return session.pump;
  }

  async #present(session, document, quiet) {
    try {
      const result = await session.renderer.render({
        sourcePath: document.uri.fsPath,
        source: document.getText(),
        version: document.version,
      });
      const exact = result.kind === "rendered" ? result : result.lastGood;
      if (!exact) {
        const detail = result.reason ?? result.diagnostic ?? result.kind;
        if (quiet) this.vscode.window.setStatusBarMessage?.(`Quarto refresh failed: ${detail}`, 5000);
        else await this.vscode.window.showErrorMessage(`Exact Quarto Preview failed: ${detail}.`);
        return result;
      }
      if (session.disposed) return result;
      if (exact.root !== session.servedRoot || result.kind === "rendered") {
        try {
          const candidate = await this.staticServerFactory({ entryPath: exact.entryPath, root: exact.root, token: randomBytes(32).toString("base64url") });
          if (session.disposed) {
            await candidate.dispose();
            return result;
          }
          const previous = session.server;
          session.server = candidate;
          session.servedRoot = exact.root;
          if (previous) await previous.dispose();
          await session.renderer.releaseExcept?.(exact.root);
        }
        catch (error) {
          if (!session.server) throw error;
          if (!quiet) await this.vscode.window.showWarningMessage(`Quarto output was created but could not replace the last good preview: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const externalUri = await this.vscode.env.asExternalUri(this.vscode.Uri.parse(session.server.url));
      const nonce = randomBytes(18).toString("base64url");
      if (session.disposed) return result;
      session.panel.webview.html = createQuartoPreviewHtml({
        cspSource: session.panel.webview.cspSource,
        externalUri: externalUri.toString(),
        nonce,
      });
      if (result.kind === "failed-with-last-good") {
        if (quiet) this.vscode.window.setStatusBarMessage?.(`Quarto refresh failed; showing last good preview. ${result.diagnostic}`, 5000);
        else await this.vscode.window.showWarningMessage(`Quarto refresh failed; the last good preview remains visible. ${result.diagnostic}`);
      }
      return result;
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (quiet) this.vscode.window.setStatusBarMessage?.(`Quarto refresh failed: ${message}`, 5000);
      else await this.vscode.window.showErrorMessage(`Exact Quarto Preview failed: ${message}.`);
      return Object.freeze({ kind: "failed", diagnostic: message });
    }
  }

  async disposeSession(key, session) {
    if (session.disposed) return;
    session.disposed = true;
    session.next = undefined;
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    if (session.pump) await session.pump;
    await session.server?.dispose();
    await session.renderer.dispose();
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.sessions].map(([key, session]) => this.disposeSession(key, session)));
  }
}

export async function registerQuartoPreview({ vscode, context, manager, platform = process.platform } = {}) {
  const remoteConfiguration = () => vscode.workspace.getConfiguration?.("chatero.documentation.remoteQuarto");
  const previewManager = manager ?? new QuartoPreviewManager({
    vscode,
    ...(platform === "linux"
      ? {
          // Execution stays opt-in and is granted only on the remote
          // extension host of a Chatero remote workspace, never to a local
          // Linux workbench.
          executionMode: () => (vscode.env?.remoteName === "chatero-remote"
            && remoteConfiguration()?.get("allowExecution") === true ? "sandboxed" : "forbid"),
          runtimeResolver: () => resolveVerifiedQuartoRuntime({
            executable: remoteConfiguration()?.get("executablePath"),
            platform,
            sha256Allowlist: remoteConfiguration()?.get("sha256Allowlist"),
          }),
        }
      : {}),
  });
  return Object.freeze([
    vscode.commands.registerCommand("chatero.documentation.openQuartoPreview", () => previewManager.open()),
    vscode.workspace.onDidSaveTextDocument(document => { void previewManager.refreshSaved(document); }),
    previewManager,
  ]);
}
