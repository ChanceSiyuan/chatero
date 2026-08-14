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
<iframe id="host" title="LaTeX PDF preview" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin" src="${escapeAttribute(hostUri)}"></iframe>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const host = document.getElementById("host");
const origin = ${JSON.stringify(origin)};
window.addEventListener("message", event => {
  if (event.source === host.contentWindow && event.origin === origin) {
    vscode.postMessage(event.data);
    return;
  }
  if (event.source === window.parent && event.data && typeof event.data === "object") {
    host.contentWindow?.postMessage(event.data, origin);
  }
});
</script>
</body></html>`;
}
