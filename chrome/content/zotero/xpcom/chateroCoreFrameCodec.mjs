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

function parseJSONWithoutDuplicateKeys(text) {
	let offset = 0;
	let whitespace = /\s/;
	function skipWhitespace() {
		while (offset < text.length && whitespace.test(text[offset])) offset++;
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
	function parseNumber() {
		skipWhitespace();
		let match = text.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
		if (!match) throw new Error(`invalid JSON number at byte ${offset}`);
		offset += match[0].length;
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
		if (character === "-" || /\d/.test(character || "")) return parseNumber();
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

function concatenate(left, right) {
	let result = new Uint8Array(left.length + right.length);
	result.set(left);
	result.set(right, left.length);
	return result;
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
	#buffer = new Uint8Array();
	#expectedLength = null;
	#maxFrameBytes;
	#textDecoder = new TextDecoder("utf-8", { fatal: true });

	constructor({ maxFrameBytes = MAX_FRAME_BYTES } = {}) {
		if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
			throw new Error("maxFrameBytes must be a positive integer");
		}
		this.#maxFrameBytes = maxFrameBytes;
	}

	push(chunk) {
		if (!(chunk instanceof Uint8Array)) throw new Error("frame chunk must be bytes");
		this.#buffer = concatenate(this.#buffer, chunk);
		let messages = [];
		while (true) {
			if (this.#expectedLength === null) {
				if (this.#buffer.length < 4) break;
				this.#expectedLength = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, 4).getUint32(0, false);
				this.#buffer = this.#buffer.slice(4);
				if (!this.#expectedLength) throw new Error("Zotero Core frame length cannot be zero");
				if (this.#expectedLength > this.#maxFrameBytes) {
					throw new Error(`Zotero Core frame length ${this.#expectedLength} exceeds limit ${this.#maxFrameBytes}`);
				}
			}
			if (this.#buffer.length < this.#expectedLength) break;
			let body = this.#buffer.slice(0, this.#expectedLength);
			this.#buffer = this.#buffer.slice(this.#expectedLength);
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
		if (this.#buffer.length) throw new Error("truncated frame header");
	}
}
