import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SHA256 = /^[0-9a-f]{64}$/;

async function defaultRunGit({ args, cwd, env }) {
  const { stdout } = await execFile("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

function assertExactFields(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  for (const name of expected) {
    if (!Object.hasOwn(value, name)) {
      throw new TypeError(`${field}.${name} is required`);
    }
  }
  for (const name of Object.keys(value)) {
    if (!expected.includes(name)) {
      throw new TypeError(`unknown field ${field}.${name}`);
    }
  }
}

function assertSafePatchPath(file, field) {
  if (typeof file !== "string" || file.length === 0 || isAbsolute(file)) {
    throw new TypeError(`unsafe patch path at ${field}`);
  }
  const portable = file.replaceAll("\\", "/");
  const normalized = posix.normalize(portable);
  if (
    normalized !== portable
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.startsWith("/")
  ) {
    throw new TypeError(`unsafe patch path at ${field}`);
  }
}

async function loadSeries(seriesPath) {
  let series;
  try {
    series = JSON.parse(await readFile(seriesPath, "utf8"));
  }
  catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError(`patch series is not valid JSON: ${error.message}`);
    }
    throw error;
  }
  assertExactFields(series, ["schemaVersion", "patches"], "series");
  if (series.schemaVersion !== 1) {
    throw new TypeError("series.schemaVersion must equal 1");
  }
  if (!Array.isArray(series.patches)) {
    throw new TypeError("series.patches must be an array");
  }

  const seen = new Set();
  for (const [index, patch] of series.patches.entries()) {
    const field = `patches[${index}]`;
    assertExactFields(patch, ["file", "sha256"], field);
    assertSafePatchPath(patch.file, `${field}.file`);
    if (seen.has(patch.file)) {
      throw new TypeError(`duplicate patch file ${patch.file}`);
    }
    seen.add(patch.file);
    if (typeof patch.sha256 !== "string" || !SHA256.test(patch.sha256)) {
      throw new TypeError(`${field}.sha256 must be a 64-character lowercase SHA-256`);
    }
  }
  return series;
}

async function assertCleanCheckout(checkout, runGit) {
  try {
    const inside = await runGit({
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd: checkout,
    });
    if (inside !== "true") {
      throw new Error("not a work tree");
    }
  }
  catch {
    throw new Error(`patch checkout is not a Git worktree: ${checkout}`);
  }
  const status = await runGit({
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: checkout,
  });
  if (status) {
    throw new Error("patch checkout must be clean before applying a series");
  }
}

export async function applyPatchSeries({
  checkout,
  seriesPath,
  runGit = defaultRunGit,
}) {
  const series = await loadSeries(seriesPath);
  if (series.patches.length === 0) {
    return { applied: [] };
  }

  const verified = [];
  for (const patch of series.patches) {
    const path = join(dirname(seriesPath), patch.file);
    const bytes = await readFile(path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== patch.sha256) {
      throw new Error(`SHA-256 mismatch for ${patch.file}`);
    }
    verified.push({ ...patch, path });
  }

  await assertCleanCheckout(checkout, runGit);

  const preflightDirectory = await mkdtemp(join(tmpdir(), "chatero-patch-index-"));
  const preflightEnv = { GIT_INDEX_FILE: join(preflightDirectory, "index") };
  try {
    await runGit({ args: ["read-tree", "HEAD"], cwd: checkout, env: preflightEnv });
    for (const patch of verified) {
      try {
        // `git apply --cached` validates the whole patch before touching the throwaway
        // index, so a separate `--check` pass would repeat the identical validation.
        await runGit({
          args: ["apply", "--cached", "--whitespace=error", patch.path],
          cwd: checkout,
          env: preflightEnv,
        });
      }
      catch (error) {
        throw new Error(`${patch.file} failed git apply preflight`, { cause: error });
      }
    }
  }
  finally {
    await rm(preflightDirectory, { recursive: true, force: true });
  }

  for (const patch of verified) {
    await runGit({
      args: ["apply", "--whitespace=error", patch.path],
      cwd: checkout,
    });
  }
  return { applied: verified.map(patch => patch.file) };
}
