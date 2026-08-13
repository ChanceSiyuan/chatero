const bootstrap = document.currentScript ?? document.querySelector("script[data-pdf-uri]");
const canvas = document.getElementById("pdf-canvas");
const pageRoot = document.getElementById("pdf-page");
const textLayer = document.getElementById("text-layer");
const annotationLayer = document.getElementById("annotation-layer");
const linkLayer = document.getElementById("link-layer");
const pageField = document.getElementById("page-number");
const pageCount = document.getElementById("page-count");
const status = document.getElementById("viewer-status");
const viewportHost = document.getElementById("page-viewport");
const annotations = JSON.parse(document.getElementById("annotation-data")?.textContent || "[]");
const initialState = JSON.parse(document.getElementById("reader-state")?.textContent || "{}");
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
let pageNumber = Number.isSafeInteger(initialState.pageIndex) && initialState.pageIndex >= 0 ? initialState.pageIndex + 1 : 1;
let renderGeneration = 0;
let zoom = 1;
let rotation = 0;
let contextSequence = 0;
let currentPageText = "";
let canvasRenderTask = null;
let textLayerRenderTask = null;
let selectionTimer = null;
let currentViewport = null;

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

async function destinationPage(destination) {
  const resolved = typeof destination === "string" ? await documentHandle.getDestination(destination) : destination;
  if (!Array.isArray(resolved) || !resolved[0]) return null;
  const index = await documentHandle.getPageIndex(resolved[0]);
  return Number.isSafeInteger(index) ? index + 1 : null;
}

async function renderLinkLayer(page, viewport, generation) {
  linkLayer.replaceChildren();
  const links = await page.getAnnotations({ intent: "display" });
  if (generation !== renderGeneration) return;
  for (const link of links) {
    if (link.subtype !== "Link" || !Array.isArray(link.rect)) continue;
    const points = viewport.convertToViewportRectangle(link.rect);
    const element = document.createElement("a");
    element.className = "pdf-link";
    element.href = "#";
    element.setAttribute("aria-label", link.url ? `Open link ${link.url}` : "Go to PDF destination");
    element.style.left = `${Math.min(points[0], points[2])}px`;
    element.style.top = `${Math.min(points[1], points[3])}px`;
    element.style.width = `${Math.abs(points[2] - points[0])}px`;
    element.style.height = `${Math.abs(points[3] - points[1])}px`;
    element.addEventListener("click", event => {
      event.preventDefault();
      if (typeof link.url === "string") vscode.postMessage({ type: "pdf-open-link", url: link.url });
      else scheduleRender(async () => {
        const target = await destinationPage(link.dest);
        if (target !== null) await goToPage(target);
      });
    });
    linkLayer.append(element);
  }
}

function selectedRectangles() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !currentViewport) return [];
  const root = pageRoot.getBoundingClientRect();
  const values = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (!textLayer.contains(range.commonAncestorContainer)) continue;
    for (const rectangle of range.getClientRects()) {
      const left = Math.max(0, rectangle.left - root.left);
      const top = Math.max(0, rectangle.top - root.top);
      const right = Math.min(root.width, rectangle.right - root.left);
      const bottom = Math.min(root.height, rectangle.bottom - root.top);
      if (right <= left || bottom <= top) continue;
      const first = currentViewport.convertToPdfPoint(left, bottom);
      const second = currentViewport.convertToPdfPoint(right, top);
      values.push([Math.min(first[0], second[0]), Math.min(first[1], second[1]), Math.max(first[0], second[0]), Math.max(first[1], second[1])]);
    }
  }
  return values.slice(0, 200);
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
  linkLayer.replaceChildren();
  status.textContent = "Rendering…";
  status.classList.remove("error");
  try {
    const page = await documentHandle.getPage(pageNumber);
    if (generation !== renderGeneration) return;
    const base = page.getViewport({ scale: 1 });
    const fit = Math.max(0.25, (viewportHost.clientWidth - 32) / base.width);
    const viewport = page.getViewport({ rotation, scale: fit * zoom });
    currentViewport = viewport;
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
    linkLayer.style.width = `${viewport.width}px`;
    linkLayer.style.height = `${viewport.height}px`;
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
    await renderLinkLayer(page, viewport, generation);
    renderAnnotationLayer(viewport);
    pageField.value = String(pageNumber);
    status.textContent = "";
    postContext("");
    vscode.postMessage({ type: "reader-state", pageIndex: pageNumber - 1 });
  }
  catch (error) {
    if (expectedCancellation(error, generation)) return;
    throw error;
  }
}

async function findNext() {
  const query = document.getElementById("find-text").value.trim().toLocaleLowerCase();
  if (!query) return;
  status.textContent = "Searching…";
  for (let offset = 0; offset < documentHandle.numPages; offset += 1) {
    const candidate = ((pageNumber - 1 + offset) % documentHandle.numPages) + 1;
    const page = await documentHandle.getPage(candidate);
    const text = textContentValue(await page.getTextContent()).toLocaleLowerCase();
    if (text.includes(query)) {
      await goToPage(candidate);
      status.textContent = `Found on page ${currentPageLabel()}`;
      return;
    }
  }
  status.textContent = "No matches found";
}

async function showOutline() {
  const host = document.getElementById("reader-navigation");
  const body = document.getElementById("reader-body");
  if (body.classList.contains("navigation-open") && host.dataset.mode === "outline") return body.classList.remove("navigation-open");
  host.dataset.mode = "outline";
  host.replaceChildren();
  const outline = await documentHandle.getOutline();
  const append = (items, depth = 0) => {
    for (const item of items || []) {
      const button = document.createElement("button");
      button.textContent = item.title || "Untitled section";
      button.style.paddingLeft = `${10 + Math.min(depth, 8) * 12}px`;
      button.addEventListener("click", () => scheduleRender(async () => {
        const target = await destinationPage(item.dest);
        if (target !== null) await goToPage(target);
      }));
      host.append(button);
      append(item.items, depth + 1);
    }
  };
  append(outline);
  if (!host.childElementCount) host.textContent = "This PDF has no outline.";
  body.classList.add("navigation-open");
}

async function showThumbnails() {
  const host = document.getElementById("reader-navigation");
  const body = document.getElementById("reader-body");
  if (body.classList.contains("navigation-open") && host.dataset.mode === "thumbnails") return body.classList.remove("navigation-open");
  host.dataset.mode = "thumbnails";
  host.replaceChildren();
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting || entry.target.dataset.rendered) continue;
      entry.target.dataset.rendered = "true";
      observer.unobserve(entry.target);
      scheduleRender(async () => {
        const page = await documentHandle.getPage(Number(entry.target.dataset.page));
        const viewport = page.getViewport({ scale: 0.22 });
        const thumbnail = entry.target.querySelector("canvas");
        thumbnail.width = Math.floor(viewport.width);
        thumbnail.height = Math.floor(viewport.height);
        await page.render({ canvasContext: thumbnail.getContext("2d"), viewport }).promise;
      });
    }
  }, { root: host, rootMargin: "300px" });
  for (let value = 1; value <= documentHandle.numPages; value += 1) {
    const row = document.createElement("div");
    row.className = "thumbnail";
    row.dataset.page = String(value);
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `Go to page ${value}`);
    row.innerHTML = `<canvas></canvas><span>${value}</span>`;
    row.addEventListener("click", () => scheduleRender(() => goToPage(value)));
    row.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") scheduleRender(() => goToPage(value));
    });
    host.append(row);
    observer.observe(row);
  }
  body.classList.add("navigation-open");
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
  pageNumber = boundedPage(pageNumber);
  pageLabels = await documentHandle.getPageLabels();
  pageCount.textContent = `/ ${documentHandle.numPages}`;
  document.getElementById("previous-page").addEventListener("click", () => scheduleRender(() => goToPage(pageNumber - 1)));
  document.getElementById("next-page").addEventListener("click", () => scheduleRender(() => goToPage(pageNumber + 1)));
  document.getElementById("zoom-out").addEventListener("click", () => { zoom = Math.max(0.5, zoom - 0.1); scheduleRender(renderPage); });
  document.getElementById("zoom-in").addEventListener("click", () => { zoom = Math.min(3, zoom + 0.1); scheduleRender(renderPage); });
  document.getElementById("rotate-page").addEventListener("click", () => { rotation = (rotation + 90) % 360; scheduleRender(renderPage); });
  document.getElementById("find-next").addEventListener("click", () => scheduleRender(findNext));
  document.getElementById("find-text").addEventListener("keydown", event => {
    if (event.key === "Enter") scheduleRender(findNext);
  });
  document.getElementById("toggle-outline").addEventListener("click", () => scheduleRender(showOutline));
  document.getElementById("toggle-thumbnails").addEventListener("click", () => scheduleRender(showThumbnails));
  document.getElementById("print-pdf").addEventListener("click", () => window.print());
  document.getElementById("export-pdf").addEventListener("click", () => vscode.postMessage({ type: "pdf-export" }));
  document.getElementById("create-highlight").addEventListener("click", () => {
    const text = selectedTextWithinLayer();
    const rects = selectedRectangles();
    if (!text.trim() || !rects.length) {
      status.textContent = "Select text on this page before creating a highlight.";
      return;
    }
    vscode.postMessage({
      type: "annotation-create",
      pageLabel: currentPageLabel(),
      positionJson: JSON.stringify({ pageIndex: pageNumber - 1, rects }),
      sortIndex: `${String(pageNumber - 1).padStart(5, "0")}|${String(Date.now()).padStart(15, "0")}|00000`,
      text,
    });
  });
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
  window.addEventListener("message", event => {
    if (event.data?.type !== "annotation-created") return;
    const created = event.data.annotation;
    try {
      const position = JSON.parse(created.positionJson);
      annotations.push({ ...created, pageIndex: position.pageIndex, rects: position.rects || [] });
      scheduleRender(renderPage);
    }
    catch { status.textContent = "The new annotation could not be displayed."; }
  });
  await renderPage();
} catch (error) {
  reportRenderError();
}
