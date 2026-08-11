import { createReadStream } from "node:fs";
import { chmod, lstat, readFile } from "node:fs/promises";
import net from "node:net";
import { basename } from "node:path";

import {
  CAPABILITIES,
  METHOD_CAPABILITIES,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
} from "../generated/protocol.mjs";
import { SessionAuthority } from "../security/session-authority.mjs";
import { FrameDecoder, writeFrame } from "../transport/frame-codec.mjs";

const MAX_BOOTSTRAP_BYTES = 1024;
const MAX_ERROR_MESSAGE = 512;

async function readBootstrapToken() {
  const stream = createReadStream("", { fd: 3, autoClose: true, encoding: "utf8" });
  let value = "";
  for await (const chunk of stream) {
    value += chunk;
    if (Buffer.byteLength(value, "utf8") > MAX_BOOTSTRAP_BYTES) {
      throw new Error("bootstrap secret exceeded its size limit");
    }
  }
  const token = value.trimEnd();
  if (token.length < 24) throw new Error("bootstrap secret was missing or truncated");
  return token;
}

function rpcError(error) {
  const message = String(error?.message || error).slice(0, MAX_ERROR_MESSAGE);
  if (error?.code === "CANCELLED") return { code: "CANCELLED", message, retriable: false };
  if (/missing capability/.test(message)) return { code: "FORBIDDEN", message, retriable: false };
  if (/deadline|profile epoch|session|authentication|protocol version/.test(message)) {
    return { code: "UNAUTHORIZED", message, retriable: false };
  }
  if (/params|query|limit|cursor/.test(message)) return { code: "INVALID_PARAMS", message, retriable: false };
  if (/unknown method/.test(message)) return { code: "METHOD_NOT_FOUND", message, retriable: false };
  return { code: "CORE_ERROR", message, retriable: false };
}

function validateSearchParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("library.search params must be an object");
  if (typeof params.query !== "string" || params.query.length > 1000) throw new Error("library.search query must be a bounded string");
  if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100) {
    throw new Error("library.search limit must be an integer from 1 through 100");
  }
  if (params.cursor !== undefined && (typeof params.cursor !== "string" || !/^\d+$/.test(params.cursor))) {
    throw new Error("library.search cursor must be a decimal offset");
  }
  if (params.collectionKey !== undefined && typeof params.collectionKey !== "string") {
    throw new Error("library.search collectionKey must be a string");
  }
}

async function main() {
  const {
    CHATERO_CORE_FIXTURE_PATH: fixturePath,
    CHATERO_CORE_PROFILE_DIRECTORY: profileDirectory,
    CHATERO_CORE_PROFILE_EPOCH: profileEpoch,
    CHATERO_CORE_SOCKET_PATH: socketPath,
    CHATERO_CORE_SEARCH_DELAY_MS: rawSearchDelayMs = "0",
    CHATERO_CORE_UPSTREAM_VERSION: upstreamVersion = "7.0-fixture",
  } = process.env;
  if (![fixturePath, profileDirectory, profileEpoch, socketPath].every(value => typeof value === "string" && value.length > 0)) {
    throw new Error("fixture Core launch configuration is incomplete");
  }
  const profileMetadata = await lstat(profileDirectory);
  if (!profileMetadata.isDirectory() || profileMetadata.isSymbolicLink()) throw new Error("fixture profile must be a real directory");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const fixtureItems = Array.isArray(fixture) ? fixture : fixture.items;
  const fixtureCollections = Array.isArray(fixture?.collections) ? fixture.collections : [];
  if (!Array.isArray(fixtureItems)) throw new Error("fixture items must be an array");
  const bootstrapToken = await readBootstrapToken();
  const searchDelayMs = Number(rawSearchDelayMs);
  if (!Number.isSafeInteger(searchDelayMs) || searchDelayMs < 0 || searchDelayMs > 10000) {
    throw new Error("fixture search delay is invalid");
  }
  const authority = new SessionAuthority({
    bootstrapToken,
    profileEpoch,
    capabilities: CAPABILITIES,
  });

  const active = new Map();
  const waitForSearch = (milliseconds, signal) => new Promise((resolvePromise, reject) => {
    if (milliseconds === 0) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(resolvePromise, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      const error = new Error("Zotero Core request was cancelled");
      error.code = "CANCELLED";
      reject(error);
    }, { once: true });
  });
  const handle = async message => {
    if (message.method === "core.handshake") {
      return { result: {
        ...authority.handshake(message.params),
        upstreamVersion,
      } };
    }
    if (!Object.hasOwn(METHOD_CAPABILITIES, message.method)) throw new Error(`unknown method ${message.method}`);
    authority.authorize(message, METHOD_CAPABILITIES[message.method]);
    if (message.method === "core.cancel") {
      if (!message.params || typeof message.params.cancellationId !== "string") {
        throw new Error("core.cancel params must include cancellationId");
      }
      const controller = active.get(message.params.cancellationId);
      controller?.abort();
      return { result: { cancelled: Boolean(controller) } };
    }
    if (message.method === "profile.status") {
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params) || Object.keys(message.params).length !== 0) {
        throw new Error("profile.status params must be an empty object");
      }
      return { result: {
        profileEpoch,
        profileName: basename(profileDirectory),
        readOnly: true,
        schemaVersion: SCHEMA_VERSION,
        upstreamVersion,
      } };
    }
    if (message.method === "library.collections") {
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)
        || Object.keys(message.params).some(key => key !== "parentKey")
        || (message.params.parentKey !== undefined && typeof message.params.parentKey !== "string")) {
        throw new Error("library.collections params may contain only parentKey");
      }
      const collections = fixtureCollections
        .filter(collection => message.params.parentKey === undefined
          ? collection.parentKey === undefined
          : collection.parentKey === message.params.parentKey)
        .sort((left, right) => String(left.name).localeCompare(String(right.name)) || String(left.collectionKey).localeCompare(String(right.collectionKey)));
      return { result: { collections } };
    }
    if (message.method === "library.search") {
      validateSearchParams(message.params);
      if (typeof message.cancellationId !== "string" || message.cancellationId.length === 0) {
        throw new Error("library.search cancellationId is required");
      }
      const controller = new AbortController();
      active.set(message.cancellationId, controller);
      try {
        await waitForSearch(searchDelayMs, controller.signal);
      }
      finally {
        active.delete(message.cancellationId);
      }
      const query = message.params.query.trim().toLocaleLowerCase("en-US");
      const matches = fixtureItems
        .filter(item => message.params.collectionKey === undefined || item.collectionKeys?.includes(message.params.collectionKey))
        .filter(item => !query || [item.title, ...(item.creators || [])].some(value => String(value).toLocaleLowerCase("en-US").includes(query)))
        .sort((left, right) => String(left.title).localeCompare(String(right.title)) || String(left.itemKey).localeCompare(String(right.itemKey)));
      const offset = Number(message.params.cursor || 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > matches.length) throw new Error("library.search cursor is outside the result set");
      const items = matches.slice(offset, offset + message.params.limit);
      const nextOffset = offset + items.length;
      const result = {
        items,
        ...(nextOffset < matches.length && { nextCursor: String(nextOffset) }),
        total: matches.length,
      };
      return {
        event: { payload: { count: result.total, query: message.params.query }, topic: "library.search.completed" },
        result,
      };
    }
    throw new Error(`unknown method ${message.method}`);
  };

  const server = net.createServer(socket => {
    const decoder = new FrameDecoder();
    let writes = Promise.resolve();
    let sequence = 0;
    const enqueue = message => {
      writes = writes.then(() => writeFrame(socket, message));
      writes.catch(error => socket.destroy(error));
      return writes;
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
        void Promise.resolve().then(async () => {
          let response;
          let event;
          try {
            const handled = await handle(message);
            response = { id: message.id, ok: true, result: handled.result };
            event = handled.event;
          }
          catch (error) {
            response = { id: typeof message.id === "string" ? message.id : "invalid", ok: false, error: rpcError(error) };
          }
          await enqueue(response);
          if (event) {
            sequence += 1;
            await enqueue({
              event: true,
              payload: event.payload,
              profileEpoch,
              sequence,
              topic: event.topic,
            });
          }
        }).catch(error => socket.destroy(error));
      }
    });
    socket.on("end", () => {
      try {
        decoder.end();
      }
      catch (error) {
        socket.destroy(error);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolvePromise);
  });
  await chmod(socketPath, 0o600);

  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch(error => {
  process.stderr.write(`fixture Zotero Core failed: ${error.message}\n`);
  process.exitCode = 1;
});
