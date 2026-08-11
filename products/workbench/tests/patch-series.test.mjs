import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8" });
  return stdout.trimEnd();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createPatchFixture({ invalidSecond = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "chatero-patch-series-"));
  temporaryDirectories.push(root);
  const checkout = join(root, "checkout");
  const patches = join(root, "patches");
  await mkdir(checkout);
  await mkdir(patches);
  await git(checkout, "init", "--initial-branch=main");
  await git(checkout, "config", "user.name", "Chatero Tests");
  await git(checkout, "config", "user.email", "tests@chatero.invalid");
  await writeFile(join(checkout, "a.txt"), "one\n");
  await writeFile(join(checkout, "b.txt"), "one\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-m", "base");

  const first = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-one",
    "+two",
    "",
  ].join("\n");
  const second = [
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1 @@",
    invalidSecond ? "-does-not-exist" : "-one",
    "+three",
    "",
  ].join("\n");
  await writeFile(join(patches, "0001-a.patch"), first);
  await writeFile(join(patches, "0002-b.patch"), second);
  const seriesPath = join(patches, "series.json");
  await writeFile(seriesPath, `${JSON.stringify({
    schemaVersion: 1,
    patches: [
      { file: "0001-a.patch", sha256: sha256(first) },
      { file: "0002-b.patch", sha256: sha256(second) },
    ],
  }, null, 2)}\n`);
  return { checkout, root, seriesPath };
}

test("accepts the deliberate empty initial patch series without touching Git", async () => {
  const { applyPatchSeries } = await import("../scripts/lib/patch-series.mjs");
  const directory = await mkdtemp(join(tmpdir(), "chatero-empty-patches-"));
  temporaryDirectories.push(directory);
  const seriesPath = join(directory, "series.json");
  await writeFile(seriesPath, '{"schemaVersion":1,"patches":[]}\n');

  const result = await applyPatchSeries({
    checkout: join(directory, "missing-checkout-is-not-needed"),
    seriesPath,
  });

  assert.deepEqual(result, { applied: [] });
});

test("applies a verified series in declared order", async () => {
  const { applyPatchSeries } = await import("../scripts/lib/patch-series.mjs");
  const { checkout, seriesPath } = await createPatchFixture();

  const result = await applyPatchSeries({ checkout, seriesPath });

  assert.deepEqual(result, { applied: ["0001-a.patch", "0002-b.patch"] });
  assert.equal(await readFile(join(checkout, "a.txt"), "utf8"), "two\n");
  assert.equal(await readFile(join(checkout, "b.txt"), "utf8"), "three\n");
});

test("checks every patch before applying the first one", async () => {
  const { applyPatchSeries } = await import("../scripts/lib/patch-series.mjs");
  const { checkout, seriesPath } = await createPatchFixture({ invalidSecond: true });

  await assert.rejects(
    applyPatchSeries({ checkout, seriesPath }),
    /0002-b\.patch failed git apply preflight/
  );

  assert.equal(await readFile(join(checkout, "a.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(checkout, "b.txt"), "utf8"), "one\n");
  assert.equal(await git(checkout, "status", "--porcelain=v1"), "");
});

test("rejects a digest mismatch before running Git", async () => {
  const { applyPatchSeries } = await import("../scripts/lib/patch-series.mjs");
  const { checkout, seriesPath } = await createPatchFixture();
  const series = JSON.parse(await readFile(seriesPath, "utf8"));
  series.patches[0].sha256 = "0".repeat(64);
  await writeFile(seriesPath, `${JSON.stringify(series, null, 2)}\n`);

  await assert.rejects(
    applyPatchSeries({
      checkout,
      seriesPath,
      runGit: async () => assert.fail("digest mismatch must fail before invoking Git"),
    }),
    /SHA-256 mismatch for 0001-a\.patch/
  );
  assert.equal(await readFile(join(checkout, "a.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(checkout, "b.txt"), "utf8"), "one\n");
});

test("rejects traversal, absolute paths, duplicate files, and unknown fields", async () => {
  const { applyPatchSeries } = await import("../scripts/lib/patch-series.mjs");
  const directory = await mkdtemp(join(tmpdir(), "chatero-unsafe-patches-"));
  temporaryDirectories.push(directory);
  const digest = "0".repeat(64);
  const cases = [
    { patches: [{ file: "../escape.patch", sha256: digest }], message: /unsafe patch path/ },
    { patches: [{ file: "/tmp/escape.patch", sha256: digest }], message: /unsafe patch path/ },
    { patches: [{ file: "a.patch", sha256: digest }, { file: "a.patch", sha256: digest }], message: /duplicate patch file/ },
    { patches: [{ file: "a.patch", sha256: digest, command: "echo unsafe" }], message: /unknown field patches\[0\]\.command/ },
  ];

  for (const [index, value] of cases.entries()) {
    const seriesPath = join(directory, `series-${index}.json`);
    await writeFile(seriesPath, JSON.stringify({ schemaVersion: 1, patches: value.patches }));
    await assert.rejects(
      applyPatchSeries({ checkout: directory, seriesPath }),
      value.message
    );
  }
});
