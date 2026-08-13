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

const UPLOAD_LIFETIME_MS = 5 * 60 * 1000;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function unavailable() {
	let error = new Error("The authorized attachment upload is unavailable");
	error.code = "UNAVAILABLE";
	return error;
}

function exactObject(value, fields, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	for (let field of Object.keys(value)) if (!fields.has(field)) throw new Error(`${label} has unknown field ${field}`);
}

function encode(bytes) {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decode(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("attachment upload chunk is not valid base64url");
	let padding = "=".repeat((4 - value.length % 4) % 4);
	let binary;
	try { binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding); }
	catch (_) { throw new Error("attachment upload chunk is not valid base64url"); }
	let bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
	if (!bytes.length || bytes.length > MAX_CHUNK_BYTES || encode(bytes) !== value.replace(/=+$/g, "")) throw new Error("attachment upload chunk is invalid or oversized");
	return bytes;
}

function defaultRandomBytes(length) {
	let bytes = new Uint8Array(length);
	if (!globalThis.crypto?.getRandomValues) throw new Error("secure attachment upload entropy is unavailable");
	globalThis.crypto.getRandomValues(bytes);
	return bytes;
}

function defaultSink(byteCount) {
	let file = Services.dirsvc.get("TmpD", Ci.nsIFile);
	file.append("chatero-core-upload");
	file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
	let output = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
	output.init(file, 0x02 | 0x08 | 0x20, 0o600, 0);
	let binary = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
	binary.setOutputStream(output);
	let finished = false;
	let removed = false;
	let cleanup = () => {
		if (removed) return;
		removed = true;
		try { file.remove(false); } catch (_) {}
	};
	return {
		write(bytes) { binary.writeByteArray(bytes); },
		finish() {
			binary.flush();
			binary.close();
			finished = true;
			let fileInput = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
			fileInput.init(file, 0x01, 0o400, 0);
			let pipe = Cc["@mozilla.org/pipe;1"].createInstance(Ci.nsIPipe);
			pipe.init(true, true, 0, 0xffffffff, null);
			let { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
			NetUtil.asyncCopy(fileInput, pipe.outputStream, status => {
				if (!Components.isSuccessCode(status)) try { pipe.outputStream.close(); } catch (_) {}
			});
			return pipe.inputStream.QueryInterface(Ci.nsIAsyncInputStream);
		},
		close() {
			if (!finished) try { binary.close(); } catch (_) {}
			cleanup();
		},
	};
}

export function createCoreAttachmentUploadRegistry({
	createSink = defaultSink,
	now = Date.now,
	randomBytes = defaultRandomBytes,
	setTimeout = globalThis.setTimeout,
	clearTimeout = globalThis.clearTimeout,
} = {}) {
	let entries = new Map();
	let disposed = false;
	let consume = id => {
		let entry = entries.get(id);
		if (!entry) return null;
		entries.delete(id);
		clearTimeout(entry.timer);
		return entry;
	};
	let authorize = value => {
		if (typeof value.uploadId !== "string" || !UPLOAD_ID_PATTERN.test(value.uploadId)) throw unavailable();
		let entry = entries.get(value.uploadId);
		if (!entry || now() >= entry.expiresAt || entry.profileEpoch !== value.profileEpoch || entry.sessionToken !== value.sessionToken) {
			let spent = consume(value.uploadId);
			spent?.sink.close();
			throw unavailable();
		}
		return entry;
	};
	return Object.freeze({
		open(value) {
			if (disposed) throw unavailable();
			exactObject(value, new Set(["byteCount", "contentType", "filename", "profileEpoch", "sessionToken"]), "attachment upload open");
			if (!Number.isSafeInteger(value.byteCount) || value.byteCount < 1 || value.byteCount > MAX_UPLOAD_BYTES) throw new Error("attachment upload byteCount is invalid");
			if (typeof value.contentType !== "string" || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(value.contentType)) throw new Error("attachment upload contentType is invalid");
			if (typeof value.filename !== "string" || !value.filename || value.filename.length > 255 || /[\\/\0]/.test(value.filename)) throw new Error("attachment upload filename is invalid");
			if (typeof value.profileEpoch !== "string" || !value.profileEpoch || typeof value.sessionToken !== "string" || value.sessionToken.length < 16) throw unavailable();
			let uploadId;
			for (let attempt = 0; attempt < 8; attempt++) {
				uploadId = encode(randomBytes(32));
				if (UPLOAD_ID_PATTERN.test(uploadId) && !entries.has(uploadId)) break;
				uploadId = null;
			}
			if (!uploadId) throw new Error("could not allocate an attachment upload id");
			let sink = createSink(value.byteCount);
			if (!sink || ![sink.write, sink.finish, sink.close].every(method => typeof method === "function")) throw new Error("attachment upload sink is invalid");
			let expiresAt = now() + UPLOAD_LIFETIME_MS;
			let timer = setTimeout(() => consume(uploadId)?.sink.close(), UPLOAD_LIFETIME_MS);
			timer?.unref?.();
			entries.set(uploadId, { ...value, expiresAt, offset: 0, sink, timer });
			return { expiresAt, nextOffset: 0, uploadId };
		},
		write(value) {
			exactObject(value, new Set(["bytesBase64url", "offset", "profileEpoch", "sessionToken", "uploadId"]), "attachment upload write");
			let entry = authorize(value);
			if (!Number.isSafeInteger(value.offset) || value.offset !== entry.offset) throw new Error("attachment upload chunk offset is not sequential");
			let bytes = decode(value.bytesBase64url);
			if (entry.offset + bytes.length > entry.byteCount) throw new Error("attachment upload exceeds declared byteCount");
			try { entry.sink.write(bytes); }
			catch (error) { consume(value.uploadId)?.sink.close(); throw error; }
			entry.offset += bytes.length;
			return { complete: entry.offset === entry.byteCount, nextOffset: entry.offset };
		},
		async commit(value, importer) {
			exactObject(value, new Set(["profileEpoch", "sessionToken", "uploadId"]), "attachment upload commit");
			let entry = authorize(value);
			if (entry.offset !== entry.byteCount) throw new Error("attachment upload is incomplete");
			if (typeof importer !== "function") throw new Error("attachment upload importer is required");
			consume(value.uploadId);
			let stream;
			try { stream = entry.sink.finish(); return await importer({ ...entry, stream }); }
			finally { try { stream?.close?.(); } catch (_) {} entry.sink.close(); }
		},
		abort(value) {
			exactObject(value, new Set(["profileEpoch", "sessionToken", "uploadId"]), "attachment upload abort");
			authorize(value);
			consume(value.uploadId)?.sink.close();
			return { aborted: true };
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			for (let id of [...entries.keys()]) consume(id)?.sink.close();
		},
	});
}
