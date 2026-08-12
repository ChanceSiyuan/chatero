# Chatero Unified Agent Knowledge Documentation Design

**Date:** 2026-08-12

**Status:** Product design approved; awaiting written-spec review

**Product:** Chatero

**Decision:** Replace the separate Draft and Knowledge authored roots with one
human- and Agent-editable `documentation/` tree. Code-OSS owns the editing
buffer and filesystem integration, while Agent changes remain private,
multi-file Change Sets until a human settles them.

## Summary

Chatero will expose one Agent Knowledge Documentation corpus, called
**Documentation** in the product. A Documentation page is an ordinary `.qmd`
workspace file. It can be opened either in the standard Code-OSS Text Editor or
in Chatero Live Preview. Both presentations share the same Code-OSS
`TextDocument`, dirty state, save/revert lifecycle, hot-exit behavior, and undo
history.

Live Preview follows the public interaction model of Obsidian Live Preview:
rendered prose and supported structures remain in one continuously editable
source document, and the source syntax for the active structure is revealed
locally. Chatero does not copy Obsidian core code; that code is not published
in the Obsidian GitHub repositories. The implementation will use public
CodeMirror 6 extension mechanisms and the stable Code-OSS custom text editor
API.

Humans edit the canonical `documentation/` files directly through Code-OSS.
The Agent never does. It stages create, edit, rename, and delete proposals in a
private Change Set. The user can continue editing while the proposal exists,
review it by file or hunk, and accept or reject it. Accepted Agent content is
applied through the workspace authority and becomes `working`. Human edits do
not silently change a page's `working` or `reviewed` state.

Migration is explicit, planned, recoverable, and never runs during startup or
upgrade. Legacy Knowledge pages win path collisions and become `reviewed`.
Legacy Draft pages become `working`; a colliding Draft is preserved under a
deterministic migration path rather than merged or overwritten.

## Relationship to Existing Designs

This design refines the QMD portion of the approved
[Code-OSS Zotero workbench design](./2026-08-11-code-oss-zotero-workbench-design.md).
After the final migration and cutover gate, it supersedes the following legacy
contracts:

- separate `drafts/` and `knowledge/` write authorities;
- Draft-only `QmdDraftIO.writeSource` as the human editing path;
- one latest per-Draft proposal under `draft-changes/`;
- the resident Visual Edit, Website Preview, and Monaco Source mode switch;
- promotion from Draft to Knowledge as the way a document becomes trusted.

It does not retroactively change the frozen Gecko implementation. Until the
Code-OSS Documentation cutover is complete, the current `QmdDraftIO` rules
remain authoritative for the legacy parity oracle. The implementation plan
must update repository policy and parity documents at the phase in which
`TextDocument` becomes the production QMD authority.

## Terminology

- **Documentation**: the unified authored research corpus rooted at
  `documentation/`.
- **Documentation page**: a canonical `.qmd` file under that root.
- **Support asset**: a non-document file under `documentation/`, such as a
  raster image. Assets are ordinary workspace files and are not assigned a
  Documentation state.
- **Working**: a page that is still being developed or whose Agent-authored
  change has not yet been marked reviewed.
- **Reviewed**: a human-assigned workflow state that permits default retrieval
  and Main Site publication. It is not an executable-content trust grant.
- **Change Set**: one persistent proposal lineage with a stable ID.
- **Change Set generation**: one immutable revision of that lineage containing
  one or more private, reviewable file operations.
- **Settle**: the human-authorized operation that accepts, rejects, or defers
  reviewed Change Set decisions and applies the accepted subset.
- **Live Preview**: the `chatero.documentation.livePreview` custom text editor,
  backed by the same `TextDocument` as the standard Text Editor.
- **Workspace authority**: the local or remote Code-OSS workspace file service
  that owns repository bytes.

The product must not use “Draft” and “Knowledge” as two current document
classes after cutover. Those names remain only in migration reports, recovery
artifacts, and historical documentation.

## Goals

1. Provide one physical `documentation/` tree that humans and the Agent can
   both improve without creating two sources of truth.
2. Give humans an Obsidian-like, source-preserving Live Preview for QMD while
   keeping the standard Text Editor available.
3. Render and edit prose, headings, formulas, Markdown tables, relative
   images, theorem blocks, lemma blocks, and proof blocks in one document.
4. Preserve exact QMD source for unsupported or ambiguous syntax and reveal
   source locally whenever the user edits a visual structure.
5. Preserve proof-block visualization, editability, and per-view collapse.
6. Keep every Agent change private and reviewable while allowing concurrent
   human editing.
7. Use the same authority, security model, behavior, and tests for local and
   SSH workspaces.
8. Migrate legacy Drafts, Knowledge, support assets, and valid pending
   proposals without overwriting or silently deleting user content.
9. Ensure Documentation, Live Preview, Quarto, or migration failures never
   prevent Zotero Core from starting.

## Non-goals

- Reimplementing the Code-OSS text model, save service, hot exit, file watcher,
  diff editor, or undo stack.
- Copying or depending on unpublished Obsidian core source.
- Converting QMD into a rich-text AST and serializing the AST back to source.
- Making canonical Documentation pages `.md`. External Literature may remain
  `.md` or `.qmd` and read-only.
- Rendering arbitrary HTML, SVG, command URIs, or network resources inside Live
  Preview.
- Executing QMD code during Live Preview, exact preview, retrieval, review, or
  publication.
- Treating `reviewed` as proof that a document is safe to execute.
- Giving the Agent a direct canonical write, promotion, migration, or state
  mutation tool.
- Adding Agent-created or Agent-edited binary assets in the first release.
- Automatically migrating a personal workspace during application startup,
  upgrade, bootstrap, or test setup.
- Removing the Gecko parity oracle before the complete cutover gate passes.

## Repository Layout and Canonical Format

After cutover, a QLab workspace has this logical layout:

~~~text
<workspace>/
├── documentation/
│   ├── index.qmd
│   ├── topics/
│   │   └── example.qmd
│   └── assets/
│       └── figure.png
├── literature/                         # external/read-only research inputs
├── .chatero/
│   └── documentation-state.v1.json     # versioned workflow state
└── work/qlab-zotero/
    ├── documentation-changes/          # private Agent Change Sets
    └── documentation-migration/        # private journals and recovery data
~~~

The only canonical authored Documentation format is QMD. `documentation/**/*.qmd`
is therefore the document corpus. The tree may also contain relative support
assets, but those assets do not become pages and are not included in page
state.

QMD remains plain text:

- it opens in the standard Text Editor without conversion;
- external editors and Git can read and modify it normally;
- Live Preview does not introduce a sidecar body format;
- merely opening, focusing, scrolling, rendering, folding, or switching editor
  presentation cannot change its bytes.

The Chatero source repository must never contain a user's Documentation,
Literature, Change Sets, migration journals, recovery copies, or workflow
state. All of these paths refer to an external, user-selected QLab workspace.

## Authority Model

The workspace file service continues to own repository bytes. For open files,
the Code-OSS `TextDocument` is the sole logical editing buffer and the source
of dirty, save, revert, hot-exit, and undo/redo behavior. A Live Preview
CodeMirror `EditorState.doc` is an unavoidable transient view mirror; it is not
a second persistence authority or history.

| Actor | Permitted action | Authority path |
| --- | --- | --- |
| Human in standard Text Editor | Edit canonical QMD | `TextDocument` and normal Code-OSS save |
| Human in Live Preview | Edit canonical QMD | Minimal `WorkspaceEdit` into the same `TextDocument` |
| Human state command | Mark Working or Reviewed | Documentation transaction service |
| Agent | Stage a Change Set only | Private `documentation-changes/` generation |
| Human reviewer | Settle reviewed decisions | Documentation transaction service plus workspace authority |
| Human migration command | Execute an approved migration plan | Documentation transaction service |
| Quarto/renderer/indexer | Read snapshots only | Workspace file service |

Human Apply actions originating from Chat or Reader are human-triggered edits,
not Agent authority. They enter the current `TextDocument` as a
`WorkspaceEdit`. No `Zotero.QLab.insertIntoQmd`-style mutation API is exposed
to the Agent.

### Deep transaction interface

All Documentation mutations outside ordinary human typing pass through one
deep module. Its public shape is:

~~~ts
type DocumentationStateName = "working" | "reviewed";

interface DocumentationTransactions {
  state(scope: OpaqueWorkspaceScope): Promise<DocumentationState>;

  stage(
    grant: AgentProposalGrant,
    input: {
      idempotencyKey: string;
      parentRef?: ChangeSetRef;
      expectedGeneration?: string;
      operations: ReadonlyArray<Create | Edit | Rename | Delete>;
    },
  ): Promise<
    ChangeSet | StaleGeneration | InvalidProposal | IdempotencyConflict
  >;

  review(ref: ChangeSetRef): Promise<ReviewSnapshot>;

  settle(
    approval: HumanApproval,
    input: {
      reviewToken: string;
      decisions: ReadonlyMap<StableChangeId, "accept" | "reject" | "defer">;
      idempotencyKey: string;
    },
  ): Promise<
    Committed
      | StaleReview
      | Conflict
      | IncompleteDecisionSet
      | InvalidDecisionSet
      | DirtyWorkingCopy
      | Recovering
      | RecoveryConflict
      | IdempotencyConflict
  >;

  setDocumentState(
    approval: HumanApproval,
    input: {
      path: DocumentationPath;
      expectedDocumentRevision: string;
      expectedStateGeneration: string;
      state: DocumentationStateName;
      idempotencyKey: string;
    },
  ): Promise<
    StateCommitted
      | StaleState
      | StaleDocument
      | DirtyWorkingCopy
      | IdempotencyConflict
  >;

  planMigration(
    scope: OpaqueWorkspaceScope,
  ): Promise<MigrationPlan>;

  migrate(
    approval: MigrationApproval,
    input: {
      planToken: string;
      idempotencyKey: string;
    },
  ): Promise<
    MigrationCommitted
      | StalePlan
      | Recovering
      | RecoveryConflict
      | IdempotencyConflict
  >;

  resolveRecovery(
    approval: RecoveryApproval,
    input: {
      recoveryToken: string;
      resolutions: ReadonlyMap<
        DocumentationPath,
        "keep-current" | "restore-before" | "apply-intended"
      >;
      idempotencyKey: string;
    },
  ): Promise<
    RecoveryResolved
      | StaleRecovery
      | RecoveryConflict
      | IdempotencyConflict
  >;
}
~~~

The types `OpaqueWorkspaceScope`, `AgentProposalGrant`, `HumanApproval`,
`MigrationApproval`, `RecoveryApproval`, and `ChangeSetRef` are unforgeable,
scope-bound capabilities issued by the workspace and UI authority. Approval
capabilities are single-use and short-lived. They bind the workspace epoch and
the exact request digest: settlement binds `reviewToken + decisions`, state
change binds path + document revision + state generation + target state,
migration binds `planToken`, and recovery binds `recoveryToken + resolutions`.

An `AgentProposalGrant` additionally binds allowed Documentation paths,
operation kinds, maximum operation count, and maximum proposed bytes. Public
methods never accept a caller-supplied workspace root, absolute path, remote
authority string, private Change Set path, or arbitrary file-service adapter.

The Agent receives only `stage` capability. It cannot call `settle`,
`setDocumentState`, `migrate`, or `resolveRecovery` and cannot obtain or reuse
a human capability by constructing JSON with the same shape.

### Hidden invariants

The transaction module owns and enforces:

- canonical containment after URI normalization and symlink resolution;
- QMD-only Agent mutation targets in the first release;
- revision binding for every source and destination;
- state generation and state-file validation;
- immutable Change Set generations and stable hunk identities;
- dependency ordering for structural and text operations;
- three-way reconciliation against current human content;
- idempotency keys, transaction journals, receipts, recovery, and
  `RecoveryConflict` evidence;
- local and remote execution adapters;
- legacy proposal conversion and migration recovery.

It exposes no generic `read`, `write`, or `exists` methods from which callers
could recreate a read-then-write race. Internal adapters expose higher-level
`snapshot`, `transact`, and `recover` operations.

### Local and remote authority

Local resource operations execute beside the local workspace file authority.
Remote resource operations send the complete transaction, including
preconditions, to the Chatero Remote Agent for validation and execution beside
the remote workspace. They must not decompose one structural settlement or
migration into independent per-file RPC writes. Text working-copy edits still
flow through `TextDocument` and `WorkspaceEdit` so the remote Code-OSS file
authority retains normal dirty, undo, and hot-exit behavior.

Both adapters implement the same contract and run the same conformance suite.
Neither renderer nor built-in extension uses Node `fs`, a private polling
watcher, or an alternate remote path mapping for Documentation.

### Transaction guarantee

Ordinary filesystems cannot promise that an unrelated external process will
observe an instantaneous multi-file commit. Nor can a journal safely roll
over a third-party edit made during recovery. Chatero therefore promises a
**recoverable, conflict-preserving transaction**, not snapshot isolation or an
unconditional all-before/all-after result:

1. all preconditions are checked against one captured generation and checked
   again immediately before the first canonical resource mutation;
2. intended outputs and an immutable journal are durably staged;
3. canonical operations and the state update are applied in dependency order;
4. an immutable receipt records the committed result;
5. after a crash, recovery rolls forward or restores only when every observed
   revision matches a journaled before, intermediate, or intended revision;
6. any unrecognized revision produces `RecoveryConflict` with before, current,
   and intended bytes preserved for human resolution.

Only the affected transaction and paths enter `Recovering` or
`RecoveryConflict`. Zotero Core, other workspaces, unrelated files, and
read-only Literature remain available. No recovery path overwrites a
third-party revision merely to make the receipt look complete.

### Persistent operation state and idempotency

Every settlement, state change, structural operation, migration, and recovery
resolution has one durable operation record. Its lifecycle is:

~~~text
prepared
  -> applying
  -> text-applied and/or resources-applied
  -> metadata-applied
  -> committed

prepared/applying/intermediate
  -> recovering
  -> committed | aborted | recovery-conflict

recovery-conflict
  -> resolving
  -> committed | aborted | recovery-conflict
~~~

The Change Set generation separately records `open -> settling ->
settled/rejected` and points to the operation record. It remains
`settling` while that operation is `recovering` or `recovery-conflict`. A
deferred child is published only when the parent operation is `committed`.

The idempotency registry is keyed by workspace epoch, operation kind, and
idempotency key, and stores the exact request digest:

- the same key and same digest returns the existing in-flight state or prior
  result without consuming a second approval or applying anything twice;
- the same key with a different digest returns `IdempotencyConflict`;
- an approval is marked consumed together with creation of the `prepared`
  record, so a crash cannot create an unrecorded reusable approval.

For text-only settlement, “all or nothing” applies only to the body changes in
the single text-only `WorkspaceEdit`. The `prepared` record exists first.
`text-applied` records the resulting document versions; workflow state,
receipt, and deferred-child metadata are then projected before `committed`.
If that projection fails, touched pages are conservatively `working` through
the in-flight overlay and recovery resumes from the recorded document
versions. This does not pretend that metadata was part of the
`WorkspaceEdit`.

`RecoveryConflict` produces a human review containing before, current, and
intended bytes plus structural state for every affected path. The
`resolveRecovery` method requires an explicit resolution for every path:
keep the external current state, restore the journaled before state, or apply
the journaled intended state. Restore/apply choices are themselves
revision-checked transactions; a further external change returns a fresh
`RecoveryConflict`. No automatic retry can make that destructive choice.

## Human Editing and Live Preview

### Editor registration and selection

Chatero contributes a `CustomTextEditorProvider` for Documentation QMD with
view type `chatero.documentation.livePreview` and contribution priority
`option`. The stable contribution API makes an optional editor available
without taking the standard Text Editor away.

The setting `chatero.documentation.livePreview` is a boolean and defaults to
`true`:

- `true` makes Chatero's Documentation Explorer and Documentation open
  commands request Live Preview;
- `false` makes those Chatero commands request the standard Text Editor;
- ordinary Code-OSS file opens continue to honor the user's
  `workbench.editorAssociations`;
- the user can independently configure Live Preview as the Workbench default
  for a chosen QMD glob;
- “Reopen Editor With…” always offers both presentations;
- a split may show the standard Text Editor and one or more Live Preview views
  of the same `TextDocument` at once.

The setting changes presentation only. It never changes the file type,
authority, state, or save semantics.

### TextDocument bridge

Each open URI has one extension-host bridge that serializes edits from all Live
Preview views:

1. The provider initializes a view with the exact source text and
   `document.version`.
2. CodeMirror displays that text in an `EditorState` with CodeMirror history
   disabled.
3. A user transaction updates the view optimistically and immediately sends
   `{ opId, baseVersion, changes }`. Changes use Code-OSS/CodeMirror UTF-16
   offsets.
4. The bridge validates the base version and, in the same per-URI serialized
   turn, applies the smallest practical `WorkspaceEdit` to the `TextDocument`.
   Code-OSS stamps the edit with the current text-model version during
   extension-host serialization; a later version cannot accept its old ranges.
5. `onDidChangeTextDocument` is the only commit acknowledgement. The bridge
   broadcasts the authoritative delta and new version to every view.
6. The originating view acknowledges its pending operation. Other views apply
   the delta with a `hostSync` annotation that update listeners ignore, which
   prevents an echo loop.

Pending deltas, operation IDs, and base versions may be recovery state; the
complete document body is not persisted as webview state. Every keypress that
changes text becomes dirty through the `TextDocument` path rather than a
separate Live Preview dirty flag.

Save, Save As, autosave, revert, close confirmation, hot exit, external clean
reload, and dirty-file conflict handling remain normal Code-OSS behavior.

### Version mismatch and conflict behavior

When a pending operation no longer matches `document.version`:

- the bridge sends the current authoritative snapshot;
- non-overlapping pending changes are mapped and replayed in order;
- overlapping changes are preserved as a visible local source conflict;
- no side silently wins and no full-document `setValue` overwrites history.

If the bridge or SSH connection drops, acknowledged `TextDocument` edits remain
normal hot-exit content. Received but unacknowledged operation deltas remain
recoverable and visibly pending. On reconnect, the bridge validates their base
before replay. Chatero never reports an unacknowledged edit as saved.

Code-OSS does not expose stable custom undo-stop grouping for
`workspace.applyEdit`. The first release therefore defines one CodeMirror user
transaction as one Workbench undo unit. Undo and redo first drain the bridge
queue and then invoke normal Workbench undo/redo. Chatero will not patch
Code-OSS core merely to emulate a different word-grouping heuristic.

### Source-preserving rendering model

The CodeMirror document always contains the original QMD. An incremental Lezer
parse and source-coordinate annotations identify supported nodes by
`[from, to)` UTF-16 ranges. Decorations and widgets render those ranges; they
do not replace the underlying source with a normalized AST.

The rendering rules are:

- supported inactive syntax is rendered in place;
- moving the cursor into or selecting a structure reveals the smallest
  editable source range for that structure;
- leaving the structure restores its visual presentation;
- ambiguous, invalid, nested beyond current support, or unknown syntax falls
  back to source for the smallest safe range;
- parsing or widget failure in one range cannot make the rest of the document
  read-only;
- presentation-only activity is byte-preserving.

This is intentionally Live Preview rather than a separate whole-document
Visual mode.

### Supported visual structures

The first complete Live Preview release supports:

- prose, headings, emphasis, lists, links, and code spans;
- inline and display formulas rendered with KaTeX;
- Markdown tables rendered as a table while inactive;
- workspace-relative raster images;
- existing Chatero theorem and lemma fenced-Div forms;
- existing Chatero proof blocks, including label/title content and formulas;
- local source reveal for editing every supported structure.

For a table, entering a cell reveals its complete source row while the other
rows remain visual. Live Preview never rebuilds and serializes the entire
table. For a formula, entering the formula reveals the original delimiters and
expression. For an image, entering the node reveals the original Markdown
target and attributes.

The formal-block parser preserves the exact fenced-Div syntax, IDs,
attributes, labels, and body bytes. It recognizes current theorem
`#thm-*`, lemma `#lem-*`, and proof class forms without converting one form to
another.

### Proof collapse

Proof collapse is per-view presentation state:

- `collapse="true"` establishes the initial collapsed state;
- a missing or false `collapse` attribute establishes the initial expanded
  state;
- the disclosure control can expand or collapse the rendered proof;
- toggling the disclosure control does not edit the QMD;
- entering the proof or its attributes reveals editable source;
- explicitly editing the `collapse` attribute changes future initial state
  through the normal text edit path;
- a source selection inside a collapsed proof expands it temporarily so the
  selection is never hidden.

A new view derives its initial state from the QMD attribute. Interactive fold
state is not shared between split views and is not written to repository
metadata.

### Exact Quarto preview

Live Preview is the primary editor. A separate command may open an exact,
read-only Quarto preview for publication fidelity. It is not a resident third
editing surface and never owns source.

Every Quarto invocation uses `--no-execute`, a document-scoped working
directory, loopback-only serving, and workspace trust checks. Preview failure
reports a Code-OSS Problem and retains the last successful preview. It does not
disable Live Preview, Text Editor editing, Zotero Core, or workspace access.

## Agent Change Sets

### Immutable generations

A Change Set lineage is identified independently of a chat turn and survives
editor, conversation, window, and application changes. Each immutable
generation contains:

- Change Set ID and generation ID;
- non-secret repository and authority identities plus a digest of the grant;
- idempotency key and creation metadata;
- ordered create, edit, rename, and delete operations;
- source and destination workspace-relative Documentation paths;
- an immutable base blob, SHA-256 digest, and originating saved revision or
  `document.version` for every edit, rename, and delete;
- an explicit target-absent precondition for every create;
- full proposed text plus derived stable hunks for text operations;
- structural dependencies between operations and hunks;
- the state generation against which it was staged;
- validation diagnostics and recovery metadata.

Capabilities and approval tokens are never serialized into a generation,
journal, or receipt.

Base blobs are private proposal evidence and persist with the generation. A
generation staged from a dirty open page captures the exact `TextDocument`
bytes and version the Agent saw, not the older on-disk file. ReviewSnapshot,
restart recovery, and three-way reconciliation always read this stored base;
they never attempt to reconstruct it from a later revision or from a diff.

Generations are immutable. Asking the Agent for a second revision requires the
current `parentRef` and `expectedGeneration` and creates a child generation in
the same lineage; it never mutates the material currently under review. A new
proposal omits both fields and receives a new lineage ID. Supplying only one
revision field, or naming a non-current parent, returns a stale-generation
result without creating files.

Create requires the target to be absent. Edit binds a base revision. Delete
binds the unchanged source revision. Rename binds both the source revision and
target absence. Rename cycles, duplicate targets, case-folding collisions,
ancestor/descendant conflicts, and symlink escapes are rejected before a
reviewable generation is created.

### Staging boundary

The Agent can propose QMD create, edit, rename, and delete operations but
cannot write canonical `documentation/` files, workflow state, migration data,
or support assets. Staging writes only beneath:

~~~text
work/qlab-zotero/documentation-changes/<change-set>/<generation>/
~~~

Canonical content remains byte-for-byte unchanged until human settlement.
Cancellation or Agent failure preserves any already-created valid generation
for review and leaves canonical files untouched.

This is an Agent-runtime policy, not merely a limitation of the Documentation
stage tool. Generic Agent file-edit and shell capabilities cannot write
`documentation/**`. Scoped Documentation reads remain available under the
retrieval policy. The private control roots `.chatero/**`,
`work/qlab-zotero/documentation-changes/**`, and
`work/qlab-zotero/documentation-migration/**` are unavailable for generic
Agent reads or writes; only typed services can access them with the appropriate
capability. A user manually typing a terminal command remains a human
filesystem action. Workspace trust is necessary for Agent staging, but trust
alone never grants these reserved-root accesses.

### Review surfaces

The same Change Set is visible from:

- the originating Chat turn;
- a Documentation Changes view integrated with the workbench's Source
  Control-style review affordances;
- editor gutter and tab indicators for affected open pages.

The authoritative comparison is the standard Code-OSS text diff. Live Preview
may offer an inline convenience rendering, but it cannot replace the exact
source diff.

A `ReviewSnapshot` binds:

- Change Set and generation;
- base, current human, and proposed text;
- current document revisions or open `document.version` values;
- current state generation;
- stable hunk IDs and structural dependencies;
- one opaque review token covering all of the above.

Line number or array position is never used as a settlement identity.

### Decisions and settlement

The user can accept, reject, or defer at hunk, file, or whole-Change-Set level.
The submitted map must resolve every leaf in the bound ReviewSnapshot.
Omissions return `IncompleteDecisionSet`; contradictory parent/child or
dependency decisions return `InvalidDecisionSet`. Create, rename, and delete
are indivisible structural decisions. Text hunks that depend on a rename
cannot be accepted while rejecting that rename.

At settlement:

1. the service validates the one-use approval, review token, complete decision
   map, and all current revisions;
2. clean non-overlapping human edits are three-way reconciled;
3. the service precomputes the complete accepted result and any deferred child
   generation; a conflict in either produces zero applied decisions;
4. overlapping edits return a conflict with base, current, and proposed text
   preserved;
5. under the shared per-URI working-copy mutex, the service rechecks every
   `document.version`, constructs the edit, and immediately calls one text-only
   `WorkspaceEdit`, including documents not previously visible in an editor;
6. create, rename, and delete remain resource operations; dirty open rename or
   delete targets return `DirtyWorkingCopy` and are not changed behind the
   editor;
7. accepted resource operations and state updates enter one recoverable,
   conflict-preserving transaction;
8. rejected material is recorded in the receipt and does not affect canonical
   files;
9. deferred material becomes a new immutable child generation rebased on the
   committed result.

Settlement does not auto-save edits to existing QMD buffers. Accepted text
becomes normal dirty Workbench content, remains undoable, participates in hot
exit, and is saved by the user's normal save policy. The receipt distinguishes
“applied to working copies” from “saved by the workspace file service.”
Create, rename, and delete require clean affected working copies because their
resource changes are persistent.

Text-only settlement uses the all-or-nothing behavior of one text-only
`WorkspaceEdit`. A settlement that includes resource operations uses the
journaled mixed-operation path and can enter `RecoveryConflict`; it does not
claim filesystem atomicity. The state projection treats every touched target
as `working` as soon as the accepted decision is applied and remains
conservatively working after later Undo, Revert, or conflict recovery.

The final version check is not a free-standing read followed by an unguarded
write. The Live Preview bridge and settlement service share a per-URI queue,
and Code-OSS serializes each text edit with the current `versionId` when
`workspace.applyEdit` crosses from the extension host to the bulk-edit
service. A standard Text Editor change that races after Chatero's final check
therefore changes the model version and makes the old-range edit fail; it
cannot land on the newer text. Settlement records `text-applied` only after
`applyEdit` succeeds and matching `onDidChangeTextDocument` events confirm all
expected versions. Failure returns a fresh review requirement without
committing state or a deferred child.

For a mixed generation, the service durably stages the intended text overlay
before committing create/rename/delete resource operations. It then applies
the overlay to the resulting `TextDocument` working copies. The receipt
records `ResourceCommitted` and `TextApplied` separately. Failure between them
enters `Recovering`; a changed target enters `RecoveryConflict` instead of
being overwritten. A deferred child generation is not exposed until both
parts are complete. Workbench Undo can undo the text overlay, but reversing an
accepted create, rename, or delete is a new, explicitly reviewed transaction.

Delete never rebases across a human modification. Rename remains a structural
operation and never silently degrades into “edit the old path.”

Accepted Agent create, edit, and rename targets become `working`. A deleted
page loses its state entry. If a user invokes Workbench Undo after settlement,
the body follows normal undo behavior, while the page conservatively remains
`working` until the user explicitly reviews it again.

## Workflow State, Retrieval, and Publication

### State representation

State is repository-owned, versionable metadata, not QMD frontmatter:

~~~json
{
  "schemaVersion": 1,
  "generation": "0000000000000001",
  "documents": {
    "index.qmd": { "state": "reviewed" },
    "topics/example.qmd": { "state": "working" }
  }
}
~~~

State is deliberately path-scoped, not a hidden logical-document identity.
Paths are normalized relative to `documentation/`. Chatero create, rename, and
delete commands go through the transaction module, which creates, moves, or
removes their state entries.

The safe defaults are:

- a new human-created page is `working`;
- a missing entry is `working`;
- an invalid, unsupported, or partially corrupt state snapshot is rejected as
  a whole; every page becomes `working` and a diagnostic is emitted;
- a normal human text edit preserves the current state, including `reviewed`;
- an accepted Agent change makes every touched target `working`;
- only an explicit human command marks a page `reviewed` or `working`.

State commands bind both the document revision and state generation. Mark
Reviewed requires a clean, saved page; when invoked on a dirty page, the UI
offers normal Save and continues only after its acknowledgement. This prevents
a reviewed marker from being committed against content other than the content
the user inspected.

External structural changes are reconciled conservatively:

- a newly observed path with no state entry is `working`;
- a missing path's entry is orphaned, excluded from retrieval/publication, and
  reported until a human removes it or the path returns;
- an externally detected rename is a missing old path plus a new `working`
  path; Chatero does not guess rename identity;
- state follows the path for same-path content replacement, because an offline
  delete-and-recreate cannot be distinguished reliably from a complete human
  rewrite without putting identity into QMD.

The final rule is an intentional consequence of the approved requirement that
human edits, including complete rewrites, preserve `reviewed`. Since
`reviewed` grants no execution authority, path-scoped state must not be used
as a security boundary.

State controls workflow and selection; it does not grant code execution,
filesystem access, network access, or command execution.

### Agent retrieval

Automatic background Documentation retrieval uses `reviewed` pages by default
and ranks them above other research text. A `working` page is eligible only
when:

- it is the current page;
- the user explicitly attaches or mentions it; or
- the user includes working pages in Documentation search.

Every retrieved `working` passage is visibly labeled and receives lower
default ranking. The Agent can propose changes to either state, but settlement
returns touched pages to `working`.

Background indexing reads saved workspace snapshots. Explicit context from an
open page reads its current `TextDocument` snapshot and records
`document.version` plus a dirty label, so an Agent proposal can be reviewed
against the exact human text it saw.

### Main Site

Main Site publishes only `reviewed` Documentation pages. `working` pages can be
rendered in a clearly labeled local or remote preview but cannot enter the
published navigation or search index.

Publication includes only support assets reached from included reviewed pages;
an unreferenced asset or an asset reachable only from a working page is not
published.

Publication is always no-execute. Reviewed pages are content approved for the
site and default retrieval, not trusted programs.

## Legacy Migration

### Explicit plan and approval

Migration is invoked by a human command such as “Migrate Drafts and Knowledge
to Documentation.” It has two separate steps:

1. a read-only dry run produces an immutable plan, collision report, link
   rewrite report, proposal report, source hashes, target preconditions, and
   opaque plan token;
2. an explicit human approval capability executes that exact plan.

Any source hash, directory entry, state generation, dirty affected working
copy, or target precondition change detected before the first canonical
mutation makes the plan stale and produces zero canonical writes. Private
bootstrap/staging evidence may remain for diagnosis. The user must inspect a
new plan. Startup, extension activation, SSH connection, and repository
bootstrap never count as approval. A third-party race detected after a legacy
root has moved produces `RecoveryConflict` and can never be reported as a
successful migration.

A pre-existing non-empty `documentation/` root without a matching in-progress
migration receipt is treated as a mixed-layout conflict. The planner reports
it and refuses to overwrite or guess precedence.

### Deterministic mapping

For every legacy relative path `x`:

| Legacy source | Target | Page state |
| --- | --- | --- |
| `knowledge/x.qmd` | `documentation/x.qmd` | `reviewed` |
| `drafts/x.qmd` with no target collision | `documentation/x.qmd` | `working` |
| `drafts/x.qmd` colliding with Knowledge | `documentation/<conflict-root>/x.qmd` | `working` |

Knowledge wins the canonical target path. Chatero never attempts semantic or
line-based auto-merge during migration.

The planner selects one deterministic `<conflict-root>` for the entire
migration:

1. try `_migrated/drafts`;
2. then try `_migrated-1/drafts`, `_migrated-2/drafts`, and so on in ascending
   decimal order;
3. choose the first candidate for which no non-conflict output file equals the
   candidate, lies below it, or occupies a file-ancestor path.

The planned output set is finite, so this algorithm always finds a root. All
colliding Draft paths retain their complete relative path below it; distinct
legacy paths therefore remain distinct without a truncated-hash collision or
a hard stop. The chosen root and full mapping are recorded in the plan and
receipt.

Support assets use the same precedence and the same chosen conflict root:
Knowledge wins an equal target path, while a colliding Draft asset moves below
`<conflict-root>`. State is created only for QMD pages.

### Link and route rewriting

The plan rewrites only references that a structure-aware handler can prove
refer to a moved workspace-relative target:

- Markdown links and images;
- supported QMD cross-reference targets;
- the `project.render`, `website.navbar`, and `website.sidebar` path-bearing
  entries in parsed Quarto project YAML;
- Chatero Main Site route metadata;
- valid legacy proposal `originalPath` and related path fields.

Rewrites are calculated from the complete source-to-target path map, so a
collided document and its moved assets retain correct relative references.
Code fences, inline code, unknown raw blocks, external URLs, and ambiguous
strings are never search-and-replaced. They appear in the migration report for
human follow-up.

### Pending proposals

Valid legacy proposal records under `work/qlab-zotero/draft-changes/` are
converted into independent Documentation Change Set lineages. Multiple valid
records for one original path are all imported in deterministic
path/manifest-digest order; exact duplicates are labeled in the report rather
than discarded.

For each imported record, migration keeps the original base and proposed blobs
unchanged as audit evidence. It also derives migrated base and proposed review
blobs by applying the same structure-aware path mapping to both sides.
Review and three-way reconciliation use the migrated pair, preventing a later
settlement from restoring legacy links. The receipt records hashes for both
original blobs, both migrated blobs, and the transformation manifest.

Malformed, unrecognized, or path-escaping proposals are moved to a quarantine
area under the migration recovery directory and listed in the receipt. They
are never silently skipped or deleted.

### Recovery and cutover

Execution uses a journaled sequence:

1. validate the one-use approval, plan token, and captured revisions;
2. write a bootstrap journal before the first private staging write;
3. stage the complete new tree, state file, converted Change Sets, and rewrite
   results;
4. validate staged hashes and containment;
5. acquire the authority-local migration lease, require affected working copies
   to be clean, and revalidate every source, directory entry, and target
   immediately before the first canonical mutation;
6. move `drafts/`, `knowledge/`, and the legacy `draft-changes/` proposal root
   into the receipt's private recovery area and verify that the moved snapshot
   still matches the plan;
7. install `documentation/`, its state, and converted Change Sets;
8. verify canonical hashes and converted proposals;
9. record an immutable committed receipt and release the lease.

On restart or reconnect, recovery inspects the journal and receipt before
allowing affected writes. It completes or restores a step only when current
revisions match journaled proof. Otherwise it records `RecoveryConflict` and
preserves before, current, and intended content for human resolution. Recovery
copies remain private and are never indexed or published. Chatero does not
delete them automatically.

The same plan and recovery contract runs on local and SSH workspaces. A remote
migration's authority-side transaction ends when the committed receipt is
durable; personal content never transits the local renderer. The local
extension observes that receipt and idempotently projects routers, retrieval,
site, and UI labels to Documentation. This projection is rebuildable after
restart and is not falsely included in the remote filesystem transaction.

## Security and Trust

### Path authority

Every Documentation path is a normalized workspace URI relative to the
capability's `documentation/` root. Operations reject:

- absolute paths and URI authority changes;
- `..` traversal after normalization;
- symlinks or junctions that escape the root;
- case-folding aliases on case-insensitive filesystems;
- duplicate or ancestor-conflicting targets;
- writes through Literature, migration recovery, or another workspace.

The transaction service revalidates containment at commit time. A safe
planning result is not treated as permanent proof.

### Live rendering

Live Preview uses a restrictive webview CSP and `asWebviewUri`. Image preview
accepts only relative, workspace-contained PNG, JPEG, GIF, WebP, or AVIF files
whose detected MIME matches the file content. The default encoded-size limit
is 20 MiB per image; larger files show a source-linked placeholder.

Live Preview never loads:

- `http:`, `https:`, `file:`, or foreign-authority resources;
- SVG or `data:` images;
- raw HTML as active DOM;
- script, iframe, object, embed, or command URIs.

KaTeX runs with trust disabled. Rendered links navigate only through the
workbench's validated link handler. Unknown HTML and unsupported QMD remain
editable source.

Safe passive Live Preview is allowed in an untrusted workspace. Quarto
processes, Agent staging/settlement, migration, and any operation that can
change multiple files require normal workspace trust. Workspace trust is only
a prerequisite; it does not weaken Agent capability or reserved-root rules.

## Failure and Degradation

| Failure | Required behavior |
| --- | --- |
| One QMD node cannot parse or render | Fall back only that safe range to source; keep the document editable |
| Formula or table widget throws | Replace the widget with a diagnostic/source placeholder |
| Image is missing, unsafe, or too large | Show a non-active placeholder and source target |
| Quarto is absent or exits | Report a Problem, retain last-good preview, continue editing |
| Live Preview edit version is stale | Map non-overlap; preserve overlap as visible source conflict |
| Live Preview bridge disconnects | Keep acknowledged TextDocument edits and recover received pending deltas; never claim they are saved |
| SSH disconnects during edit | Leave pending edits visible and retry only after revision validation |
| Review token is stale | Make zero canonical changes and produce a fresh ReviewSnapshot |
| Approval is expired, reused, or request-digest mismatched | Reject it without applying any decision |
| Exact idempotent request is retried | Return the existing state/result without reapplying |
| Idempotency key is reused with different payload | Return IdempotencyConflict |
| Decision map is incomplete or contradictory | Return the typed decision error and make zero changes |
| Human edit overlaps Agent hunk | Preserve base/current/proposed and require conflict resolution |
| Rename/delete target is dirty | Refuse the structural operation without background overwrite |
| Transaction crashes | Mark affected paths Recovering; complete only from matching journaled revisions |
| Third-party edit appears during recovery | Enter RecoveryConflict and preserve before/current/intended content |
| Human recovery choice races another edit | Return a fresh RecoveryConflict; never overwrite it |
| State file is missing/corrupt | Reject the snapshot, treat every page as working, and report a diagnostic |
| Migration plan becomes stale before canonical mutation | Make zero canonical writes and require a new dry run |
| Legacy proposal is damaged | Quarantine and report it; never delete it |
| Documentation subsystem fails to activate | Keep standard Code-OSS editing and Zotero Core available |

## Verification Strategy

Implementation is test-first and split into independently shippable vertical
slices. Existing test files are not evidence by themselves: at the design
audit, the legacy QMD Node tests stopped during module loading because the
workspace lacked `katex`. The implementation plan must establish a
reproducible dependency/bootstrap path before calling that suite green.

### Unit, property, and fuzz tests

Tests cover:

- UTF-16 edits, surrogate pairs, combining characters, CRLF, and final-newline
  preservation;
- source ranges for nested, malformed, and unknown QMD;
- byte preservation when a document is only viewed or supported nodes are not
  edited;
- formula, table, image, theorem, lemma, and proof source mapping;
- proof initial collapse and presentation-only folding;
- path-scoped state defaults, state generation, Chatero rename/delete updates,
  external structural reconciliation, same-path replacement, and corruption;
- stable hunk IDs, immutable lineages/generations, parent validation, complete
  decisions, persisted base blobs, capability request binding, exact retries,
  idempotency-key conflicts, and operation-state transitions;
- three-way non-overlap replay and overlap preservation;
- create/edit/rename/delete preconditions, cycles, case collisions, and
  ancestor conflicts;
- traversal, symlink escape, URI authority changes, and MIME/content mismatch;
- migration mapping, total deterministic conflict-root allocation, safe
  reference rewriting,
  original/migrated proposal blobs, multiple valid proposals, stale plans,
  post-validation races, and crash injection at every journal boundary;
- recovery proof matching and `RecoveryConflict` preservation when an external
  writer creates an unrecognized revision.

### Code-OSS integration tests

The integration suite proves:

- standard Text Editor and Live Preview share one `TextDocument`;
- the Live Preview setting controls Chatero open commands while ordinary opens
  and user editor associations remain intact;
- multiple Live Preview views and source splits synchronize without echo;
- the first changing keypress marks the Workbench document dirty;
- save, autosave, revert, close, hot exit, restart, undo, and redo follow
  Workbench semantics;
- one CodeMirror transaction produces one Workbench undo unit;
- clean external edits reload and dirty external edits cannot overwrite memory;
- version mismatches replay only safe non-overlapping pending edits;
- an injected standard-editor change between final review validation and bulk
  apply causes the version-bound `WorkspaceEdit` to fail without placing an
  old range on new text;
- the same scenarios pass under local and SSH authorities;
- disconnect/reconnect recovers edit queues and transaction journals;
- QLab/Documentation activation failure does not prevent Zotero Core startup.

### Visual behavior tests

Fixtures exercise prose, headings, inline/display formulas, tables, relative
images, nested formal blocks, theorem/lemma IDs, proof formulas, proof
collapse, malformed Divs, YAML, citations, code cells, and unknown extensions.

For every supported visual structure, tests prove that:

- its inactive visual presentation is correct;
- focusing it reveals the intended minimum source;
- editing updates exactly the corresponding source range;
- switching focus restores visual presentation;
- folding, scrolling, navigating, splitting, and reopening do not rewrite
  bytes.

### Change Set tests

Tests cover staging without canonical mutation, file/hunk/all review, stable
review tokens, one-use content-bound approvals, incomplete/invalid decisions,
persisted dirty/saved base snapshots, concurrent human edits, non-overlap
replay, three-text conflict, structural dependencies, dirty rename/delete
refusal, partial settlement, deferred-child creation, every persistent
operation-state transition, exact retry after each crash point, mixed
`ResourceCommitted`/`TextApplied` recovery, reject, Workbench text undo after
settlement, explicit inverse structural transactions, state effects, restart
persistence, cancellation, `resolveRecovery`, and repeated
`RecoveryConflict`.

### Security tests

Tests use hostile QMD and workspace layouts containing path traversal,
symlinks, case aliases, raw HTML, SVG, network URLs, command URIs, MIME
spoofing, oversized images, malicious formal-block attributes, forged/replayed
capabilities, Agent file/shell attempts against reserved roots, and untrusted
workspaces. Local and remote adapters must reject the same cases.

### Performance gate

On the project's documented CI reference runner, a 1 MiB QMD fixture with at
least 10,000 mixed blocks must keep the p95 synchronous input transaction plus
incremental decoration update at or below 16 ms. Image decoding, Quarto
rendering, indexing, and network/SSH latency are asynchronous and excluded.

The parser updates affected nodes and viewport decorations; a normal keypress
must not parse, render, stringify, or diff the complete document.

### Commands and installed smoke test

The implementation adds a reproducible Documentation suite, exposed as:

~~~bash
npm run test:documentation
~~~

The existing workbench gates remain mandatory:

~~~bash
npm run test:workbench-bootstrap
npm run workbench:verify
~~~

An installed Electron smoke test uses only temporary, generated, non-personal
local and remote workspaces. It opens the same QMD in both editor
presentations, edits every supported structure, reviews a concurrent Agent
Change Set, reconnects SSH, previews without execution, and exercises a
throwaway migration. No personal profile or QLab workspace is a fixture.

## Implementation Planning Scope

This is one product contract because authority, state, editor synchronization,
Agent review, and migration share invariants that cannot be designed
independently. It is too large for one implementation diff or one uninterrupted
execution checklist.

After written-spec approval, the implementation plan must therefore be a
master dependency map with five separately executable phase plans matching the
slices below. Each phase has its own red/green tests, small commits, review
checkpoint, and rollback boundary. Phase 3 further splits by visual structure.
Only one phase becomes the active implementation scope at a time, and no later
phase can weaken an earlier authority or recovery gate.

## Phased Delivery

### Phase 1: Documentation authority and planning

- Add the deep transaction model, `documentation/` path type, workflow-state
  schema, status commands, and local/remote conformance tests behind a product
  flag.
- Add a read-only legacy migration planner and reports, but do not execute a
  personal migration.
- Preserve standard Text Editor compatibility for QMD.

### Phase 2: TextDocument-backed editor

- Add `chatero.documentation.livePreview` as a plain-source CodeMirror custom
  text editor.
- Complete the bridge, split synchronization, dirty/save/revert/hot-exit,
  undo/redo, external-change, local, and SSH gates before adding rich widgets.
- Keep the standard Text Editor available throughout.

### Phase 3: Incremental Live Preview

- Deliver prose/headings and formulas first.
- Add tables and safe relative images.
- Add theorem, lemma, proof, and proof collapse.
- Ship each structure only with source-preservation, local-source-reveal,
  accessibility, and failure-fallback tests.
- Retain optional no-execute exact Quarto preview.

### Phase 4: Agent review workflow

- Add immutable multi-file Change Sets, review surfaces, stable hunks,
  settlement, concurrent-human reconciliation, state effects, retrieval
  policy, and Main Site filtering.
- Verify recovery, local/remote equivalence, and the no-direct-Agent-write
  boundary.

### Phase 5: Explicit migration and cutover

- Enable migration execution only after Phases 1–4 pass all automated and
  installed smoke gates.
- Migrate one explicitly selected workspace using a reviewed dry-run plan.
- Switch current routes and labels to Documentation only after receipt
  verification.
- Retain the Gecko implementation as a parity oracle until full workbench
  cutover criteria pass; remove it only under the broader atomic cutover plan.

No phase moves or rewrites personal data merely because a new Chatero build is
installed.

## Acceptance Criteria

The design is complete when implementation evidence proves all of the
following:

1. A new QLab workspace has `documentation/` and no current Draft/Knowledge
   document classes.
2. Every canonical page is QMD and can open in both the standard Text Editor
   and Live Preview.
3. Both presentations share one logical buffer, dirty state, save lifecycle,
   and Workbench undo history.
4. Prose, formulas, tables, relative images, theorem, lemma, and proof blocks
   are visual, locally source-editable, and source-preserving.
5. Proof folding works per view and does not mutate source when toggled.
6. Unsupported QMD remains editable in local source form and is never
   destructively normalized.
7. The Agent cannot mutate canonical pages or state before human settlement.
8. Multi-file proposals remain reviewable while humans edit, and overlap
   never causes silent overwrite.
9. Human edits preserve status; accepted Agent changes become `working`; only
   explicit human action makes a page `reviewed`.
10. Default retrieval and Main Site use only `reviewed` pages, while working
    pages remain explicitly accessible and labeled.
11. Migration preserves both sides of every collision, converts valid pending
    proposals, quarantines damaged ones, and is crash-recoverable.
12. The same editing, review, security, and recovery contracts pass locally
    and over SSH.
13. QLab or Documentation failure cannot prevent Zotero Core or standard
    Code-OSS editing from starting.

## Public References

The design uses public behavior and extension seams, not unpublished Obsidian
implementation:

- [Obsidian repositories do not include the application core](https://github.com/obsidianmd/obsidian-releases#about-this-repository)
- [Obsidian Help: views and editing modes](https://github.com/obsidianmd/obsidian-help/blob/master/en/Editing%20and%20formatting/Views%20and%20editing%20mode.md)
- [Obsidian Help: advanced formatting syntax](https://github.com/obsidianmd/obsidian-help/blob/master/en/Editing%20and%20formatting/Advanced%20formatting%20syntax.md)
- [Obsidian Help: embedded files](https://github.com/obsidianmd/obsidian-help/blob/master/en/Linking%20notes%20and%20files/Embed%20files.md)
- [Obsidian public API and CodeMirror editor-extension registration](https://github.com/obsidianmd/obsidian-api)
- [VS Code Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [VS Code custom editor contribution point](https://code.visualstudio.com/api/references/contribution-points#contributes.customEditors)
- [VS Code API reference](https://code.visualstudio.com/api/references/vscode-api)
- [Pinned Code-OSS extension-host bulk edits capture text document versions](https://github.com/microsoft/vscode/blob/df53daabb18cd157bdb08c7f01c34df936cf12f4/src/vs/workbench/api/common/extHostBulkEdits.ts)
- [Pinned Code-OSS WorkspaceEdit conversion emits version-bound text edits](https://github.com/microsoft/vscode/blob/df53daabb18cd157bdb08c7f01c34df936cf12f4/src/vs/workbench/api/common/extHostTypeConverters.ts)
- [CodeMirror 6 reference](https://codemirror.net/docs/ref/)
