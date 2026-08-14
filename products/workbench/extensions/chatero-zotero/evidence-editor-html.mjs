function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJson(value) {
  return JSON.stringify(value ?? {}).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export function renderNoteEditorHTML({ note, cspSource, nonce }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${escapeHtml(nonce)}'; script-src 'nonce-${escapeHtml(nonce)}' ${escapeHtml(cspSource)}">
<meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${escapeHtml(nonce)}">:root{color-scheme:light dark;font:14px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}body{margin:0;height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr)}header{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:7px 12px;border-bottom:1px solid var(--vscode-panel-border)}button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:3px;padding:5px 9px}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}#note-editor{overflow:auto;outline:0;padding:24px;line-height:1.55;white-space:normal}#note-editor:focus{box-shadow:inset 0 0 0 1px var(--vscode-focusBorder)}#note-editor[aria-readonly=true]{opacity:.75}.status{color:var(--vscode-descriptionForeground)}.status.error{color:var(--vscode-errorForeground)}#reload-note[hidden]{display:none}pre{white-space:pre-wrap}blockquote{border-left:3px solid var(--vscode-focusBorder);padding-left:10px}</style></head>
<body><header><strong>${escapeHtml(note.title)}</strong><button id="format-bold" class="secondary" aria-label="Bold"><strong>B</strong></button><button id="format-italic" class="secondary" aria-label="Italic"><em>I</em></button><button id="format-list" class="secondary" aria-label="Bulleted list">List</button><button id="format-link" class="secondary" aria-label="Insert link">Link</button><button id="save-note">Save</button><button id="reload-note" class="secondary" hidden>Reload latest</button><span id="note-status" class="status" role="status" aria-live="polite">Saved</span></header><main id="note-editor" contenteditable="true" role="textbox" aria-label="Zotero Note" aria-multiline="true"></main><script id="note-data" type="application/json">${safeJson({ html: note.html, version: note.version })}</script><script nonce="${escapeHtml(nonce)}">const vscode=acquireVsCodeApi();const editor=document.getElementById("note-editor");const status=document.getElementById("note-status");const reload=document.getElementById("reload-note");let sequence=0;let dirty=false;const blocked=new Set(["SCRIPT","IFRAME","OBJECT","EMBED","LINK","META","BASE","FORM","INPUT","BUTTON","TEXTAREA","SELECT","STYLE"]);function sanitize(root){for(const element of [...root.querySelectorAll("*")]){if(blocked.has(element.tagName)){element.replaceWith(...element.childNodes);continue}for(const attribute of [...element.attributes]){const name=attribute.name.toLowerCase();if(name.startsWith("on")||name==="srcdoc")element.removeAttribute(attribute.name);if(name==="href"&&!/^(?:https?:|mailto:|zotero:)/i.test(attribute.value))element.removeAttribute(attribute.name);if(name==="src"&&!/^data:image\/(?:png|gif|jpeg|webp);base64,/i.test(attribute.value))element.removeAttribute(attribute.name);if(name==="style"&&/(?:url\s*\(|expression\s*\()/i.test(attribute.value))element.removeAttribute(attribute.name)}}return root}function setHTML(html){const template=document.createElement("template");template.innerHTML=html;sanitize(template.content);editor.replaceChildren(template.content.cloneNode(true));dirty=false}function html(){const clone=editor.cloneNode(true);return sanitize(clone).innerHTML}setHTML(JSON.parse(document.getElementById("note-data").textContent).html);editor.addEventListener("input",()=>{dirty=true;status.classList.remove("error");status.textContent="Unsaved"});function command(name,value){editor.focus();document.execCommand(name,false,value)}document.getElementById("format-bold").onclick=()=>command("bold");document.getElementById("format-italic").onclick=()=>command("italic");document.getElementById("format-list").onclick=()=>command("insertUnorderedList");document.getElementById("format-link").onclick=()=>{const value=prompt("Link URL");if(value&&/^(?:https?:|mailto:|zotero:)/i.test(value))command("createLink",value)};const save=()=>{if(editor.getAttribute("aria-readonly")==="true")return;status.textContent="Saving…";vscode.postMessage({type:"note-save",sequence:++sequence,html:html()})};document.getElementById("save-note").addEventListener("click",save);reload.onclick=()=>{if(dirty&&!confirm("Discard the local unsaved version and reload the latest Zotero Note?"))return;vscode.postMessage({type:"note-reload",sequence:++sequence})};document.addEventListener("keydown",event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="s"){event.preventDefault();save()}});window.addEventListener("message",event=>{if(event.data?.sequence!==sequence)return;if(event.data.type==="note-saved"){dirty=false;status.textContent="Saved"}if(event.data.type==="note-error"){status.classList.add("error");status.textContent="Conflict: "+event.data.message;editor.contentEditable="false";editor.setAttribute("aria-readonly","true");reload.hidden=false}if(event.data.type==="note-reloaded"){setHTML(event.data.html);editor.contentEditable="true";editor.setAttribute("aria-readonly","false");reload.hidden=true;status.classList.remove("error");status.textContent="Latest version loaded"}});</script></body></html>`;
}

export function renderUpstreamReaderHTML({ annotations, attachment, documentUri, frameOrigin, nonce, panelNonce, readerPageUri, readerType, state }) {
  const config = { annotations, documentUri, panelNonce, readerType, state, title: attachment.title };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escapeHtml(frameOrigin)}; style-src 'nonce-${escapeHtml(nonce)}'; script-src 'nonce-${escapeHtml(nonce)}'">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(attachment.title)}</title>
<style nonce="${escapeHtml(nonce)}">html,body{height:100%;margin:0;overflow:hidden;background:var(--vscode-editor-background)}iframe{display:block;border:0;width:100%;height:100%}</style></head>
<body><iframe id="reader-frame" src="${escapeHtml(readerPageUri)}" title="${escapeHtml(attachment.title)}" allow="clipboard-read; clipboard-write"></iframe>
<script id="reader-config" type="application/json">${safeJson(config)}</script>
<script nonce="${escapeHtml(nonce)}">
const vscode = acquireVsCodeApi();
const frame = document.getElementById("reader-frame");
const config = JSON.parse(document.getElementById("reader-config").textContent);
const childOrigin = new URL(frame.src).origin;
const KEY_FIELDS = ["altKey", "code", "ctrlKey", "key", "keyCode", "metaKey", "repeat", "shiftKey"];
const HOST_TO_READER_TYPES = new Set(["pdf-context-error", "upstream-reader-error", "upstream-reader-saved"]);
window.addEventListener("message", event => {
  if (event.source === frame.contentWindow) {
    if (event.origin !== childOrigin) return;
    if (event.data?.type === "chatero-reader-ready") {
      frame.contentWindow.postMessage({ type: "chatero-reader-init", ...config }, childOrigin);
      vscode.postMessage(event.data);
      return;
    }
    if (event.data?.type === "chatero-reader-key") {
      // Keystrokes inside the reader frame never reach the webview host's own
      // key listeners, so re-dispatch them here for workbench keybindings.
      if (event.data.eventType !== "keydown" && event.data.eventType !== "keyup") return;
      const init = {};
      for (const field of KEY_FIELDS) init[field] = event.data[field];
      window.dispatchEvent(new KeyboardEvent(event.data.eventType, init));
      return;
    }
    vscode.postMessage(event.data);
    return;
  }
  // Only genuine extension-host responses go down: a nested frame posting to
  // this window always carries a concrete source that is not our parent.
  if (event.source && event.source !== window.parent) return;
  if (!HOST_TO_READER_TYPES.has(event.data?.type)) return;
  frame.contentWindow?.postMessage(event.data, childOrigin);
});
</script></body></html>`;
}
