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
import { createCoreAttachmentUploadRegistry } from "../../../chrome/content/zotero/xpcom/chateroCoreAttachmentUploadRegistry.mjs";
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
  if (error?.code === "REVISION_CONFLICT" || error?.code === "IDEMPOTENCY_CONFLICT" || error?.code === "VERSION_CONFLICT") {
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
  if (error?.code === "SESSION_EXPIRED") {
    return { code: "UNAUTHORIZED", details: { kind: "SESSION_EXPIRED" }, message, retriable: false };
  }
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
  if (params.scope !== undefined && !["feed", "library", "trash", "unfiled"].includes(params.scope)) throw new Error("library.search scope is invalid");
  if (params.collectionKey !== undefined && params.libraryId === undefined) throw new Error("library.search collectionKey requires libraryId");
  if (params.scope !== undefined && params.libraryId === undefined) throw new Error("library.search scope requires libraryId");
  if (params.collectionKey !== undefined && params.scope !== undefined) throw new Error("library.search collectionKey and scope are mutually exclusive");
  if (params.libraryId !== undefined && params.collectionKey === undefined && params.scope === undefined) throw new Error("library.search libraryId requires a collectionKey or scope");
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
    CHATERO_CORE_SESSION_TTL_MS: rawSessionTtlMs,
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
  const fixtureLookupResults = Array.isArray(fixture?.lookupResults) ? fixture.lookupResults : [];
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
  const sessionTtlMs = rawSessionTtlMs === undefined ? undefined : Number(rawSessionTtlMs);
  if (sessionTtlMs !== undefined && (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1)) {
    throw new Error("fixture session TTL is invalid");
  }
  const eventJournal = createCoreEventJournal({ profileEpoch });
  const transactionRegistry = createCoreTransactionRegistry();
  const attachmentSources = createCoreAttachmentSourceRegistry();
  const attachmentUploads = createCoreAttachmentUploadRegistry({
    createSink: () => {
      const chunks = [];
      return {
        close() {},
        finish() { return { bytes: Buffer.concat(chunks), close() {} }; },
        write(bytes) { chunks.push(Buffer.from(bytes)); },
      };
    },
  });
  const authority = new SessionAuthority({
    bootstrapToken,
    profileEpoch,
    capabilities: CAPABILITIES,
    eventSequence: () => eventJournal.latestSequence,
    ...(sessionTtlMs !== undefined && { sessionTtlMs }),
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
    if (message.method === "core.resume") {
      const resumed = authority.resume(message.params);
      return { result: {
        ...resumed,
        ...eventJournal.replay({ afterSequence: message.params.afterSequence, limit: message.params.limit }),
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
    if (message.method === "attachment.upload-open") return { result: attachmentUploads.open({
      ...message.params, profileEpoch, sessionToken: authorizedSession.sessionToken,
    }) };
    if (message.method === "attachment.upload-write") return { result: attachmentUploads.write({
      ...message.params, profileEpoch, sessionToken: authorizedSession.sessionToken,
    }) };
    if (message.method === "attachment.upload-abort") return { result: attachmentUploads.abort({
      ...message.params, profileEpoch, sessionToken: authorizedSession.sessionToken,
    }) };
    if (message.method === "attachment.upload-commit") {
      const { expectedRevision, idempotencyKey, uploadId, ...operation } = message.params || {};
      const completed = await transactionRegistry.execute({
        expectedRevision, idempotencyKey, operation: { ...operation, uploadId }, scope: `library:${operation.libraryId}/attachment:catalog`,
      }, () => attachmentUploads.commit({ profileEpoch, sessionToken: authorizedSession.sessionToken, uploadId }, async upload => {
        const sequence = fixtureItemChildren.flatMap(entry => entry.attachments || []).length + 1;
        return { attachmentKey: `UPL${String(sequence).padStart(5, "0")}`, libraryId: operation.libraryId, ...(operation.parentItemKey && { parentItemKey: operation.parentItemKey }), synced: false, version: 1 };
      }));
      return {
        ...(!completed.replayed && { event: eventJournal.publish("library.attachment.changed", {
          identities: [{ itemKey: completed.result.attachmentKey, libraryId: completed.result.libraryId }], revision: completed.revision,
        }) }), result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
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
    if (message.method === "library.collection-mutate") {
      const { expectedRevision, idempotencyKey, ...operation } = message.params || {};
      const completed = await transactionRegistry.execute({
        expectedRevision, idempotencyKey, operation, scope: `library:${operation.libraryId}/collection:catalog`,
      }, async value => {
        let collection;
        if (value.action === "create") {
          const sequence = fixtureCollections.length + 1;
          collection = {
            childCount: 0, collectionKey: `COL${String(sequence).padStart(5, "0")}`,
            itemCount: 0, libraryId: value.libraryId, name: value.name,
            ...(value.parentKey && { parentKey: value.parentKey }), synced: false, version: 1,
          };
          fixtureCollections.push(collection);
        }
        else {
          collection = fixtureCollections.find(entry => entry.libraryId === value.libraryId && entry.collectionKey === value.collectionKey);
          if (!collection) throw new Error("fixture collection was not found");
          if (collection.version !== value.expectedVersion) throw new Error("fixture collection version changed");
          if (value.action === "delete") fixtureCollections.splice(fixtureCollections.indexOf(collection), 1);
          else {
            if (value.name !== undefined) collection.name = value.name;
            if (value.parentKey !== undefined) value.parentKey ? collection.parentKey = value.parentKey : delete collection.parentKey;
            collection.synced = false;
            collection.version += 1;
          }
        }
        return {
          action: value.action, collectionKey: collection.collectionKey, deleted: value.action === "delete",
          libraryId: collection.libraryId,
          ...(value.action !== "delete" && { name: collection.name, ...(collection.parentKey && { parentKey: collection.parentKey }), synced: collection.synced, version: collection.version }),
        };
      });
      return {
        ...(!completed.replayed && { event: eventJournal.publish("library.collection.changed", {
          action: completed.result.action, collectionKey: completed.result.collectionKey,
          libraryId: completed.result.libraryId, revision: completed.revision,
        }) }),
        result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
    }
    if (message.method === "library.batch-mutate") {
      const { expectedRevision, idempotencyKey, ...operation } = message.params || {};
      const completed = await transactionRegistry.execute({
        expectedRevision, idempotencyKey, operation, scope: `library:${operation.libraryId}/batch:catalog`,
      }, async value => {
        if (!Number.isSafeInteger(value.libraryId) || value.libraryId < 1
          || !Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > 100) {
          throw new Error("library.batch-mutate params are invalid");
        }
        const results = value.operations.map((entry, index) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)
            || typeof entry.kind !== "string" || !entry.params || entry.params.libraryId !== value.libraryId) {
            throw new Error(`library.batch-mutate operation ${index} must target the same library`);
          }
          return { kind: entry.kind, result: { libraryId: value.libraryId } };
        });
        return { results };
      });
      return {
        ...(!completed.replayed && { event: eventJournal.publish("library.batch.changed", {
          libraryId: operation.libraryId, operationCount: completed.result.results.length, revision: completed.revision,
        }) }),
        result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
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
    if (message.method === "library.fulltext-index") {
      const { expectedRevision, idempotencyKey, ...operation } = message.params || {};
      const completed = await transactionRegistry.execute({
        expectedRevision, idempotencyKey, operation, scope: "library:fulltext-index",
      }, async value => ({ attachments: value.attachments, complete: value.complete }));
      return {
        ...(!completed.replayed && { event: eventJournal.publish("library.fulltext.indexed", {
          count: completed.result.attachments.length, revision: completed.revision,
        }) }),
        result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
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
    if (message.method === "library.saved-search-mutate") {
      const { expectedRevision, idempotencyKey, ...operation } = message.params || {};
      const completed = await transactionRegistry.execute({
        expectedRevision, idempotencyKey, operation, scope: `library:${operation.libraryId}/search:catalog`,
      }, async value => {
        let search;
        if (value.action === "create") {
          search = { deleted: false, itemKeys: [], libraryId: value.libraryId, name: value.name, searchKey: `SEA${String(fixtureSavedSearches.length + 1).padStart(5, "0")}`, synced: false, version: 1 };
          fixtureSavedSearches.push(search);
        }
        else {
          search = fixtureSavedSearches.find(entry => entry.libraryId === value.libraryId && entry.searchKey === value.searchKey);
          if (!search || search.version !== value.expectedVersion) throw new Error("fixture saved search changed");
          if (value.name !== undefined) search.name = value.name;
          if (value.action === "trash") search.deleted = true;
          if (value.action === "restore") search.deleted = false;
          search.synced = false;
          search.version += 1;
        }
        return { action: value.action, deleted: Boolean(search.deleted), libraryId: search.libraryId, name: search.name, searchKey: search.searchKey, synced: search.synced, version: search.version };
      });
      return {
        ...(!completed.replayed && { event: eventJournal.publish("library.saved-search.changed", {
          action: completed.result.action, libraryId: completed.result.libraryId, revision: completed.revision, searchKey: completed.result.searchKey,
        }) }),
        result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
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
          error.code = "VERSION_CONFLICT";
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
    if (message.method === "library.item-mutate") {
      const { expectedRevision, idempotencyKey, ...operation } = message.params || {};
      const completed = await transactionRegistry.execute({
        expectedRevision, idempotencyKey, operation, scope: `library:${operation.libraryId}/item:catalog`,
      }, async value => {
        let facts;
        let summary;
        if (value.action === "create") {
          const sequence = fixtureItemFacts.length + fixtureItems.length + 1;
          const itemKey = `NEW${String(sequence).padStart(5, "0")}`;
          summary = { attachmentCount: 0, collectionKeys: value.collectionKeys || [], creators: [], itemKey, itemType: value.itemType, libraryId: value.libraryId, title: value.fields?.find(field => field.field === "title")?.value || "", };
          facts = { citationWarning: false, itemKey, libraryId: value.libraryId, relations: [], retracted: false, synced: false, version: 1 };
          fixtureItems.push(summary);
          fixtureItemFacts.push(facts);
        }
        else {
          facts = fixtureItemFacts.find(entry => entry.libraryId === value.libraryId && entry.itemKey === value.itemKey);
          summary = fixtureItems.find(entry => entry.libraryId === value.libraryId && entry.itemKey === value.itemKey);
          if (!facts || !summary) throw new Error("fixture item was not found");
          if (facts.version !== value.expectedVersion) throw new Error("fixture item version changed");
          if (value.action === "collections") summary.collectionKeys = value.collectionKeys.slice();
          if (value.action === "trash") facts.deleted = true;
          if (value.action === "restore") facts.deleted = false;
          facts.synced = false;
          facts.version += 1;
        }
        return {
          action: value.action, collectionKeys: summary.collectionKeys || [], deleted: Boolean(facts.deleted),
          itemKey: facts.itemKey, libraryId: facts.libraryId, synced: facts.synced, version: facts.version,
        };
      });
      return {
        ...(!completed.replayed && { event: eventJournal.publish("library.item.changed", {
          action: completed.result.action, identities: [{ itemKey: completed.result.itemKey, libraryId: completed.result.libraryId }], revision: completed.revision,
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
    if (message.method === "library.attachment-mutate") {
      const { expectedRevision, idempotencyKey, ...operation } = message.params || {};
      const completed = await transactionRegistry.execute({
        expectedRevision, idempotencyKey, operation, scope: `library:${operation.libraryId}/attachment:${operation.attachmentKey}`,
      }, async value => {
        const attachment = fixtureItemChildren.flatMap(entry => entry.attachments || []).find(entry => entry.libraryId === value.libraryId && entry.attachmentKey === value.attachmentKey);
        if (!attachment) throw new Error("fixture attachment was not found");
        attachment.version ||= 1;
        if (attachment.version !== value.expectedVersion) throw new Error("fixture attachment changed");
        attachment.deleted = value.action === "trash";
        attachment.synced = false;
        attachment.version += 1;
        return { action: value.action, attachmentKey: attachment.attachmentKey, deleted: attachment.deleted, libraryId: attachment.libraryId, ...(attachment.parentItemKey && { parentItemKey: attachment.parentItemKey }), synced: attachment.synced, version: attachment.version };
      });
      return {
        ...(!completed.replayed && { event: eventJournal.publish("library.attachment.changed", {
          action: completed.result.action, identities: [{ itemKey: completed.result.attachmentKey, libraryId: completed.result.libraryId }], revision: completed.revision,
        }) }), result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
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
          error.code = "VERSION_CONFLICT";
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
    if (message.method === "library.note-mutate") {
      const { expectedRevision, idempotencyKey, ...operation } = message.params || {};
      const completed = await transactionRegistry.execute({
        expectedRevision, idempotencyKey, operation, scope: `library:${operation.libraryId}/note:catalog`,
      }, async value => {
        let note;
        if (value.action === "create") {
          note = { deleted: false, html: value.html, libraryId: value.libraryId, noteKey: `NOT${String(fixtureNotes.length + 1).padStart(5, "0")}`, ...(value.parentItemKey && { parentItemKey: value.parentItemKey }), synced: false, title: "New Note", version: 1 };
          fixtureNotes.push(note);
        }
        else {
          note = fixtureNotes.find(entry => entry.libraryId === value.libraryId && entry.noteKey === value.noteKey);
          if (!note || note.version !== value.expectedVersion) throw new Error("fixture Note changed");
          note.deleted = value.action === "trash";
          note.synced = false;
          note.version += 1;
        }
        return { action: value.action, deleted: Boolean(note.deleted), libraryId: note.libraryId, noteKey: note.noteKey, ...(note.parentItemKey && { parentItemKey: note.parentItemKey }), synced: note.synced, version: note.version };
      });
      return {
        ...(!completed.replayed && { event: eventJournal.publish("library.note.changed", {
          action: completed.result.action, identities: [{ itemKey: completed.result.noteKey, libraryId: completed.result.libraryId }], revision: completed.revision,
        }) }), result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
    }
    if (message.method === "reader.state") {
      const state = fixtureAttachmentStates.find(entry => entry.libraryId === message.params?.libraryId && entry.attachmentKey === message.params?.attachmentKey);
      if (!state) throw new Error("fixture Reader attachment was not found");
      return { result: { attachmentKey: state.attachmentKey, contentType: "application/pdf", libraryId: state.libraryId, pageIndex: state.pageIndex || 0, version: state.version || 1 } };
    }
    if (message.method === "reader.state-update") {
      const { expectedRevision, idempotencyKey, ...operation } = message.params || {};
      const completed = await transactionRegistry.execute({
        expectedRevision, idempotencyKey, operation, scope: `library:${operation.libraryId}/reader:${operation.attachmentKey}`,
      }, async value => {
        const state = fixtureAttachmentStates.find(entry => entry.libraryId === value.libraryId && entry.attachmentKey === value.attachmentKey);
        if (!state || (state.version || 1) !== value.expectedVersion) throw new Error("fixture Reader state changed");
        state.pageIndex = value.pageIndex;
        return { attachmentKey: state.attachmentKey, contentType: "application/pdf", libraryId: state.libraryId, pageIndex: state.pageIndex, synced: false, version: state.version || 1 };
      });
      return { ...(!completed.replayed && { event: eventJournal.publish("reader.state.changed", { attachmentKey: completed.result.attachmentKey, libraryId: completed.result.libraryId, revision: completed.revision }) }), result: { ...completed.result, replayed: completed.replayed, revision: completed.revision } };
    }
    if (message.method === "library.annotations") {
      validateIdentityParams(message.params, "attachmentKey", "library.annotations");
      const value = fixtureAnnotations.find(entry => entry.libraryId === message.params.libraryId && entry.attachmentKey === message.params.attachmentKey);
      return { result: { annotations: value?.annotations || [] } };
    }
    if (message.method === "library.annotation-mutate") {
      const { expectedRevision, idempotencyKey, ...operation } = message.params || {};
      validateIdentityParams({ attachmentKey: operation.attachmentKey, libraryId: operation.libraryId }, "attachmentKey", "library.annotation-mutate");
      const completed = await transactionRegistry.execute({
        expectedRevision, idempotencyKey, operation,
        scope: `library:${operation.libraryId}/attachment:${operation.attachmentKey}`,
      }, async value => {
        const record = fixtureAnnotations.find(entry => entry.libraryId === value.libraryId && entry.attachmentKey === value.attachmentKey);
        if (!record || !["create", "trash", "restore"].includes(value.action)) throw new Error("library.annotation-mutate params are invalid");
        let annotation;
        if (value.action === "create") {
          if (value.annotationKey !== undefined || value.expectedVersion !== undefined) throw new Error("fixture annotation create identity is invalid");
          const index = record.annotations.length + 1;
          annotation = {
            annotationKey: `NEWANN${String(index).padStart(2, "0")}`,
            color: value.color,
            comment: value.comment || "",
            deleted: false,
            libraryId: value.libraryId,
            pageLabel: value.pageLabel || "",
            positionJson: value.positionJson,
            sortIndex: value.sortIndex,
            tags: value.tags || [],
            text: value.text || "",
            type: value.type,
            version: 1,
          };
          record.annotations.push(annotation);
        }
        else {
          annotation = record.annotations.find(entry => entry.annotationKey === value.annotationKey);
          if (!annotation || annotation.version !== value.expectedVersion) throw new Error("fixture annotation changed before mutation");
          annotation.deleted = value.action === "trash";
          annotation.version += 1;
        }
        return { action: value.action, annotation: { ...annotation }, deleted: annotation.deleted, synced: false };
      });
      return {
        ...(!completed.replayed && { event: eventJournal.publish("library.annotation.changed", {
          action: completed.result.action,
          identities: [{ itemKey: completed.result.annotation.annotationKey, libraryId: completed.result.annotation.libraryId }],
          revision: completed.revision,
        }) }),
        result: { ...completed.result, replayed: completed.replayed, revision: completed.revision },
      };
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
            error.code = "VERSION_CONFLICT";
            error.actualRevision = annotation.version;
            error.expectedRevision = update.expectedVersion;
            throw error;
          }
          return { annotation, update };
        });
        for (const { annotation, update } of prepared) {
          for (const field of ["color", "comment", "text"]) if (update[field] !== undefined) annotation[field] = update[field];
          if (update.tags !== undefined) annotation.tags = [...update.tags];
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
        errors: [],
        libraryIds: [...new Set(value.libraryIds)].sort((left, right) => left - right),
        successfulLibraryIds: [...new Set(value.libraryIds)].sort((left, right) => left - right),
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
    if (message.method === "citation.items") {
      return { result: { items: message.params.identities.map(identity => ({
        citationWarning: false,
        cslJson: JSON.stringify({ id: identity.itemKey, type: "article-journal" }),
        itemKey: identity.itemKey,
        libraryId: identity.libraryId,
        retracted: false,
      })) } };
    }
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
    if (message.method === "translation.lookup") {
      const serialized = JSON.stringify(message.params);
      const value = fixtureLookupResults.find(entry => JSON.stringify(entry.params) === serialized);
      if (!value) throw new Error("fixture translation.lookup params were not configured");
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
        .filter(item => {
          if (message.params.collectionKey !== undefined) return item.libraryId === message.params.libraryId && item.collectionKeys?.includes(message.params.collectionKey);
          if (message.params.scope === "trash") return item.libraryId === message.params.libraryId && item.deleted === true;
          if (message.params.scope === "unfiled") return item.libraryId === message.params.libraryId && item.deleted !== true && (!item.collectionKeys || item.collectionKeys.length === 0);
          if (message.params.scope !== undefined) return item.libraryId === message.params.libraryId && item.deleted !== true;
          return item.deleted !== true;
        })
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
      // library.search is read-only, so it publishes no journal event -- an event here
      // would make every event consumer re-run the search that produced it.
      return { result };
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
    void Promise.all([attachmentSources.dispose(), attachmentUploads.dispose()]).finally(() => process.exit(0));
  });
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch(error => {
  process.stderr.write(`fixture Zotero Core failed: ${error.message}\n`);
  process.exitCode = 1;
});
