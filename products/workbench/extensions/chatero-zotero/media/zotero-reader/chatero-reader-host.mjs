const bootstrap = document.currentScript ?? document.querySelector("script[data-document-uri]");
const vscode = acquireVsCodeApi();
const type = bootstrap.dataset.readerType;
const annotations = JSON.parse(document.getElementById("annotation-data")?.textContent || "[]");
const state = JSON.parse(document.getElementById("reader-state")?.textContent || "{}");
let sequence = 0;
const pending = new Map();

window.addEventListener("message", event => {
  if (event.data?.type !== "upstream-reader-saved" && event.data?.type !== "upstream-reader-error") return;
  const operation = pending.get(event.data.sequence);
  if (!operation) return;
  pending.delete(event.data.sequence);
  if (event.data.type === "upstream-reader-saved") operation.resolve();
  else {
    operation.reject(new Error(event.data.message));
    window._reader?.setReadOnly(true);
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
    onDeleteAnnotations(ids) { vscode.postMessage({ type: "upstream-reader-delete", ids, sequence: ++sequence }); },
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
