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

import { SCHEMA_VERSION } from "../modules/chateroCoreProtocol.mjs";
import { GeckoFrameDecoder, encodeGeckoFrame } from "./chateroCoreFrameCodec.mjs";
import { createZoteroLibraryAdapter } from "./chateroCoreLibraryAdapter.mjs";
import { createGeckoCoreRequestRouter, mapGeckoCoreError } from "./chateroCoreRequestRouter.mjs";

const MAX_BOOTSTRAP_BYTES = 1024;

export function createGeckoCoreConnection({ profileEpoch, router, write } = {}) {
	if (typeof profileEpoch !== "string" || !profileEpoch) throw new Error("Core connection profileEpoch is required");
	if (typeof router?.handle !== "function") throw new Error("Core connection router is required");
	if (typeof write !== "function") throw new Error("Core connection write function is required");
	let decoder = new GeckoFrameDecoder();
	let lastEventSequence = 0;
	let closed = false;

	return Object.freeze({
		async push(bytes) {
			if (closed) throw new Error("Core connection is closed");
			let messages = decoder.push(bytes);
			for (let message of messages) {
				let response;
				let event;
				try {
					let handled = await router.handle(message);
					response = { id: message.id, ok: true, result: handled.result };
					event = handled.event;
				}
				catch (error) {
					response = {
						error: mapGeckoCoreError(error),
						id: typeof message.id === "string" ? message.id : "invalid",
						ok: false,
					};
				}
				await write(encodeGeckoFrame(response));
				if (event) {
					if (event.profileEpoch !== profileEpoch || !Number.isSafeInteger(event.sequence)
							|| event.sequence <= lastEventSequence) {
						throw new Error("Core router emitted an invalid event sequence");
					}
					lastEventSequence = event.sequence;
					await write(encodeGeckoFrame({
						...event,
						event: true,
					}));
				}
			}
		},
		end() {
			if (closed) return;
			closed = true;
			decoder.end();
		},
	});
}

function bytesToBinaryString(bytes) {
	let chunks = [];
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
	}
	return chunks.join("");
}

function waitUntilWritable(output) {
	return new Promise((resolve, reject) => {
		try {
			output.QueryInterface(Ci.nsIAsyncOutputStream).asyncWait({
				onOutputStreamReady() { resolve(); },
			}, 0, 0, Services.tm.currentThread);
		}
		catch (error) {
			reject(error);
		}
	});
}

async function writeAll(output, bytes) {
	let binary = bytesToBinaryString(bytes);
	let offset = 0;
	while (offset < binary.length) {
		try {
			let written = output.write(binary.slice(offset), binary.length - offset);
			if (!written) throw new Error("Core socket accepted a zero-byte write");
			offset += written;
		}
		catch (error) {
			if (error?.result !== Cr.NS_BASE_STREAM_WOULD_BLOCK) throw error;
			await waitUntilWritable(output);
		}
	}
}

function readInheritedBootstrapToken() {
	let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
	file.initWithPath("/dev/fd/3");
	let input = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
	input.init(file, 0x01, 0, 0);
	let scriptable = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
	scriptable.init(input);
	let value = "";
	try {
		while (true) {
			let available = scriptable.available();
			if (!available) break;
			value += scriptable.read(Math.min(available, MAX_BOOTSTRAP_BYTES + 1));
			if (value.length > MAX_BOOTSTRAP_BYTES) throw new Error("bootstrap secret exceeded its size limit");
		}
	}
	finally {
		scriptable.close();
	}
	let token = value.trimEnd();
	if (token.length < 24) throw new Error("bootstrap secret was missing or truncated");
	return token;
}

function requiredEnvironment(name) {
	let value = Services.env.get(name);
	if (!value) throw new Error(`Gecko Core launch environment is missing ${name}`);
	return value;
}

function socketBytes(input, count) {
	let binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
	binary.setInputStream(input);
	return Uint8Array.from(binary.readByteArray(count));
}

function attachTransport({ transport, router, profileEpoch, onClose }) {
	let input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
	let output = transport.openOutputStream(0, 0, 0);
	let processing = Promise.resolve();
	let closed = false;
	let connection = createGeckoCoreConnection({
		profileEpoch,
		router,
		write: bytes => writeAll(output, bytes),
	});
	let close = error => {
		if (closed) return;
		closed = true;
		try { connection.end(); }
		catch (endError) { error ||= endError; }
		try { input.close(); } catch (_) {}
		try { output.close(); } catch (_) {}
		try { transport.close(Cr.NS_OK); } catch (_) {}
		onClose(error);
	};
	let callback = {
		onInputStreamReady(stream) {
			if (closed) return;
			let available;
			try {
				available = stream.available();
			}
			catch (error) {
				close(error?.result === Cr.NS_BASE_STREAM_CLOSED ? null : error);
				return;
			}
			if (!available) {
				close();
				return;
			}
			let bytes;
			try {
				bytes = socketBytes(stream, available);
			}
			catch (error) {
				close(error);
				return;
			}
			processing = processing.then(() => connection.push(bytes));
			processing.catch(close);
			stream.asyncWait(callback, 0, 0, Services.tm.currentThread);
		},
	};
	input.asyncWait(callback, 0, 0, Services.tm.currentThread);
	return { close };
}

export async function startGeckoCoreHost({ Zotero, window } = {}) {
	if (!Zotero?.initialized) throw new Error("Zotero must be initialized before Gecko Core starts");
	let socketPath = requiredEnvironment("CHATERO_CORE_SOCKET_PATH");
	let profileEpoch = requiredEnvironment("CHATERO_CORE_PROFILE_EPOCH");
	let configuredProfile = requiredEnvironment("CHATERO_CORE_PROFILE_DIRECTORY");
	let actualProfile = Zotero.Profile.dir;
	if (PathUtils.normalize(configuredProfile) !== PathUtils.normalize(actualProfile)) {
		throw new Error("Gecko Core profile does not match the supervisor profile");
	}
	if (!PathUtils.isAbsolute(socketPath)) throw new Error("Gecko Core socket path must be absolute");
	if (await IOUtils.exists(socketPath)) throw new Error("Gecko Core socket path already exists");

	let bootstrapToken = readInheritedBootstrapToken();
	let adapter = createZoteroLibraryAdapter({ Zotero });
	let router = createGeckoCoreRequestRouter({
		adapter,
		bootstrapToken,
		profileEpoch,
		profileName: PathUtils.filename(actualProfile),
		schemaVersion: SCHEMA_VERSION,
		upstreamVersion: Zotero.version,
	});
	bootstrapToken = "";

	let socketFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
	socketFile.initWithPath(socketPath);
	let server = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
	server.initWithFilename(socketFile, 0o600, -1);
	let connections = new Set();
	server.asyncListen({
		onSocketAccepted(_server, transport) {
			let handle;
			handle = attachTransport({
				onClose(error) {
					connections.delete(handle);
					if (error) Zotero.logError(error);
				},
				profileEpoch,
				router,
				transport,
			});
			connections.add(handle);
		},
		onStopListening(_server, status) {
			if (status !== Cr.NS_OK) Zotero.logError(new Error(`Gecko Core socket stopped with status ${status}`));
		},
	});
	await IOUtils.setPermissions(socketPath, 0o600);
	let close = () => {
		for (let connection of connections) connection.close();
		connections.clear();
		try { server.close(); } catch (_) {}
	};
	window?.addEventListener("unload", close, { once: true });
	Zotero.addShutdownListener(close);
	return Object.freeze({ close, profileEpoch, socketPath });
}
