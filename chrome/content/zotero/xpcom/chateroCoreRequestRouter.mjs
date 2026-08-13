/*
    ***** BEGIN LICENSE BLOCK *****

    Copyright © 2026 Chance Siyuan / Chatero contributors

    This file is part of Chatero (a Zotero fork).

    Chatero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    ***** END LICENSE BLOCK *****
*/

import {
	CAPABILITIES,
	METHOD_CAPABILITIES,
	PROTOCOL_VERSION,
} from "../modules/chateroCoreProtocol.mjs";
import { createCoreEventJournal } from "./chateroCoreEventJournal.mjs";
import { createCoreAttachmentSourceRegistry } from "./chateroCoreAttachmentSourceRegistry.mjs";
import { createCoreTransactionRegistry } from "./chateroCoreTransactionRegistry.mjs";
import { createCoreAttachmentUploadRegistry } from "./chateroCoreAttachmentUploadRegistry.mjs";

const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_DEADLINE_HORIZON_MS = 2 * 60 * 1000;
const MAX_ERROR_MESSAGE = 512;

function secretEqual(left, right) {
	let leftValue = typeof left === "string" ? left : "";
	let rightValue = typeof right === "string" ? right : "";
	let mismatch = leftValue.length ^ rightValue.length;
	let length = Math.max(leftValue.length, rightValue.length, 1);
	for (let index = 0; index < length; index++) {
		mismatch |= (leftValue.charCodeAt(index % Math.max(leftValue.length, 1)) || 0)
			^ (rightValue.charCodeAt(index % Math.max(rightValue.length, 1)) || 0);
	}
	return mismatch === 0 && typeof left === "string" && typeof right === "string";
}

function defaultToken() {
	if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
	throw new Error("secure session token generation is unavailable");
}

function validateRouterOptions(options) {
	if (!options?.adapter
			|| typeof options.adapter.annotations !== "function"
			|| typeof options.adapter.updateAnnotations !== "function"
			|| typeof options.adapter.attachment !== "function"
			|| typeof options.adapter.attachmentState !== "function"
			|| typeof options.adapter.attachmentSource !== "function"
			|| typeof options.adapter.importAttachment !== "function"
			|| typeof options.adapter.mutateAttachment !== "function"
			|| typeof options.adapter.collections !== "function"
			|| typeof options.adapter.mutateCollection !== "function"
			|| typeof options.adapter.feeds !== "function"
			|| typeof options.adapter.duplicates !== "function"
			|| typeof options.adapter.fulltextSearch !== "function"
			|| typeof options.adapter.indexFulltext !== "function"
			|| typeof options.adapter.itemChildren !== "function"
			|| typeof options.adapter.itemMetadata !== "function"
			|| typeof options.adapter.itemFacts !== "function"
			|| typeof options.adapter.updateItem !== "function"
			|| typeof options.adapter.mutateItem !== "function"
			|| typeof options.adapter.libraries !== "function"
			|| typeof options.adapter.note !== "function"
			|| typeof options.adapter.updateNote !== "function"
			|| typeof options.adapter.mutateNote !== "function"
			|| typeof options.adapter.readerState !== "function"
			|| typeof options.adapter.updateReaderState !== "function"
			|| typeof options.adapter.profileBackup !== "function"
			|| typeof options.adapter.profileStatus !== "function"
			|| typeof options.adapter.profileMigrate !== "function"
			|| typeof options.adapter.savedSearches !== "function"
			|| typeof options.adapter.mutateSavedSearch !== "function"
			|| typeof options.adapter.savedSearchItems !== "function"
			|| typeof options.adapter.search !== "function"
			|| typeof options.adapter.tags !== "function"
			|| typeof options.adapter.syncStatus !== "function"
			|| typeof options.adapter.syncStorageStatus !== "function"
			|| typeof options.adapter.syncConflicts !== "function"
			|| typeof options.adapter.retrySync !== "function"
			|| typeof options.adapter.translators !== "function"
			|| typeof options.adapter.citationStyles !== "function"
			|| typeof options.adapter.citationItems !== "function"
			|| typeof options.adapter.renderCitation !== "function"
			|| typeof options.adapter.exportItems !== "function"
			|| typeof options.adapter.importItems !== "function"
			|| typeof options.adapter.lookupIdentifiers !== "function") {
		throw new Error("Gecko Core router requires Profile and Library adapters");
	}
	if (typeof options.bootstrapToken !== "string" || options.bootstrapToken.length < 24) {
		throw new Error("Gecko Core bootstrapToken must contain at least 24 characters");
	}
	if (typeof options.profileEpoch !== "string" || !options.profileEpoch) throw new Error("Gecko Core profileEpoch is required");
	if (typeof options.profileName !== "string" || !options.profileName) throw new Error("Gecko Core profileName is required");
	if (typeof options.upstreamVersion !== "string" || !options.upstreamVersion) throw new Error("Gecko Core upstreamVersion is required");
	if (!Number.isSafeInteger(options.schemaVersion) || options.schemaVersion < 1) throw new Error("Gecko Core schemaVersion is invalid");
}

export function mapGeckoCoreError(error) {
	let message = String(error?.message || error).slice(0, MAX_ERROR_MESSAGE);
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
	if (/deadline|profile epoch|session|authentication|bootstrap|protocol version/.test(message)) {
		return { code: "UNAUTHORIZED", message, retriable: false };
	}
	if (/params|query|limit|cursor|libraryId|parentKey|collectionKey|attachmentKey|offset|length|sourceId/.test(message)) {
		return { code: "INVALID_PARAMS", message, retriable: false };
	}
	if (/unknown method/.test(message)) return { code: "METHOD_NOT_FOUND", message, retriable: false };
	return { code: "CORE_ERROR", message, retriable: false };
}

export function createGeckoCoreRequestRouter(options = {}) {
	validateRouterOptions(options);
	let {
		adapter,
		profileEpoch,
		profileName,
		schemaVersion,
		upstreamVersion,
	} = options;
	let now = options.now || Date.now;
	let randomToken = options.randomToken || defaultToken;
	let bootstrapToken = options.bootstrapToken;
	let bootstrapConsumed = false;
	let sessions = new Map();
	let active = new Map();
	let eventJournal = options.eventJournal || createCoreEventJournal({ profileEpoch, now });
	let attachmentSources = options.attachmentSources || createCoreAttachmentSourceRegistry({ now });
	let attachmentUploads = options.attachmentUploads || createCoreAttachmentUploadRegistry({ now });
	let transactionRegistry = options.transactionRegistry || createCoreTransactionRegistry();

	function authorize(message, capability) {
		if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("request must be an object");
		if (typeof message.id !== "string" || !message.id || message.id.length > 128) throw new Error("request id must be bounded");
		if (!Number.isSafeInteger(message.deadline)) throw new Error("request deadline must be an integer timestamp");
		let current = now();
		if (message.deadline <= current) throw new Error("request deadline expired");
		if (message.deadline > current + MAX_DEADLINE_HORIZON_MS) throw new Error("request deadline exceeds the permitted horizon");
		if (message.profileEpoch !== profileEpoch) throw new Error("request profile epoch does not match");
		let session = sessions.get(message.sessionToken);
		if (!session) throw new Error("session authentication failed");
		if (session.expiresAt <= current) {
			sessions.delete(message.sessionToken);
			throw new Error("session expired");
		}
		if (capability && !session.capabilities.has(capability)) throw new Error(`session is missing capability ${capability}`);
	}

	function handshake(params) {
		if (bootstrapConsumed) throw new Error("bootstrap token was already consumed");
		if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("core.handshake params must be an object");
		if (!secretEqual(params.bootstrapToken, bootstrapToken)) throw new Error("bootstrap authentication failed");
		if (params.protocolVersion !== PROTOCOL_VERSION) {
			throw new Error(`protocol version ${params.protocolVersion} is incompatible with ${PROTOCOL_VERSION}`);
		}
		if (!Array.isArray(params.requestedCapabilities)) throw new Error("requestedCapabilities must be an array");
		let selected = [...new Set(params.requestedCapabilities)].sort();
		for (let capability of selected) {
			if (!CAPABILITIES.includes(capability)) throw new Error(`unsupported capability ${capability}`);
		}
		let sessionToken = randomToken();
		if (typeof sessionToken !== "string" || sessionToken.length < 16 || sessions.has(sessionToken)) {
			throw new Error("session token generator returned an unsafe token");
		}
		let expiresAt = now() + SESSION_TTL_MS;
		sessions.set(sessionToken, { capabilities: new Set(selected), expiresAt });
		bootstrapConsumed = true;
		bootstrapToken = "";
		return {
			capabilities: selected,
			eventSequence: eventJournal.latestSequence,
			expiresAt,
			profileEpoch,
			protocolVersion: PROTOCOL_VERSION,
			sessionToken,
			upstreamVersion,
		};
	}

	function resume(params) {
		if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("core.resume params must be an object");
		let allowed = new Set(["afterSequence", "limit", "profileEpoch", "protocolVersion", "sessionToken"]);
		if (Object.keys(params).some(key => !allowed.has(key))) throw new Error("core.resume params contain an unknown field");
		if (params.protocolVersion !== PROTOCOL_VERSION) throw new Error(`protocol version ${params.protocolVersion} is incompatible with ${PROTOCOL_VERSION}`);
		if (params.profileEpoch !== profileEpoch) throw new Error("resume profile epoch does not match");
		let session = sessions.get(params.sessionToken);
		let current = now();
		if (!session) throw new Error("session authentication failed");
		if (session.expiresAt <= current) {
			sessions.delete(params.sessionToken);
			throw new Error("session expired");
		}
		let replay = eventJournal.replay({ afterSequence: params.afterSequence, limit: params.limit });
		return {
			capabilities: [...session.capabilities].sort(),
			expiresAt: session.expiresAt,
			profileEpoch,
			protocolVersion: PROTOCOL_VERSION,
			sessionToken: params.sessionToken,
			upstreamVersion,
			...replay,
		};
	}

	return Object.freeze({
		async dispose() { await Promise.all([attachmentSources.dispose(), attachmentUploads.dispose()]); },
		publishEvent(topic, payload) { return eventJournal.publish(topic, payload); },
		subscribeEvents(listener) { return eventJournal.subscribe(listener); },
		async handle(message) {
			if (message?.method === "core.handshake") return { result: handshake(message.params) };
			if (message?.method === "core.resume") return { result: resume(message.params) };
			if (!Object.hasOwn(METHOD_CAPABILITIES, message?.method)) throw new Error(`unknown method ${message?.method}`);
			authorize(message, METHOD_CAPABILITIES[message.method]);
			if (message.method === "core.cancel") {
				if (!message.params || typeof message.params.cancellationId !== "string") {
					throw new Error("core.cancel params must include cancellationId");
				}
				let controller = active.get(message.params.cancellationId);
				controller?.abort();
				return { result: { cancelled: Boolean(controller) } };
			}
			if (message.method === "core.events") {
				return { result: eventJournal.replay(message.params) };
			}
			if (message.method === "attachment.open") {
				let source = await adapter.attachmentSource(message.params);
				try {
					return { result: attachmentSources.open({
						...message.params,
						profileEpoch,
						sessionToken: message.sessionToken,
						source,
					}) };
				}
				catch (error) {
					await source.close().catch(() => {});
					throw error;
				}
			}
			if (message.method === "attachment.read") {
				return { result: await attachmentSources.read({
					...message.params,
					profileEpoch,
					sessionToken: message.sessionToken,
				}) };
			}
			if (message.method === "attachment.close") {
				return { result: await attachmentSources.close({
					...message.params,
					profileEpoch,
					sessionToken: message.sessionToken,
				}) };
			}
			if (message.method === "attachment.upload-open") {
				return { result: attachmentUploads.open({ ...message.params, profileEpoch, sessionToken: message.sessionToken }) };
			}
			if (message.method === "attachment.upload-write") {
				return { result: attachmentUploads.write({ ...message.params, profileEpoch, sessionToken: message.sessionToken }) };
			}
			if (message.method === "attachment.upload-abort") {
				return { result: attachmentUploads.abort({ ...message.params, profileEpoch, sessionToken: message.sessionToken }) };
			}
			if (message.method === "attachment.upload-commit") {
				let { expectedRevision, idempotencyKey, uploadId, ...operation } = message.params || {};
				let completed = await transactionRegistry.execute({
					expectedRevision, idempotencyKey, operation: { ...operation, uploadId },
					scope: `library:${operation.libraryId}/attachment:catalog`,
				}, () => attachmentUploads.commit({ profileEpoch, sessionToken: message.sessionToken, uploadId }, upload => adapter.importAttachment(operation, upload)));
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("library.attachment.changed", {
						identities: [{ itemKey: result.attachmentKey, libraryId: result.libraryId }], revision: completed.revision,
					}) }), result,
				};
			}
			if (message.method === "profile.status") {
				return { result: await adapter.profileStatus(message.params) };
			}
			if (message.method === "profile.backup") {
				let completed = await transactionRegistry.execute({
					expectedRevision: message.params?.expectedRevision,
					idempotencyKey: message.params?.idempotencyKey,
					operation: { kind: "profile-backup" },
					scope: "profile:backup",
				}, () => adapter.profileBackup());
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("profile.backup.completed", { revision: completed.revision }) }),
					result,
				};
			}
			if (message.method === "profile.migrate") {
				let completed = await transactionRegistry.execute({
					expectedRevision: message.params?.expectedRevision,
					idempotencyKey: message.params?.idempotencyKey,
					operation: { kind: "profile-migrate" },
					scope: "profile:migrate",
				}, () => adapter.profileMigrate());
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("profile.migration.completed", {
						migrated: result.migrated, revision: completed.revision, schemaVersion: result.schemaVersion,
					}) }),
					result,
				};
			}
			if (message.method === "library.annotations") return { result: await adapter.annotations(message.params) };
			if (message.method === "library.annotations-update") {
				let { expectedRevision, idempotencyKey, ...operation } = message.params || {};
				let completed = await transactionRegistry.execute({
					expectedRevision,
					idempotencyKey,
					operation,
					scope: `library:${operation.libraryId}/attachment:${operation.attachmentKey}`,
				}, value => adapter.updateAnnotations(value));
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("library.annotation.changed", {
						identities: result.annotations.map(value => ({ itemKey: value.annotationKey, libraryId: value.libraryId })),
						revision: completed.revision,
					}) }),
					result,
				};
			}
			if (message.method === "library.attachment") return { result: await adapter.attachment(message.params) };
			if (message.method === "library.attachment-state") return { result: await adapter.attachmentState(message.params) };
			if (message.method === "library.attachment-mutate") {
				let { expectedRevision, idempotencyKey, ...operation } = message.params || {};
				let completed = await transactionRegistry.execute({
					expectedRevision, idempotencyKey, operation, scope: `library:${operation.libraryId}/attachment:${operation.attachmentKey}`,
				}, value => adapter.mutateAttachment(value));
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("library.attachment.changed", {
						action: result.action, identities: [{ itemKey: result.attachmentKey, libraryId: result.libraryId }], revision: completed.revision,
					}) }), result,
				};
			}
			if (message.method === "library.collections") return { result: await adapter.collections(message.params) };
			if (message.method === "library.collection-mutate") {
				let { expectedRevision, idempotencyKey, ...operation } = message.params || {};
				let completed = await transactionRegistry.execute({
					expectedRevision, idempotencyKey, operation, scope: `library:${operation.libraryId}/collection:catalog`,
				}, value => adapter.mutateCollection(value));
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("library.collection.changed", {
						action: result.action, collectionKey: result.collectionKey,
						libraryId: result.libraryId, revision: completed.revision,
					}) }),
					result,
				};
			}
			if (message.method === "library.feeds") return { result: await adapter.feeds(message.params) };
			if (message.method === "library.duplicates") return { result: await adapter.duplicates(message.params) };
			if (message.method === "library.fulltext-search") return { result: await adapter.fulltextSearch(message.params) };
			if (message.method === "library.fulltext-index") {
				let { expectedRevision, idempotencyKey, ...operation } = message.params || {};
				let completed = await transactionRegistry.execute({
					expectedRevision, idempotencyKey, operation, scope: "library:fulltext-index",
				}, value => adapter.indexFulltext(value));
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("library.fulltext.indexed", {
						count: result.attachments.length, revision: completed.revision,
					}) }),
					result,
				};
			}
			if (message.method === "library.item-children") return { result: await adapter.itemChildren(message.params) };
			if (message.method === "library.item-metadata") return { result: await adapter.itemMetadata(message.params) };
			if (message.method === "library.item-facts") return { result: await adapter.itemFacts(message.params) };
			if (message.method === "library.item-update") {
				let { expectedRevision, idempotencyKey, ...operation } = message.params || {};
				let completed = await transactionRegistry.execute({
					expectedRevision,
					idempotencyKey,
					operation,
					scope: `library:${operation.libraryId}/item:${operation.itemKey}`,
				}, value => adapter.updateItem(value));
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("library.item.changed", {
						identities: [{ itemKey: result.itemKey, libraryId: result.libraryId }],
						revision: completed.revision,
					}) }),
					result,
				};
			}
			if (message.method === "library.item-mutate") {
				let { expectedRevision, idempotencyKey, ...operation } = message.params || {};
				let completed = await transactionRegistry.execute({
					expectedRevision, idempotencyKey, operation, scope: `library:${operation.libraryId}/item:catalog`,
				}, value => adapter.mutateItem(value));
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("library.item.changed", {
						action: result.action, identities: [{ itemKey: result.itemKey, libraryId: result.libraryId }],
						revision: completed.revision,
					}) }),
					result,
				};
			}
			if (message.method === "library.libraries") return { result: await adapter.libraries(message.params) };
			if (message.method === "library.note") return { result: await adapter.note(message.params) };
			if (message.method === "library.note-update") {
				let { expectedRevision, idempotencyKey, ...operation } = message.params || {};
				let completed = await transactionRegistry.execute({
					expectedRevision,
					idempotencyKey,
					operation,
					scope: `library:${operation.libraryId}/note:${operation.noteKey}`,
				}, value => adapter.updateNote(value));
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("library.note.changed", {
						identities: [{ itemKey: result.noteKey, libraryId: result.libraryId }],
						revision: completed.revision,
					}) }),
					result,
				};
			}
			if (message.method === "library.note-mutate") {
				let { expectedRevision, idempotencyKey, ...operation } = message.params || {};
				let completed = await transactionRegistry.execute({
					expectedRevision, idempotencyKey, operation, scope: `library:${operation.libraryId}/note:catalog`,
				}, value => adapter.mutateNote(value));
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("library.note.changed", {
						action: result.action, identities: [{ itemKey: result.noteKey, libraryId: result.libraryId }], revision: completed.revision,
					}) }), result,
				};
			}
			if (message.method === "reader.state") return { result: await adapter.readerState(message.params) };
			if (message.method === "reader.state-update") {
				let { expectedRevision, idempotencyKey, ...operation } = message.params || {};
				let completed = await transactionRegistry.execute({
					expectedRevision, idempotencyKey, operation, scope: `library:${operation.libraryId}/reader:${operation.attachmentKey}`,
				}, value => adapter.updateReaderState(value));
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("reader.state.changed", {
						attachmentKey: result.attachmentKey, libraryId: result.libraryId, revision: completed.revision,
					}) }), result,
				};
			}
			if (message.method === "library.saved-searches") return { result: await adapter.savedSearches(message.params) };
			if (message.method === "library.saved-search-mutate") {
				let { expectedRevision, idempotencyKey, ...operation } = message.params || {};
				let completed = await transactionRegistry.execute({
					expectedRevision, idempotencyKey, operation, scope: `library:${operation.libraryId}/search:catalog`,
				}, value => adapter.mutateSavedSearch(value));
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("library.saved-search.changed", {
						action: result.action, libraryId: result.libraryId, revision: completed.revision, searchKey: result.searchKey,
					}) }),
					result,
				};
			}
			if (message.method === "library.saved-search-items") return { result: await adapter.savedSearchItems(message.params) };
			if (message.method === "library.tags") return { result: await adapter.tags(message.params) };
			if (message.method === "translation.translators") return { result: await adapter.translators(message.params) };
			if (message.method === "translation.export") return { result: await adapter.exportItems(message.params) };
			if (message.method === "translation.import") {
				let { expectedRevision, idempotencyKey, ...operation } = message.params || {};
				let completed = await transactionRegistry.execute({
					expectedRevision,
					idempotencyKey,
					operation,
					scope: `library:${operation.libraryId}/translation:import`,
				}, value => adapter.importItems(value));
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("library.items.imported", {
						identities: result.items.map(value => ({ itemKey: value.itemKey, libraryId: value.libraryId })),
						revision: completed.revision,
					}) }),
					result,
				};
			}
			if (message.method === "translation.lookup") return { result: await adapter.lookupIdentifiers(message.params) };
			if (message.method === "citation.styles") return { result: await adapter.citationStyles(message.params) };
			if (message.method === "citation.items") return { result: await adapter.citationItems(message.params) };
			if (message.method === "citation.render") return { result: await adapter.renderCitation(message.params) };
			if (message.method === "sync.status") return { result: await adapter.syncStatus(message.params) };
			if (message.method === "sync.storage-status") return { result: await adapter.syncStorageStatus(message.params) };
			if (message.method === "sync.conflicts") return { result: await adapter.syncConflicts(message.params) };
			if (message.method === "sync.retry") {
				let { expectedRevision, idempotencyKey, ...operation } = message.params || {};
				let completed = await transactionRegistry.execute({
					expectedRevision,
					idempotencyKey,
					operation,
					scope: "sync:retry",
				}, value => adapter.retrySync(value));
				let result = { ...completed.result, replayed: completed.replayed, revision: completed.revision };
				return {
					...(!completed.replayed && { event: eventJournal.publish("sync.completed", {
						completed: result.completed,
						libraryIds: result.libraryIds,
						revision: completed.revision,
					}) }),
					result,
				};
			}
			if (message.method === "library.search") {
				if (typeof message.cancellationId !== "string" || !message.cancellationId) {
					throw new Error("library.search cancellationId is required");
				}
				let controller = new AbortController();
				active.set(message.cancellationId, controller);
				try {
					let result = await adapter.search(message.params, { signal: controller.signal });
					return {
						event: eventJournal.publish("library.search.completed", { count: result.total, query: message.params.query }),
						result,
					};
				}
				finally {
					if (active.get(message.cancellationId) === controller) active.delete(message.cancellationId);
				}
			}
			throw new Error(`unknown method ${message.method}`);
		},
	});
}
