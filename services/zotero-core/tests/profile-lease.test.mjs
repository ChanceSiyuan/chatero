import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    force: true,
    recursive: true,
  })));
});

async function profileDirectory() {
  const root = await mkdtemp(join(tmpdir(), "chatero-profile-lease-"));
  temporaryDirectories.push(root);
  const profile = join(root, "profile");
  await mkdir(profile, { mode: 0o700 });
  return { profile, root };
}

test("acquires one owner-only profile lease and refuses a live second owner", async () => {
  const { acquireProfileLease } = await import("../profile/profile-lease.mjs");
  const { profile } = await profileDirectory();
  const options = {
    profileDirectory: profile,
    pid: 100,
    processStartIdentity: "process-100-start",
    epoch: "epoch-1",
    nonce: "nonce-owner-one",
    now: () => 1234,
    isProcessAlive: async () => true,
  };
  const lease = await acquireProfileLease(options);
  const lockPath = join(profile, ".chatero-core.lock");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));

  assert.deepEqual(lock, {
    createdAt: 1234,
    epoch: "epoch-1",
    nonce: "nonce-owner-one",
    pid: 100,
    processStartIdentity: "process-100-start",
    schemaVersion: 1,
  });
  assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
  await assert.rejects(acquireProfileLease({ ...options, nonce: "nonce-owner-two" }), /live Chatero Core owner/);
  assert.equal(await lease.release(), true);
  assert.equal(await lease.release(), false);
  await assert.rejects(lstat(lockPath), /ENOENT/);
});

test("reclaims only a recognized stale lease", async () => {
  const { acquireProfileLease } = await import("../profile/profile-lease.mjs");
  const { profile } = await profileDirectory();
  const lockPath = join(profile, ".chatero-core.lock");
  await writeFile(lockPath, `${JSON.stringify({
    createdAt: 1,
    epoch: "old-epoch",
    nonce: "old-owner-nonce",
    pid: 99,
    processStartIdentity: "old-process",
    schemaVersion: 1,
  })}\n`, { mode: 0o600 });

  const lease = await acquireProfileLease({
    profileDirectory: profile,
    pid: 100,
    processStartIdentity: "new-process",
    epoch: "new-epoch",
    nonce: "new-owner-nonce",
    isProcessAlive: async () => false,
  });

  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).nonce, "new-owner-nonce");
  assert.equal(await lease.release(), true);
});

test("rejects symlinked profiles, symlinked locks, and unrecognized locks", async () => {
  const { acquireProfileLease } = await import("../profile/profile-lease.mjs");
  const { profile, root } = await profileDirectory();
  const linkedProfile = join(root, "linked-profile");
  await symlink(profile, linkedProfile);
  const options = {
    profileDirectory: linkedProfile,
    pid: 100,
    processStartIdentity: "process",
    epoch: "epoch",
    nonce: "owner-nonce-value",
    isProcessAlive: async () => false,
  };
  await assert.rejects(acquireProfileLease(options), /real directory/);

  const lockPath = join(profile, ".chatero-core.lock");
  const target = join(root, "target");
  await writeFile(target, "do not touch\n");
  await symlink(target, lockPath);
  await assert.rejects(acquireProfileLease({ ...options, profileDirectory: profile }), /regular file/);
  assert.equal(await readFile(target, "utf8"), "do not touch\n");
  await rm(lockPath);
  await writeFile(lockPath, "not-json\n");
  await assert.rejects(acquireProfileLease({ ...options, profileDirectory: profile }), /unrecognized profile lease/);
  assert.equal(await readFile(lockPath, "utf8"), "not-json\n");
});

test("release preserves a lock replaced by another owner", async () => {
  const { acquireProfileLease } = await import("../profile/profile-lease.mjs");
  const { profile } = await profileDirectory();
  const lease = await acquireProfileLease({
    profileDirectory: profile,
    pid: 100,
    processStartIdentity: "process",
    epoch: "epoch",
    nonce: "owner-nonce-value",
    isProcessAlive: async () => false,
  });
  const lockPath = join(profile, ".chatero-core.lock");
  await chmod(lockPath, 0o600);
  await writeFile(lockPath, `${JSON.stringify({
    createdAt: 2,
    epoch: "other-epoch",
    nonce: "other-owner-value",
    pid: 101,
    processStartIdentity: "other-process",
    schemaVersion: 1,
  })}\n`);

  assert.equal(await lease.release(), false);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).nonce, "other-owner-value");
});
