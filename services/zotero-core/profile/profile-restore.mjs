import { constants } from "node:fs";
import { copyFile, lstat, open, rename, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { acquireProfileLease } from "./profile-lease.mjs";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");

async function regularFile(path, label, optional = false) {
  const metadata = await lstat(path).catch(error => error?.code === "ENOENT" && optional ? null : Promise.reject(error));
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return metadata;
}

async function verifySQLite(path) {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length || !bytes.equals(SQLITE_HEADER)) throw new Error("profile backup is not a SQLite database");
  }
  finally { await handle.close(); }
}

export async function restoreProfileDatabase({
  backupName = "zotero.sqlite.chatero-core.bak",
  epoch = `restore-${randomUUID()}`,
  profileDirectory,
} = {}) {
  const profile = resolve(profileDirectory || "");
  const metadata = await lstat(profile);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("restore profile must be a real directory");
  if (basename(backupName) !== backupName || !/^zotero\.sqlite\.[A-Za-z0-9-]+\.bak$/.test(backupName)) {
    throw new Error("restore backupName is invalid");
  }
  const lease = await acquireProfileLease({ profileDirectory: profile, epoch });
  const nonce = randomUUID();
  const database = join(profile, "zotero.sqlite");
  const backup = join(profile, backupName);
  const staged = join(profile, `.zotero.sqlite.restore-${nonce}.tmp`);
  const recovery = join(profile, `zotero.sqlite.pre-restore-${nonce}.bak`);
  let databaseMoved = false;
  let committed = false;
  const movedJournals = [];
  try {
    await regularFile(backup, "profile backup");
    await verifySQLite(backup);
    const current = await regularFile(database, "profile database", true);
    await copyFile(backup, staged, constants.COPYFILE_EXCL);
    await verifySQLite(staged);
    if (current) {
      await rename(database, recovery);
      databaseMoved = true;
    }
    for (const suffix of ["-wal", "-shm"]) {
      const journal = `${database}${suffix}`;
      if (await regularFile(journal, `profile ${suffix} journal`, true)) {
        const destination = `${recovery}${suffix}`;
        await rename(journal, destination);
        movedJournals.push([destination, journal]);
      }
    }
    await rename(staged, database);
    committed = true;
    return Object.freeze({ databaseRestored: true, recoveryCreated: databaseMoved });
  }
  catch (error) {
    if (!committed) {
      for (const [from, to] of movedJournals.reverse()) await rename(from, to).catch(() => {});
      if (databaseMoved) await rename(recovery, database).catch(() => {});
      await unlink(staged).catch(candidate => { if (candidate?.code !== "ENOENT") throw candidate; });
    }
    throw error;
  }
  finally {
    await lease.release();
  }
}
