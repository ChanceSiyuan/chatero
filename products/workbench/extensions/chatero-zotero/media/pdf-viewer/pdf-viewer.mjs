const bootstrap = document.currentScript ?? document.querySelector("script[data-pdf-uri]");
const pageField = document.getElementById("page-number");
const pageCount = document.getElementById("page-count");
const status = document.getElementById("viewer-status");
const viewportHost = document.getElementById("page-viewport");
const pagesHost = document.getElementById("pdf-pages");
const selectionMenu = document.getElementById("selection-menu");
const annotations = JSON.parse(document.getElementById("annotation-data")?.textContent || "[]");
const initialState = JSON.parse(document.getElementById("reader-state")?.textContent || "{}");
const panelNonce = bootstrap?.dataset.panelNonce;
const vscode = acquireVsCodeApi();

const SELECTED_TEXT_MAX_BYTES = 32 * 1024;
const PAGE_TEXT_MAX_BYTES = 128 * 1024;
const PAGE_LABEL_MAX_BYTES = 256;

if (!/^[A-Za-z0-9_-]{24}$/.test(panelNonce || "")) throw new Error("PDF viewer panel nonce is invalid");

let documentHandle;
let pdfjs;
let pageLabels = null;
let pageNumber = Number.isSafeInteger(initialState.pageIndex) && initialState.pageIndex >= 0 ? initialState.pageIndex + 1 : 1;
let zoom = 1;
let renderedZoom = 1;
let rotation = 0;
let contextSequence = 0;
let renderGeneration = 0;
let pageObserver = null;
let selectionTimer = null;
let resizeTimer = null;
let wheelZoomTimer = null;
let wheelZoomAnchor = null;
let scrollFrame = null;
let contextTimer = null;
let areaSelection = null;
let pendingSelectionAction = null;
let rebuildingPages = false;
let lastLayoutWidth = 0;
let pdfWorker = null;
let pdfWorkerUrl = null;
let lastReaderPage = pageNumber;
const pages = new Map();

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

function pageLabel(value = pageNumber) {
  return boundedUtf8(pageLabels?.[value - 1] || String(value), PAGE_LABEL_MAX_BYTES);
}

function currentPageLabel() {
  return pageLabel(pageNumber);
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

function elementForNode(node) {
  return node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
}

function selectionDetails() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  let layer = null;
  let state = null;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    const startLayer = elementForNode(range.startContainer)?.closest?.(".textLayer");
    const endLayer = elementForNode(range.endContainer)?.closest?.(".textLayer");
    const commonLayer = elementForNode(range.commonAncestorContainer)?.closest?.(".textLayer");
    if (!startLayer || startLayer !== endLayer || startLayer !== commonLayer) return null;
    if (layer && layer !== startLayer) return null;
    layer = startLayer;
    state = pages.get(Number(layer.closest(".page")?.dataset.pageNumber));
  }
  if (!layer || !state?.viewport) return null;
  return { layer, selection, state, text: boundedUtf8(selection.toString(), SELECTED_TEXT_MAX_BYTES) };
}

function selectedTextWithinLayer() {
  return selectionDetails()?.text || "";
}

function selectedRectangles(details = selectionDetails()) {
  if (!details) return [];
  const root = details.state.root.getBoundingClientRect();
  const values = [];
  for (let index = 0; index < details.selection.rangeCount; index += 1) {
    const range = details.selection.getRangeAt(index);
    if (!details.layer.contains(range.commonAncestorContainer)) continue;
    for (const rectangle of range.getClientRects()) {
      const left = Math.max(0, rectangle.left - root.left);
      const top = Math.max(0, rectangle.top - root.top);
      const right = Math.min(root.width, rectangle.right - root.left);
      const bottom = Math.min(root.height, rectangle.bottom - root.top);
      if (right <= left || bottom <= top) continue;
      const first = details.state.viewport.convertToPdfPoint(left, bottom);
      const second = details.state.viewport.convertToPdfPoint(right, top);
      values.push([Math.min(first[0], second[0]), Math.min(first[1], second[1]), Math.max(first[0], second[0]), Math.max(first[1], second[1])]);
    }
  }
  return values.slice(0, 200);
}

function selectionOffset(details) {
  const range = details?.selection?.getRangeAt(0);
  if (!range) return 0;
  try {
    const prefix = document.createRange();
    prefix.selectNodeContents(details.layer);
    prefix.setEnd(range.startContainer, range.startOffset);
    return Math.max(0, prefix.toString().length);
  }
  catch {
    return 0;
  }
}

function sortIndexFor(pageIndex, offset = 0, top = 0) {
  return [
    String(Math.max(0, pageIndex)).slice(0, 5).padStart(5, "0"),
    String(Math.max(0, Math.floor(offset))).slice(0, 6).padStart(6, "0"),
    String(Math.max(0, Math.floor(top))).slice(0, 5).padStart(5, "0"),
  ].join("|");
}

function makeContextMessage(selectedText, state = pages.get(pageNumber)) {
  return Object.freeze({
    type: "pdf-context",
    panelNonce,
    sequence: ++contextSequence,
    pageIndex: (state?.number || pageNumber) - 1,
    pageLabel: pageLabel(state?.number || pageNumber),
    pageText: state?.pageText || "",
    selectedText: boundedUtf8(selectedText, SELECTED_TEXT_MAX_BYTES),
  });
}

function postContext(selectedText = selectedTextWithinLayer(), state = selectionDetails()?.state || pages.get(pageNumber)) {
  const message = makeContextMessage(selectedText, state);
  vscode.postMessage(message);
  return message.sequence;
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

function renderAnnotationLayer(state) {
  state.annotationLayer.replaceChildren();
  for (const annotation of pageAnnotations(state.number - 1)) {
    for (const rectangle of annotation.rects) {
      const overlay = rectangleOverlay(state.viewport, rectangle, annotation);
      if (overlay) state.annotationLayer.append(overlay);
    }
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

function postAnnotationCreate(annotationType, options = {}) {
  const details = options.details || selectionDetails();
  const state = options.state || details?.state || pages.get(pageNumber);
  const rects = options.rects || selectedRectangles(details);
  const text = options.text ?? details?.text ?? "";
  if (!state || !rects.length || (["highlight", "underline"].includes(annotationType) && !text.trim())) {
    status.textContent = annotationType === "image" ? "Drag an area on this page first." : "Select text on one page first.";
    return;
  }
  const offset = options.offset ?? selectionOffset(details);
  const top = options.top ?? Math.max(0, Math.min(...rects.map(rect => rect[1])));
  vscode.postMessage({
    type: "annotation-create",
    annotationType,
    color: "#ffd400",
    comment: options.comment || "",
    pageLabel: pageLabel(state.number),
    positionJson: JSON.stringify({ pageIndex: state.number - 1, rects }),
    sortIndex: sortIndexFor(state.number - 1, offset, top),
    tags: [],
    text,
  });
  status.textContent = "Saving annotation…";
}

function expectedCancellation(error, generation) {
  return generation !== renderGeneration || error?.name === "RenderingCancelledException" || error?.name === "AbortException";
}

function cancelPageRender(state) {
  const canvasTask = state.canvasRenderTask;
  const textTask = state.textLayerRenderTask;
  state.canvasRenderTask = null;
  state.textLayerRenderTask = null;
  canvasTask?.cancel();
  textTask?.cancel();
}

function cancelRenderTasks() {
  for (const state of pages.values()) cancelPageRender(state);
}

function reportRenderError(error) {
  status.textContent = `PDF page could not be rendered${error?.message ? `: ${error.message}` : "."}`;
  status.classList.add("error");
}

function scheduleRender(operation) {
  void Promise.resolve().then(operation).catch(reportRenderError);
}

async function destinationPage(destination) {
  const resolved = typeof destination === "string" ? await documentHandle.getDestination(destination) : destination;
  if (!Array.isArray(resolved) || !resolved[0]) return null;
  const index = await documentHandle.getPageIndex(resolved[0]);
  return Number.isSafeInteger(index) ? index + 1 : null;
}

async function renderLinkLayer(state, generation) {
  state.linkLayer.replaceChildren();
  const links = await state.page.getAnnotations({ intent: "display" });
  if (generation !== renderGeneration) return;
  for (const link of links) {
    if (link.subtype !== "Link" || !Array.isArray(link.rect)) continue;
    const points = state.viewport.convertToViewportRectangle(link.rect);
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
    state.linkLayer.append(element);
  }
}

async function renderPageState(state) {
  if (state.rendered) return state;
  if (state.rendering) return state.rendering;
  const generation = renderGeneration;
  state.rendering = (async () => {
    try {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      state.canvas.width = Math.floor(state.viewport.width * ratio);
      state.canvas.height = Math.floor(state.viewport.height * ratio);
      const context = state.canvas.getContext("2d", { alpha: false });
      const renderTask = state.page.render({
        canvasContext: context,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
        viewport: state.viewport,
      });
      state.canvasRenderTask = renderTask;
      try { await renderTask.promise; }
      catch (error) { if (expectedCancellation(error, generation)) return state; throw error; }
      finally { if (state.canvasRenderTask === renderTask) state.canvasRenderTask = null; }
      if (generation !== renderGeneration) return state;
      status.textContent = "";
      const textContent = await state.page.getTextContent();
      if (generation !== renderGeneration) return state;
      state.pageText = textContentValue(textContent);
      const layerTask = new pdfjs.TextLayer({ textContentSource: textContent, container: state.textLayer, viewport: state.viewport });
      state.textLayerRenderTask = layerTask;
      try { await layerTask.render(); }
      catch (error) { if (expectedCancellation(error, generation)) return state; throw error; }
      finally { if (state.textLayerRenderTask === layerTask) state.textLayerRenderTask = null; }
      if (generation !== renderGeneration) return state;
      await renderLinkLayer(state, generation);
      renderAnnotationLayer(state);
      state.rendered = true;
      state.root.dataset.rendered = "true";
      if (state.number === pageNumber) postContext("", state);
      return state;
    }
    finally {
      state.rendering = null;
    }
  })();
  return state.rendering;
}

function createPageRoot(number, viewport, page) {
  const root = document.createElement("section");
  root.className = "page";
  root.dataset.pageNumber = String(number);
  root.setAttribute("aria-label", `PDF page ${pageLabel(number)}`);
  root.style.width = `${viewport.width}px`;
  root.style.height = `${viewport.height}px`;
  root.style.setProperty("--scale-factor", String(viewport.scale));
  root.style.setProperty("--user-unit", String(viewport.userUnit));
  const canvas = document.createElement("canvas");
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  canvas.setAttribute("aria-label", `Rendered PDF page ${number}`);
  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  const annotationLayer = document.createElement("div");
  annotationLayer.className = "annotation-layer";
  const linkLayer = document.createElement("div");
  linkLayer.className = "link-layer";
  for (const layer of [annotationLayer, linkLayer]) {
    layer.style.width = `${viewport.width}px`;
    layer.style.height = `${viewport.height}px`;
  }
  const label = document.createElement("span");
  label.className = "page-number-label";
  label.textContent = pageLabel(number);
  root.append(canvas, textLayer, annotationLayer, linkLayer, label);
  return { annotationLayer, canvas, canvasRenderTask: null, linkLayer, number, page, pageText: "", rendered: false, rendering: null, root, textLayer, textLayerRenderTask: null, viewport };
}

function captureScrollAnchor() {
  const host = viewportHost.getBoundingClientRect();
  const center = host.top + host.height / 2;
  let best = pages.get(pageNumber);
  let distance = Infinity;
  for (const state of pages.values()) {
    const rect = state.root.getBoundingClientRect();
    const current = center < rect.top ? rect.top - center : center > rect.bottom ? center - rect.bottom : 0;
    if (current < distance) { best = state; distance = current; }
  }
  if (!best) return { number: pageNumber, ratio: 0, viewportY: host.height / 2 };
  const rect = best.root.getBoundingClientRect();
  return { number: best.number, ratio: Math.max(0, Math.min(1, (center - rect.top) / Math.max(1, rect.height))), viewportY: host.height / 2 };
}

function capturePointAnchor(clientX, clientY) {
  const host = viewportHost.getBoundingClientRect();
  let best = pages.get(pageNumber);
  let distance = Infinity;
  for (const state of pages.values()) {
    const rect = state.root.getBoundingClientRect();
    const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    const current = dx * dx + dy * dy;
    if (current < distance) { best = state; distance = current; }
  }
  if (!best) return captureScrollAnchor();
  const rect = best.root.getBoundingClientRect();
  return {
    number: best.number,
    ratio: Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height))),
    ratioX: Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width))),
    viewportX: clientX - host.left,
    viewportY: clientY - host.top,
  };
}

async function rebuildPages(anchor = captureScrollAnchor()) {
  const generation = ++renderGeneration;
  rebuildingPages = true;
  try {
    status.classList.remove("error");
    const pdfPages = await Promise.all(Array.from({ length: documentHandle.numPages }, (_, index) => documentHandle.getPage(index + 1)));
    if (generation !== renderGeneration) return;
    const availableWidth = Math.max(240, viewportHost.clientWidth - 40);
    const nextPages = new Map();
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < pdfPages.length; index += 1) {
      const page = pdfPages[index];
      const base = page.getViewport({ rotation, scale: 1 });
      const fit = Math.max(0.25, availableWidth / base.width);
      const viewport = page.getViewport({ rotation, scale: fit * zoom });
      const state = createPageRoot(index + 1, viewport, page);
      nextPages.set(state.number, state);
      fragment.append(state.root);
    }
    const target = nextPages.get(boundedPage(anchor.number)) || nextPages.values().next().value;
    await Promise.all([nextPages.get((target?.number || 1) - 1), target, nextPages.get((target?.number || 1) + 1)].filter(Boolean).map(renderPageState));
    if (generation !== renderGeneration) return;
    pageObserver?.disconnect();
    cancelRenderTasks();
    pages.clear();
    for (const [number, state] of nextPages) pages.set(number, state);
    pagesHost.style.zoom = "";
    pagesHost.replaceChildren(fragment);
    renderedZoom = zoom;
    pageObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) scheduleRender(() => renderPageState(pages.get(Number(entry.target.dataset.pageNumber))));
      }
    }, { root: viewportHost, rootMargin: "1200px 0px" });
    for (const state of pages.values()) pageObserver.observe(state.root);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (generation !== renderGeneration) return;
    if (target) {
      const host = viewportHost.getBoundingClientRect();
      const rect = target.root.getBoundingClientRect();
      const viewportY = Number.isFinite(anchor.viewportY) ? anchor.viewportY : host.height / 2;
      viewportHost.scrollTop += rect.top + rect.height * anchor.ratio - host.top - viewportY;
      if (Number.isFinite(anchor.ratioX) && Number.isFinite(anchor.viewportX)) {
        viewportHost.scrollLeft += rect.left + rect.width * anchor.ratioX - host.left - anchor.viewportX;
      }
    }
    pageNumber = target?.number || 1;
    pageField.value = String(pageNumber);
    status.textContent = "";
    lastLayoutWidth = viewportHost.clientWidth;
  }
  finally {
    if (generation === renderGeneration) rebuildingPages = false;
  }
}

function updateCurrentPageFromScroll() {
  scrollFrame = null;
  const host = viewportHost.getBoundingClientRect();
  const center = host.top + host.height / 2;
  let closest = null;
  let distance = Infinity;
  for (const state of pages.values()) {
    const rect = state.root.getBoundingClientRect();
    const current = center < rect.top ? rect.top - center : center > rect.bottom ? center - rect.bottom : 0;
    if (current < distance) { closest = state; distance = current; }
    if (current === 0) break;
  }
  if (!closest || closest.number === pageNumber) return;
  pageNumber = closest.number;
  pageField.value = String(pageNumber);
  scheduleRender(() => renderPageState(closest));
  clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    if (lastReaderPage !== pageNumber) {
      lastReaderPage = pageNumber;
      vscode.postMessage({ type: "reader-state", pageIndex: pageNumber - 1 });
    }
    const state = pages.get(pageNumber);
    if (state?.rendered) postContext("", state);
  }, 160);
}

async function goToPage(value) {
  const target = pages.get(boundedPage(value));
  if (!target) return;
  pageNumber = target.number;
  pageField.value = String(pageNumber);
  viewportHost.scrollTop = Math.max(0, target.root.offsetTop - 18);
  await renderPageState(target);
  if (lastReaderPage !== pageNumber) {
    lastReaderPage = pageNumber;
    vscode.postMessage({ type: "reader-state", pageIndex: pageNumber - 1 });
  }
  postContext("", target);
}

async function findNext() {
  const query = document.getElementById("find-text").value.trim().toLocaleLowerCase();
  if (!query) return;
  status.textContent = "Searching…";
  for (let offset = 1; offset <= documentHandle.numPages; offset += 1) {
    const candidate = ((pageNumber - 1 + offset) % documentHandle.numPages) + 1;
    const state = pages.get(candidate);
    const text = state?.pageText || textContentValue(await state.page.getTextContent());
    state.pageText ||= text;
    if (text.toLocaleLowerCase().includes(query)) {
      await goToPage(candidate);
      status.textContent = `Found on page ${pageLabel(candidate)}`;
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
        const page = pages.get(Number(entry.target.dataset.page))?.page;
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
    row.innerHTML = `<canvas></canvas><span>${pageLabel(value)}</span>`;
    row.addEventListener("click", () => scheduleRender(() => goToPage(value)));
    row.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") scheduleRender(() => goToPage(value)); });
    host.append(row);
    observer.observe(row);
  }
  body.classList.add("navigation-open");
}

function hideSelectionMenu() {
  selectionMenu.hidden = true;
  pendingSelectionAction = null;
}

function showSelectionMenu(event) {
  const details = selectionDetails();
  const rects = selectedRectangles(details);
  if (!details?.text.trim() || !rects.length) return;
  event.preventDefault();
  pendingSelectionAction = Object.freeze({ details, offset: selectionOffset(details), rects, state: details.state, text: details.text });
  selectionMenu.hidden = false;
  selectionMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - 330))}px`;
  selectionMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - 52))}px`;
  selectionMenu.querySelector("button")?.focus({ preventScroll: true });
}

function setAreaMode(annotationType) {
  areaSelection = { annotationType, armed: true };
  for (const state of pages.values()) state.root.classList.add("area-selecting");
  status.textContent = annotationType === "note" ? "Click a location for the note." : "Drag across an image or page area.";
}

function clearAreaMode() {
  areaSelection?.preview?.remove();
  areaSelection = null;
  for (const state of pages.values()) state.root.classList.remove("area-selecting");
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

try {
  pdfjs = await import(bootstrap.dataset.pdfJsUri);
  const [pdfBytes, worker] = await Promise.all([loadPdfBytes(bootstrap.dataset.pdfUri), startPdfWorker(bootstrap.dataset.workerUri)]);
  pdfjs.GlobalWorkerOptions.workerPort = worker;
  annotations.splice(0, annotations.length, ...annotations.map(annotationPosition));
  for (const swatch of document.querySelectorAll(".swatch[data-color]")) swatch.style.backgroundColor = safeColor(swatch.dataset.color);
  status.textContent = "Opening PDF…";
  documentHandle = await pdfjs.getDocument({ data: pdfBytes }).promise;
  pageNumber = boundedPage(pageNumber);
  lastReaderPage = pageNumber;
  pageLabels = await documentHandle.getPageLabels();
  pageCount.textContent = `/ ${documentHandle.numPages}`;

  document.getElementById("previous-page").addEventListener("click", () => scheduleRender(() => goToPage(pageNumber - 1)));
  document.getElementById("next-page").addEventListener("click", () => scheduleRender(() => goToPage(pageNumber + 1)));
  document.getElementById("zoom-out").addEventListener("click", () => { const anchor = captureScrollAnchor(); zoom = Math.max(0.5, zoom - 0.1); scheduleRender(() => rebuildPages(anchor)); });
  document.getElementById("zoom-in").addEventListener("click", () => { const anchor = captureScrollAnchor(); zoom = Math.min(3, zoom + 0.1); scheduleRender(() => rebuildPages(anchor)); });
  document.getElementById("rotate-page").addEventListener("click", () => { const anchor = captureScrollAnchor(); rotation = (rotation + 90) % 360; scheduleRender(() => rebuildPages(anchor)); });
  document.getElementById("find-next").addEventListener("click", () => scheduleRender(findNext));
  document.getElementById("find-text").addEventListener("keydown", event => { if (event.key === "Enter") scheduleRender(findNext); });
  document.getElementById("toggle-outline").addEventListener("click", () => scheduleRender(showOutline));
  document.getElementById("toggle-thumbnails").addEventListener("click", () => scheduleRender(showThumbnails));
  document.getElementById("print-pdf").addEventListener("click", () => window.print());
  document.getElementById("export-pdf").addEventListener("click", () => vscode.postMessage({ type: "pdf-export" }));
  document.getElementById("create-highlight").addEventListener("click", () => postAnnotationCreate("highlight"));
  document.getElementById("create-underline").addEventListener("click", () => postAnnotationCreate("underline"));
  document.getElementById("create-area").addEventListener("click", () => setAreaMode("image"));
  document.getElementById("create-note").addEventListener("click", () => setAreaMode("note"));
  document.getElementById("undo-annotation").addEventListener("click", () => vscode.postMessage({ type: "annotation-undo" }));
  pageField.addEventListener("change", () => scheduleRender(() => goToPage(pageField.value)));

  pagesHost.addEventListener("pointerdown", event => {
    if (!areaSelection?.armed) return;
    const root = event.target.closest(".page");
    const state = pages.get(Number(root?.dataset.pageNumber));
    if (!state?.viewport) return;
    event.preventDefault();
    const bounds = root.getBoundingClientRect();
    if (areaSelection.annotationType === "note") {
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const first = state.viewport.convertToPdfPoint(Math.max(0, x - 8), Math.max(0, y - 8));
      const second = state.viewport.convertToPdfPoint(Math.min(bounds.width, x + 8), Math.min(bounds.height, y + 8));
      const rect = [Math.min(first[0], second[0]), Math.min(first[1], second[1]), Math.max(first[0], second[0]), Math.max(first[1], second[1])];
      clearAreaMode();
      postAnnotationCreate("note", { offset: 0, rects: [rect], state, text: "", top: y });
      return;
    }
    const preview = document.createElement("span");
    preview.className = "area-preview";
    root.append(preview);
    areaSelection = { annotationType: "image", pointerId: event.pointerId, preview, root, startX: event.clientX - bounds.left, startY: event.clientY - bounds.top, state };
    root.setPointerCapture(event.pointerId);
  });
  pagesHost.addEventListener("pointermove", event => {
    if (areaSelection?.pointerId !== event.pointerId) return;
    const bounds = areaSelection.root.getBoundingClientRect();
    const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
    const y = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
    areaSelection.preview.style.left = `${Math.min(areaSelection.startX, x)}px`;
    areaSelection.preview.style.top = `${Math.min(areaSelection.startY, y)}px`;
    areaSelection.preview.style.width = `${Math.abs(x - areaSelection.startX)}px`;
    areaSelection.preview.style.height = `${Math.abs(y - areaSelection.startY)}px`;
  });
  pagesHost.addEventListener("pointerup", event => {
    if (areaSelection?.pointerId !== event.pointerId) return;
    const active = areaSelection;
    const bounds = active.root.getBoundingClientRect();
    const endX = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
    const endY = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
    const start = active.state.viewport.convertToPdfPoint(active.startX, active.startY);
    const end = active.state.viewport.convertToPdfPoint(endX, endY);
    const rect = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])];
    clearAreaMode();
    if ((rect[2] - rect[0]) * (rect[3] - rect[1]) > 16) postAnnotationCreate("image", { offset: 0, rects: [rect], state: active.state, text: "", top: Math.min(active.startY, endY) });
  });
  pagesHost.addEventListener("contextmenu", event => { if (event.target.closest(".textLayer")) showSelectionMenu(event); });
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
  viewportHost.addEventListener("scroll", () => {
    if (!selectionMenu.hidden) hideSelectionMenu();
    if (scrollFrame === null) scrollFrame = requestAnimationFrame(updateCurrentPageFromScroll);
  }, { passive: true });
  viewportHost.addEventListener("wheel", event => {
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewportHost.clientHeight : 1;
    if (!event.ctrlKey && !event.metaKey) {
      viewportHost.scrollLeft += event.deltaX * unit;
      viewportHost.scrollTop += event.deltaY * unit;
      return;
    }
    const host = viewportHost.getBoundingClientRect();
    const localX = event.clientX - host.left;
    const localY = event.clientY - host.top;
    const contentX = viewportHost.scrollLeft + localX;
    const contentY = viewportHost.scrollTop + localY;
    const previousZoom = zoom;
    zoom = Math.max(0.5, Math.min(3, zoom * Math.exp(-event.deltaY * unit * 0.002)));
    if (zoom === previousZoom) return;
    pagesHost.style.zoom = String(zoom / renderedZoom);
    const factor = zoom / previousZoom;
    viewportHost.scrollLeft = contentX * factor - localX;
    viewportHost.scrollTop = contentY * factor - localY;
    wheelZoomAnchor = capturePointAnchor(event.clientX, event.clientY);
    clearTimeout(wheelZoomTimer);
    wheelZoomTimer = setTimeout(() => {
      const anchor = wheelZoomAnchor;
      wheelZoomAnchor = null;
      scheduleRender(() => rebuildPages(anchor));
    }, 80);
  }, { passive: false });
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
    if (event.key === "Escape" && (!selectionMenu.hidden || areaSelection)) {
      event.preventDefault();
      hideSelectionMenu();
      clearAreaMode();
      return;
    }
    const target = event.target.closest("[data-page-index]");
    if (target && (event.key === "Enter" || event.key === " ")) scheduleRender(() => goToPage(Number(target.dataset.pageIndex) + 1));
  });
  document.addEventListener("selectionchange", () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const details = selectionDetails();
      postContext(details?.text || "", details?.state || pages.get(pageNumber));
    }, 100);
  });
  new ResizeObserver(() => {
    if (rebuildingPages) return;
    if (lastLayoutWidth && Math.abs(viewportHost.clientWidth - lastLayoutWidth) < 24) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => scheduleRender(() => rebuildPages(captureScrollAnchor())), 180);
  }).observe(viewportHost);
  window.addEventListener("unload", () => {
    clearTimeout(selectionTimer);
    clearTimeout(resizeTimer);
    clearTimeout(wheelZoomTimer);
    clearTimeout(contextTimer);
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    renderGeneration += 1;
    pageObserver?.disconnect();
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
    if (event.data?.type === "pdf-context-error") {
      status.textContent = "PDF context is temporarily unavailable; scrolling and annotation remain available.";
      return;
    }
    if (event.data?.type === "annotation-created" || event.data?.type === "annotation-updated") {
      const next = annotationPosition(event.data.annotation);
      const index = annotations.findIndex(value => value.annotationKey === next.annotationKey);
      if (index === -1) annotations.push(next); else annotations.splice(index, 1, next);
      renderAnnotationSidebar();
      for (const state of pages.values()) if (state.rendered) renderAnnotationLayer(state);
      status.classList.remove("error");
      status.textContent = "Saved";
      return;
    }
    if (event.data?.type === "annotation-deleted") {
      const index = annotations.findIndex(value => value.annotationKey === event.data.annotationKey);
      if (index !== -1) annotations.splice(index, 1);
      renderAnnotationSidebar();
      for (const state of pages.values()) if (state.rendered) renderAnnotationLayer(state);
      return;
    }
    if (event.data?.type === "annotation-undone") {
      annotations.splice(0, annotations.length, ...event.data.annotations.map(annotationPosition));
      renderAnnotationSidebar();
      for (const state of pages.values()) if (state.rendered) renderAnnotationLayer(state);
      status.textContent = event.data.changed ? "Last annotation change undone" : "Nothing to undo";
    }
  });

  renderAnnotationSidebar();
  await rebuildPages({ number: pageNumber, ratio: 0 });
}
catch (error) {
  reportRenderError(error);
}
