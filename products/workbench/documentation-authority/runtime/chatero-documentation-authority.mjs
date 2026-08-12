#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as nodeFilesystem from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createStateTransactionExecutor } from "../documentation-operations.mjs";
import { buildLegacyMigrationMapping } from "../migration-model.mjs";
import {
  classifyLegacyProposals,
  rewriteLegacyReferences,
} from "../migration-rewrite.mjs";
import {
  decodeAuthorityRequest,
  encodeAuthorityResponse,
} from "./protocol.mjs";

const MAX_FRAME_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
const STATE_PATH = ".chatero/documentation-state.v1.json";
const OPERATIONS_PATH = ".chatero/documentation-operations";
const RECEIPTS_PATH = ".chatero/documentation-receipts";
const LEASE_PATH = ".chatero/documentation-authority.lock";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MIGRATION_ROOTS = Object.freeze(["documentation", "drafts", "knowledge"]);
const LEGACY_PROPOSAL_ROOT = "work/qlab-zotero/draft-changes";
const PASSIVE_IMAGE_MIME = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const PASSIVE_IMAGE_EXTENSIONS = Object.freeze(new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
]));

class MigrationLimitError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

class MigrationSnapshotChangedError extends Error {}

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("authority journal contains a non-JSON value");
  const keys = Object.keys(value).sort(compareUtf8Bytes);
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function digestValue(value) {
  return `sha256:${sha256(Buffer.from(canonicalJson(value), "utf8"))}`;
}

function serializedJson(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/")
    || value.includes("\\") || /[%:?#\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Documentation authority path is unsafe");
  }
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.normalize("NFC") !== part)) {
    throw new TypeError("Documentation authority path is unsafe");
  }
  return parts;
}

function decodedPathname(uri) {
  try {
    return decodeURIComponent(uri.pathname);
  }
  catch {
    throw new TypeError("workspace URI path encoding is invalid");
  }
}

function workspacePath(value) {
  let uri;
  try { uri = new URL(value); }
  catch { throw new TypeError("workspace URI is invalid"); }
  let path;
  if (uri.protocol === "file:") path = fileURLToPath(uri);
  else if (uri.protocol === "vscode-remote:") path = decodedPathname(uri);
  else throw new TypeError("workspace URI scheme is unsupported");
  if (!isAbsolute(path) || /[\u0000\r\n]/u.test(path)) throw new TypeError("workspace path is invalid");
  return resolve(path);
}

async function assertWorkspaceRoot(fs, workspace) {
  const root = workspacePath(workspace);
  const metadata = await fs.lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await fs.realpath(root) !== root) {
    throw new TypeError("workspace root is not one real directory");
  }
  return root;
}

async function directoryNames(fs, path) {
  const names = await fs.readdir(path);
  names.sort(compareUtf8Bytes);
  const folded = new Set();
  for (const name of names) {
    const key = name.normalize("NFC").toLowerCase();
    if (folded.has(key)) throw new TypeError("workspace contains a case-fold alias");
    folded.add(key);
  }
  return names;
}

async function inspectRelative(fs, root, relativePath) {
  const parts = safeRelativePath(relativePath);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    const names = await directoryNames(fs, current);
    const requested = parts[index];
    const alias = names.find(name => name.normalize("NFC").toLowerCase() === requested.toLowerCase());
    if (alias !== undefined && alias !== requested) {
      throw new TypeError("workspace path resolves through a case-fold alias");
    }
    current = join(current, requested);
    let metadata;
    try { metadata = await fs.lstat(current); }
    catch (error) {
      if (error?.code === "ENOENT") return Object.freeze({ path: current, metadata: null });
      throw error;
    }
    if (index < parts.length - 1 && (!metadata.isDirectory() || metadata.isSymbolicLink())) {
      throw new TypeError("workspace path has a non-directory or symbolic ancestor");
    }
  }
  return Object.freeze({ path: current, metadata: await fs.lstat(current) });
}

async function readRegularFile(fs, path, maximumBytes = MAX_FILE_BYTES) {
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximumBytes) {
      throw new TypeError("workspace file is not a bounded unaliased regular file");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await fs.lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || before.dev !== current.dev || before.ino !== current.ino || bytes.byteLength !== before.size) {
      throw new TypeError("workspace file changed while it was read");
    }
    return Buffer.from(bytes);
  }
  finally {
    await handle.close();
  }
}

function passiveImagePlaceholder(epoch, reason) {
  return Object.freeze({ kind: "passive-image-placeholder", epoch, reason });
}

function passivePagePath(workspace, pageUri) {
  const root = new URL(workspace);
  const page = new URL(pageUri);
  const prefix = root.pathname === "/" ? "/" : `${root.pathname.replace(/\/+$/u, "")}/`;
  if (page.protocol !== root.protocol || page.host !== root.host || !page.pathname.startsWith(prefix)) return null;
  let relative;
  try { relative = decodeURIComponent(page.pathname.slice(prefix.length)); }
  catch { return null; }
  if (!relative.startsWith("documentation/") || !relative.toLowerCase().endsWith(".qmd")) return null;
  try { safeRelativePath(relative); }
  catch { return null; }
  return relative;
}

function passiveTargetPath(pagePath, target) {
  if (typeof target !== "string" || target.length === 0 || Buffer.byteLength(target, "utf8") > 4096
    || target.startsWith("/") || target.includes("\\") || /[%:?#\u0000-\u001f\u007f]/u.test(target)
    || target.normalize("NFC") !== target) return null;
  const parts = pagePath.split("/");
  parts.pop();
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length <= 1) return null;
      parts.pop();
      continue;
    }
    if (part.normalize("NFC") !== part) return null;
    parts.push(part);
  }
  if (parts[0] !== "documentation" || parts.length < 2) return null;
  const value = parts.join("/");
  try { safeRelativePath(value); }
  catch { return null; }
  return value;
}

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && new Set(["GIF87a", "GIF89a"]).has(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brands = bytes.subarray(8, Math.min(bytes.length, 32)).toString("ascii");
    if (brands.includes("avif") || brands.includes("avis")) return "image/avif";
  }
  return null;
}

async function passiveImageResult(fs, root, request) {
  const pagePath = passivePagePath(request.workspace, request.snapshot.pageUri);
  const relativePath = pagePath && passiveTargetPath(pagePath, request.snapshot.target);
  if (!relativePath) return passiveImagePlaceholder(request.epoch, "unsafe");
  const dot = relativePath.lastIndexOf(".");
  const expectedMime = dot < 0 ? undefined : PASSIVE_IMAGE_EXTENSIONS.get(relativePath.slice(dot).toLowerCase());
  if (!expectedMime || !PASSIVE_IMAGE_MIME.includes(expectedMime)) return passiveImagePlaceholder(request.epoch, "unsupported-type");
  let inspected;
  try { inspected = await inspectRelative(fs, root, relativePath); }
  catch { return passiveImagePlaceholder(request.epoch, "unsafe"); }
  if (!inspected.metadata) return passiveImagePlaceholder(request.epoch, "missing");
  if (!inspected.metadata.isFile() || inspected.metadata.isSymbolicLink() || inspected.metadata.nlink !== 1) {
    return passiveImagePlaceholder(request.epoch, "unsafe");
  }
  if (inspected.metadata.size > request.snapshot.maxBytes) return passiveImagePlaceholder(request.epoch, "too-large");
  let bytes;
  try { bytes = await readRegularFile(fs, inspected.path, request.snapshot.maxBytes); }
  catch { return passiveImagePlaceholder(request.epoch, "unavailable"); }
  const detected = imageMime(bytes);
  if (!detected || detected !== expectedMime || !request.snapshot.allowedMime.includes(detected)) {
    return passiveImagePlaceholder(request.epoch, "mime-mismatch");
  }
  const digest = sha256(bytes);
  return Object.freeze({
    kind: "passive-image",
    epoch: request.epoch,
    mime: detected,
    size: bytes.byteLength,
    sha256: digest,
    revision: `sha256:${digest}`,
    bytes: bytes.toString("base64url"),
  });
}

function overlayPaths(request) {
  const workspace = new URL(request.workspace);
  const basePath = workspace.pathname === "/" ? "/" : `${workspace.pathname.replace(/\/+$/u, "")}/`;
  const values = new Map();
  const aliases = new Set();
  for (const overlay of request.snapshot.overlays) {
    const uri = new URL(overlay.uri);
    if (uri.protocol !== workspace.protocol || uri.host !== workspace.host || !uri.pathname.startsWith(basePath)) {
      throw new TypeError("TextDocument overlay is outside the workspace");
    }
    const relativePath = decodeURIComponent(uri.pathname.slice(basePath.length));
    safeRelativePath(relativePath);
    const folded = relativePath.toLowerCase();
    if (values.has(relativePath) || aliases.has(folded)) throw new TypeError("TextDocument overlays contain an alias");
    aliases.add(folded);
    values.set(relativePath, overlay);
  }
  return values;
}

async function directoryGeneration(fs, path) {
  const records = [];
  for (const name of await directoryNames(fs, path)) {
    const child = join(path, name);
    const metadata = await fs.lstat(child);
    if (metadata.isSymbolicLink()) {
      records.push([name, "symlink", await fs.readlink(child)]);
    }
    else if (metadata.isDirectory()) records.push([name, "directory"]);
    else if (metadata.isFile() && metadata.nlink === 1) records.push([name, "file"]);
    else throw new TypeError("workspace directory contains an unsafe entry");
  }
  return `sha256:${sha256(Buffer.from(canonicalJson(records), "utf8"))}`;
}

async function snapshotEntry(fs, root, relativePath, overlay) {
  const inspected = await inspectRelative(fs, root, relativePath);
  if (!inspected.metadata) {
    if (!overlay) return Object.freeze({ path: relativePath, type: "absent" });
    const bytes = Buffer.from(overlay.text, "utf8");
    return Object.freeze({
      path: relativePath,
      type: "file",
      bytes: bytes.toString("base64url"),
      sha256: sha256(bytes),
      revision: overlay.revision,
    });
  }
  if (inspected.metadata.isSymbolicLink()) {
    if (overlay) throw new TypeError("TextDocument overlay targets a symbolic link");
    return Object.freeze({ path: relativePath, type: "symlink", target: await fs.readlink(inspected.path) });
  }
  if (inspected.metadata.isDirectory()) {
    if (overlay) throw new TypeError("TextDocument overlay targets a directory");
    return Object.freeze({
      path: relativePath,
      type: "directory",
      directoryGeneration: await directoryGeneration(fs, inspected.path),
    });
  }
  if (!inspected.metadata.isFile() || inspected.metadata.nlink !== 1) {
    throw new TypeError("workspace path is not a safe snapshot entry");
  }
  const bytes = overlay ? Buffer.from(overlay.text, "utf8") : await readRegularFile(fs, inspected.path);
  const digest = sha256(bytes);
  return Object.freeze({
    path: relativePath,
    type: "file",
    bytes: bytes.toString("base64url"),
    sha256: digest,
    revision: overlay?.revision ?? `sha256:${digest}`,
  });
}

async function collectDocumentationPages(fs, root, overlays) {
  const pages = new Map();
  const documentation = await inspectRelative(fs, root, "documentation");
  if (documentation.metadata) {
    if (!documentation.metadata.isDirectory() || documentation.metadata.isSymbolicLink()) {
      throw new TypeError("documentation root is not a real directory");
    }
    const visit = async (directory, prefix) => {
      for (const name of await directoryNames(fs, directory)) {
        const path = join(directory, name);
        const relativePath = prefix ? `${prefix}/${name}` : name;
        const metadata = await fs.lstat(path);
        if (metadata.isSymbolicLink()) throw new TypeError("documentation tree contains a symbolic link");
        if (metadata.isDirectory()) await visit(path, relativePath);
        else if (metadata.isFile() && metadata.nlink === 1 && relativePath.toLowerCase().endsWith(".qmd")) {
          const workspaceRelative = `documentation/${relativePath}`;
          const overlay = overlays.get(workspaceRelative);
          const bytes = overlay ? Buffer.from(overlay.text, "utf8") : await readRegularFile(fs, path);
          const digest = sha256(bytes);
          pages.set(relativePath, Object.freeze({
            path: relativePath,
            revision: overlay?.revision ?? `sha256:${digest}`,
          }));
          if (pages.size > MAX_ENTRIES) throw new RangeError("documentation tree has too many pages");
        }
        else if (!metadata.isFile() || metadata.nlink !== 1) {
          throw new TypeError("documentation tree contains an unsafe entry");
        }
      }
    };
    await visit(documentation.path, "");
  }
  for (const [relativePath, overlay] of overlays) {
    if (!relativePath.startsWith("documentation/") || !relativePath.toLowerCase().endsWith(".qmd")) continue;
    const pagePath = relativePath.slice("documentation/".length);
    safeRelativePath(pagePath);
    const folded = pagePath.toLowerCase();
    const alias = [...pages.keys()].find(value => value.toLowerCase() === folded && value !== pagePath);
    if (alias) throw new TypeError("documentation pages contain a case-fold alias");
    pages.set(pagePath, Object.freeze({ path: pagePath, revision: overlay.revision }));
  }
  return [...pages.values()].sort((left, right) => compareUtf8Bytes(left.path, right.path));
}

function migrationLimits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.maximumEntries !== 50_000
    || value.maximumBlobBytes !== 16 * 1024 * 1024
    || value.maximumAggregateBytes !== 64 * 1024 * 1024
    || value.maximumReportBytes !== 2 * 1024 * 1024) {
    throw new TypeError("migration planning limits differ from the product contract");
  }
  return value;
}

function contentFreeSnapshotRecord(record) {
  if (record.type === "file") {
    return Object.freeze({ path: record.path, type: record.type, digest: record.digest });
  }
  if (record.type === "directory") {
    return Object.freeze({
      path: record.path,
      type: record.type,
      directoryGeneration: record.directoryGeneration,
    });
  }
  return Object.freeze({ path: record.path, type: "absent" });
}

async function collectMigrationSnapshot(fs, root, request) {
  const limits = migrationLimits(request.snapshot.limits);
  const overlays = overlayPaths(request);
  const records = new Map();
  let aggregateBytes = 0;

  const add = record => {
    if (records.has(record.path)) throw new TypeError("migration snapshot contains a duplicate path");
    if (records.size >= limits.maximumEntries) throw new MigrationLimitError("maximum-entries");
    records.set(record.path, Object.freeze(record));
  };

  const addFile = async (relativePath, absolutePath) => {
    const overlay = overlays.get(relativePath);
    let bytes;
    if (overlay) bytes = Buffer.from(overlay.text, "utf8");
    else {
      const metadata = await fs.lstat(absolutePath);
      if (metadata.size > limits.maximumBlobBytes) throw new MigrationLimitError("maximum-blob-bytes");
      bytes = await readRegularFile(fs, absolutePath, limits.maximumBlobBytes);
    }
    if (bytes.byteLength > limits.maximumBlobBytes) throw new MigrationLimitError("maximum-blob-bytes");
    aggregateBytes += bytes.byteLength;
    if (aggregateBytes > limits.maximumAggregateBytes) {
      throw new MigrationLimitError("maximum-aggregate-bytes");
    }
    add({
      path: relativePath,
      type: "file",
      bytes,
      digest: `sha256:${sha256(bytes)}`,
    });
  };

  const visitDirectory = async (relativePath, absolutePath) => {
    const before = await directoryGeneration(fs, absolutePath);
    add({ path: relativePath, type: "directory", directoryGeneration: before });
    for (const name of await directoryNames(fs, absolutePath)) {
      const childRelative = `${relativePath}/${name}`;
      const child = join(absolutePath, name);
      const metadata = await fs.lstat(child);
      if (metadata.isSymbolicLink()) throw new TypeError("migration source contains a symbolic link");
      if (metadata.isDirectory()) await visitDirectory(childRelative, child);
      else if (metadata.isFile() && metadata.nlink === 1) await addFile(childRelative, child);
      else throw new TypeError("migration source contains an unsafe entry");
    }
    if (await directoryGeneration(fs, absolutePath) !== before) {
      throw new MigrationSnapshotChangedError("migration directory changed during snapshot");
    }
  };

  const collectRoot = async relativePath => {
    const inspected = await inspectRelative(fs, root, relativePath);
    if (!inspected.metadata) {
      add({ path: relativePath, type: "absent" });
      return;
    }
    if (!inspected.metadata.isDirectory() || inspected.metadata.isSymbolicLink()) {
      throw new TypeError("migration root is not a real directory");
    }
    await visitDirectory(relativePath, inspected.path);
  };

  for (const relativePath of MIGRATION_ROOTS) await collectRoot(relativePath);
  await collectRoot(LEGACY_PROPOSAL_ROOT);

  const privateRoot = await inspectRelative(fs, root, ".chatero");
  if (!privateRoot.metadata) add({ path: ".chatero", type: "absent" });
  else if (privateRoot.metadata.isDirectory() && !privateRoot.metadata.isSymbolicLink()) {
    add({
      path: ".chatero",
      type: "directory",
      directoryGeneration: await directoryGeneration(fs, privateRoot.path),
    });
  }
  else throw new TypeError("Documentation private root is unsafe");

  const state = await inspectRelative(fs, root, STATE_PATH);
  if (!state.metadata) add({ path: STATE_PATH, type: "absent" });
  else if (state.metadata.isFile() && !state.metadata.isSymbolicLink() && state.metadata.nlink === 1) {
    await addFile(STATE_PATH, state.path);
  }
  else throw new TypeError("Documentation state path is unsafe");

  for (const [relativePath, overlay] of overlays) {
    const tracked = MIGRATION_ROOTS.some(prefix => relativePath.startsWith(`${prefix}/`))
      || relativePath.startsWith(`${LEGACY_PROPOSAL_ROOT}/`) || relativePath === STATE_PATH;
    if (!tracked || records.get(relativePath)?.type === "file") continue;
    const bytes = Buffer.from(overlay.text, "utf8");
    if (bytes.byteLength > limits.maximumBlobBytes) throw new MigrationLimitError("maximum-blob-bytes");
    aggregateBytes += bytes.byteLength;
    if (aggregateBytes > limits.maximumAggregateBytes) {
      throw new MigrationLimitError("maximum-aggregate-bytes");
    }
    if (records.has(relativePath)) records.delete(relativePath);
    add({ path: relativePath, type: "file", bytes, digest: `sha256:${sha256(bytes)}` });
  }

  const sorted = [...records.values()].sort((left, right) => compareUtf8Bytes(left.path, right.path));
  const digest = digestValue(sorted.map(contentFreeSnapshotRecord));
  return Object.freeze({ records: Object.freeze(sorted), digest });
}

function migrationEntries(snapshot, root) {
  const prefix = `${root}/`;
  return snapshot.records
    .filter(record => record.type === "file" && record.path.startsWith(prefix))
    .map(record => Object.freeze({
      path: record.path.slice(prefix.length),
      revision: record.digest,
    }));
}

function migrationMappingRecords(mapping) {
  return [...mapping.pages, ...mapping.assets]
    .map(entry => {
      const value = {
        kind: entry.kind,
        sourceRoot: entry.sourceRoot,
        sourcePath: entry.sourcePath,
        sourceRevision: entry.sourceRevision,
        destinationPath: entry.destination.value,
        reason: entry.reason,
      };
      if (entry.kind === "page") value.state = entry.state;
      return Object.freeze(value);
    })
    .sort((left, right) => ({ knowledge: 0, drafts: 1 })[left.sourceRoot]
      - ({ knowledge: 0, drafts: 1 })[right.sourceRoot]
      || compareUtf8Bytes(left.sourcePath, right.sourcePath));
}

function migrationRecord(snapshot, path) {
  return snapshot.records.find(record => record.path === path) ?? null;
}

function migrationRewriteSummaries(snapshot, mapping) {
  const summaries = [];
  const outputDigests = new Map();
  for (const entry of [...mapping.pages, ...mapping.assets]) {
    const sourcePath = `${entry.sourceRoot}/${entry.sourcePath}`;
    const source = migrationRecord(snapshot, sourcePath);
    if (!source || source.type !== "file") throw new MigrationSnapshotChangedError("migration source disappeared");
    if (entry.kind === "asset") {
      outputDigests.set(entry.destination.value, source.digest);
      continue;
    }
    const rewritten = rewriteLegacyReferences({
      sourcePath,
      destinationPath: entry.destination,
      bytes: source.bytes,
      mapping,
    });
    const migratedDigest = `sha256:${sha256(rewritten.bytes)}`;
    outputDigests.set(entry.destination.value, migratedDigest);
    summaries.push(Object.freeze({
      sourcePath,
      destinationPath: entry.destination.value,
      sourceDigest: source.digest,
      migratedDigest,
      edits: Object.freeze(rewritten.edits.map(edit => Object.freeze({
        from: edit.from,
        to: edit.to,
        syntax: edit.syntax,
      }))),
      followUps: Object.freeze(rewritten.followUps.map(value => Object.freeze({
        from: value.from,
        to: value.to,
        code: value.code,
      }))),
    }));
  }
  summaries.sort((left, right) => compareUtf8Bytes(left.sourcePath, right.sourcePath));
  return Object.freeze({ summaries: Object.freeze(summaries), outputDigests });
}

function migrationProposalEvidence(snapshot) {
  const records = [];
  const blobs = new Map();
  for (const record of snapshot.records) {
    if (record.type !== "file" || !record.path.startsWith(`${LEGACY_PROPOSAL_ROOT}/`)) continue;
    if (record.path.endsWith("/manifest.json")) {
      records.push(Object.freeze({ path: record.path, bytes: record.bytes }));
    }
    else blobs.set(record.path, record.bytes);
  }
  return Object.freeze({ records: Object.freeze(records), blobs });
}

function migrationStateOutput(mapping) {
  const documents = mapping.pages.map(entry => Object.freeze({
    path: entry.destination.value,
    state: entry.state,
  }));
  documents.sort((left, right) => compareUtf8Bytes(left.path, right.path));
  return Object.freeze({
    generation: "0000000000000001",
    documents: Object.freeze(documents),
  });
}

function stateOutputBytes(stateOutput) {
  const documents = Object.fromEntries(stateOutput.documents.map(value => [value.path, { state: value.state }]));
  return Buffer.from(`${canonicalJson({ schemaVersion: 1, generation: stateOutput.generation, documents })}\n`, "utf8");
}

function migrationPathProofs(snapshot, mapping, outputDigests, stateOutput) {
  const proofs = new Map();
  const add = proof => {
    if (proofs.has(proof.path)) throw new TypeError("migration path proofs contain a duplicate path");
    proofs.set(proof.path, Object.freeze(proof));
  };
  for (const record of snapshot.records) {
    const source = ["knowledge", "drafts", LEGACY_PROPOSAL_ROOT].some(root =>
      record.path === root || record.path.startsWith(`${root}/`));
    if (!source || record.type === "absent") continue;
    add(record.type === "file"
      ? { path: record.path, role: "source", expectedDigest: record.digest, requireClean: true }
      : {
          path: record.path,
          role: "source",
          directoryGeneration: record.directoryGeneration,
          requireClean: true,
        });
  }
  for (const rootPath of [".chatero", "documentation"]) {
    const record = migrationRecord(snapshot, rootPath);
    add(record?.type === "directory"
      ? {
          path: rootPath,
          role: "target",
          directoryGeneration: record.directoryGeneration,
          requireClean: true,
        }
      : { path: rootPath, role: "target", targetAbsent: true, requireClean: true });
  }
  for (const entry of [...mapping.pages, ...mapping.assets]) {
    const path = `documentation/${entry.destination.value}`;
    add({
      path,
      role: "target",
      intendedDigest: outputDigests.get(entry.destination.value),
      targetAbsent: true,
      requireClean: true,
    });
  }
  add({
    path: STATE_PATH,
    role: "target",
    intendedDigest: `sha256:${sha256(stateOutputBytes(stateOutput))}`,
    targetAbsent: true,
    requireClean: true,
  });
  return Object.freeze([...proofs.values()].sort((left, right) => compareUtf8Bytes(left.path, right.path)));
}

function migrationDiagnostics(rewrites, proposalDiagnostics) {
  const values = proposalDiagnostics.map(value => Object.freeze({
    code: value.code,
    recordPath: value.recordPath,
  }));
  for (const rewrite of rewrites) {
    if (rewrite.followUps.length > 0) {
      values.push(Object.freeze({ code: "reference-follow-up", path: rewrite.sourcePath }));
    }
  }
  values.sort((left, right) => compareUtf8Bytes(left.path ?? left.recordPath, right.path ?? right.recordPath)
    || compareUtf8Bytes(left.code, right.code));
  return Object.freeze(values);
}

function migrationReportModel({ mappings, collisions, proposals, rewrites, diagnostics }) {
  const followUps = rewrites.reduce((count, value) => count + value.followUps.length, 0)
    + diagnostics.length;
  return Object.freeze({
    schemaVersion: 1,
    title: "Documentation migration dry run",
    summary: Object.freeze({
      pages: mappings.filter(value => value.kind === "page").length,
      assets: mappings.filter(value => value.kind === "asset").length,
      collisions: collisions.length,
      proposals: proposals.length,
      followUps,
    }),
    sections: Object.freeze([
      Object.freeze({
        heading: "Planned mappings",
        items: Object.freeze(mappings.map(value =>
          `${value.sourceRoot}/${value.sourcePath} -> documentation/${value.destinationPath}`)),
      }),
      Object.freeze({
        heading: "Conflicts and follow-ups",
        items: Object.freeze([
          ...collisions.map(value => `${value.path}: ${value.contentRelation} Knowledge/Draft collision`),
          ...diagnostics.map(value => `${value.path ?? value.recordPath}: ${value.code}`),
        ]),
      }),
    ]),
  });
}

async function planMigrationResult(fs, root, request) {
  const limits = migrationLimits(request.snapshot.limits);
  let source;
  try { source = await collectMigrationSnapshot(fs, root, request); }
  catch (error) {
    if (error instanceof MigrationLimitError) {
      return Object.freeze({ kind: "migration-limit", workspaceEpoch: request.epoch, code: error.code });
    }
    if (error instanceof MigrationSnapshotChangedError) {
      return Object.freeze({ kind: "stale-plan-evidence", workspaceEpoch: request.epoch, code: "snapshot-changed" });
    }
    throw error;
  }

  const documentationEntries = source.records.filter(record =>
    record.path.startsWith("documentation/") && record.type !== "absent");
  if (documentationEntries.length > 0) {
    return Object.freeze({
      kind: "migration-conflict",
      workspaceEpoch: request.epoch,
      code: "documentation-not-empty",
      paths: Object.freeze(documentationEntries.map(value => value.path).sort(compareUtf8Bytes)),
    });
  }
  if (migrationRecord(source, STATE_PATH)?.type === "file") {
    return Object.freeze({
      kind: "migration-conflict",
      workspaceEpoch: request.epoch,
      code: "documentation-state-exists",
      paths: Object.freeze([STATE_PATH]),
    });
  }

  let mapping;
  try {
    mapping = buildLegacyMigrationMapping({
      knowledge: migrationEntries(source, "knowledge"),
      drafts: migrationEntries(source, "drafts"),
      documentation: [],
    });
  }
  catch (error) {
    if (error instanceof TypeError) {
      return Object.freeze({
        kind: "migration-conflict",
        workspaceEpoch: request.epoch,
        code: "unsafe-legacy-layout",
        paths: Object.freeze([]),
      });
    }
    throw error;
  }
  const rewrites = migrationRewriteSummaries(source, mapping);
  const proposalEvidence = migrationProposalEvidence(source);
  const classified = classifyLegacyProposals({
    records: proposalEvidence.records,
    blobs: proposalEvidence.blobs,
    mapping,
  });
  const mappings = Object.freeze(migrationMappingRecords(mapping));
  const stateOutput = migrationStateOutput(mapping);
  const pathProofs = migrationPathProofs(source, mapping, rewrites.outputDigests, stateOutput);
  const affectedPaths = Object.freeze(pathProofs.map(value => value.path));
  const diagnostics = migrationDiagnostics(rewrites.summaries, classified.diagnostics);
  let verification;
  try { verification = await collectMigrationSnapshot(fs, root, request); }
  catch (error) {
    if (error instanceof MigrationLimitError) {
      return Object.freeze({ kind: "migration-limit", workspaceEpoch: request.epoch, code: error.code });
    }
    if (error instanceof MigrationSnapshotChangedError) {
      return Object.freeze({ kind: "stale-plan-evidence", workspaceEpoch: request.epoch, code: "snapshot-changed" });
    }
    throw error;
  }
  if (source.digest !== verification.digest) {
    return Object.freeze({
      kind: "stale-plan-evidence",
      workspaceEpoch: request.epoch,
      code: "snapshot-changed",
    });
  }

  const planRecord = Object.freeze({
    schemaVersion: 1,
    sourceSnapshotDigest: source.digest,
    verificationSnapshotDigest: verification.digest,
    affectedPaths,
    pathProofs,
    mappings,
    stateOutput,
    collisions: mapping.collisions,
    rewrites: rewrites.summaries,
    proposals: classified.proposals,
    diagnostics,
  });
  if (Buffer.byteLength(canonicalJson(planRecord), "utf8") > MAX_FILE_BYTES) {
    return Object.freeze({
      kind: "migration-limit",
      workspaceEpoch: request.epoch,
      code: "maximum-plan-bytes",
    });
  }
  const reportModel = migrationReportModel({
    mappings,
    collisions: mapping.collisions,
    proposals: classified.proposals,
    rewrites: rewrites.summaries,
    diagnostics,
  });
  if (Buffer.byteLength(canonicalJson(reportModel), "utf8") > limits.maximumReportBytes) {
    return Object.freeze({
      kind: "migration-limit",
      workspaceEpoch: request.epoch,
      code: "maximum-report-bytes",
    });
  }
  return Object.freeze({
    kind: "migration-plan",
    workspaceEpoch: request.epoch,
    planDigest: digestValue(planRecord),
    planRecord,
    reportModel,
  });
}

async function snapshotResult(fs, root, request) {
  const overlays = overlayPaths(request);
  if (request.snapshot.kind === "passive-image") return passiveImageResult(fs, root, request);
  if (request.snapshot.kind === "paths") {
    const entries = [];
    for (const path of request.snapshot.paths) entries.push(await snapshotEntry(fs, root, path, overlays.get(path)));
    entries.sort((left, right) => compareUtf8Bytes(left.path, right.path));
    return Object.freeze({ kind: "snapshot", epoch: request.epoch, entries: Object.freeze(entries) });
  }
  if (request.snapshot.kind === "documentation-state") {
    const pages = await collectDocumentationPages(fs, root, overlays);
    const state = await inspectRelative(fs, root, STATE_PATH);
    if (!state.metadata) {
      return Object.freeze({
        kind: "documentation-state",
        epoch: request.epoch,
        pages: Object.freeze(pages),
        state: Object.freeze({ kind: "missing" }),
      });
    }
    if (!state.metadata.isFile() || state.metadata.isSymbolicLink() || state.metadata.nlink !== 1) {
      throw new TypeError("Documentation state path is unsafe");
    }
    const bytes = await readRegularFile(fs, state.path, 4 * 1024 * 1024);
    const digest = sha256(bytes);
    return Object.freeze({
      kind: "documentation-state",
      epoch: request.epoch,
      pages: Object.freeze(pages),
      state: Object.freeze({
        kind: "file",
        bytes: bytes.toString("base64url"),
        sha256: digest,
        revision: `sha256:${digest}`,
      }),
    });
  }
  if (request.snapshot.kind === "plan-migration") {
    return planMigrationResult(fs, root, request);
  }
  throw new TypeError("Documentation snapshot operation is not implemented");
}

async function ensureDirectory(fs, root, relativePath, { privateMode = false } = {}) {
  const parts = safeRelativePath(relativePath);
  let current = root;
  for (const [index, part] of parts.entries()) {
    const requirePrivateMode = privateMode && index === parts.length - 1;
    current = join(current, part);
    let metadata;
    try { metadata = await fs.lstat(current); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await fs.mkdir(current, { mode: requirePrivateMode ? PRIVATE_DIRECTORY_MODE : 0o755 });
      metadata = await fs.lstat(current);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new TypeError("authority directory is unsafe");
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new TypeError("authority directory owner is unsafe");
    }
    if ((metadata.mode & 0o022) !== 0) throw new TypeError("authority directory is group or world writable");
    if (requirePrivateMode && (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      throw new TypeError("authority private directory mode is unsafe");
    }
  }
  return current;
}

async function syncDirectory(fs, path) {
  const handle = await fs.open(path, constants.O_RDONLY);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function exclusiveWrite(fs, path, bytes) {
  const handle = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  }
  finally { await handle.close(); }
  await syncDirectory(fs, dirname(path));
}

async function atomicWrite(fs, path, bytes) {
  const temporary = join(dirname(path), `.${path.split(sep).at(-1)}.${randomUUID()}.tmp`);
  try {
    await exclusiveWrite(fs, temporary, bytes);
    await fs.rename(temporary, path);
    await syncDirectory(fs, dirname(path));
  }
  finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readOptional(fs, path, maximumBytes = 8 * 1024 * 1024) {
  try { return await readRegularFile(fs, path, maximumBytes); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readCanonicalJson(fs, path) {
  const bytes = await readOptional(fs, path);
  if (bytes === null) return null;
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || !text.endsWith("\n")) {
    throw new TypeError("authority journal is not canonical UTF-8 JSON");
  }
  const value = JSON.parse(text.slice(0, -1));
  if (!serializedJson(value).equals(bytes)) throw new TypeError("authority journal is not canonical JSON");
  return value;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

async function acquireLease(fs, root, clock) {
  await ensureDirectory(fs, root, ".chatero");
  const path = join(root, ...safeRelativePath(LEASE_PATH));
  const token = randomUUID();
  const record = Object.freeze({ schemaVersion: 1, pid: process.pid, token, createdAt: clock.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await exclusiveWrite(fs, path, serializedJson(record));
      return Object.freeze({ path, token });
    }
    catch (error) {
      if (error?.code !== "EEXIST" || attempt !== 0) throw error;
      const existing = await readCanonicalJson(fs, path);
      if (processAlive(existing?.pid)) throw new Error("Documentation authority is busy");
      const stale = `${path}.stale.${randomUUID()}`;
      await fs.rename(path, stale);
      await fs.rm(stale, { force: true });
      await syncDirectory(fs, dirname(path));
    }
  }
  throw new Error("Documentation authority lease is unavailable");
}

async function releaseLease(fs, lease) {
  const current = await readCanonicalJson(fs, lease.path);
  if (current?.token !== lease.token) throw new Error("Documentation authority lease ownership changed");
  await fs.rm(lease.path);
  await syncDirectory(fs, dirname(lease.path));
}

async function withLease(fs, root, clock, callback) {
  const lease = await acquireLease(fs, root, clock);
  let failure;
  try { return await callback(); }
  catch (error) { failure = error; throw error; }
  finally {
    try { await releaseLease(fs, lease); }
    catch (error) { if (!failure) throw error; }
  }
}

async function createFilesystemAuthority(fs, root) {
  const operations = await ensureDirectory(fs, root, OPERATIONS_PATH, { privateMode: true });
  const receipts = await ensureDirectory(fs, root, RECEIPTS_PATH, { privateMode: true });
  const statePath = join(root, ...safeRelativePath(STATE_PATH));
  const operationPath = operationId => join(operations, `${operationId}.json`);
  const receiptPath = operationId => join(receipts, `${operationId}.json`);
  return Object.freeze({
    readOperation: operationId => readCanonicalJson(fs, operationPath(operationId)),
    createOperation: record => exclusiveWrite(fs, operationPath(record.operationId), serializedJson(record)),
    updateOperation: record => atomicWrite(fs, operationPath(record.operationId), serializedJson(record)),
    readReceipt: operationId => readCanonicalJson(fs, receiptPath(operationId)),
    async writeReceipt(operationId, result) {
      const path = receiptPath(operationId);
      const existing = await readCanonicalJson(fs, path);
      if (existing !== null) {
        if (canonicalJson(existing) !== canonicalJson(result)) throw new Error("Documentation receipt conflicts");
        return;
      }
      try { await exclusiveWrite(fs, path, serializedJson(result)); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const raced = await readCanonicalJson(fs, path);
        if (canonicalJson(raced) !== canonicalJson(result)) throw new Error("Documentation receipt conflicts");
      }
    },
    readState: () => readOptional(fs, statePath, 4 * 1024 * 1024),
    writeState: bytes => atomicWrite(fs, statePath, Buffer.from(bytes)),
    async readPageRevision(path, workingCopy) {
      const entry = await inspectRelative(fs, root, `documentation/${path}`);
      if (!entry.metadata) return null;
      if (!entry.metadata.isFile() || entry.metadata.isSymbolicLink() || entry.metadata.nlink !== 1) {
        throw new TypeError("Documentation page path is unsafe");
      }
      const bytes = await readRegularFile(fs, entry.path);
      return Object.freeze({
        revision: `sha256:${sha256(bytes)}`,
        dirty: workingCopy?.dirty === true,
      });
    },
  });
}

async function dispatch(fs, clock, request) {
  const root = await assertWorkspaceRoot(fs, request.workspace);
  if (request.kind === "snapshot") return snapshotResult(fs, root, request);
  return withLease(fs, root, clock, async () => {
    const authority = await createFilesystemAuthority(fs, root);
    const executor = createStateTransactionExecutor({ authority });
    if (request.kind === "transact") return executor.execute(request.transaction);
    if (request.kind === "recover") return executor.recover(request.recovery);
    throw new TypeError("Documentation authority operation is unsupported");
  });
}

async function readOneFrame(stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_FRAME_BYTES + 1) throw new RangeError("Documentation authority request frame is too large");
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength < 2 || bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a)) {
    throw new TypeError("Documentation authority requires exactly one newline-terminated frame");
  }
  const frameBytes = bytes.subarray(0, -1);
  const frame = frameBytes.toString("ascii");
  if (!Buffer.from(frame, "ascii").equals(frameBytes)) throw new TypeError("Documentation authority frame is not ASCII");
  return frame;
}

async function writeOneFrame(stdout, frame) {
  const bytes = Buffer.from(`${frame}\n`, "ascii");
  if (bytes.byteLength > MAX_FRAME_BYTES + 1) throw new RangeError("Documentation authority response frame is too large");
  await new Promise((resolveWrite, rejectWrite) => {
    stdout.write(bytes, error => error ? rejectWrite(error) : resolveWrite());
  });
}

export async function runDocumentationAuthority({
  stdin = process.stdin,
  stdout = process.stdout,
  filesystem = nodeFilesystem,
  clock = Date,
} = {}) {
  if (!stdin || !stdout || !filesystem || typeof clock?.now !== "function") {
    throw new TypeError("Documentation authority dependencies are invalid");
  }
  const request = decodeAuthorityRequest(await readOneFrame(stdin));
  const result = await dispatch(filesystem, clock, request);
  const response = encodeAuthorityResponse({
    protocolVersion: 1,
    requestId: request.requestId,
    result,
  });
  await writeOneFrame(stdout, response);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDocumentationAuthority().catch(() => { process.exitCode = 1; });
}
