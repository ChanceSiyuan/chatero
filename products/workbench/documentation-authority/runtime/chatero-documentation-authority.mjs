#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as nodeFilesystem from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createStateTransactionExecutor } from "../documentation-operations.mjs";
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

async function snapshotResult(fs, root, request) {
  const overlays = overlayPaths(request);
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
