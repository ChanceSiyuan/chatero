#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { verifyCodeOss } from "./verify-code-oss.mjs";

const execFile = promisify(execFileCallback);
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIRECTORY, "..", "..", "..");
const DEFAULT_REQUIREMENTS_PATH = join(DEFAULT_ROOT, "products", "workbench", "acceptance", "stage-1.requirements.json");
const DEFAULT_EVIDENCE_PATH = join(DEFAULT_ROOT, "products", "workbench", ".cache", "acceptance", "stage-1.json");
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

const EXPECTED_REQUIREMENTS = Object.freeze({
  schemaVersion: 1,
  stage: 1,
  checks: Object.freeze([
    Object.freeze({ id: "documentation-assets", command: "npm", args: Object.freeze(["run", "build:documentation-webview"]) }),
    Object.freeze({ id: "workbench-node-tests", command: "npm", args: Object.freeze(["run", "test:workbench-bootstrap"]) }),
    Object.freeze({ id: "core-protocol", command: "npm", args: Object.freeze(["run", "core:check"]) }),
    Object.freeze({ id: "core-node-tests", command: "npm", args: Object.freeze(["run", "test:zotero-core"]) }),
    Object.freeze({ id: "legacy-node-tests", command: "npm", args: Object.freeze(["run", "test:chatero"]) }),
    Object.freeze({ id: "code-oss-provenance", command: "npm", args: Object.freeze(["run", "workbench:verify"]) }),
    Object.freeze({ id: "code-oss-compile", command: "npm", args: Object.freeze(["run", "workbench:compile"]) }),
    Object.freeze({
      id: "documentation-local-runtime",
      command: "npm",
      args: Object.freeze(["run", "test:documentation:integration", "--", "--target", "local"]),
    }),
    Object.freeze({ id: "tracked-source-clean", kind: "source-inspection" }),
  ]),
});

function cloneAndFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)])));
  }
  return value;
}

export function validateStageOneRequirements(value) {
  if (JSON.stringify(value) !== JSON.stringify(EXPECTED_REQUIREMENTS)) {
    throw new TypeError("requirements do not match the immutable Stage 1 requirement contract");
  }
  return cloneAndFreeze(value);
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function sanitizeFailureMessage(error, root) {
  let message = error instanceof Error ? error.message : String(error);
  for (const [value, replacement] of [
    [root, "<repository>"],
    [process.env.HOME, "<home>"],
  ]) {
    if (value) message = message.replaceAll(value, replacement);
  }
  message = message
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\b(token|password|credential|secret)=\S+/giu, "$1=<redacted>")
    .slice(0, 512);
  return message || "acceptance check failed";
}

async function defaultRunCommand({ file, args, cwd, shell }) {
  return new Promise((accept, reject) => {
    const child = spawn(file, args, {
      cwd,
      shell,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (Number.isInteger(code)) accept(code);
      else reject(new Error(`command terminated by ${signal ?? "unknown signal"}`));
    });
  });
}

async function runGit(root, args) {
  const { stdout } = await execFile("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

function validateInspection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("source inspection returned no evidence");
  }
  const { source, upstream } = value;
  if (!source || !SHA1.test(source.commit) || typeof source.clean !== "boolean") {
    throw new Error("source inspection returned invalid Git evidence");
  }
  if (!upstream || !SHA1.test(upstream.commit)
    || !SHA256.test(upstream.productSha256)
    || !SHA256.test(upstream.patchSeriesSha256)) {
    throw new Error("source inspection returned invalid Code-OSS evidence");
  }
  return {
    source: Object.freeze({ commit: source.commit, clean: source.clean }),
    upstream: Object.freeze({
      commit: upstream.commit,
      productSha256: upstream.productSha256,
      patchSeriesSha256: upstream.patchSeriesSha256,
    }),
  };
}

export async function inspectStageOneSource({ root }) {
  const [commit, status, upstream, patchSeriesBytes] = await Promise.all([
    runGit(root, ["rev-parse", "HEAD^{commit}"]),
    runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    verifyCodeOss({ root }),
    readFile(join(root, "products", "workbench", "patches", "code-oss", "series.json")),
  ]);
  return validateInspection({
    source: { commit, clean: status === "" },
    upstream: {
      commit: upstream.commit,
      productSha256: upstream.productSha256,
      patchSeriesSha256: createHash("sha256").update(patchSeriesBytes).digest("hex"),
    },
  });
}

export async function writeStageOneEvidence({ path, evidence }) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.stage-1-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  }
  catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function commandCheckResult({ descriptor, started, ended, exitCode }) {
  return Object.freeze({
    id: descriptor.id,
    status: exitCode === 0 ? "passed" : "failed",
    startedAt: iso(started),
    endedAt: iso(ended),
    durationMs: Math.max(0, ended - started),
    exitCode,
  });
}

export async function runStageOneAcceptance({
  root = DEFAULT_ROOT,
  requirements,
  requirementsPath = join(root, "products", "workbench", "acceptance", "stage-1.requirements.json"),
  evidencePath = join(root, "products", "workbench", ".cache", "acceptance", "stage-1.json"),
  clock = Date.now,
  runCommand = defaultRunCommand,
  inspectSource = inspectStageOneSource,
  writeEvidence = writeStageOneEvidence,
} = {}) {
  const loaded = requirements ?? JSON.parse(await readFile(requirementsPath, "utf8"));
  const contract = validateStageOneRequirements(loaded);
  const started = clock();
  const checks = [];
  let source = null;
  let upstream = null;
  let failure = null;

  for (const descriptor of contract.checks.slice(0, -1)) {
    const checkStarted = clock();
    let exitCode;
    try {
      exitCode = await runCommand({
        file: descriptor.command,
        args: [...descriptor.args],
        cwd: root,
        shell: false,
      });
      if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
        throw new Error("command returned an invalid exit code");
      }
    }
    catch (error) {
      exitCode = 1;
      failure = {
        checkId: descriptor.id,
        message: sanitizeFailureMessage(error, root),
      };
    }
    const checkEnded = clock();
    checks.push(commandCheckResult({ descriptor, started: checkStarted, ended: checkEnded, exitCode }));
    if (exitCode !== 0) {
      failure ??= {
        checkId: descriptor.id,
        message: `required command ${descriptor.id} exited with ${exitCode}`,
      };
      break;
    }
  }

  if (!failure) {
    const descriptor = contract.checks.at(-1);
    const checkStarted = clock();
    let exitCode = 0;
    try {
      const inspection = validateInspection(await inspectSource({ root }));
      source = inspection.source;
      upstream = inspection.upstream;
      if (!source.clean) throw new Error("tracked source is dirty");
    }
    catch (error) {
      exitCode = 1;
      failure = {
        checkId: descriptor.id,
        message: sanitizeFailureMessage(error, root),
      };
    }
    const checkEnded = clock();
    checks.push(commandCheckResult({ descriptor, started: checkStarted, ended: checkEnded, exitCode }));
  }

  const ended = clock();
  const evidence = Object.freeze({
    schemaVersion: 1,
    stage: 1,
    status: failure ? "failed" : "passed",
    startedAt: iso(started),
    endedAt: iso(ended),
    durationMs: Math.max(0, ended - started),
    source,
    upstream,
    checks: Object.freeze(checks),
    ...(failure ? { failure: Object.freeze(failure) } : {}),
  });
  await writeEvidence({ path: evidencePath, evidence });
  return evidence;
}

export function parseStageOneAcceptanceArguments(args) {
  if (!Array.isArray(args)) throw new TypeError("Stage 1 acceptance arguments must be an array");
  if (args.length !== 0) throw new TypeError("Stage 1 acceptance accepts no arguments");
  return {};
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    parseStageOneAcceptanceArguments(process.argv.slice(2));
    const evidence = await runStageOneAcceptance({
      root: DEFAULT_ROOT,
      requirementsPath: DEFAULT_REQUIREMENTS_PATH,
      evidencePath: DEFAULT_EVIDENCE_PATH,
    });
    process.stdout.write(`${JSON.stringify({
      stage: evidence.stage,
      status: evidence.status,
      checks: evidence.checks.length,
    })}\n`);
    if (evidence.status !== "passed") process.exitCode = 1;
  }
  catch (error) {
    process.stderr.write(`Stage 1 acceptance failed: ${sanitizeFailureMessage(error, DEFAULT_ROOT)}\n`);
    process.exitCode = 1;
  }
}
