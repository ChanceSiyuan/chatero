import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  assertSafeDestinationAncestors,
  inspectFirstPartyExtensionSources,
  materializeFirstPartyExtensions,
} from "./first-party-extensions.mjs";
import { BUILD_GENERATED_TRACKED_PATHS } from "../verify-code-oss.mjs";

const execFile = promisify(execFileCallback);
const PROVENANCE_FILE = ".chatero-provenance.json";

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

function extensionTreePath(checkout, destinationRoot) {
  if (typeof destinationRoot !== "string" || !/^extensions\/[a-z][a-z0-9-]*$/u.test(destinationRoot)) {
    throw new Error(`unsafe first-party extension destination root: ${destinationRoot}`);
  }
  const path = resolve(checkout, destinationRoot.split("/").join(sep));
  const contained = relative(checkout, path);
  if (!contained || contained === ".." || contained.startsWith(`..${sep}`)) {
    throw new Error(`first-party extension destination root escapes the checkout: ${destinationRoot}`);
  }
  return path;
}

async function readRefreshableProvenance(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.firstPartyExtensions)) {
    throw new Error("Code-OSS provenance is not usable for a first-party extension refresh");
  }
  return value;
}

async function atomicWriteJSON(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o644,
    });
    await rename(temporaryPath, path);
  }
  catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

// Development commands verify the generated checkout against its own
// provenance, which stays green even after the repository's extension sources
// move ahead -- the checkout is internally consistent yet stale, and a launch
// silently runs old code. This refresh closes that gap: when the current
// sources differ from what the checkout was generated from, it re-materializes
// every first-party extension tree and re-records the provenance so subsequent
// verification pins the fresh bytes.
export async function refreshFirstPartyExtensions({
  root,
  checkout,
  manifestPath = join(root, "products", "workbench", "first-party-extensions.json"),
  buildWebview,
  runGit = defaultRunGit,
} = {}) {
  const canonicalRoot = resolve(root);
  const canonicalCheckout = resolve(checkout);
  const provenancePath = join(canonicalCheckout, PROVENANCE_FILE);
  if (buildWebview) await buildWebview({ root: canonicalRoot });
  const current = await inspectFirstPartyExtensionSources({ root: canonicalRoot, manifestPath });
  const provenance = await readRefreshableProvenance(provenancePath);
  if (JSON.stringify(current) === JSON.stringify(provenance.firstPartyExtensions)) {
    return { refreshed: false, extensions: provenance.firstPartyExtensions.map(extension => extension.id) };
  }
  const destinationRoots = new Set([
    ...provenance.firstPartyExtensions.map(extension => extension.destinationRoot),
    ...current.map(extension => extension.destinationRoot),
  ]);
  // Each tree is moved aside rather than deleted, so a failure part-way through
  // materializing restores the previous trees instead of leaving a checkout
  // whose provenance describes files that no longer exist -- a state the verify
  // gate would reject before refresh could ever repair it. Path math alone does
  // not bound a delete: every ancestor is checked for symbolic links first, so
  // a redirected `extensions` component cannot move the target outside the
  // checkout.
  const staged = [];
  for (const destinationRoot of destinationRoots) {
    const path = extensionTreePath(canonicalCheckout, destinationRoot);
    await assertSafeDestinationAncestors(canonicalCheckout, path);
    const metadata = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!metadata) continue;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`first-party extension tree is unsafe to replace: ${destinationRoot}`);
    }
    const backup = `${path}.chatero-refresh-${randomUUID()}`;
    await rename(path, backup);
    staged.push({ backup, path });
  }
  let materialized;
  try {
    materialized = await materializeFirstPartyExtensions({
      root: canonicalRoot,
      checkout: canonicalCheckout,
      manifestPath,
    });
  }
  catch (error) {
    for (const entry of staged) {
      await rm(entry.path, { force: true, recursive: true }).catch(() => {});
      await rename(entry.backup, entry.path).catch(() => {});
    }
    throw error;
  }
  await Promise.all(staged.map(entry => rm(entry.backup, { force: true, recursive: true })));
  const status = await runGit({
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: canonicalCheckout,
  });
  const managedPaths = parseStatusPaths(status)
    .filter(path => path !== PROVENANCE_FILE && !BUILD_GENERATED_TRACKED_PATHS.includes(path));
  const worktreeDiff = await runGit({
    args: [
      "diff",
      "--binary",
      "HEAD",
      "--",
      ".",
      ...BUILD_GENERATED_TRACKED_PATHS.map(path => `:(exclude)${path}`),
    ],
    cwd: canonicalCheckout,
  });
  await atomicWriteJSON(provenancePath, {
    ...provenance,
    firstPartyExtensions: materialized.extensions,
    managedPaths,
    worktreeDiffSha256: sha256(worktreeDiff),
  });
  return { refreshed: true, extensions: materialized.extensions.map(extension => extension.id) };
}
