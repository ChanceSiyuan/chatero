const bootstrap = document.currentScript ?? document.querySelector("script[data-pdf-uri]");
const canvas = document.getElementById("pdf-canvas");
const annotationLayer = document.getElementById("annotation-layer");
const pageField = document.getElementById("page-number");
const pageCount = document.getElementById("page-count");
const status = document.getElementById("viewer-status");
const viewportHost = document.getElementById("page-viewport");
const annotations = JSON.parse(document.getElementById("annotation-data")?.textContent || "[]");

let documentHandle;
let pageNumber = 1;
let renderGeneration = 0;
let zoom = 1;

function boundedPage(value) {
  return Math.max(1, Math.min(documentHandle?.numPages || 1, Number(value) || 1));
}

function safeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffd400";
}

function pageAnnotations(index) {
  return annotations.filter(annotation => annotation.pageIndex === index);
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

async function renderPage() {
  const generation = ++renderGeneration;
  status.textContent = "Rendering…";
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
  annotationLayer.style.width = `${viewport.width}px`;
  annotationLayer.style.height = `${viewport.height}px`;
  const context = canvas.getContext("2d", { alpha: false });
  await page.render({ canvasContext: context, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0], viewport }).promise;
  if (generation !== renderGeneration) return;
  renderAnnotationLayer(viewport);
  pageField.value = String(pageNumber);
  status.textContent = "";
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
  const pdfjs = await import(bootstrap.dataset.pdfJsUri);
  pdfjs.GlobalWorkerOptions.workerSrc = bootstrap.dataset.workerUri;
  annotations.splice(0, annotations.length, ...parseAnnotations());
  for (const swatch of document.querySelectorAll(".swatch[data-color]")) {
    swatch.style.backgroundColor = safeColor(swatch.dataset.color);
  }
  documentHandle = await pdfjs.getDocument({ url: bootstrap.dataset.pdfUri }).promise;
  pageCount.textContent = `/ ${documentHandle.numPages}`;
  document.getElementById("previous-page").addEventListener("click", () => goToPage(pageNumber - 1));
  document.getElementById("next-page").addEventListener("click", () => goToPage(pageNumber + 1));
  document.getElementById("zoom-out").addEventListener("click", () => { zoom = Math.max(0.5, zoom - 0.1); void renderPage(); });
  document.getElementById("zoom-in").addEventListener("click", () => { zoom = Math.min(3, zoom + 0.1); void renderPage(); });
  pageField.addEventListener("change", () => goToPage(pageField.value));
  document.addEventListener("click", event => {
    const target = event.target.closest("[data-page-index]");
    if (target) void goToPage(Number(target.dataset.pageIndex) + 1);
  });
  document.addEventListener("keydown", event => {
    const target = event.target.closest("[data-page-index]");
    if (target && (event.key === "Enter" || event.key === " ")) void goToPage(Number(target.dataset.pageIndex) + 1);
  });
  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => void renderPage(), 120);
  }).observe(viewportHost);
  await renderPage();
} catch (error) {
  status.textContent = `PDF could not be rendered: ${error instanceof Error ? error.message : String(error)}`;
  status.classList.add("error");
}
