function escapeAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// The panel is a thin shell: it frames the loopback host page, which owns the
// pdf.js viewer, and relays position updates to the extension host so a
// reopened panel resumes where the reader left off.
export function createLatexPreviewHtml({ cspSource, hostUri, nonce } = {}) {
  if (typeof cspSource !== "string" || !cspSource || typeof hostUri !== "string"
      || !/^https?:\/\//u.test(hostUri) || !/^[A-Za-z0-9_-]{24}$/u.test(nonce ?? "")) {
    throw new TypeError("LaTeX preview HTML inputs are invalid");
  }
  const origin = new URL(hostUri).origin;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escapeAttribute(origin)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${nonce}">html,body,iframe{width:100%;height:100%;margin:0;border:0;background:var(--vscode-editor-background)}.label{position:fixed;z-index:1;right:12px;top:8px;padding:3px 8px;border-radius:4px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font:12px var(--vscode-font-family);pointer-events:none}</style>
<title>LaTeX Preview</title></head><body>
<div class="label" role="status">LaTeX Preview</div>
<iframe id="host" title="LaTeX PDF preview" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin"></iframe>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const host = document.getElementById("host");
const origin = ${JSON.stringify(origin)};
window.addEventListener("message", event => {
  const message = event.data;
  const fromHost = event.origin === origin && message && typeof message === "object"
    && ["chatero-latex-host-ready", "chatero-latex-position", "chatero-latex-ready", "chatero-latex-error"].includes(message.type);
  if (fromHost) {
    vscode.postMessage(message);
    return;
  }
  // VS Code delivers extension-host webview.postMessage() events without a
  // stable WindowProxy source. In Electron it is not window.parent, so a
  // source equality check silently drops the first document and leaves the
  // nested viewer at about:blank. This product-owned shell has only the host
  // frame above; accept only the two exact inbound message shapes and validate
  // the token-relative viewer path before forwarding them.
  // Some Electron builds report the nested host as the WindowProxy source for
  // an extension-host delivery too. The authenticated loopback-origin branch
  // above already consumed genuine host-to-extension traffic, so the exact
  // inbound types below are safe to accept regardless of that unstable source.
  if (!message || typeof message !== "object") return;
  if (message.type === "chatero-latex-restore") {
    host.contentWindow?.postMessage(message, origin);
    return;
  }
  const viewerPrefix = "../viewer/web/viewer.html?file=../../doc/";
  const decodedViewerPath = typeof message.viewerPath === "string" ? decodeURIComponent(message.viewerPath) : "";
  if (message.type === "chatero-latex-document"
      && decodedViewerPath.startsWith(viewerPrefix)
      && /^[A-Za-z0-9_-]{24}$/u.test(decodedViewerPath.slice(viewerPrefix.length))) {
    host.contentWindow?.postMessage(message, origin);
  }
});
// Navigate only after the relay is listening. A loopback host can finish
// loading while the HTML parser is still reaching this script; giving the
// iframe its src in markup therefore loses its one-shot ready message and the
// extension never publishes the first PDF lease.
host.src = ${JSON.stringify(hostUri)};
</script>
</body></html>`;
}
