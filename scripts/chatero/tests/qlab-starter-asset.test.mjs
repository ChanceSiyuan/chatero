import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { buildDeterministicZip } from "../build-qlab-starter.mjs";
import { loadQLab } from "../lib/load-qlab.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const starterRoot = join(root, "resource", "chatero", "qlab-starter");
const manifestPath = join(starterRoot, "manifest.json");
const archivePath = join(starterRoot, "research-loop-starter.zip");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function archiveEntries(archive) {
  return execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function storedArchiveFiles(archive) {
  const files = new Map();
  let offset = 0;
  while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034B50) {
    const method = archive.readUInt16LE(offset + 8);
    const size = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    assert.equal(method, 0, "starter archive must use deterministic stored entries");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
    files.set(name, archive.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return files;
}

test("starter ZIP writer is byte-stable and bytewise orders payload paths", () => {
  const files = [
    { path: "z.txt", mode: "0644", data: Buffer.from("z") },
    { path: "a.txt", mode: "0644", data: Buffer.from("a") },
  ];
  const first = buildDeterministicZip(files);
  const second = buildDeterministicZip([...files].reverse());
  assert.deepEqual(first, second);
  assert.deepEqual([...storedArchiveFiles(first).keys()], ["a.txt", "z.txt"]);
});

test("public Research Loop starter is complete, deterministic, and free of personal or generated content", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const archive = await readFile(archivePath);
  const entries = archiveEntries(archivePath);
  const archiveFiles = storedArchiveFiles(archive);

  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.digest, /^[a-f0-9]{64}$/);
  const validatedManifest = (await loadQLab()).validateQLabStarterManifest(manifest);
  assert.equal(validatedManifest.digest, manifest.digest);
  assert.equal(manifest.archiveSha256, sha256(archive));
  assert.deepEqual(entries, [...entries].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
  assert.equal(new Set(entries).size, entries.length);

  for (const forbidden of [".git/", "node_modules/", "dist/", "public/knowledge/", "drafts/ai-contexts/"]) {
    assert.equal(entries.some((entry) => entry.startsWith(forbidden)), false, `forbidden starter path: ${forbidden}`);
  }

  const files = manifest.entries.filter((entry) => entry.kind === "file");
  assert.equal(files.some((entry) => entry.path === "drafts/examples/theorem-blocks.qmd"), true);
  assert.equal(files.some((entry) => entry.path === "literature/ref.bib"), true);
  assert.equal(files.some((entry) => entry.path === "knowledge/index.qmd"), true);
  assert.equal(files.some((entry) => entry.path === "src/app/api/qlab/health/route.ts"), true);

  for (const entry of files) {
    assert.equal(entries.includes(entry.path), true, `archive missing ${entry.path}`);
    assert.equal(sha256(archiveFiles.get(entry.path)), entry.digest, `digest mismatch: ${entry.path}`);
  }
  assert.equal(entries.every((entry) => files.some((file) => file.path === entry)), true);
  const theoremDraft = archiveFiles.get("drafts/examples/theorem-blocks.qmd").toString("utf8");
  assert.match(theoremDraft, /\{#def-starter/);
  assert.match(theoremDraft, /\{#lem-starter/);
  assert.match(theoremDraft, /\{#thm-starter/);
  assert.match(theoremDraft, /::: \{\.proof\}/);
  assert.match(theoremDraft, /\$\$[\s\S]*\$\$/);
  assert.match(theoremDraft, /\[@citekey\]/);
  assert.match(archiveFiles.get("src/app/api/qlab/health/route.ts").toString("utf8"), /repositoryIdentity/);
  assert.doesNotMatch(archiveFiles.get("src/app/api/qlab/health/route.ts").toString("utf8"), /process\.cwd|PathUtils|IOUtils/);
  assert.equal(dirname(manifestPath), starterRoot);
});
