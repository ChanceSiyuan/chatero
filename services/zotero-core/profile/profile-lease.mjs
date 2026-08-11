import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const LOCK_FILE = ".chatero-core.lock";
const LOCK_FIELDS = new Set([
  "createdAt",
  "epoch",
  "nonce",
  "pid",
  "processStartIdentity",
  "schemaVersion",
]);
const MAX_LOCK_BYTES = 16 * 1024;

function defaultNonce() {
  return randomBytes(24).toString("base64url");
}

async function processStartIdentity(pid) {
  try {
    const { stdout } = await execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    });
    const value = stdout.trim();
    return value || null;
  }
  catch {
    return null;
  }
}

async function defaultIsProcessAlive(pid, expectedIdentity) {
  const actualIdentity = await processStartIdentity(pid);
  return actualIdentity !== null && actualIdentity === expectedIdentity;
}

function validateLock(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unrecognized profile lease: lock must be an object");
  }
  const fields = Object.keys(value);
  if (fields.length !== LOCK_FIELDS.size || fields.some(field => !LOCK_FIELDS.has(field))) {
    throw new Error("unrecognized profile lease: lock fields do not match schema 1");
  }
  if (value.schemaVersion !== 1
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || typeof value.processStartIdentity !== "string" || value.processStartIdentity.length === 0
    || typeof value.epoch !== "string" || value.epoch.length === 0
    || typeof value.nonce !== "string" || value.nonce.length < 8) {
    throw new Error("unrecognized profile lease: lock values are invalid");
  }
  return value;
}

async function assertRealDirectory(path) {
  const metadata = await lstat(path).catch(error => {
    if (error?.code === "ENOENT") throw new Error(`Zotero profile does not exist: ${path}`);
    throw error;
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Zotero profile must be a real directory: ${path}`);
  }
}

async function readExistingLock(lockPath) {
  const metadata = await lstat(lockPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_LOCK_BYTES) {
    throw new Error(`profile lease must be a small regular file: ${lockPath}`);
  }
  try {
    return validateLock(JSON.parse(await readFile(lockPath, "utf8")));
  }
  catch (error) {
    if (/unrecognized profile lease/.test(error.message)) throw error;
    throw new Error(`unrecognized profile lease: ${error.message}`);
  }
}

async function createLock(lockPath, contents) {
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(contents)}\n`, "utf8");
    await handle.sync();
  }
  finally {
    await handle?.close();
  }
}

export async function acquireProfileLease({
  profileDirectory,
  pid = process.pid,
  processStartIdentity: suppliedProcessStartIdentity,
  epoch,
  nonce = defaultNonce(),
  now = Date.now,
  isProcessAlive = defaultIsProcessAlive,
} = {}) {
  const profile = resolve(profileDirectory);
  await assertRealDirectory(profile);
  const identity = suppliedProcessStartIdentity || await processStartIdentity(pid);
  if (typeof identity !== "string" || identity.length === 0) {
    throw new Error("could not establish the Chatero Core process start identity");
  }
  const contents = validateLock({
    createdAt: now(),
    epoch,
    nonce,
    pid,
    processStartIdentity: identity,
    schemaVersion: 1,
  });
  const lockPath = join(profile, LOCK_FILE);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await createLock(lockPath, contents);
      break;
    }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readExistingLock(lockPath);
      if (await isProcessAlive(existing.pid, existing.processStartIdentity)) {
        throw new Error(`Zotero profile already has a live Chatero Core owner (pid ${existing.pid})`);
      }
      if (attempt > 0) throw new Error("could not acquire Zotero profile lease after a concurrent owner change");
      await unlink(lockPath);
    }
  }

  let released = false;
  return Object.freeze({
    epoch,
    lockPath,
    nonce,
    async release() {
      if (released) return false;
      released = true;
      let existing;
      try {
        existing = await readExistingLock(lockPath);
      }
      catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
      if (existing.nonce !== nonce) return false;
      await unlink(lockPath);
      return true;
    },
  });
}
