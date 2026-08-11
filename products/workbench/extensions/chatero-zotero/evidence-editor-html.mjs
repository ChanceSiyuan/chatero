function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safePageIndex(positionJson) {
  try {
    const value = JSON.parse(positionJson);
    return Number.isSafeInteger(value?.pageIndex) && value.pageIndex >= 0 ? value.pageIndex : null;
  } catch {
    return null;
  }
}

function safeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffd400";
}

function annotationRow(annotation) {
  const pageIndex = safePageIndex(annotation.positionJson);
  const label = annotation.pageLabel || (pageIndex === null ? "Unknown page" : String(pageIndex + 1));
  const navigation = pageIndex === null ? "" : ` data-page-index="${pageIndex}" tabindex="0" role="button"`;
  return `<article class="annotation"${navigation}>
    <div class="annotation-meta"><span class="swatch" data-color="${safeColor(annotation.color)}"></span><span>${escapeHtml(annotation.type)}</span><span>Page ${escapeHtml(label)}</span></div>
    ${annotation.text ? `<blockquote>${escapeHtml(annotation.text)}</blockquote>` : ""}
    ${annotation.comment ? `<p>${escapeHtml(annotation.comment)}</p>` : ""}
  </article>`;
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export function renderPdfEditorHTML({ attachment, annotations, cspSource, nonce, panelNonce, pdfJsUri, pdfUri, viewerUri, workerUri }) {
  const rows = annotations.length
    ? annotations.map(annotationRow).join("\n")
    : '<p class="empty">No Zotero highlights or annotations yet.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${escapeHtml(cspSource)}; img-src ${escapeHtml(cspSource)} data: blob:; style-src 'nonce-${escapeHtml(nonce)}'; script-src 'nonce-${escapeHtml(nonce)}' ${escapeHtml(cspSource)}; worker-src ${escapeHtml(cspSource)} blob:">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${escapeHtml(nonce)}">
:root{color-scheme:light dark;font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
*{box-sizing:border-box}body{margin:0;height:100vh;overflow:hidden}.layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;height:100%}
.paper{display:grid;grid-template-rows:36px minmax(0,1fr);min-width:0;background:var(--vscode-editor-background)}.toolbar{display:flex;align-items:center;justify-content:center;gap:6px;border-bottom:1px solid var(--vscode-panel-border)}
.toolbar button,.toolbar input{font:inherit;color:inherit;background:var(--vscode-button-secondaryBackground);border:1px solid var(--vscode-widget-border);border-radius:4px;height:24px}.toolbar button{min-width:28px}.toolbar input{width:48px;text-align:center}
.viewport{position:relative;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:16px;background:var(--vscode-editor-background)}.page{--scale-factor:1;--user-unit:1;--total-scale-factor:calc(var(--scale-factor) * var(--user-unit));--scale-round-x:1px;--scale-round-y:1px;position:relative;box-shadow:0 2px 12px #0003;background:white}.page canvas{display:block}
.textLayer{--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size));position:absolute;inset:0;overflow:clip;line-height:1;text-align:initial;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;z-index:1}.textLayer[data-main-rotation="90"]{transform:rotate(90deg) translateY(-100%)}.textLayer[data-main-rotation="180"]{transform:rotate(180deg) translate(-100%,-100%)}.textLayer[data-main-rotation="270"]{transform:rotate(270deg) translateX(-100%)}
.textLayer :is(span,br){position:absolute;z-index:1;color:transparent;white-space:pre;cursor:text;transform-origin:0 0}.textLayer>.markedContent{display:contents}.textLayer .markedContent{display:contents}.textLayer>:not(.markedContent),.textLayer .markedContent span:not(.markedContent){--font-height:0px;--scale-x:1;--rotate:0deg;font-size:calc(var(--font-height) * var(--text-scale-factor));transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}.textLayer br::selection{background:transparent}.textLayer ::selection{background:color-mix(in srgb,var(--vscode-editor-selectionBackground) 75%,transparent)}
.annotation-layer{position:absolute;inset:0;z-index:2;pointer-events:none}.pdf-highlight{position:absolute;mix-blend-mode:multiply;border-radius:1px}
.viewer-status{position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:2;color:var(--vscode-descriptionForeground)}.viewer-status.error{color:var(--vscode-errorForeground)}
.sidebar{overflow:auto;border-left:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);padding:12px}
h1{font-size:13px;margin:0 0 12px}.annotation{border:1px solid var(--vscode-widget-border);border-radius:6px;margin:0 0 10px;padding:9px;background:var(--vscode-editorWidget-background)}
.annotation[data-page-index]{cursor:pointer}.annotation[data-page-index]:hover{border-color:var(--vscode-focusBorder)}.annotation-meta{display:flex;gap:7px;align-items:center;color:var(--vscode-descriptionForeground);font-size:11px}
.swatch{width:9px;height:9px;border-radius:50%}.swatch[data-color="#ffd400"]{background:#ffd400}blockquote{margin:8px 0;padding-left:8px;border-left:2px solid var(--vscode-focusBorder)}p{margin:8px 0 0}.empty{color:var(--vscode-descriptionForeground)}
@media(max-width:720px){.layout{grid-template-columns:1fr}.sidebar{display:none}}
</style></head><body><main class="layout">
<section class="paper" aria-label="${escapeHtml(attachment.title)}"><nav class="toolbar" aria-label="PDF navigation"><button id="previous-page" title="Previous page">‹</button><input id="page-number" type="number" min="1" value="1" aria-label="Page"><span id="page-count"></span><button id="next-page" title="Next page">›</button><button id="zoom-out" title="Zoom out">−</button><button id="zoom-in" title="Zoom in">+</button></nav><div class="viewport" id="page-viewport"><div id="viewer-status" class="viewer-status">Loading PDF…</div><div id="pdf-page" class="page"><canvas id="pdf-canvas"></canvas><div id="text-layer" class="textLayer"></div><div id="annotation-layer" class="annotation-layer"></div></div></div></section>
<aside class="sidebar" aria-label="Zotero annotations"><h1>${annotations.length} Zotero annotation${annotations.length === 1 ? "" : "s"}</h1>${rows}</aside>
</main><script id="annotation-data" type="application/json">${safeJson(annotations)}</script><script nonce="${escapeHtml(nonce)}" type="module" src="${escapeHtml(viewerUri)}" data-panel-nonce="${escapeHtml(panelNonce)}" data-pdf-js-uri="${escapeHtml(pdfJsUri)}" data-pdf-uri="${escapeHtml(pdfUri)}" data-worker-uri="${escapeHtml(workerUri)}"></script></body></html>`;
}

export function renderNoteEditorHTML({ note, cspSource }) {
  const source = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:15px -apple-system,BlinkMacSystemFont,sans-serif;line-height:1.55;margin:24px;max-width:760px}img{max-width:100%}blockquote{margin-left:0;padding-left:12px;border-left:3px solid #999}</style></head><body>${note.html}</body></html>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'self' ${escapeHtml(cspSource)}; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0"><iframe title="${escapeHtml(note.title)}" sandbox="" srcdoc="${escapeHtml(source)}" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe></body></html>`;
}
