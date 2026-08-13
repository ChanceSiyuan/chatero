#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { CUTOVER_FIELDS, validateReleaseReceipt, verifyReleaseReceiptArtifact } from "./stage-7-release-contract.mjs";

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const EXPECTED = Object.freeze({
  schemaVersion: 1,
  stage: 7,
  checks: Object.freeze([
    ...[1, 2, 3, 4, 5, 6].map(stage => Object.freeze({ id: `stage-${stage}-same-source`, kind: "prior-stage", stage })),
    Object.freeze({ id: "complete-parity-catalog", kind: "parity-inspection" }),
    Object.freeze({ id: "recovery-security-license-suite", command: "node", args: Object.freeze(["products/workbench/scripts/run-node-tests.mjs", "products/workbench/tests/*.test.mjs", "services/zotero-core/tests/*.test.mjs"]) }),
    Object.freeze({ id: "notarized-macos-release", kind: "release-receipt" }),
    Object.freeze({ id: "atomic-cutover", kind: "cutover-inspection" }),
  ]),
});

const STAGE_CHECKS = Object.freeze({
  1: Object.freeze(["documentation-assets", "workbench-node-tests", "core-protocol", "core-node-tests", "legacy-node-tests", "code-oss-provenance", "code-oss-compile", "documentation-local-runtime", "tracked-source-clean"]),
  2: Object.freeze(["core-protocol", "core-node-and-real-gecko", "profile-discovery-and-import", "signed-gecko-bundle", "core-boundary-audit"]),
  3: Object.freeze(["native-library-tests", "core-library-tests", "workbench-tests", "code-oss-compile", "signed-gecko-bundle", "library-parity-audit"]),
  4: Object.freeze(["core-protocol", "reader-note-citation-tests", "core-mutation-tests", "workbench-regression-tests", "real-profile-parity-twice", "code-oss-compile", "signed-gecko-bundle", "reader-boundary-audit"]),
  5: Object.freeze(["ide-language-product-audit", "remote-contract-tests", "code-oss-compile", "signed-agent-release", "linux-x64-real-ssh", "linux-arm64-real-ssh", "stage-five-boundary-audit"]),
  6: Object.freeze(["research-loop-contract-tests", "documentation-transaction-tests", "local-research-loop-runtime", "ssh-research-loop-runtime", "research-loop-boundary-audit"]),
});

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

export function validateStageSevenRequirements(value) {
  if (JSON.stringify(value) !== JSON.stringify(EXPECTED)) throw new TypeError("requirements do not match the immutable Stage 7 requirement contract");
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

function receiptCommit(receipt) {
  return receipt.sourceCommit ?? receipt.source?.commit ?? receipt.audit?.sourceCommit;
}

export function inspectPriorStageEvidence(receipt, { stage, sourceCommit, requiredChecks }) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.stage !== stage || receipt.status !== "passed"
      || receiptCommit(receipt) !== sourceCommit || !Array.isArray(receipt.checks)) {
    throw new Error(`Stage ${stage} evidence is invalid or stale`);
  }
  const expected = new Set(requiredChecks);
  if (receipt.checks.length !== expected.size || receipt.checks.some(value =>
    !value || !expected.delete(value.id) || value.status !== "passed" || value.exitCode !== 0)) {
    throw new Error(`Stage ${stage} evidence is incomplete`);
  }
  return freeze({ stage, checks: receipt.checks.length, sourceCommit });
}

function evidenceFilename(value) {
  const fragment = value.split("#", 1)[0];
  return fragment.includes("/") || fragment.endsWith(".mjs") ? fragment : null;
}

export async function inspectCompleteParity({ root = ROOT } = {}) {
  const paths = [
    "stage-3-library-parity.json",
    "stage-4-reader-parity.json",
    "stage-5-ide-remote-parity.json",
    "stage-6-research-loop-parity.json",
  ];
  const texts = await Promise.all(paths.map(path => readFile(join(root, "products", "workbench", "acceptance", path), "utf8")));
  const catalogs = texts.map(JSON.parse);
  const entries = [];
  for (const [index, catalog] of catalogs.entries()) {
    const stage = index + 3;
    if (catalog.schemaVersion !== 1 || (catalog.stage !== undefined && catalog.stage !== stage)) throw new Error(`Stage ${stage} parity catalog is invalid`);
    if (stage === 5) {
      for (const value of catalog.languages ?? []) entries.push({ status: "supported", evidence: `language:${value.id}` });
      for (const value of catalog.workbench ?? []) entries.push({ status: "supported", evidence: `workbench:${value}` });
      for (const value of catalog.remote ?? []) entries.push({ status: "supported", evidence: `remote:${value}` });
      continue;
    }
    for (const value of catalog.entries ?? []) entries.push({
      status: value.status,
      evidence: value.evidence ?? value.test,
    });
  }
  if (entries.length < 90 || entries.some(value => value.status !== "supported" || typeof value.evidence !== "string")) {
    throw new Error("complete parity catalog contains unsupported behavior");
  }
  let unresolvedEvidence = 0;
  for (const entry of entries) {
    const filename = evidenceFilename(entry.evidence);
    if (!filename) continue;
    const candidates = filename.startsWith("products/") || filename.startsWith("services/")
      ? [join(root, filename)]
      : [join(root, "products", "workbench", "tests", filename), join(root, "services", "zotero-core", "tests", filename)];
    if (!await Promise.any(candidates.map(path => access(path).then(() => true))).catch(() => false)) unresolvedEvidence += 1;
  }
  if (unresolvedEvidence) throw new Error("complete parity catalog contains unresolved evidence");
  return freeze({
    catalogSha256: createHash("sha256").update(texts.join("\n")).digest("hex"),
    entries: entries.length,
    unresolvedEvidence,
    unsupportedEntries: 0,
  });
}

export function inspectAtomicCutover(receipt, { sourceCommit, productSha256 }) {
  try { validateReleaseReceipt(receipt, { sourceCommit, productSha256 }); }
  catch { throw new Error("Stage 7 cutover receipt is invalid or incomplete"); }
  return freeze({
    electronOnlyVisibleProduct: true,
    notarized: true,
    productSha256,
    sourceCommit,
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeEvidence(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.stage-7-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function runStageSevenAcceptance({
  root = ROOT, requirements, run = runCommand, inspectParity = inspectCompleteParity,
  read = readJson, write = writeEvidence, clock = Date.now,
} = {}) {
  const contract = validateStageSevenRequirements(requirements ?? await read(join(root, "products", "workbench", "acceptance", "stage-7.requirements.json")));
  const sourceCommit = (await execFile("git", ["rev-parse", "HEAD^{commit}"], { cwd: root, encoding: "utf8" })).stdout.trim();
  if (!COMMIT.test(sourceCommit)) throw new Error("Stage 7 source commit is invalid");
  const started = clock();
  const checks = [];
  const audit = {};
  let releaseReceipt = null;
  let failure = null;
  for (const descriptor of contract.checks) {
    const checkStarted = clock();
    let exitCode = 0;
    try {
      if (descriptor.kind === "prior-stage") {
        const receipt = await read(join(root, "products", "workbench", ".cache", "acceptance", `stage-${descriptor.stage}.json`));
        audit[`stage${descriptor.stage}`] = inspectPriorStageEvidence(receipt, {
          stage: descriptor.stage, sourceCommit, requiredChecks: STAGE_CHECKS[descriptor.stage],
        });
      }
      else if (descriptor.kind === "parity-inspection") audit.parity = await inspectParity({ root });
      else if (descriptor.kind === "release-receipt") {
        const receiptPath = resolve(process.env.CHATERO_STAGE_7_RELEASE_RECEIPT ?? join(root, "products", "workbench", ".cache", "acceptance", "stage-7-release.json"));
        const verified = await verifyReleaseReceiptArtifact({ receiptPath, sourceCommit });
        releaseReceipt = verified.receipt;
        audit.release = inspectAtomicCutover(releaseReceipt, {
          sourceCommit,
          productSha256: verified.receipt.productSha256,
        });
      }
      else if (descriptor.kind === "cutover-inspection") {
        if (!releaseReceipt) throw new Error("notarized release must be verified before atomic cutover");
        const cutover = await read(join(root, "products", "workbench", "acceptance", "stage-7-cutover.json"));
        if (cutover.productionVisibleProduct !== "electron-workbench"
            || cutover.legacyGeckoUi !== "developer-parity-oracle-only"
            || cutover.requiresAllPriorStagesAtSameSource !== true
            || cutover.requiresNotarizedProductDigest !== true
            || cutover.rollbackPreservesProfile !== true) {
          throw new Error("atomic cutover declaration is invalid");
        }
        audit.cutover = inspectAtomicCutover(releaseReceipt, {
          sourceCommit,
          productSha256: audit.release.productSha256,
        });
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
  const evidence = freeze({ schemaVersion: 1, stage: 7, status: failure ? "failed" : "passed", sourceCommit, startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: Math.max(0, ended - started), audit, checks, ...(failure && { failure }) });
  await write(join(root, "products", "workbench", ".cache", "acceptance", "stage-7.json"), evidence);
  return evidence;
}

export function parseStageSevenAcceptanceArguments(args) {
  if (!Array.isArray(args) || args.length) throw new TypeError("Stage 7 acceptance accepts no arguments");
  return {};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    parseStageSevenAcceptanceArguments(process.argv.slice(2));
    const evidence = await runStageSevenAcceptance({ root: ROOT });
    process.stdout.write(`${JSON.stringify({ stage: 7, status: evidence.status, checks: evidence.checks.length })}\n`);
    if (evidence.status !== "passed") process.exitCode = 1;
  }
  catch (error) { process.stderr.write(`Stage 7 acceptance failed: ${sanitize(error, ROOT)}\n`); process.exitCode = 1; }
}
