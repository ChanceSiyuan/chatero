# Headless Gecko Core Host Implementation Plan

**Goal:** Allow the Code-OSS workbench to start a real Chatero/Zotero Gecko
process as Zotero Core, connect through the existing authenticated Unix-socket
protocol, and render real read-only Library data without launching the legacy
window.

**Architecture:** The existing Core supervisor remains the only Electron-side
process owner and profile lease owner. In production mode it launches the
bundled Gecko executable with an explicit profile, `-headless`, and
`-ChateroCore`; the one-time secret still travels on inherited fd 3. The Gecko
command-line entry opens only a hidden Core host document. That host waits for
normal Zotero initialization, then mounts an owner-only Unix socket and routes
generated protocol requests into the read-only Zotero API adapter. The fixture
process remains an explicit test mode.

## Task 1: Pure authenticated Gecko router

Implement a Gecko-compatible request router with single-use bootstrap
authentication, least-privilege sessions, deadline/profile-epoch checks,
structured errors, cancellation bookkeeping, profile status, collections, and
search. Exercise it under Node with the recorded Zotero object graph.

## Task 2: Gecko Unix-socket host

Implement bounded four-byte framed JSON over `nsIServerSocket.initWithFilename`,
fatal UTF-8 decoding, duplicate-key rejection, owner-only socket permissions,
ordered response/event writes, and safe shutdown. Read the bootstrap secret
from inherited fd 3, never argv, environment, or a persistent file.

## Task 3: Headless command-line entry

Add `-ChateroCore` to the early command-line handler, suppress the legacy main
window, load a hidden Core document, wait for `Zotero.initializationPromise`,
and terminate on startup/transport failure. Ordinary Chatero launches retain
their current behavior.

## Task 4: Supervisor and workbench selection

Teach the supervisor to choose either the fixture module or an explicit Gecko
executable without changing the public client. Add workbench settings and a
file picker for the development Core executable. Production packaging will
later bind the bundled path without exposing this setting.

## Task 5: Real smoke and regression gate

Build a disposable Chatero app/profile, launch it headlessly through the
supervisor, call profile/collection/search methods, stop it cleanly, and verify
no visible legacy window or residual profile/session lock remains. Then rerun
Core, workbench, legacy Chatero, and real Code-OSS compilation gates.
