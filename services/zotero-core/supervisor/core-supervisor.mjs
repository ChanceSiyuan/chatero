import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { connectCore } from "../client/core-client.mjs";
import { CAPABILITIES } from "../generated/protocol.mjs";
import { acquireProfileLease } from "../profile/profile-lease.mjs";
export { restoreProfileDatabase } from "../profile/profile-restore.mjs";

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FIXTURE_CORE = join(CORE_ROOT, "fixture", "fixture-core.mjs");
const SESSION_PREFIX = "chatero-zotero-core-";
const MARKER_FILE = ".chatero-session.json";

export function buildCoreLaunchPlan({ geckoExecutable, profileDirectory, fixtureCorePath = DEFAULT_FIXTURE_CORE } = {}) {
  const canonicalProfile = resolve(profileDirectory);
  if (geckoExecutable !== undefined) {
    if (typeof geckoExecutable !== "string" || !geckoExecutable.startsWith("/")) {
      throw new Error("Gecko Core executable must be an absolute path");
    }
    return Object.freeze({
      args: Object.freeze(["-no-remote", "-profile", canonicalProfile, "-headless", "-ChateroCore"]),
      executable: geckoExecutable,
      mode: "gecko",
    });
  }
  return Object.freeze({
    args: Object.freeze([fixtureCorePath]),
    executable: process.execPath,
    mode: "fixture",
  });
}

function wait(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

async function removeOwnedSessionDirectory(sessionDirectory, nonce) {
  const canonical = resolve(sessionDirectory);
  if (dirname(canonical) !== resolve(tmpdir()) || !basename(canonical).startsWith(SESSION_PREFIX)) {
    throw new Error(`refusing to remove an unexpected Core session directory: ${canonical}`);
  }
  const metadata = await lstat(canonical).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!metadata) return false;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Core session path is not a real directory");
  let marker;
  try {
    marker = JSON.parse(await readFile(join(canonical, MARKER_FILE), "utf8"));
  }
  catch (error) {
    throw new Error(`refusing to remove an unrecognized Core session: ${error.message}`);
  }
  if (marker?.schemaVersion !== 1 || marker?.nonce !== nonce) {
    throw new Error("refusing to remove a Core session owned by another launch");
  }
  await rm(canonical, { recursive: true });
  return true;
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise(resolvePromise => child.once("exit", resolvePromise)),
    wait(timeoutMs),
  ]);
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForExit(child, 2000);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child, 1000);
  }
}

export async function startCore({
  profileDirectory,
  fixtureCollections = [],
  fixtureFeeds = [],
  fixtureAnnotations = [],
  fixtureAttachmentContents = [],
  fixtureAttachmentStates = [],
  fixtureCitationRenders = [],
  fixtureCitationStyles = [],
  fixtureDuplicates = [],
  fixtureExports = [],
  fixtureImportResults = [],
  fixtureFulltextMatches = [],
  fixtureItems = [],
  fixtureItemChildren = [],
  fixtureItemFacts = [],
  fixtureItemMetadata = [],
  fixtureLibraries = [],
  fixtureNotes = [],
  fixtureSavedSearches = [],
  fixtureTags = [],
  fixtureSyncConflicts = [],
  fixtureSyncStatus,
  fixtureSyncStorageStatuses = [],
  fixtureTranslators = [],
  fixtureCorePath = DEFAULT_FIXTURE_CORE,
  fixtureSearchDelayMs = 0,
  geckoExecutable,
  requestedCapabilities = CAPABILITIES,
  readyTimeoutMs = 5000,
  upstreamVersion = "7.0-fixture",
} = {}) {
  const profileEpoch = randomUUID();
  const lease = await acquireProfileLease({ profileDirectory, epoch: profileEpoch });
  const sessionNonce = randomBytes(24).toString("base64url");
  const bootstrapToken = randomBytes(32).toString("base64url");
  const sessionDirectory = await mkdtemp(join(tmpdir(), SESSION_PREFIX));
  await chmod(sessionDirectory, 0o700);
  const markerPath = join(sessionDirectory, MARKER_FILE);
  const bootstrapPath = join(sessionDirectory, "bootstrap.token");
  const fixturePath = join(sessionDirectory, "fixture-items.json");
  const socketPath = join(sessionDirectory, "core.sock");
  const startupErrorPath = `${socketPath}.startup-error`;
  await writeFile(markerPath, `${JSON.stringify({ nonce: sessionNonce, schemaVersion: 1 })}\n`, { mode: 0o600 });
  await writeFile(bootstrapPath, `${bootstrapToken}\n`, { mode: 0o600 });
  await writeFile(fixturePath, `${JSON.stringify({
    annotations: fixtureAnnotations,
    attachmentContents: fixtureAttachmentContents,
    attachmentStates: fixtureAttachmentStates,
    citationRenders: fixtureCitationRenders,
    citationStyles: fixtureCitationStyles,
    duplicates: fixtureDuplicates,
    collections: fixtureCollections,
    feeds: fixtureFeeds,
    exports: fixtureExports,
    importResults: fixtureImportResults,
    fulltextMatches: fixtureFulltextMatches,
    itemChildren: fixtureItemChildren,
    itemFacts: fixtureItemFacts,
    itemMetadata: fixtureItemMetadata,
    items: fixtureItems,
    libraries: fixtureLibraries,
    notes: fixtureNotes,
    savedSearches: fixtureSavedSearches,
    syncConflicts: fixtureSyncConflicts,
    ...(fixtureSyncStatus && { syncStatus: fixtureSyncStatus }),
    syncStorageStatuses: fixtureSyncStorageStatuses,
    tags: fixtureTags,
    translators: fixtureTranslators,
  })}\n`, { mode: 0o600 });

  const launch = buildCoreLaunchPlan({ fixtureCorePath, geckoExecutable, profileDirectory });
  const bootstrapHandle = await open(bootstrapPath, "r");
  let child;
  try {
    child = spawn(launch.executable, launch.args, {
      env: {
        ...process.env,
        ...(process.versions.electron && { ELECTRON_RUN_AS_NODE: "1" }),
        CHATERO_CORE_FIXTURE_PATH: fixturePath,
        CHATERO_CORE_PROFILE_DIRECTORY: resolve(profileDirectory),
        CHATERO_CORE_PROFILE_EPOCH: profileEpoch,
        CHATERO_CORE_SEARCH_DELAY_MS: String(fixtureSearchDelayMs),
        CHATERO_CORE_SOCKET_PATH: socketPath,
        CHATERO_CORE_UPSTREAM_VERSION: upstreamVersion,
      },
      stdio: ["ignore", "pipe", "pipe", bootstrapHandle.fd],
    });
  }
  finally {
    await bootstrapHandle.close();
    await unlink(bootstrapPath).catch(error => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  let spawnError = null;
  child.once("error", error => { spawnError = error; });
  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout = `${stdout}${chunk}`.slice(-8192);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });

  let client;
  const deadline = Date.now() + readyTimeoutMs;
  try {
    while (!client && Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        const startupError = await readFile(startupErrorPath, "utf8").catch(error => error?.code === "ENOENT" ? "" : Promise.reject(error));
        throw new Error(`Zotero Core exited before readiness: ${(startupError + stdout + stderr).trim() || child.exitCode || child.signalCode}`);
      }
      try {
        client = await connectCore({
          socketPath,
          bootstrapToken,
          requestedCapabilities,
          connectTimeoutMs: Math.min(250, Math.max(1, deadline - Date.now())),
        });
      }
      catch (error) {
        if (!["ENOENT", "ECONNREFUSED"].includes(error?.code)) throw error;
        await wait(20);
      }
    }
    if (!client) {
      const startupError = await readFile(startupErrorPath, "utf8").catch(error => error?.code === "ENOENT" ? "" : Promise.reject(error));
      let diagnostics = (startupError + stdout + stderr).trim();
      throw new Error(`Zotero Core did not become ready within ${readyTimeoutMs}ms${diagnostics ? `: ${diagnostics}` : ""}`);
    }
  }
  catch (error) {
    await terminate(child);
    await lease.release();
    await removeOwnedSessionDirectory(sessionDirectory, sessionNonce);
    throw error;
  }

  let stopRequested = false;
  let cleanupPromise = null;
  let resolveStopped;
  let rejectStopped;
  const whenStopped = new Promise((resolvePromise, reject) => {
    resolveStopped = resolvePromise;
    rejectStopped = reject;
  });
  const cleanup = (expected, exit = {}) => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      client.close();
      if (expected) await terminate(child);
      await lease.release();
      await removeOwnedSessionDirectory(sessionDirectory, sessionNonce);
      const result = Object.freeze({
        code: exit.code ?? child.exitCode,
        expected,
        signal: exit.signal ?? child.signalCode,
      });
      resolveStopped(result);
      return result;
    })().catch(error => {
      rejectStopped(error);
      throw error;
    });
    return cleanupPromise;
  };
  child.once("exit", (code, signal) => {
    if (!cleanupPromise) void cleanup(false, { code, signal }).catch(() => {});
  });
  const stop = async () => {
    if (stopRequested || cleanupPromise) return false;
    stopRequested = true;
    await cleanup(true);
    return true;
  };

  return Object.freeze({
    bootstrapTransport: "inherited-fd",
    child,
    client,
    mode: launch.mode,
    profileEpoch,
    sessionDirectory,
    socketPath,
    stop,
    transport: "unix",
    whenStopped,
  });
}
