import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  buildDeterministicZip,
  buildStarter,
  STARTER_ARCHITECTURE_COPY_PATHS,
  STARTER_COPY_PATHS,
  STARTER_CURATED_COPY_PATHS,
} from "../build-qlab-starter.mjs";
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

async function loadStarterAsset() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const archive = await readFile(archivePath);
  return { archive, manifest, files: storedArchiveFiles(archive) };
}

function textPayloads(files) {
  return [...files.entries()]
    .flatMap(([path, data]) => {
      try {
        return [{ path, text: new TextDecoder("utf-8", { fatal: true }).decode(data) }];
      } catch {
        return [];
      }
    });
}

async function extractStarter(t) {
  const directory = await mkdtemp(join(tmpdir(), "chatero-public-starter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync("unzip", ["-q", archivePath, "-d", directory], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return directory;
}

function run(repository, command, args) {
  return spawnSync(command, args, {
    cwd: repository,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NODE_PATH: "" },
  });
}

async function expectKnowledgeRejected(repository, invalidIndex) {
  const indexPath = join(repository, "knowledge", "index.qmd");
  const original = await readFile(indexPath, "utf8");
  await writeFile(indexPath, invalidIndex);
  const result = run(repository, "npm", ["run", "knowledge:check"]);
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  await writeFile(indexPath, original);
}

async function waitForSite(url, child) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`site exited early with ${child.exitCode}`);
    try {
      return await fetch(url, { redirect: "manual" });
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError ?? new Error("site did not become ready");
}

async function writeRequiredStarterSourceFixture(source) {
  const directories = new Set([".research-loop", "schemas", "skills", "src"]);
  for (const path of STARTER_COPY_PATHS) {
    const target = join(source, path);
    if (directories.has(path)) await mkdir(target, { recursive: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "public fixture\n");
    }
  }
  for (const path of STARTER_CURATED_COPY_PATHS) {
    const target = join(source, path);
    if (path.includes("/scripts/") || /\.[A-Za-z0-9]+$/.test(path)) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "public fixture\n");
    } else await mkdir(target, { recursive: true });
  }
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

test("starter Knowledge index satisfies the trusted-index contract", async () => {
  const { files } = await loadStarterAsset();
  const index = files.get("knowledge/index.qmd").toString("utf8");
  assert.match(index, /^description:\s*["'][^"']+["']$/m);
  assert.match(index, /^## Reading map$/m);
});

test("starter retains public Research Loop protocol trees and a real local Vinext application", async () => {
  const { files } = await loadStarterAsset();
  for (const path of [
    "skills/expand-notes/SKILL.md",
    "skills/edit-topic-tree/SKILL.md",
    "schemas/research-problem-assessment.schema.json",
    "src/lib/knowledge/validate.ts",
    "src/lib/knowledge/resolve.ts",
    "src/lib/knowledge/site.ts",
    "src/lib/knowledge/tree.ts",
    "src/lib/drafts/check.ts",
    "src/lib/drafts/preview.ts",
    "src/lib/literature/bibliography.ts",
    "src/lib/literature/indexes.ts",
    ".research-loop/tooling/scripts/knowledge.ts",
    ".research-loop/tooling/scripts/draft-check.ts",
    ".research-loop/tooling/scripts/draft-preview.ts",
    ".research-loop/tooling/scripts/literature.ts",
    ".research-loop/tooling/scripts/qlab.ts",
    "src/app/page.tsx",
    "src/app/layout.tsx",
    "src/app/globals.css",
    "src/app/api/qlab/health/route.ts",
  ]) assert.equal(files.has(path), true, `missing public protocol path ${path}`);
  const packageJSON = JSON.parse(files.get("package.json").toString("utf8"));
  assert.equal(packageJSON.dependencies.vinext ?? packageJSON.devDependencies.vinext, "0.0.50");
  assert.match(files.get("src/app/page.tsx").toString("utf8"), /Repository|Knowledge|Drafts|Literature/);
  assert.match(files.get("src/app/api/qlab/health/route.ts").toString("utf8"), /NextResponse/);
});

test("real Knowledge validator rejects invalid trusted-note contracts in an extracted starter", async (t) => {
  const repository = await extractStarter(t);
  const installed = run(repository, "npm", ["ci", "--ignore-scripts"]);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const index = await readFile(join(repository, "knowledge", "index.qmd"), "utf8");
  await expectKnowledgeRejected(repository, index.replace(/^description:.*\n/m, ""));
  await expectKnowledgeRejected(repository, index.replace("---\n\n## Reading map", "categories:\n  - invalid-category\n---\n\n## Reading map"));
  await expectKnowledgeRejected(repository, index.replace("---\n\n## Reading map", "author: Private Person\n---\n\n## Reading map"));
  await expectKnowledgeRejected(repository, `${index}\nUnsupported citation [@missing-reference].\n`);
  const restored = run(repository, "npm", ["run", "knowledge:check"]);
  assert.equal(restored.status, 0, restored.stderr || restored.stdout);
});

test("extracted public starter is dependency-closed and builds its Knowledge and local site", async (t) => {
  const repository = await extractStarter(t);
  const packageJSON = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  assert.equal(packageJSON.dependencies.next, "16.2.6");
  assert.equal(packageJSON.devDependencies.vinext, "0.0.50");
  for (const script of Object.values(packageJSON.scripts)) {
    for (const target of String(script).matchAll(/\.research-loop\/[A-Za-z0-9_./-]+\.(?:mjs|js|ts)/g)) {
      const targetPath = join(repository, target[0]);
      const targetResult = spawnSync("test", ["-f", targetPath], { encoding: "utf8" });
      assert.equal(targetResult.status, 0, `missing retained package-script target ${target[0]}`);
    }
  }
  for (const invocation of [
    ["npm", ["ci", "--ignore-scripts"]],
    ["npm", ["run", "knowledge:check"]],
    ["npm", ["run", "knowledge:build"]],
    ["npm", ["run", "build:app"]],
    ["npm", ["run", "build"]],
  ]) {
    const result = run(repository, invocation[0], invocation[1]);
    assert.equal(result.status, 0, `${invocation.join(" ")}\n${result.stderr || result.stdout}`);
  }
  assert.equal(spawnSync("test", ["-d", join(repository, "node_modules", "vinext")]).status, 0);
  assert.equal(spawnSync("test", ["-f", join(repository, "public", "knowledge", "index.html")]).status, 0);
  assert.equal(spawnSync("test", ["-d", join(repository, "dist", "server")]).status, 0);
});

test("built Main Site serves the real app, health protocol, Knowledge assets, and a stable 404", async (t) => {
  const repository = await extractStarter(t);
  const installed = run(repository, "npm", ["ci", "--ignore-scripts"]);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const built = run(repository, "npm", ["run", "build"]);
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const port = 46000 + Math.floor(Math.random() * 1000);
  const site = spawn("npm", ["run", "start", "--", "--port", String(port)], {
    cwd: repository,
    env: { ...process.env, NODE_PATH: "", QLAB_REPOSITORY_ID: "starter-probe" },
    stdio: "pipe",
  });
  t.after(() => { if (site.exitCode === null) site.kill("SIGTERM"); });
  const origin = `http://127.0.0.1:${port}`;
  const root = await waitForSite(`${origin}/`, site);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /Local research workspace/);
  const health = await fetch(`${origin}/api/qlab/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, repositoryIdentity: "starter-probe" });
  const redirect = await fetch(`${origin}/knowledge`, { redirect: "manual" });
  assert.equal(redirect.status, 308);
  const knowledge = await fetch(`${origin}/knowledge/`);
  assert.equal(knowledge.status, 200);
  assert.match(await knowledge.text(), /Research Loop Knowledge/);
  const asset = await fetch(`${origin}/knowledge/site_libs/quarto-html/quarto.js`);
  assert.equal(asset.status, 200);
  const missing = await fetch(`${origin}/definitely-not-present`);
  assert.equal(missing.status, 404);
  assert.equal(site.exitCode, null, "a 404 must not stop the Main Site");
  assert.equal((await fetch(`${origin}/api/qlab/health`)).status, 200);
});

test("starter builder rejects a symbolic-link ancestor of an explicit source path", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "chatero-starter-source-"));
  const output = await mkdtemp(join(tmpdir(), "chatero-starter-output-"));
  const external = await mkdtemp(join(tmpdir(), "chatero-starter-external-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));
  t.after(() => rm(external, { recursive: true, force: true }));
  const directories = new Set([".research-loop", "schemas", "skills", "src"]);
  for (const path of STARTER_COPY_PATHS) {
    const target = join(source, path);
    if (directories.has(path)) await mkdir(target, { recursive: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "public fixture\n");
    }
  }
  for (const path of STARTER_ARCHITECTURE_COPY_PATHS) {
    const target = join(external, path.replace(/^\.research-loop\/tooling\//, ""));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "export {};\n");
  }
  await symlink(external, join(source, ".research-loop", "tooling"));
  for (const path of STARTER_CURATED_COPY_PATHS) {
    if (path.startsWith(".research-loop/tooling/")) continue;
    const target = join(source, path);
    if (path.includes("/scripts/") || /\.[A-Za-z0-9]+$/.test(path)) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "public fixture\n");
    } else await mkdir(target, { recursive: true });
  }
  await assert.rejects(
    () => buildStarter({ source, output }),
    /symlink ancestor/,
  );
});

test("starter builder rejects binary and invalid-UTF-8 payloads beneath recursive public trees before writing an archive", async (t) => {
  const fixtures = [
    ["skills/unexpected.pdf", Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff])],
    ["schemas/unexpected.bin", Buffer.from([0x00, 0xff, 0x80, 0x41])],
    ["skills/credential.blob", Buffer.concat([Buffer.from("sk_should_never_be_archived_"), Buffer.from([0xff, 0x80])])],
  ];
  for (const [relativePath, payload] of fixtures) {
    const source = await mkdtemp(join(tmpdir(), "chatero-binary-source-"));
    const output = await mkdtemp(join(tmpdir(), "chatero-binary-output-"));
    t.after(() => rm(source, { recursive: true, force: true }));
    t.after(() => rm(output, { recursive: true, force: true }));
    await writeRequiredStarterSourceFixture(source);
    const target = join(source, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, payload);
    await assert.rejects(
      () => buildStarter({ source, output }),
      /binary|UTF-8|payload/i,
      relativePath,
    );
    await assert.rejects(() => lstat(join(output, "research-loop-starter.zip")), /ENOENT/);
  }
});

test("starter manifest digest covers the canonical manifest payload", async () => {
  const { manifest } = await loadStarterAsset();
  assert.equal(
    manifest.digest,
    sha256(JSON.stringify({ schemaVersion: manifest.schemaVersion, entries: manifest.entries })),
  );
});

test("starter contains only the explicit public .research-loop tooling sub-tree", async () => {
  const { files } = await loadStarterAsset();
  for (const path of files.keys()) {
    if (!path.startsWith(".research-loop/")) continue;
    assert.match(path, /^\.research-loop\/tooling\/scripts\/[A-Za-z0-9._-]+\.(?:mjs|ts)$/);
  }
  for (const forbidden of [".research-loop/docs/", ".research-loop/fixtures/", ".research-loop/tests/"]) {
    assert.equal([...files.keys()].some(path => path.startsWith(forbidden)), false, `forbidden starter path: ${forbidden}`);
  }
});

test("starter text has no fixed hosting identity, credentials, or personal data path", async () => {
  const { files } = await loadStarterAsset();
  for (const { path, text } of textPayloads(files)) {
    assert.doesNotMatch(text, /\.openai\/hosting\.json|appgprj_[a-z0-9]+|Reuse the opaque Sites project ID/i, path);
    assert.doesNotMatch(text, /(?:^|[^A-Za-z])(?:sk|ghp)_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, path);
    assert.doesNotMatch(text, /(?:^|[\s"'=:(])(?:\/Users\/|\/home\/|[A-Za-z]:[\\/])/, path);
  }
  assert.deepEqual(
    [...files.keys()].filter(path => /\.(?:qmd|pdf)$/i.test(path)).sort(),
    ["drafts/examples/theorem-blocks.qmd", "knowledge/index.qmd"],
  );
  assert.equal([...files.keys()].some(path => /(?:\.research-loop\/(?:docs|fixtures|tests)\/|downloads-knowledge-import|ref\.bib\.bak)/i.test(path)), false);
  assert.doesNotMatch(files.get("literature/ref.bib").toString("utf8"), /^\s*@/m);
});

test("starter uses a loadable local-only Vite configuration", async () => {
  const { files } = await loadStarterAsset();
  const source = files.get("vite.config.ts").toString("utf8");
  assert.doesNotMatch(source, /\.openai|hosting\.json|sites\(/i);
  const context = {};
  runInNewContext(
    source
      .replace(/^import vinext from "vinext";$/m, "const vinext = () => ({ name: 'vinext' });")
      .replace(/^import \{ cloudflare \} from "@cloudflare\/vite-plugin";$/m, "const cloudflare = () => ({ name: 'cloudflare' });")
      .replace(/^export default\s+/m, "this.config = "),
    context,
  );
  assert.equal(context.config.server.host, "127.0.0.1");
  assert.equal(context.config.preview.host, "127.0.0.1");
});

test("starter ignores private setup receipts and local identity state", async () => {
  const { files } = await loadStarterAsset();
  const ignore = files.get(".gitignore").toString("utf8");
  assert.match(ignore, /^\.research-loop\/starter\.json$/m);
  assert.match(ignore, /^\.research-loop\/starter\.\*\.json$/m);
  assert.match(ignore, /^\.research-loop\/local\/$/m);
});

test("public Research Loop starter is complete, deterministic, and free of personal or generated content", async () => {
  const { manifest, archive, files: archiveFiles } = await loadStarterAsset();
  const entries = archiveEntries(archivePath);

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
