# Zotero Core RPC Foundation Implementation Plan

> Execute this plan test-first. The visible Code-OSS workbench never opens or
> writes `zotero.sqlite`; only the supervised Zotero Core process owns a Zotero
> profile.

**Goal:** Establish the versioned, authenticated local process boundary between
the Chatero Electron workbench and a future headless Gecko Zotero Core.

**Architecture:** A declarative protocol contract generates shared JavaScript
constants and TypeScript declarations. Electron creates an owner-only session
directory, acquires a non-destructive profile lease, starts Core with a bootstrap
secret over an inherited file descriptor, and connects over a Unix-domain
socket. Length-prefixed bounded frames carry requests and events. A fixture Core
implements the same handshake and lifecycle so the transport can be exercised
before the Gecko adapter exists.

**Technology:** Node.js ESM, Node `net`, JSON, generated TypeScript declarations,
Node's built-in test runner. No runtime package is added.

## Task 1: Protocol source and deterministic generation

Create:

- `services/zotero-core/protocol/chatero-core.protocol.json`
- `services/zotero-core/scripts/generate-protocol.mjs`
- `services/zotero-core/generated/protocol.mjs`
- `services/zotero-core/generated/protocol.d.ts`
- `services/zotero-core/tests/protocol-generation.test.mjs`

The source defines the protocol version, limits, capability vocabulary, request
envelope fields, handshake result, and initial `profile.status` and
`library.search` methods. The generator must be deterministic, reject unknown or
duplicate fields, and support `--check` without writing.

## Task 2: Bounded frame codec

Create:

- `services/zotero-core/transport/frame-codec.mjs`
- `services/zotero-core/tests/frame-codec.test.mjs`

Use a four-byte big-endian byte length followed by UTF-8 JSON. Reject zero,
oversized, truncated, invalid-UTF-8, duplicate-key-risk input, and non-object
messages. Decode incrementally across arbitrary chunk boundaries and serialize
writes to respect backpressure.

## Task 3: Capability session authentication

Create:

- `services/zotero-core/security/session-authority.mjs`
- `services/zotero-core/tests/session-authority.test.mjs`

Bootstrap tokens are single-use and compared without timing leaks. Successful
handshake yields a short-lived opaque session token, an immutable capability
set, and the current profile epoch. Requests fail closed on expiry, epoch
mismatch, missing capability, token replay, or malformed deadlines.

## Task 4: Profile lease

Create:

- `services/zotero-core/profile/profile-lease.mjs`
- `services/zotero-core/tests/profile-lease.test.mjs`

Acquire a dedicated `.chatero-core.lock` with create-exclusive semantics after
checking that the profile is a real directory rather than a symlink. Record PID,
process start identity, epoch, and creation time. A second live owner must fail.
Never remove an unrecognized or live lock. Release removes only a lock whose
nonce still matches the holder.

## Task 5: Fixture Core and supervisor integration

Create:

- `services/zotero-core/fixture/fixture-core.mjs`
- `services/zotero-core/client/core-client.mjs`
- `services/zotero-core/supervisor/core-supervisor.mjs`
- `services/zotero-core/tests/core-supervisor.integration.test.mjs`

The supervisor creates a mode-0700 session directory, mode-0600 socket parent,
passes the one-time secret through inherited fd 3, starts the fixture, waits for
readiness with a bounded deadline, and returns an authenticated client. Stop is
idempotent and removes only its own disposable session directory. The fixture
implements `profile.status`, deterministic `library.search`, cancellation, and
monotonic events without touching Zotero data.

## Task 6: Repository integration and gates

Modify:

- `package.json`
- `products/workbench/README.md`

Add `core:generate`, `core:check`, and `test:zotero-core` commands. Completion
requires protocol check mode, all Core tests, all workbench bootstrap tests,
the existing Chatero suite, and a clean tracked diff. Generated Code-OSS,
profiles, sockets, tokens, and fixture data remain ignored.

The next plan replaces the fixture method handlers with a pinned Gecko Zotero
adapter and then implements the read-only Library vertical slice.
