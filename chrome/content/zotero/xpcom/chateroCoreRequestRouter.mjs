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
			|| typeof options.adapter.attachment !== "function"
			|| typeof options.adapter.attachmentSource !== "function"
			|| typeof options.adapter.collections !== "function"
			|| typeof options.adapter.itemChildren !== "function"
			|| typeof options.adapter.itemMetadata !== "function"
			|| typeof options.adapter.libraries !== "function"
			|| typeof options.adapter.note !== "function"
			|| typeof options.adapter.profileBackup !== "function"
			|| typeof options.adapter.profileStatus !== "function"
			|| typeof options.adapter.savedSearches !== "function"
			|| typeof options.adapter.savedSearchItems !== "function"
			|| typeof options.adapter.search !== "function"
			|| typeof options.adapter.tags !== "function") {
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

	return Object.freeze({
		async dispose() { await attachmentSources.dispose(); },
		publishEvent(topic, payload) { return eventJournal.publish(topic, payload); },
		subscribeEvents(listener) { return eventJournal.subscribe(listener); },
		async handle(message) {
			if (message?.method === "core.handshake") return { result: handshake(message.params) };
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
			if (message.method === "library.annotations") return { result: await adapter.annotations(message.params) };
			if (message.method === "library.attachment") return { result: await adapter.attachment(message.params) };
			if (message.method === "library.collections") return { result: await adapter.collections(message.params) };
			if (message.method === "library.item-children") return { result: await adapter.itemChildren(message.params) };
			if (message.method === "library.item-metadata") return { result: await adapter.itemMetadata(message.params) };
			if (message.method === "library.libraries") return { result: await adapter.libraries(message.params) };
			if (message.method === "library.note") return { result: await adapter.note(message.params) };
			if (message.method === "library.saved-searches") return { result: await adapter.savedSearches(message.params) };
			if (message.method === "library.saved-search-items") return { result: await adapter.savedSearchItems(message.params) };
			if (message.method === "library.tags") return { result: await adapter.tags(message.params) };
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
