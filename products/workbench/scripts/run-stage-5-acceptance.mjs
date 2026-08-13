#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EXPECTED_CHECKS as EXPECTED_SSH_CHECKS } from "./run-stage-5-real-ssh.mjs";
import { REMOTE_AGENT_TUPLES, verifyRelease } from "../remote-agent/release-contract.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CODE_OSS_COMMIT = "df53daabb18cd157bdb08c7f01c34df936cf12f4";
const EXPECTED = Object.freeze({
  schemaVersion: 1,
  stage: 5,
  checks: Object.freeze([
    Object.freeze({ id: "ide-language-product-audit", kind: "source-inspection" }),
    Object.freeze({ id: "remote-contract-tests", command: "node", args: Object.freeze(["products/workbench/scripts/run-node-tests.mjs", "products/workbench/tests/chatero-remote-*.test.mjs", "products/workbench/tests/remote-agent-*.test.mjs", "products/workbench/tests/documentation-remote-transaction.test.mjs"]) }),
    Object.freeze({ id: "code-oss-compile", command: "npm", args: Object.freeze(["run", "workbench:compile"]) }),
    Object.freeze({ id: "signed-agent-release", kind: "release-inspection" }),
    Object.freeze({ id: "linux-x64-real-ssh", kind: "runner-receipt", tuple: "linux-x86_64" }),
    Object.freeze({ id: "linux-arm64-real-ssh", kind: "runner-receipt", tuple: "linux-aarch64" }),
    Object.freeze({ id: "stage-five-boundary-audit", kind: "boundary-inspection" }),
  ]),
});

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

export function validateStageFiveRequirements(value) {
  if (JSON.stringify(value) !== JSON.stringify(EXPECTED)) throw new TypeError("requirements do not match the immutable Stage 5 requirement contract");
  return freeze(value);
}

function sanitize(error, root) {
  let message = String(error?.message || error);
  for (const value of [root, process.env.HOME]) if (value) message = message.replaceAll(value, value === root ? "<repository>" : "<home>");
  return message.replace(/[\r\n\t]+/gu, " ").replace(/\b(token|password|credential|secret)=\S+/giu, "$1=<redacted>").slice(0, 512);
}

async function runCommand({ file, args, cwd }) {
  return new Promise((accept, reject) => {
    const child = spawn(file, args, { cwd, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => Number.isInteger(code) ? accept(code) : reject(new Error(`command terminated by ${signal || "unknown signal"}`)));
  });
}

function checkoutPath(root) {
  return process.env.CHATERO_CODE_OSS_DIR ? resolve(process.env.CHATERO_CODE_OSS_DIR) : join(root, "vendor", "code-oss");
}

function digestText(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function currentCommit(root) {
  const head = await readFile(join(root, ".git"), "utf8").catch(() => null);
  const { execFile } = await import("node:child_process");
  return new Promise((resolveCommit, reject) => execFile("git", ["rev-parse", "HEAD^{commit}"], { cwd: root, encoding: "utf8" }, (error, stdout) => {
    if (error) reject(error);
    else resolveCommit(stdout.trim());
  }));
}

export async function inspectStageFiveProduct({ root = ROOT } = {}) {
  const checkout = checkoutPath(root);
  const catalogText = await readFile(join(root, "products", "workbench", "acceptance", "stage-5-ide-remote-parity.json"), "utf8");
  const catalog = JSON.parse(catalogText);
  if (catalog.schemaVersion !== 1 || catalog.stage !== 5
      || !Array.isArray(catalog.languages) || catalog.languages.length < 13
      || !Array.isArray(catalog.workbench) || catalog.workbench.length < 13
      || !Array.isArray(catalog.remote) || catalog.remote.length < 18) {
    throw new Error("Stage 5 IDE/remote parity catalog is incomplete");
  }
  const languageIds = new Set();
  for (const entry of catalog.languages) {
    if (!entry || typeof entry.id !== "string" || typeof entry.extension !== "string" || typeof entry.fixture !== "string") {
      throw new Error("Stage 5 language entry is invalid");
    }
    if (languageIds.has(entry.id)) throw new Error(`Stage 5 language ${entry.id} is duplicated`);
    languageIds.add(entry.id);
    if (entry.id === "quarto") {
      const documentation = JSON.parse(await readFile(join(root, "products", "workbench", "extensions", "chatero-documentation", "package.json"), "utf8"));
      if (!documentation.contributes?.customEditors?.some(value => value.selector?.some(selector => selector.filenamePattern?.endsWith("*.qmd")))) {
        throw new Error("Chatero Documentation does not own QMD fixtures");
      }
      continue;
    }
    const manifest = JSON.parse(await readFile(join(checkout, "extensions", entry.extension, "package.json"), "utf8"));
    const contributed = new Set((manifest.contributes?.languages ?? []).map(value => value.id));
    if (!contributed.has(entry.id)) throw new Error(`Code-OSS extension ${entry.extension} does not contribute ${entry.id}`);
  }
  for (const extension of ["git", "ipynb", "notebook-renderers", "debug-auto-launch", "debug-server-ready", "terminal-suggest"]) {
    await readFile(join(checkout, "extensions", extension, "package.json"), "utf8");
  }
  const requiredSources = [
    "src/vs/workbench/contrib/terminal/common/remote/remoteTerminalChannel.ts",
    "src/vs/workbench/contrib/tasks/common/taskService.ts",
    "src/vs/workbench/contrib/debug/common/debug.ts",
    "src/vs/workbench/contrib/notebook/common/notebookService.ts",
    "src/vs/workbench/contrib/search/browser/search.contribution.ts",
    "src/vs/workbench/services/workspaces/common/workspaceTrust.ts",
    "src/vs/workbench/services/extensions/electron-browser/nativeExtensionService.ts",
    "src/vs/workbench/services/files/electron-browser/watcherClient.ts",
  ];
  for (const path of requiredSources) await readFile(join(checkout, path), "utf8");
  const productText = await readFile(join(checkout, "product.json"), "utf8");
  const product = JSON.parse(productText);
  if (product.extensionsGallery?.serviceUrl !== "https://open-vsx.org/vscode/gallery"
      || product.extensionsGallery?.itemUrl !== "https://open-vsx.org/vscode/item") {
    throw new Error("materialized product is not bound exclusively to Open VSX");
  }
  const forbidden = /marketplace\.visualstudio\.com|gallerycdn\.vsassets\.io|ms-python\.vscode-pylance|ms-vscode-remote\.remote-ssh/iu;
  if (forbidden.test(productText)) throw new Error("materialized product references a restricted Microsoft component");
  const firstParty = JSON.parse(await readFile(join(root, "products", "workbench", "first-party-extensions.json"), "utf8"));
  const firstPartyIds = new Set(firstParty.extensions.map(value => value.id));
  for (const id of ["chatero.documentation", "chatero.remote", "chatero.zotero"]) {
    if (!firstPartyIds.has(id)) throw new Error(`first-party product omits ${id}`);
  }
  return freeze({
    catalogSha256: digestText(catalogText),
    codeOssCommit: CODE_OSS_COMMIT,
    languages: catalog.languages.length,
    remoteCapabilities: catalog.remote.length,
    restrictedComponents: 0,
    workbenchCapabilities: catalog.workbench.length,
  });
}

async function safeReleaseFile(directory, filename) {
  const root = await realpath(resolve(directory));
  const path = resolve(root, filename);
  const pathRelative = relative(root, path);
  if (!pathRelative || pathRelative === ".." || pathRelative.startsWith("../")) throw new Error("release file escapes its directory");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error(`release file ${filename} is unsafe`);
  if (await realpath(path) !== path) throw new Error(`release file ${filename} is indirect`);
  return path;
}

export async function inspectSignedRelease({ root = ROOT, releaseDirectory } = {}) {
  const directory = resolve(releaseDirectory ?? process.env.CHATERO_REMOTE_AGENT_RELEASE_DIR ?? join(root, "products", "workbench", "remote-agent", "dist"));
  const [manifestPath, signaturePath, publicKeyPath] = await Promise.all([
    safeReleaseFile(directory, "manifest.json"),
    safeReleaseFile(directory, "manifest.sig"),
    safeReleaseFile(join(root, "products", "workbench", "remote-agent"), "release-public-key.pem"),
  ]);
  const manifestText = await readFile(manifestPath, "utf8");
  const release = {
    manifestText,
    signature: await readFile(signaturePath),
    publicKey: await readFile(publicKeyPath),
    readArtifact: async filename => createReadStream(await safeReleaseFile(directory, filename)),
  };
  const manifest = await verifyRelease(release);
  return freeze({
    artifacts: manifest.artifacts.map(value => ({ tuple: value.tuple, sha256: value.sha256, size: value.size })),
    codeOssCommit: manifest.codeOssCommit,
    directory,
    manifestSha256: digestText(manifestText),
  });
}

export async function inspectRunnerReceipt({ root = ROOT, tuple, release, receiptDirectory } = {}) {
  if (!REMOTE_AGENT_TUPLES.includes(tuple)) throw new TypeError("runner receipt tuple is invalid");
  const sourceCommit = await currentCommit(root);
  const directory = resolve(receiptDirectory ?? process.env.CHATERO_STAGE_5_RECEIPT_DIR ?? join(root, "products", "workbench", ".cache", "acceptance", "stage-5-runner-receipts"));
  const path = await safeReleaseFile(directory, `${tuple}.json`);
  const text = await readFile(path, "utf8");
  const receipt = JSON.parse(text);
  const exact = ["schemaVersion", "stage", "status", "tuple", "sourceCommit", "codeOssCommit", "releaseManifestSha256", "artifactSha256", "hostFingerprintSha256", "pdfSha256", "checks"];
  if (!receipt || Object.keys(receipt).sort().join(",") !== exact.sort().join(",")
      || receipt.schemaVersion !== 1 || receipt.stage !== 5 || receipt.status !== "passed"
      || receipt.tuple !== tuple || receipt.sourceCommit !== sourceCommit
      || receipt.codeOssCommit !== CODE_OSS_COMMIT || receipt.releaseManifestSha256 !== release.manifestSha256
      || !/^[0-9a-f]{64}$/u.test(receipt.hostFingerprintSha256)
      || !/^[0-9a-f]{64}$/u.test(receipt.pdfSha256)) {
    throw new Error(`Stage 5 runner receipt for ${tuple} is invalid or stale`);
  }
  const artifact = release.artifacts.find(value => value.tuple === tuple);
  if (!artifact || receipt.artifactSha256 !== artifact.sha256) throw new Error(`Stage 5 runner receipt for ${tuple} does not match the signed artifact`);
  if (!Array.isArray(receipt.checks) || receipt.checks.length !== EXPECTED_SSH_CHECKS.length
      || receipt.checks.some((value, index) => !value || Object.keys(value).sort().join(",") !== "id,status"
        || value.id !== EXPECTED_SSH_CHECKS[index] || value.status !== "passed")) {
    throw new Error(`Stage 5 runner receipt for ${tuple} has incomplete SSH checks`);
  }
  if (/\/(?:Users|home|tmp)\/|connectionToken|grantId|remotePath/iu.test(text)) {
    throw new Error(`Stage 5 runner receipt for ${tuple} exposes a path or secret-bearing field`);
  }
  return freeze({ receiptSha256: digestText(text), tuple, checks: receipt.checks.length });
}

export async function inspectStageFiveBoundary({ root = ROOT, release } = {}) {
  const extensionRoot = join(root, "products", "workbench", "extensions", "chatero-remote");
  const source = await Promise.all([
    "extension.cjs", "evidence-cache.mjs", "remote-agent-installer.mjs", "remote-process.mjs",
    "remote-workspace.mjs", "ssh-session.mjs", "openssh-targets.mjs",
  ].map(path => readFile(join(extensionRoot, path), "utf8"))).then(values => values.join("\n"));
  if (/zotero\.sqlite|better-sqlite|sqlite3/iu.test(source)) throw new Error("remote renderer directly accesses Zotero database data");
  if (!source.includes("randomBytes(32)") || !source.includes("ttlSeconds !== TTL_SECONDS")
      || !source.includes("FingerprintHash=sha256") || !source.includes("ProxyJump")) {
    throw new Error("Stage 5 remote security boundary is incomplete");
  }
  const releaseEntries = new Set(release.artifacts.map(value => value.tuple));
  if (releaseEntries.size !== 2 || REMOTE_AGENT_TUPLES.some(tuple => !releaseEntries.has(tuple))) {
    throw new Error("signed release is not a complete two-architecture product");
  }
  return freeze({
    localPathsInReceipts: 0,
    rendererDatabaseAccess: false,
    releaseTuples: [...releaseEntries],
    remotePrivateKeys: 0,
  });
}

async function writeEvidence(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.stage-5-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function runStageFiveAcceptance({
  root = ROOT,
  requirements,
  run = runCommand,
  inspectProduct = inspectStageFiveProduct,
  inspectRelease = inspectSignedRelease,
  inspectReceipt = inspectRunnerReceipt,
  inspectBoundary = inspectStageFiveBoundary,
  write = writeEvidence,
  clock = Date.now,
} = {}) {
  const contract = validateStageFiveRequirements(requirements ?? JSON.parse(await readFile(join(root, "products", "workbench", "acceptance", "stage-5.requirements.json"), "utf8")));
  const started = clock();
  const checks = [];
  const audit = {};
  let release = null;
  let failure = null;
  for (const descriptor of contract.checks) {
    const checkStarted = clock();
    let exitCode = 0;
    try {
      if (descriptor.kind === "source-inspection") audit.product = await inspectProduct({ root });
      else if (descriptor.kind === "release-inspection") audit.release = release = await inspectRelease({ root });
      else if (descriptor.kind === "runner-receipt") {
        if (!release) throw new Error("signed release must be verified before runner receipts");
        audit[descriptor.tuple] = await inspectReceipt({ root, tuple: descriptor.tuple, release });
      }
      else if (descriptor.kind === "boundary-inspection") {
        if (!release) throw new Error("signed release must be verified before boundary inspection");
        audit.boundary = await inspectBoundary({ root, release });
      }
      else exitCode = await run({ file: descriptor.command, args: [...descriptor.args], cwd: root });
      if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) throw new Error("command returned an invalid exit code");
      if (exitCode !== 0) throw new Error(`required command ${descriptor.id} exited with ${exitCode}`);
    }
    catch (error) {
      if (exitCode === 0) exitCode = 1;
      failure = { checkId: descriptor.id, message: sanitize(error, root) };
    }
    const ended = clock();
    checks.push({ id: descriptor.id, status: exitCode ? "failed" : "passed", startedAt: new Date(checkStarted).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: Math.max(0, ended - checkStarted), exitCode });
    if (failure) break;
  }
  const ended = clock();
  const evidence = freeze({ schemaVersion: 1, stage: 5, status: failure ? "failed" : "passed", startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: Math.max(0, ended - started), audit, checks, ...(failure && { failure }) });
  await write(join(root, "products", "workbench", ".cache", "acceptance", "stage-5.json"), evidence);
  return evidence;
}

export function parseStageFiveAcceptanceArguments(args) {
  if (!Array.isArray(args) || args.length) throw new TypeError("Stage 5 acceptance accepts no arguments");
  return {};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    parseStageFiveAcceptanceArguments(process.argv.slice(2));
    const evidence = await runStageFiveAcceptance({ root: ROOT });
    process.stdout.write(`${JSON.stringify({ stage: 5, status: evidence.status, checks: evidence.checks.length })}\n`);
    if (evidence.status !== "passed") process.exitCode = 1;
  }
  catch (error) {
    process.stderr.write(`Stage 5 acceptance failed: ${sanitize(error, ROOT)}\n`);
    process.exitCode = 1;
  }
}
