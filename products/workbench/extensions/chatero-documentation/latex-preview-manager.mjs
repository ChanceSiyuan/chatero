import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { createLatexPreviewHtml } from "./latex-preview-html.mjs";
import { hostRootFor, LatexPreviewServer, viewerRootFor } from "./latex-preview-server.mjs";
import { resolveVerifiedLatexRuntime } from "./latex-runtime.mjs";
import { SafeLatexRenderer } from "./safe-latex-renderer.mjs";

const VIEW_TYPE = "chatero.documentation.latexPreview";
const REMOTE_AUTHORITY_PREFIX = "chatero-remote+";
const POSITION_STATE_KEY = "chatero.documentation.latexPreview.positions.v1";
const MAX_REMEMBERED_POSITIONS = 32;

function previewableTexUri(uri) {
  if (!uri || typeof uri.fsPath !== "string" || resolve(uri.fsPath) !== uri.fsPath
      || !uri.fsPath.toLowerCase().endsWith(".tex")) return false;
  if (uri.scheme === "file") return true;
  return uri.scheme === "vscode-remote"
    && typeof uri.authority === "string"
    && uri.authority.startsWith(REMOTE_AUTHORITY_PREFIX);
}

function activeTex(vscode) {
  const document = vscode.window.activeTextEditor?.document;
  if (document && previewableTexUri(document.uri)) return document;
  const tabUri = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input?.uri;
  if (tabUri && previewableTexUri(tabUri)) {
    return vscode.workspace.textDocuments?.find(candidate => candidate.uri?.toString() === tabUri.toString()) ?? null;
  }
  return null;
}

function validPosition(value) {
  return Boolean(value) && Number.isSafeInteger(value.page) && value.page >= 0
    && Number.isFinite(value.offset?.left) && Number.isFinite(value.offset?.top);
}

export class LatexPreviewManager {
  constructor({ vscode, memento, runtimeResolver = resolveVerifiedLatexRuntime, rendererFactory, server } = {}) {
    if (!vscode?.window || !vscode?.workspace || !vscode?.env || typeof runtimeResolver !== "function") {
      throw new TypeError("LaTeX preview manager dependencies are invalid");
    }
    this.vscode = vscode;
    this.memento = memento;
    this.runtimeResolver = runtimeResolver;
    this.rendererFactory = rendererFactory;
    this.server = server;
    this.sessions = new Map();
    this.disposed = false;
  }

  #positions() {
    const stored = this.memento?.get?.(POSITION_STATE_KEY);
    return stored && typeof stored === "object" && !Array.isArray(stored) ? { ...stored } : {};
  }

  async #rememberPosition(key, value) {
    if (!this.memento?.update) return;
    const positions = this.#positions();
    positions[key] = value;
    const keys = Object.keys(positions);
    // Keep the map bounded so a long-lived profile cannot grow without limit.
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_POSITIONS))) delete positions[stale];
    await this.memento.update(POSITION_STATE_KEY, positions);
  }

  async open(document = activeTex(this.vscode)) {
    if (this.disposed) throw new Error("LaTeX preview manager is disposed");
    if (!this.vscode.workspace.isTrusted) {
      await this.vscode.window.showErrorMessage("LaTeX Preview requires a trusted workspace.");
      return Object.freeze({ kind: "preview-unavailable", reason: "untrusted-workspace" });
    }
    if (!document || !previewableTexUri(document.uri)) {
      await this.vscode.window.showErrorMessage("Open a saved LaTeX source file (local, or in a Chatero remote workspace) before starting LaTeX Preview.");
      return Object.freeze({ kind: "preview-unavailable", reason: "no-active-tex" });
    }
    if (document.isDirty) {
      const choice = await this.vscode.window.showWarningMessage("Save this LaTeX file before compiling a preview?", "Save and Preview", "Cancel");
      if (choice !== "Save and Preview" || !await document.save()) return Object.freeze({ kind: "cancelled" });
    }
    const key = document.uri.toString();
    let session = this.sessions.get(key);
    if (!session) {
      const runtime = await this.runtimeResolver();
      if (runtime.kind !== "verified-runtime") {
        await this.vscode.window.showErrorMessage(`LaTeX Preview is unavailable: ${runtime.reason}.`);
        return runtime;
      }
      const panel = this.vscode.window.createWebviewPanel(VIEW_TYPE, `LaTeX Preview: ${document.uri.path.split("/").at(-1)}`, {
        preserveFocus: true,
        viewColumn: this.vscode.ViewColumn?.Beside,
      }, {
        enableScripts: true,
        localResourceRoots: [],
        retainContextWhenHidden: true,
      });
      const renderer = this.rendererFactory ? this.rendererFactory(runtime) : new SafeLatexRenderer({ runtime });
      const stored = this.#positions()[key];
      session = {
        disposed: false,
        document,
        lease: undefined,
        next: undefined,
        panel,
        position: validPosition(stored?.position) ? stored.position : undefined,
        pump: undefined,
        renderer,
        scale: typeof stored?.scale === "string" ? stored.scale : undefined,
      };
      this.sessions.set(key, session);
      panel.webview.onDidReceiveMessage?.(message => {
        if (message?.type !== "chatero-latex-position" || !validPosition(message.position)) return;
        session.position = message.position;
        if (typeof message.scale === "string") session.scale = message.scale;
        void this.#rememberPosition(key, { position: session.position, scale: session.scale });
      });
      panel.onDidDispose(() => { void this.disposeSession(key, session); });
    }
    else session.panel.reveal?.(this.vscode.ViewColumn?.Beside, true);
    return this.#schedule(session, document, false);
  }

  async refreshSaved(document) {
    if (this.disposed || !document || !previewableTexUri(document.uri)) return;
    const session = this.sessions.get(document.uri.toString());
    if (!session || session.disposed) return;
    await this.#schedule(session, document, true);
  }

  // Compiles for one session are serialized through a single pump: a save that
  // arrives mid-compile is coalesced into the pending slot instead of being
  // dropped, and an interactive request keeps its non-quiet reporting.
  #schedule(session, document, quiet) {
    session.next = { document, quiet: session.next ? session.next.quiet && quiet : quiet };
    if (!session.pump) {
      session.pump = (async () => {
        let result = Object.freeze({ kind: "compile-in-flight" });
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
        if (quiet) this.vscode.window.setStatusBarMessage?.(`LaTeX compile failed: ${detail}`, 5000);
        else await this.vscode.window.showErrorMessage(`LaTeX Preview failed: ${detail}.`);
        return result;
      }
      if (session.disposed) return result;
      if (result.kind === "rendered" || !session.lease) {
        const lease = await this.server.lease({ path: exact.pdfPath, leaseId: session.lease?.leaseId });
        if (session.disposed) { lease.dispose(); return result; }
        session.lease = lease;
        await session.renderer.releaseExcept?.(exact.root);
      }
      const externalUri = await this.vscode.env.asExternalUri(this.vscode.Uri.parse(session.lease.hostUrl));
      if (session.rendered) {
        // The host page keeps its viewer mounted and swaps documents, so the
        // reader never sees an empty pane between compiles.
        session.panel.webview.postMessage?.({
          type: "chatero-latex-document",
          documentUrl: session.lease.documentUrl,
          viewerUrl: session.lease.viewerUrl,
        });
      }
      else {
        const nonce = randomBytes(18).toString("base64url");
        session.panel.webview.html = createLatexPreviewHtml({
          cspSource: session.panel.webview.cspSource,
          hostUri: externalUri.toString(),
          nonce,
        });
        session.rendered = true;
        if (session.position || session.scale) {
          session.panel.webview.postMessage?.({
            type: "chatero-latex-restore",
            position: session.position,
            scale: session.scale,
          });
        }
      }
      if (result.kind === "failed-with-last-good") {
        if (quiet) this.vscode.window.setStatusBarMessage?.(`LaTeX compile failed; showing the last good PDF. ${result.diagnostic}`, 8000);
        else await this.vscode.window.showWarningMessage(`LaTeX compile failed; the last good PDF remains visible. ${result.diagnostic}`);
      }
      return result;
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (quiet) this.vscode.window.setStatusBarMessage?.(`LaTeX compile failed: ${message}`, 5000);
      else await this.vscode.window.showErrorMessage(`LaTeX Preview failed: ${message}.`);
      return Object.freeze({ kind: "failed", diagnostic: message });
    }
  }

  async disposeSession(key, session) {
    if (session.disposed) return;
    session.disposed = true;
    session.next = undefined;
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    if (session.pump) await session.pump;
    session.lease?.dispose();
    await session.renderer.dispose();
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.sessions].map(([key, session]) => this.disposeSession(key, session)));
    await this.server?.dispose?.();
  }
}

export async function registerLatexPreview({ vscode, context, manager, platform = process.platform } = {}) {
  const configuration = () => vscode.workspace.getConfiguration?.("chatero.documentation.remoteLatex");
  const previewManager = manager ?? new LatexPreviewManager({
    vscode,
    memento: context?.workspaceState,
    runtimeResolver: () => resolveVerifiedLatexRuntime({
      executable: configuration()?.get("executablePath"),
      platform,
      runtimeRoots: configuration()?.get("runtimeRoots"),
      sha256Allowlist: configuration()?.get("sha256Allowlist"),
    }),
    server: new LatexPreviewServer({
      hostRoot: hostRootFor(context.extensionPath),
      viewerRoot: viewerRootFor(context.extensionPath),
    }),
  });
  return Object.freeze([
    vscode.commands.registerCommand("chatero.documentation.openLatexPreview", () => previewManager.open()),
    vscode.workspace.onDidSaveTextDocument(document => { void previewManager.refreshSaved(document); }),
    previewManager,
  ]);
}
