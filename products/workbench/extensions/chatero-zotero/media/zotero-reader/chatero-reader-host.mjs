const errorBanner = document.getElementById("reader-error");

const SELECTED_TEXT_MAX_BYTES = 32 * 1024;
const PAGE_TEXT_MAX_BYTES = 128 * 1024;
const PAGE_LABEL_MAX_BYTES = 256;
const PAGE_TEXT_CACHE_LIMIT = 8;

function utf8Width(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function boundedUtf8(value, maxBytes) {
  let result = "";
  let used = 0;
  for (const character of String(value)) {
    const width = utf8Width(character);
    if (used + width > maxBytes) break;
    result += character;
    used += width;
  }
  return result;
}

function exposeWriteFailure(message) {
  window._reader?.setReadOnly(true);
  if (errorBanner) {
    errorBanner.hidden = false;
    errorBanner.textContent = `Zotero write failed. Reopen the document before editing again: ${message}`;
  }
}

const init = await new Promise(resolve => {
  const listener = event => {
    if (event.source !== window.parent || event.data?.type !== "chatero-reader-init") return;
    window.removeEventListener("message", listener);
    resolve({ data: event.data, origin: event.origin });
  };
  window.addEventListener("message", listener);
  window.parent.postMessage({ type: "chatero-reader-ready" }, "*");
});

const parentOrigin = init.origin;
const { annotations, documentUri, panelNonce, readerType: type, state, title } = init.data;
const send = message => window.parent.postMessage(message, parentOrigin);

const KEY_FIELDS = ["altKey", "code", "ctrlKey", "key", "keyCode", "metaKey", "repeat", "shiftKey"];

// Keystrokes inside this frame (and the nested pdf.js viewer frame) never
// reach the webview document that VS Code watches for keybindings, so trusted
// key events are relayed up for synthetic re-dispatch there.
function wireKeyRelay(doc, beforeKeydown = null) {
  if (beforeKeydown) doc.addEventListener("keydown", beforeKeydown, true);
  for (const eventType of ["keydown", "keyup"]) {
    doc.addEventListener(eventType, event => {
      if (!event.isTrusted) return;
      const message = { eventType, type: "chatero-reader-key" };
      for (const field of KEY_FIELDS) message[field] = event[field];
      send(message);
    }, true);
  }
}

let sequence = 0;
const pending = new Map();
let contextSequence = 0;
let contextQueue = Promise.resolve();

window.addEventListener("message", event => {
  if (event.source !== window.parent || event.origin !== parentOrigin) return;
  if (event.data?.type === "pdf-context-error") {
    console.warn("Chatero PDF context is temporarily unavailable.");
    return;
  }
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

function primaryViewState() {
  if (type !== "pdf") return state;
  return {
    pageIndex: Number.isSafeInteger(state?.pageIndex) && state.pageIndex >= 0 ? state.pageIndex : 0,
    scale: "page-width",
    scrollMode: 0,
    spreadMode: 0,
  };
}

// -- PDF evidence context (Cmd/Ctrl+Shift+L): the fork pdf.js viewer iframe is
// same-origin with this document, so selection and page text come straight from
// its window, mirroring what the Gecko readerHooks parity surface captures.
function createPdfContext() {
  const frameElements = [];
  const wiredFrames = new WeakSet();
  let pageLabels = null;
  let currentPageIndex = Number.isSafeInteger(state?.pageIndex) && state.pageIndex >= 0 ? state.pageIndex : 0;
  let primed = false;
  let selectionTimer = null;
  let pageTimer = null;
  const pageTextCache = new Map();

  const viewerWindows = () => frameElements.map(element => element.contentWindow).filter(value => value?.PDFViewerApplicationOptions);
  const pdfDocument = () => viewerWindows()[0]?.PDFViewerApplication?.pdfDocument || null;

  async function pageText(pageIndex) {
    if (pageTextCache.has(pageIndex)) return pageTextCache.get(pageIndex);
    const handle = pdfDocument();
    if (!handle) return "";
    let value = "";
    try {
      const content = await handle.getPage(pageIndex + 1).then(page => page.getTextContent());
      for (const item of content?.items || []) {
        if (typeof item?.str !== "string") continue;
        value += item.str;
        value += item.hasEOL ? "\n" : " ";
      }
    }
    catch {
      return "";
    }
    const bounded = boundedUtf8(value.trim(), PAGE_TEXT_MAX_BYTES);
    pageTextCache.set(pageIndex, bounded);
    if (pageTextCache.size > PAGE_TEXT_CACHE_LIMIT) pageTextCache.delete(pageTextCache.keys().next().value);
    return bounded;
  }

  async function pageLabelFor(pageIndex) {
    // Never memoize before the viewer document exists, or every label in the
    // session silently degrades to the bare page number.
    if (pageLabels === null && pdfDocument()) {
      try { pageLabels = (await pdfDocument()?.getPageLabels()) || false; } catch { pageLabels = false; }
    }
    return boundedUtf8((pageLabels && pageLabels[pageIndex]) || String(pageIndex + 1), PAGE_LABEL_MAX_BYTES);
  }

  function selectionInfo() {
    for (const frameWindow of viewerWindows()) {
      const selection = frameWindow.getSelection?.();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) continue;
      const element = node => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement);
      const range = selection.getRangeAt(0);
      // A selection spanning pages has its common ancestor above every text
      // layer; the start container still names the first selected page.
      const layer = element(range.startContainer)?.closest?.(".textLayer")
        || element(range.commonAncestorContainer)?.closest?.(".textLayer");
      const number = Number(layer?.closest("[data-page-number]")?.dataset.pageNumber);
      if (!layer || !Number.isSafeInteger(number) || number < 1) continue;
      return { pageIndex: number - 1, text: boundedUtf8(selection.toString(), SELECTED_TEXT_MAX_BYTES) };
    }
    return null;
  }

  function queueContext() {
    const run = contextQueue.then(async () => {
      const selection = selectionInfo();
      const pageIndex = selection?.pageIndex ?? currentPageIndex;
      const message = {
        type: "pdf-context",
        panelNonce,
        sequence: contextSequence + 1,
        pageIndex,
        pageLabel: await pageLabelFor(pageIndex),
        pageText: await pageText(pageIndex),
        selectedText: selection?.text || "",
      };
      contextSequence = message.sequence;
      send(message);
      return message.sequence;
    });
    contextQueue = run.catch(() => {});
    return run;
  }

  async function attachContext() {
    try {
      const attachSequence = await queueContext();
      send({ panelNonce, sequence: attachSequence, type: "pdf-context-attach" });
    }
    catch {
      console.warn("Chatero could not capture the PDF context.");
    }
  }

  function isAttachKey(event) {
    return (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey
      && (event.code === "KeyL" || event.key === "l" || event.key === "L");
  }

  function onKeydown(event) {
    if (!isAttachKey(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void attachContext();
  }

  function wireFrame(iframe) {
    if (wiredFrames.has(iframe)) return;
    wiredFrames.add(iframe);
    frameElements.push(iframe);
    const prepare = () => {
      const candidate = iframe.contentWindow;
      if (!candidate?.PDFViewerApplicationOptions) return;
      candidate.document.addEventListener("selectionchange", () => {
        clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => void queueContext(), 100);
      });
      wireKeyRelay(candidate.document, onKeydown);
      if (!primed) {
        primed = true;
        void queueContext();
      }
    };
    iframe.addEventListener("load", prepare);
    prepare();
  }

  // The reader creates a pdf.js iframe per view (a second one appears when the
  // user opens split view); keep watching so selection, shortcut, and
  // key-relay listeners land inside every viewer.
  const observer = new MutationObserver(() => {
    for (const iframe of document.querySelectorAll("#split-view iframe")) wireFrame(iframe);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return {
    onKeydown,
    onViewState(next) {
      const pageIndex = Number.isSafeInteger(next?.pageIndex) && next.pageIndex >= 0 ? next.pageIndex : currentPageIndex;
      if (pageIndex === currentPageIndex && primed) return;
      primed = true;
      currentPageIndex = pageIndex;
      clearTimeout(pageTimer);
      pageTimer = setTimeout(() => void queueContext(), 160);
    },
  };
}

const pdfContext = type === "pdf" ? createPdfContext() : null;
wireKeyRelay(document, pdfContext?.onKeydown ?? null);

try {
  const response = await fetch(documentUri);
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
      if (!primary) return;
      pdfContext?.onViewState(next);
      send({ state: next, type: "upstream-reader-state" });
    },
    onClosePopup() {},
    onConfirm(_title, text) { return window.confirm(text); },
    onDeleteAnnotations(ids) {
      // Create-only save batches still call this with an empty array.
      if (!Array.isArray(ids) || !ids.length) return;
      const requestSequence = ++sequence;
      pending.set(requestSequence, {});
      send({ ids, sequence: requestSequence, type: "upstream-reader-delete" });
    },
    onOpenContextMenu(params) { return reader.openContextMenu(params); },
    onOpenLink(url) { send({ type: "pdf-open-link", url }); },
    onOpenTagsPopup() {},
    onRotatePages() { send({ feature: "page rotation", type: "reader-unsupported" }); },
    onSaveAnnotations(values) {
      const requestSequence = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(requestSequence, { reject, resolve });
        send({ annotations: values, sequence: requestSequence, type: "upstream-reader-save" });
      });
    },
    onSetDataTransferAnnotations() {},
    onToggleSidebar() {},
    primaryViewState: primaryViewState(),
    readOnly: false,
    showAnnotations: true,
    sidebarOpen: true,
    sidebarView: "annotations",
    title,
    type,
  });
  // Reader.initializedPromise is never resolved upstream, so nothing may await
  // it; the pdf context primes itself from the first wired viewer frame or the
  // first primary view-state event instead.
}
catch (error) {
  document.body.textContent = `The ${type} document could not be opened: ${error.message}`;
  document.body.className = "chatero-reader-error";
}
