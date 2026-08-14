import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

// Bounds a single shipped file read; it is headroom over the largest vendored bundle
// (the Zotero reader, ~3.5 MiB), not a size pin -- exact bytes are pinned per file by
// the recorded provenance digests below.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const TOP_FIELDS = new Set(["schemaVersion", "extensions"]);
const EXTENSION_FIELDS = new Set(["id", "files"]);
const FILE_FIELDS = new Set(["source", "destination"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new Error(`${label} has unknown field ${field}`);
  }
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${label} is an unsafe path`);
  }
  const parts = value.split("/");
  if (value.startsWith("/") || parts.some(part => !part || part === "." || part === "..")) {
    throw new Error(`${label} is an unsafe path`);
  }
  return parts.join(sep);
}

function inside(root, path, label) {
  const value = relative(root, path);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || value.includes(`${sep}..${sep}`)) {
    throw new Error(`${label} escapes its root`);
  }
}

async function assertSourceFile(root, relativePath) {
  const parts = relativePath.split(sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error(`source contains a symbolic link: ${relativePath}`);
    if (index < parts.length - 1 && !metadata.isDirectory()) throw new Error(`source ancestor is not a directory: ${relativePath}`);
    if (index === parts.length - 1) {
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) throw new Error(`source is not a bounded regular file: ${relativePath}`);
      return metadata;
    }
  }
}

export async function assertSafeDestinationAncestors(checkout, destination) {
  const relativePath = relative(checkout, destination);
  const parts = relativePath.split(sep).slice(0, -1);
  let current = checkout;
  for (const part of parts) {
    current = join(current, part);
    const metadata = await lstat(current).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!metadata) return;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`destination ancestor is unsafe: ${relativePath}`);
    }
  }
}

function treeSha256(files) {
  return sha256(files.map(file => `${file.path}\0${file.size}\0${file.sha256}\n`).join(""));
}

export async function inspectFirstPartyExtensionSources({ root, manifestPath }) {
  const canonicalRoot = resolve(root);
  const extensions = await loadManifest(canonicalRoot, manifestPath);
  const inspected = [];
  for (const extension of extensions) {
    const files = [];
    for (const file of extension.files) {
      await assertSourceFile(canonicalRoot, file.sourceRelative);
      const bytes = await readFile(file.source);
      files.push({ path: file.destinationUnix, sha256: sha256(bytes), size: bytes.length });
    }
    files.sort((left, right) => compareUtf8Bytes(left.path, right.path));
    inspected.push({
      destinationRoot: extension.destinationRootUnix,
      files,
      id: extension.id,
      treeSha256: treeSha256(files),
    });
  }
  return Object.freeze(inspected.map(extension => Object.freeze({
    ...extension,
    files: Object.freeze(extension.files.map(file => Object.freeze(file))),
  })));
}

async function loadManifest(root, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  exactObject(manifest, TOP_FIELDS, "first-party extension manifest");
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.extensions)) {
    throw new Error("first-party extension manifest schema is unsupported");
  }
  const ids = new Set();
  const destinations = new Set();
  const extensions = [];
  for (const extension of manifest.extensions) {
    exactObject(extension, EXTENSION_FIELDS, "first-party extension");
    if (typeof extension.id !== "string" || !/^chatero\.[a-z][a-z0-9-]*$/.test(extension.id)) {
      throw new Error(`unsafe first-party extension id ${extension.id}`);
    }
    if (ids.has(extension.id)) throw new Error(`duplicate first-party extension id ${extension.id}`);
    ids.add(extension.id);
    const destinationRootUnix = `extensions/chatero-${extension.id.slice("chatero.".length)}`;
    if (!Array.isArray(extension.files) || extension.files.length === 0) throw new Error(`extension ${extension.id} has no files`);
    const files = [];
    for (const file of extension.files) {
      exactObject(file, FILE_FIELDS, `extension ${extension.id} file`);
      const sourceRelative = safeRelativePath(file.source, `extension ${extension.id} source`);
      const destinationRelative = safeRelativePath(file.destination, `extension ${extension.id} destination`);
      if (!file.destination.startsWith(`${destinationRootUnix}/`)) {
        throw new Error(`extension ${extension.id} destination is unsafe`);
      }
      if (destinations.has(file.destination)) throw new Error(`duplicate extension destination ${file.destination}`);
      destinations.add(file.destination);
      const source = resolve(root, sourceRelative);
      inside(root, source, "extension source");
      files.push({
        destinationRelative,
        destinationUnix: file.destination,
        source,
        sourceRelative,
      });
    }
    extensions.push({ destinationRootUnix, id: extension.id, files });
  }
  return extensions;
}

export async function materializeFirstPartyExtensions({ root, checkout, manifestPath }) {
  const canonicalRoot = resolve(root);
  const canonicalCheckout = resolve(checkout);
  const extensions = await loadManifest(canonicalRoot, manifestPath);
  const prepared = [];
  for (const extension of extensions) {
    const files = [];
    for (const file of extension.files) {
      await assertSourceFile(canonicalRoot, file.sourceRelative);
      const destination = resolve(canonicalCheckout, file.destinationRelative);
      inside(canonicalCheckout, destination, "extension destination");
      await assertSafeDestinationAncestors(canonicalCheckout, destination);
      const existing = await lstat(destination).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (existing) throw new Error(`extension destination already exists: ${file.destinationUnix}`);
      const bytes = await readFile(file.source);
      files.push({
        bytes,
        destination,
        path: file.destinationUnix,
        sha256: sha256(bytes),
        size: bytes.length,
      });
    }
    files.sort((left, right) => compareUtf8Bytes(left.path, right.path));
    prepared.push({
      id: extension.id,
      destinationRoot: extension.destinationRootUnix,
      files,
    });
  }
  for (const extension of prepared) {
    for (const file of extension.files) {
      await mkdir(dirname(file.destination), { recursive: true, mode: 0o755 });
      await writeFile(file.destination, file.bytes, { flag: "wx", mode: 0o644 });
    }
  }
  return {
    extensions: prepared.map(extension => ({
      destinationRoot: extension.destinationRoot,
      files: extension.files.map(({ path, sha256: digest, size }) => ({ path, sha256: digest, size })),
      id: extension.id,
      treeSha256: treeSha256(extension.files),
    })),
  };
}

async function collectFiles(root, directory, files) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`extension tree contains an unsafe directory: ${directory}`);
  for (const entry of (await readdir(directory)).sort(compareUtf8Bytes)) {
    const path = join(directory, entry);
    const value = await lstat(path);
    if (value.isSymbolicLink()) throw new Error(`extension tree contains a symbolic link: ${path}`);
    if (value.isDirectory()) await collectFiles(root, path, files);
    else if (value.isFile() && value.size <= MAX_FILE_BYTES) files.push(path);
    else throw new Error(`extension tree contains an unsafe file: ${path}`);
  }
}

export async function verifyFirstPartyExtensions({ checkout, expected }) {
  const canonicalCheckout = resolve(checkout);
  if (!Array.isArray(expected)) throw new Error("expected first-party extension provenance must be an array");
  const verified = [];
  for (const extension of expected) {
    const directory = resolve(canonicalCheckout, safeRelativePath(extension.destinationRoot, "extension destination root"));
    inside(canonicalCheckout, directory, "extension destination root");
    const actualPaths = [];
    await collectFiles(canonicalCheckout, directory, actualPaths);
    const files = [];
    for (const path of actualPaths) {
      const relativePath = relative(canonicalCheckout, path).split(sep).join("/");
      const bytes = await readFile(path);
      files.push({ path: relativePath, sha256: sha256(bytes), size: bytes.length });
    }
    files.sort((left, right) => compareUtf8Bytes(left.path, right.path));
    if (JSON.stringify(files) !== JSON.stringify(extension.files)) {
      throw new Error(`first-party extension ${extension.id} file digest set does not match provenance`);
    }
    const digest = treeSha256(files);
    if (digest !== extension.treeSha256) throw new Error(`first-party extension ${extension.id} tree digest does not match provenance`);
    verified.push({
      destinationRoot: extension.destinationRoot,
      files,
      id: extension.id,
      treeSha256: digest,
    });
  }
  return verified;
}
