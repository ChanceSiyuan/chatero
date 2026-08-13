#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXPECTED = Object.freeze({
  schemaVersion: 1,
  stage: 3,
  checks: Object.freeze([
    Object.freeze({ id: "native-library-tests", command: "node", args: Object.freeze(["--test", "products/workbench/tests/native-library-extension.test.mjs"]) }),
    Object.freeze({ id: "core-library-tests", command: "node", args: Object.freeze(["--test", "services/zotero-core/tests/gecko-library-adapter.test.mjs", "services/zotero-core/tests/gecko-core-router.test.mjs", "services/zotero-core/tests/core-supervisor.integration.test.mjs"]) }),
    Object.freeze({ id: "workbench-tests", command: "npm", args: Object.freeze(["run", "test:workbench-bootstrap"]) }),
    Object.freeze({ id: "code-oss-compile", command: "npm", args: Object.freeze(["run", "workbench:compile"]) }),
    Object.freeze({ id: "signed-gecko-bundle", command: "npm", args: Object.freeze(["run", "verify:chatero-bundle"]) }),
    Object.freeze({ id: "library-parity-audit", kind: "source-inspection" }),
  ]),
});

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

export function validateStageThreeRequirements(value) {
  if (JSON.stringify(value) !== JSON.stringify(EXPECTED)) throw new TypeError("requirements do not match the immutable Stage 3 requirement contract");
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

export async function inspectStageThreeLibrary({ root }) {
  const extensionRoot = join(root, "products", "workbench", "extensions", "chatero-zotero");
  const [manifestText, extension, catalogText, englishText, chineseText, firstPartyText, sourceCommitResult] = await Promise.all([
    readFile(join(extensionRoot, "package.json"), "utf8"),
    readFile(join(extensionRoot, "extension.cjs"), "utf8"),
    readFile(join(root, "products", "workbench", "acceptance", "stage-3-library-parity.json"), "utf8"),
    readFile(join(extensionRoot, "package.nls.json"), "utf8"),
    readFile(join(extensionRoot, "package.nls.zh-cn.json"), "utf8"),
    readFile(join(root, "products", "workbench", "first-party-extensions.json"), "utf8"),
    execFile("git", ["rev-parse", "HEAD^{commit}"], { cwd: root, encoding: "utf8" }),
  ]);
  const manifest = JSON.parse(manifestText);
  const catalog = JSON.parse(catalogText);
  const english = JSON.parse(englishText);
  const chinese = JSON.parse(chineseText);
  const firstParty = JSON.parse(firstPartyText).extensions.find(value => value.id === "chatero.zotero");
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries) || catalog.entries.length < 35) throw new Error("Library parity catalog is incomplete");
  if (catalog.entries.some(value => value.status !== "supported")) throw new Error("Library parity catalog contains unsupported entries");
  const commands = new Set(manifest.contributes.commands.map(value => value.command));
  for (const entry of catalog.entries) {
    if (!commands.has(entry.chatero) && !["chatero.zotero.library", "chatero.zotero.items", "chatero.zotero.itemTableColumns"].includes(entry.chatero)) {
      throw new Error(`Library parity command ${entry.chatero} is not declared`);
    }
  }
  const registrations = [...extension.matchAll(/registerCommand\("([^"]+)"/gu)].map(match => match[1]);
  for (const command of commands) if (!registrations.includes(command)) throw new Error(`declared Library command ${command} is not registered`);
  if (JSON.stringify(Object.keys(english).sort()) !== JSON.stringify(Object.keys(chinese).sort())) throw new Error("English and Chinese Library localization keys differ");
  if (!manifest.contributes.accessibilityHelpContent?.length || !extension.includes("accessibilityInformation")) throw new Error("Library accessibility coverage is incomplete");
  if (!Array.isArray(firstParty?.files)) throw new Error("Library first-party extension manifest is missing");
  for (const path of ["library-item-table-model.mjs", "library-source-tree-model.mjs", "package.nls.json", "package.nls.zh-cn.json"]) {
    if (!firstParty.files.some(value => value.destination.endsWith(path))) throw new Error(`first-party Library package omits ${path}`);
  }
  if (/sqlite|zotero\.sqlite/iu.test(extension)) throw new Error("Library extension directly accesses Zotero database data");
  const sourceCommit = sourceCommitResult.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("Stage 3 source provenance is invalid");
  return freeze({
    accessibilityStates: 2,
    commandCount: commands.size,
    localeCount: 2,
    parityEntries: catalog.entries.length,
    paritySha256: createHash("sha256").update(catalogText).digest("hex"),
    sourceCommit,
    unsupportedEntries: 0,
  });
}

async function writeEvidence(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.stage-3-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function runStageThreeAcceptance({ root = ROOT, requirements, run = runCommand, inspect = inspectStageThreeLibrary, write = writeEvidence, clock = Date.now } = {}) {
  const contract = validateStageThreeRequirements(requirements ?? JSON.parse(await readFile(join(root, "products", "workbench", "acceptance", "stage-3.requirements.json"), "utf8")));
  const sourceCommit = (await execFile("git", ["rev-parse", "HEAD^{commit}"], { cwd: root, encoding: "utf8" })).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("Stage 3 source provenance is invalid");
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
    catch (error) { if (exitCode === 0) exitCode = 1; failure = { checkId: descriptor.id, message: sanitize(error, root) }; }
    const ended = clock();
    checks.push({ id: descriptor.id, status: exitCode ? "failed" : "passed", startedAt: new Date(checkStarted).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: Math.max(0, ended - checkStarted), exitCode });
    if (failure) break;
  }
  const ended = clock();
  const evidence = freeze({ schemaVersion: 1, stage: 3, status: failure ? "failed" : "passed", sourceCommit, startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: Math.max(0, ended - started), audit, checks, ...(failure && { failure }) });
  await write(join(root, "products", "workbench", ".cache", "acceptance", "stage-3.json"), evidence);
  return evidence;
}

export function parseStageThreeAcceptanceArguments(args) {
  if (!Array.isArray(args) || args.length) throw new TypeError("Stage 3 acceptance accepts no arguments");
  return {};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    parseStageThreeAcceptanceArguments(process.argv.slice(2));
    const evidence = await runStageThreeAcceptance({ root: ROOT });
    process.stdout.write(`${JSON.stringify({ stage: 3, status: evidence.status, checks: evidence.checks.length })}\n`);
    if (evidence.status !== "passed") process.exitCode = 1;
  }
  catch (error) { process.stderr.write(`Stage 3 acceptance failed: ${sanitize(error, ROOT)}\n`); process.exitCode = 1; }
}
