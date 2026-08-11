# Gecko Library Adapter Implementation Plan

**Goal:** Replace fixture-shaped Library data with a deterministic read-only
adapter over initialized Zotero APIs, without allowing Electron or an extension
to open `zotero.sqlite` directly.

**Architecture:** A side-effect-free ES module in the Zotero source tree owns
the conversion from upstream Zotero objects to the generated Chatero Core
protocol. The adapter receives the initialized `Zotero` service explicitly, so
the same code can be exercised with recorded objects under Node and later
mounted by the headless Gecko command-line host. Collection and item identities
are always `(libraryId, key)` pairs; keys alone are never treated as globally
unique.

## Task 1: Correct cross-library identity

Add `libraryId` to collection-scoped protocol requests. Update generated
bindings, fixture validation/filtering, the extension model, and TreeView calls.
Prove that two libraries may contain the same collection key without leaking
items across libraries.

## Task 2: Read-only Zotero API adapter

Add a pure Gecko-compatible module that lists root and nested collections,
searches either one collection or all loaded libraries, normalizes creators,
years, item types, attachment counts, and collection keys, and emits stable
sorted pages and decimal cursors. Reject malformed parameters before touching
Zotero APIs.

## Task 3: Adapter contract tests

Drive the adapter with a recorded fake Zotero object graph containing two
libraries, duplicate collection keys, nested collections, regular items,
attachments, and notes. Verify protocol-exact output, stable pagination,
cross-library isolation, and read-only behavior.

## Task 4: Integration gate

Regenerate the protocol, refresh first-party extension provenance through a
clean bootstrap, compile Code-OSS with the pinned runtime, and rerun Core,
workbench, and legacy Chatero tests. Commit source and generated contracts only;
never commit a generated checkout or profile data.
