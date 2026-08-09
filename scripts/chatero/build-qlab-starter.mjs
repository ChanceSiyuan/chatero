#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENERATED_STARTER_DIRECTORIES,
  GENERATED_STARTER_FILES,
} from "./starter/generated-files.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const outputRoot = join(repositoryRoot, "resource", "chatero", "qlab-starter");
const archiveName = "research-loop-starter.zip";
const manifestName = "manifest.json";
const NORMALIZED_TIMESTAMP = 315532800; // 1980-01-01T00:00:00Z, the ZIP epoch

export const STARTER_COPY_PATHS = Object.freeze([
  ".gitignore", ".node-version", "AGENTS.md", "CLAUDE.md", "Makefile",
  "README.md", "eslint.config.mjs", "next.config.ts", "package-lock.json",
  "package.json", "playwright.assessment.config.ts",
  "playwright.autoresearch.config.ts", "playwright.config.ts",
  "postcss.config.mjs", "qlab", "tsconfig.json", "vite.config.ts",
  "worker-configuration.d.ts", ".research-loop", "schemas", "skills", "src",
  "public/favicon.svg", "public/og.png", "knowledge/_quarto.yml",
  "drafts/_quarto.yml",
]);

export const STARTER_ARCHITECTURE_COPY_PATHS = Object.freeze([
  ".research-loop/tooling/scripts/qlab.ts",
]);

/** Public product protocols that are copied exactly after no-follow and privacy checks. */
export const STARTER_CURATED_COPY_PATHS = Object.freeze([
  "package-lock.json",
  "schemas",
  "skills",
  "src/lib/knowledge",
  "src/lib/drafts",
  "src/lib/literature",
  "src/lib/skills/sci-brain.mjs",
  "src/worker/index.ts",
  "knowledge/_quarto.yml",
  "drafts/_quarto.yml",
  ".research-loop/tooling/scripts/knowledge.ts",
  ".research-loop/tooling/scripts/draft-check.ts",
  ".research-loop/tooling/scripts/draft-preview.ts",
  ".research-loop/tooling/scripts/literature.ts",
  ".research-loop/tooling/scripts/qlab.ts",
  ".research-loop/tooling/scripts/ensure-sci-brain.mjs",
]);

const GENERATED_REPLACEMENTS = new Set([
  ...STARTER_COPY_PATHS,
  ...STARTER_ARCHITECTURE_COPY_PATHS,
]);

const bytewiseCompare = (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const isWithin = (root, target) => target === root || target.startsWith(`${root}${sep}`);
const PROHIBITED_SOURCE_EXTENSIONS = /\.(?:7z|avi|bin|blob|bmp|bz2|class|dmg|dll|docx?|exe|gif|gz|ico|jar|jpe?g|mov|mp[34]|otf|pdf|png|rar|so|tar|tiff?|ttf|wasm|webm|webp|woff2?|xpi|zip)$/i;

function fail(message) {
  throw new Error(`QLab starter build failed: ${message}`);
}

function assertPublicPayload(path, data) {
  if (PROHIBITED_SOURCE_EXTENSIONS.test(path)) {
    fail(`public source has a prohibited binary payload extension: ${path}`);
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    fail(`public source payload is not valid UTF-8: ${path}`);
  }
  if (source.includes("\0")) {
    fail(`public source contains a binary NUL payload: ${path}`);
  }
  if (/(?:^|[\s"'=:(])(?:\/Users\/|\/home\/|[A-Za-z]:[\\/])/.test(source)) {
    fail(`public source contains an absolute user path: ${path}`);
  }
  if (/\.openai\/hosting\.json|appgprj_[a-z0-9]+|(?:^|[^A-Za-z])(?:sk|ghp)_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/i.test(source)) {
    fail(`public source contains private hosting or credential data: ${path}`);
  }
}

function safeRelativePath(path) {
  if (typeof path !== "string" || !path || path.includes("\\") || path.includes("\0") || isAbsolute(path)) return false;
  return path.split("/").every((segment) => segment && segment !== "." && segment !== ".." && !segment.startsWith("-"));
}

function normalizedMode(path, directory = false) {
  return directory ? "0755" : path === "qlab" ? "0755" : "0644";
}

function stableJSON(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function uint16(value) {
  const result = Buffer.allocUnsafe(2);
  result.writeUInt16LE(value >>> 0, 0);
  return result;
}

function uint32(value) {
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32LE(value >>> 0, 0);
  return result;
}

function dosDateTime(epochSeconds = NORMALIZED_TIMESTAMP) {
  const date = new Date(epochSeconds * 1000);
  const day = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear() - 1980;
  return {
    time: (date.getUTCSeconds() >> 1) | (date.getUTCMinutes() << 5) | (date.getUTCHours() << 11),
    date: day | (month << 5) | (year << 9),
  };
}

/** Build a minimal, deterministic stored ZIP without delegating archive metadata to the host OS. */
export function buildDeterministicZip(files) {
  const ordered = [...files].sort((left, right) => bytewiseCompare(left.path, right.path));
  const local = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime();
  for (const file of ordered) {
    const name = Buffer.from(file.path, "utf8");
    const data = Buffer.from(file.data);
    const crc = crc32(data);
    const flags = 0x0800; // UTF-8 filenames
    const localRecord = Buffer.concat([
      uint32(0x04034B50), uint16(20), uint16(flags), uint16(0), uint16(time), uint16(date),
      uint32(crc), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), name, data,
    ]);
    local.push(localRecord);
    const externalAttributes = ((0o100000 | Number.parseInt(file.mode, 8)) << 16) >>> 0;
    central.push(Buffer.concat([
      uint32(0x02014B50), uint16((3 << 8) | 20), uint16(20), uint16(flags), uint16(0), uint16(time), uint16(date),
      uint32(crc), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(externalAttributes), uint32(offset), name,
    ]));
    offset += localRecord.length;
  }
  const centralData = Buffer.concat(central);
  return Buffer.concat([
    ...local,
    centralData,
    uint32(0x06054B50), uint16(0), uint16(0), uint16(ordered.length), uint16(ordered.length),
    uint32(centralData.length), uint32(offset), uint16(0),
  ]);
}

async function gatherSourcePath(sourceRoot, allowedPath, records) {
  if (!safeRelativePath(allowedPath)) fail(`unsafe allowlisted path ${JSON.stringify(allowedPath)}`);
  await assertNoSymlinkAncestor(sourceRoot, allowedPath);
  const target = resolve(sourceRoot, allowedPath);
  if (!isWithin(sourceRoot, target)) fail(`allowlisted path escapes source root: ${allowedPath}`);
  let metadata;
  try {
    metadata = await lstat(target);
  }
  catch {
    fail(`required source path is missing: ${allowedPath}`);
  }
  if (metadata.isSymbolicLink()) fail(`source symlink is not allowed: ${allowedPath}`);
  if (metadata.isFile()) {
    const data = await readFile(target);
    assertPublicPayload(allowedPath, data);
    records.set(allowedPath, { path: allowedPath, kind: "file", mode: normalizedMode(allowedPath), data });
    return;
  }
  if (!metadata.isDirectory()) fail(`source path is neither a file nor directory: ${allowedPath}`);
  records.set(allowedPath, { path: allowedPath, kind: "directory", mode: normalizedMode(allowedPath, true) });
  const children = await readdir(target, { withFileTypes: true });
  children.sort((left, right) => bytewiseCompare(left.name, right.name));
  for (const child of children) {
    const childPath = `${allowedPath}/${child.name}`;
    if (child.isSymbolicLink()) fail(`source symlink is not allowed: ${childPath}`);
    await gatherSourcePath(sourceRoot, childPath, records);
  }
}

async function assertNoSymlinkAncestor(sourceRoot, allowedPath) {
  let parent = sourceRoot;
  const segments = allowedPath.split("/");
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    let metadata;
    try {
      metadata = await lstat(parent);
    }
    catch {
      fail(`required source path is missing: ${allowedPath}`);
    }
    if (metadata.isSymbolicLink()) fail(`source symlink ancestor is not allowed: ${allowedPath}`);
  }
}

async function assertSourcePathExists(sourceRoot, allowedPath) {
  if (!safeRelativePath(allowedPath)) fail(`unsafe allowlisted path ${JSON.stringify(allowedPath)}`);
  await assertNoSymlinkAncestor(sourceRoot, allowedPath);
  const target = resolve(sourceRoot, allowedPath);
  if (!isWithin(sourceRoot, target)) fail(`allowlisted path escapes source root: ${allowedPath}`);
  let metadata;
  try {
    metadata = await lstat(target);
  }
  catch {
    fail(`required source path is missing: ${allowedPath}`);
  }
  if (metadata.isSymbolicLink()) fail(`source symlink is not allowed: ${allowedPath}`);
}

function addGeneratedRecords(records) {
  for (const path of GENERATED_STARTER_DIRECTORIES) {
    if (!safeRelativePath(path)) fail(`unsafe generated directory ${path}`);
    const existing = records.get(path);
    if (existing && existing.kind !== "directory") fail(`generated directory conflicts with copied source: ${path}`);
    if (!existing) records.set(path, { path, kind: "directory", mode: "0755" });
  }
  for (const [path, data] of Object.entries(GENERATED_STARTER_FILES)) {
    if (!safeRelativePath(path)) fail(`unsafe generated file ${path}`);
    if (records.has(path)) fail(`generated file conflicts with copied source: ${path}`);
    records.set(path, { path, kind: "file", mode: normalizedMode(path), data: Buffer.from(data) });
  }
}

function addImplicitAncestorDirectories(records) {
	for (const record of [...records.values()]) {
		const segments = record.path.split("/");
		segments.pop();
		while (segments.length) {
			const path = segments.join("/");
			const existing = records.get(path);
			if (existing && existing.kind !== "directory") fail(`file output path is a parent: ${path}`);
			if (!existing) records.set(path, { path, kind: "directory", mode: "0755" });
			segments.pop();
		}
	}
}

function validatePathSet(records) {
  const folded = new Set();
  for (const record of records.values()) {
    if (!safeRelativePath(record.path)) fail(`unsafe output path: ${record.path}`);
    const key = record.path.toLocaleLowerCase("en-US");
    if (folded.has(key)) fail(`case-folded duplicate output path: ${record.path}`);
    folded.add(key);
    const ancestors = record.path.split("/");
    ancestors.pop();
    while (ancestors.length) {
      const parent = records.get(ancestors.join("/"));
      if (parent && parent.kind !== "directory") fail(`file output path is a parent: ${parent.path}`);
      ancestors.pop();
    }
  }
}

export async function buildStarter({ source, output = outputRoot } = {}) {
  if (!source) fail("--source <Research Loop checkout> is required");
  const canonicalSource = await realpath(source);
  const sourceMetadata = await stat(canonicalSource);
  if (!sourceMetadata.isDirectory()) fail(`source is not a directory: ${source}`);
  const records = new Map();
  for (const path of STARTER_COPY_PATHS) {
    if (GENERATED_REPLACEMENTS.has(path)) await assertSourcePathExists(canonicalSource, path);
    else await gatherSourcePath(canonicalSource, path, records);
  }
  for (const path of STARTER_CURATED_COPY_PATHS) await gatherSourcePath(canonicalSource, path, records);
  for (const path of STARTER_ARCHITECTURE_COPY_PATHS) await assertSourcePathExists(canonicalSource, path);
  addGeneratedRecords(records);
  addImplicitAncestorDirectories(records);
  validatePathSet(records);

  const entries = [...records.values()]
    .sort((left, right) => bytewiseCompare(left.path, right.path))
    .map((record) => record.kind === "directory"
      ? { path: record.path, kind: record.kind, mode: record.mode }
      : { path: record.path, kind: record.kind, mode: record.mode, digest: sha256(record.data) });
  const manifestDigest = sha256(JSON.stringify({ schemaVersion: 1, entries }));
  const archive = buildDeterministicZip([...records.values()].filter((record) => record.kind === "file"));
  const manifest = {
    schemaVersion: 1,
    digest: manifestDigest,
    archiveSha256: sha256(archive),
    entries,
  };

  const canonicalOutput = resolve(output);
  await mkdir(canonicalOutput, { recursive: true, mode: 0o755 });
  const archivePath = join(canonicalOutput, archiveName);
  const manifestPath = join(canonicalOutput, manifestName);
  const temporaryArchive = join(canonicalOutput, `.${archiveName}.${process.pid}.tmp`);
  const temporaryManifest = join(canonicalOutput, `.${manifestName}.${process.pid}.tmp`);
  try {
    await writeFile(temporaryArchive, archive, { mode: 0o644 });
    await writeFile(temporaryManifest, stableJSON(manifest), { encoding: "utf8", mode: 0o644 });
    await rename(temporaryArchive, archivePath);
    await rename(temporaryManifest, manifestPath);
  }
  finally {
    await rm(temporaryArchive, { force: true });
    await rm(temporaryManifest, { force: true });
  }
  return Object.freeze({ archivePath, manifestPath, manifest: Object.freeze(manifest) });
}

function parseArguments(argv) {
  let source = "";
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== "--source") fail(`unknown argument: ${argv[index]}`);
    source = argv[++index] || "";
  }
  return { source };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildStarter(parseArguments(process.argv.slice(2)));
  process.stdout.write(`Built public QLab starter: ${basename(result.archivePath)} (${result.manifest.entries.length} entries)\n`);
}
