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
  return `<article class="annotation" data-annotation-key="${escapeHtml(annotation.annotationKey)}" data-version="${Number.isSafeInteger(annotation.version) ? annotation.version : 0}"${navigation}>
    <div class="annotation-meta"><span class="swatch" data-color="${safeColor(annotation.color)}"></span><span>${escapeHtml(annotation.type)}</span><span>Page ${escapeHtml(label)}</span></div>
    ${annotation.text ? `<blockquote>${escapeHtml(annotation.text)}</blockquote>` : ""}
    ${annotation.comment ? `<p>${escapeHtml(annotation.comment)}</p>` : ""}
    ${Array.isArray(annotation.tags) && annotation.tags.length ? `<p class="annotation-tags">${annotation.tags.map(tag => `#${escapeHtml(tag)}`).join(" ")}</p>` : ""}
    <div class="annotation-actions"><button data-action="edit-annotation" aria-label="Edit annotation">Edit</button><button data-action="delete-annotation" aria-label="Delete annotation">Delete</button></div>
  </article>`;
}

function safeJson(value) {
  return JSON.stringify(value ?? {}).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export function renderPdfEditorHTML({ attachment, annotations, cspSource, initialState, nonce, panelNonce, pdfJsUri, pdfUri, viewerUri, workerUri }) {
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
.paper{display:grid;grid-template-rows:36px minmax(0,1fr);min-width:0;background:var(--vscode-editor-background)}.toolbar{display:flex;align-items:center;justify-content:center;gap:6px;border-bottom:1px solid var(--vscode-panel-border);overflow-x:auto}
.toolbar button,.toolbar input{font:inherit;color:inherit;background:var(--vscode-button-secondaryBackground);border:1px solid var(--vscode-widget-border);border-radius:4px;height:24px}.toolbar button{min-width:28px}.toolbar input{width:48px;text-align:center}.toolbar input[type=search]{width:150px;text-align:left}
.reader-body{display:grid;grid-template-columns:0 minmax(0,1fr);min-height:0}.reader-body.navigation-open{grid-template-columns:210px minmax(0,1fr)}.reader-navigation{overflow:auto;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);visibility:hidden}.reader-body.navigation-open .reader-navigation{visibility:visible}.reader-navigation button{display:block;width:100%;border:0;padding:7px 10px;text-align:left;color:inherit;background:transparent}.reader-navigation button:hover{background:var(--vscode-list-hoverBackground)}.thumbnail{padding:8px;border-bottom:1px solid var(--vscode-panel-border);cursor:pointer}.thumbnail canvas{display:block;max-width:100%;margin:auto}.thumbnail span{display:block;text-align:center;margin-top:4px}.viewport{position:relative;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:16px;background:var(--vscode-editor-background)}.page{--scale-factor:1;--user-unit:1;--total-scale-factor:calc(var(--scale-factor) * var(--user-unit));--scale-round-x:1px;--scale-round-y:1px;position:relative;box-shadow:0 2px 12px #0003;background:white}.page canvas{display:block}
.textLayer{--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size));position:absolute;inset:0;overflow:clip;line-height:1;text-align:initial;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;z-index:1}.textLayer[data-main-rotation="90"]{transform:rotate(90deg) translateY(-100%)}.textLayer[data-main-rotation="180"]{transform:rotate(180deg) translate(-100%,-100%)}.textLayer[data-main-rotation="270"]{transform:rotate(270deg) translateX(-100%)}
.textLayer :is(span,br){position:absolute;z-index:1;color:transparent;white-space:pre;cursor:text;transform-origin:0 0}.textLayer>.markedContent{display:contents}.textLayer .markedContent{display:contents}.textLayer>:not(.markedContent),.textLayer .markedContent span:not(.markedContent){--font-height:0px;--scale-x:1;--rotate:0deg;font-size:calc(var(--font-height) * var(--text-scale-factor));transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}.textLayer br::selection{background:transparent}.textLayer ::selection{background:color-mix(in srgb,var(--vscode-editor-selectionBackground) 75%,transparent)}
.annotation-layer{position:absolute;inset:0;z-index:2;pointer-events:none}.link-layer{position:absolute;inset:0;z-index:3;pointer-events:none}.pdf-link{position:absolute;pointer-events:auto;border:1px solid transparent}.pdf-link:focus,.pdf-link:hover{border-color:var(--vscode-focusBorder);background:#0066cc18}.pdf-highlight{position:absolute;mix-blend-mode:multiply;border-radius:1px}
.viewer-status{position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:2;color:var(--vscode-descriptionForeground)}.viewer-status.error{color:var(--vscode-errorForeground)}
.sidebar{overflow:auto;border-left:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);padding:12px}
h1{font-size:13px;margin:0 0 12px}.annotation{border:1px solid var(--vscode-widget-border);border-radius:6px;margin:0 0 10px;padding:9px;background:var(--vscode-editorWidget-background)}
.annotation[data-page-index]{cursor:pointer}.annotation[data-page-index]:hover{border-color:var(--vscode-focusBorder)}.annotation-meta{display:flex;gap:7px;align-items:center;color:var(--vscode-descriptionForeground);font-size:11px}
.swatch{width:9px;height:9px;border-radius:50%}.swatch[data-color="#ffd400"]{background:#ffd400}blockquote{margin:8px 0;padding-left:8px;border-left:2px solid var(--vscode-focusBorder)}p{margin:8px 0 0}.empty{color:var(--vscode-descriptionForeground)}.annotation-tags{color:var(--vscode-descriptionForeground)}.annotation-actions{display:flex;gap:6px;margin-top:8px}.annotation-actions button{font:inherit;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:0;border-radius:3px;padding:3px 7px}.pdf-highlight.underline{background:transparent!important;border-bottom:2px solid var(--annotation-color)}.pdf-highlight.image{background:transparent!important;border:2px solid var(--annotation-color)}.pdf-highlight.note{width:16px!important;height:16px!important;border-radius:50%;background:var(--annotation-color)!important}.page.area-selecting{cursor:crosshair}.area-preview{position:absolute;z-index:4;border:2px dashed var(--vscode-focusBorder);background:#0066cc18;pointer-events:none}
@media(max-width:720px){.layout{grid-template-columns:1fr}.sidebar{display:none}}
</style></head><body><main class="layout">
<section class="paper" aria-label="${escapeHtml(attachment.title)}"><nav class="toolbar" aria-label="PDF navigation"><button id="toggle-outline" title="Outline" aria-label="Show document outline">Outline</button><button id="toggle-thumbnails" title="Thumbnails" aria-label="Show page thumbnails">Pages</button><button id="previous-page" title="Previous page" aria-label="Previous page">‹</button><input id="page-number" type="number" min="1" value="1" aria-label="Page"><span id="page-count"></span><button id="next-page" title="Next page" aria-label="Next page">›</button><button id="zoom-out" title="Zoom out" aria-label="Zoom out">−</button><button id="zoom-in" title="Zoom in" aria-label="Zoom in">+</button><button id="rotate-page" title="Rotate clockwise" aria-label="Rotate clockwise">↻</button><input id="find-text" type="search" aria-label="Find in PDF" placeholder="Find"><button id="find-next" title="Find next" aria-label="Find next">⌕</button><button id="create-highlight" title="Create highlight from selection" aria-label="Create highlight from selection">Highlight</button><button id="create-underline" title="Create underline from selection" aria-label="Create underline from selection">Underline</button><button id="create-note" title="Place a note" aria-label="Place a note">Note</button><button id="create-area" title="Select an image area" aria-label="Select an image area">Area</button><button id="undo-annotation" title="Undo last annotation change" aria-label="Undo last annotation change">Undo</button><button id="print-pdf" title="Print PDF" aria-label="Print PDF">Print</button><button id="export-pdf" title="Export a copy" aria-label="Export a copy of this PDF">Export</button></nav><div id="reader-body" class="reader-body"><aside id="reader-navigation" class="reader-navigation" aria-label="PDF navigation panel"></aside><div class="viewport" id="page-viewport" tabindex="0"><div id="viewer-status" class="viewer-status" role="status" aria-live="polite">Loading PDF…</div><div id="pdf-page" class="page"><canvas id="pdf-canvas" aria-label="Rendered PDF page"></canvas><div id="text-layer" class="textLayer"></div><div id="annotation-layer" class="annotation-layer"></div><div id="link-layer" class="link-layer"></div></div></div></div></section>
<aside class="sidebar" aria-label="Zotero annotations"><h1 id="annotation-count">${annotations.length} Zotero annotation${annotations.length === 1 ? "" : "s"}</h1><div id="annotation-list">${rows}</div></aside>
</main><script id="annotation-data" type="application/json">${safeJson(annotations)}</script><script id="reader-state" type="application/json">${safeJson(initialState)}</script><script nonce="${escapeHtml(nonce)}" type="module" src="${escapeHtml(viewerUri)}" data-panel-nonce="${escapeHtml(panelNonce)}" data-pdf-js-uri="${escapeHtml(pdfJsUri)}" data-pdf-uri="${escapeHtml(pdfUri)}" data-worker-uri="${escapeHtml(workerUri)}"></script></body></html>`;
}

export function renderNoteEditorHTML({ note, cspSource, nonce }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${escapeHtml(nonce)}'; script-src 'nonce-${escapeHtml(nonce)}' ${escapeHtml(cspSource)}">
<meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${escapeHtml(nonce)}">:root{color-scheme:light dark;font:14px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}body{margin:0;height:100vh;display:grid;grid-template-rows:40px minmax(0,1fr)}header{display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--vscode-panel-border)}button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:3px;padding:5px 12px}textarea{resize:none;border:0;outline:0;padding:18px;font:14px var(--vscode-editor-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);line-height:1.5}.status{color:var(--vscode-descriptionForeground)}</style></head>
<body><header><strong>${escapeHtml(note.title)}</strong><button id="save-note">Save</button><span id="note-status" class="status" role="status" aria-live="polite">Saved</span></header><textarea id="note-html" aria-label="Zotero Note HTML">${escapeHtml(note.html)}</textarea><script nonce="${escapeHtml(nonce)}">const vscode=acquireVsCodeApi();const editor=document.getElementById("note-html");const status=document.getElementById("note-status");let sequence=0;editor.addEventListener("input",()=>{status.textContent="Unsaved"});const save=()=>{status.textContent="Saving…";vscode.postMessage({type:"note-save",sequence:++sequence,html:editor.value})};document.getElementById("save-note").addEventListener("click",save);document.addEventListener("keydown",event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="s"){event.preventDefault();save()}});window.addEventListener("message",event=>{if(event.data?.type==="note-saved"&&event.data.sequence===sequence)status.textContent="Saved";if(event.data?.type==="note-error"&&event.data.sequence===sequence)status.textContent="Conflict: "+event.data.message});</script></body></html>`;
}

export function renderUpstreamReaderHTML({ annotations, attachment, cspSource, documentUri, hostUri, luaparseUri, nonce, readerCssUri, readerJsUri, readerType, state }) {
  return `<!doctype html><html lang="en" dir="ltr" style="--sidebar-width:240px;--split-view-size:50%;--bottom-placeholder-height:50px;--toolbar-placeholder-width:0px"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${escapeHtml(cspSource)}; font-src ${escapeHtml(cspSource)}; img-src ${escapeHtml(cspSource)} data: blob:; style-src ${escapeHtml(cspSource)} 'unsafe-inline'; script-src 'nonce-${escapeHtml(nonce)}' ${escapeHtml(cspSource)}; worker-src ${escapeHtml(cspSource)} blob:; frame-src blob: data:">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(attachment.title)}</title><link rel="stylesheet" href="${escapeHtml(readerCssUri)}"><style nonce="${escapeHtml(nonce)}">html,body{height:100%;margin:0}.chatero-reader-error{box-sizing:border-box;padding:24px;font:14px var(--vscode-font-family);color:var(--vscode-errorForeground);background:var(--vscode-editor-background)}#reader-error{position:fixed;z-index:10000;inset:0 0 auto 0;padding:8px 12px;color:var(--vscode-inputValidation-errorForeground);background:var(--vscode-inputValidation-errorBackground);border-bottom:1px solid var(--vscode-inputValidation-errorBorder);font:13px var(--vscode-font-family)}#reader-error[hidden]{display:none}</style></head>
<body class="sidebar-open"><div id="reader-error" role="alert" hidden></div><div id="reader-ui"></div><div id="split-view"><div id="primary-view" class="primary-view"></div><div id="secondary-view" class="secondary-view"></div></div><div id="printContainer"></div>
<script id="annotation-data" type="application/json">${safeJson(annotations)}</script><script id="reader-state" type="application/json">${safeJson(state)}</script><script nonce="${escapeHtml(nonce)}" src="${escapeHtml(luaparseUri)}"></script><script nonce="${escapeHtml(nonce)}" src="${escapeHtml(readerJsUri)}"></script><script nonce="${escapeHtml(nonce)}" type="module" src="${escapeHtml(hostUri)}" data-document-uri="${escapeHtml(documentUri)}" data-reader-type="${escapeHtml(readerType)}" data-title="${escapeHtml(attachment.title)}"></script></body></html>`;
}
