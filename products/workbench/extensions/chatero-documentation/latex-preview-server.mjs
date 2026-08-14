import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const CONTENT_TYPES = Object.freeze({
  ".bcmap": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".ftl": "text/plain; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".icc": "application/vnd.iccprofile",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".pfb": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

// Serves the packaged pdf.js viewer and each compiled PDF to the preview
// webview over 127.0.0.1 only. A webview service worker cannot intercept
// nested iframe navigations, so resource-scheme URIs never load inside the
// viewer frame; a real loopback origin gives the viewer standard same-origin
// fetch, iframe and worker semantics, and asExternalUri tunnels it back to the
// client when the render happens on a remote host. Every URL is guarded by an
// unguessable per-server token, and each PDF additionally by a per-lease id.
export class LatexPreviewServer {
  #viewerRoot;
  #hostRoot;
  #server = null;
  #origin = null;
  #starting = null;
  #token = randomBytes(18).toString("base64url");
  #documents = new Map();

  constructor({ viewerRoot, hostRoot } = {}) {
    if (typeof viewerRoot !== "string" || !viewerRoot.length) throw new TypeError("LaTeX preview viewer root is invalid");
    if (typeof hostRoot !== "string" || !hostRoot.length) throw new TypeError("LaTeX preview host root is invalid");
    this.#viewerRoot = resolve(viewerRoot);
    this.#hostRoot = resolve(hostRoot);
  }

  async #start() {
    if (this.#origin) return this.#origin;
    this.#starting ||= new Promise((accept, reject) => {
      const server = createServer((request, response) => {
        void this.#serve(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("LaTeX preview server did not bind a TCP address"));
          return;
        }
        this.#server = server;
        this.#origin = `http://127.0.0.1:${address.port}`;
        accept(this.#origin);
      });
    });
    return this.#starting;
  }

  async #resolveStaticPath(root, relativePath) {
    const target = resolve(root, relativePath);
    if (!target.startsWith(`${root}${sep}`)) return null;
    const canonical = await realpath(target).catch(() => null);
    if (!canonical || !canonical.startsWith(`${root}${sep}`)) return null;
    const metadata = await stat(canonical).catch(() => null);
    return metadata?.isFile() ? canonical : null;
  }

  async #serve(request, response) {
    const reply = (status, headers = {}) => {
      response.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
      response.end();
    };
    if (!request.url || !["GET", "HEAD"].includes(request.method ?? "")) {
      reply(request.method && !["GET", "HEAD"].includes(request.method) ? 405 : 400, { Allow: "GET, HEAD" });
      return;
    }
    const url = new URL(request.url, "http://127.0.0.1");
    const prefix = `/${this.#token}/`;
    if (!url.pathname.startsWith(prefix)) { reply(404); return; }
    const rest = url.pathname.slice(prefix.length);
    let path;
    let contentType;
    let disposition;
    if (rest.startsWith("viewer/") || rest.startsWith("host/")) {
      const viewer = rest.startsWith("viewer/");
      path = await this.#resolveStaticPath(
        viewer ? this.#viewerRoot : this.#hostRoot,
        decodeURIComponent(rest.slice(viewer ? "viewer/".length : "host/".length))
      );
      contentType = path ? CONTENT_TYPES[extname(path).toLowerCase()] : undefined;
      if (!path || !contentType) { reply(path ? 415 : 404); return; }
    }
    else if (rest.startsWith("doc/")) {
      const lease = this.#documents.get(decodeURIComponent(rest.slice("doc/".length)));
      if (!lease) { reply(404); return; }
      path = lease.path;
      contentType = "application/pdf";
      disposition = "inline; filename=\"preview.pdf\"";
      if (!await stat(path).then(value => value.isFile(), () => false)) { reply(404); return; }
    }
    else { reply(404); return; }
    const headers = {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob: data:; worker-src 'self' blob:; frame-ancestors *; object-src 'none'; base-uri 'none'",
      "Content-Type": contentType,
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      ...(disposition && { "Content-Disposition": disposition }),
    };
    if (request.method === "HEAD") { reply(200, headers); return; }
    response.writeHead(200, headers);
    createReadStream(path).on("error", () => response.destroy()).pipe(response);
  }

  // Publishes one compiled PDF under a fresh unguessable id and returns the
  // viewer URL that renders it. Replacing a session's lease revokes the old id
  // so a stale webview cannot keep reading a superseded render.
  async lease({ path, leaseId } = {}) {
    if (typeof path !== "string" || resolve(path) !== path) throw new TypeError("LaTeX preview document path is invalid");
    const origin = await this.#start();
    const id = randomBytes(18).toString("base64url");
    if (leaseId) this.#documents.delete(leaseId);
    this.#documents.set(id, { path });
    const documentUrl = `${origin}/${this.#token}/doc/${id}`;
    // The viewer resolves ../build/pdf.mjs and its worker relative to web/, so
    // the served root is the pdfjs bundle itself, not its web directory. The
    // host page is same-origin with the viewer, which is what lets it read and
    // restore the scroll position across recompiles.
    const viewerUrl = `${origin}/${this.#token}/viewer/web/viewer.html?file=${encodeURIComponent(documentUrl)}`;
    return Object.freeze({
      documentUrl,
      leaseId: id,
      origin,
      viewerUrl,
      hostUrl: `${origin}/${this.#token}/host/latex-preview-host.html?viewer=${encodeURIComponent(viewerUrl)}`,
      dispose: () => { this.#documents.delete(id); },
    });
  }

  revoke(leaseId) {
    if (typeof leaseId === "string") this.#documents.delete(leaseId);
  }

  async dispose() {
    this.#documents.clear();
    const server = this.#server;
    this.#server = null;
    this.#origin = null;
    this.#starting = null;
    if (server) await new Promise(accept => server.close(accept));
  }
}

export function viewerRootFor(extensionPath) {
  return join(resolve(extensionPath), "media", "pdfjs");
}

export function hostRootFor(extensionPath) {
  return join(resolve(extensionPath), "media", "latex-preview");
}
