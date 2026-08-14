// Chatero LaTeX preview host.
//
// Loaded from the loopback preview origin so it is same-origin with the
// packaged pdf.js viewer it embeds, which is what lets it read and restore the
// viewer's position across recompiles.
//
// The position model and the anti-flicker sequence are ported from Overleaf
// (services/web/frontend/js/features/pdf-preview, GNU AGPL v3.0; see
// licenses/Overleaf-AGPL-3.0.txt). Position is recorded as a page index plus a
// point in PDF coordinates rather than a pixel scroll offset, so it survives a
// recompile that changes page count, and a zoom change that changes pixel
// geometry.
"use strict";

(() => {
  const frame = document.getElementById("viewer");
  const status = document.getElementById("status");
  const parameters = new URLSearchParams(window.location.search);
  const DEFAULT_SCALE = "page-width";
  let restored = false;
  let position = null;
  let scale = DEFAULT_SCALE;
  let saveTimer = 0;

  function post(message) {
    window.parent?.postMessage(message, "*");
  }

  function viewerApplication() {
    const application = frame.contentWindow?.PDFViewerApplication;
    return application?.pdfViewer ? application : null;
  }

  // Ported from Overleaf PDFJSWrapper#currentPosition: walk back from the
  // current page to the page actually crossing the container's top edge, then
  // express the container origin in that page's PDF coordinates.
  function currentPosition() {
    const application = viewerApplication();
    const viewer = application?.pdfViewer;
    if (!viewer) return null;
    const container = viewer.container;
    if (!container) return null;
    const containerRect = container.getBoundingClientRect();
    let pageIndex = viewer.currentPageNumber - 1;
    for (let index = pageIndex; index >= 0; index -= 1) {
      const pageView = viewer.getPageView(index);
      if (!pageView?.div) continue;
      const pageRect = pageView.div.getBoundingClientRect();
      if (pageRect.bottom < containerRect.top) {
        pageIndex = index + 1;
        break;
      }
      pageIndex = index;
    }
    const pageView = viewer.getPageView(pageIndex);
    if (!pageView?.div || !pageView.viewport) return null;
    const pageRect = pageView.div.getBoundingClientRect();
    const [left, top] = pageView.viewport.convertToPdfPoint(
      containerRect.left - pageRect.left,
      containerRect.top - pageRect.top
    );
    return { offset: { left, top }, page: pageIndex };
  }

  // Ported from Overleaf PDFJSWrapper#scrollToPosition: one scrollPageIntoView
  // with an XYZ destination restores both the zoom mode and the position, and
  // the margin snap keeps the page's top margin visible at the document start.
  function scrollToPosition(value, scaleValue) {
    const viewer = viewerApplication()?.pdfViewer;
    if (!viewer || !value) return;
    viewer.scrollPageIntoView({
      pageNumber: value.page + 1,
      destArray: [null, { name: "XYZ" }, value.offset.left, value.offset.top, scaleValue || null],
    });
    const pageView = viewer.getPageView(viewer.currentPageNumber - 1);
    if (pageView?.div) {
      const marginTop = Number.parseFloat(getComputedStyle(pageView.div).marginTop) || 0;
      if (viewer.container.scrollTop <= marginTop) viewer.container.scrollTop = 0;
    }
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const value = currentPosition();
      const viewer = viewerApplication()?.pdfViewer;
      if (!value || !viewer) return;
      position = value;
      scale = viewer.currentScaleValue || scale;
      post({ type: "chatero-latex-position", position, scale, page: viewer.currentPageNumber });
    }, 400);
  }

  function restore() {
    if (restored) return;
    const viewer = viewerApplication()?.pdfViewer;
    if (!viewer) return;
    restored = true;
    // Apply the persisted zoom before the first paint so the document never
    // flashes at pdf.js's default scale, then restore the position.
    viewer.currentScaleValue = scale || DEFAULT_SCALE;
    if (position) scrollToPosition(position, scale || DEFAULT_SCALE);
    status.hidden = true;
    post({ type: "chatero-latex-ready", pages: viewer.pagesCount || 0 });
  }

  function attach() {
    const application = viewerApplication();
    if (!application) { window.setTimeout(attach, 50); return; }
    const bus = application.eventBus;
    if (!bus) { window.setTimeout(attach, 50); return; }
    bus.on("pagesinit", restore);
    bus.on("pagechanging", scheduleSave);
    bus.on("scalechanging", scheduleSave);
    application.pdfViewer.container?.addEventListener("scroll", scheduleSave, { passive: true });
    if (application.pdfViewer.pagesCount > 0) restore();
  }

  // The extension host owns persistence: it sends the last known position back
  // when the panel reloads, and a fresh document URL on every recompile.
  window.addEventListener("message", event => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "chatero-latex-restore") {
      if (message.position && typeof message.position.page === "number") position = message.position;
      if (typeof message.scale === "string" && message.scale) scale = message.scale;
      return;
    }
    if (message.type === "chatero-latex-document" && typeof message.documentUrl === "string") {
      // Keep the current position and zoom, then reload the viewer against the
      // new render; the pagesinit handler applies them to the new document.
      const value = currentPosition();
      const viewer = viewerApplication()?.pdfViewer;
      if (value) position = value;
      if (viewer?.currentScaleValue) scale = viewer.currentScaleValue;
      restored = false;
      status.hidden = false;
      frame.src = `${message.viewerUrl}`;
      frame.addEventListener("load", attach, { once: true });
    }
  });

  const initialViewerUrl = parameters.get("viewer");
  if (initialViewerUrl) {
    frame.addEventListener("load", attach, { once: true });
    frame.src = initialViewerUrl;
  }
  post({ type: "chatero-latex-host-ready" });
})();
