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

function unavailable(message) {
	let error = new Error(message);
	error.code = "UNAVAILABLE";
	return error;
}

export function openGeckoAttachmentSource(path) {
	if (typeof path !== "string" || !PathUtils.isAbsolute(path)) {
		throw unavailable("Zotero attachment path is unavailable");
	}
	let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
	file.initWithPath(path);
	if (!file.exists() || !file.isFile() || file.isSymlink()) {
		throw unavailable("Zotero attachment is not an available regular file");
	}
	let size = Number(file.fileSize);
	if (!Number.isSafeInteger(size) || size < 1) {
		throw unavailable("Zotero attachment has an invalid size");
	}
	let input = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
	let closed = false;
	try {
		input.init(file, 0x01, 0, 0);
		let seekable = input.QueryInterface(Ci.nsISeekableStream);
		let binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
		binary.setInputStream(input);
		return Object.freeze({
			size,
			async read(offset, length) {
				if (closed) throw unavailable("Zotero attachment source is closed");
				seekable.seek(Ci.nsISeekableStream.NS_SEEK_SET, offset);
				// readArrayBuffer fills the destination directly -- readByteArray would
				// materialize a JS number array of the whole chunk first.
				let buffer = new ArrayBuffer(length);
				let read = binary.readArrayBuffer(length, buffer);
				return read === length ? new Uint8Array(buffer) : new Uint8Array(buffer, 0, read);
			},
			async close() {
				if (closed) return;
				closed = true;
				binary.close();
			},
		});
	}
	catch (error) {
		try { input.close(); } catch (_) {}
		if (error?.code === "UNAVAILABLE") throw error;
		throw unavailable("Zotero attachment could not be opened");
	}
}
