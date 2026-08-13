const bootstrap = document.currentScript ?? document.querySelector("script[data-document-uri]");
const vscode = acquireVsCodeApi();
const type = bootstrap.dataset.readerType;
const annotations = JSON.parse(document.getElementById("annotation-data")?.textContent || "[]");
const state = JSON.parse(document.getElementById("reader-state")?.textContent || "{}");
const errorBanner = document.getElementById("reader-error");
let sequence = 0;
const pending = new Map();

function exposeWriteFailure(message) {
  window._reader?.setReadOnly(true);
  if (errorBanner) {
    errorBanner.hidden = false;
    errorBanner.textContent = `Zotero write failed. Reopen the document before editing again: ${message}`;
  }
}

window.addEventListener("message", event => {
  if (event.data?.type !== "upstream-reader-saved" && event.data?.type !== "upstream-reader-error") return;
  const operation = pending.get(event.data.sequence);
  if (!operation) {
    if (event.data.type === "upstream-reader-error") exposeWriteFailure(event.data.message);
    return;
  }
  pending.delete(event.data.sequence);
  if (event.data.type === "upstream-reader-saved") operation.resolve?.();
  else {
    exposeWriteFailure(event.data.message);
    operation.reject?.(new Error(event.data.message));
  }
});

try {
  const response = await fetch(bootstrap.dataset.documentUri);
  if (!response.ok) throw new Error(`Reader document request failed (${response.status})`);
  const data = new Uint8Array(await response.arrayBuffer());
  const reader = window.createReader({
    annotations,
    authorName: "",
    data: { buf: data },
    enableReadAloud: false,
    loggedIn: false,
    onAddToNote() {},
    onChangeSidebarView() {},
    onChangeSidebarWidth() {},
    onChangeViewState(next, primary) {
      if (primary) vscode.postMessage({ type: "upstream-reader-state", state: next });
    },
    onClosePopup() {},
    onConfirm(_title, text) { return window.confirm(text); },
    onDeleteAnnotations(ids) {
      const requestSequence = ++sequence;
      pending.set(requestSequence, {});
      vscode.postMessage({ type: "upstream-reader-delete", ids, sequence: requestSequence });
    },
    onOpenContextMenu(params) { return reader.openContextMenu(params); },
    onOpenLink(url) { vscode.postMessage({ type: "pdf-open-link", url }); },
    onOpenTagsPopup() {},
    onSaveAnnotations(values) {
      const requestSequence = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(requestSequence, { reject, resolve });
        vscode.postMessage({ type: "upstream-reader-save", annotations: values, sequence: requestSequence });
      });
    },
    onSetDataTransferAnnotations() {},
    onToggleSidebar() {},
    primaryViewState: state,
    readOnly: false,
    showAnnotations: true,
    sidebarOpen: true,
    sidebarView: "annotations",
    title: bootstrap.dataset.title,
    type,
  });
  await reader.initializedPromise;
}
catch (error) {
  document.body.textContent = `The ${type} document could not be opened: ${error.message}`;
  document.body.className = "chatero-reader-error";
}
