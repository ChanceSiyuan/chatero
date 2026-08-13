# Chatero Seven-Stage Completion Design

**Date:** 2026-08-13

**Status:** Ready for final user review

**Product:** Chatero

## Objective

Complete the approved Code-OSS/Electron Chatero workbench as a production-ready
replacement for every first-party visible Zotero surface while preserving a
headless Gecko Zotero Core as the only owner of Zotero data. Completion means
that all seven delivery stages satisfy their product, contract, data-safety,
integration, release, and atomic-cutover gates. A passing narrow unit suite,
an implemented prototype, or a developer-only build does not complete a stage.

This design extends the approved workbench architecture rather than replacing
it. Existing focused designs and plans remain authoritative for their bounded
subsystems unless this document imposes a stronger completion gate.

## Product Boundaries

- Code-OSS/Electron exclusively owns visible windows, editor groups, Monaco,
  terminals, source control, debugging, notebooks, settings, commands,
  accessibility, themes, extensions, and Agent interaction.
- Headless Gecko Zotero Core exclusively owns the profile database, migrations,
  sync, translators, attachments, full text, citations, Notes, annotations, and
  every other Zotero data mutation.
- The active local or SSH workspace file service exclusively owns repository
  bytes and canonical path resolution for its authority.
- The Agent owns neither workspace nor Zotero truth. It may retrieve only
  granted context and may propose only reviewable, authority-scoped changes.
- Electron renderers, webviews, extensions, remote helpers, and the Agent never
  open or write `zotero.sqlite`.
- The legacy Gecko UI remains a development-only parity oracle until the atomic
  cutover. Chatero never publishes an incomplete mixed Gecko/Electron product.

## Global Non-Goals and Prohibitions

- Do not invent a second Zotero schema or duplicate Zotero truth in Electron.
- Do not use Microsoft Marketplace, Microsoft Remote-SSH, Pylance, GitHub
  Copilot runtime/provider fallbacks, or Microsoft product branding.
- Do not put personal profiles, repositories, Knowledge, Drafts, Literature,
  chat history, credentials, signing keys, or research output in the source
  repository or test logs.
- Do not weaken a release gate by skipping tests, converting a required real
  integration into a fixture-only test, or treating documentation as evidence
  of runtime behavior.
- Do not use last-write-wins for Zotero, Documentation, QMD, annotation, or
  migration conflicts.

## Completion Model

Every stage has four mandatory layers. A stage advances only when all four are
green at the same source commit.

1. **Contract gate.** Versioned schemas, authority boundaries, capabilities,
   error shapes, resource limits, and ownership invariants are executable and
   covered by negative controls.
2. **Implementation gate.** Every planned user behavior, state transition,
   failure path, recovery path, and accessibility behavior is implemented.
3. **Integration gate.** The behavior passes in a real generated Electron app
   and, when relevant, a real headless Gecko Core, disposable profile, local
   workspace, SSH workspace, and signed Remote Agent.
4. **Release gate.** Provenance, dependency and license inventory, supported
   platform matrix, signing state, recovery evidence, and stage acceptance
   records are complete.

Each stage writes a machine-readable acceptance record. It names every
requirement, the proving command or artifact, the exact source/product digest,
the result, and the evidence path. The verifier rejects missing requirements,
stale evidence, unverified manual claims, skipped mandatory scenarios, and
records produced by a different source or application digest.

## Stage 1: Reproducible Workbench Bootstrap

### Product result

A clean clone reproducibly materializes the exact pinned Code-OSS source,
applies an ordered digest-pinned fuzz-free patch series, installs pinned
dependencies, compiles, packages, installs, and launches Chatero without
touching a personal profile or workspace. The application contains only the
declared first-party extensions, uses Open VSX, and exposes Chatero identity.

### Required closure

- Preserve strict upstream, runtime, patch, product, extension, and policy
  provenance through compile and packaging.
- Eliminate the residual GitHub Copilot extension activation attempt, duplicate
  vendor registration, provider fallback, and GitHub token/resource probing.
- Fix the reproducible Documentation `dirty-save-autosave-revert` integration
  failure without bypassing Code-OSS optimistic concurrency.
- Make local integration invocation honor exact scenario selection and produce
  bounded machine-readable results.
- Verify clean bootstrap, incremental reuse, compile, isolated launch, app
  bundle identity, ad-hoc developer signing, and production-signing readiness.
- Keep generated checkouts, caches, dependencies, app bundles, profiles,
  workspaces, sockets, tokens, and test evidence out of Git unless an explicit
  sanitized acceptance artifact is declared.

### Exit gate

All Bootstrap, legacy Chatero, Core foundation, and local Electron integration
tests pass with no unexpected extension activation errors or policy/network
attempts. A freshly generated installed app matches committed provenance.

### Acceptance record

Stage 1 source, compile, and local-runtime acceptance is complete only when
`npm run verify:stage-1` produces a passing, nine-check record at
`products/workbench/.cache/acceptance/stage-1.json` from the same clean source
commit. The contract is checked in at
`products/workbench/acceptance/stage-1.requirements.json`, and the macOS CI job
uploads the ignored record for audit even on failure. No required command has a
skip or optional mode; signed release packaging and installed-app cutover
remain independently required by the later release stages.

## Stage 2: Complete Zotero Core Protocol and Headless Harness

### Product result

One supervised headless Gecko process provides the complete Zotero product
service behind a generated, authenticated, cancellable, bounded, versioned RPC
contract. Electron remains usable when Core is unavailable.

### Required domains

- Profile discovery, locking, migration, backup, restore, compatibility, and
  lifecycle.
- Libraries, groups, collections, saved searches, items, creators, fields,
  tags, relations, duplicates, retractions, feeds, and maintenance.
- Attachment metadata and streams, storage state, linked/stored files, full
  text, indexing, and safe local-file authorization.
- Notes, annotations, Reader transactions, batch mutations, and conflict data.
- Translators, lookup, import, export, bibliography, CSL citation metadata,
  document-integration operations, and quick-copy behavior.
- Sync status, progress, conflicts, errors, retry, object sync, file sync,
  WebDAV/ZFS state, offline operation, and test-server behavior.

### Protocol requirements

Generated clients and handlers implement handshake negotiation, explicit
protocol compatibility, short-lived capabilities, profile epochs, deadlines,
cancellation, bounded frames, backpressured streams, monotonic events with
bounded replay, idempotency keys, expected revisions, atomic batches,
structured validation failures, conflict results, and reconnect. Renderers
never receive a raw transport or filesystem path capability.

### Exit gate

The same disposable operations run through upstream Zotero and Chatero Core
and produce normalized-equivalent data and events. Negative tests prove direct
SQLite access, stale epochs, missing capabilities, replay, cross-library
identity confusion, path escape, oversized data, and partial mutation fail
closed without corrupting the profile.

## Stage 3: Native Library Vertical Slice

### Product result

The Workbench provides the full visible Zotero Library experience through
native Code-OSS views, editors, commands, menus, settings, keybindings, and
accessible models.

### Required surfaces

- Libraries, groups, collections, saved searches, duplicates, feeds, trash,
  and sync status.
- A virtualized sortable item table with configurable fields, stable selection,
  multi-selection, pagination, drag and drop, keyboard navigation, and session
  restoration.
- Complete item metadata display and editing, creators, tags, related items,
  attachments, Notes, identifiers, locate actions, and batch edits.
- Quick search, advanced search, import, export, lookup, citation/copy actions,
  attachment operations, conflict display, and progress/cancellation.

### Exit gate

An executable parity catalog maps every upstream Library command and surface to
the Chatero command, automated test, and current manual evidence. It contains
no unsupported first-party Library entry. Accessibility and localization tests
cover every visible state; item-table performance meets the approved budgets.

## Stage 4: Reader, Notes, Citations, and Mutation Slice

### Product result

PDF, EPUB, snapshot, Note, annotation, metadata, import, citation, and sync
mutations are complete native Workbench experiences backed only by Core
transactions.

### Required behavior

- PDF text, images, page geometry, rotation, links, search, outline, thumbnails,
  zoom, selection, accessibility, printing/export, and exact session restore.
- EPUB and snapshot reading with upstream-equivalent navigation and annotations.
- Existing and new highlights, underlines, notes, comments, colors, tags, image
  annotations, selection actions, reviewed Agent proposals, batch apply, undo,
  and conflict resolution.
- Complete Zotero Notes editing and Note/annotation round trips.
- Citation metadata, quick copy, bibliography, word-processor integration, and
  document-integration failure handling.
- Offline edits, reconnect, stale events, interrupted batches, low disk, Core
  crash, Electron crash, and profile restart without silent loss.

### Exit gate

Every mutation is a named idempotent transaction with expected revisions and
atomic or itemized results. Two consecutive real disposable profile runs match
upstream Zotero data and event outcomes. Reader first-page and interaction
performance, accessibility, and localization budgets pass.

## Stage 5: IDE, Languages, and Remote SSH

### Product result

Local and SSH workspaces provide normal Code-OSS files, search, Git, terminals,
debugging, notebooks, settings, extensions, and session restore while local
Zotero editors remain available beside remote source editors.

### Required behavior

- Python, LaTeX, Quarto, JavaScript/TypeScript, Markdown, JSON, YAML, shell, and
  representative general-language fixtures work through Open VSX-compatible or
  Chatero-owned extensions without restricted Microsoft components.
- PTY, task, debug, notebook, source-control, search, file watching, settings,
  workspace trust, and extension-host restart pass locally and remotely.
- System OpenSSH configuration, ProxyJump, host-key identity, reconnect,
  cancellation, arbitrary/empty remote folders, authority persistence, and
  noninteractive diagnostics are bounded and inspectable.
- Signed Linux x64 and arm64 Remote Agents contain the exact verified product,
  embedded Codex SDK, fixed helpers, notices, and no private key.
- Explicit complete-paper transfer uses a 256-bit, 60-second, one-use,
  target/fingerprint-bound grant; resumable upload publishes an owner-only
  digest-named cache for exactly 24 hours; expiry and revoke are target-bound.

### Exit gate

Clean Linux x64 and arm64 runners build, sign, install, verify, launch, reconnect,
and remove the Remote Agent. Real SSH acceptance covers files, Git, PTY, debug,
languages, Documentation, Codex, exact PDF context, explicit full-paper cache,
disconnect recovery, expiry, and revoke without exposing a local path.

## Stage 6: Global Agent and Research Loop

### Product result

One native Code-OSS Agent supports independent conversations and precise local
or remote repository and Zotero context. Documentation and QMD provide the
complete read-ask-write-review-promote research workflow.

### Required behavior

- Native OpenAI Codex authentication and runtime with no Copilot fallback,
  multiple live turns, stop/resume, history, context manifests, immutable
  selection references, removable provenance chips, explicit grants, approval
  cards, reviewable workspace edits, and fault recovery.
- Documentation standard TextDocument editing, incremental Live Preview,
  formulas, formal blocks, tables, images, Quarto last-good preview, human
  review, immutable Agent generations, settlement, recovery, migration, and
  reviewed-only background retrieval.
- QMD Draft editing, Preview, proposal comparison, Keep/Reject, three-way
  replay, compliance, citations, and exact PDF/source deep links.
- Knowledge promotion, Literature import/refresh, bibliography, Main Site,
  Research Actions, Library Search, multi-paper chat, Note/QMD bridge, reviewed
  annotation proposals, and topic graph.
- Local and SSH authority parity for every repository-side operation; Zotero
  paths and unauthorized bytes never enter remote prompts.

### Exit gate

End-to-end local and SSH scenarios prove the full research loop, including
restart and recovery at every durable transaction phase. Every Agent tool has
an explicit authority, grant, mutation boundary, audit record, and negative
escape test. No custom parallel chat runtime or hidden promotion path exists.

## Stage 7: Parity Closure and Atomic Cutover

### Product result

The Electron application becomes the only normal visible Chatero product after
all first-party Zotero and Research Loop behavior is proven complete. The
legacy UI is retained only as a developer parity oracle or removed from
production packaging according to the approved cutover artifact.

### Required gates

- The executable parity catalog has no unsupported first-party command,
  surface, setting, data behavior, accessibility behavior, or localization.
- Two consecutive pinned upstream profile, migration, sync, and storage suites
  pass without normalized data or event differences.
- Local and SSH acceptance passes on every supported macOS version and both
  supported Linux Remote Agent architectures.
- Backup, migration, interrupted migration, recovery, downgrade warning,
  upgrade, rollback, legacy fallback, offline, crash, stale event, remote
  disconnect, and low-disk drills preserve user data.
- Performance, accessibility, localization, licensing, privacy, security,
  dependency, and notarization reports pass at the final source and product
  digests.
- A Developer ID signed and notarized DMG passes clean install, side-by-side
  installation, copied-profile migration, upgrade, rollback, URL scheme,
  Connector, document integration, and Gatekeeper checks.

### Atomic release rule

No incomplete Electron subset is presented as the replacement product. The
production default changes in one reviewed cutover commit only after the final
acceptance verifier proves every prior stage at the same release digest.

## Data and Mutation Flow

Every user or Agent operation follows this structure:

```text
Workbench surface
  -> active workspace/profile epoch and capability validation
  -> versioned Core or workspace transaction
  -> durable prepare and conflict check
  -> atomic mutation or explicit reviewed TextDocument edit
  -> durable acknowledgement
  -> monotonic event and UI reconciliation
```

Human source edits still pass through the owning TextDocument or QMD revision
guard. Agent edits remain private proposals until the owning Keep, settlement,
promotion, import, or reviewed-annotation transaction accepts them. Knowledge
and Literature never become generic writable Agent roots.

## Failure and Recovery Model

- Core failure leaves repository and IDE functionality usable.
- Remote failure leaves local Zotero editors usable and retains only bounded,
  identity-safe reconnect state.
- Quarto, Preview, Documentation, QMD, or Agent failure is contained to its
  surface and retains last-good content where defined.
- Durable operations distinguish not-started, private-staged, marker-committed,
  mutation-started, text/resources-applied, acknowledged, committed, and
  recovery-conflict states.
- Unknown third-party bytes are never overwritten. They become immutable
  recovery evidence and keep the affected resource gated for explicit review.
- Cleanup removes only disposable state proven to belong to the current
  operation, process, checkout, cache, profile lease, or test fixture.

## Verification and Evidence

Required evidence includes:

- requirement-to-command-to-test-to-surface mappings;
- unit, contract, integration, real-app, parity, fault-injection, performance,
  accessibility, localization, security, and migration results;
- disposable profile/workspace before and after summaries;
- source, upstream, patch, extension, dependency, product, app, Remote Agent,
  and evidence digests;
- complete third-party license and notice inventory;
- screenshots or recordings only for interactions that cannot be asserted
  automatically, bound to product digest and exact reproduction steps;
- CI job identity and supported platform/architecture for external evidence;
- signing and notarization records that contain no private key or credential.

Mandatory skipped tests fail the acceptance verifier. Conditional tests may be
skipped only when their requirement is out of scope for that stage and another
declared stage owns the gate. The final cutover verifier allows no deferred
mandatory requirement.

## Sequencing

Implementation uses dependency-gated stages rather than subsystem completion
in isolation:

1. close Stage 1 runtime and integration failures;
2. complete the Core contract before building writable Zotero UI;
3. close the complete Library surface;
4. add Reader, Notes, citations, and mutations;
5. complete IDE/language and signed remote behavior;
6. complete Agent and Research Loop workflows;
7. run parity closure and atomic cutover.

Work already implemented in a later stage is preserved and tested, but it does
not reorder an unmet prerequisite or count as stage completion by itself.

## External Infrastructure and Credentials

Repository-contained work proceeds without personal credentials. When the
corresponding gate is ready, final acceptance requires separately provisioned:

- disposable Zotero sync/test-server credentials and libraries;
- Linux x64 and arm64 Remote Agent build runners plus SSH fixture hosts;
- Apple Developer ID Application credentials, notarization credentials, and a
  supported macOS test matrix;
- a protected signing key for Remote Agent manifests.

These secrets remain in an approved external secret store. Their absence may
delay an external release gate but never justifies changing or weakening it.

## Known Starting Gaps

The first implementation batch begins from verified current-state evidence:

- the main Workbench, Core, and legacy Node suites pass independently;
- local Documentation Electron integration reproducibly fails the
  `dirty-save-autosave-revert` scenario with a file-modified race;
- the generated application logs a missing GitHub Copilot Chat extension and
  duplicate vendor registration during isolated startup;
- the Core protocol exposes only a small read-only subset of the required
  domains and capabilities;
- Zotero Library, PDF, Note, and annotations are substantially read-only;
- complete-paper remote transfer is disabled and signed release artifacts/CI
  are not complete;
- Main Site, full Literature/promotion/Note bridge/topic graph workflows and
  final executable parity/cutover evidence remain incomplete;
- the installed developer application is ad-hoc signed, not Developer ID
  signed and notarized;
- local `main` is not integrated into `origin/main`, and existing plan
  checkboxes do not reliably describe current implementation status.

## Definition of Complete

The objective is complete only when every named requirement in this design and
the referenced approved subsystem plans has current authoritative evidence at
one release digest, the final verifier reports no missing, failed, stale,
deferred, or mandatory-skipped entry, the production-signed artifacts pass
clean-install and upgrade drills, and the atomic Electron cutover is committed.
