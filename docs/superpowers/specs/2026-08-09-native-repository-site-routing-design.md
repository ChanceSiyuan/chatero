# Native Repository, Main Site, and Document Routing Design

**Date:** 2026-08-09

**Status:** Approved for implementation planning

**Product:** Chatero

**Scope:** Research Loop repository initialization, local Main Site lifecycle,
and clickable `drafts/`, `knowledge/`, and `literature/` documents

## Summary

Complete the first XPI-to-Chatero migration stage by implementing repository
initialization, a functional native Main Site tab, and one authority-aware
document router for the QLab Explorer and site links.

The XPI is a behavioral and security reference, not a UI or architectural
template. Chatero will retain the proven repository-state model, starter
integrity checks, Git-private repository identity, loopback-only site, and
non-overwrite guarantees. It will replace the XPI's injected controls, shell
archive extraction, and nested Workbench browser with native Chatero services,
tabs, background progress, Reader reuse, and consistent document routing.

This is phase 1 of six ordered migration projects:

1. repository initialization, Main Site, and document opening;
2. Zotero Literature synchronization and `literature/ref.bib` refresh;
3. remote SSH, Linux helpers, and Terminal;
4. history browsing, multi-paper conversations, and Library Search;
5. PDF screenshots, Note/QMD exchange, and reviewed annotations;
6. Knowledge topic tree and graph.

Later phases must not begin until this phase passes its automated and native
application acceptance gates.

## Product Principle

Every migration phase follows the same rule:

- migrate observable behavior, data formats, security invariants, and useful
  tests from the XPI;
- redesign presentation and lifecycle around Chatero's freedom as a complete
  Zotero fork;
- do not copy an XPI panel merely to preserve visual parity;
- do not weaken the existing `drafts/` editable, `knowledge/` trusted, and
  `literature/` evidence boundaries;
- never overwrite irreplaceable personal content.

## Goals

1. Initialize an empty or content-only folder as a complete, usable Research
   Loop repository without overwriting any existing file.
2. Present initialization as a clear native setup flow with an exact plan,
   progress, resumability, and actionable errors.
3. Make Main Site a functional native Chatero tab that can build, start, reuse,
   display, refresh, stop, and diagnose a repository-local site.
4. Make every supported Explorer file clickable and route it according to its
   authority and format.
5. Let Site, QMD, and PDF tabs participate in Chatero's existing native split,
   drag, close, and session-restoration behavior.
6. Keep repository, process, view, and routing responsibilities isolated behind
   small interfaces that later migration phases can reuse.

## Non-goals

- Publishing a site to the public internet.
- Executing QMD code while building a preview.
- Editing `knowledge/` or `literature/` directly through Visual Edit or Monaco.
- Importing Zotero records into `literature/`; that is phase 2.
- Remote site build or remote initialization; those remain local-only.
- Restoring the XPI's internal Workbench, bottom-left site button, or nested
  Chat/site split.
- Implementing the Knowledge graph; that is phase 6.
- Copying personal Knowledge, Draft, Literature, Git history, credentials, or a
  remote hosting project identity into the starter.

## Considered Architectures

### 1. Copy the XPI service and UI wholesale — rejected

This is the shortest port, but it preserves plugin assumptions: a monolithic
site class, injected buttons, shell-string process control, a nested browser,
and stale Workbench entry points. It would also duplicate Chatero's native tab
and layout machinery.

### 2. Port behavior into native Chatero services — selected

Pure repository inspection, initialization planning, process supervision, site
presentation, and document routing become separate modules. Chatero's existing
tabs, Reader, split layout, QMD surfaces, session state, and background process
runner present those services. This retains the XPI's safety behavior while
making the workflow feel native and removes the entry-point regressions found
in the XPI.

### 3. Run a separate local web application — rejected

A standalone web application would isolate frontend work but would recreate the
boundary Chatero is meant to remove. It would require another authentication,
window, navigation, and filesystem bridge and could not reuse the native Reader
or document tabs directly.

## Architecture

The implementation has four primary units and one private identity helper:

```text
WorkspaceInspector / StarterPlanner
                 │
                 ▼
RepositoryInitializer ───────► RepositoryIdentity
                 │
                 ▼
          MainSiteService ───────► MainSiteView (`qlabsite` tab)
                                            │
Explorer / Site / Deep Link ─────► WorkspaceDocumentRouter
                                            │
                       Draft QMD | Read-only QMD/Bib | Native Reader
```

### Workspace inspection and planning

`qlabWorkspace.js` remains the authority for canonicalization, safe relative
paths, agent-writable roots, and top-level repository classification. It gains
pure validation that distinguishes files from directories and identifies
unsafe symbolic links.

A manifest planner consumes a canonical root and a bundled, versioned starter
manifest and returns an immutable plan:

```js
{
  repositoryState: 'empty' | 'partial',
  create: [{ path, kind, digest, mode }],
  preserve: [{ path, kind }],
  conflicts: [{ path, reason }],
  gitAction: 'initialize' | 'preserve',
  starterVersion,
  planDigest,
}
```

The setup UI renders this exact snapshot as **Will add**, **Will preserve**, and
**Needs attention**. Execution re-inspects the target immediately before the
first write. A changed target invalidates the plan and returns to review.

### Repository initialization

Chatero owns a public, versioned Research Loop starter beneath its product
resources. The starter contains the application skeleton only, including:

- `AGENTS.md` and the Research Loop trust contract;
- an executable `qlab` launcher;
- project configuration, package metadata, build scripts, and required skills;
- empty `knowledge/` and `literature/` structure, including a valid empty
  `literature/ref.bib` when absent;
- `drafts/example.qmd`, demonstrating valid frontmatter, theorem, lemma,
  definition, proof, display math, and citation syntax;
- ignore rules for generated state, previews, AI working copies, local
  literature assets, and private identities.

It contains no personal notes, bibliography records, PDFs, generated site,
`node_modules`, Git history, credentials, or fixed hosting identifier.

Unlike the XPI's `unzip -n` shell command, Chatero uses a manifest-driven
initializer:

1. canonicalize and inspect the selected root;
2. verify the starter manifest and every bundled file digest before any write;
3. create `.research-loop/starter.json` as a private setup receipt;
4. create directories and files with create-if-absent semantics;
5. set executable permission only on a `qlab` file created by this run;
6. initialize Git only when `.git` does not exist;
7. verify the complete repository shape and starter schema;
8. create the Git-private repository UUID;
9. atomically mark the receipt `ready`.

If execution fails, the receipt records the last completed operation and the
error category. A later attempt produces a fresh plan and resumes by adding
only still-missing entries. It never deletes created files during rollback,
because a file could have become user-owned after creation.

### Repository identity

The stable UUID lives at the Git-private path `qlab/repository-id`. Creation
uses exclusive, no-follow, owner-only semantics and mode `0600`. Parent private
directories use mode `0700`. Existing valid identities are preserved. Invalid,
oversized, linked, or out-of-root identity paths fail closed.

Identity creation occurs only after repository structure and Git initialization
succeed. Later target switching and remote phases use this identity rather than
the display path.

### Main Site service

`MainSiteService` owns one state machine per canonical repository identity:

```text
idle → checking → installing → building → starting → ready
  │        │            │          │          │        │
  └────────┴────────────┴──────────┴──────────┴──────► error
ready → stale → building
ready → stopping → idle
```

`initializing` is represented by the repository setup controller, not hidden in
the site process.

The service:

- probes the preferred URL `http://127.0.0.1:4180/` before starting anything;
- reuses that server only when its health payload identifies the selected
  repository;
- prefers port 4180 for compatibility, but may allocate a free port from a
  bounded loopback range when 4180 belongs to an unrelated process;
- binds only to `127.0.0.1`;
- invokes fixed executables with argument arrays and an absolute canonical
  `cwd`, never a concatenated shell command;
- checks Node/npm and Quarto before dependency installation;
- runs dependency installation only after the explicit **Build & Start** action;
- runs the repository's supported build with QMD execution disabled;
- streams normalized progress and a bounded diagnostic tail;
- merges concurrent Start requests and never launches duplicate servers;
- retains the last-good site while a rebuild runs or fails;
- records whether a process is Chatero-owned or externally discovered;
- stops only Chatero-owned processes during application shutdown;
- never blocks Zotero Library, Reader, Chat, or QMD startup when site work
  fails.

Opening the Site tab performs a health check but does not install dependencies,
build, or start a process without a user action.

### Main Site view

`qlabsite` remains a singleton native Chatero document tab. It can be closed,
dragged, restored, and placed in any existing content group. It does not live
inside Chat.

Depending on repository state, the tab presents:

| State | Primary presentation and action |
|---|---|
| `missing` | Choose Workspace |
| `empty` | Create a Research Loop Workspace → review plan → Initialize |
| `partial` | Complete Setup → review missing items → Initialize |
| `incompatible` | Explain conflicting top-level items; Choose Another Folder or Reveal in Finder |
| `ready`, site stopped | Build & Start |
| `ready`, site running | Embedded Main Site |
| site error | Last-good page if available, bounded diagnostics, Retry |

Initialization progress uses named steps: Verify Folder, Verify Starter, Add
Missing Files, Initialize Git if Absent, Verify Repository, and Ready. The view
may be hidden while work continues; returning to it shows current progress.
Restarting Chatero after an interrupted setup presents **Resume Setup** and a
new review plan. It never resumes writes automatically.

The running-site toolbar provides Back, Forward, Home, Reload, a status pill,
Open Source Beside Site, and a collapsible Build Log. It does not display a
free-form URL field that can turn the tab into a general browser.

Navigation policy is strict:

- the current loopback site origin stays in the embedded browser;
- `chatero://` and supported `zotero://` links route to native handlers;
- external HTTP(S) links open in the user's external browser;
- filesystem and unknown protocols are refused.

### Authority-aware document routing

One router handles Explorer clicks, Quick Open, Main Site source requests, and
future deep links:

```js
openWorkspaceDocument({
  root,
  relativePath,
  source: 'explorer' | 'quick-open' | 'site' | 'deep-link',
  placement: 'current' | 'beside',
})
```

It canonicalizes the path, validates it against the selected repository, reads
the Explorer kind and authority, and returns a concrete native action. The
rules are:

| Document | Default action | Authority |
|---|---|---|
| `drafts/**/*.qmd` | Existing Visual/Website/Monaco workspace | Editable Draft |
| `knowledge/**/*.qmd` | Open compiled site page when available; source action opens the same QMD workspace read-only | Trusted Knowledge |
| `literature/**/*.{qmd,md}` | Read-only Visual/Website/Monaco workspace | External Evidence |
| `literature/**/*.bib` | Read-only Monaco/BibTeX surface with citekey search | External Evidence |
| `literature/**/*.pdf` matched to Zotero | Reuse or open native Reader tab | External Evidence |
| unmatched Literature PDF | Offer Link to Zotero and Open; do not silently create a Zotero item | External Evidence |

The existing Draft-only `openDraft()` remains Draft-only. A new read-only
document session reuses QMD rendering and Monaco bridges but does not expose
autosave, AI proposal mutation, TODO completion, Add to Knowledge, formal-block
insertion, or external-editor write actions. A prominent authority badge and
tooltip explain why the document is read-only.

**Open Source Beside Site** maps only `/knowledge/` HTML routes from the current
site origin to safe `knowledge/**/*.qmd` paths. It keeps the Site tab in place
and opens the read-only source in an adjacent Chatero content group. Directory
indexes map to `index.qmd`; traversal, query-based path injection, and missing
sources are rejected with an inline message.

## Native UI Improvements Over the XPI

1. Setup is a native, reviewable task rather than a long-running button with no
   intermediate state.
2. The plan explicitly distinguishes personal content being preserved from
   infrastructure being added.
3. Main Site is a peer of PDF and QMD tabs and participates in native Chatero
   splits instead of occupying Chat's pane.
4. Build progress and errors stay attached to the Site tab, while background
   work does not block reading or writing.
5. Site source opens beside the rendered page, producing a direct
   `Knowledge Site | Trusted Source` comparison.
6. Explorer icons and labels expose file role and authority: Draft, Trusted,
   Evidence, BibTeX, and PDF.
7. Every entry point shares one router, preventing the XPI's split behavior
   between buttons, site links, and tree rows.
8. Chatero reuses its native Reader instead of opening PDFs in Preview.app or a
   generic browser.

## Safety Invariants

- An existing file, directory, symbolic link, or permission is never replaced
  or altered by initialization.
- Existing `knowledge/`, `drafts/`, and `literature/` bytes remain unchanged.
- `incompatible` roots never expose a force-initialize action.
- The selected root is canonical and unchanged between plan confirmation and
  execution.
- Starter paths reject absolute paths, empty segments, `.`, `..`, option-like
  segments, NUL bytes, symlink traversal, and case-folded duplicate targets.
- All starter bytes and the manifest pass bundled digest verification before
  any target write.
- `knowledge/` never becomes an ordinary Agent-writable root.
- Knowledge and Literature read-only sessions cannot reach Draft mutation APIs.
- Site processes bind only to loopback and embedded navigation is origin
  constrained.
- No command is formed by interpolating a repository path into a shell string.
- Site and setup failures never prevent Zotero core startup.

## Error Handling and Recovery

- Folder classification errors identify the exact conflicting top-level path
  without exposing a destructive override.
- A stale setup plan stops before writing and returns the user to the review
  screen.
- A starter integrity failure produces zero target writes.
- An interrupted initialization leaves a private receipt and resumes only after
  another explicit confirmation.
- Missing Node/npm/Quarto produces an actionable dependency card and leaves the
  repository unchanged.
- Build and process failures retain a bounded log and the last-good site.
- A server found on port 4180 but associated with another root is never reused.
- A missing source mapping leaves the current Site page visible.
- An unmatched Literature PDF is never imported or linked without review.

## Persistence and Lifecycle

- The selected canonical root and repository identity continue to use existing
  Chatero preferences and target epochs.
- Site runtime state is keyed by repository identity, not a mutable display
  path.
- Restored `qlabsite` tabs re-run health checks and restore their last safe
  in-site URL; they do not implicitly start processes.
- Site browser, setup view, and document sessions detach listeners on tab or
  window disposal.
- Chatero shutdown asks its service to stop owned site processes within a
  bounded timeout. Externally discovered processes remain untouched.
- Explorer polling continues to refresh after initialization and external file
  changes without remounting the QMD workspace.

## Planned Modules

Existing modules retain narrow responsibilities:

- `qlabWorkspace.js`: inspection, canonicalization, and path policy.
- `qmdExplorer.js`: safe snapshots plus file kind and authority metadata.
- `qmdWorkspaceShell.js`: editable Draft and read-only QMD/Bib presentations.
- `qlabModule.js`: lifecycle wiring and tab mounting only.
- `phase4.js`: compatibility delegation rather than implementation.

New modules:

- `qlabStarterManifest.js`: parse, validate, and plan bundled starter entries.
- `qlabRepositoryInitializer.js`: execute and resume non-overwriting setup.
- `qlabRepositoryIdentity.js`: create and validate Git-private identities.
- `qlabWorkspaceSetupView.js`: native setup plan, progress, and recovery UI.
- `mainSiteService.js`: health, dependency, build, process, and lifecycle state.
- `mainSiteView.js`: native `qlabsite` presentation and navigation policy.
- `workspaceDocumentRouter.js`: authority-aware Explorer/site/deep-link routing.

The exact filenames may be adjusted during the implementation plan only to
match an existing Chatero naming convention; the responsibility boundaries and
interfaces in this specification remain binding.

## Test Strategy

Implementation follows strict red-green-refactor cycles. Tests exercise real
pure logic and injected filesystem/process adapters rather than asserting only
mock call counts.

### Repository tests

- classify missing, empty, content-only partial, interrupted partial, ready,
  and incompatible roots;
- reject wrong file/directory types, symbolic links, traversal, case-folded
  collisions, and changed roots;
- verify manifest and all asset digests before writes;
- prove empty initialization produces the complete required shape;
- prove content-only initialization preserves every pre-existing byte and mode;
- prove a second run is idempotent;
- prove interrupted setup produces a resumable plan;
- prove Git and identity creation never replace existing values.

### Site service tests

- recognize a healthy server for the selected repository;
- reject an unrelated process on port 4180 and select a bounded fallback;
- merge concurrent Start requests;
- expose dependency, install, build, early-exit, timeout, cancellation, and
  diagnostic states;
- keep last-good content during rebuild failure;
- stop owned processes and preserve external processes;
- refuse non-loopback origins and shell-interpolated execution.

### View and routing tests

- render every repository/setup/site state with the correct primary action;
- restore a `qlabsite` tab without starting a server;
- preserve tab and split state while Site, PDF, and QMD move between groups;
- route every supported Explorer type;
- keep Drafts writable and Knowledge/Literature read-only;
- hide all mutation controls in read-only sessions;
- reuse matched Zotero PDF Readers and review unmatched PDFs;
- map safe Knowledge URLs to QMD and reject traversal or foreign origins;
- continue normal Zotero startup when QLab setup or site mounting fails.

### Native application acceptance

A built Chatero application must be tested on macOS with temporary fixtures,
never the user's personal repository:

1. initialize an empty folder;
2. initialize a copy containing pre-seeded personal content and compare hashes;
3. refuse an unrelated non-empty folder;
4. interrupt and resume setup;
5. build and display Main Site;
6. close, drag, split, restore, and reopen the Site tab;
7. open Draft, Knowledge QMD, Literature QMD/Bib, matched PDF, and unmatched PDF;
8. open a Knowledge source beside its site page;
9. switch repositories and confirm no stale cwd, server, or Explorer state;
10. quit and confirm only Chatero-owned site processes stop.

## Acceptance Criteria

The phase is complete only when:

- every automated test above passes;
- a fresh Chatero build passes the macOS acceptance run;
- no test or manual fixture touches personal `knowledge/`, `drafts/`, or
  `literature/` data;
- an empty or content-only directory becomes a ready repository through a
  visible, resumable, non-overwriting setup flow;
- a ready local repository can build and display Main Site in a native tab;
- every supported Explorer document opens through the authority-aware router;
- Knowledge and Literature cannot be mutated through the QMD workspace;
- Site, QMD, and native PDF Reader tabs retain Chatero split, drag, close, and
  restoration behavior;
- failures are visible and actionable without blocking Zotero core features.
