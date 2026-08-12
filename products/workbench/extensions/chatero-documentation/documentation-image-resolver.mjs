import { createHash } from "node:crypto";

export const MAX_PASSIVE_IMAGE_BYTES = 20 * 1024 * 1024;
export const PASSIVE_IMAGE_MIME = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

const MIME_EXTENSION = Object.freeze(new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
]));

function uriText(uri) {
  if (!uri || typeof uri.toString !== "function") throw new TypeError("image page URI is invalid");
  const value = uri.toString(true);
  if (!value) throw new TypeError("image page URI is invalid");
  return value;
}

function safeTarget(target) {
  return typeof target === "string" && target.length > 0 && Buffer.byteLength(target, "utf8") <= 4096
    && !target.startsWith("/") && !target.includes("\\") && !/[%:?#\u0000-\u001f\u007f]/u.test(target)
    && target.normalize("NFC") === target;
}

function targetWithinDocumentation(pageUri, target) {
  let page;
  try { page = new URL(uriText(pageUri)); }
  catch { return false; }
  let segments;
  try { segments = decodeURIComponent(page.pathname).split("/").filter(Boolean); }
  catch { return false; }
  const documentationIndex = segments.lastIndexOf("documentation");
  if (documentationIndex < 0 || !segments.at(-1)?.toLowerCase().endsWith(".qmd")) return false;
  segments.pop();
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length <= documentationIndex + 1) return false;
      segments.pop();
    }
    else segments.push(part);
  }
  return segments.length > documentationIndex + 1 && segments[documentationIndex] === "documentation";
}

function placeholder(target, reason) {
  return Object.freeze({ kind: "placeholder", target, reason });
}

export function createPassiveImageSnapshotRequest(scope, {
  pageUri,
  target,
  maxBytes = MAX_PASSIVE_IMAGE_BYTES,
} = {}) {
  if (!scope || !safeTarget(target) || !targetWithinDocumentation(pageUri, target) || maxBytes !== MAX_PASSIVE_IMAGE_BYTES) {
    throw new TypeError("passive image snapshot request is invalid");
  }
  return Object.freeze({
    kind: "passive-image",
    pageUri: uriText(pageUri),
    target,
    maxBytes,
    allowedMime: PASSIVE_IMAGE_MIME,
  });
}

function decodeSnapshot(result) {
  if (!result || typeof result !== "object") throw new TypeError("passive image snapshot is invalid");
  if (result.kind === "passive-image-placeholder") return result;
  if (result.kind !== "passive-image" || !PASSIVE_IMAGE_MIME.includes(result.mime)
    || !Number.isSafeInteger(result.size) || result.size < 0 || result.size > MAX_PASSIVE_IMAGE_BYTES
    || typeof result.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(result.sha256)
    || result.revision !== `sha256:${result.sha256}` || typeof result.bytes !== "string"
    || !/^[A-Za-z0-9_-]*$/u.test(result.bytes)) {
    throw new TypeError("passive image snapshot metadata is invalid");
  }
  const bytes = Buffer.from(result.bytes, "base64url");
  if (bytes.toString("base64url") !== result.bytes || bytes.byteLength !== result.size
    || createHash("sha256").update(bytes).digest("hex") !== result.sha256) {
    throw new TypeError("passive image snapshot bytes are invalid");
  }
  return Object.freeze({ ...result, bytes });
}

export class DocumentationImageResolver {
  constructor({ scope, snapshotPassiveImage, workspace, Uri, storageUri, webview, sessionId }) {
    if (!scope || typeof snapshotPassiveImage !== "function" || !workspace?.fs
      || typeof workspace.fs.createDirectory !== "function" || typeof workspace.fs.writeFile !== "function"
      || typeof workspace.fs.delete !== "function" || !Uri || typeof Uri.joinPath !== "function"
      || !storageUri || !webview || typeof webview.asWebviewUri !== "function"
      || typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) {
      throw new TypeError("Documentation image resolver dependencies are invalid");
    }
    this.scope = scope;
    this.snapshotPassiveImage = snapshotPassiveImage;
    this.workspace = workspace;
    this.Uri = Uri;
    this.webview = webview;
    this.rootUri = Uri.joinPath(storageUri, "live-preview-images", sessionId);
    this.ready = workspace.fs.createDirectory(this.rootUri);
    this.cached = new Map();
    this.disposed = false;
  }

  async resolve(pageUri, target) {
    if (this.disposed) return placeholder(String(target ?? ""), "unavailable");
    if (!safeTarget(target) || !targetWithinDocumentation(pageUri, target)) return placeholder(String(target ?? ""), "unsafe");
    try {
      await this.ready;
      const request = createPassiveImageSnapshotRequest(this.scope, { pageUri, target });
      const snapshot = decodeSnapshot(await this.snapshotPassiveImage(request));
      if (snapshot.kind === "passive-image-placeholder") return placeholder(target, snapshot.reason);
      let resolution = this.cached.get(snapshot.sha256);
      if (!resolution) {
        const extension = MIME_EXTENSION.get(snapshot.mime);
        const cacheUri = this.Uri.joinPath(this.rootUri, `${snapshot.sha256}.${extension}`);
        await this.workspace.fs.writeFile(cacheUri, snapshot.bytes);
        const src = this.webview.asWebviewUri(cacheUri).toString();
        if (!src || /^(?:data|blob|file|javascript):/iu.test(src)) throw new TypeError("derived image URI is unsafe");
        resolution = Object.freeze({
          kind: "ready",
          target,
          src,
          mime: snapshot.mime,
          size: snapshot.size,
          revision: snapshot.revision,
        });
        this.cached.set(snapshot.sha256, resolution);
      }
      return resolution.target === target ? resolution : Object.freeze({ ...resolution, target });
    }
    catch {
      return placeholder(target, "unavailable");
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cached.clear();
    try {
      await this.ready;
      await this.workspace.fs.delete(this.rootUri, { recursive: true, useTrash: false });
    }
    catch {}
  }
}

export function createDocumentationImageResolver(dependencies) {
  return new DocumentationImageResolver(dependencies);
}
