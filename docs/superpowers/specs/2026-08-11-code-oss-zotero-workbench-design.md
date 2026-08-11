# Chatero Code-OSS Research Workbench Design

**Date:** 2026-08-11

**Status:** Approved for implementation

**Product:** Chatero

**Decision:** Replace the visible Gecko/XUL application with one branded
Code-OSS/Electron workbench, while retaining a headless Zotero Core service as
the sole owner of Zotero data, synchronization, translators, and attachments.

## Summary

Chatero becomes a research workbench with the interaction model of Cursor and
the complete first-party capabilities of Zotero. A user can open a local or
remote repository, edit Python, LaTeX, Quarto, and general source files, run
terminals and Git operations, install compatible Open VSX extensions, read and
annotate Zotero PDFs, and use one global Agent over both repository and
literature context.

The final product has one visible Electron application. Zotero's established
core remains a private background process because it already implements the
hard, stateful parts of Zotero: the profile database, schema migrations, sync,
translators, attachment storage, full-text indexing, citation data, and data
integrity rules. Electron never opens or writes `zotero.sqlite` directly.

The application is developed behind a product flag in independently testable
slices, but the public UI cutover is atomic. The legacy Gecko UI remains a test
oracle and emergency developer fallback until the complete parity gate passes;
users are not asked to operate two applications or a hybrid interface.

## Product Contract

Chatero must feel like one application, not VS Code beside Zotero:

- the workbench owns the window, activity bar, command palette, editors,
  groups, panels, notifications, keybindings, themes, accessibility tree, and
  extension host;
- Library, collections, item tables, item metadata, PDF Reader, annotations,
  notes, citation tools, and sync status are native workbench views and editors;
- repositories, terminals, source control, debugging, notebooks, and language
  tooling behave like Code-OSS;
- the Agent is global and can cite the exact repository selection, Git diff,
  terminal output, Zotero item, PDF page or selection, annotation, note, QMD
  draft, and trusted Knowledge page that the user has granted;
- QLab remains a research workflow layered over ordinary folders, not a second
  embedded application;
- local and remote workspaces use the same UI and trust model;
- personal Zotero profiles and repository content are never overwritten by
  installation, migration, indexing, or Agent work.

## Goals

1. Reuse the Code-OSS workbench, editor groups, Monaco, terminal, source
   control, debug, notebook, extension-host, command, menu, settings, and
   workspace infrastructure instead of recreating an IDE.
2. Reimplement every first-party Zotero surface as Electron/Code-OSS UI while
   preserving Zotero's data and sync semantics.
3. Support Open VSX extensions and Chatero-owned replacements for Remote SSH
   and Python language intelligence without using restricted Microsoft
   Marketplace services or Microsoft-only extension binaries.
4. Preserve the existing Chatero/QLab features: Research Loop initialization,
   Main Site, QMD editing and previews, Draft AI-version/Keep, Knowledge and
   Literature boundaries, Zotero import and `ref.bib`, multi-paper chat,
   Library Search, Note/QMD exchange, reviewed annotations, topic graphs,
   terminals, and remote helpers.
5. Provide one Cursor-like Agent with reviewable edits and stable concurrent
   tasks that do not stop when the active PDF, editor, or chat changes.
6. Keep Zotero profile compatibility and sync correctness at least as strong as
   the upstream Zotero build from which each Chatero release is derived.

## Non-goals

- Binary compatibility with third-party Zotero XPI extensions. Chatero exposes
  a documented workbench extension API instead.
- Access to Microsoft's Visual Studio Marketplace, proprietary extension
  gallery, branding, Pylance, or Microsoft Remote-SSH binaries.
- Reimplementing Zotero database or sync semantics in Electron.
- Publishing personal Knowledge, Drafts, Literature, PDFs, chat history, or
  credentials.
- Exposing a half-migrated mixed Gecko/Electron UI as the normal product.
- Executing untrusted QMD code during preview or Knowledge publication.

## Selected Architecture

```text
┌──────────────────────────────── Chatero.app ────────────────────────────────┐
│ Code-OSS / Electron Workbench                                               │
│                                                                            │
│ Explorer · Search · SCM · Run · Extensions · Zotero Library · Research     │
│                                                                            │
│ Editor groups: source | PDF | QMD preview | Note | graph | settings         │
│ Bottom panel: terminal | problems | output | debug console                  │
│ Floating/docked Agent: code + PDF + Zotero + Research Loop context          │
│                                                                            │
│ Built-in Chatero extensions                                                │
│  zotero-library  zotero-reader  research-loop  agent  remote  python        │
└───────────────────────────┬───────────────────────┬────────────────────────┘
                            │ authenticated IPC     │ remote authority RPC
                    ┌───────▼────────┐       ┌──────▼─────────────────┐
                    │ Zotero Core    │       │ Chatero Remote Agent   │
                    │ headless Gecko │       │ Linux x64 / arm64      │
                    │ local profile  │       │ files/PTY/Git/LSP      │
                    └───────┬────────┘       └────────────────────────┘
                            │
                    SQLite · sync · translators · attachments · full text
```

### Process boundaries

The Electron main process is a coordinator, not a data owner. It starts and
supervises Zotero Core, registers safe custom protocols, owns operating-system
integration, and brokers capability-scoped IPC to renderer and extension-host
processes.

Zotero Core is a headless Gecko application produced from the same pinned
Zotero upstream revision as the release. It is the exclusive writer to the
active profile and implements a versioned Chatero RPC adapter around upstream
Zotero APIs. It has no visible windows. A profile lock prevents simultaneous
use by another Zotero or Chatero core process.

The extension host receives typed service facades rather than raw database,
filesystem, or unrestricted Electron IPC access. Remote workspaces use a
Chatero Remote Agent; Zotero Core remains local unless a future explicit
profile-hosting product is designed.

### Why the core remains headless Gecko

Porting the Zotero UI is tractable; rewriting its database, sync, translators,
and attachment semantics is not a UI project. Keeping the proven core:

- preserves profile and server compatibility;
- allows regular upstream Zotero security and schema updates;
- makes migration reversible because the data representation does not change;
- prevents two JavaScript runtimes from racing to write the same SQLite file;
- permits the UI and the core to be tested independently.

## Source and Upstream Strategy

The current repository becomes the Chatero product repository during the
transition. Existing Zotero source stays in place as the pinned core upstream
and legacy parity oracle. Code-OSS is a reproducible managed upstream, not a
manually copied snapshot.

```text
chatero/
├── chrome/, app/, ...              # Zotero core source during transition
├── products/workbench/             # Chatero product layer and build tooling
│   ├── product.json
│   ├── patches/code-oss/
│   ├── resources/
│   └── scripts/
├── extensions/
│   ├── chatero-zotero/
│   ├── chatero-reader/
│   ├── chatero-research-loop/
│   ├── chatero-agent/
│   ├── chatero-remote/
│   └── chatero-python/
├── services/
│   ├── zotero-core-rpc/
│   └── protocol/
├── remote/
│   └── agent/
├── tests/chatero-workbench/
└── vendor/                          # ignored, verified upstream checkouts
    └── code-oss/
```

`products/workbench/upstreams.json` pins a full Code-OSS commit, repository
URL, archive digest, compatible Electron/Node versions, and Open VSX endpoint.
The bootstrap script verifies the commit and digest, applies the ordered patch
series without fuzz, and fails on drift. Generated upstream checkouts, build
products, caches, native helper outputs, and signed applications are not
committed.

Chatero changes should prefer built-in extensions and supported Code-OSS
contribution points. A small, reviewed patch queue is allowed only for product
identity, Zotero editor inputs, context keys, service registration, security,
window lifecycle, and Agent-specific workbench affordances that cannot be
implemented as extensions. Every patch names its upstream file and has a
contract test so rebases fail visibly.

The release records both upstream commits. Updating Code-OSS and Zotero happens
on dedicated merge branches with independent parity gates before integration.

## Workbench Experience

### Primary layout

The default research layout uses the normal Code-OSS shell:

- Activity Bar: Explorer, Search, Source Control, Run, Extensions, Zotero
  Library, Research Loop;
- Side Bar: the active view, including collections and library search;
- Editor Groups: arbitrary source files, PDFs, QMD views, Notes, graphs, and
  settings; all support drag, split, close, reopen, and session restore;
- Panel: terminal, problems, output, ports, debug console, and Zotero sync log;
- Status Bar: repository authority, remote connection, Git branch, Python
  environment, Zotero sync, citation index, and QLab compliance;
- Agent: hidden by default, opened by command or selection action, floatable,
  pinnable, resizable, and optionally docked to the secondary side bar.

No document type owns a special split system. A Zotero PDF is an editor input,
so PDF | source, PDF | QMD, PDF | Agent, or two PDFs use the same editor-group
logic as two code files. Switching a PDF, editor, or conversation changes only
focus; background Agent turns continue and remain attached to their captured
context snapshot.

### Zotero Library

The Zotero activity opens a workbench-native library view containing:

- library and group roots, collections, saved searches, feeds, duplicates,
  unfiled items, trash, and virtual research collections;
- sortable, configurable item tables with saved column layouts;
- quick search and advanced search;
- tag selector and colored tags;
- item metadata, creators, abstract, attachments, notes, tags, related items,
  and libraries;
- multi-select batch editing;
- import, export, duplicate merge, retraction notices, locate, and file
  management actions;
- sync state, conflicts, errors, and retry controls.

Library rows open workbench editors. Commands use the standard palette, context
menus, menus, keybindings, and accessibility semantics rather than a separate
web-app navigation model.

### PDF Reader and annotations

The Reader is a first-class editor with pages, thumbnails, outline, find,
zoom, selection, citations, page labels, color annotations, comments, images,
ink where supported, and annotation navigation. It streams attachment bytes
through a capability URL instead of exposing file paths to renderer content.

Deep links use stable Zotero library/item/attachment identity plus page and an
optional annotation or text anchor. Clicking a link focuses an existing Reader
input when possible and navigates in place; otherwise it opens a new editor.
Agent citations render as the same links.

Annotation proposals are staged in an explicit review model. The Agent cannot
silently write annotations. A user can inspect, edit, select, and apply a batch
once; committed annotations go through Zotero Core and sync normally.

### Notes, QMD, and Research Loop

Zotero Notes are rich-text editors backed by Zotero Core. QMD files are ordinary
workspace files with Monaco source, Visual Edit, and isolated Quarto website
preview editor inputs. Note ↔ QMD is an explicit import/export command with a
preview of lossy constructs; the QMD Draft remains the authoritative research
writing artifact.

Research Loop supplies:

- safe initialization of empty or content-only folders;
- `drafts/` as editable, `knowledge/` as trusted/read-only, and `literature/`
  as external evidence;
- Draft original/proposed snapshots, Visual Edit, website preview, compliance,
  Keep, and promotion review;
- Zotero Literature materialization and audited `literature/ref.bib` refresh;
- local Main Site and Knowledge topic graph;
- skills-backed research actions rather than an unrelated prompt library.

The workbench file service, editor groups, diagnostics, diff editor, undo/redo,
file watchers, and dirty-state model replace custom XUL editor mechanics.

## Extension Ecosystem

Chatero uses Open VSX as its default public registry and clearly labels the
publisher, license, permissions, remote support, web/native host, and trust
requirements of each extension. It does not contact Microsoft's Marketplace or
ship Microsoft-only binaries.

Compatibility has three levels:

1. standard Code-OSS/Open VSX extensions run unchanged;
2. Chatero built-ins use a documented additive API for Zotero and research
   context;
3. extensions that depend on Microsoft-private services or unsupported native
   assumptions are marked incompatible with a useful replacement suggestion.

Chatero's extension API exposes immutable item/collection snapshots, safe
search, attachment streams, Reader navigation, annotation proposals, citation
insertion, context contributions, and Research Actions. Mutations require
declared permissions and user-visible transactions. Raw profile paths, SQLite,
credentials, and sync tokens are never extension APIs.

## Python, LaTeX, Quarto, and General Languages

The built-in Python experience uses Pyright or BasedPyright for type analysis,
a Chatero-owned environment/interpreter selector, debugpy for debugging, and
Jupyter-compatible notebook support. It is not named Pylance and does not rely
on Pylance binaries or services.

LaTeX uses Open VSX-compatible language tooling and local TeX distributions.
Quarto uses a Chatero built-in extension for schema, completion, preview,
Visual Edit, cross-references, theorem/lemma/definition/proof blocks, citations,
and no-execute build policies. Other languages use normal Code-OSS extensions.

Language servers run on the workspace side: locally for local folders and in
the Remote Agent for SSH folders. PDF/Zotero data remains local and can be
granted to a remote-language Agent only through an explicit, bounded context
transfer.

## Remote SSH

The Chatero Remote extension owns the `chatero-remote` authority and does not
reuse Microsoft's Remote-SSH code or service. It uses the system OpenSSH client
and existing SSH configuration, known-host verification, agent/keychain
integration, proxy jumps, port forwarding, reconnect, and observable logs.

On first connection it verifies and installs a signed, version-matched Remote
Agent for Linux x64 or arm64 in a user-scoped directory. The Agent supplies
filesystem watching, search, PTY/terminal, Git, process execution, port
forwarding, extension-host placement, debug adapters, and language servers.
Installation is resumable and never changes remote project files.

The UI follows Code-OSS remote semantics: the window has one active workspace
authority, remote status is persistent and inspectable, and local Zotero
editors may coexist beside remote source editors. Absolute paths are never
accepted across authority boundaries without canonicalization by the owning
file service.

## Global Agent

The Agent is a workbench service with multiple conversation tabs and independent
turn lifecycles. Its visible surface can float over the document area, pin,
resize, move, dock, or hide. `Command-K` over a code, QMD, Note, or PDF selection
opens a compact prompt seeded with an immutable reference to that selection.

Each turn receives a context manifest rather than a concatenated UI dump:

```json
{
  "workspace": { "authority": "local-or-remote", "repositoryId": "..." },
  "resources": [
    { "kind": "text-selection", "uri": "...", "range": {} },
    { "kind": "pdf-selection", "itemKey": "...", "page": 7, "anchor": "..." },
    { "kind": "zotero-item", "libraryId": 1, "itemKey": "..." }
  ],
  "grants": ["workspace:read", "drafts:propose", "zotero:search"]
}
```

Context chips show provenance and can be removed before sending. Conversation
history stores only stable identifiers plus messages; transient attachment
bytes and secrets are not duplicated. Missing resources remain visible as
unavailable references instead of being silently replaced with the currently
focused PDF.

Agent tools are authority-scoped. Draft changes target a private proposed copy,
compose across multiple turns, and become the original only through Keep.
Knowledge and Literature are read-only to the Agent except for dedicated,
audited promotion/import transactions. General source edits use the normal
reviewable workspace edit/diff flow. Terminal commands honor workspace trust
and remote authority.

## Zotero Core RPC

### Transport and authentication

Electron launches Core with a fresh session directory, Unix-domain socket, and
one-time bootstrap token passed through a protected inherited channel. Core
returns its protocol version, upstream Zotero version, profile identity, schema
version, and capability set. Every client connection derives a short-lived
capability token. The socket directory is owner-only; TCP is not used.

Messages use a generated, versioned schema. Requests carry an id, method,
deadline, cancellation id, profile epoch, and capability. Responses are
bounded. Large attachment/full-text data uses backpressured streams rather than
JSON blobs.

### API domains

- profile lifecycle and migration;
- libraries, collections, searches, items, creators, tags, relations;
- attachment metadata, streams, storage state, and full-text indexing;
- notes and annotation transactions;
- translators, import, export, lookup, and citation metadata;
- sync status, progress, conflicts, errors, and retry;
- feeds, duplicates, retractions, and maintenance;
- events with monotonic sequence numbers and replay from a bounded cursor.

Renderer processes never call RPC directly. Workbench services validate the
active editor/workspace/profile epoch, enforce permissions, normalize errors,
and publish cancellable models to views.

### Mutation semantics

Every mutation is a named transaction with an idempotency key, expected
revision, affected identities, and structured result. Optimistic UI updates are
reconciled against Core events. Revision conflicts become editable conflict
views; they are not last-write-wins. Batch annotation and metadata operations
either commit atomically or return itemized validation failures without a
partial silent success.

## Data Safety and Migration

The first launch performs read-only discovery and offers the existing Zotero
profile. Before the first Core run under Chatero, it verifies no Zotero process
owns the profile lock, checks available disk space, creates a versioned backup
of migration-sensitive files, and records the upstream schema version.

Chatero does not invent a new Zotero schema. A profile changed by its matching
Zotero Core remains a Zotero profile subject to upstream compatibility rules.
If the pinned core requires a forward-only migration, Chatero explains the
upstream consequence and requires explicit user confirmation at that migration
boundary. Product installation alone never migrates a profile.

Repository initialization, upgrades, extensions, and Agent work use
create-if-absent or transactional writes. Existing Knowledge, Drafts,
Literature, Git metadata, PDFs, Zotero data, chat history, SSH configuration,
and credentials are preserved. Generated previews, caches, indexes, remote
agents, and build products are disposable and excluded from Git by default.

## Failure Handling

- If Core fails, the workbench opens with repository features intact and a
  recoverable Zotero status view; it never starts a second profile writer.
- If the extension host fails, Library and Reader retain read-only models and
  the host can restart without restarting Core.
- If a renderer crashes, editor inputs restore from stable identity and Core
  event cursors; unsaved source buffers use Code-OSS hot exit.
- If sync fails, local mutations remain Core transactions and normal Zotero
  conflict handling applies.
- If a remote connection fails, local PDFs, Zotero, chat history, and local
  repositories remain available; remote editors become reconnectable inputs.
- If Quarto preview fails, source editing remains available with the last-good
  preview and bounded diagnostics.
- If an Agent turn fails or is cancelled, proposed Draft state and ordinary
  source edits remain unchanged unless a complete reviewable edit was staged.

## Security Model

The application enables Electron context isolation and sandboxing, disables
Node integration in content renderers, uses strict content-security policies,
and exposes only generated preload bridges. PDF, HTML preview, Note, extension
webview, and remote content are separate origins with capability URLs.

Workspace trust gates tasks, terminals, debug adapters, extension activation,
Quarto execution, and Agent commands. Research Loop additionally enforces its
filesystem authorities. Zotero credentials and sync tokens remain in Core and
operating-system credential storage. Logs redact tokens, absolute personal
paths where practical, document contents, and chat text by default.

Open-source license notices, Code-OSS and Zotero source offers, third-party
licenses, and product branding are generated and verified during release. A
release gate rejects Microsoft Marketplace endpoints, proprietary Microsoft
extension identifiers, and unapproved Microsoft product assets.

## Testing and Acceptance

### Contract tests

- generated RPC clients and Core handlers match one schema;
- protocol downgrade/upgrade, cancellation, deadlines, event replay, streaming,
  idempotency, conflicts, and capability rejection;
- path and authority validation for local and SSH workspaces;
- no direct SQLite access from Electron, renderers, or extensions;
- no Microsoft Marketplace endpoints or restricted bundled extensions.

### Zotero parity

An executable parity catalog maps every visible upstream Zotero command and
surface to a Chatero command, automated test, and manual evidence. It covers
Library, groups, collections, item CRUD, metadata, attachments, Reader,
annotations, Notes, search, duplicates, feeds, translators, import/export,
citations, sync, conflicts, preferences, accessibility, and localization.

Tests run the same fixture/profile operations through upstream Zotero and
Chatero Core, normalize nondeterministic fields, and compare resulting data and
events. Sync tests use disposable local and test-server libraries. Profile
round trips include backup restore and interrupted migrations.

### Workbench acceptance

- local and SSH repositories support files, search, Git, PTY, debug, notebooks,
  extensions, settings, and session restore;
- Python, LaTeX, Quarto, and representative general-language fixtures work;
- PDFs and source files drag between normal editor groups without reload;
- Library/Reader actions are keyboard accessible and preserve upstream Zotero
  semantics;
- the Agent references and deep-links exact PDF/source context, keeps parallel
  turns alive, and cannot escape grants;
- Draft Visual Edit, website preview, Monaco, AI proposal, Keep, compliance,
  and promotion pass end-to-end;
- Main Site, bibliography refresh, Note/QMD, reviewed annotations, Library
  Search, multi-paper chat, and topic graph pass end-to-end;
- crash, restart, offline, stale-event, remote disconnect, and low-disk fault
  injections preserve user data.

### Release cutover gate

The Electron UI becomes the normal Chatero product only when:

1. the Zotero parity catalog has no unsupported first-party feature;
2. two consecutive pinned upstream profile/sync suites pass without data diff;
3. local and remote workbench acceptance passes on supported macOS versions;
4. migration backup, recovery, and legacy fallback drills pass;
5. accessibility, localization, licensing, security, and performance gates pass;
6. a signed personal-development DMG passes clean-install and upgrade smoke
   tests with a copied disposable profile.

Until then, the Electron workbench is an opt-in developer target and the legacy
UI is retained only to verify behavior. There is no public mixed-mode release.

## Delivery Program

Implementation is ordered by dependency, not by which UI is easiest:

1. **Reproducible workbench bootstrap.** Pin and verify Code-OSS, establish
   Chatero branding, Open VSX, patch discipline, build/test commands, generated
   license inventory, and a development Electron shell.
2. **Core protocol and headless harness.** Define generated RPC, profile lock,
   authenticated transport, lifecycle supervisor, fixture Core, and upstream
   Zotero adapter smoke path.
3. **Library vertical slice.** Collections, item table, metadata, search, events,
   commands, and read-only attachment opening through the new architecture.
4. **Reader and mutation slice.** PDF editor, annotations, Notes, item edits,
   imports, citations, transaction conflicts, and sync state.
5. **IDE and remote slice.** terminals, Git, debug, extensions, Python,
   LaTeX/Quarto, signed Linux x64/arm64 Remote Agent, and SSH authority.
6. **Agent and Research Loop slice.** global Agent, context manifests, QMD
   surfaces, Keep/promotion, literature sync, Main Site, actions, history,
   Library Search, Note/QMD, reviewed annotations, and topic graph.
7. **Parity closure and atomic cutover.** complete remaining first-party Zotero
   surfaces, performance/accessibility/localization, fault injection, migration,
   signing, DMG, and removal of visible legacy UI from production builds.

Each slice is test-driven and lands only when its own contract, integration,
and data-safety gates pass. “All Zotero UI at once” applies to the user-visible
cutover: no incomplete subset is presented as the replacement application.

## Initial Performance Budgets

- workbench first usable paint, warm: 2.5 seconds at p95;
- Core ready with an unchanged medium profile, warm: 3 seconds at p95;
- Library initial viewport after Core ready: 500 ms at p95;
- item-table scroll: 55+ frames per second at p95 on the reference Mac;
- PDF first visible page from local attachment: 1 second at p95;
- local text edit input latency: 16 ms at p95;
- QMD incremental preview after save: 1.5 seconds at p95 for one page, retaining
  last-good content while rendering;
- local library search first page: 300 ms at p95;
- UI event delivery after committed Core mutation: 100 ms at p95.

Budgets are measured with recorded fixture sizes and may be tightened after the
first vertical slices; regressions require an explicit reviewed waiver.

## Consequences

This decision creates a larger product and an additional upstream to maintain,
but it removes the architectural ceiling of the XPI and the current XUL UI. It
also avoids the highest-risk rewrite: Zotero data and sync. The workbench can
use mature Code-OSS behavior for programming while exposing literature as a
native research context that ordinary IDEs do not understand.

The most important invariant is ownership: Code-OSS owns interaction, Zotero
Core owns Zotero truth, the workspace file service owns repository bytes, and
the Agent owns neither. Chatero coordinates them through typed, reviewable,
recoverable transactions.
