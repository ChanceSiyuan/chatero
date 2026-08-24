import { createServer } from "node:http";
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

const MIME = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
});

function reply(response, status, headers = {}) {
  response.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  response.end();
}

export async function createQuartoStaticServer({ entryPath, root, token } = {}) {
  if (typeof root !== "string" || resolve(root) !== root || !/^[A-Za-z0-9_-]{43,128}$/u.test(token ?? "")) {
    throw new TypeError("Quarto static server configuration is invalid");
  }
  const canonicalRoot = await realpath(root);
  const canonicalEntry = await realpath(entryPath ?? join(root, "index.html"));
  const entryRelative = relative(canonicalRoot, canonicalEntry).split(sep).join("/");
  if (!entryRelative || entryRelative.startsWith("../") || entryRelative.includes("/../")) {
    throw new Error("Quarto preview entry is outside its immutable output root");
  }
  const prefix = `/${token}/`;
  const server = createServer(async (request, response) => {
    try {
      if (!request.url || !["GET", "HEAD"].includes(request.method ?? "")) {
        reply(response, request.method && !["GET", "HEAD"].includes(request.method) ? 405 : 400, { Allow: "GET, HEAD" });
        return;
      }
      const url = new URL(request.url, "http://127.0.0.1");
      if (!url.pathname.startsWith(prefix)) { reply(response, 404); return; }
      const relativePath = decodeURIComponent(url.pathname.slice(prefix.length)) || "index.html";
      const target = resolve(canonicalRoot, relativePath);
      if (relative(canonicalRoot, target).startsWith(`..${sep}`) || target === canonicalRoot) { reply(response, 404); return; }
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(target) !== target) { reply(response, 404); return; }
      const mime = MIME[extname(target).toLowerCase()];
      if (!mime) { reply(response, 415); return; }
      const bytes = await readFile(target);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": String(bytes.byteLength),
        // The tokenized loopback document is intentionally embedded by the
        // Electron webview. A bare `*` ancestor source only covers network
        // schemes in Chromium, so it rejects the actual `vscode-webview:`
        // preview host and its `vscode-file:` workbench ancestor, replacing
        // the otherwise valid render with chrome-error://chromewebdata/.
        // Admit that complete product-owned ancestor chain explicitly while
        // keeping ordinary web pages unable to frame it.
        // Quarto's fixed `embed-resources: true` output represents its own
        // Bootstrap stylesheets as data:text/css links. Admit that passive
        // style transport without extending script or connect permissions.
        "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' data:; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors vscode-webview: vscode-file:; form-action 'none'; base-uri 'none'",
        "Content-Type": mime,
        // The tokenized document is intentionally framed by the
        // vscode-webview:// preview host. `same-origin` makes Chromium replace
        // that otherwise-authorized cross-origin iframe with
        // chrome-error://chromewebdata/ even though frame-ancestors permits it.
        "Cross-Origin-Resource-Policy": "cross-origin",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    }
    catch { reply(response, 404); }
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Quarto static server did not bind a TCP address");
  let disposed = false;
  return Object.freeze({
    root: canonicalRoot,
    url: `http://127.0.0.1:${address.port}${prefix}${entryRelative.split("/").map(encodeURIComponent).join("/")}`,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await new Promise(resolveClose => server.close(resolveClose));
    },
  });
}
