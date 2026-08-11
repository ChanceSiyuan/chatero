const bootstrap = document.currentScript ?? document.querySelector("script[data-pdf-uri]");
const canvas = document.getElementById("pdf-canvas");
const pageRoot = document.getElementById("pdf-page");
const textLayer = document.getElementById("text-layer");
const annotationLayer = document.getElementById("annotation-layer");
const pageField = document.getElementById("page-number");
const pageCount = document.getElementById("page-count");
const status = document.getElementById("viewer-status");
const viewportHost = document.getElementById("page-viewport");
const annotations = JSON.parse(document.getElementById("annotation-data")?.textContent || "[]");
const panelNonce = bootstrap?.dataset.panelNonce;
const vscode = acquireVsCodeApi();

const SELECTED_TEXT_MAX_BYTES = 32 * 1024;
const PAGE_TEXT_MAX_BYTES = 128 * 1024;
const PAGE_LABEL_MAX_BYTES = 256;

if (!/^[A-Za-z0-9_-]{24}$/.test(panelNonce || "")) {
  throw new Error("PDF viewer panel nonce is invalid");
}

let documentHandle;
let pdfjs;
let pageLabels = null;
let pageNumber = 1;
let renderGeneration = 0;
let zoom = 1;
let contextSequence = 0;
let currentPageText = "";
let canvasRenderTask = null;
let textLayerRenderTask = null;
let selectionTimer = null;

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

function boundedPage(value) {
  return Math.max(1, Math.min(documentHandle?.numPages || 1, Number(value) || 1));
}

function safeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffd400";
}

function pageAnnotations(index) {
  return annotations.filter(annotation => annotation.pageIndex === index);
}

function currentPageLabel() {
  return boundedUtf8(pageLabels?.[pageNumber - 1] || String(pageNumber), PAGE_LABEL_MAX_BYTES);
}

function textContentValue(content) {
  let value = "";
  for (const item of content?.items || []) {
    if (typeof item?.str !== "string") continue;
    value += item.str;
    value += item.hasEOL ? "\n" : " ";
  }
  return boundedUtf8(value.trim(), PAGE_TEXT_MAX_BYTES);
}

function selectedTextWithinLayer() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return "";
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (!textLayer.contains(range.startContainer)
        || !textLayer.contains(range.endContainer)
        || !textLayer.contains(range.commonAncestorContainer)) {
      return "";
    }
  }
  return boundedUtf8(selection.toString(), SELECTED_TEXT_MAX_BYTES);
}

function makeContextMessage(selectedText) {
  return Object.freeze({
    type: "pdf-context",
    panelNonce,
    sequence: ++contextSequence,
    pageIndex: pageNumber - 1,
    pageLabel: currentPageLabel(),
    pageText: currentPageText,
    selectedText: boundedUtf8(selectedText, SELECTED_TEXT_MAX_BYTES),
  });
}

function postContext(selectedText = selectedTextWithinLayer()) {
  const message = makeContextMessage(selectedText);
  vscode.postMessage(message);
  return message.sequence;
}

function rectangleOverlay(viewport, rectangle, color) {
  if (!Array.isArray(rectangle) || rectangle.length !== 4 || !rectangle.every(Number.isFinite)) return null;
  const points = viewport.convertToViewportRectangle(rectangle);
  const element = document.createElement("span");
  element.className = "pdf-highlight";
  element.style.left = `${Math.min(points[0], points[2])}px`;
  element.style.top = `${Math.min(points[1], points[3])}px`;
  element.style.width = `${Math.abs(points[2] - points[0])}px`;
  element.style.height = `${Math.abs(points[3] - points[1])}px`;
  element.style.backgroundColor = `${safeColor(color)}66`;
  return element;
}

function renderAnnotationLayer(viewport) {
  annotationLayer.replaceChildren();
  for (const annotation of pageAnnotations(pageNumber - 1)) {
    for (const rectangle of annotation.rects) {
      const overlay = rectangleOverlay(viewport, rectangle, annotation.color);
      if (overlay) annotationLayer.append(overlay);
    }
  }
}

function expectedCancellation(error, generation) {
  return generation !== renderGeneration
    || error?.name === "RenderingCancelledException"
    || error?.name === "AbortException";
}

function cancelRenderTasks() {
  const canvasTask = canvasRenderTask;
  const textTask = textLayerRenderTask;
  canvasRenderTask = null;
  textLayerRenderTask = null;
  canvasTask?.cancel();
  textTask?.cancel();
}

function reportRenderError() {
  status.textContent = "PDF page could not be rendered.";
  status.classList.add("error");
}

function scheduleRender(operation) {
  void Promise.resolve().then(operation).catch(reportRenderError);
}

async function renderPage() {
  const generation = ++renderGeneration;
  cancelRenderTasks();
  clearTimeout(selectionTimer);
  window.getSelection()?.removeAllRanges();
  currentPageText = "";
  textLayer.replaceChildren();
  annotationLayer.replaceChildren();
  status.textContent = "Rendering…";
  status.classList.remove("error");
  try {
    const page = await documentHandle.getPage(pageNumber);
    if (generation !== renderGeneration) return;
    const base = page.getViewport({ scale: 1 });
    const fit = Math.max(0.25, (viewportHost.clientWidth - 32) / base.width);
    const viewport = page.getViewport({ scale: fit * zoom });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    pageRoot.style.width = `${viewport.width}px`;
    pageRoot.style.height = `${viewport.height}px`;
    pageRoot.style.setProperty("--scale-factor", String(viewport.scale));
    pageRoot.style.setProperty("--user-unit", String(viewport.userUnit));
    annotationLayer.style.width = `${viewport.width}px`;
    annotationLayer.style.height = `${viewport.height}px`;
    const context = canvas.getContext("2d", { alpha: false });
    const renderTask = page.render({
      canvasContext: context,
      transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
      viewport,
    });
    canvasRenderTask = renderTask;
    const textContentPromise = page.getTextContent();
    let textContent;
    try {
      [, textContent] = await Promise.all([renderTask.promise, textContentPromise]);
    }
    catch (error) {
      if (expectedCancellation(error, generation)) return;
      throw error;
    }
    finally {
      if (canvasRenderTask === renderTask) canvasRenderTask = null;
    }
    if (generation !== renderGeneration) return;

    currentPageText = textContentValue(textContent);
    const layerTask = new pdfjs.TextLayer({
      textContentSource: textContent,
      container: textLayer,
      viewport,
    });
    textLayerRenderTask = layerTask;
    try {
      await layerTask.render();
    }
    catch (error) {
      if (expectedCancellation(error, generation)) return;
      throw error;
    }
    finally {
      if (textLayerRenderTask === layerTask) textLayerRenderTask = null;
    }
    if (generation !== renderGeneration) return;
    renderAnnotationLayer(viewport);
    pageField.value = String(pageNumber);
    status.textContent = "";
    postContext("");
  }
  catch (error) {
    if (expectedCancellation(error, generation)) return;
    throw error;
  }
}

async function goToPage(value) {
  pageNumber = boundedPage(value);
  await renderPage();
}

function parseAnnotations() {
  return annotations.map(annotation => {
    let position = {};
    try { position = JSON.parse(annotation.positionJson); } catch {}
    return {
      ...annotation,
      pageIndex: Number.isSafeInteger(position.pageIndex) ? position.pageIndex : null,
      rects: Array.isArray(position.rects) ? position.rects : [],
    };
  });
}

try {
  pdfjs = await import(bootstrap.dataset.pdfJsUri);
  pdfjs.GlobalWorkerOptions.workerSrc = bootstrap.dataset.workerUri;
  annotations.splice(0, annotations.length, ...parseAnnotations());
  for (const swatch of document.querySelectorAll(".swatch[data-color]")) {
    swatch.style.backgroundColor = safeColor(swatch.dataset.color);
  }
  documentHandle = await pdfjs.getDocument({ url: bootstrap.dataset.pdfUri }).promise;
  pageLabels = await documentHandle.getPageLabels();
  pageCount.textContent = `/ ${documentHandle.numPages}`;
  document.getElementById("previous-page").addEventListener("click", () => scheduleRender(() => goToPage(pageNumber - 1)));
  document.getElementById("next-page").addEventListener("click", () => scheduleRender(() => goToPage(pageNumber + 1)));
  document.getElementById("zoom-out").addEventListener("click", () => { zoom = Math.max(0.5, zoom - 0.1); scheduleRender(renderPage); });
  document.getElementById("zoom-in").addEventListener("click", () => { zoom = Math.min(3, zoom + 0.1); scheduleRender(renderPage); });
  pageField.addEventListener("change", () => scheduleRender(() => goToPage(pageField.value)));
  document.addEventListener("click", event => {
    const target = event.target.closest("[data-page-index]");
    if (target) scheduleRender(() => goToPage(Number(target.dataset.pageIndex) + 1));
  });
  document.addEventListener("keydown", event => {
    if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "k") {
      const selectedText = selectedTextWithinLayer();
      if (selectedText.trim().length > 0) {
        event.preventDefault();
        clearTimeout(selectionTimer);
        const sequence = postContext(selectedText);
        vscode.postMessage(Object.freeze({ type: "pdf-context-attach", panelNonce, sequence }));
      }
      return;
    }
    const target = event.target.closest("[data-page-index]");
    if (target && (event.key === "Enter" || event.key === " ")) scheduleRender(() => goToPage(Number(target.dataset.pageIndex) + 1));
  });
  document.addEventListener("selectionchange", () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => postContext(), 100);
  });
  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => scheduleRender(renderPage), 120);
  }).observe(viewportHost);
  window.addEventListener("unload", () => {
    clearTimeout(selectionTimer);
    clearTimeout(resizeTimer);
    renderGeneration += 1;
    cancelRenderTasks();
  });
  await renderPage();
} catch (error) {
  reportRenderError();
}
