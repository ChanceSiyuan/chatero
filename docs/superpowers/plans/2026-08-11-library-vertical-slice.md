# Code-OSS Library Vertical Slice Implementation Plan

**Goal:** Make a verified first-party Chatero extension appear as native
Code-OSS workbench views and exercise the Zotero Core RPC boundary without
exposing the developer fixture as a public Zotero replacement.

**Architecture:** The repository owns extension source and Zotero Core runtime
source. Bootstrap materializes both into the ignored Code-OSS checkout,
records byte digests in provenance, and verifies them before launch. The
extension host—not a renderer or webview—supervises Core and exposes native
TreeView/command models. The fixture path is enabled only by an explicit
development setting; the future Gecko adapter implements the same service.

## Task 1: First-party extension materializer

Create `products/workbench/scripts/lib/first-party-extensions.mjs` and tests.
Copy only declared regular files, reject links and path escapes, write into a
new destination, and return stable per-file and tree SHA-256 values.

## Task 2: Bootstrap provenance integration

Extend bootstrap/verification provenance with `firstPartyExtensions`. Verify
the copied tree independently of Git diff, include it in managed paths, and
scan committed extension source with the existing Open VSX/restricted-extension
policy. Existing generated checkouts must fail closed after the contract
changes; bootstrap never silently repairs them.

## Task 3: Native Library extension

Create `products/workbench/extensions/chatero-zotero/` with a Code-OSS extension
manifest and an ESM entrypoint. Register a Chatero activity container, Library
tree, search command, Core status item, start/stop/refresh commands, and a
read-only item model. Use Code-OSS ThemeIcons, accessibility labels, cancellation
tokens, progress, and normal command/keybinding infrastructure—no iframe and no
custom fake workbench chrome.

## Task 4: Core Library protocol

Add `library.collections`, collection-aware item search, stable cursors, and
events. Fixture tests prove ordering, cancellation, capability enforcement, and
reconnect. The extension consumes only generated protocol names.

## Task 5: Real checkout gate

Materialize into a new ignored checkout, verify provenance, install dependencies
under the pinned Node runtime, compile Code-OSS, and run Core, workbench, and
legacy Chatero tests. Commit only source, manifests, generated protocol, tests,
and plans; never commit the checkout or user data.
