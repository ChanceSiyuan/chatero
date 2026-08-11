#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/u;
const TRANSFER_ID = /^[0-9a-f]{32}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const TTL_SECONDS = 86400;
const MAX_LINE_BYTES = 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;
const MAX_ENTRIES = 20_000;

class HelperError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new HelperError(`${label}-shape`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new HelperError(`${label}-fields`);
  }
}

function parseCanonicalJson(line, label) {
  if (!line || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    throw new HelperError(`${label}-size`);
  }
  let value;
  try { value = JSON.parse(line); }
  catch (_) { throw new HelperError(`${label}-json`); }
  if (JSON.stringify(value) !== line) throw new HelperError(`${label}-canonical`);
  return value;
}

function emit(value) {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new HelperError("output-size");
  process.stdout.write(line);
}

function validateDigest(value) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new HelperError("digest");
  return value;
}

function validateTransferId(value) {
  if (typeof value !== "string" || !TRANSFER_ID.test(value)) throw new HelperError("transfer-id");
  return value;
}

function validateSize(value) {
  if (!Number.isSafeInteger(value) || value < 1 || !DECIMAL.test(String(value))) {
    throw new HelperError("size");
  }
  return value;
}

function validateFirstRequest(value) {
  if (value?.operation === "stage") {
    exactKeys(value, ["protocolVersion", "operation", "digest", "size", "transferId", "ttlSeconds"], "stage");
    if (value.protocolVersion !== 1 || value.ttlSeconds !== TTL_SECONDS) throw new HelperError("stage-version");
    return Object.freeze({
      protocolVersion: 1,
      operation: "stage",
      digest: validateDigest(value.digest),
      size: validateSize(value.size),
      transferId: validateTransferId(value.transferId),
      ttlSeconds: TTL_SECONDS,
    });
  }
  if (value?.operation === "revoke") {
    exactKeys(value, ["protocolVersion", "operation", "digest"], "revoke");
    if (value.protocolVersion !== 1) throw new HelperError("revoke-version");
    return Object.freeze({ protocolVersion: 1, operation: "revoke", digest: validateDigest(value.digest) });
  }
  if (value?.operation === "cleanup") {
    exactKeys(value, ["protocolVersion", "operation"], "cleanup");
    if (value.protocolVersion !== 1) throw new HelperError("cleanup-version");
    return Object.freeze({ protocolVersion: 1, operation: "cleanup" });
  }
  throw new HelperError("operation");
}

async function ensureDirectory(path, { create = true, ownerOnly = false } = {}) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || metadata.uid !== process.getuid()) throw new HelperError("unsafe-directory");
  }
  catch (error) {
    if (error?.code !== "ENOENT" || !create) throw error;
    try { await mkdir(path, { mode: 0o700 }); }
    catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") throw mkdirError;
    }
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || metadata.uid !== process.getuid()
      || ownerOnly && (metadata.mode & 0o777) !== 0o700
      || await realpath(path) !== path) {
    throw new HelperError("unsafe-directory");
  }
}

async function evidenceRoot() {
  const home = process.env.HOME;
  if (typeof home !== "string" || !isAbsolute(home) || normalize(home) !== home
      || /[\0\r\n]/u.test(home) || Buffer.byteLength(home, "utf8") > 2048) {
    throw new HelperError("home");
  }
  await ensureDirectory(home, { create: false });
  const cache = join(home, ".cache");
  await ensureDirectory(cache);
  const chatero = join(cache, "chatero");
  await ensureDirectory(chatero, { ownerOnly: true });
  const root = join(chatero, "evidence");
  await ensureDirectory(root, { ownerOnly: true });
  return root;
}

async function safeRegular(path, { allowMissing = false, mode = 0o600 } = {}) {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== process.getuid()) throw new HelperError("unsafe-file");
  if ((metadata.mode & 0o777) !== mode) throw new HelperError("unsafe-file-mode");
  return metadata;
}

async function readSafeFile(path, maximumBytes) {
  const metadata = await safeRegular(path);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || metadata.size > maximumBytes) {
    throw new HelperError("file-size");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== process.getuid()
        || opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size) {
      throw new HelperError("unsafe-file");
    }
    return await handle.readFile();
  }
  finally { await handle.close(); }
}

async function safeUnlink(path) {
  const metadata = await safeRegular(path, { allowMissing: true });
  if (metadata) await unlink(path);
  return Boolean(metadata);
}

function names(root, digest, transferId, generation) {
  return Object.freeze({
    final: generation ? join(root, `${digest}.${generation}.pdf`) : null,
    generation: join(root, `${digest}.generation`),
    lock: join(root, `${digest}.lock`),
    meta: generation ? join(root, `${digest}.${generation}.meta.json`) : null,
    part: transferId ? join(root, `${digest}.${transferId}.part`) : null,
    state: transferId ? join(root, `${digest}.${transferId}.state.json`) : null,
    revoked: transferId ? join(root, `${digest}.${transferId}.revoked`) : null,
  });
}

async function readGenerationToken(path, { allowMissing = false } = {}) {
  const metadata = await safeRegular(path, { allowMissing });
  if (!metadata) return null;
  if (metadata.size !== 64) throw new HelperError("generation");
  const token = (await readSafeFile(path, 64)).toString("utf8");
  if (!SHA256.test(token)) throw new HelperError("generation");
  return token;
}

async function ensureGenerationToken(root, digest) {
  const path = names(root, digest).generation;
  const existing = await readGenerationToken(path, { allowMissing: true });
  if (existing) return existing;
  const token = randomBytes(32).toString("hex");
  const candidate = `${path}.${token}.candidate`;
  await writeExclusive(candidate, Buffer.from(token, "utf8"));
  await rename(candidate, path);
  return token;
}

async function replaceGenerationToken(root, digest) {
  const path = names(root, digest).generation;
  await ensureGenerationToken(root, digest);
  const token = randomBytes(32).toString("hex");
  const candidate = `${path}.${token}.candidate`;
  await writeExclusive(candidate, Buffer.from(token, "utf8"));
  await rename(candidate, path);
  if (await readGenerationToken(path) !== token) throw new HelperError("generation");
  return token;
}

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const LOCK_NONCE = /^[0-9a-f]{32}$/u;
let localProcessIdentityPromise;

async function processStatus(pid) {
  const value = await readFile(`/proc/${pid}/stat`, "utf8");
  const end = value.lastIndexOf(")");
  if (end < 1) throw new HelperError("lock-owner");
  const fields = value.slice(end + 2).trim().split(/ +/u);
  const state = fields[0];
  const startTime = fields[19];
  if (typeof state !== "string" || state.length !== 1 || !DECIMAL.test(startTime ?? "")) {
    throw new HelperError("lock-owner");
  }
  return Object.freeze({ startTime, state });
}

async function localProcessIdentity() {
  if (!localProcessIdentityPromise) {
    localProcessIdentityPromise = Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      processStatus(process.pid),
    ]).then(([bootId, status]) => {
      const canonicalBootId = bootId.trim().toLowerCase();
      if (!BOOT_ID.test(canonicalBootId)) throw new HelperError("lock-owner");
      return Object.freeze({
        bootId: canonicalBootId,
        nonce: randomBytes(16).toString("hex"),
        pid: process.pid,
        startTime: status.startTime,
      });
    });
  }
  return localProcessIdentityPromise;
}

function validateLockOwner(value) {
  exactKeys(value, ["bootId", "nonce", "pid", "startTime"], "lock-owner");
  if (!BOOT_ID.test(value.bootId) || !LOCK_NONCE.test(value.nonce)
      || !Number.isSafeInteger(value.pid) || value.pid < 1
      || typeof value.startTime !== "string" || !DECIMAL.test(value.startTime)) {
    throw new HelperError("lock-owner");
  }
  return Object.freeze(value);
}

async function readLockOwner(path, expectedMetadata) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid() || metadata.nlink !== 2
        || (metadata.mode & 0o777) !== 0o600 || metadata.size > 1024
        || metadata.dev !== expectedMetadata.dev || metadata.ino !== expectedMetadata.ino) {
      throw new HelperError("unsafe-lock");
    }
    const text = (await handle.readFile()).toString("utf8");
    return validateLockOwner(parseCanonicalJson(text, "lock-owner"));
  }
  finally { await handle.close(); }
}

async function processIdentityIsAlive(identity) {
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().toLowerCase();
  if (bootId !== identity.bootId) return false;
  try {
    const status = await processStatus(identity.pid);
    return status.state !== "Z" && status.startTime === identity.startTime;
  }
  catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return false;
    throw error;
  }
}

function assertLockKey(key) {
  if (!/^[0-9a-f]{64}(?:\.[0-9a-f]{32}\.transfer)?$/u.test(key)) {
    throw new HelperError("lock-key");
  }
  return key;
}

function lockPath(root, key) {
  return join(root, `${assertLockKey(key)}.lock`);
}

function ownerCompanion(root, key, nonce) {
  return join(root, `${assertLockKey(key)}.lock.${nonce}.owner`);
}

function claimCompanion(root, key, originalNonce, claimant) {
  return join(root, [
    assertLockKey(key),
    "lock",
    originalNonce,
    "claim",
    claimant.bootId,
    String(claimant.pid),
    claimant.startTime,
    claimant.nonce,
  ].join("."));
}

function parseClaimant(entry, key, originalNonce) {
  const prefix = `${assertLockKey(key)}.lock.${originalNonce}.claim.`;
  if (!entry.startsWith(prefix)) return null;
  const fields = entry.slice(prefix.length).split(".");
  if (fields.length !== 4) return null;
  const pid = Number(fields[1]);
  try {
    return validateLockOwner({ bootId: fields[0], pid, startTime: fields[2], nonce: fields[3] });
  }
  catch (_) { return null; }
}

async function sameInode(path, expected) {
  try {
    const value = await lstat(path);
    return value.isFile() && !value.isSymbolicLink() && value.uid === process.getuid()
      && value.dev === expected.dev && value.ino === expected.ino && value.nlink === 2;
  }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function recoverDeadLock(root, key) {
  const fixed = lockPath(root, key);
  let metadata;
  try { metadata = await lstat(fixed); }
  catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
      || metadata.nlink !== 2 || (metadata.mode & 0o777) !== 0o600) {
    throw new HelperError("unsafe-lock");
  }
  const originalOwner = await readLockOwner(fixed, metadata);
  const ownerPath = ownerCompanion(root, key, originalOwner.nonce);
  let companion = await sameInode(ownerPath, metadata) ? ownerPath : null;
  let activeOwner = originalOwner;
  if (!companion) {
    const entries = await readdir(root);
    if (entries.length > MAX_ENTRIES) throw new HelperError("entry-limit");
    for (const entry of entries) {
      const claimant = parseClaimant(entry, key, originalOwner.nonce);
      if (!claimant) continue;
      const candidate = join(root, entry);
      if (await sameInode(candidate, metadata)) {
        if (companion) throw new HelperError("unsafe-lock");
        companion = candidate;
        activeOwner = claimant;
      }
    }
  }
  if (!companion) throw new HelperError("unsafe-lock");
  if (await processIdentityIsAlive(activeOwner)) return false;
  const claimant = await localProcessIdentity();
  const claimed = claimCompanion(root, key, originalOwner.nonce, claimant);
  try { await rename(companion, claimed); }
  catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  const fixedNow = await lstat(fixed).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  const claimNow = await lstat(claimed);
  if (!fixedNow || fixedNow.dev !== claimNow.dev || fixedNow.ino !== claimNow.ino
      || fixedNow.dev !== metadata.dev || fixedNow.ino !== metadata.ino) {
    throw new HelperError("unsafe-lock");
  }
  await unlink(fixed);
  await unlink(claimed);
  return true;
}

async function acquireDigestLock(root, key) {
  for (;;) {
    const identity = await localProcessIdentity();
    const owner = Object.freeze({ ...identity, nonce: randomBytes(16).toString("hex") });
    const companion = ownerCompanion(root, key, owner.nonce);
    await writeExclusive(companion, Buffer.from(JSON.stringify(owner), "utf8"));
    try {
      await link(companion, lockPath(root, key));
    }
    catch (error) {
      await unlink(companion).catch(unlinkError => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
      if (error?.code !== "EEXIST") throw error;
      if (!await recoverDeadLock(root, key)) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      continue;
    }
    // Once link succeeds the two-name inode is deliberately retained on every
    // subsequent failure so another helper can prove and recover a dead owner.
    const fixed = await lstat(lockPath(root, key));
    const owned = await lstat(companion);
    if (fixed.dev !== owned.dev || fixed.ino !== owned.ino || fixed.nlink !== 2 || owned.nlink !== 2) {
      throw new HelperError("unsafe-lock");
    }
    return Object.freeze({ companion, fixed: lockPath(root, key), key, metadata: fixed });
  }
}

async function releaseDigestLock(lock) {
  const fixed = await lstat(lock.fixed);
  const companion = await lstat(lock.companion);
  if (fixed.dev !== lock.metadata.dev || fixed.ino !== lock.metadata.ino
      || companion.dev !== fixed.dev || companion.ino !== fixed.ino || fixed.nlink !== 2) {
    throw new HelperError("unsafe-lock");
  }
  await unlink(lock.fixed);
  await unlink(lock.companion);
}

async function withDigestLock(root, key, callback) {
  const lock = await acquireDigestLock(root, key);
  try { return await callback(); }
  finally { await releaseDigestLock(lock); }
}

async function writeExclusive(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  }
  finally { await handle.close(); }
  await safeRegular(path);
}

async function readState(path) {
  const metadata = await safeRegular(path, { allowMissing: true });
  if (!metadata) return null;
  if (metadata.size > 1024) throw new HelperError("state-size");
  const text = (await readSafeFile(path, 1024)).toString("utf8");
  const value = parseCanonicalJson(text, "state");
  exactKeys(value, ["epoch", "instance", "size"], "state");
  if (typeof value.epoch !== "string" || !SHA256.test(value.epoch)
      || typeof value.instance !== "string" || !SHA256.test(value.instance)) {
    throw new HelperError("state-identity");
  }
  validateSize(value.size);
  return Object.freeze({ epoch: value.epoch, instance: value.instance, size: value.size });
}

function isInvalidStateError(error) {
  return error instanceof HelperError
    && /^(?:state-(?:size|json|canonical|shape|fields|identity)|size)$/u.test(error.code);
}

async function readStateForCleanup(path) {
  try { return await readState(path); }
  catch (error) {
    if (isInvalidStateError(error)) return null;
    throw error;
  }
}

async function hashFilePrefix(path) {
  const metadata = await safeRegular(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new HelperError("unsafe-file");
    }
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
      if (bytesRead < 1) throw new HelperError("part-read");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { hash, metadata: opened, offset: opened.size };
  }
  finally { await handle.close(); }
}

async function verifySafeDigest(path, expectedSize, expectedDigest) {
  const result = await hashFilePrefix(path);
  if (result.offset !== expectedSize || result.hash.digest("hex") !== expectedDigest) {
    throw new HelperError("digest-mismatch");
  }
  return result.metadata;
}

async function readMeta(path, digest, instance) {
  const metadata = await safeRegular(path, { allowMissing: true });
  if (!metadata) return null;
  if (metadata.size > 4096) throw new HelperError("meta-size");
  const text = (await readSafeFile(path, 4096)).toString("utf8");
  const value = parseCanonicalJson(text, "meta");
  exactKeys(value, ["createdAt", "digest", "epoch", "expiresAt", "instance", "size"], "meta");
  const createdAt = typeof value.createdAt === "string" ? Date.parse(value.createdAt) : Number.NaN;
  const expiresAt = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : Number.NaN;
  if (value.digest !== digest || !Number.isSafeInteger(value.size) || value.size < 1
      || typeof value.epoch !== "string" || !SHA256.test(value.epoch)
      || typeof value.instance !== "string" || !SHA256.test(value.instance)
      || instance && value.instance !== instance
      || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt)
      || new Date(createdAt).toISOString() !== value.createdAt
      || new Date(expiresAt).toISOString() !== value.expiresAt
      || expiresAt - createdAt !== TTL_SECONDS * 1000) {
    throw new HelperError("meta");
  }
  return Object.freeze(value);
}

function isInvalidMetadataError(error) {
  return error instanceof HelperError && /^(?:meta(?:-(?:size|json|canonical|shape|fields))?)$/u.test(error.code);
}

async function recoverInterruptedLink(paths, published) {
  let part;
  let final;
  try { part = await lstat(paths.part); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  try { final = await lstat(published.final); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (!part || !final || !part.isFile() || !final.isFile()
      || part.isSymbolicLink() || final.isSymbolicLink()
      || part.uid !== process.getuid() || final.uid !== process.getuid()
      || part.nlink !== 2 || final.nlink !== 2
      || part.dev !== final.dev || part.ino !== final.ino) return;
  // A crash between link(part, final) and unlink(part) is recognizable by the
  // two derived names sharing the same owner-only inode. Restore the part and
  // let the normal full-digest finalize path run again.
  await unlink(published.final);
  await safeRegular(paths.part);
}

async function writeTombstone(path) {
  if (await safeRegular(path, { allowMissing: true })) return;
  try { await writeExclusive(path, Buffer.from("revoked", "utf8")); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await safeRegular(path);
  }
}

async function prepareStage(root, request) {
  const lease = await acquireDigestLock(root, `${request.digest}.${request.transferId}.transfer`);
  let epoch;
  let instance;
  let paths;
  try {
    await withDigestLock(root, request.digest, async () => {
      paths = names(root, request.digest, request.transferId);
      if (await safeRegular(paths.revoked, { allowMissing: true })) throw new HelperError("revoked");
      const existingState = await readState(paths.state);
      const current = await ensureGenerationToken(root, request.digest);
      if (existingState) {
        if (existingState.epoch !== current || existingState.size !== request.size) {
          throw new HelperError("revoked");
        }
        epoch = existingState.epoch;
        instance = existingState.instance;
        await removeGeneration(root, request.digest, instance);
      }
      else {
        epoch = current;
        for (let attempt = 0; attempt < 8; attempt++) {
          const candidate = randomBytes(32).toString("hex");
          const published = names(root, request.digest, null, candidate);
          if (!await safeRegular(published.final, { allowMissing: true })
              && !await safeRegular(published.meta, { allowMissing: true })) {
            instance = candidate;
            break;
          }
        }
        if (!instance) throw new HelperError("instance-entropy");
        await writeExclusive(paths.state, Buffer.from(JSON.stringify({ epoch, instance, size: request.size }), "utf8"));
      }
      await recoverInterruptedLink(paths, names(root, request.digest, null, instance));
      if (!await safeRegular(paths.part, { allowMissing: true })) {
        await writeExclusive(paths.part, Buffer.alloc(0));
      }
    });
    const state = Object.freeze({ epoch, instance, size: request.size });
    const prefix = await hashFilePrefix(paths.part);
    if (prefix.offset > request.size) throw new HelperError("part-size");
    return { digest: request.digest, lease, paths, prefix, root, state };
  }
  catch (error) {
    await releaseDigestLock(lease).catch(() => {});
    throw error;
  }
}

async function releaseStageLease(stage) {
  if (!stage?.lease) return;
  const lease = stage.lease;
  stage.lease = null;
  await releaseDigestLock(lease);
}

async function abortStage(stage, { tombstone = false } = {}) {
  await safeUnlink(stage.paths.part);
  await safeUnlink(stage.paths.state);
  if (tombstone) await writeTombstone(stage.paths.revoked);
}

async function publishStage(root, request, stage) {
  if (await readGenerationToken(stage.paths.generation) !== stage.state.epoch
      || await safeRegular(stage.paths.revoked, { allowMissing: true })) {
    await abortStage(stage, { tombstone: true });
    throw new HelperError("revoked");
  }
  let verified;
  try { verified = await verifySafeDigest(stage.paths.part, request.size, request.digest); }
  catch (error) {
    if (await readGenerationToken(stage.paths.generation) !== stage.state.epoch
        || await safeRegular(stage.paths.revoked, { allowMissing: true })) {
      throw new HelperError("revoked");
    }
    throw error;
  }
  const published = names(root, request.digest, null, stage.state.instance);
  try {
    return await withDigestLock(root, request.digest, async () => {
      if (await readGenerationToken(stage.paths.generation) !== stage.state.epoch
          || await safeRegular(stage.paths.revoked, { allowMissing: true })) {
        throw new HelperError("revoked");
      }
      const current = await safeRegular(stage.paths.part);
      if (current.dev !== verified.dev || current.ino !== verified.ino
          || current.size !== verified.size || current.mtimeMs !== verified.mtimeMs
          || current.ctimeMs !== verified.ctimeMs) {
        throw new HelperError("digest-mismatch");
      }
      await recoverInterruptedLink(stage.paths, published);
      if (await safeRegular(published.meta, { allowMissing: true })
          || await safeRegular(published.final, { allowMissing: true })) {
        throw new HelperError("publish-exists");
      }
      let publishedInode = null;
      let metadataPublished = false;
      let linkCreated = false;
      try {
        await link(stage.paths.part, published.final);
        linkCreated = true;
        const part = await lstat(stage.paths.part);
        const final = await lstat(published.final);
        if (part.dev !== verified.dev || part.ino !== verified.ino
            || final.dev !== part.dev || final.ino !== part.ino
            || part.nlink !== 2 || final.nlink !== 2) {
          throw new HelperError("unsafe-file");
        }
        publishedInode = Object.freeze({ dev: final.dev, ino: final.ino });
        await unlink(stage.paths.part);
        await safeRegular(published.final);
        const createdAt = new Date(Date.now()).toISOString();
        const meta = Object.freeze({
          createdAt,
          digest: request.digest,
          epoch: stage.state.epoch,
          expiresAt: new Date(Date.parse(createdAt) + TTL_SECONDS * 1000).toISOString(),
          instance: stage.state.instance,
          size: request.size,
        });
        await writeExclusive(published.meta, Buffer.from(JSON.stringify(meta), "utf8"));
        metadataPublished = true;
        const publishedMeta = await readMeta(published.meta, request.digest, stage.state.instance);
        await safeUnlink(stage.paths.state);
        return Object.freeze({ ...publishedMeta, remotePath: published.final });
      }
      catch (error) {
        if (metadataPublished) await safeUnlink(published.meta).catch(() => {});
        if (publishedInode) {
          const currentFinal = await lstat(published.final).catch(unlinkError =>
            unlinkError?.code === "ENOENT" ? null : Promise.reject(unlinkError));
          if (currentFinal?.dev === publishedInode.dev && currentFinal?.ino === publishedInode.ino) {
            await unlink(published.final).catch(() => {});
          }
        }
        else if (linkCreated) {
          const [part, final] = await Promise.all([
            lstat(stage.paths.part).catch(() => null),
            lstat(published.final).catch(() => null),
          ]);
          if (part && final && part.dev === final.dev && part.ino === final.ino) {
            await unlink(published.final).catch(() => {});
          }
        }
        throw error;
      }
    });
  }
  catch (error) {
    if (error?.code === "revoked") {
      await abortStage(stage, { tombstone: true }).catch(() => {});
    }
    throw error;
  }
}

async function transactionEntries(root, digest) {
  const entries = await readdir(root);
  if (entries.length > MAX_ENTRIES) throw new HelperError("entry-limit");
  const pattern = new RegExp(`^${digest}\\.([0-9a-f]{32})\\.state\\.json$`, "u");
  return entries.flatMap(entry => {
    const match = entry.match(pattern);
    return match ? [Object.freeze({ transferId: match[1] })] : [];
  });
}

async function publishedGenerations(root, digest) {
  const entries = await readdir(root);
  if (entries.length > MAX_ENTRIES) throw new HelperError("entry-limit");
  const pattern = new RegExp(`^${digest}\\.([0-9a-f]{64})\\.(?:pdf|meta\\.json)$`, "u");
  return new Set(entries.flatMap(entry => {
    const match = entry.match(pattern);
    return match ? [match[1]] : [];
  }));
}

async function removeGeneration(root, digest, instance, transactions = null) {
  const published = names(root, digest, null, instance);
  const values = transactions ?? await transactionEntries(root, digest);
  for (const { transferId } of values) {
    const paths = names(root, digest, transferId);
    const state = await readStateForCleanup(paths.state);
    if (!state || state.instance === instance) await recoverInterruptedLink(paths, published);
  }
  await safeUnlink(published.meta);
  await safeUnlink(published.final);
}

async function cleanupOrphanLockEntry(root, entry) {
  const ownerMatch = entry.match(/^([0-9a-f]{64}(?:\.[0-9a-f]{32}\.transfer)?)\.lock\.([0-9a-f]{32})\.owner$/u);
  const claimMatch = entry.match(/^([0-9a-f]{64}(?:\.[0-9a-f]{32}\.transfer)?)\.lock\.([0-9a-f]{32})\.claim\./u);
  if (!ownerMatch && !claimMatch) return false;
  const path = join(root, entry);
  const metadata = await lstat(path).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!metadata) return false;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
      || (metadata.mode & 0o777) !== 0o600) throw new HelperError("unsafe-lock");
  if (metadata.nlink !== 1) return false;
  let activeOwner;
  if (ownerMatch) {
    const text = (await readSafeFile(path, 1024)).toString("utf8");
    activeOwner = validateLockOwner(parseCanonicalJson(text, "lock-owner"));
    if (activeOwner.nonce !== ownerMatch[2]) throw new HelperError("unsafe-lock");
  }
  else {
    activeOwner = parseClaimant(entry, claimMatch[1], claimMatch[2]);
    if (!activeOwner) throw new HelperError("unsafe-lock");
  }
  if (await processIdentityIsAlive(activeOwner)) return false;
  await safeUnlink(path);
  return true;
}

async function revoke(root, digest) {
  await withDigestLock(root, digest, async () => {
    const epoch = await replaceGenerationToken(root, digest);
    const transactions = await transactionEntries(root, digest);
    for (const published of await publishedGenerations(root, digest)) {
      await removeGeneration(root, digest, published, transactions);
    }
    for (const { transferId } of transactions) {
      const transferPaths = names(root, digest, transferId);
      const state = await readStateForCleanup(transferPaths.state);
      if (state?.epoch === epoch) continue;
      await safeUnlink(transferPaths.part);
      await safeUnlink(transferPaths.state);
      await writeTombstone(transferPaths.revoked);
    }
  });
}

async function cleanup(root) {
  const entries = await readdir(root);
  if (entries.length > MAX_ENTRIES) throw new HelperError("entry-limit");
  let cleaned = 0;
  const now = Date.now();
  const digests = new Set();
  for (const entry of entries) {
    const match = entry.match(/^([0-9a-f]{64})\.(?:generation|[0-9a-f]{64}\.(?:meta\.json|pdf)|[0-9a-f]{32}\.state\.json)$/u);
    if (match) digests.add(match[1]);
  }
  for (const digest of digests) {
    const verifyOutsideLock = [];
    await withDigestLock(root, digest, async () => {
      await ensureGenerationToken(root, digest);
      const transactions = await transactionEntries(root, digest);
      for (const instance of await publishedGenerations(root, digest)) {
        const published = names(root, digest, null, instance);
        const meta = await readMeta(published.meta, digest, instance).catch(error => {
          if (error?.code === "ENOENT" || isInvalidMetadataError(error)) return null;
          throw error;
        });
        const final = await safeRegular(published.final, { allowMissing: true });
        let invalid = !meta || !final || now >= Date.parse(meta.expiresAt);
        if (invalid) {
          await removeGeneration(root, digest, instance, transactions);
          cleaned += 1;
        }
        else {
          verifyOutsideLock.push(Object.freeze({
            instance,
            metadata: final,
            path: published.final,
            size: meta.size,
          }));
        }
      }
      for (const { transferId } of transactions) {
        const paths = names(root, digest, transferId);
        const metadata = await safeRegular(paths.state, { allowMissing: true });
        const state = metadata ? await readStateForCleanup(paths.state) : null;
        if (metadata && (!state || now - metadata.mtimeMs >= TTL_SECONDS * 1000)) {
          await safeUnlink(paths.part);
          await safeUnlink(paths.state);
          await writeTombstone(paths.revoked);
        }
      }
    });
    for (const candidate of verifyOutsideLock) {
      let tampered = false;
      try { await verifySafeDigest(candidate.path, candidate.size, digest); }
      catch (error) {
        if (error?.code === "digest-mismatch" || error?.code === "ENOENT") tampered = true;
        else throw error;
      }
      if (!tampered) continue;
      await withDigestLock(root, digest, async () => {
        const current = await safeRegular(candidate.path, { allowMissing: true });
        if (!current || current.dev !== candidate.metadata.dev || current.ino !== candidate.metadata.ino
            || current.size !== candidate.metadata.size
            || current.mtimeMs !== candidate.metadata.mtimeMs
            || current.ctimeMs !== candidate.metadata.ctimeMs) return;
        await removeGeneration(root, digest, candidate.instance);
        cleaned += 1;
      });
    }
  }
  for (const entry of entries) {
    const staleMatch = entry.match(/^([0-9a-f]{64})\.(?:[0-9a-f]{32}\.(?:part|state\.json|revoked)|[0-9a-f]{64}\.meta\.json\.[0-9a-f]{32}\.tmp|generation\.[0-9a-f]{64}\.candidate)$/u);
    if (!staleMatch) continue;
    const path = join(root, entry);
    const metadata = await safeRegular(path, { allowMissing: true });
    if (!metadata) continue;
    if (now - metadata.mtimeMs >= TTL_SECONDS * 1000) {
      await safeUnlink(path);
    }
  }
  for (const entry of entries) {
    if (await cleanupOrphanLockEntry(root, entry)) cleaned += 1;
  }
  return cleaned;
}

async function runProtocol() {
  const root = await evidenceRoot();
  let buffer = Buffer.alloc(0);
  let request = null;
  let stage = null;
  let stageHandle = null;
  let position = 0;
  let pendingTerminal = null;
  let ended = false;
  let inputTransportError = false;
  process.stdin.once("error", () => { inputTransportError = true; });

  const closeStageHandle = async () => {
    if (!stageHandle) return;
    const handle = stageHandle;
    stageHandle = null;
    let failure = null;
    try { await handle.sync(); }
    catch (error) { failure = error; }
    try { await handle.close(); }
    catch (error) { failure ||= error; }
    if (failure) throw failure;
  };

  const processLine = async line => {
    const value = parseCanonicalJson(line, "input");
    if (!request) {
      request = validateFirstRequest(value);
      if (request.operation === "stage") {
        stage = await prepareStage(root, request);
        position = stage.prefix.offset;
        emit({ type: "resume", offset: position, prefixDigest: stage.prefix.hash.copy().digest("hex") });
      }
      else pendingTerminal = request.operation;
      return;
    }
    if (request.operation !== "stage" || pendingTerminal) throw new HelperError("extra-input");
    if (!stageHandle) {
      exactKeys(value, ["type"], "stage-control");
      if (value.type === "abort") {
        pendingTerminal = "abort";
        return;
      }
      if (value.type !== "continue") throw new HelperError("stage-control");
      const metadata = await safeRegular(stage.paths.part);
      stageHandle = await open(
        stage.paths.part,
        constants.O_RDWR | constants.O_NOFOLLOW | (constants.O_CLOEXEC ?? 0),
      );
      const opened = await stageHandle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== process.getuid()
          || (opened.mode & 0o777) !== 0o600 || opened.size !== position
          || opened.ino !== metadata.ino || opened.dev !== metadata.dev) {
        throw new HelperError("unsafe-file");
      }
      return;
    }
    if (value.type === "chunk") {
      exactKeys(value, ["type", "data"], "stage-chunk");
      if (typeof value.data !== "string"
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.data)) {
        throw new HelperError("chunk-base64");
      }
      const bytes = Buffer.from(value.data, "base64");
      if (bytes.length < 1 || bytes.length > CHUNK_BYTES || bytes.toString("base64") !== value.data
          || position + bytes.length > request.size) throw new HelperError("chunk-size");
      const written = await stageHandle.write(bytes, 0, bytes.length, position);
      if (written.bytesWritten !== bytes.length) throw new HelperError("chunk-write");
      stage.prefix.hash.update(bytes);
      stage.prefix.offset += bytes.length;
      position += bytes.length;
      return;
    }
    exactKeys(value, ["type"], "stage-control");
    if (value.type === "abort") pendingTerminal = "abort";
    else if (value.type === "finalize") pendingTerminal = "finalize";
    else throw new HelperError("stage-control");
  };

  try {
    for await (const chunk of process.stdin) {
      if (pendingTerminal && request?.operation === "stage") throw new HelperError("extra-input");
      if (chunk.byteLength > MAX_LINE_BYTES * 2
          || buffer.length + chunk.byteLength > MAX_LINE_BYTES * 2) {
        throw new HelperError("input-size");
      }
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.length > MAX_LINE_BYTES && buffer.indexOf(0x0a) < 0) throw new HelperError("input-size");
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        if (newline > MAX_LINE_BYTES) throw new HelperError("input-size");
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        await processLine(line);
      }
    }
    ended = true;
    if (buffer.length || !request || !pendingTerminal) throw new HelperError("unterminated-input");
    if (request.operation === "stage") {
      await closeStageHandle();
      if (pendingTerminal === "abort") {
        await abortStage(stage);
        emit({ type: "aborted" });
      }
      else {
        const result = await publishStage(root, request, stage);
        emit({
          type: "complete",
          createdAt: result.createdAt,
          digest: result.digest,
          size: result.size,
          expiresAt: result.expiresAt,
          remotePath: result.remotePath,
        });
      }
    }
    else if (request.operation === "revoke") {
      await revoke(root, request.digest);
      emit({ type: "revoked" });
    }
    else emit({ type: "cleaned", count: await cleanup(root) });
  }
  catch (error) {
    await closeStageHandle().catch(() => {});
    // A channel loss before an explicit finalize/abort deliberately retains
    // the transaction for prefix-verified resume on the same host.
    if (stage && !inputTransportError
        && !(ended && !pendingTerminal && error?.code === "unterminated-input")) {
      await abortStage(stage).catch(() => {});
    }
    throw error;
  }
  finally {
    await releaseStageLease(stage);
  }
}

export async function main() {
  try { await runProtocol(); }
  catch (error) {
    emit({ type: "error", code: error instanceof HelperError ? error.code : "internal" });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
