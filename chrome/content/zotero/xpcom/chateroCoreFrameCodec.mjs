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

import { MAX_FRAME_BYTES } from "../modules/chateroCoreProtocol.mjs";

function assertPlainObject(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Zotero Core frames must contain a plain object");
	}
}

function isDigit(code) {
	return code >= 0x30 && code <= 0x39;
}

function parseJSONWithoutDuplicateKeys(text) {
	let offset = 0;
	function skipWhitespace() {
		while (offset < text.length) {
			let code = text.charCodeAt(offset);
			if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
			offset++;
		}
	}
	function expect(character) {
		skipWhitespace();
		if (text[offset] !== character) throw new Error(`invalid JSON at byte ${offset}`);
		offset++;
	}
	function parseString() {
		skipWhitespace();
		if (text[offset] !== '"') throw new Error(`invalid JSON string at byte ${offset}`);
		let start = offset++;
		while (offset < text.length) {
			let character = text[offset];
			if (character === '"') return JSON.parse(text.slice(start, ++offset));
			if (character === "\\") offset += 2;
			else {
				if (character.charCodeAt(0) < 0x20) throw new Error(`invalid JSON string at byte ${offset}`);
				offset++;
			}
		}
		throw new Error("truncated JSON string");
	}
	// Scans -?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)? without copying the rest of the frame.
	function parseNumber() {
		skipWhitespace();
		let start = offset;
		if (text.charCodeAt(offset) === 0x2d) offset++;
		let leading = text.charCodeAt(offset);
		if (leading === 0x30) {
			offset++;
		}
		else if (leading >= 0x31 && leading <= 0x39) {
			while (isDigit(text.charCodeAt(offset))) offset++;
		}
		else {
			offset = start;
			throw new Error(`invalid JSON number at byte ${offset}`);
		}
		if (text.charCodeAt(offset) === 0x2e) {
			let mark = offset++;
			if (isDigit(text.charCodeAt(offset))) {
				while (isDigit(text.charCodeAt(offset))) offset++;
			}
			else {
				offset = mark;
			}
		}
		let exponent = text.charCodeAt(offset);
		if (exponent === 0x65 || exponent === 0x45) {
			let mark = offset++;
			let sign = text.charCodeAt(offset);
			if (sign === 0x2b || sign === 0x2d) offset++;
			if (isDigit(text.charCodeAt(offset))) {
				while (isDigit(text.charCodeAt(offset))) offset++;
			}
			else {
				offset = mark;
			}
		}
	}
	function parseArray() {
		expect("[");
		skipWhitespace();
		if (text[offset] === "]") return void offset++;
		while (true) {
			parseValue();
			skipWhitespace();
			if (text[offset] === "]") return void offset++;
			expect(",");
		}
	}
	function parseObject() {
		expect("{");
		let keys = new Set();
		skipWhitespace();
		if (text[offset] === "}") return void offset++;
		while (true) {
			let key = parseString();
			if (keys.has(key)) throw new Error(`duplicate JSON object key ${key}`);
			keys.add(key);
			expect(":");
			parseValue();
			skipWhitespace();
			if (text[offset] === "}") return void offset++;
			expect(",");
		}
	}
	function parseValue() {
		skipWhitespace();
		let character = text[offset];
		if (character === "{") return parseObject();
		if (character === "[") return parseArray();
		if (character === '"') return parseString();
		if (character === "-" || isDigit(text.charCodeAt(offset))) return parseNumber();
		for (let literal of ["true", "false", "null"]) {
			if (text.startsWith(literal, offset)) {
				offset += literal.length;
				return;
			}
		}
		throw new Error(`invalid JSON value at byte ${offset}`);
	}
	parseValue();
	skipWhitespace();
	if (offset !== text.length) throw new Error(`trailing JSON data at byte ${offset}`);
	return JSON.parse(text);
}

export function encodeGeckoFrame(value, { maxFrameBytes = MAX_FRAME_BYTES } = {}) {
	assertPlainObject(value);
	let body = new TextEncoder().encode(JSON.stringify(value));
	if (!body.length || body.length > maxFrameBytes) {
		throw new Error(`Zotero Core frame length ${body.length} exceeds limit ${maxFrameBytes}`);
	}
	let frame = new Uint8Array(4 + body.length);
	new DataView(frame.buffer).setUint32(0, body.length, false);
	frame.set(body, 4);
	return frame;
}

export class GeckoFrameDecoder {
	// Chunks are held until a whole header or body is available, so a large frame arriving
	// over many socket reads is copied once instead of once per read.
	#chunks = [];
	#pending = 0;
	#expectedLength = null;
	#maxFrameBytes;
	#textDecoder = new TextDecoder("utf-8", { fatal: true });

	constructor({ maxFrameBytes = MAX_FRAME_BYTES } = {}) {
		if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
			throw new Error("maxFrameBytes must be a positive integer");
		}
		this.#maxFrameBytes = maxFrameBytes;
	}

	#consume(length) {
		let first = this.#chunks[0];
		if (first.length >= length) {
			this.#pending -= length;
			if (first.length === length) this.#chunks.shift();
			else this.#chunks[0] = first.subarray(length);
			return first.subarray(0, length);
		}
		let taken = new Uint8Array(length);
		let filled = 0;
		while (filled < length) {
			let part = this.#chunks[0];
			let size = Math.min(part.length, length - filled);
			taken.set(size === part.length ? part : part.subarray(0, size), filled);
			filled += size;
			if (size === part.length) this.#chunks.shift();
			else this.#chunks[0] = part.subarray(size);
		}
		this.#pending -= length;
		return taken;
	}

	push(chunk) {
		if (!(chunk instanceof Uint8Array)) throw new Error("frame chunk must be bytes");
		if (chunk.length) {
			this.#chunks.push(chunk);
			this.#pending += chunk.length;
		}
		let messages = [];
		while (true) {
			if (this.#expectedLength === null) {
				if (this.#pending < 4) break;
				let header = this.#consume(4);
				this.#expectedLength = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, false);
				if (!this.#expectedLength) throw new Error("Zotero Core frame length cannot be zero");
				if (this.#expectedLength > this.#maxFrameBytes) {
					throw new Error(`Zotero Core frame length ${this.#expectedLength} exceeds limit ${this.#maxFrameBytes}`);
				}
			}
			if (this.#pending < this.#expectedLength) break;
			let body = this.#consume(this.#expectedLength);
			this.#expectedLength = null;
			let text;
			try {
				text = this.#textDecoder.decode(body);
			}
			catch (_) {
				throw new Error("Zotero Core frame is not valid UTF-8");
			}
			let message = parseJSONWithoutDuplicateKeys(text);
			assertPlainObject(message);
			messages.push(message);
		}
		return messages;
	}

	end() {
		if (this.#expectedLength !== null) throw new Error("truncated frame body");
		if (this.#pending) throw new Error("truncated frame header");
	}
}
