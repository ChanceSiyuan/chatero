import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

const execFile = promisify(execFileCallback);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    force: true,
    recursive: true,
  })));
});

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function createUpstreamRepository() {
  const root = await mkdtemp(join(tmpdir(), "chatero-code-oss-upstream-"));
  temporaryDirectories.push(root);
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "Chatero Tests");
  await git(root, "config", "user.email", "tests@chatero.invalid");
  await writeFile(join(root, "product.json"), '{"nameShort":"Code - OSS"}\n');
  await git(root, "add", "product.json");
  await git(root, "commit", "-m", "pinned");
  const pinnedCommit = await git(root, "rev-parse", "HEAD");
  await git(root, "tag", "1.132.0");
  await writeFile(join(root, "after-pin.txt"), "newer main content\n");
  await git(root, "add", "after-pin.txt");
  await git(root, "commit", "-m", "newer-main");
  const newerCommit = await git(root, "rev-parse", "HEAD");
  return { root, pinnedCommit, newerCommit };
}

test("creates a clean detached checkout at the exact pinned commit", async () => {
  const { ensureCheckout } = await import("../scripts/lib/git-checkout.mjs");
  const upstream = await createUpstreamRepository();
  const parent = await mkdtemp(join(tmpdir(), "chatero-code-oss-checkout-"));
  temporaryDirectories.push(parent);
  const destination = join(parent, "code-oss");

  const result = await ensureCheckout({
    repository: upstream.root,
    ref: "refs/tags/1.132.0",
    commit: upstream.pinnedCommit,
    destination,
  });

  assert.deepEqual(result, {
    destination,
    commit: upstream.pinnedCommit,
    created: true,
    clean: true,
  });
  assert.equal(await git(destination, "rev-parse", "HEAD"), upstream.pinnedCommit);
  assert.equal(await git(destination, "branch", "--show-current"), "");
  assert.equal(await git(destination, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.equal(await readFile(join(destination, "product.json"), "utf8"), '{"nameShort":"Code - OSS"}\n');
});

test("moves a clean existing checkout to the pin without deleting repository files", async () => {
  const { ensureCheckout } = await import("../scripts/lib/git-checkout.mjs");
  const upstream = await createUpstreamRepository();
  const parent = await mkdtemp(join(tmpdir(), "chatero-code-oss-existing-"));
  temporaryDirectories.push(parent);
  const destination = join(parent, "code-oss");
  await git(parent, "clone", upstream.root, destination);
  assert.equal(await git(destination, "rev-parse", "HEAD"), upstream.newerCommit);

  const result = await ensureCheckout({
    repository: upstream.root,
    ref: "refs/tags/1.132.0",
    commit: upstream.pinnedCommit,
    destination,
  });

  assert.equal(result.created, false);
  assert.equal(await git(destination, "rev-parse", "HEAD"), upstream.pinnedCommit);
  assert.equal(await readFile(join(destination, "product.json"), "utf8"), '{"nameShort":"Code - OSS"}\n');
});

test("rejects a dirty existing checkout and preserves every dirty byte", async () => {
  const { ensureCheckout } = await import("../scripts/lib/git-checkout.mjs");
  const upstream = await createUpstreamRepository();
  const parent = await mkdtemp(join(tmpdir(), "chatero-code-oss-dirty-"));
  temporaryDirectories.push(parent);
  const destination = join(parent, "code-oss");
  await git(parent, "clone", upstream.root, destination);
  await writeFile(join(destination, "product.json"), "personal dirty bytes\n");
  await writeFile(join(destination, "untracked.txt"), "must survive\n");

  await assert.rejects(
    ensureCheckout({
      repository: upstream.root,
      ref: "refs/tags/1.132.0",
      commit: upstream.pinnedCommit,
      destination,
    }),
    /Code-OSS checkout is dirty: product\.json, untracked\.txt/
  );

  assert.equal(await readFile(join(destination, "product.json"), "utf8"), "personal dirty bytes\n");
  assert.equal(await readFile(join(destination, "untracked.txt"), "utf8"), "must survive\n");
  assert.equal(await git(destination, "rev-parse", "HEAD"), upstream.newerCommit);
});

test("rejects a non-Git destination without modifying it", async () => {
  const { ensureCheckout } = await import("../scripts/lib/git-checkout.mjs");
  const upstream = await createUpstreamRepository();
  const destination = await mkdtemp(join(tmpdir(), "chatero-code-oss-not-git-"));
  temporaryDirectories.push(destination);
  await mkdir(join(destination, "personal"));
  await writeFile(join(destination, "personal", "note.txt"), "keep\n");

  await assert.rejects(
    ensureCheckout({
      repository: upstream.root,
      ref: "refs/tags/1.132.0",
      commit: upstream.pinnedCommit,
      destination,
    }),
    /destination exists but is not a Git checkout/
  );

  assert.equal(await readFile(join(destination, "personal", "note.txt"), "utf8"), "keep\n");
});

test("rejects a commit that the immutable ref does not resolve to", async () => {
  const { ensureCheckout } = await import("../scripts/lib/git-checkout.mjs");
  const upstream = await createUpstreamRepository();
  const parent = await mkdtemp(join(tmpdir(), "chatero-code-oss-mismatch-"));
  temporaryDirectories.push(parent);
  const destination = join(parent, "code-oss");

  await assert.rejects(
    ensureCheckout({
      repository: upstream.root,
      ref: "refs/tags/1.132.0",
      commit: upstream.newerCommit,
      destination,
    }),
    /refs\/tags\/1\.132\.0 resolved to .* instead of the pinned commit/
  );
});
