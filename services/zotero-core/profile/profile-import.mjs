import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { cp, lstat, mkdir, open, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const RECEIPT = ".chatero-import.json";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");
const MIN_FREE_AFTER_IMPORT = 512 * 1024 * 1024;
const execFile = promisify(execFileCallback);

async function defaultListOpen(file, args) {
  try { return (await execFile(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024 })).stdout; }
  catch (error) {
    if (error?.code === 1 || error?.code === "ENOENT") return "";
    throw error;
  }
}

export async function isZoteroSourceOwned({ sourceData, sourceProfile, inspect = lstat, listOpen = defaultListOpen } = {}) {
  if (![sourceData, sourceProfile].every(value => typeof value === "string" && resolve(value) === value)
      || typeof inspect !== "function" || typeof listOpen !== "function") {
    throw new TypeError("Zotero source ownership check is invalid");
  }
  for (const name of [".parentlock", "parent.lock", ".parent.lock", "lock"]) {
    const metadata = await inspect(join(sourceProfile, name)).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (metadata) return true;
  }
  const output = await listOpen("/usr/sbin/lsof", ["-F", "p", "--", join(sourceData, "zotero.sqlite")]);
  return /^p[1-9][0-9]*$/mu.test(output);
}

async function inspectTree(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error("Zotero source contains a symbolic link");
  if (metadata.isFile()) return { bytes: metadata.size, files: 1 };
  if (!metadata.isDirectory()) throw new Error("Zotero source contains an unsupported filesystem entry");
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(path)) {
    const result = await inspectTree(join(path, entry));
    bytes += result.bytes;
    files += result.files;
    if (!Number.isSafeInteger(bytes) || files > 1_000_000) throw new Error("Zotero source exceeds the import safety limit");
  }
  return { bytes, files };
}

async function digestTree(path) {
  const hash = createHash("sha256");
  async function visit(current, relative = "") {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error("Zotero source contains a symbolic link");
    if (metadata.isFile()) {
      hash.update(`f\0${relative}\0${metadata.size}\0`);
      const handle = await open(current, "r");
      try {
        for await (const chunk of handle.createReadStream()) hash.update(chunk);
      }
      finally { await handle.close(); }
      return;
    }
    if (!metadata.isDirectory()) throw new Error("Zotero source contains an unsupported filesystem entry");
    hash.update(`d\0${relative}\0`);
    for (const entry of (await readdir(current)).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
      await visit(join(current, entry), relative ? `${relative}/${entry}` : entry);
    }
  }
  await visit(path);
  return hash.digest("hex");
}

async function sqliteDatabase(path) {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead === bytes.length && bytes.equals(SQLITE_HEADER);
  }
  finally { await handle.close(); }
}

async function defaultSpaceAvailable(path) {
  const values = await statfs(path);
  return values.bavail * values.bsize;
}

async function existingAncestor(path) {
  let candidate = resolve(path);
  while (!await lstat(candidate).then(() => true).catch(error => error?.code === "ENOENT" ? false : Promise.reject(error))) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("no existing destination ancestor is available");
    candidate = parent;
  }
  return candidate;
}

export async function importZoteroProfile({
  destinationRoot,
  isSourceOwned,
  name = "research",
  now = Date.now,
  randomId = randomUUID,
  sourceData,
  sourceProfile,
  spaceAvailable = defaultSpaceAvailable,
} = {}) {
  if (![destinationRoot, sourceData, sourceProfile].every(value => typeof value === "string" && resolve(value) === value)
      || typeof isSourceOwned !== "function" || typeof now !== "function" || typeof randomId !== "function"
      || typeof spaceAvailable !== "function") {
    throw new TypeError("Zotero profile import configuration is invalid");
  }
  const profileMetadata = await lstat(sourceProfile);
  const dataMetadata = await lstat(sourceData);
  if (!profileMetadata.isDirectory() || profileMetadata.isSymbolicLink()
      || !dataMetadata.isDirectory() || dataMetadata.isSymbolicLink()) {
    throw new Error("Zotero source profile and data must be real directories");
  }
  if (await isSourceOwned({ sourceData, sourceProfile })) throw new Error("Close Zotero before importing this profile into Chatero");
  if (!await sqliteDatabase(join(sourceData, "zotero.sqlite")).catch(() => false)) {
    throw new Error("Zotero source data has no valid zotero.sqlite database");
  }
  const [profileSummary, dataSummary] = await Promise.all([inspectTree(sourceProfile), inspectTree(sourceData)]);
  const requiredBytes = Math.ceil((profileSummary.bytes + dataSummary.bytes) * 1.1) + MIN_FREE_AFTER_IMPORT;
  const existingParent = await existingAncestor(destinationRoot);
  if (await spaceAvailable(existingParent) < requiredBytes) throw new Error("Insufficient disk space to import the Zotero profile safely");

  const id = randomId();
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(id)) throw new Error("profile import random identity is invalid");
  const date = new Date(now()).toISOString().slice(0, 10).replaceAll("-", "");
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 32) || "profile";
  const leaf = `${safeName}-${date}-${id.slice(0, 8).toLowerCase()}`;
  const staging = join(destinationRoot, `.${leaf}.staging`);
  const destination = join(destinationRoot, leaf);
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  let stagingOwned = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    stagingOwned = true;
    await cp(sourceProfile, staging, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    const sourceProfileDigest = await digestTree(sourceProfile);
    const copiedProfileDigest = await digestTree(staging);
    if (sourceProfileDigest !== copiedProfileDigest) throw new Error("imported Zotero profile digest does not match its source");
    const dataDestination = join(staging, "zotero");
    await cp(sourceData, dataDestination, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    const [sourceDataDigest, copiedDataDigest] = await Promise.all([
      digestTree(sourceData), digestTree(dataDestination),
    ]);
    if (sourceDataDigest !== copiedDataDigest) throw new Error("imported Zotero data digest does not match its source");
    if (await isSourceOwned({ sourceData, sourceProfile })) throw new Error("Close Zotero before completing this profile import into Chatero");
    const receipt = Object.freeze({
      copiedDataDigest,
      importedAt: new Date(now()).toISOString(),
      schemaVersion: 1,
      sourceDataDigest,
      sourceProfileDigest,
      status: "imported",
    });
    await writeFile(join(staging, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(staging, destination);
    return Object.freeze({ profileDirectory: destination, sourceProfileDigest });
  }
  catch (error) {
    if (stagingOwned) await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
