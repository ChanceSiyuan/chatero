#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REQUIREMENTS = join(ROOT, "products", "workbench", "acceptance", "stage-2.requirements.json");
const EVIDENCE = join(ROOT, "products", "workbench", ".cache", "acceptance", "stage-2.json");
const EXPECTED = Object.freeze({
  schemaVersion: 1,
  stage: 2,
  checks: Object.freeze([
    Object.freeze({ id: "core-protocol", command: "npm", args: Object.freeze(["run", "core:check"]) }),
    Object.freeze({ id: "core-node-and-real-gecko", command: "npm", args: Object.freeze(["run", "test:zotero-core"]) }),
    Object.freeze({ id: "signed-gecko-bundle", command: "npm", args: Object.freeze(["run", "verify:chatero-bundle"]) }),
    Object.freeze({ id: "core-boundary-audit", kind: "source-inspection" }),
  ]),
});

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

export function validateStageTwoRequirements(value) {
  if (JSON.stringify(value) !== JSON.stringify(EXPECTED)) throw new TypeError("requirements do not match the immutable Stage 2 requirement contract");
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

export async function inspectStageTwoBoundaries({ root }) {
  const [contract, generated, supervisor, extensionHost] = await Promise.all([
    readFile(join(root, "services", "zotero-core", "protocol", "chatero-core.protocol.json"), "utf8"),
    readFile(join(root, "services", "zotero-core", "generated", "protocol.mjs"), "utf8"),
    readFile(join(root, "services", "zotero-core", "supervisor", "core-supervisor.mjs"), "utf8"),
    readFile(join(root, "products", "workbench", "extensions", "chatero-zotero", "extension.cjs"), "utf8"),
  ]);
  const parsed = JSON.parse(contract);
  if (parsed.methods.length < 53 || parsed.types && Object.keys(parsed.types).length < 133) throw new Error("Core protocol domain surface is incomplete");
  if (!supervisor.includes('"-datadir", "profile"')) throw new Error("Gecko Core data directory is not profile-isolated");
  if (/sqlite|zotero\.sqlite/iu.test(extensionHost)) throw new Error("Workbench Zotero extension contains direct Zotero database access");
  if (!generated.includes('"library.batch-mutate"')) throw new Error("generated protocol is missing atomic batch mutation");
  return freeze({
    methodCount: parsed.methods.length,
    protocolSha256: createHash("sha256").update(contract).digest("hex"),
    rendererDatabaseAccess: false,
    typeCount: Object.keys(parsed.types).length,
  });
}

async function writeEvidence(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.stage-2-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function runStageTwoAcceptance({ root = ROOT, requirements, run = runCommand, inspect = inspectStageTwoBoundaries, write = writeEvidence, clock = Date.now } = {}) {
  const contract = validateStageTwoRequirements(requirements ?? JSON.parse(await readFile(join(root, "products", "workbench", "acceptance", "stage-2.requirements.json"), "utf8")));
  const started = clock();
  const checks = [];
  let audit = null;
  let failure = null;
  for (const descriptor of contract.checks) {
    const checkStarted = clock();
    let exitCode = 0;
    try {
      if (descriptor.kind === "source-inspection") audit = await inspect({ root });
      else exitCode = await run({ file: descriptor.command, args: [...descriptor.args], cwd: root, shell: false });
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
  const evidence = freeze({ schemaVersion: 1, stage: 2, status: failure ? "failed" : "passed", startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), durationMs: Math.max(0, ended - started), audit, checks, ...(failure && { failure }) });
  await write(join(root, "products", "workbench", ".cache", "acceptance", "stage-2.json"), evidence);
  return evidence;
}

export function parseStageTwoAcceptanceArguments(args) {
  if (!Array.isArray(args) || args.length) throw new TypeError("Stage 2 acceptance accepts no arguments");
  return {};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    parseStageTwoAcceptanceArguments(process.argv.slice(2));
    const evidence = await runStageTwoAcceptance({ root: ROOT });
    process.stdout.write(`${JSON.stringify({ stage: 2, status: evidence.status, checks: evidence.checks.length })}\n`);
    if (evidence.status !== "passed") process.exitCode = 1;
  }
  catch (error) { process.stderr.write(`Stage 2 acceptance failed: ${sanitize(error, ROOT)}\n`); process.exitCode = 1; }
}
