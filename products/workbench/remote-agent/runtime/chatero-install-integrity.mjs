#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const INSTALL_TREE_MANIFEST_PATH = "integrity/tree.v1.json";
const INSTALL_MARKER_PATH = ".chatero-release-sha256";
const ALLOWED_SYMLINK_PATH = "agent-sdk/codex/node_modules/.bin/codex";
const ALLOWED_SYMLINK_TARGET = "../@openai/codex/bin/codex.js";
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;
const MODE = /^0[0-7]{3}$/u;
const MAX_ENTRIES = 200_000;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeMode(metadata, path) {
  const value = metadata.mode & 0o7777;
  if ((value & 0o7022) !== 0) throw new TypeError(`unsafe mode for ${path}`);
  return value.toString(8).padStart(4, "0");
}

function validatePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/")
    || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some(part => !part || part === "." || part === "..")
    || value.normalize("NFC") !== value) {
    throw new TypeError("install tree manifest contains an unsafe path");
  }
  return value;
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
    throw new TypeError(`${label} has an invalid schema`);
  }
  return value;
}

function freezeRecord(record) {
  return Object.freeze(record);
}

async function assertRoot(root, { validateMode = true } = {}) {
  const canonical = resolve(root);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(canonical) !== canonical) {
    throw new TypeError("install root must be one real directory");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new TypeError("install root owner is invalid");
  }
  if (validateMode) safeMode(metadata, ".");
  return canonical;
}

async function normalizeBuildModes(root) {
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  const visit = async path => {
    const metadata = await lstat(path);
    if (expectedUid !== null && metadata.uid !== expectedUid) throw new TypeError("build tree owner is invalid");
    if (metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      await chmod(path, 0o755);
      for (const name of await readdir(path)) await visit(join(path, name));
      return;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) throw new TypeError("build tree entry is unsafe");
    await chmod(path, (metadata.mode & 0o111) === 0 ? 0o644 : 0o755);
  };
  await visit(root);
}

async function hashRegularFile(path, relativePath, expectedUid) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (expectedUid !== null && before.uid !== expectedUid)) {
      throw new TypeError(`unsafe regular file ${relativePath}`);
    }
    const hash = createHash("sha256");
    let size = 0;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      size += chunk.byteLength;
      hash.update(chunk);
    }
    const after = await handle.stat();
    const pathMetadata = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino
      || size !== before.size) {
      throw new TypeError(`file changed while hashing ${relativePath}`);
    }
    return freezeRecord({
      path: relativePath,
      type: "file",
      mode: safeMode(before, relativePath),
      size,
      sha256: hash.digest("hex"),
    });
  }
  finally {
    await handle.close();
  }
}

async function validateExcludedFile(root, relativePath, { marker = false } = {}) {
  const path = join(root, ...relativePath.split("/"));
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new TypeError(`excluded install file is unsafe: ${relativePath}`);
  }
  if (marker && (metadata.mode & 0o7777) !== 0o600) {
    throw new TypeError("install marker mode is unsafe");
  }
  safeMode(metadata, relativePath);
}

async function collectInstallTree(root) {
  const canonicalRoot = await assertRoot(root);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  const records = [];
  const aliases = new Set();
  const visit = async (directory, prefix) => {
    const names = await readdir(directory);
    names.sort(compareUtf8Bytes);
    for (const name of names) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      validatePath(relativePath);
      const folded = relativePath.toLowerCase();
      if (aliases.has(folded)) throw new TypeError("install tree contains a case-fold alias");
      aliases.add(folded);
      if (relativePath === INSTALL_TREE_MANIFEST_PATH) {
        await validateExcludedFile(canonicalRoot, relativePath);
        continue;
      }
      if (relativePath === INSTALL_MARKER_PATH) {
        await validateExcludedFile(canonicalRoot, relativePath, { marker: true });
        continue;
      }
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (expectedUid !== null && metadata.uid !== expectedUid) {
        throw new TypeError(`install entry owner is unsafe: ${relativePath}`);
      }
      if (metadata.isSymbolicLink()) {
        if (relativePath !== ALLOWED_SYMLINK_PATH) throw new TypeError("install tree contains an unlisted symlink");
        const linkTarget = await readlink(path);
        if (linkTarget !== ALLOWED_SYMLINK_TARGET) throw new TypeError("Codex shim target is invalid");
        const expectedTarget = join(canonicalRoot, "agent-sdk", "codex", "node_modules", "@openai", "codex", "bin", "codex.js");
        if (await realpath(path) !== expectedTarget) throw new TypeError("Codex shim escapes its fixed target");
        records.push(freezeRecord({ path: relativePath, type: "symlink", target: linkTarget }));
      }
      else if (metadata.isDirectory()) {
        records.push(freezeRecord({
          path: relativePath,
          type: "directory",
          mode: safeMode(metadata, relativePath),
        }));
        await visit(path, relativePath);
      }
      else if (metadata.isFile()) {
        records.push(await hashRegularFile(path, relativePath, expectedUid));
      }
      else {
        throw new TypeError(`install tree contains an unsafe entry: ${relativePath}`);
      }
      if (records.length > MAX_ENTRIES) throw new RangeError("install tree has too many entries");
    }
  };
  await visit(canonicalRoot, "");
  records.sort((left, right) => compareUtf8Bytes(left.path, right.path));
  return Object.freeze(records);
}

function validateManifest(manifest) {
  exactObject(manifest, ["schemaVersion", "entries"], "install tree manifest");
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)
    || manifest.entries.length > MAX_ENTRIES) {
    throw new TypeError("install tree manifest schema is unsupported");
  }
  const records = [];
  const byPath = new Map();
  const aliases = new Set();
  let previous = null;
  for (const raw of manifest.entries) {
    if (!raw || typeof raw !== "object") throw new TypeError("install tree record is invalid");
    validatePath(raw.path);
    if (raw.path === INSTALL_TREE_MANIFEST_PATH || raw.path === INSTALL_MARKER_PATH) {
      throw new TypeError("install tree manifest lists an excluded path");
    }
    if (previous !== null && compareUtf8Bytes(previous, raw.path) >= 0) {
      throw new TypeError("install tree records are not unique and bytewise sorted");
    }
    const folded = raw.path.toLowerCase();
    if (aliases.has(folded)) throw new TypeError("install tree manifest contains a case-fold alias");
    aliases.add(folded);
    if (raw.type === "directory") {
      exactObject(raw, ["path", "type", "mode"], "install directory record");
    }
    else if (raw.type === "file") {
      exactObject(raw, ["path", "type", "mode", "size", "sha256"], "install file record");
      if (!Number.isSafeInteger(raw.size) || raw.size < 0 || !LOWERCASE_SHA256.test(raw.sha256)) {
        throw new TypeError("install file record metadata is invalid");
      }
    }
    else if (raw.type === "symlink") {
      exactObject(raw, ["path", "type", "target"], "install symlink record");
      if (raw.path !== ALLOWED_SYMLINK_PATH || raw.target !== ALLOWED_SYMLINK_TARGET) {
        throw new TypeError("install symlink record is not allowlisted");
      }
    }
    else {
      throw new TypeError("install tree record type is unsupported");
    }
    if (raw.type !== "symlink" && (!MODE.test(raw.mode) || (Number.parseInt(raw.mode, 8) & 0o7022) !== 0)) {
      throw new TypeError("install tree record mode is unsafe");
    }
    const record = raw.type === "directory"
      ? freezeRecord({ path: raw.path, type: raw.type, mode: raw.mode })
      : raw.type === "file"
        ? freezeRecord({
            path: raw.path,
            type: raw.type,
            mode: raw.mode,
            size: raw.size,
            sha256: raw.sha256,
          })
        : freezeRecord({ path: raw.path, type: raw.type, target: raw.target });
    records.push(record);
    byPath.set(record.path, record);
    previous = record.path;
  }
  for (const record of records) {
    const parts = record.path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const ancestor = parts.slice(0, index).join("/");
      if (byPath.get(ancestor)?.type !== "directory") {
        throw new TypeError("install tree record has a missing or non-directory ancestor");
      }
    }
  }
  return Object.freeze({ schemaVersion: 1, entries: Object.freeze(records) });
}

function serializeManifest(manifest) {
  const validated = validateManifest(manifest);
  return Buffer.from(`${JSON.stringify({ schemaVersion: 1, entries: validated.entries })}\n`, "utf8");
}

function parseManifest(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new TypeError("install tree manifest is not bounded bytes");
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer) || !text.endsWith("\n")) {
    throw new TypeError("install tree manifest is not canonical UTF-8 JSON");
  }
  const manifest = validateManifest(JSON.parse(text.slice(0, -1)));
  if (!serializeManifest(manifest).equals(buffer)) {
    throw new TypeError("install tree manifest JSON is not canonical");
  }
  return manifest;
}

export async function writeInstallTreeManifest({ root }) {
  const canonicalRoot = await assertRoot(root, { validateMode: false });
  const integrityDirectory = join(canonicalRoot, "integrity");
  await mkdir(integrityDirectory, { mode: 0o755 });
  const integrityMetadata = await lstat(integrityDirectory);
  if (!integrityMetadata.isDirectory() || integrityMetadata.isSymbolicLink()
    || await realpath(integrityDirectory) !== integrityDirectory) {
    throw new TypeError("integrity directory is unsafe");
  }
  await normalizeBuildModes(canonicalRoot);
  const manifestPath = join(canonicalRoot, ...INSTALL_TREE_MANIFEST_PATH.split("/"));
  try {
    await lstat(manifestPath);
    throw new TypeError("install tree manifest already exists");
  }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const manifest = Object.freeze({ schemaVersion: 1, entries: await collectInstallTree(canonicalRoot) });
  const manifestBytes = serializeManifest(manifest);
  const temporaryPath = join(dirname(manifestPath), `.tree.v1.${process.pid}.tmp`);
  try {
    await writeFile(temporaryPath, manifestBytes, { flag: "wx", mode: 0o644 });
    const handle = await open(temporaryPath, "r");
    try { await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporaryPath, manifestPath);
  }
  finally {
    await rm(temporaryPath, { force: true });
  }
  const treeManifestSha256 = sha256(manifestBytes);
  return Object.freeze({ manifestBytes, treeManifestSha256, manifestPath });
}

export async function verifyInstallTree({ root, manifestBytes, expectedTreeDigest }) {
  try {
    if (typeof expectedTreeDigest !== "string" || !LOWERCASE_SHA256.test(expectedTreeDigest)) {
      throw new TypeError("expected install tree digest is invalid");
    }
    const canonicalRoot = await assertRoot(root);
    const buffer = Buffer.from(manifestBytes);
    if (sha256(buffer) !== expectedTreeDigest) throw new TypeError("install tree manifest digest does not match");
    const manifest = parseManifest(buffer);
    const onDiskManifest = await readFile(join(canonicalRoot, ...INSTALL_TREE_MANIFEST_PATH.split("/")));
    if (!onDiskManifest.equals(buffer)) throw new TypeError("installed tree manifest bytes do not match");
    const actual = await collectInstallTree(canonicalRoot);
    if (JSON.stringify(actual) !== JSON.stringify(manifest.entries)) {
      throw new TypeError("installed tree differs from its signed manifest");
    }
    return Object.freeze({ kind: "verified", treeManifestSha256: expectedTreeDigest });
  }
  catch {
    return Object.freeze({ kind: "integrity-failure", reason: "installed-tree-mismatch" });
  }
}

async function main(argv) {
  if (argv.length !== 4 || argv[0] !== "verify") throw new TypeError("usage: verify ROOT MANIFEST SHA256");
  const [, root, manifestPath, expectedTreeDigest] = argv;
  const result = await verifyInstallTree({
    root,
    manifestBytes: await readFile(manifestPath),
    expectedTreeDigest,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.kind !== "verified") process.exitCode = 75;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stdout.write('{"kind":"integrity-failure","reason":"installed-tree-mismatch"}\n');
    process.exitCode = 75;
  });
}
