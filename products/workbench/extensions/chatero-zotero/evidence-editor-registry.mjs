import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

const evidenceKinds = Object.freeze({
  note: Object.freeze({
    keyField: "noteKey",
    leaf: "note.chatero-zotero-note",
    scheme: "chatero-zotero-note",
  }),
  pdf: Object.freeze({
    keyField: "attachmentKey",
    leaf: "paper.chatero-zotero-pdf",
    scheme: "chatero-zotero-pdf",
  }),
});

function uriText(uri) {
  const value = typeof uri === "string" ? uri : uri?.toString?.();
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Zotero evidence URI is invalid");
  }
  return value;
}

function canonicalUri({ kind, libraryId, key }) {
  const descriptor = evidenceKinds[kind];
  return `${descriptor.scheme}:/${libraryId}/${key}/${descriptor.leaf}`;
}

function identityFromRecord(kind, record) {
  const descriptor = evidenceKinds[kind];
  if (!descriptor || !record || typeof record !== "object" || !Object.isFrozen(record)) {
    throw new Error("Zotero evidence document is invalid");
  }
  if (!Number.isSafeInteger(record.libraryId) || record.libraryId < 1) {
    throw new Error("Zotero evidence library is invalid");
  }
  const key = record[descriptor.keyField];
  if (typeof key !== "string" || !/^[A-Z0-9]{8}$/.test(key)) {
    throw new Error("Zotero evidence key is invalid");
  }
  return Object.freeze({ kind, libraryId: record.libraryId, key });
}

function sameIdentity(identity, record) {
  try {
    const actual = identityFromRecord(identity.kind, record);
    return actual.libraryId === identity.libraryId && actual.key === identity.key;
  }
  catch (_) {
    return false;
  }
}

function unavailableEvidence(message) {
  const error = new Error(message);
  error.code = "UNAVAILABLE";
  return error;
}

export function parseEvidenceDocumentUri(uri) {
  const value = uriText(uri);
  const match = /^(chatero-zotero-(pdf|note)):\/([1-9][0-9]*)\/([A-Z0-9]{8})\/(paper\.chatero-zotero-pdf|note\.chatero-zotero-note)$/.exec(value);
  if (!match) throw new Error("Zotero evidence URI is not canonical");
  const [, scheme, kind, rawLibraryId, key, leaf] = match;
  const libraryId = Number(rawLibraryId);
  const descriptor = evidenceKinds[kind];
  if (!Number.isSafeInteger(libraryId) || libraryId < 1
      || descriptor.scheme !== scheme || descriptor.leaf !== leaf) {
    throw new Error("Zotero evidence URI is not canonical");
  }
  const identity = Object.freeze({ kind, libraryId, key });
  if (canonicalUri(identity) !== value) throw new Error("Zotero evidence URI is not canonical");
  return identity;
}

export function createEnsureCore({ getCurrent, start } = {}) {
  if (typeof getCurrent !== "function" || typeof start !== "function") {
    throw new Error("ensureCore requires current-Core and startup functions");
  }
  let pending = null;
  return async function ensureCore() {
    const current = getCurrent();
    if (current) return current;
    if (!pending) pending = Promise.resolve().then(start);
    const launch = pending;
    try {
      return await launch;
    }
    finally {
      if (pending === launch) pending = null;
    }
  };
}

export function readCoreLaunchConfiguration(configuration) {
  if (!configuration || typeof configuration.inspect !== "function") {
    throw new Error("Zotero Core configuration must support global inspection");
  }
  const globalValue = (key, fallback) => {
    const value = configuration.inspect(key)?.globalValue;
    return typeof value === typeof fallback ? value : fallback;
  };
  return Object.freeze({
    coreExecutable: globalValue("coreExecutable", ""),
    developerFixtureCore: globalValue("developerFixtureCore", false),
    profilePath: globalValue("profilePath", ""),
  });
}

export async function resolveCoreExecutable({
  configuredPath,
  extensionPath,
  platform = process.platform,
  isFile = async path => lstat(path).then(value => value.isFile() && !value.isSymbolicLink()).catch(() => false),
} = {}) {
  if (typeof configuredPath !== "string" || typeof extensionPath !== "string" || typeof isFile !== "function") {
    throw new TypeError("Zotero Core executable resolution is invalid");
  }
  if (platform === "darwin") {
    const resources = resolve(extensionPath, "..", "..", "..");
    const bundled = join(resources, "chatero-core", "Chatero Core.app", "Contents", "MacOS", "zotero");
    if (await isFile(bundled)) return bundled;
    if (extensionPath.includes(".app/Contents/Resources/")) {
      throw new Error("The bundled Zotero Core is unavailable; reinstall Chatero from the verified DMG");
    }
  }
  if (configuredPath && resolve(configuredPath) === configuredPath) return configuredPath;
  throw new Error("A development Zotero Core executable must be selected before Core can start");
}

export function buildZoteroCompatibilityLaunchPlan({ geckoExecutable, profileDirectory } = {}) {
  if (typeof geckoExecutable !== "string" || resolve(geckoExecutable) !== geckoExecutable) {
    throw new Error("Zotero compatibility executable must be an absolute path");
  }
  if (typeof profileDirectory !== "string" || resolve(profileDirectory) !== profileDirectory) {
    throw new Error("Zotero compatibility profile must be an absolute path");
  }
  return Object.freeze({
    executable: geckoExecutable,
    profileDirectory: resolve(profileDirectory),
    args: Object.freeze([
      "-no-remote",
      "-profile",
      resolve(profileDirectory),
      "-datadir",
      "profile",
    ]),
  });
}

function localFilePath(uri, label) {
  if (!uri || uri.scheme !== "file" || uri.authority
      || typeof uri.fsPath !== "string" || uri.fsPath.length === 0) {
    throw new Error(`${label} must be selected from the local file system`);
  }
  return uri.fsPath;
}

export async function selectLocalCoreConfigurationPath({
  defaultUri,
  dialogOptions,
  label,
  showOpenDialog,
  update,
} = {}) {
  if (typeof showOpenDialog !== "function" || typeof update !== "function"
      || !dialogOptions || typeof dialogOptions !== "object" || typeof label !== "string") {
    throw new Error("Zotero Core local picker configuration is invalid");
  }
  localFilePath(defaultUri, `${label} default`);
  const selection = await showOpenDialog({ ...dialogOptions, defaultUri });
  if (!selection?.[0]) return null;
  const path = localFilePath(selection[0], label);
  await update(path);
  return path;
}

export function createCoreLifecycle({
  start,
  publish = () => {},
  unpublish = () => {},
  onUnexpectedStop = () => {},
} = {}) {
  if (typeof start !== "function" || typeof publish !== "function"
      || typeof unpublish !== "function" || typeof onUnexpectedStop !== "function") {
    throw new Error("Zotero Core lifecycle requires start and lifecycle callbacks");
  }
  let current = null;
  let disposed = false;
  let disposePromise = null;
  let epoch = 0;
  let pendingLaunch = null;
  let publicationCleanup = null;
  let stopping = null;

  const validateCore = core => {
    if (!core || typeof core.stop !== "function" || typeof core.whenStopped?.then !== "function") {
      throw new Error("Zotero Core startup returned an invalid lifecycle handle");
    }
  };

  const clearPublication = (core, details) => {
    if (current !== core) return false;
    current = null;
    const cleanup = publicationCleanup;
    publicationCleanup = null;
    let cleanupError = null;
    try {
      cleanup?.();
    }
    catch (error) {
      cleanupError = error;
    }
    try {
      unpublish(details);
    }
    catch (error) {
      cleanupError ||= error;
    }
    if (cleanupError) throw cleanupError;
    return true;
  };

  const reportUnexpectedStop = details => {
    try {
      onUnexpectedStop(details);
    }
    catch (_) {}
  };

  const discardPublishedCore = async (core, cleanup, reason, initialError = null) => {
    let failure = initialError;
    try {
      cleanup?.();
    }
    catch (error) {
      failure ||= error;
    }
    try {
      unpublish({ core, reason });
    }
    catch (error) {
      failure ||= error;
    }
    try {
      await core.stop();
    }
    catch (error) {
      failure ||= error;
    }
    if (failure) throw failure;
  };

  const watchCore = core => {
    void Promise.resolve(core.whenStopped).then(result => {
      if (current !== core) return;
      epoch += 1;
      let cleanupError = null;
      try {
        clearPublication(core, { core, reason: "stopped", result });
      }
      catch (error) {
        cleanupError = error;
      }
      if (result?.expected !== true || cleanupError) {
        reportUnexpectedStop({ core, error: cleanupError, result });
      }
    }, error => {
      if (current !== core) return;
      epoch += 1;
      let cleanupError = null;
      try {
        clearPublication(core, { core, error, reason: "stopped" });
      }
      catch (value) {
        cleanupError = value;
      }
      reportUnexpectedStop({ core, error: cleanupError || error });
    });
  };

  const launchForEpoch = async launchEpoch => {
    const launched = await start();
    if (launched === null || launched === undefined) return null;
    validateCore(launched);
    if (disposed || launchEpoch !== epoch) {
      await launched.stop();
      return null;
    }

    let cleanup = null;
    try {
      cleanup = publish(launched) || null;
      if (cleanup !== null && typeof cleanup !== "function") {
        throw new Error("Zotero Core publication cleanup must be a function");
      }
    }
    catch (error) {
      await discardPublishedCore(launched, cleanup, "publish-failed", error);
    }
    if (disposed || launchEpoch !== epoch) {
      await discardPublishedCore(launched, cleanup, "stale-start");
      return null;
    }

    current = launched;
    publicationCleanup = cleanup;
    watchCore(launched);
    return launched;
  };

  async function ensureCore() {
    if (disposed) throw new Error("Zotero Core lifecycle is disposed");
    if (stopping) await stopping;
    if (disposed) throw new Error("Zotero Core lifecycle is disposed");
    if (current) return current;
    if (!pendingLaunch) {
      const launchEpoch = epoch;
      const launch = Promise.resolve().then(() => launchForEpoch(launchEpoch));
      const tracked = launch.finally(() => {
        if (pendingLaunch === tracked) pendingLaunch = null;
      });
      pendingLaunch = tracked;
    }
    return pendingLaunch;
  }

  function stopCore() {
    if (stopping) return stopping;
    epoch += 1;
    const active = current;
    const launch = pendingLaunch;
    let transitionError = null;
    if (active) {
      try {
        clearPublication(active, { core: active, reason: "stop" });
      }
      catch (error) {
        transitionError = error;
      }
    }
    else {
      try {
        unpublish({ core: null, reason: "stop" });
      }
      catch (error) {
        transitionError = error;
      }
    }
    const operation = (async () => {
      if (active) {
        try {
          await active.stop();
        }
        catch (error) {
          transitionError ||= error;
        }
      }
      if (launch) {
        try {
          await launch;
        }
        catch (error) {
          transitionError ||= error;
        }
      }
      if (transitionError) throw transitionError;
    })();
    const tracked = operation.finally(() => {
      if (stopping === tracked) stopping = null;
    });
    stopping = tracked;
    return tracked;
  }

  function dispose() {
    disposed = true;
    disposePromise ||= stopCore();
    return disposePromise;
  }

  return Object.freeze({
    dispose,
    ensureCore,
    getCurrent: () => current,
    stopCore,
  });
}

export function createEvidenceDocumentResolver({ ensureCore, getModel, registry } = {}) {
  if (typeof ensureCore !== "function" || typeof getModel !== "function"
      || !(registry instanceof EvidenceDocumentRegistry)) {
    throw new Error("Zotero evidence resolver requires Core access and a document registry");
  }
  return (uri, kind) => registry.resolveOrHydrate(uri, kind, async identity => {
    await ensureCore();
    const model = getModel();
    if (!model) {
      throw new Error("Zotero Core setup is required before restoring this evidence tab");
    }
    if (identity.kind === "pdf") {
      return model.attachment({ attachmentKey: identity.key, libraryId: identity.libraryId });
    }
    const restored = await model.note({ libraryId: identity.libraryId, noteKey: identity.key });
    return Object.freeze({
      libraryId: restored.libraryId,
      noteKey: restored.noteKey,
      parentItemKey: restored.parentItemKey,
      title: restored.title,
    });
  });
}

export class EvidenceDocumentRegistry {
  #documents = new Map();
  #hydrations = new Map();
  #epoch = 0;

  stage(kind, record) {
    const identity = identityFromRecord(kind, record);
    const uri = canonicalUri(identity);
    const existing = this.#documents.get(uri);
    if (existing && existing.kind !== kind) {
      throw new Error("A different Zotero evidence kind already owns this document tab");
    }
    this.#documents.set(uri, Object.freeze({ kind, record }));
    return uri;
  }

  resolve(uri, kind) {
    const identity = parseEvidenceDocumentUri(uri);
    const key = canonicalUri(identity);
    const entry = this.#documents.get(key);
    if (!entry || entry.kind !== kind || identity.kind !== kind) {
      throw new Error("The evidence document does not belong to the active Zotero Core session");
    }
    return entry.record;
  }

  release(uri, kind, record) {
    const identity = parseEvidenceDocumentUri(uri);
    const key = canonicalUri(identity);
    const entry = this.#documents.get(key);
    if (!entry || entry.kind !== kind || identity.kind !== kind || entry.record !== record) {
      return false;
    }
    this.#documents.delete(key);
    return true;
  }

  async resolveOrHydrate(uri, kind, resolver) {
    const identity = parseEvidenceDocumentUri(uri);
    if (identity.kind !== kind || !evidenceKinds[kind]) {
      throw new Error("The evidence document kind does not match its canonical URI");
    }
    const key = canonicalUri(identity);
    const existing = this.#documents.get(key);
    if (existing) return this.resolve(key, kind);
    if (typeof resolver !== "function") throw new Error("Zotero evidence hydration requires a resolver");
    const active = this.#hydrations.get(key);
    if (active) return active;
    const epoch = this.#epoch;
    const hydration = Promise.resolve().then(async () => {
      const record = await resolver(identity);
      if (epoch !== this.#epoch) {
        throw new Error("The active Zotero Core session changed while restoring evidence");
      }
      if (!sameIdentity(identity, record)) {
        throw unavailableEvidence("Zotero Core returned a different evidence identity");
      }
      if (this.stage(kind, record) !== key) {
        throw unavailableEvidence("Zotero Core returned a noncanonical evidence identity");
      }
      return this.resolve(key, kind);
    });
    this.#hydrations.set(key, hydration);
    try {
      return await hydration;
    }
    finally {
      if (this.#hydrations.get(key) === hydration) this.#hydrations.delete(key);
    }
  }

  reset() {
    this.#epoch += 1;
    this.#documents.clear();
    this.#hydrations.clear();
  }
}
