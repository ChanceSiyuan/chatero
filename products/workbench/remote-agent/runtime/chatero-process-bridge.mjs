#!/usr/bin/env node

import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

const REQUEST_FIELDS = ["protocolVersion", "command", "args", "cwd", "env"];
const MAX_FIRST_LINE_BYTES = 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024;

let child;
let settled = false;
let requestBytes = Buffer.alloc(0);

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function fail(error) {
  if (settled) {
    return;
  }
  settled = true;
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  process.stdin.destroy();
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function assertRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function validateRequest(value) {
  assertRecord(value, "request");
  for (const field of REQUEST_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      throw new TypeError(`${field} is required`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!REQUEST_FIELDS.includes(field)) {
      throw new TypeError(`unknown field ${field}`);
    }
  }
  if (value.protocolVersion !== 1) {
    throw new TypeError("protocolVersion must equal 1");
  }
  if (typeof value.command !== "string" || value.command.length === 0) {
    throw new TypeError("command must be a non-empty string");
  }
  if (byteLength(value.command) > MAX_ENTRY_BYTES) {
    throw new TypeError("command must not exceed 64 KiB");
  }
  if (!Array.isArray(value.args) || value.args.some(argument => typeof argument !== "string")) {
    throw new TypeError("args must be an array of strings");
  }
  for (const argument of value.args) {
    if (byteLength(argument) > MAX_ENTRY_BYTES) {
      throw new TypeError("each argument must not exceed 64 KiB");
    }
  }
  if (typeof value.cwd !== "string" || !isAbsolute(value.cwd)) {
    throw new TypeError("cwd must be an absolute path");
  }
  assertRecord(value.env, "env");
  for (const [name, entry] of Object.entries(value.env)) {
    if (typeof entry !== "string") {
      throw new TypeError(`environment entry ${name} must be a string`);
    }
    if (name.includes("\0") || name.includes("=")) {
      throw new TypeError(`environment entry name ${JSON.stringify(name)} is invalid`);
    }
    if (entry.includes("\0")) {
      throw new TypeError(`environment entry ${name} contains NUL`);
    }
    if (byteLength(`${name}=${entry}`) > MAX_ENTRY_BYTES) {
      throw new TypeError("each environment entry must not exceed 64 KiB");
    }
  }
  return value;
}

function forward(stream, type) {
  stream.on("data", data => {
    const writable = process.stdout.write(`${JSON.stringify({
      type,
      data: Buffer.from(data).toString("base64"),
    })}\n`);
    if (!writable) {
      stream.pause();
      process.stdout.once("drain", () => stream.resume());
    }
  });
}

function launch(request, remainder) {
  const options = {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  };
  if (process.platform !== "win32") {
    options.detached = true;
  }
  child = spawn(request.command, request.args, options);
  forward(child.stdout, "stdout");
  forward(child.stderr, "stderr");
  child.once("error", fail);
  child.once("close", (code, signal) => {
    if (settled) {
      return;
    }
    settled = true;
    emit({ type: "exit", code, signal });
  });

  if (remainder.length > 0) {
    child.stdin.write(remainder);
  }
  process.stdin.pipe(child.stdin);
  process.stdin.resume();
}

function acceptFirstLine(data) {
  requestBytes = Buffer.concat([requestBytes, data]);
  const newline = requestBytes.indexOf(0x0a);
  if (newline === -1) {
    if (requestBytes.length > MAX_FIRST_LINE_BYTES) {
      fail(new Error("first JSON line must not exceed 1 MiB"));
    }
    return;
  }
  if (newline > MAX_FIRST_LINE_BYTES) {
    fail(new Error("first JSON line must not exceed 1 MiB"));
    return;
  }

  process.stdin.pause();
  process.stdin.off("data", acceptFirstLine);
  const line = requestBytes.subarray(0, newline).toString("utf8");
  const remainder = requestBytes.subarray(newline + 1);
  requestBytes = Buffer.alloc(0);
  try {
    launch(validateRequest(JSON.parse(line)), remainder);
  }
  catch (error) {
    fail(error instanceof SyntaxError
      ? new TypeError(`first line is not valid JSON: ${error.message}`)
      : error);
  }
}

process.stdin.on("data", acceptFirstLine);
process.stdin.once("end", () => {
  if (!child && !settled) {
    fail(new Error("a newline-terminated SpawnRequest is required"));
  }
});
process.stdin.once("error", fail);

process.once("SIGTERM", () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    process.exitCode = 143;
    return;
  }
  try {
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    }
    else {
      process.kill(-child.pid, "SIGTERM");
    }
  }
  catch (error) {
    fail(error);
  }
});
