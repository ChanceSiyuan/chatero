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

const DEFAULT_CAPACITY = 4096;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_REPLAY_LIMIT = 1000;
const TOPIC_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

function exactObject(value, fields, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	for (let field of Object.keys(value)) {
		if (!fields.has(field)) throw new Error(`${label} has unknown field ${field}`);
	}
}

function copyJSON(value, maxBytes) {
	let active = new Set();
	let clone = candidate => {
		if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
		if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
		if (!candidate || typeof candidate !== "object") throw new Error("Core event payload must contain only JSON values");
		if (active.has(candidate)) throw new Error("Core event payload must not be cyclic");
		active.add(candidate);
		let result;
		if (Array.isArray(candidate)) {
			result = candidate.map(clone);
		}
		else {
			result = {};
			for (let [key, child] of Object.entries(candidate)) result[key] = clone(child);
		}
		active.delete(candidate);
		return result;
	};
	let copied;
	try { copied = clone(value); }
	catch (error) { throw new Error(`Core event payload is not valid JSON: ${error.message}`); }
	let encoded = JSON.stringify(copied);
	if (typeof encoded !== "string") throw new Error("Core event payload is not valid JSON");
	if (new TextEncoder().encode(encoded).length > maxBytes) throw new Error("Core event payload exceeds its size limit");
	return copied;
}

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (let child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

export function createCoreEventJournal({
	capacity = DEFAULT_CAPACITY,
	maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
	now = Date.now,
	profileEpoch,
} = {}) {
	if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100000) {
		throw new Error("Core event capacity must be an integer from 1 through 100000");
	}
	if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1 || maxPayloadBytes > 1024 * 1024) {
		throw new Error("Core event maxPayloadBytes must be an integer from 1 through 1048576");
	}
	if (typeof now !== "function") throw new Error("Core event clock must be a function");
	if (typeof profileEpoch !== "string" || !profileEpoch) throw new Error("Core event profileEpoch is required");

	let events = [];
	let latestSequence = 0;

	return Object.freeze({
		get latestSequence() { return latestSequence; },
		publish(topic, payload) {
			if (typeof topic !== "string" || !TOPIC_PATTERN.test(topic) || topic.length > 128) {
				throw new Error("Core event topic is invalid");
			}
			let occurredAt = now();
			if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) throw new Error("Core event clock returned an invalid timestamp");
			let event = deepFreeze({
				occurredAt,
				payload: copyJSON(payload, maxPayloadBytes),
				profileEpoch,
				sequence: ++latestSequence,
				topic,
			});
			events.push(event);
			if (events.length > capacity) events.shift();
			return event;
		},
		replay(params) {
			exactObject(params, new Set(["afterSequence", "limit"]), "core.events params");
			if (!Number.isSafeInteger(params.afterSequence) || params.afterSequence < 0) {
				throw new Error("core.events afterSequence must be a non-negative safe integer");
			}
			if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > MAX_REPLAY_LIMIT) {
				throw new Error(`core.events limit must be an integer from 1 through ${MAX_REPLAY_LIMIT}`);
			}
			let oldestSequence = events[0]?.sequence ?? latestSequence + 1;
			let truncated = params.afterSequence < oldestSequence - 1;
			let replayed = events.filter(event => event.sequence > params.afterSequence).slice(0, params.limit);
			return deepFreeze({ events: replayed, latestSequence, oldestSequence, truncated });
		},
	});
}
