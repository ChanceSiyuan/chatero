import { randomUUID } from "node:crypto";
import net from "node:net";

import {
  DEFAULT_DEADLINE_MS,
  METHOD_CAPABILITIES,
  PROTOCOL_VERSION,
} from "../generated/protocol.mjs";
import { FrameDecoder, writeFrame } from "../transport/frame-codec.mjs";

export class CoreRPCError extends Error {
  constructor({ code = "CORE_ERROR", message = "Zotero Core request failed", retriable = false, details } = {}) {
    super(message);
    this.name = "CoreRPCError";
    this.code = code;
    this.retriable = Boolean(retriable);
    if (details !== undefined) this.details = details;
  }
}

function connectSocket(socketPath, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to Zotero Core at ${socketPath}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolvePromise(socket);
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

export async function connectCore({
  socketPath,
  bootstrapToken,
  requestedCapabilities,
  connectTimeoutMs = 1000,
  defaultDeadlineMs = DEFAULT_DEADLINE_MS,
  now = Date.now,
} = {}) {
  const socket = await connectSocket(socketPath, connectTimeoutMs);
  const decoder = new FrameDecoder();
  const eventListeners = new Set();
  const pending = new Map();
  let closed = false;
  let lastEventSequence = 0;
  let session = null;

  const rejectPending = error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.on("data", chunk => {
    let messages;
    try {
      messages = decoder.push(chunk);
    }
    catch (error) {
      socket.destroy(error);
      return;
    }
    for (const message of messages) {
      if (message.event === true) {
        if (message.profileEpoch !== session?.profileEpoch
          || !Number.isSafeInteger(message.sequence)
          || message.sequence !== lastEventSequence + 1
          || typeof message.topic !== "string") {
          socket.destroy(new Error("Zotero Core emitted an invalid event sequence"));
          return;
        }
        lastEventSequence = message.sequence;
        for (const listener of eventListeners) listener(message);
        continue;
      }
      if (typeof message.id !== "string" || !pending.has(message.id)) continue;
      const request = pending.get(message.id);
      pending.delete(message.id);
      request.cleanup();
      if (message.ok === true) request.resolve(message.result);
      else request.reject(new CoreRPCError(message.error));
    }
  });
  socket.on("error", error => rejectPending(error));
  socket.on("close", () => {
    closed = true;
    rejectPending(new Error("Zotero Core connection closed"));
  });

  async function send(method, params, { timeoutMs = defaultDeadlineMs, signal, handshake = false } = {}) {
    if (closed) throw new Error("Zotero Core client is closed");
    if (!Object.hasOwn(METHOD_CAPABILITIES, method)) throw new Error(`unknown Zotero Core method ${method}`);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
      throw new Error("request timeoutMs must be an integer from 1 through 120000");
    }
    if (signal?.aborted) throw signal.reason || new Error("Zotero Core request aborted");
    const id = randomUUID();
    const cancellationId = randomUUID();
    const request = {
      cancellationId,
      deadline: now() + timeoutMs,
      id,
      method,
      params,
      ...(!handshake && {
        profileEpoch: session.profileEpoch,
        sessionToken: session.sessionToken,
      }),
    };
    let timer;
    let abortHandler;
    const result = new Promise((resolvePromise, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      };
      pending.set(id, { cleanup, reject, resolve: resolvePromise });
      timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        cleanup();
        reject(new CoreRPCError({ code: "DEADLINE_EXCEEDED", message: `Zotero Core request ${method} timed out`, retriable: true }));
      }, timeoutMs);
      abortHandler = () => {
        if (!pending.delete(id)) return;
        cleanup();
        reject(new CoreRPCError({ code: "CANCELLED", message: `Zotero Core request ${method} was cancelled` }));
        if (!handshake && method !== "core.cancel") {
          void send("core.cancel", { cancellationId }, { timeoutMs: 1000 }).catch(() => {});
        }
      };
      signal?.addEventListener("abort", abortHandler, { once: true });
    });
    try {
      await writeFrame(socket, request);
    }
    catch (error) {
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        entry.cleanup();
        entry.reject(error);
      }
    }
    return result;
  }

  try {
    session = await send("core.handshake", {
      bootstrapToken,
      protocolVersion: PROTOCOL_VERSION,
      requestedCapabilities,
    }, { handshake: true, timeoutMs: connectTimeoutMs });
    if (!Number.isSafeInteger(session.eventSequence) || session.eventSequence < 0) {
      throw new Error("Zotero Core handshake returned an invalid event sequence");
    }
    lastEventSequence = session.eventSequence;
  }
  catch (error) {
    socket.destroy();
    throw error;
  }

  return Object.freeze({
    capabilities: Object.freeze([...session.capabilities]),
    profileEpoch: session.profileEpoch,
    request(method, params, options) {
      return send(method, params, options);
    },
    onEvent(listener) {
      if (typeof listener !== "function") throw new Error("event listener must be a function");
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      socket.end();
      rejectPending(new Error("Zotero Core client closed"));
    },
  });
}
