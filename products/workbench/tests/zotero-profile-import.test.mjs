import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chatero-profile-import-"));
  temporaryDirectories.push(root);
  const sourceProfile = join(root, "source-profile");
  const sourceData = join(root, "source-data");
  const destinationRoot = join(root, "chatero", "Profiles");
  await mkdir(join(sourceProfile, "storage"), { recursive: true });
  await mkdir(join(sourceData, "storage", "ITEM0001"), { recursive: true });
  await writeFile(join(sourceProfile, "prefs.js"), "user_pref(\"safe\", true);\n");
  await writeFile(join(sourceData, "zotero.sqlite"), Buffer.concat([Buffer.from("SQLite format 3\0", "binary"), Buffer.alloc(64)]));
  await writeFile(join(sourceData, "storage", "ITEM0001", "paper.pdf"), "pdf bytes");
  return { destinationRoot, root, sourceData, sourceProfile };
}

test("atomically imports a private Chatero profile and never mutates the Zotero source", async () => {
  const { importZoteroProfile } = await import("../../../services/zotero-core/profile/profile-import.mjs");
  const input = await fixture();
  const originalProfile = await readFile(join(input.sourceProfile, "prefs.js"));
  const originalDatabase = await readFile(join(input.sourceData, "zotero.sqlite"));
  const result = await importZoteroProfile({
    ...input,
    isSourceOwned: async () => false,
    now: () => 1_786_665_600_000,
    randomId: () => "01234567-89ab-4cde-8fab-0123456789ab",
    spaceAvailable: async () => 2 ** 40,
  });

  assert.match(result.profileDirectory, /\/Profiles\/research-20260814-01234567$/u);
  assert.equal(await readFile(join(result.profileDirectory, "prefs.js"), "utf8"), "user_pref(\"safe\", true);\n");
  assert.deepEqual(await readFile(join(result.profileDirectory, "zotero", "zotero.sqlite")), originalDatabase);
  assert.equal(await readFile(join(result.profileDirectory, "zotero", "storage", "ITEM0001", "paper.pdf"), "utf8"), "pdf bytes");
  assert.deepEqual(await readFile(join(input.sourceProfile, "prefs.js")), originalProfile);
  assert.deepEqual(await readFile(join(input.sourceData, "zotero.sqlite")), originalDatabase);
  const receipt = JSON.parse(await readFile(join(result.profileDirectory, ".chatero-import.json"), "utf8"));
  assert.equal(receipt.status, "imported");
  assert.equal(receipt.sourceProfileDigest.length, 64);
  assert.equal(JSON.stringify(receipt).includes(input.root), false);
  assert.deepEqual((await readdir(input.destinationRoot)).filter(name => name.startsWith(".")), []);
});

test("fails before copying when Zotero owns the source or disk space is insufficient", async () => {
  const { importZoteroProfile } = await import("../../../services/zotero-core/profile/profile-import.mjs");
  for (const variation of [
    { isSourceOwned: async () => true, spaceAvailable: async () => 2 ** 40, message: /close Zotero/iu },
    { isSourceOwned: async () => false, spaceAvailable: async () => 1, message: /disk space/iu },
  ]) {
    const input = await fixture();
    await assert.rejects(importZoteroProfile({
      ...input,
      isSourceOwned: variation.isSourceOwned,
      randomId: () => "01234567-89ab-4cde-8fab-0123456789ab",
      spaceAvailable: variation.spaceAvailable,
    }), variation.message);
    assert.equal(await stat(input.destinationRoot).then(() => true).catch(() => false), false);
  }
});

test("rejects symlinked source content and removes only its owned staging directory", async () => {
  const { importZoteroProfile } = await import("../../../services/zotero-core/profile/profile-import.mjs");
  const input = await fixture();
  await symlink(join(input.sourceData, "zotero.sqlite"), join(input.sourceData, "linked.sqlite"));
  await assert.rejects(importZoteroProfile({
    ...input,
    isSourceOwned: async () => false,
    randomId: () => "01234567-89ab-4cde-8fab-0123456789ab",
    spaceAvailable: async () => 2 ** 40,
  }), /symbolic link/iu);
  assert.deepEqual(await readdir(input.destinationRoot).catch(error => error?.code === "ENOENT" ? [] : Promise.reject(error)), []);
});

test("detects native profile locks and open Zotero databases without reading their contents", async () => {
  const { isZoteroSourceOwned } = await import("../../../services/zotero-core/profile/profile-import.mjs");
  const input = await fixture();
  assert.equal(await isZoteroSourceOwned({
    ...input,
    inspect: async path => path.endsWith(".parentlock") ? { isSymbolicLink: () => true } : null,
    listOpen: async () => "",
  }), true);
  assert.equal(await isZoteroSourceOwned({
    ...input,
    inspect: async () => null,
    listOpen: async (file, args) => {
      assert.equal(file, "/usr/sbin/lsof");
      assert.deepEqual(args, ["-F", "p", "--", join(input.sourceData, "zotero.sqlite")]);
      return "p1234\n";
    },
  }), true);
  assert.equal(await isZoteroSourceOwned({
    ...input,
    inspect: async () => null,
    listOpen: async () => "",
  }), false);
});

test("a staging-name collision never removes or changes pre-existing bytes", async () => {
  const { importZoteroProfile } = await import("../../../services/zotero-core/profile/profile-import.mjs");
  const input = await fixture();
  const collision = join(input.destinationRoot, ".research-20260814-01234567.staging");
  await mkdir(collision, { recursive: true });
  await writeFile(join(collision, "owner.txt"), "not Chatero import state");
  await assert.rejects(importZoteroProfile({
    ...input,
    isSourceOwned: async () => false,
    now: () => 1_786_665_600_000,
    randomId: () => "01234567-89ab-4cde-8fab-0123456789ab",
    spaceAvailable: async () => 2 ** 40,
  }), /exist/iu);
  assert.equal(await readFile(join(collision, "owner.txt"), "utf8"), "not Chatero import state");
});
