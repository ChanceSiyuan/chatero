import { execFile as execFileCallback } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

async function pathState(path) {
  try {
    const value = await stat(path);
    return value.isDirectory() ? "directory" : "other";
  }
  catch (error) {
    if (error?.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

async function defaultRunGit({ args, cwd }) {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

function dirtyPaths(status) {
  return status
    .split("\n")
    .filter(Boolean)
    .map(line => line.slice(3))
    .sort();
}

async function assertGitCheckout(destination, runGit) {
  try {
    const inside = await runGit({
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd: destination,
    });
    if (inside !== "true") {
      throw new Error("not inside a work tree");
    }
  }
  catch {
    throw new Error(`destination exists but is not a Git checkout: ${destination}`);
  }
}

async function readStatus(destination, runGit) {
  return runGit({
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: destination,
  });
}

async function assertClean(destination, runGit) {
  const status = await readStatus(destination, runGit);
  if (status) {
    throw new Error(`Code-OSS checkout is dirty: ${dirtyPaths(status).join(", ")}`);
  }
}

async function fetchPinnedRef({ repository, ref, commit, destination, runGit }) {
  await runGit({
    args: ["fetch", "--no-tags", repository, ref],
    cwd: destination,
  });
  const resolved = await runGit({
    args: ["rev-parse", "FETCH_HEAD^{commit}"],
    cwd: destination,
  });
  if (resolved !== commit) {
    throw new Error(`${ref} resolved to ${resolved} instead of the pinned commit ${commit}`);
  }
}

export async function verifyCheckout({ destination, commit, runGit = defaultRunGit }) {
  const canonicalDestination = resolve(destination);
  if (await pathState(canonicalDestination) !== "directory") {
    throw new Error(`Code-OSS checkout does not exist: ${canonicalDestination}`);
  }
  await assertGitCheckout(canonicalDestination, runGit);
  const head = await runGit({
    args: ["rev-parse", "HEAD^{commit}"],
    cwd: canonicalDestination,
  });
  if (head !== commit) {
    throw new Error(`Code-OSS checkout HEAD is ${head}, expected ${commit}`);
  }
  await assertClean(canonicalDestination, runGit);
  return {
    destination: canonicalDestination,
    commit,
    created: false,
    clean: true,
  };
}

export async function ensureCheckout({
  repository,
  ref,
  commit,
  destination,
  runGit = defaultRunGit,
}) {
  const canonicalDestination = resolve(destination);
  const state = await pathState(canonicalDestination);
  let created = false;

  if (state === "other") {
    throw new Error(`destination exists but is not a Git checkout: ${canonicalDestination}`);
  }
  if (state === "directory") {
    await assertGitCheckout(canonicalDestination, runGit);
    await assertClean(canonicalDestination, runGit);
  }
  else {
    await mkdir(dirname(canonicalDestination), { recursive: true });
    await runGit({
      args: [
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        repository,
        canonicalDestination,
      ],
      cwd: dirname(canonicalDestination),
    });
    created = true;
    await assertGitCheckout(canonicalDestination, runGit);
  }

  await fetchPinnedRef({
    repository,
    ref,
    commit,
    destination: canonicalDestination,
    runGit,
  });
  await runGit({
    args: ["checkout", "--detach", commit],
    cwd: canonicalDestination,
  });

  const verified = await verifyCheckout({
    destination: canonicalDestination,
    commit,
    runGit,
  });
  return {
    ...verified,
    created,
  };
}
