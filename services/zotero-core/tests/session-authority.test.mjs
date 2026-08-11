import assert from "node:assert/strict";
import { test } from "node:test";

function createAuthority(overrides = {}) {
  let currentTime = 1_000_000;
  return {
    advance(milliseconds) { currentTime += milliseconds; },
    async authority() {
      const { SessionAuthority } = await import("../security/session-authority.mjs");
      return new SessionAuthority({
        bootstrapToken: "bootstrap-secret-with-enough-entropy",
        profileEpoch: "epoch-1",
        capabilities: ["profile:read", "library:search"],
        now: () => currentTime,
        randomToken: (() => {
          let index = 0;
          return () => `session-token-value-${++index}`;
        })(),
        sessionTtlMs: 1000,
        ...overrides,
      });
    },
  };
}

test("exchanges a one-time bootstrap secret for a least-privilege session", async () => {
  const fixture = createAuthority();
  const authority = await fixture.authority();

  const session = authority.handshake({
    bootstrapToken: "bootstrap-secret-with-enough-entropy",
    protocolVersion: "1.0",
    requestedCapabilities: ["library:search"],
  });

  assert.deepEqual(session, {
    capabilities: ["library:search"],
    expiresAt: 1_001_000,
    profileEpoch: "epoch-1",
    protocolVersion: "1.0",
    sessionToken: "session-token-value-1",
  });
  assert.throws(() => authority.handshake({
    bootstrapToken: "bootstrap-secret-with-enough-entropy",
    protocolVersion: "1.0",
    requestedCapabilities: [],
  }), /already consumed/);
});

test("wrong secrets and unsupported capabilities fail closed", async () => {
  const authority = await createAuthority().authority();
  assert.throws(() => authority.handshake({
    bootstrapToken: "wrong",
    protocolVersion: "1.0",
    requestedCapabilities: [],
  }), /authentication failed/);
  assert.throws(() => authority.handshake({
    bootstrapToken: "bootstrap-secret-with-enough-entropy",
    protocolVersion: "1.0",
    requestedCapabilities: ["notes:write"],
  }), /unsupported capability notes:write/);
  assert.throws(() => authority.handshake({
    bootstrapToken: "bootstrap-secret-with-enough-entropy",
    protocolVersion: "2.0",
    requestedCapabilities: [],
  }), /protocol version/);
});

test("authorizes deadlines, profile epoch, expiry, and method capability", async () => {
  const fixture = createAuthority();
  const authority = await fixture.authority();
  const session = authority.handshake({
    bootstrapToken: "bootstrap-secret-with-enough-entropy",
    protocolVersion: "1.0",
    requestedCapabilities: ["library:search"],
  });
  const request = {
    id: "request-1",
    method: "library.search",
    params: { query: "tensor" },
    deadline: 1_000_500,
    profileEpoch: "epoch-1",
    sessionToken: session.sessionToken,
  };

  assert.deepEqual(authority.authorize(request, "library:search"), {
    capabilities: ["library:search"],
    sessionToken: "session-token-value-1",
  });
  assert.throws(() => authority.authorize({ ...request, deadline: 999_999 }, "library:search"), /deadline expired/);
  assert.throws(() => authority.authorize({ ...request, profileEpoch: "epoch-2" }, "library:search"), /profile epoch/);
  assert.throws(() => authority.authorize(request, "profile:read"), /missing capability profile:read/);
  fixture.advance(1001);
  assert.throws(() => authority.authorize({ ...request, deadline: 1_002_000 }, "library:search"), /session expired/);
});

test("rejects malformed or unbounded request deadlines", async () => {
  const authority = await createAuthority().authority();
  const session = authority.handshake({
    bootstrapToken: "bootstrap-secret-with-enough-entropy",
    protocolVersion: "1.0",
    requestedCapabilities: ["library:search"],
  });
  const base = {
    id: "request-1",
    method: "library.search",
    params: {},
    profileEpoch: "epoch-1",
    sessionToken: session.sessionToken,
  };
  assert.throws(() => authority.authorize({ ...base, deadline: "later" }, "library:search"), /deadline/);
  assert.throws(() => authority.authorize({ ...base, deadline: 2_000_001 }, "library:search"), /deadline exceeds/);
  assert.throws(() => authority.authorize({ ...base, id: "", deadline: 1_000_100 }, "library:search"), /request id/);
});
