import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { loadUpstreamContract } from "./lib/upstream-contract.mjs";
import { verifyWorkbenchPolicy } from "./lib/workbench-policy.mjs";

const execFile = promisify(execFileCallback);
const PROVENANCE_FILE = ".chatero-provenance.json";
const MAX_PROVENANCE_BYTES = 128 * 1024;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKBENCH_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_REPOSITORY_ROOT = resolve(DEFAULT_WORKBENCH_ROOT, "..", "..");

async function defaultRunGit({ args, cwd }) {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseStatusPaths(status) {
  return status
    .split("\n")
    .filter(Boolean)
    .map(line => line.slice(3))
    .sort();
}

async function readProvenance(path) {
  const metadata = await lstat(path).catch(error => {
    if (error?.code === "ENOENT") {
      throw new Error(`Code-OSS provenance is missing: ${path}`);
    }
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PROVENANCE_BYTES) {
    throw new Error(`Code-OSS provenance is not a safe regular file: ${path}`);
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  }
  catch (error) {
    throw new Error(`Code-OSS provenance is invalid: ${error.message}`);
  }
  const fields = [
    "schemaVersion",
    "codeOssCommit",
    "codeOssVersion",
    "node",
    "electron",
    "patches",
    "managedPaths",
    "productSha256",
    "worktreeDiffSha256",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Code-OSS provenance must be an object");
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`Code-OSS provenance is missing ${field}`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) {
      throw new Error(`Code-OSS provenance has unknown field ${field}`);
    }
  }
  return value;
}

async function readPatchPins(seriesPath) {
  let series;
  try {
    series = JSON.parse(await readFile(seriesPath, "utf8"));
  }
  catch (error) {
    throw new Error(`cannot read patch series for verification: ${error.message}`);
  }
  if (series?.schemaVersion !== 1 || !Array.isArray(series.patches)) {
    throw new Error("patch series has an unsupported verification shape");
  }
  return series.patches.map(patch => ({
    file: patch.file,
    sha256: patch.sha256,
  }));
}

export async function verifyCodeOss({
  root = DEFAULT_REPOSITORY_ROOT,
  workbenchRoot = join(root, "products", "workbench"),
  destination = process.env.CHATERO_CODE_OSS_DIR || join(root, "vendor", "code-oss"),
  contractPath = join(workbenchRoot, "upstreams.json"),
  contract,
  runGit = defaultRunGit,
} = {}) {
  const pinned = contract || await loadUpstreamContract(contractPath);
  const canonicalDestination = resolve(destination);
  const provenancePath = join(canonicalDestination, PROVENANCE_FILE);
  const provenance = await readProvenance(provenancePath);

  for (const [field, expected] of [
    ["codeOssCommit", pinned.codeOss.commit],
    ["codeOssVersion", pinned.codeOss.version],
    ["node", pinned.codeOss.node],
    ["electron", pinned.codeOss.electron],
  ]) {
    if (provenance[field] !== expected) {
      throw new Error(`provenance ${field} is ${provenance[field]}, expected ${expected}`);
    }
  }
  if (provenance.schemaVersion !== 1) {
    throw new Error("provenance schemaVersion must equal 1");
  }

  const head = await runGit({
    args: ["rev-parse", "HEAD^{commit}"],
    cwd: canonicalDestination,
  });
  if (head !== pinned.codeOss.commit) {
    throw new Error(`Code-OSS checkout HEAD is ${head}, expected ${pinned.codeOss.commit}`);
  }

  const productPath = join(canonicalDestination, "product.json");
  const productBytes = await readFile(productPath);
  if (sha256(productBytes) !== provenance.productSha256) {
    throw new Error("product.json SHA-256 does not match provenance");
  }

  const status = await runGit({
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: canonicalDestination,
  });
  const managedPaths = parseStatusPaths(status)
    .filter(path => path !== PROVENANCE_FILE);
  if (JSON.stringify(managedPaths) !== JSON.stringify(provenance.managedPaths)) {
    throw new Error(`managed checkout paths differ from provenance: ${managedPaths.join(", ")}`);
  }

  const worktreeDiff = await runGit({
    args: ["diff", "--binary", "HEAD", "--"],
    cwd: canonicalDestination,
  });
  if (sha256(worktreeDiff) !== provenance.worktreeDiffSha256) {
    throw new Error("Code-OSS worktree diff SHA-256 does not match provenance");
  }

  const patchPins = await readPatchPins(join(workbenchRoot, "patches", "code-oss", "series.json"));
  if (JSON.stringify(patchPins) !== JSON.stringify(provenance.patches)) {
    throw new Error("patch pins differ from provenance");
  }

  const policy = await verifyWorkbenchPolicy({
    root: workbenchRoot,
    productPath,
  });
  if (!policy.ok) {
    throw new Error(`workbench policy rejected generated product: ${policy.violations.map(value => value.rule).join(", ")}`);
  }
  return {
    ok: true,
    commit: head,
    destination: canonicalDestination,
    productSha256: provenance.productSha256,
    worktreeDiffSha256: provenance.worktreeDiffSha256,
    policy,
  };
}

function isMainModule() {
  return Boolean(process.argv[1])
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  verifyCodeOss()
    .then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`workbench verification failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
