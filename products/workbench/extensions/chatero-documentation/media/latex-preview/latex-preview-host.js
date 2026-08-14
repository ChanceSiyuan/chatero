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
  const DEFAULT_SCALE = "page-width";
  const ATTACH_INTERVAL_MS = 50;
  const ATTACH_TIMEOUT_MS = 30_000;
  let restored = false;
  let position = null;
  let scale = DEFAULT_SCALE;
  let saveTimer = 0;
  let attachDeadline = 0;

  function post(message) {
    window.parent?.postMessage(message, "*");
  }

  function report(message) {
    status.hidden = false;
    status.textContent = message;
  }

  // Reading across origins throws, which must never be fatal: the viewer frame
  // is cross-origin while it is still loading an error document, and a throw
  // here would otherwise abort the retry loop or the document swap.
  function viewerApplication() {
    try {
      const application = frame.contentWindow?.PDFViewerApplication;
      return application?.pdfViewer ? application : null;
    }
    catch { return null; }
  }

  // Ported from Overleaf PDFJSWrapper#currentPosition: walk back from the
  // current page to the page actually crossing the container's top edge, then
  // express the container origin in that page's PDF coordinates.
  function currentPosition() {
    const viewer = viewerApplication()?.pdfViewer;
    const container = viewer?.container;
    if (!container) return null;
    try {
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
    catch { return null; }
  }

  // Ported from Overleaf PDFJSWrapper#scrollToPosition: one scrollPageIntoView
  // with an XYZ destination restores both the zoom mode and the position, and
  // the margin snap keeps the page's top margin visible at the document start.
  function scrollToPosition(value, scaleValue) {
    const viewer = viewerApplication()?.pdfViewer;
    if (!viewer || !value) return;
    // A recompile can shorten the document; clamp so a stale page index still
    // lands somewhere real instead of being dropped.
    const pages = viewer.pagesCount || 1;
    const page = Math.min(Math.max(value.page, 0), pages - 1);
    try {
      viewer.scrollPageIntoView({
        pageNumber: page + 1,
        destArray: [null, { name: "XYZ" }, value.offset.left, value.offset.top, scaleValue || null],
      });
      const pageView = viewer.getPageView(viewer.currentPageNumber - 1);
      if (pageView?.div) {
        const marginTop = Number.parseFloat(getComputedStyle(pageView.div).marginTop) || 0;
        if (viewer.container.scrollTop <= marginTop) viewer.container.scrollTop = 0;
      }
    }
    catch { /* the viewer went away mid-restore; the next render restores it */ }
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
    try { viewer.currentScaleValue = scale || DEFAULT_SCALE; }
    catch { /* fall back to the viewer's own default */ }
    if (position) scrollToPosition(position, scale || DEFAULT_SCALE);
    status.hidden = true;
    post({ type: "chatero-latex-ready", pages: viewer.pagesCount || 0 });
  }

  function attach() {
    const application = viewerApplication();
    const bus = application?.eventBus;
    if (!bus) {
      if (Date.now() > attachDeadline) {
        report("The PDF viewer did not start. Run the preview command again to retry.");
        post({ type: "chatero-latex-error", reason: "viewer-unavailable" });
        return;
      }
      window.setTimeout(attach, ATTACH_INTERVAL_MS);
      return;
    }
    bus.on("pagesinit", restore);
    bus.on("pagechanging", scheduleSave);
    bus.on("scalechanging", scheduleSave);
    application.pdfViewer.container?.addEventListener("scroll", scheduleSave, { passive: true });
    if (application.pdfViewer.pagesCount > 0) restore();
  }

  function showDocument(viewerPath) {
    // Capture where the reader was before the old document goes away, then
    // repoint the frame first so a failed read can never freeze the preview.
    const value = currentPosition();
    const viewer = viewerApplication()?.pdfViewer;
    if (value) position = value;
    if (viewer?.currentScaleValue) scale = viewer.currentScaleValue;
    restored = false;
    attachDeadline = Date.now() + ATTACH_TIMEOUT_MS;
    report("Rendering PDF…");
    frame.addEventListener("load", attach, { once: true });
    frame.src = viewerPath;
  }

  // The extension host owns persistence and the document itself: the page
  // announces readiness and the host replies with the current render plus the
  // last known position, so a reloaded webview recovers instead of pointing at
  // a revoked lease.
  window.addEventListener("message", event => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "chatero-latex-restore") {
      if (message.position && Number.isFinite(message.position.page)) position = message.position;
      if (typeof message.scale === "string" && message.scale) scale = message.scale;
      return;
    }
    if (message.type === "chatero-latex-document" && typeof message.viewerPath === "string") {
      if (message.position && Number.isFinite(message.position.page) && !restored) position = message.position;
      if (typeof message.scale === "string" && message.scale && !restored) scale = message.scale;
      showDocument(message.viewerPath);
    }
  });

  post({ type: "chatero-latex-host-ready" });
})();
