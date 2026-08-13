#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXPECTED = Object.freeze({
  schemaVersion: 1,
  stage: 6,
  checks: Object.freeze([
    Object.freeze({ id: "research-loop-contract-tests", command: "node", args: Object.freeze(["products/workbench/scripts/run-node-tests.mjs", "products/workbench/tests/research-loop-*.test.mjs", "products/workbench/tests/reviewed-research-surfaces.test.mjs", "products/workbench/tests/zotero-research-api.test.mjs"]) }),
    Object.freeze({ id: "documentation-transaction-tests", command: "node", args: Object.freeze(["products/workbench/scripts/run-node-tests.mjs", "products/workbench/tests/documentation-*.test.mjs"]) }),
    Object.freeze({ id: "qmd-obsidian-editing-parity", command: "node", args: Object.freeze(["--test", "products/workbench/tests/documentation-live-preview-provider.test.mjs", "products/workbench/tests/documentation-quarto-preview.test.mjs"]) }),
    Object.freeze({ id: "local-research-loop-runtime", command: "npm", args: Object.freeze(["run", "test:documentation:integration", "--", "--target", "local"]) }),
    Object.freeze({ id: "ssh-research-loop-runtime", command: "npm", args: Object.freeze(["run", "test:documentation:integration", "--", "--target", "ssh-fixture"]) }),
    Object.freeze({ id: "research-loop-boundary-audit", kind: "source-inspection" }),
  ]),
});

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

export function validateStageSixRequirements(value) {
  if (JSON.stringify(value) !== JSON.stringify(EXPECTED)) throw new TypeError("requirements do not match the immutable Stage 6 requirement contract");
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

export async function inspectStageSixResearchLoop({ root = ROOT } = {}) {
  const catalogText = await readFile(join(root, "products", "workbench", "acceptance", "stage-6-research-loop-parity.json"), "utf8");
  const catalog = JSON.parse(catalogText);
  if (catalog.schemaVersion !== 1 || catalog.stage !== 6 || !Array.isArray(catalog.entries) || catalog.entries.length < 20) {
    throw new Error("Stage 6 Research Loop parity catalog is incomplete");
  }
  if (catalog.entries.some(value => !value || value.status !== "supported" || typeof value.id !== "string" || typeof value.test !== "string")) {
    throw new Error("Stage 6 Research Loop parity catalog contains unsupported or unproven behavior");
  }
  const ids = new Set(catalog.entries.map(value => value.id));
  if (ids.size !== catalog.entries.length) throw new Error("Stage 6 Research Loop parity catalog contains duplicate behavior");
  const extensionRoot = join(root, "products", "workbench", "extensions", "chatero-documentation");
  const [manifestText, controller, registration, composition, reviewed, zoteroApi, remoteEvidence, sourceCommit] = await Promise.all([
    readFile(join(extensionRoot, "package.json"), "utf8"),
    readFile(join(extensionRoot, "research-loop-controller.mjs"), "utf8"),
    readFile(join(extensionRoot, "research-loop-registration.mjs"), "utf8"),
    readFile(join(extensionRoot, "research-loop-composition.mjs"), "utf8"),
    readFile(join(extensionRoot, "reviewed-research-surfaces.mjs"), "utf8"),
    readFile(join(root, "products", "workbench", "extensions", "chatero-zotero", "research-api.mjs"), "utf8"),
    readFile(join(root, "products", "workbench", "extensions", "chatero-remote", "remote-evidence-controller.mjs"), "utf8"),
    execFile("git", ["rev-parse", "HEAD^{commit}"], { cwd: root, encoding: "utf8" }),
  ]);
  const manifest = JSON.parse(manifestText);
  const commands = new Set((manifest.contributes?.commands ?? []).map(value => value.command));
  for (const command of ["chatero.research.runAction", "chatero.research.chatWithSelection", "chatero.research.refreshLiterature", "chatero.research.noteToDraft", "chatero.research.openTopicGraph", "chatero.research.openMainSite"]) {
    if (!commands.has(command)) throw new Error(`Stage 6 command ${command} is not declared`);
  }
  const joined = [controller, registration, composition, reviewed, zoteroApi, remoteEvidence].join("\n");
  if (/zotero\.sqlite|better-sqlite|sqlite3/iu.test(joined)) throw new Error("Stage 6 surface directly accesses Zotero database data");
  if (!joined.includes("chatero.chat.attachTextContext") || !joined.includes("chatero.chat.removeTextContext")) {
    throw new Error("Stage 6 does not use the native removable Chat context boundary");
  }
  if (/createWebviewPanel\([^)]*chat|registerChatParticipant/iu.test(joined)) throw new Error("Stage 6 contains a parallel chat runtime");
  if (/writeFile|workspace\.fs\.writeFile/u.test(reviewed)) throw new Error("reviewed passive surfaces contain a hidden promotion path");
  const commit = sourceCommit.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("Stage 6 source commit is invalid");
  return freeze({
    catalogSha256: createHash("sha256").update(catalogText).digest("hex"),
    commandCount: commands.size,
    hiddenPromotionPaths: 0,
    parallelChatRuntimes: 0,
    parityEntries: catalog.entries.length,
    rendererDatabaseAccess: false,
    sourceCommit: commit,
    unsupportedEntries: 0,
  });
}

async function writeEvidence(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.stage-6-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function runStageSixAcceptance({
  root = ROOT, requirements, run = runCommand, inspect = inspectStageSixResearchLoop,
  write = writeEvidence, clock = Date.now,
} = {}) {
  const contract = validateStageSixRequirements(requirements ?? JSON.parse(await readFile(join(root, "products", "workbench", "acceptance", "stage-6.requirements.json"), "utf8")));
  const sourceCommit = (await execFile("git", ["rev-parse", "HEAD^{commit}"], { cwd: root, encoding: "utf8" })).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("Stage 6 source provenance is invalid");
  const started = clock();
  const checks = [];
  let audit = null;
  let failure = null;
  for (const descriptor of contract.checks) {
    const checkStarted = clock();
    let exitCode = 0;
    try {
      if (descriptor.kind === "source-inspection") audit = await inspect({ root });
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
  const evidence = freeze({ schemaVersion: 1, stage: 6, status: failure ? "failed" : "passed", sourceCommit, startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: Math.max(0, ended - started), audit, checks, ...(failure && { failure }) });
  await write(join(root, "products", "workbench", ".cache", "acceptance", "stage-6.json"), evidence);
  return evidence;
}

export function parseStageSixAcceptanceArguments(args) {
  if (!Array.isArray(args) || args.length) throw new TypeError("Stage 6 acceptance accepts no arguments");
  return {};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    parseStageSixAcceptanceArguments(process.argv.slice(2));
    const evidence = await runStageSixAcceptance({ root: ROOT });
    process.stdout.write(`${JSON.stringify({ stage: 6, status: evidence.status, checks: evidence.checks.length })}\n`);
    if (evidence.status !== "passed") process.exitCode = 1;
  }
  catch (error) { process.stderr.write(`Stage 6 acceptance failed: ${sanitize(error, ROOT)}\n`); process.exitCode = 1; }
}
