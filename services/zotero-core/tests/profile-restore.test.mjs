import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { acquireProfileLease } from "../profile/profile-lease.mjs";
import { restoreProfileDatabase } from "../profile/profile-restore.mjs";

const sqlite = marker => Buffer.concat([Buffer.from("SQLite format 3\0", "binary"), Buffer.from(marker)]);

test("restores a verified Core backup offline and preserves rollback files", async t => {
  const root = await mkdtemp(join(tmpdir(), "chatero-profile-restore-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const profile = join(root, "profile");
  await mkdir(profile);
  await writeFile(join(profile, "zotero.sqlite"), sqlite("current"));
  await writeFile(join(profile, "zotero.sqlite-wal"), "wal");
  await writeFile(join(profile, "zotero.sqlite.chatero-core.bak"), sqlite("backup"));

  assert.deepEqual(await restoreProfileDatabase({ profileDirectory: profile }), {
    databaseRestored: true,
    recoveryCreated: true,
  });
  assert.deepEqual(await readFile(join(profile, "zotero.sqlite")), sqlite("backup"));
  const names = await import("node:fs/promises").then(fs => fs.readdir(profile));
  assert.equal(names.some(name => name.includes("pre-restore") && name.endsWith(".bak")), true);
  assert.equal(names.some(name => name.includes("pre-restore") && name.endsWith(".bak-wal")), true);
});

test("fails closed for an invalid backup or a live profile owner", async t => {
  const root = await mkdtemp(join(tmpdir(), "chatero-profile-restore-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const profile = join(root, "profile");
  await mkdir(profile);
  await writeFile(join(profile, "zotero.sqlite.chatero-core.bak"), "not sqlite");
  await assert.rejects(restoreProfileDatabase({ profileDirectory: profile }), /not a SQLite/);
  await writeFile(join(profile, "zotero.sqlite.chatero-core.bak"), sqlite("backup"));
  const lease = await acquireProfileLease({ profileDirectory: profile, epoch: "live-owner" });
  t.after(() => lease.release());
  await assert.rejects(restoreProfileDatabase({ profileDirectory: profile }), /live Chatero Core owner/);
});
