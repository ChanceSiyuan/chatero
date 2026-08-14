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
const selectionMenu = document.getElementById("selection-menu");
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
let areaSelection = null;
let pdfWorker = null;
let pdfWorkerUrl = null;
let pendingSelectionAction = null;
let scrollTurnLocked = false;

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

function rectangleOverlay(viewport, rectangle, annotation) {
  if (!Array.isArray(rectangle) || rectangle.length !== 4 || !rectangle.every(Number.isFinite)) return null;
  const points = viewport.convertToViewportRectangle(rectangle);
  const element = document.createElement("span");
  element.className = `pdf-highlight ${annotation.type}`;
  element.style.left = `${Math.min(points[0], points[2])}px`;
  element.style.top = `${Math.min(points[1], points[3])}px`;
  element.style.width = `${Math.abs(points[2] - points[0])}px`;
  element.style.height = `${Math.abs(points[3] - points[1])}px`;
  element.style.setProperty("--annotation-color", safeColor(annotation.color));
  element.style.backgroundColor = `${safeColor(annotation.color)}66`;
  element.setAttribute("aria-label", `${annotation.type} annotation${annotation.comment ? `: ${annotation.comment}` : ""}`);
  return element;
}

function renderAnnotationLayer(viewport) {
  annotationLayer.replaceChildren();
  for (const annotation of pageAnnotations(pageNumber - 1)) {
    for (const rectangle of annotation.rects) {
      const overlay = rectangleOverlay(viewport, rectangle, annotation);
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

function annotationPosition(value) {
  try {
    const position = JSON.parse(value.positionJson);
    return { ...value, pageIndex: Number.isSafeInteger(position.pageIndex) ? position.pageIndex : null, rects: Array.isArray(position.rects) ? position.rects : [] };
  }
  catch {
    return { ...value, pageIndex: null, rects: [] };
  }
}

function annotationRow(annotation) {
  const article = document.createElement("article");
  article.className = "annotation";
  article.dataset.annotationKey = annotation.annotationKey;
  article.dataset.version = String(annotation.version);
  if (annotation.pageIndex !== null) {
    article.dataset.pageIndex = String(annotation.pageIndex);
    article.tabIndex = 0;
    article.setAttribute("role", "button");
  }
  const meta = document.createElement("div");
  meta.className = "annotation-meta";
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.backgroundColor = safeColor(annotation.color);
  meta.append(swatch, document.createTextNode(`${annotation.type} · Page ${annotation.pageLabel || (annotation.pageIndex === null ? "?" : annotation.pageIndex + 1)}`));
  article.append(meta);
  if (annotation.text) {
    const quote = document.createElement("blockquote");
    quote.textContent = annotation.text;
    article.append(quote);
  }
  if (annotation.comment) {
    const comment = document.createElement("p");
    comment.textContent = annotation.comment;
    article.append(comment);
  }
  if (annotation.tags?.length) {
    const tags = document.createElement("p");
    tags.className = "annotation-tags";
    tags.textContent = annotation.tags.map(tag => `#${tag}`).join(" ");
    article.append(tags);
  }
  const actions = document.createElement("div");
  actions.className = "annotation-actions";
  for (const [action, label] of [["edit-annotation", "Edit"], ["delete-annotation", "Delete"]]) {
    const button = document.createElement("button");
    button.dataset.action = action;
    button.setAttribute("aria-label", `${label} annotation`);
    button.textContent = label;
    actions.append(button);
  }
  article.append(actions);
  return article;
}

function renderAnnotationSidebar() {
  const list = document.getElementById("annotation-list");
  const count = document.getElementById("annotation-count");
  count.textContent = `${annotations.length} Zotero annotation${annotations.length === 1 ? "" : "s"}`;
  list.replaceChildren();
  if (!annotations.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No Zotero highlights or annotations yet.";
    list.append(empty);
    return;
  }
  list.append(...annotations.map(annotationRow));
}

function postAnnotationCreate(annotationType, { comment = "", rects = selectedRectangles(), text = selectedTextWithinLayer() } = {}) {
  if (!rects.length || (["highlight", "underline"].includes(annotationType) && !text.trim())) {
    status.textContent = annotationType === "image" ? "Drag an area on this page first." : "Select text on this page first.";
    return;
  }
  vscode.postMessage({
    type: "annotation-create",
    annotationType,
    color: "#ffd400",
    comment,
    pageLabel: currentPageLabel(),
    positionJson: JSON.stringify({ pageIndex: pageNumber - 1, rects }),
    sortIndex: `${String(pageNumber - 1).padStart(5, "0")}|${String(Date.now()).padStart(15, "0")}|00000`,
    tags: [],
    text,
  });
  status.textContent = "Saving annotation…";
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

function hideSelectionMenu() {
  selectionMenu.hidden = true;
  pendingSelectionAction = null;
}

function showSelectionMenu(event) {
  const text = selectedTextWithinLayer();
  const rects = selectedRectangles();
  if (!text.trim() || !rects.length) return;
  event.preventDefault();
  pendingSelectionAction = Object.freeze({ rects, text });
  selectionMenu.hidden = false;
  selectionMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - 330))}px`;
  selectionMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - 52))}px`;
  selectionMenu.querySelector("button")?.focus({ preventScroll: true });
}

async function turnPageFromScroll(direction) {
  if (scrollTurnLocked || !documentHandle) return;
  const nextPage = pageNumber + direction;
  if (nextPage < 1 || nextPage > documentHandle.numPages) return;
  scrollTurnLocked = true;
  try {
    await goToPage(nextPage);
    viewportHost.scrollTop = direction > 0 ? 0 : viewportHost.scrollHeight;
  }
  finally {
    setTimeout(() => { scrollTurnLocked = false; }, 260);
  }
}

async function loadPdfBytes(url) {
  status.textContent = "Reading local PDF…";
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`PDF request failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength) throw new Error("PDF request returned an empty document");
  return bytes;
}

async function startPdfWorker(url) {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`PDF worker request failed (${response.status})`);
  const source = await response.arrayBuffer();
  if (!source.byteLength) throw new Error("PDF worker request returned an empty module");
  pdfWorkerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  pdfWorker = new Worker(pdfWorkerUrl, { type: "module" });
  return pdfWorker;
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
    try {
      await renderTask.promise;
    }
    catch (error) {
      if (expectedCancellation(error, generation)) return;
      throw error;
    }
    finally {
      if (canvasRenderTask === renderTask) canvasRenderTask = null;
    }
    if (generation !== renderGeneration) return;
    status.textContent = "";

    const textContent = await page.getTextContent();
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
  return annotations.map(annotationPosition);
}

try {
  pdfjs = await import(bootstrap.dataset.pdfJsUri);
  const [pdfBytes, worker] = await Promise.all([
    loadPdfBytes(bootstrap.dataset.pdfUri),
    startPdfWorker(bootstrap.dataset.workerUri),
  ]);
  pdfjs.GlobalWorkerOptions.workerPort = worker;
  annotations.splice(0, annotations.length, ...parseAnnotations());
  for (const swatch of document.querySelectorAll(".swatch[data-color]")) {
    swatch.style.backgroundColor = safeColor(swatch.dataset.color);
  }
  status.textContent = "Opening PDF…";
  documentHandle = await pdfjs.getDocument({ data: pdfBytes }).promise;
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
    postAnnotationCreate("highlight");
  });
  document.getElementById("create-underline").addEventListener("click", () => postAnnotationCreate("underline"));
  document.getElementById("create-area").addEventListener("click", () => {
    areaSelection = { annotationType: "image", armed: true };
    pageRoot.classList.add("area-selecting");
    status.textContent = "Drag across an image or page area.";
  });
  document.getElementById("create-note").addEventListener("click", () => {
    areaSelection = { annotationType: "note", armed: true };
    pageRoot.classList.add("area-selecting");
    status.textContent = "Click a location for the note.";
  });
  document.getElementById("undo-annotation").addEventListener("click", () => vscode.postMessage({ type: "annotation-undo" }));
  pageRoot.addEventListener("pointerdown", event => {
    if (!areaSelection?.armed || !currentViewport) return;
    event.preventDefault();
    const root = pageRoot.getBoundingClientRect();
    if (areaSelection.annotationType === "note") {
      const x = event.clientX - root.left;
      const y = event.clientY - root.top;
      const first = currentViewport.convertToPdfPoint(Math.max(0, x - 8), Math.max(0, y - 8));
      const second = currentViewport.convertToPdfPoint(Math.min(root.width, x + 8), Math.min(root.height, y + 8));
      const rect = [Math.min(first[0], second[0]), Math.min(first[1], second[1]), Math.max(first[0], second[0]), Math.max(first[1], second[1])];
      areaSelection = null;
      pageRoot.classList.remove("area-selecting");
      postAnnotationCreate("note", { rects: [rect], text: "" });
      return;
    }
    const preview = document.createElement("span");
    preview.className = "area-preview";
    pageRoot.append(preview);
    areaSelection = { pointerId: event.pointerId, preview, startX: event.clientX - root.left, startY: event.clientY - root.top };
    pageRoot.setPointerCapture(event.pointerId);
  });
  pageRoot.addEventListener("pointermove", event => {
    if (areaSelection?.pointerId !== event.pointerId) return;
    const root = pageRoot.getBoundingClientRect();
    const x = Math.max(0, Math.min(root.width, event.clientX - root.left));
    const y = Math.max(0, Math.min(root.height, event.clientY - root.top));
    areaSelection.preview.style.left = `${Math.min(areaSelection.startX, x)}px`;
    areaSelection.preview.style.top = `${Math.min(areaSelection.startY, y)}px`;
    areaSelection.preview.style.width = `${Math.abs(x - areaSelection.startX)}px`;
    areaSelection.preview.style.height = `${Math.abs(y - areaSelection.startY)}px`;
  });
  pageRoot.addEventListener("pointerup", event => {
    if (areaSelection?.pointerId !== event.pointerId || !currentViewport) return;
    const root = pageRoot.getBoundingClientRect();
    const endX = Math.max(0, Math.min(root.width, event.clientX - root.left));
    const endY = Math.max(0, Math.min(root.height, event.clientY - root.top));
    const start = currentViewport.convertToPdfPoint(areaSelection.startX, areaSelection.startY);
    const end = currentViewport.convertToPdfPoint(endX, endY);
    const rect = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])];
    areaSelection.preview.remove();
    areaSelection = null;
    pageRoot.classList.remove("area-selecting");
    if ((rect[2] - rect[0]) * (rect[3] - rect[1]) > 16) postAnnotationCreate("image", { rects: [rect], text: "" });
  });
  textLayer.addEventListener("contextmenu", showSelectionMenu);
  selectionMenu.addEventListener("click", event => {
    const action = event.target.closest("[data-selection-action]")?.dataset.selectionAction;
    const selection = pendingSelectionAction;
    if (!action || !selection) return;
    event.preventDefault();
    event.stopPropagation();
    hideSelectionMenu();
    if (action === "highlight-note") {
      const comment = window.prompt("Annotation note", "");
      if (comment === null) return;
      postAnnotationCreate("highlight", { ...selection, comment });
    }
    else postAnnotationCreate(action, selection);
  });
  viewportHost.addEventListener("wheel", event => {
    if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) < 2) return;
    const atTop = viewportHost.scrollTop <= 1;
    const atBottom = viewportHost.scrollTop + viewportHost.clientHeight >= viewportHost.scrollHeight - 1;
    const direction = event.deltaY > 0 ? 1 : -1;
    if ((direction > 0 && atBottom) || (direction < 0 && atTop)) {
      event.preventDefault();
      scheduleRender(() => turnPageFromScroll(direction));
    }
  }, { passive: false });
  viewportHost.addEventListener("scroll", () => {
    if (!selectionMenu.hidden) hideSelectionMenu();
  }, { passive: true });
  pageField.addEventListener("change", () => scheduleRender(() => goToPage(pageField.value)));
  document.addEventListener("click", event => {
    if (!selectionMenu.hidden && !selectionMenu.contains(event.target)) hideSelectionMenu();
    const action = event.target.closest("[data-action]");
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      const row = action.closest("[data-annotation-key]");
      const annotation = annotations.find(value => value.annotationKey === row?.dataset.annotationKey);
      if (!annotation) return;
      if (action.dataset.action === "delete-annotation") {
        if (window.confirm("Delete this Zotero annotation?")) vscode.postMessage({ type: "annotation-delete", annotationKey: annotation.annotationKey, expectedVersion: annotation.version });
      }
      else {
        const comment = window.prompt("Annotation comment", annotation.comment);
        if (comment === null) return;
        const tags = window.prompt("Tags (comma-separated)", annotation.tags.join(", "));
        if (tags === null) return;
        const color = window.prompt("Color (#RRGGBB)", annotation.color);
        if (color === null) return;
        if (!/^#[0-9a-f]{6}$/i.test(color)) return void (status.textContent = "Color must use #RRGGBB.");
        vscode.postMessage({ type: "annotation-update", annotationKey: annotation.annotationKey, color, comment, expectedVersion: annotation.version, tags: tags.split(",").map(value => value.trim()).filter(Boolean) });
      }
      return;
    }
    const target = event.target.closest("[data-page-index]");
    if (target) scheduleRender(() => goToPage(Number(target.dataset.pageIndex) + 1));
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !selectionMenu.hidden) {
      event.preventDefault();
      hideSelectionMenu();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "l") {
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
    void documentHandle?.destroy?.();
    pdfWorker?.terminate();
    if (pdfWorkerUrl) URL.revokeObjectURL(pdfWorkerUrl);
    pdfWorker = null;
    pdfWorkerUrl = null;
  });
  window.addEventListener("message", event => {
    if (event.data?.type === "annotation-error") {
      status.textContent = `Zotero write failed: ${event.data.message}. Reopen the document to resolve the conflict.`;
      status.classList.add("error");
      return;
    }
    if (event.data?.type === "annotation-created" || event.data?.type === "annotation-updated") {
      const next = annotationPosition(event.data.annotation);
      const index = annotations.findIndex(value => value.annotationKey === next.annotationKey);
      if (index === -1) annotations.push(next); else annotations.splice(index, 1, next);
      renderAnnotationSidebar();
      status.textContent = "Saved";
      scheduleRender(renderPage);
      return;
    }
    if (event.data?.type === "annotation-deleted") {
      const index = annotations.findIndex(value => value.annotationKey === event.data.annotationKey);
      if (index !== -1) annotations.splice(index, 1);
      renderAnnotationSidebar();
      scheduleRender(renderPage);
      return;
    }
    if (event.data?.type === "annotation-undone") {
      annotations.splice(0, annotations.length, ...event.data.annotations.map(annotationPosition));
      renderAnnotationSidebar();
      status.textContent = event.data.changed ? "Last annotation change undone" : "Nothing to undo";
      scheduleRender(renderPage);
    }
  });
  renderAnnotationSidebar();
  await renderPage();
} catch (error) {
  reportRenderError();
}
