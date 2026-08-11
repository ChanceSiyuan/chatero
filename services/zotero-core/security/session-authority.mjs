import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { PROTOCOL_VERSION } from "../generated/protocol.mjs";

const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_DEADLINE_HORIZON_MS = 2 * 60 * 1000;

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function equalSecret(left, right) {
  const leftDigest = digest(typeof left === "string" ? left : "");
  const rightDigest = digest(typeof right === "string" ? right : "");
  return timingSafeEqual(leftDigest, rightDigest) && typeof left === "string" && typeof right === "string";
}

function defaultRandomToken() {
  return randomBytes(32).toString("base64url");
}

export class SessionAuthority {
  #availableCapabilities;
  #bootstrapConsumed = false;
  #bootstrapToken;
  #maxDeadlineHorizonMs;
  #now;
  #profileEpoch;
  #protocolVersion;
  #randomToken;
  #sessions = new Map();
  #sessionTtlMs;

  constructor({
    bootstrapToken,
    profileEpoch,
    capabilities,
    protocolVersion = PROTOCOL_VERSION,
    now = Date.now,
    randomToken = defaultRandomToken,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    maxDeadlineHorizonMs = DEFAULT_MAX_DEADLINE_HORIZON_MS,
  }) {
    if (typeof bootstrapToken !== "string" || bootstrapToken.length < 24) {
      throw new Error("bootstrapToken must contain at least 24 characters");
    }
    if (typeof profileEpoch !== "string" || profileEpoch.length === 0) {
      throw new Error("profileEpoch is required");
    }
    if (!Array.isArray(capabilities) || capabilities.some(value => typeof value !== "string")) {
      throw new Error("capabilities must be an array of strings");
    }
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1) {
      throw new Error("sessionTtlMs must be a positive integer");
    }
    this.#bootstrapToken = bootstrapToken;
    this.#profileEpoch = profileEpoch;
    this.#availableCapabilities = new Set(capabilities);
    this.#protocolVersion = protocolVersion;
    this.#now = now;
    this.#randomToken = randomToken;
    this.#sessionTtlMs = sessionTtlMs;
    this.#maxDeadlineHorizonMs = maxDeadlineHorizonMs;
  }

  handshake({ bootstrapToken, protocolVersion, requestedCapabilities }) {
    if (this.#bootstrapConsumed) throw new Error("bootstrap token was already consumed");
    if (!equalSecret(bootstrapToken, this.#bootstrapToken)) throw new Error("bootstrap authentication failed");
    if (protocolVersion !== this.#protocolVersion) {
      throw new Error(`protocol version ${protocolVersion} is incompatible with ${this.#protocolVersion}`);
    }
    if (!Array.isArray(requestedCapabilities)) throw new Error("requestedCapabilities must be an array");
    const selected = [...new Set(requestedCapabilities)].sort();
    for (const capability of selected) {
      if (!this.#availableCapabilities.has(capability)) {
        throw new Error(`unsupported capability ${capability}`);
      }
    }
    const sessionToken = this.#randomToken();
    if (typeof sessionToken !== "string" || sessionToken.length < 16 || this.#sessions.has(sessionToken)) {
      throw new Error("session token generator returned an unsafe token");
    }
    const expiresAt = this.#now() + this.#sessionTtlMs;
    this.#sessions.set(sessionToken, {
      capabilities: new Set(selected),
      expiresAt,
    });
    this.#bootstrapConsumed = true;
    this.#bootstrapToken = "";
    return {
      capabilities: selected,
      expiresAt,
      profileEpoch: this.#profileEpoch,
      protocolVersion: this.#protocolVersion,
      sessionToken,
    };
  }

  authorize(request, requiredCapability) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("request must be an object");
    }
    if (typeof request.id !== "string" || request.id.length === 0 || request.id.length > 128) {
      throw new Error("request id must be a non-empty bounded string");
    }
    if (typeof request.method !== "string" || request.method.length === 0) {
      throw new Error("request method is required");
    }
    if (!Number.isSafeInteger(request.deadline)) throw new Error("request deadline must be an integer timestamp");
    const currentTime = this.#now();
    if (request.deadline <= currentTime) throw new Error("request deadline expired");
    if (request.deadline > currentTime + this.#maxDeadlineHorizonMs) {
      throw new Error("request deadline exceeds the permitted horizon");
    }
    if (request.profileEpoch !== this.#profileEpoch) throw new Error("request profile epoch does not match");
    if (typeof request.sessionToken !== "string") throw new Error("request session token is required");
    const session = this.#sessions.get(request.sessionToken);
    if (!session) throw new Error("session authentication failed");
    if (session.expiresAt <= currentTime) {
      this.#sessions.delete(request.sessionToken);
      throw new Error("session expired");
    }
    if (requiredCapability && !session.capabilities.has(requiredCapability)) {
      throw new Error(`session is missing capability ${requiredCapability}`);
    }
    return Object.freeze({
      capabilities: Object.freeze([...session.capabilities].sort()),
      sessionToken: request.sessionToken,
    });
  }

  revoke(sessionToken) {
    return this.#sessions.delete(sessionToken);
  }
}
