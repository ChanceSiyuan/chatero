import { createReadStream } from "node:fs";
import { chmod, lstat, readFile } from "node:fs/promises";
import net from "node:net";
import { basename } from "node:path";

import {
  CAPABILITIES,
  METHOD_CAPABILITIES,
  PROTOCOL_VERSION,
} from "../generated/protocol.mjs";
import { SessionAuthority } from "../security/session-authority.mjs";
import { FrameDecoder, writeFrame } from "../transport/frame-codec.mjs";
import { createCoreEventJournal } from "../../../chrome/content/zotero/xpcom/chateroCoreEventJournal.mjs";
import { createCoreAttachmentSourceRegistry } from "../../../chrome/content/zotero/xpcom/chateroCoreAttachmentSourceRegistry.mjs";
import { createCoreTransactionRegistry } from "../../../chrome/content/zotero/xpcom/chateroCoreTransactionRegistry.mjs";

const MAX_BOOTSTRAP_BYTES = 1024;
const MAX_ERROR_MESSAGE = 512;

async function readBootstrapToken() {
  const stream = createReadStream("", { fd: 3, autoClose: true, encoding: "utf8" });
  let value = "";
  for await (const chunk of stream) {
    value += chunk;
    if (Buffer.byteLength(value, "utf8") > MAX_BOOTSTRAP_BYTES) {
      throw new Error("bootstrap secret exceeded its size limit");
    }
  }
  const token = value.trimEnd();
  if (token.length < 24) throw new Error("bootstrap secret was missing or truncated");
  return token;
}

function rpcError(error) {
  const message = String(error?.message || error).slice(0, MAX_ERROR_MESSAGE);
  if (error?.code === "CANCELLED") return { code: "CANCELLED", message, retriable: false };
  if (error?.code === "UNAVAILABLE") return { code: "UNAVAILABLE", message, retriable: false };
  if (error?.code === "REVISION_CONFLICT" || error?.code === "IDEMPOTENCY_CONFLICT") {
    return {
      code: "CONFLICT",
      details: {
        ...(Number.isSafeInteger(error.actualRevision) && { actualRevision: error.actualRevision }),
        ...(Number.isSafeInteger(error.expectedRevision) && { expectedRevision: error.expectedRevision }),
        kind: error.code,
      },
      message,
      retriable: false,
    };
  }
  if (/missing capability/.test(message)) return { code: "FORBIDDEN", message, retriable: false };
  if (/deadline|profile epoch|session|authentication|protocol version/.test(message)) {
    return { code: "UNAUTHORIZED", message, retriable: false };
  }
  if (/params|query|limit|cursor/.test(message)) return { code: "INVALID_PARAMS", message, retriable: false };
  if (/unknown method/.test(message)) return { code: "METHOD_NOT_FOUND", message, retriable: false };
  return { code: "CORE_ERROR", message, retriable: false };
}

function validateSearchParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("library.search params must be an object");
  if (typeof params.query !== "string" || params.query.length > 1000) throw new Error("library.search query must be a bounded string");
  if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100) {
    throw new Error("library.search limit must be an integer from 1 through 100");
  }
  if (params.cursor !== undefined && (typeof params.cursor !== "string" || !/^\d+$/.test(params.cursor))) {
    throw new Error("library.search cursor must be a decimal offset");
  }
  if (params.collectionKey !== undefined && typeof params.collectionKey !== "string") {
    throw new Error("library.search collectionKey must be a string");
  }
  if (params.libraryId !== undefined && (!Number.isSafeInteger(params.libraryId) || params.libraryId <= 0)) {
    throw new Error("library.search libraryId must be a positive safe integer");
  }
  if ((params.collectionKey === undefined) !== (params.libraryId === undefined)) {
    throw new Error("library.search collectionKey and libraryId must be provided together");
  }
  if (params.sortBy !== undefined && !["creators", "itemType", "title", "year"].includes(params.sortBy)) {
    throw new Error("library.search sortBy must be one of creators, itemType, title, year");
  }
  if (params.sortDirection !== undefined && !["asc", "desc"].includes(params.sortDirection)) {
    throw new Error("library.search sortDirection must be asc or desc");
  }
}

function validateIdentityParams(params, keyField, label) {
  if (!params || typeof params !== "object" || Array.isArray(params)
    || Object.keys(params).length !== 2
    || !Number.isSafeInteger(params.libraryId) || params.libraryId <= 0
    || typeof params[keyField] !== "string" || !/^[A-Z0-9]{8}$/.test(params[keyField])) {
    throw new Error(`${label} params require a libraryId and ${keyField}`);
  }
}

async function main() {
  const {
    CHATERO_CORE_FIXTURE_PATH: fixturePath,
    CHATERO_CORE_PROFILE_DIRECTORY: profileDirectory,
    CHATERO_CORE_PROFILE_EPOCH: profileEpoch,
    CHATERO_CORE_SOCKET_PATH: socketPath,
    CHATERO_CORE_SEARCH_DELAY_MS: rawSearchDelayMs = "0",
    CHATERO_CORE_UPSTREAM_VERSION: upstreamVersion = "7.0-fixture",
  } = process.env;
  if (![fixturePath, profileDirectory, profileEpoch, socketPath].every(value => typeof value === "string" && value.length > 0)) {
    throw new Error("fixture Core launch configuration is incomplete");
  }
  const profileMetadata = await lstat(profileDirectory);
  if (!profileMetadata.isDirectory() || profileMetadata.isSymbolicLink()) throw new Error("fixture profile must be a real directory");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const fixtureItems = Array.isArray(fixture) ? fixture : fixture.items;
  const fixtureCollections = Array.isArray(fixture?.collections) ? fixture.collections : [];
  const fixtureItemChildren = Array.isArray(fixture?.itemChildren) ? fixture.itemChildren : [];
  const fixtureItemFacts = Array.isArray(fixture?.itemFacts) ? fixture.itemFacts : [];
  const fixtureFeeds = Array.isArray(fixture?.feeds) ? fixture.feeds : [];
  const fixtureItemMetadata = Array.isArray(fixture?.itemMetadata) ? fixture.itemMetadata : [];
  const fixtureLibraries = Array.isArray(fixture?.libraries) ? fixture.libraries : [];
  const fixtureNotes = Array.isArray(fixture?.notes) ? fixture.notes : [];
  const fixtureSavedSearches = Array.isArray(fixture?.savedSearches) ? fixture.savedSearches : [];
  const fixtureTags = Array.isArray(fixture?.tags) ? fixture.tags : [];
  const fixtureAnnotations = Array.isArray(fixture?.annotations) ? fixture.annotations : [];
  const fixtureAttachmentContents = Array.isArray(fixture?.attachmentContents) ? fixture.attachmentContents : [];
  const fixtureAttachmentStates = Array.isArray(fixture?.attachmentStates) ? fixture.attachmentStates : [];
  const fixtureCitationStyles = Array.isArray(fixture?.citationStyles) ? fixture.citationStyles : [];
  const fixtureCitationRenders = Array.isArray(fixture?.citationRenders) ? fixture.citationRenders : [];
  const fixtureDuplicates = Array.isArray(fixture?.duplicates) ? fixture.duplicates : [];
  const fixtureExports = Array.isArray(fixture?.exports) ? fixture.exports : [];
  const fixtureImportResults = Array.isArray(fixture?.importResults) ? fixture.importResults : [];
  const fixtureFulltextMatches = Array.isArray(fixture?.fulltextMatches) ? fixture.fulltextMatches : [];
  const fixtureSyncConflicts = Array.isArray(fixture?.syncConflicts) ? fixture.syncConflicts : [];
  const fixtureSyncStorageStatuses = Array.isArray(fixture?.syncStorageStatuses) ? fixture.syncStorageStatuses : [];
  const fixtureTranslators = Array.isArray(fixture?.translators) ? fixture.translators : [];
  if (!Array.isArray(fixtureItems)) throw new Error("fixture items must be an array");
  const bootstrapToken = await readBootstrapToken();
  const searchDelayMs = Number(rawSearchDelayMs);
  if (!Number.isSafeInteger(searchDelayMs) || searchDelayMs < 0 || searchDelayMs > 10000) {
    throw new Error("fixture search delay is invalid");
  }
  const eventJournal = createCoreEventJournal({ profileEpoch });
  const transactionRegistry = createCoreTransactionRegistry();
  const attachmentSources = createCoreAttachmentSourceRegistry();
  const authority = new SessionAuthority({
    bootstrapToken,
    profileEpoch,
    capabilities: CAPABILITIES,
    eventSequence: () => eventJournal.latestSequence,
  });

  const active = new Map();
  const waitForSearch = (milliseconds, signal) => new Promise((resolvePromise, reject) => {
    if (milliseconds === 0) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(resolvePromise, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      const error = new Error("Zotero Core request was cancelled");
      error.code = "CANCELLED";
      reject(error);
    }, { once: true });
  });
  const handle = async message => {
    if (message.method === "core.handshake") {
      return { result: {
        ...authority.handshake(message.params),
        upstreamVersion,
      } };
    }
    if (!Object.hasOwn(METHOD_CAPABILITIES, message.method)) throw new Error(`unknown method ${message.method}`);
    const authorizedSession = authority.authorize(message, METHOD_CAPABILITIES[message.method]);
    if (message.method === "core.cancel") {
      if (!message.params || typeof message.params.cancellationId !== "string") {
        throw new Error("core.cancel params must include cancellationId");
      }
      const controller = active.get(message.params.cancellationId);
      controller?.abort();
      return { result: { cancelled: Boolean(controller) } };
    }
    if (message.method === "core.events") {
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)
        || Object.keys(message.params).some(key => !["afterSequence", "limit"].includes(key))
        || !Number.isSafeInteger(message.params.afterSequence) || message.params.afterSequence < 0
        || !Number.isSafeInteger(message.params.limit) || message.params.limit < 1 || message.params.limit > 1000) {
        throw new Error("core.events params require a valid afterSequence and limit");
      }
      return { result: eventJournal.replay(message.params) };
    }
    if (message.method === "attachment.open") {
      validateIdentityParams(message.params, "attachmentKey", "attachment.open");
      const metadata = fixtureItemChildren.flatMap(entry => entry.attachments || [])
        .find(entry => entry.libraryId === message.params.libraryId && entry.attachmentKey === message.params.attachmentKey);
      if (!metadata) throw new Error(`fixture attachment ${message.params.libraryId}/${message.params.attachmentKey} was not found`);
      const content = fixtureAttachmentContents.find(entry => entry.libraryId === message.params.libraryId && entry.attachmentKey === message.params.attachmentKey);
      const bytes = Buffer.from(content?.bytesBase64url || "JVBERi0xLjQKJSVFT0YK", "base64url");
      return { result: attachmentSources.open({
        ...message.params,
        profileEpoch,
        sessionToken: authorizedSession.sessionToken,
        source: {
          size: bytes.length,
          async read(offset, length) { return Uint8Array.from(bytes.subarray(offset, offset + length)); },
          async close() {},
        },
      }) };
    }
    if (message.method === "attachment.read") {
      return { result: await attachmentSources.read({
        ...message.params,
        profileEpoch,
        sessionToken: authorizedSession.sessionToken,
      }) };
    }
    if (message.method === "attachment.close") {
      return { result: await attachmentSources.close({
        ...message.params,
        profileEpoch,
        sessionToken: authorizedSession.sessionToken,
      }) };
    }
    if (message.method === "profile.status") {
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params) || Object.keys(message.params).length !== 0) {
        throw new Error("profile.status params must be an empty object");
      }
      return { result: {
        compatibilityVersion: 10,
        integrityCheckRequired: false,
        profileEpoch,
        profileName: basename(profileDirectory),
        quickCheckPassed: true,
        readOnly: false,
        schemaVersion: 142,
        upstreamVersion,
      } };
    }
    if (message.method === "profile.backup") {
      const completed = await transactionRegistry.execute({
        expectedRevision: message.params?.expectedRevision,
        idempotencyKey: message.params?.idempotencyKey,
        operation: { kind: "profile-backup" },
        scope: "profile:backup",
      }, async () => ({ backupCreated: true, completedAt: Date.now() }));
      return {
        ...(!completed.replayed && {
          event: eventJournal.publish("profile.backup.completed", { revision: completed.revision }),
        }),
        result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
    }
    if (message.method === "profile.migrate") {
      const completed = await transactionRegistry.execute({
        expectedRevision: message.params?.expectedRevision,
        idempotencyKey: message.params?.idempotencyKey,
        operation: { kind: "profile-migrate" },
        scope: "profile:migrate",
      }, async () => ({ compatibilityVersion: 10, migrated: false, schemaVersion: 142 }));
      return {
        ...(!completed.replayed && { event: eventJournal.publish("profile.migration.completed", {
          migrated: completed.result.migrated, revision: completed.revision, schemaVersion: completed.result.schemaVersion,
        }) }),
        result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
    }
    if (message.method === "library.collections") {
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)
        || Object.keys(message.params).some(key => !["libraryId", "parentKey"].includes(key))
        || (message.params.parentKey !== undefined && typeof message.params.parentKey !== "string")
        || (message.params.libraryId !== undefined && (!Number.isSafeInteger(message.params.libraryId) || message.params.libraryId <= 0))
        || ((message.params.parentKey === undefined) !== (message.params.libraryId === undefined))) {
        throw new Error("library.collections requires a valid libraryId with parentKey");
      }
      const collections = fixtureCollections
        .filter(collection => message.params.libraryId === undefined || collection.libraryId === message.params.libraryId)
        .filter(collection => message.params.parentKey === undefined
          ? collection.parentKey === undefined
          : collection.parentKey === message.params.parentKey)
        .sort((left, right) => String(left.name).localeCompare(String(right.name)) || String(left.collectionKey).localeCompare(String(right.collectionKey)));
      return { result: { collections } };
    }
    if (message.method === "library.feeds") {
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params) || Object.keys(message.params).length) {
        throw new Error("library.feeds params must be an empty object");
      }
      return { result: { feeds: fixtureFeeds } };
    }
    if (message.method === "library.duplicates") {
      const matches = fixtureDuplicates.filter(value => value.libraryId === message.params?.libraryId);
      const offset = Number(message.params?.cursor || 0);
      const items = matches.slice(offset, offset + message.params.limit);
      const nextOffset = offset + items.length;
      return { result: { items, ...(nextOffset < matches.length && { nextCursor: String(nextOffset) }), total: matches.length } };
    }
    if (message.method === "library.fulltext-search") {
      const matches = fixtureFulltextMatches.filter(value => value.libraryId === message.params?.libraryId
        && (!value.query || value.query === message.params.query)).map(({ query: _, ...value }) => value);
      const offset = Number(message.params?.cursor || 0);
      const page = matches.slice(offset, offset + message.params.limit);
      const nextOffset = offset + page.length;
      return { result: { matches: page, ...(nextOffset < matches.length && { nextCursor: String(nextOffset) }), total: matches.length } };
    }
    if (message.method === "library.item-children") {
      validateIdentityParams(message.params, "itemKey", "library.item-children");
      const value = fixtureItemChildren.find(entry => entry.libraryId === message.params.libraryId && entry.itemKey === message.params.itemKey);
      if (!value) throw new Error(`fixture item ${message.params.libraryId}/${message.params.itemKey} was not found`);
      return { result: { attachments: value.attachments, notes: value.notes } };
    }
    if (message.method === "library.libraries") {
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params) || Object.keys(message.params).length) {
        throw new Error("library.libraries params must be an empty object");
      }
      return { result: { libraries: fixtureLibraries } };
    }
    if (message.method === "library.saved-searches") {
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)
        || Object.keys(message.params).length !== 1 || !Number.isSafeInteger(message.params.libraryId) || message.params.libraryId < 1) {
        throw new Error("library.saved-searches params require libraryId");
      }
      return { result: { searches: fixtureSavedSearches.filter(value => value.libraryId === message.params.libraryId) } };
    }
    if (message.method === "library.saved-search-items") {
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)
        || !Number.isSafeInteger(message.params.libraryId) || message.params.libraryId < 1
        || typeof message.params.searchKey !== "string" || !/^[A-Z0-9]{8}$/.test(message.params.searchKey)
        || !Number.isSafeInteger(message.params.limit) || message.params.limit < 1 || message.params.limit > 200
        || (message.params.cursor !== undefined && (typeof message.params.cursor !== "string" || !/^\d+$/.test(message.params.cursor)))) {
        throw new Error("library.saved-search-items params are invalid");
      }
      const definition = fixtureSavedSearches.find(value => value.libraryId === message.params.libraryId && value.searchKey === message.params.searchKey);
      if (!definition) throw new Error(`fixture saved search ${message.params.libraryId}/${message.params.searchKey} was not found`);
      const matches = fixtureItems.filter(item => item.libraryId === message.params.libraryId && definition.itemKeys?.includes(item.itemKey));
      const offset = Number(message.params.cursor || 0);
      const items = matches.slice(offset, offset + message.params.limit);
      const nextOffset = offset + items.length;
      return { result: { items, ...(nextOffset < matches.length && { nextCursor: String(nextOffset) }), total: matches.length } };
    }
    if (message.method === "library.tags") {
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)
        || !Number.isSafeInteger(message.params.libraryId) || message.params.libraryId < 1
        || typeof message.params.query !== "string"
        || !Number.isSafeInteger(message.params.limit) || message.params.limit < 1 || message.params.limit > 200
        || (message.params.cursor !== undefined && (typeof message.params.cursor !== "string" || !/^\d+$/.test(message.params.cursor)))) {
        throw new Error("library.tags params are invalid");
      }
      const matches = fixtureTags.filter(value => value.libraryId === message.params.libraryId)
        .filter(value => !message.params.query || value.name.toLocaleLowerCase("en-US").includes(message.params.query.toLocaleLowerCase("en-US")))
        .map(({ libraryId: _, ...value }) => value);
      const offset = Number(message.params.cursor || 0);
      const tags = matches.slice(offset, offset + message.params.limit);
      const nextOffset = offset + tags.length;
      return { result: { tags, ...(nextOffset < matches.length && { nextCursor: String(nextOffset) }), total: matches.length } };
    }
    if (message.method === "library.item-metadata") {
      validateIdentityParams(message.params, "itemKey", "library.item-metadata");
      const value = fixtureItemMetadata.find(entry => entry.libraryId === message.params.libraryId && entry.itemKey === message.params.itemKey);
      if (!value) throw new Error(`fixture item metadata ${message.params.libraryId}/${message.params.itemKey} was not found`);
      return { result: value };
    }
    if (message.method === "library.item-facts") {
      validateIdentityParams(message.params, "itemKey", "library.item-facts");
      const value = fixtureItemFacts.find(entry => entry.libraryId === message.params.libraryId && entry.itemKey === message.params.itemKey);
      if (!value) throw new Error(`fixture item facts ${message.params.libraryId}/${message.params.itemKey} was not found`);
      return { result: value };
    }
    if (message.method === "library.item-update") {
      const { expectedRevision, idempotencyKey, ...operation } = message.params || {};
      validateIdentityParams({ itemKey: operation.itemKey, libraryId: operation.libraryId }, "itemKey", "library.item-update");
      const completed = await transactionRegistry.execute({
        expectedRevision,
        idempotencyKey,
        operation,
        scope: `library:${operation.libraryId}/item:${operation.itemKey}`,
      }, async value => {
        const facts = fixtureItemFacts.find(entry => entry.libraryId === value.libraryId && entry.itemKey === value.itemKey);
        if (!facts) throw new Error(`fixture item facts ${value.libraryId}/${value.itemKey} was not found`);
        if (facts.version !== value.expectedVersion) {
          const error = new Error("fixture item version changed before update");
          error.code = "REVISION_CONFLICT";
          error.actualRevision = facts.version;
          error.expectedRevision = value.expectedVersion;
          throw error;
        }
        facts.version += 1;
        facts.synced = false;
        return { itemKey: facts.itemKey, libraryId: facts.libraryId, synced: facts.synced, version: facts.version };
      });
      return {
        ...(!completed.replayed && { event: eventJournal.publish("library.item.changed", {
          identities: [{ itemKey: operation.itemKey, libraryId: operation.libraryId }],
          revision: completed.revision,
        }) }),
        result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
    }
    if (message.method === "library.attachment") {
      validateIdentityParams(message.params, "attachmentKey", "library.attachment");
      const value = fixtureItemChildren
        .flatMap(entry => entry.attachments || [])
        .find(entry => entry.libraryId === message.params.libraryId && entry.attachmentKey === message.params.attachmentKey);
      if (!value) throw new Error(`fixture attachment ${message.params.libraryId}/${message.params.attachmentKey} was not found`);
      return { result: value };
    }
    if (message.method === "library.attachment-state") {
      validateIdentityParams(message.params, "attachmentKey", "library.attachment-state");
      const value = fixtureAttachmentStates.find(entry => entry.libraryId === message.params.libraryId && entry.attachmentKey === message.params.attachmentKey);
      if (!value) throw new Error(`fixture attachment state ${message.params.libraryId}/${message.params.attachmentKey} was not found`);
      return { result: value };
    }
    if (message.method === "library.note") {
      validateIdentityParams(message.params, "noteKey", "library.note");
      const value = fixtureNotes.find(entry => entry.libraryId === message.params.libraryId && entry.noteKey === message.params.noteKey);
      if (!value) throw new Error(`fixture note ${message.params.libraryId}/${message.params.noteKey} was not found`);
      return { result: value };
    }
    if (message.method === "library.note-update") {
      const { expectedRevision, idempotencyKey, ...operation } = message.params || {};
      validateIdentityParams({ libraryId: operation.libraryId, noteKey: operation.noteKey }, "noteKey", "library.note-update");
      const completed = await transactionRegistry.execute({
        expectedRevision, idempotencyKey, operation,
        scope: `library:${operation.libraryId}/note:${operation.noteKey}`,
      }, async value => {
        const note = fixtureNotes.find(entry => entry.libraryId === value.libraryId && entry.noteKey === value.noteKey);
        if (!note) throw new Error(`fixture note ${value.libraryId}/${value.noteKey} was not found`);
        if (note.version !== value.expectedVersion) {
          const error = new Error("fixture Note version changed before update");
          error.code = "REVISION_CONFLICT";
          error.actualRevision = note.version;
          error.expectedRevision = value.expectedVersion;
          throw error;
        }
        if (typeof value.html !== "string") throw new Error("library.note-update html must be a string");
        note.html = value.html;
        note.version += 1;
        return { libraryId: note.libraryId, noteKey: note.noteKey, synced: false, version: note.version };
      });
      return {
        ...(!completed.replayed && { event: eventJournal.publish("library.note.changed", {
          identities: [{ itemKey: operation.noteKey, libraryId: operation.libraryId }], revision: completed.revision,
        }) }),
        result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
    }
    if (message.method === "library.annotations") {
      validateIdentityParams(message.params, "attachmentKey", "library.annotations");
      const value = fixtureAnnotations.find(entry => entry.libraryId === message.params.libraryId && entry.attachmentKey === message.params.attachmentKey);
      return { result: { annotations: value?.annotations || [] } };
    }
    if (message.method === "library.annotations-update") {
      const { expectedRevision, idempotencyKey, ...operation } = message.params || {};
      validateIdentityParams({ attachmentKey: operation.attachmentKey, libraryId: operation.libraryId }, "attachmentKey", "library.annotations-update");
      const completed = await transactionRegistry.execute({
        expectedRevision, idempotencyKey, operation,
        scope: `library:${operation.libraryId}/attachment:${operation.attachmentKey}`,
      }, async value => {
        const record = fixtureAnnotations.find(entry => entry.libraryId === value.libraryId && entry.attachmentKey === value.attachmentKey);
        if (!record || !Array.isArray(value.updates) || !value.updates.length) throw new Error("library.annotations-update params are invalid");
        const prepared = value.updates.map(update => {
          const annotation = record.annotations.find(entry => entry.annotationKey === update.annotationKey);
          if (!annotation) throw new Error(`fixture annotation ${value.libraryId}/${update.annotationKey} was not found`);
          if (annotation.version !== update.expectedVersion) {
            const error = new Error("fixture annotation version changed before update");
            error.code = "REVISION_CONFLICT";
            error.actualRevision = annotation.version;
            error.expectedRevision = update.expectedVersion;
            throw error;
          }
          return { annotation, update };
        });
        for (const { annotation, update } of prepared) {
          for (const field of ["color", "comment", "text"]) if (update[field] !== undefined) annotation[field] = update[field];
          annotation.version += 1;
        }
        return { annotations: prepared.map(({ annotation }) => ({ annotationKey: annotation.annotationKey, libraryId: annotation.libraryId, synced: false, version: annotation.version })) };
      });
      return {
        ...(!completed.replayed && { event: eventJournal.publish("library.annotation.changed", {
          identities: completed.result.annotations.map(value => ({ itemKey: value.annotationKey, libraryId: value.libraryId })), revision: completed.revision,
        }) }),
        result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
    }
    if (message.method === "sync.status") {
      return { result: fixture.syncStatus || { enabled: true, inProgress: false, libraries: [], offline: false, status: "" } };
    }
    if (message.method === "sync.storage-status") {
      const value = fixtureSyncStorageStatuses.find(entry => entry.libraryId === message.params?.libraryId);
      return { result: value || { conflictCount: 0, downloadAsNeeded: false, enabled: false, libraryId: message.params.libraryId, mode: "zfs" } };
    }
    if (message.method === "sync.conflicts") {
      return { result: { conflicts: fixtureSyncConflicts.filter(entry => entry.libraryId === message.params?.libraryId) } };
    }
    if (message.method === "sync.retry") {
      const { expectedRevision, idempotencyKey, ...operation } = message.params || {};
      const completed = await transactionRegistry.execute({ expectedRevision, idempotencyKey, operation, scope: "sync:retry" }, async value => ({
        completed: true,
        libraryIds: [...new Set(value.libraryIds)].sort((left, right) => left - right),
      }));
      return {
        ...(!completed.replayed && { event: eventJournal.publish("sync.completed", { ...completed.result, revision: completed.revision }) }),
        result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
    }
    if (message.method === "translation.translators") {
      return { result: { translators: fixtureTranslators.filter(value => value.kind === message.params?.kind) } };
    }
    if (message.method === "citation.styles") return { result: { styles: fixtureCitationStyles } };
    if (message.method === "citation.render") {
      const serialized = JSON.stringify(message.params);
      const value = fixtureCitationRenders.find(entry => JSON.stringify(entry.params) === serialized);
      if (!value) throw new Error("fixture citation.render params were not configured");
      return { result: value.result };
    }
    if (message.method === "translation.export") {
      const serialized = JSON.stringify(message.params);
      const value = fixtureExports.find(entry => JSON.stringify(entry.params) === serialized);
      if (!value) throw new Error("fixture translation.export params were not configured");
      return { result: value.result };
    }
    if (message.method === "translation.import") {
      const { expectedRevision, idempotencyKey, ...operation } = message.params || {};
      const completed = await transactionRegistry.execute({
        expectedRevision, idempotencyKey, operation,
        scope: `library:${operation.libraryId}/translation:import`,
      }, async value => {
        const configured = fixtureImportResults.find(entry => JSON.stringify(entry.params) === JSON.stringify(value));
        if (!configured) throw new Error("fixture translation.import params were not configured");
        return configured.result;
      });
      return {
        ...(!completed.replayed && { event: eventJournal.publish("library.items.imported", {
          identities: completed.result.items.map(value => ({ itemKey: value.itemKey, libraryId: value.libraryId })), revision: completed.revision,
        }) }),
        result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
    }
    if (message.method === "library.search") {
      validateSearchParams(message.params);
      if (typeof message.cancellationId !== "string" || message.cancellationId.length === 0) {
        throw new Error("library.search cancellationId is required");
      }
      const controller = new AbortController();
      active.set(message.cancellationId, controller);
      try {
        await waitForSearch(searchDelayMs, controller.signal);
      }
      finally {
        active.delete(message.cancellationId);
      }
      const query = message.params.query.trim().toLocaleLowerCase("en-US");
      const sortBy = message.params.sortBy || "title";
      const sortDirection = message.params.sortDirection || "asc";
      const compare = (left, right) => {
        let result;
        if (sortBy === "year") {
          const leftYear = Number.isSafeInteger(left.year) ? left.year : null;
          const rightYear = Number.isSafeInteger(right.year) ? right.year : null;
          if (leftYear === null && rightYear === null) result = 0;
          else if (leftYear === null) result = 1;
          else if (rightYear === null) result = -1;
          else result = leftYear - rightYear;
        }
        else if (sortBy === "creators") {
          result = String(left.creators?.[0] || "").localeCompare(String(right.creators?.[0] || ""));
        }
        else if (sortBy === "itemType") {
          result = String(left.itemType).localeCompare(String(right.itemType));
        }
        else {
          result = String(left.title).localeCompare(String(right.title));
        }
        if (result === 0) result = String(left.itemKey).localeCompare(String(right.itemKey));
        return sortDirection === "desc" ? -result : result;
      };
      const matches = fixtureItems
        .filter(item => message.params.collectionKey === undefined
          || (item.libraryId === message.params.libraryId && item.collectionKeys?.includes(message.params.collectionKey)))
        .filter(item => !query || [item.title, ...(item.creators || [])].some(value => String(value).toLocaleLowerCase("en-US").includes(query)))
        .sort(compare);
      const offset = Number(message.params.cursor || 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > matches.length) throw new Error("library.search cursor is outside the result set");
      const items = matches.slice(offset, offset + message.params.limit);
      const nextOffset = offset + items.length;
      const result = {
        items,
        ...(nextOffset < matches.length && { nextCursor: String(nextOffset) }),
        total: matches.length,
      };
      return {
        event: eventJournal.publish("library.search.completed", { count: result.total, query: message.params.query }),
        result,
      };
    }
    throw new Error(`unknown method ${message.method}`);
  };

  const server = net.createServer(socket => {
    const decoder = new FrameDecoder();
    let writes = Promise.resolve();
    const enqueue = message => {
      writes = writes.then(() => writeFrame(socket, message));
      writes.catch(error => socket.destroy(error));
      return writes;
    };
    socket.on("data", chunk => {
      let messages;
      try {
        messages = decoder.push(chunk);
      }
      catch (error) {
        socket.destroy(error);
        return;
      }
      for (const message of messages) {
        void Promise.resolve().then(async () => {
          let response;
          let event;
          try {
            const handled = await handle(message);
            response = { id: message.id, ok: true, result: handled.result };
            event = handled.event;
          }
          catch (error) {
            response = { id: typeof message.id === "string" ? message.id : "invalid", ok: false, error: rpcError(error) };
          }
          await enqueue(response);
          if (event) {
            await enqueue({
              ...event,
              event: true,
            });
          }
        }).catch(error => socket.destroy(error));
      }
    });
    socket.on("end", () => {
      try {
        decoder.end();
      }
      catch (error) {
        socket.destroy(error);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolvePromise);
  });
  await chmod(socketPath, 0o600);

  const shutdown = () => server.close(() => {
    void attachmentSources.dispose().finally(() => process.exit(0));
  });
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch(error => {
  process.stderr.write(`fixture Zotero Core failed: ${error.message}\n`);
  process.exitCode = 1;
});
