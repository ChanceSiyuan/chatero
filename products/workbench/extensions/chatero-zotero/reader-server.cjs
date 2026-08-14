const { createServer } = require("node:http");
const { randomBytes } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { stat, realpath } = require("node:fs/promises");
const { extname, join, normalize, resolve, sep } = require("node:path");

const CONTENT_TYPES = Object.freeze({
  ".bcmap": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".ftl": "text/plain; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".icc": "application/vnd.iccprofile",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".pfb": "application/octet-stream",
  ".png": "image/png",
  ".properties": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

// Serves the packaged upstream reader and per-panel materialized attachments to
// the webview over 127.0.0.1 only. A webview service worker cannot intercept
// nested iframe navigations, so resource-scheme URIs never load there; a real
// loopback origin gives the reader document and the fork pdf.js viewer iframe
// standard same-origin fetch, iframe, and worker semantics instead. Every URL
// is guarded by an unguessable per-server token, and documents additionally by
// an unguessable per-lease id.
class ReaderServer {
  #mediaRoot;
  #server = null;
  #origin = null;
  #starting = null;
  #token = randomBytes(18).toString("base64url");
  #documents = new Map();

  constructor({ mediaRoot }) {
    if (typeof mediaRoot !== "string" || !mediaRoot.length) throw new TypeError("Reader server media root is invalid");
    this.#mediaRoot = resolve(mediaRoot);
  }

  async #start() {
    if (this.#origin) return this.#origin;
    this.#starting ||= new Promise((resolveStart, rejectStart) => {
      const server = createServer((request, response) => {
        void this.#serve(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      server.unref();
      server.on("error", error => {
        this.#starting = null;
        rejectStart(error);
      });
      server.listen(0, "127.0.0.1", () => {
        this.#server = server;
        this.#origin = `http://127.0.0.1:${server.address().port}`;
        resolveStart(this.#origin);
      });
    });
    return this.#starting;
  }

  async #serve(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    const [, token, kind, ...rest] = url.pathname.split("/");
    if (request.method !== "GET" || token !== this.#token || rest.length === 0) {
      response.writeHead(404);
      response.end();
      return;
    }
    let path = null;
    let contentType = null;
    const extraHeaders = {};
    if (kind === "reader") {
      const relative = normalize(rest.map(decodeURIComponent).join("/"));
      if (relative.startsWith("..") || relative.includes(`..${sep}`)) {
        response.writeHead(404);
        response.end();
        return;
      }
      path = join(this.#mediaRoot, relative);
      const real = await realpath(path).catch(() => null);
      if (!real || (real !== this.#mediaRoot && !real.startsWith(this.#mediaRoot + sep))) {
        response.writeHead(404);
        response.end();
        return;
      }
      path = real;
      contentType = CONTENT_TYPES[extname(path).toLowerCase()] || "application/octet-stream";
    }
    else if (kind === "doc" && rest.length === 1) {
      const entry = this.#documents.get(rest[0]);
      if (!entry) {
        response.writeHead(404);
        response.end();
        return;
      }
      path = entry.path;
      // The reader only ever reads leased documents as bytes; a neutral type
      // plus a sandbox keeps a navigated-to document inert on this origin.
      contentType = "application/octet-stream";
      extraHeaders["Content-Disposition"] = "attachment";
      extraHeaders["Content-Security-Policy"] = "sandbox";
    }
    else {
      response.writeHead(404);
      response.end();
      return;
    }
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Accept-Ranges": "none",
      "Cache-Control": "private, max-age=0, must-revalidate",
      "Content-Length": info.size,
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    });
    const stream = createReadStream(path);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  }

  async lease({ path, contentType }) {
    if (typeof path !== "string" || !path.length || typeof contentType !== "string" || !contentType.length) {
      throw new TypeError("Reader server lease request is invalid");
    }
    const origin = await this.#start();
    const documentId = randomBytes(18).toString("base64url");
    this.#documents.set(documentId, { contentType, path });
    let disposed = false;
    return Object.freeze({
      documentUrl: `${origin}/${this.#token}/doc/${documentId}`,
      origin,
      readerPageUrl: `${origin}/${this.#token}/reader/chatero-reader.html`,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.#documents.delete(documentId);
      },
    });
  }

  dispose() {
    this.#documents.clear();
    this.#server?.close();
    this.#server = null;
    this.#origin = null;
    this.#starting = null;
  }
}

module.exports = { ReaderServer };
