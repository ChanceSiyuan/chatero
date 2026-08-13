function escapeAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function createQuartoPreviewHtml({ cspSource, externalUri, nonce } = {}) {
  if (typeof cspSource !== "string" || !cspSource || typeof externalUri !== "string"
      || !/^https?:\/\//u.test(externalUri) || !/^[A-Za-z0-9_-]{24}$/u.test(nonce ?? "")) {
    throw new TypeError("exact Quarto preview HTML inputs are invalid");
  }
  const source = new URL(externalUri).origin;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escapeAttribute(source)}; style-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${nonce}">html,body,iframe{width:100%;height:100%;margin:0;border:0;background:var(--vscode-editor-background)}.label{position:fixed;z-index:1;right:12px;top:8px;padding:3px 8px;border-radius:4px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font:12px var(--vscode-font-family)}</style>
<title>Exact Quarto Preview</title></head><body>
<div class="label" role="status">Exact Quarto Preview · read-only</div>
<iframe title="Exact Quarto Preview" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" src="${escapeAttribute(externalUri)}"></iframe>
</body></html>`;
}
