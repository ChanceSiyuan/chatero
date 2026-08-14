import { posix } from "node:path";

const REQUEST_FIELDS = Object.freeze(["protocolVersion", "command", "args", "cwd", "env"]);
const STREAM_FRAME_TYPES = new Set(["stdout", "stderr"]);
const TERMINAL_FRAME_TYPES = new Set(["exit", "error"]);
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_CANONICAL_CWD_ENTRIES = 64;

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function assertPlainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function validateTextEntry(value, label, { allowEmpty = true } = {}) {
  if (typeof value !== "string" || !allowEmpty && value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be ${allowEmpty ? "a" : "a non-empty"} NUL-free string`);
  }
  if (byteLength(value) > MAX_ENTRY_BYTES) throw new TypeError(`${label} exceeds 64 KiB`);
  return value;
}

export function validateSpawnRequest(value) {
  assertPlainRecord(value, "SpawnRequest");
  exactKeys(value, REQUEST_FIELDS, "SpawnRequest");
  if (value.protocolVersion !== 1) throw new TypeError("SpawnRequest protocolVersion must equal 1");
  validateTextEntry(value.command, "command", { allowEmpty: false });
  if (!Array.isArray(value.args)) throw new TypeError("args must be an array");
  for (const argument of value.args) validateTextEntry(argument, "argument");
  validateTextEntry(value.cwd, "cwd", { allowEmpty: false });
  if (!posix.isAbsolute(value.cwd) || /[\r\n]/u.test(value.cwd)) {
    throw new TypeError("cwd must be an absolute POSIX path without controls");
  }
  assertPlainRecord(value.env, "env");
  for (const [name, entry] of Object.entries(value.env)) {
    validateTextEntry(name, "environment name", { allowEmpty: false });
    validateTextEntry(entry, `environment entry ${name}`);
    if (name.includes("=")) throw new TypeError("environment names must not contain equals signs");
    if (byteLength(`${name}=${entry}`) > MAX_ENTRY_BYTES) {
      throw new TypeError("environment entry exceeds 64 KiB");
    }
  }
  const serialized = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (serialized.length > MAX_REQUEST_BYTES) throw new TypeError("SpawnRequest exceeds 1 MiB");
  return Object.freeze({
    protocolVersion: 1,
    command: value.command,
    args: Object.freeze([...value.args]),
    cwd: value.cwd,
    env: Object.freeze({ ...value.env }),
  });
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("remote process frame contains noncanonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error("remote process frame contains noncanonical base64");
  }
  return bytes;
}

function parseFrame(line) {
  let value;
  try {
    value = JSON.parse(line);
  }
  catch (error) {
    throw new Error(`remote process frame is not valid JSON: ${error.message}`);
  }
  assertPlainRecord(value, "remote process frame");
  if (STREAM_FRAME_TYPES.has(value.type)) {
    exactKeys(value, ["type", "data"], "remote process stream frame");
    return Object.freeze({ type: value.type, data: decodeCanonicalBase64(value.data) });
  }
  if (value.type === "exit") {
    exactKeys(value, ["type", "code", "signal"], "remote process exit frame");
    if (value.code !== null && (!Number.isSafeInteger(value.code) || value.code < 0 || value.code > 255)) {
      throw new TypeError("remote process exit frame has an invalid code");
    }
    if (value.signal !== null && (typeof value.signal !== "string" || !/^SIG[A-Z0-9]+$/u.test(value.signal))) {
      throw new TypeError("remote process exit frame has an invalid signal");
    }
    if (value.code === null && value.signal === null) {
      throw new TypeError("remote process exit frame lacks a terminal status");
    }
    return Object.freeze({ type: "exit", code: value.code, signal: value.signal });
  }
  if (value.type === "error") {
    exactKeys(value, ["type", "message"], "remote process error frame");
    if (typeof value.message !== "string" || !value.message || byteLength(value.message) > MAX_ENTRY_BYTES) {
      throw new TypeError("remote process error frame has an invalid message");
    }
    return Object.freeze({ type: "error", message: value.message });
  }
  throw new TypeError("remote process frame has an unknown type");
}

function cancellationError(reason) {
  const error = new Error(`remote process was cancelled${reason?.message ? `: ${reason.message}` : ""}`);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

/**
 * Run one process-bridge request over an already authenticated, fixed SSH
 * channel. `stdin` is data for the child after the newline-terminated request.
 */
export function runFramedBridgeRequest(channel, request, observer = {}, {
  signal,
  stdin,
  isGenerationCurrent = () => true,
} = {}) {
  if (!channel || typeof channel.write !== "function" || typeof channel.end !== "function"
    || typeof channel.onData !== "function" || typeof channel.onClose !== "function") {
    throw new TypeError("a process bridge channel is required");
  }
  const validated = validateSpawnRequest(request);
  const requestLine = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
  const input = stdin === undefined ? null : Buffer.from(stdin);
  let buffer = Buffer.alloc(0);
  let streamBytes = 0;
  let terminal = null;
  let protocolError = null;
  let settled = false;
  const disposables = [];

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      for (const disposable of disposables) disposable?.dispose?.();
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const stopWithProtocolError = error => {
      if (protocolError || settled) return;
      protocolError = error instanceof Error ? error : new Error(String(error));
      channel.close?.();
    };
    const onAbort = () => {
      if (settled) return;
      protocolError = cancellationError(signal.reason);
      channel.close?.();
      settle(protocolError);
    };
    const consume = bytes => {
      if (settled) return;
      if (!isGenerationCurrent()) {
        stopWithProtocolError(new Error("stale remote connection generation"));
        return;
      }
      try {
        buffer = Buffer.concat([buffer, Buffer.from(bytes)]);
        if (buffer.length > MAX_FRAME_BYTES && buffer.indexOf(0x0a) < 0) {
          throw new Error("remote process frame exceeds 2 MiB");
        }
        for (;;) {
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) break;
          if (newline > MAX_FRAME_BYTES) throw new Error("remote process frame exceeds 2 MiB");
          const line = buffer.subarray(0, newline).toString("utf8");
          buffer = buffer.subarray(newline + 1);
          if (!line) throw new Error("remote process frame is empty");
          if (terminal) throw new Error("remote process emitted a frame after its terminal frame");
          const value = parseFrame(line);
          if (value.type === "stdout" || value.type === "stderr") {
            streamBytes += value.data.length;
            if (streamBytes > MAX_STREAM_BYTES) throw new Error("remote process output exceeds 64 MiB");
            const callback = value.type === "stdout" ? observer.onStdout : observer.onStderr;
            callback?.(Uint8Array.from(value.data));
          }
          else terminal = value;
        }
      }
      catch (error) {
        stopWithProtocolError(error);
      }
    };
    const close = result => {
      if (settled) return;
      if (!isGenerationCurrent() && !protocolError) {
        protocolError = new Error("stale remote connection generation");
      }
      if (protocolError) {
        settle(protocolError);
        return;
      }
      if (result?.error) {
        settle(result.error instanceof Error ? result.error : new Error(String(result.error)));
        return;
      }
      if (buffer.length) {
        settle(new Error("remote process ended with an unterminated frame"));
        return;
      }
      if (!terminal) {
        settle(new Error("remote process ended without a terminal frame"));
        return;
      }
      if (terminal.type === "error") {
        const error = new Error(`remote process bridge error: ${terminal.message}`);
        error.code = "REMOTE_PROCESS_BRIDGE";
        settle(error);
        return;
      }
      settle(null, Object.freeze({ code: terminal.code, signal: terminal.signal }));
    };

    disposables.push(channel.onData(consume));
    disposables.push(channel.onClose(close));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      channel.write(requestLine);
      if (input?.length) channel.write(input);
      channel.end();
    }
    catch (error) {
      settle(error);
    }
  });
}

export function isPathInside(root, candidate) {
  if (!posix.isAbsolute(root) || !posix.isAbsolute(candidate)) return false;
  const relative = posix.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative);
}

function sessionGeneration(session) {
  const value = session?.getPublicSession?.() ?? session;
  if (!Number.isSafeInteger(value?.generation) || value.generation < 1) {
    throw new Error("connected SSH session has no valid generation");
  }
  return value.generation;
}

export class RemoteProcessService {
  constructor({
    getSession,
    getWorkspaceFolder,
    isWorkspaceTrusted,
    canonicalizeWorkspaceCwd,
  }) {
    if (typeof getSession !== "function" || typeof getWorkspaceFolder !== "function"
      || typeof isWorkspaceTrusted !== "function" || typeof canonicalizeWorkspaceCwd !== "function") {
      throw new TypeError("remote process service dependencies are required");
    }
    this.getSession = getSession;
    this.getWorkspaceFolder = getWorkspaceFolder;
    this.isWorkspaceTrusted = isWorkspaceTrusted;
    this.canonicalizeWorkspaceCwd = canonicalizeWorkspaceCwd;
    // Canonical (root, cwd) answers are scoped to one authenticated session
    // generation, exactly the window in which a previously returned realpath is
    // already trusted. Every entry is dropped when the generation changes.
    this.canonicalCwdCache = new Map();
  }

  #canonicalCwdBucket(authority, generation) {
    const existing = this.canonicalCwdCache.get(authority);
    if (existing && existing.generation === generation) return existing;
    const bucket = { generation, entries: new Map() };
    this.canonicalCwdCache.set(authority, bucket);
    return bucket;
  }

  #rememberCanonicalCwd(bucket, authority, key, canonical) {
    if (!canonical || this.canonicalCwdCache.get(authority) !== bucket) return;
    if (bucket.entries.size >= MAX_CANONICAL_CWD_ENTRIES) bucket.entries.clear();
    bucket.entries.set(key, canonical);
  }

  async run(request, observer = {}, signal) {
    const folder = this.getWorkspaceFolder();
    const uri = folder?.uri;
    if (!uri || uri.scheme !== "vscode-remote" || typeof uri.path !== "string"
      || !uri.authority?.startsWith("chatero-remote+")) {
      throw new Error("no Chatero remote workspace is active");
    }
    if (!this.isWorkspaceTrusted()) {
      const error = new Error("remote process execution is disabled until the workspace is trusted");
      error.code = "WORKSPACE_UNTRUSTED";
      throw error;
    }
    const session = this.getSession(uri.authority);
    const generation = sessionGeneration(session);
    const requested = validateSpawnRequest({
      protocolVersion: 1,
      ...request,
      cwd: request?.cwd === undefined ? uri.path : request.cwd,
    });
    const cwdBucket = this.#canonicalCwdBucket(uri.authority, generation);
    const cwdKey = `${uri.path}\u0000${requested.cwd}`;
    const cached = cwdBucket.entries.get(cwdKey);
    const canonical = cached
      ?? await this.canonicalizeWorkspaceCwd(session, uri.path, requested.cwd, signal);
    if (!cached) this.#rememberCanonicalCwd(cwdBucket, uri.authority, cwdKey, canonical);
    const canonicalRoot = typeof canonical === "string" ? uri.path : canonical?.root;
    const canonicalCwd = typeof canonical === "string" ? canonical : canonical?.cwd;
    if (!posix.isAbsolute(canonicalRoot ?? "") || !posix.isAbsolute(canonicalCwd ?? "")
      || !isPathInside(canonicalRoot, canonicalCwd)) {
      throw new Error("remote process cwd resolves outside the selected workspace root");
    }
    if (sessionGeneration(session) !== generation) throw new Error("stale remote connection generation");
    const channel = session.openProcessBridge({ signal });
    if (channel.generation !== generation) {
      channel.close?.();
      throw new Error("stale remote process bridge generation");
    }
    return runFramedBridgeRequest(channel, {
      ...requested,
      cwd: canonicalCwd,
    }, observer, {
      signal,
      isGenerationCurrent: () => {
        try { return sessionGeneration(session) === generation; }
        catch { return false; }
      },
    });
  }
}

export const REMOTE_PROCESS_LIMITS = Object.freeze({
  requestBytes: MAX_REQUEST_BYTES,
  entryBytes: MAX_ENTRY_BYTES,
  frameBytes: MAX_FRAME_BYTES,
  streamBytes: MAX_STREAM_BYTES,
});
