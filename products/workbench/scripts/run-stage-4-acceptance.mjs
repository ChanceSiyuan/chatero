#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXPECTED = Object.freeze({
  schemaVersion: 1,
  stage: 4,
  checks: Object.freeze([
    Object.freeze({ id: "core-protocol", command: "npm", args: Object.freeze(["run", "core:check"]) }),
    Object.freeze({ id: "reader-note-citation-tests", command: "node", args: Object.freeze(["--test", "products/workbench/tests/reader-workflow-model.test.mjs", "products/workbench/tests/upstream-reader-bridge.test.mjs", "products/workbench/tests/zotero-evidence-editors.test.mjs", "products/workbench/tests/zotero-pdf-context.test.mjs", "products/workbench/tests/native-library-extension.test.mjs"]) }),
    Object.freeze({ id: "core-mutation-tests", command: "node", args: Object.freeze(["--test", "services/zotero-core/tests/gecko-library-adapter.test.mjs", "services/zotero-core/tests/gecko-core-router.test.mjs", "services/zotero-core/tests/core-supervisor.integration.test.mjs"]) }),
    Object.freeze({ id: "workbench-regression-tests", command: "npm", args: Object.freeze(["run", "test:workbench-bootstrap"]) }),
    Object.freeze({ id: "real-profile-parity-twice", command: "node", args: Object.freeze(["services/zotero-core/scripts/run-stage-4-real-profile.mjs"]) }),
    Object.freeze({ id: "code-oss-compile", command: "npm", args: Object.freeze(["run", "workbench:compile"]) }),
    Object.freeze({ id: "signed-gecko-bundle", command: "npm", args: Object.freeze(["run", "verify:chatero-bundle"]) }),
    Object.freeze({ id: "reader-boundary-audit", kind: "source-inspection" }),
  ]),
});

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

export function validateStageFourRequirements(value) {
  if (JSON.stringify(value) !== JSON.stringify(EXPECTED)) throw new TypeError("requirements do not match the immutable Stage 4 requirement contract");
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

export async function inspectStageFourReader({ root, requireProductMatch = false, requireRealEvidence = false }) {
  const extensionRoot = join(root, "products", "workbench", "extensions", "chatero-zotero");
	const omniPath = join(root, "app", "staging", "Chatero.app", "Contents", "Resources", "app", "omni.ja");
	const productAudit = requireProductMatch
		? Promise.all([
			readFile(omniPath),
			execFile("unzip", ["-p", omniPath, "resource/chatero-build.mjs"], { encoding: "utf8", maxBuffer: 1024 * 1024 }),
		])
		: Promise.resolve(null);
	const [catalogText, extension, provider, workflow, readerBridge, readerServer, noteHtml, readerHost, readerPage, readerBundle, viewerPageStat, workerStat, protocol, manifestText, firstPartyText, sourceCommitResult, product, realProfileText] = await Promise.all([
    readFile(join(root, "products", "workbench", "acceptance", "stage-4-reader-parity.json"), "utf8"),
    readFile(join(extensionRoot, "extension.cjs"), "utf8"),
    readFile(join(extensionRoot, "evidence-editors.cjs"), "utf8"),
    readFile(join(extensionRoot, "reader-workflow-model.mjs"), "utf8"),
    readFile(join(extensionRoot, "upstream-reader-bridge.mjs"), "utf8"),
    readFile(join(extensionRoot, "reader-server.cjs"), "utf8"),
    readFile(join(extensionRoot, "evidence-editor-html.mjs"), "utf8"),
    readFile(join(extensionRoot, "media", "zotero-reader", "chatero-reader-host.mjs"), "utf8"),
    readFile(join(extensionRoot, "media", "zotero-reader", "chatero-reader.html"), "utf8"),
    readFile(join(extensionRoot, "media", "zotero-reader", "reader.js"), "utf8"),
    stat(join(extensionRoot, "media", "zotero-reader", "pdf", "web", "viewer.html")),
    stat(join(extensionRoot, "media", "zotero-reader", "pdf", "build", "pdf.worker.mjs")),
    readFile(join(root, "services", "zotero-core", "protocol", "chatero-core.protocol.json"), "utf8"),
    readFile(join(extensionRoot, "package.json"), "utf8"),
    readFile(join(root, "products", "workbench", "first-party-extensions.json"), "utf8"),
		execFile("git", ["rev-parse", "HEAD^{commit}"], { cwd: root, encoding: "utf8" }),
		productAudit,
		requireRealEvidence
			? readFile(join(root, "products", "workbench", ".cache", "acceptance", "stage-4-real-profile.json"), "utf8")
			: Promise.resolve(null),
  ]);
  const catalog = JSON.parse(catalogText);
  if (catalog.schemaVersion !== 1 || catalog.stage !== 4 || !Array.isArray(catalog.entries) || catalog.entries.length < 14) throw new Error("Stage 4 parity catalog is incomplete");
  if (catalog.entries.some(value => value.status !== "supported")) throw new Error("Stage 4 parity catalog contains unsupported behavior");
  for (const [label, info] of [["pdf/web/viewer.html", viewerPageStat], ["pdf/build/pdf.worker.mjs", workerStat]]) {
    if (!info.isFile() || info.size === 0) throw new Error(`Stage 4 Reader package omits ${label}`);
  }
  const joined = [extension, provider, workflow, readerBridge, readerServer, noteHtml, readerHost, readerPage, readerBundle].join("\n");
  for (const behavior of [
    "batchMutate",
    "expectedVersion",
    "async undo()",
    'new Set(["highlight", "image", "ink", "note", "text", "underline"])',
    "note-reload",
    "citation.render",
    "upstream-reader-save",
    "upstream-reader-delete",
    "chatero-reader-init",
    "chatero-reader-key",
    "reader-unsupported",
  ]) {
    if (!joined.includes(behavior)) throw new Error(`Stage 4 implementation omits ${behavior}`);
  }
  // The reader page and the materialized attachment are served by a per-extension
  // loopback server instead of webview resource URIs, so its boundaries are part
  // of the Reader audit: GET only, 127.0.0.1 only, unguessable token, and paths
  // resolved through realpath inside the packaged reader root.
  for (const boundary of [
    'request.method !== "GET"',
    'server.listen(0, "127.0.0.1"',
    "token !== this.#token",
    'randomBytes(18).toString("base64url")',
    "await realpath(path)",
    "real.startsWith(this.#mediaRoot + sep)",
    '"X-Content-Type-Options": "nosniff"',
  ]) {
    if (!readerServer.includes(boundary)) throw new Error(`Stage 4 reader server omits ${boundary}`);
  }
  if (/zotero\.sqlite|better-sqlite|sqlite3/iu.test(joined)) throw new Error("Workbench Reader directly accesses Zotero database data");
  if (/fetch\(["']https?:/u.test(joined)) throw new Error("Reader performs an undeclared remote fetch");
  if (/asWebviewUri|localResourceRoots: \[[^\]]/u.test(provider)) throw new Error("Reader grants the webview direct resource access");
  const manifest = JSON.parse(manifestText);
  const commands = new Set(manifest.contributes.commands.map(value => value.command));
  for (const command of ["chatero.zotero.copyCitation", "chatero.zotero.copyBibliography", "chatero.zotero.insertCitation"]) if (!commands.has(command)) throw new Error(`Stage 4 command ${command} is not declared`);
  const firstParty = JSON.parse(firstPartyText).extensions.find(value => value.id === "chatero.zotero");
  for (const path of [
    "chatero-zotero/reader-server.cjs",
    "media/zotero-reader/reader.js",
    "media/zotero-reader/chatero-reader.html",
    "media/zotero-reader/chatero-reader-host.mjs",
    "media/zotero-reader/pdf/build/pdf.mjs",
    "media/zotero-reader/pdf/build/pdf.worker.mjs",
    "media/zotero-reader/pdf/web/viewer.html",
    "media/zotero-reader/pdf/web/viewer.mjs",
  ]) {
    if (!firstParty.files.some(value => value.destination.endsWith(path))) throw new Error(`first-party Reader package omits ${path}`);
  }
  if (firstParty.files.some(value => value.destination.includes("media/pdf-viewer/"))) throw new Error("first-party Reader package still ships the removed custom PDF viewer");
  if (!protocol.includes('"library.batch-mutate"') || !protocol.includes('"citation.render"')) throw new Error("Core protocol omits Stage 4 transactions");
	const sourceCommit = sourceCommitResult.stdout.trim();
	if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("Stage 4 source provenance is invalid");
	let productEvidence = null;
	if (product) {
		const [omniBytes, provenanceResult] = product;
		const packagedMatch = provenanceResult.stdout.match(/"sourceCommit":\s*"([0-9a-f]{40})"/u);
		if (!packagedMatch) throw new Error("Stage 4 product provenance is invalid");
		const packagedSourceCommit = packagedMatch[1];
		if (packagedSourceCommit !== sourceCommit) throw new Error("Stage 4 signed product does not match repository HEAD");
		productEvidence = Object.freeze({
			bundleOmniSha256: createHash("sha256").update(omniBytes).digest("hex"),
			packagedSourceCommit,
		});
	}
	let realProfile = null;
	if (requireRealEvidence) {
		realProfile = JSON.parse(realProfileText);
		if (realProfile.schemaVersion !== 1 || realProfile.status !== "passed" || realProfile.runs !== 2 || !/^[0-9a-f]{64}$/u.test(realProfile.digest)) {
			throw new Error("Stage 4 real profile evidence is invalid");
		}
	}
  return freeze({
		...(productEvidence ?? {}),
    commandCount: commands.size,
    parityEntries: catalog.entries.length,
    paritySha256: createHash("sha256").update(catalogText).digest("hex"),
		...(realProfile && { realProfile }),
    rendererDatabaseAccess: false,
    remoteReaderFetches: 0,
    unsupportedEntries: 0,
		sourceCommit,
  });
}

async function writeEvidence(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.stage-4-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function runStageFourAcceptance({ root = ROOT, requirements, run = runCommand, inspect = inspectStageFourReader, write = writeEvidence, clock = Date.now } = {}) {
  const contract = validateStageFourRequirements(requirements ?? JSON.parse(await readFile(join(root, "products", "workbench", "acceptance", "stage-4.requirements.json"), "utf8")));
  const sourceCommit = (await execFile("git", ["rev-parse", "HEAD^{commit}"], { cwd: root, encoding: "utf8" })).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("Stage 4 source provenance is invalid");
  const started = clock();
  const checks = [];
  let audit = null;
  let failure = null;
  for (const descriptor of contract.checks) {
    const checkStarted = clock();
    let exitCode = 0;
    try {
		if (descriptor.kind === "source-inspection") audit = await inspect({ root, requireProductMatch: true, requireRealEvidence: true });
      else exitCode = await run({ file: descriptor.command, args: [...descriptor.args], cwd: root });
      if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) throw new Error("command returned an invalid exit code");
      if (exitCode !== 0) throw new Error(`required command ${descriptor.id} exited with ${exitCode}`);
    }
    catch (error) { if (exitCode === 0) exitCode = 1; failure = { checkId: descriptor.id, message: sanitize(error, root) }; }
    const ended = clock();
    checks.push({ id: descriptor.id, status: exitCode ? "failed" : "passed", startedAt: new Date(checkStarted).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: Math.max(0, ended - checkStarted), exitCode });
    if (failure) break;
  }
  const ended = clock();
  const evidence = freeze({ schemaVersion: 1, stage: 4, status: failure ? "failed" : "passed", sourceCommit, startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: Math.max(0, ended - started), audit, checks, ...(failure && { failure }) });
  await write(join(root, "products", "workbench", ".cache", "acceptance", "stage-4.json"), evidence);
  return evidence;
}

export function parseStageFourAcceptanceArguments(args) {
  if (!Array.isArray(args) || args.length) throw new TypeError("Stage 4 acceptance accepts no arguments");
  return {};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    parseStageFourAcceptanceArguments(process.argv.slice(2));
    const evidence = await runStageFourAcceptance({ root: ROOT });
    process.stdout.write(`${JSON.stringify({ stage: 4, status: evidence.status, checks: evidence.checks.length })}\n`);
    if (evidence.status !== "passed") process.exitCode = 1;
  }
  catch (error) { process.stderr.write(`Stage 4 acceptance failed: ${sanitize(error, ROOT)}\n`); process.exitCode = 1; }
}
