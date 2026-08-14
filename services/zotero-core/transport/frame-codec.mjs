import { TextDecoder } from "node:util";

import { MAX_FRAME_BYTES } from "../generated/protocol.mjs";

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
      const code = text.charCodeAt(offset);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      offset += 1;
    }
  }

  function expect(character) {
    skipWhitespace();
    if (text[offset] !== character) throw new Error(`invalid JSON at byte ${offset}`);
    offset += 1;
  }

  function parseString() {
    skipWhitespace();
    if (text[offset] !== '"') throw new Error(`invalid JSON string at byte ${offset}`);
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset));
      }
      if (character === "\\") {
        offset += 2;
      }
      else {
        if (character.charCodeAt(0) < 0x20) throw new Error(`invalid JSON string at byte ${offset}`);
        offset += 1;
      }
    }
    throw new Error("truncated JSON string");
  }

  // Scans -?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)? without copying the rest of the frame.
  function parseNumber() {
    skipWhitespace();
    const start = offset;
    if (text.charCodeAt(offset) === 0x2d) offset += 1;
    const leading = text.charCodeAt(offset);
    if (leading === 0x30) {
      offset += 1;
    }
    else if (leading >= 0x31 && leading <= 0x39) {
      while (isDigit(text.charCodeAt(offset))) offset += 1;
    }
    else {
      offset = start;
      throw new Error(`invalid JSON number at byte ${offset}`);
    }
    if (text.charCodeAt(offset) === 0x2e) {
      const mark = offset;
      offset += 1;
      if (isDigit(text.charCodeAt(offset))) {
        while (isDigit(text.charCodeAt(offset))) offset += 1;
      }
      else {
        offset = mark;
      }
    }
    const exponent = text.charCodeAt(offset);
    if (exponent === 0x65 || exponent === 0x45) {
      const mark = offset;
      offset += 1;
      const sign = text.charCodeAt(offset);
      if (sign === 0x2b || sign === 0x2d) offset += 1;
      if (isDigit(text.charCodeAt(offset))) {
        while (isDigit(text.charCodeAt(offset))) offset += 1;
      }
      else {
        offset = mark;
      }
    }
  }

  function parseArray() {
    expect("[");
    skipWhitespace();
    if (text[offset] === "]") {
      offset += 1;
      return;
    }
    while (true) {
      parseValue();
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      expect(",");
    }
  }

  function parseObject() {
    expect("{");
    const keys = new Set();
    skipWhitespace();
    if (text[offset] === "}") {
      offset += 1;
      return;
    }
    while (true) {
      const key = parseString();
      if (keys.has(key)) throw new Error(`duplicate JSON object key ${key}`);
      keys.add(key);
      expect(":");
      parseValue();
      skipWhitespace();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      expect(",");
    }
  }

  function parseValue() {
    skipWhitespace();
    const character = text[offset];
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (character === '"') return parseString();
    if (character === "-" || isDigit(text.charCodeAt(offset))) return parseNumber();
    for (const literal of ["true", "false", "null"]) {
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

export function encodeFrame(value, { maxFrameBytes = MAX_FRAME_BYTES } = {}) {
  assertPlainObject(value);
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > maxFrameBytes) {
    throw new Error(`Zotero Core frame length ${body.length} exceeds limit ${maxFrameBytes}`);
  }
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
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
    const first = this.#chunks[0];
    if (first.length >= length) {
      this.#pending -= length;
      if (first.length === length) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(length);
      return first.subarray(0, length);
    }
    const taken = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const part = this.#chunks[0];
      const size = Math.min(part.length, length - filled);
      part.copy(taken, filled, 0, size);
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
      this.#chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      this.#pending += chunk.length;
    }
    const messages = [];
    while (true) {
      if (this.#expectedLength === null) {
        if (this.#pending < 4) break;
        this.#expectedLength = this.#consume(4).readUInt32BE(0);
        if (this.#expectedLength === 0) throw new Error("Zotero Core frame length cannot be zero");
        if (this.#expectedLength > this.#maxFrameBytes) {
          throw new Error(`Zotero Core frame length ${this.#expectedLength} exceeds limit ${this.#maxFrameBytes}`);
        }
      }
      if (this.#pending < this.#expectedLength) break;
      const body = this.#consume(this.#expectedLength);
      this.#expectedLength = null;
      let text;
      try {
        text = this.#textDecoder.decode(body);
      }
      catch {
        throw new Error("Zotero Core frame is not valid UTF-8");
      }
      const message = parseJSONWithoutDuplicateKeys(text);
      assertPlainObject(message);
      messages.push(message);
    }
    return messages;
  }

  end() {
    if (this.#expectedLength !== null) throw new Error("truncated frame body");
    if (this.#pending !== 0) throw new Error("truncated frame header");
  }
}

export async function writeFrame(stream, value, options) {
  const frame = encodeFrame(value, options);
  await new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const finish = callback => value => {
      cleanup();
      callback(value);
    };
    const onDrain = finish(resolvePromise);
    const onError = finish(reject);
    const onClose = finish(() => reject(new Error("stream closed before frame drained")));
    stream.once("error", onError);
    stream.once("close", onClose);
    let accepted;
    try {
      accepted = stream.write(frame);
    }
    catch (error) {
      cleanup();
      reject(error);
      return;
    }
    if (accepted) {
      cleanup();
      resolvePromise();
    }
    else {
      stream.once("drain", onDrain);
    }
  });
}
