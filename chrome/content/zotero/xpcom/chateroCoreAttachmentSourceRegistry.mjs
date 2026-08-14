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

const SOURCE_LIFETIME_MS = 60_000;
// Absolute ceiling: a source that keeps being read still dies, so an abandoned or
// runaway handle can never be held open indefinitely.
const MAX_SOURCE_LIFETIME_MS = 10 * 60_000;
const MAX_READ_BYTES = 512 * 1024;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_PATTERN = /^[A-Z0-9]{8}$/;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function unavailable() {
	let error = new Error("The authorized attachment source is unavailable");
	error.code = "UNAVAILABLE";
	return error;
}

function exactObject(value, fields, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	for (let field of Object.keys(value)) if (!fields.has(field)) throw new Error(`${label} has unknown field ${field}`);
}

function validateBinding(value) {
	if (typeof value.profileEpoch !== "string" || !value.profileEpoch
			|| typeof value.sessionToken !== "string" || value.sessionToken.length < 16
			|| !Number.isSafeInteger(value.libraryId) || value.libraryId < 1
			|| typeof value.attachmentKey !== "string" || !KEY_PATTERN.test(value.attachmentKey)) {
		throw unavailable();
	}
}

// Direct, unpadded base64url -- identical output to btoa(binary).replace(...) without the
// intermediate binary string and the three whole-payload regex replacements.
function encode(bytes) {
	let chunks = [];
	let piece = "";
	let index = 0;
	let triples = bytes.length - 2;
	while (index < triples) {
		let value = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
		piece += BASE64URL_ALPHABET[(value >> 18) & 63] + BASE64URL_ALPHABET[(value >> 12) & 63]
			+ BASE64URL_ALPHABET[(value >> 6) & 63] + BASE64URL_ALPHABET[value & 63];
		index += 3;
		if (piece.length >= 0x8000) {
			chunks.push(piece);
			piece = "";
		}
	}
	if (bytes.length - index === 1) {
		let value = bytes[index];
		piece += BASE64URL_ALPHABET[value >> 2] + BASE64URL_ALPHABET[(value << 4) & 63];
	}
	else if (bytes.length - index === 2) {
		let value = (bytes[index] << 8) | bytes[index + 1];
		piece += BASE64URL_ALPHABET[value >> 10] + BASE64URL_ALPHABET[(value >> 4) & 63]
			+ BASE64URL_ALPHABET[(value << 2) & 63];
	}
	chunks.push(piece);
	return chunks.join("");
}

function defaultRandomBytes(length) {
	let bytes = new Uint8Array(length);
	if (!globalThis.crypto?.getRandomValues) throw new Error("secure attachment source entropy is unavailable");
	globalThis.crypto.getRandomValues(bytes);
	return bytes;
}

export function createCoreAttachmentSourceRegistry({
	now = Date.now,
	randomBytes = defaultRandomBytes,
	setTimeout = globalThis.setTimeout,
	clearTimeout = globalThis.clearTimeout,
} = {}) {
	if (![now, randomBytes, setTimeout, clearTimeout].every(value => typeof value === "function")) {
		throw new Error("attachment source registry dependencies are invalid");
	}
	let entries = new Map();
	let spent = new Set();
	let disposed = false;
	let closing = new Set();

	let closeSource = source => {
		let promise = Promise.resolve().then(() => source.close());
		closing.add(promise);
		void promise.finally(() => closing.delete(promise)).catch(() => {});
		return promise;
	};
	let consume = (sourceId, close = false) => {
		let entry = entries.get(sourceId);
		if (!entry) return null;
		entries.delete(sourceId);
		spent.add(sourceId);
		clearTimeout(entry.timer);
		if (close) closeSource(entry.source);
		return entry;
	};

	return Object.freeze({
		open(value) {
			if (disposed) throw unavailable();
			exactObject(value, new Set(["attachmentKey", "libraryId", "profileEpoch", "sessionToken", "source"]), "attachment source");
			validateBinding(value);
			if (!value.source || typeof value.source.read !== "function" || typeof value.source.close !== "function"
					|| !Number.isSafeInteger(value.source.size) || value.source.size < 1) throw unavailable();
			let sourceId;
			for (let attempt = 0; attempt < 8; attempt++) {
				let entropy = randomBytes(32);
				if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 32) throw new Error("attachment source entropy is invalid");
				sourceId = encode(entropy);
				if (SOURCE_ID_PATTERN.test(sourceId) && !entries.has(sourceId) && !spent.has(sourceId)) break;
				sourceId = null;
			}
			if (!sourceId) throw new Error("could not allocate an attachment source id");
			let opened = now();
			let expiresAt = opened + SOURCE_LIFETIME_MS;
			let timer = setTimeout(() => consume(sourceId, true), SOURCE_LIFETIME_MS);
			timer?.unref?.();
			entries.set(sourceId, { ...value, expiresAt, hardExpiresAt: opened + MAX_SOURCE_LIFETIME_MS, timer });
			return Object.freeze({ expiresAt, size: value.source.size, sourceId });
		},
		async read(value) {
			exactObject(value, new Set(["attachmentKey", "length", "libraryId", "offset", "profileEpoch", "sessionToken", "sourceId"]), "attachment source read");
			validateBinding(value);
			if (typeof value.sourceId !== "string" || !SOURCE_ID_PATTERN.test(value.sourceId)
					|| !Number.isSafeInteger(value.offset) || value.offset < 0
					|| !Number.isSafeInteger(value.length) || value.length < 1 || value.length > MAX_READ_BYTES) {
				throw new Error("attachment source read offset, length, or sourceId is invalid");
			}
			let entry = entries.get(value.sourceId);
			if (!entry) throw unavailable();
			if (now() >= entry.expiresAt || entry.profileEpoch !== value.profileEpoch
					|| entry.sessionToken !== value.sessionToken
					|| entry.libraryId !== value.libraryId || entry.attachmentKey !== value.attachmentKey
					|| value.offset >= entry.source.size || value.offset + value.length > entry.source.size) {
				consume(value.sourceId, true);
				throw unavailable();
			}
			let bytes = await entry.source.read(value.offset, value.length);
			if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > value.length
					|| value.offset + bytes.byteLength > entry.source.size) {
				consume(value.sourceId, true);
				throw unavailable();
			}
			// Slide the lease on use so a long sequential transfer cannot expire mid-file,
			// while the absolute ceiling still bounds the source's total lifetime.
			let current = now();
			let renewed = Math.min(current + SOURCE_LIFETIME_MS, entry.hardExpiresAt);
			if (entries.get(value.sourceId) === entry && renewed > entry.expiresAt) {
				entry.expiresAt = renewed;
				clearTimeout(entry.timer);
				entry.timer = setTimeout(() => consume(value.sourceId, true), renewed - current);
				entry.timer?.unref?.();
			}
			return Object.freeze({ bytesBase64url: encode(bytes), eof: value.offset + bytes.byteLength === entry.source.size });
		},
		async close(value) {
			exactObject(value, new Set(["profileEpoch", "sessionToken", "sourceId"]), "attachment source close");
			if (typeof value.profileEpoch !== "string" || !value.profileEpoch
					|| typeof value.sessionToken !== "string" || value.sessionToken.length < 16
					|| typeof value.sourceId !== "string" || !SOURCE_ID_PATTERN.test(value.sourceId)) throw unavailable();
			let entry = entries.get(value.sourceId);
			if (!entry) return { closed: false };
			if (entry.profileEpoch !== value.profileEpoch || entry.sessionToken !== value.sessionToken) {
				consume(value.sourceId, true);
				throw unavailable();
			}
			consume(value.sourceId);
			await closeSource(entry.source);
			return { closed: true };
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			for (let sourceId of [...entries.keys()]) consume(sourceId, true);
			await Promise.allSettled([...closing]);
		},
	});
}
