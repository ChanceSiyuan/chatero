# Cursor-Style QMD Research Workspace Design

**Date:** 2026-08-08  
**Status:** Approved for implementation  
**Product:** Chatero  
**Scope:** Native `qlabqmd` tab only

## Summary

Replace the current lightweight QMD textarea and card editor with a mature
research-writing workspace built around Zotero's bundled Monaco Editor. The
workspace has a QLab Explorer on the left, a QMD source editor in the center,
and a live Quarto Preview on the right. The editor and Preview are resizable,
keyboard-first, and share one explicit draft session. AI edits remain isolated
in a working copy and are reviewed in a Monaco diff before Keep promotes them
to the Draft.

This is deliberately narrower than reproducing all of Cursor. Chatero keeps
Zotero's Library and Reader as native application surfaces and adds the pieces
that matter for reading papers, writing mathematical notes, and reviewing AI
changes. It does not add a terminal, Git view, VS Code extension compatibility,
or a general-purpose IDE shell.

## Goals

1. Make sustained QMD writing feel as reliable and responsive as editing a file
   in Cursor or VS Code.
2. Show the real Quarto result beside the source without making the user switch
   modes or manually reload the page.
3. Preserve Quarto source as the writing authority, including frontmatter,
   mathematics, citations, fenced code, and `thm`, `lem`, `def`, and `proof`
   Div blocks.
4. Keep human and AI authority visually and technically distinct:
   human edits save to the Draft; AI edits remain in one latest working copy
   until Keep.
5. Remain a disableable Chatero module. QLab failures must not interfere with
   Zotero Library, Reader, sync, or citation features.

## Non-goals

- Direct manipulation of rendered HTML as the primary editing model.
- A full Cursor clone, terminal, source-control view, or VS Code marketplace.
- Editing trusted `knowledge/` pages from this workspace.
- Letting AI write outside `drafts/` or promote content directly to
  `knowledge/`.
- Executing code cells while producing a Draft preview. Quarto always runs with
  `--no-execute`.

## User Experience

### Normal editing

The native QMD tab contains four persistent regions:

1. A compact workspace toolbar with the Draft breadcrumb and icon-only actions.
2. A collapsible QLab Explorer.
3. A Monaco source editor.
4. A Quarto Preview separated from the editor by a draggable divider.

The editor and Preview appear together by default. Either pane can be hidden or
maximized without losing the Monaco model, undo stack, selection, scroll
position, or Preview session. Divider position and Explorer visibility are
restored with the native tab session.

The toolbar uses icons with localized accessible labels and hover tooltips.
The status bar reports the current file, line and column, save state, Quarto
state, and pinned PDF context. Routine status is quiet; errors do not consume a
large persistent area above the document.

### Explorer

The Explorer shows three roots:

- `drafts/`: editable and expanded by default.
- `knowledge/`: read-only and available for navigation or AI context.
- `literature/`: read-only and available for navigation or AI context.

Only `.qmd` entries under `drafts/` can be opened as editable Monaco models.
Knowledge pages and literature records may be opened in their existing read
surfaces or attached to Chat context, but the QMD workspace does not expose a
writable model for them.

Each Draft row can show:

- an unsaved marker for a live human buffer;
- a green dot for a persisted AI working copy awaiting review;
- a compact error marker when Quarto or compliance validation reports a problem.

A bounded workspace watcher refreshes the tree when files are added, removed,
renamed, or changed by Cursor or another process. It never follows symlinks out
of the selected QLab root. When Chatero is not focused, the watcher reduces its
polling frequency.

### Monaco editing

Chatero reuses the Monaco Editor already bundled with Zotero 0.47 rather than
shipping another editor. A dedicated QLab Monaco host is used instead of
changing Scaffold's JavaScript-oriented Monaco page.

The QMD language integration provides:

- Markdown editing, line numbers, find/replace, undo/redo, multi-cursor,
  selection, folding, word wrap, bracket matching, and familiar macOS shortcuts;
- recognition and decoration of YAML frontmatter, display and inline LaTeX,
  fenced code blocks, citations, Quarto fenced Divs, and theorem-family blocks;
- completion snippets for `thm`, `lem`, `def`, and `proof` blocks;
- citation completion after `@`, sourced from `literature/ref.bib`;
- diagnostics from the current Draft contract and Quarto compilation;
- `⌘K` to send the current selection and nearby QMD context to the existing AI
  writing flow.

The first implementation is QMD-specific. It does not attempt to host arbitrary
programming-language projects or VS Code extensions.

### Saving

Human edits use delayed automatic saving by default:

- Monaco changes immediately mark the Draft session dirty.
- After 800 ms without a new edit, Chatero saves the buffer using the current
  file revision as a compare-and-swap guard.
- `⌘S` saves immediately and resets the delay.
- A failed save leaves the buffer dirty and fully recoverable in memory.

If the file changes on disk while the buffer is clean, Chatero reloads it and
preserves the visible selection as closely as possible. If both the Monaco
buffer and disk changed, Chatero opens a compare view. It does not silently
overwrite either version and does not show the previous opaque red
"original draft changed" message.

### Live Quarto Preview

Each open Draft owns at most one Quarto Preview session. Chatero starts Quarto
from the correct project directory with `--no-execute`, a loopback-only host,
and a stable per-Draft port. Delayed auto-save makes the on-disk QMD update,
which triggers Quarto's normal live rebuild.

While a build runs, the Preview keeps the last successful HTML visible and
shows a small `Rendering…` state. A successful build swaps in the new document
without flashing a blank iframe. A failed build keeps the last successful page
and publishes diagnostics to Monaco and the Preview toolbar.

If Quarto is missing or cannot start, the Preview uses Chatero's existing
source-driven HTML renderer. The fallback is explicitly labelled and offers a
single setup action. It must continue to render mathematics and theorem-family
blocks, but it is not described as equivalent to a full Quarto build.

Source and Preview use a block map derived from the QMD parser. Headings, named
Divs, theorem-family blocks, equations, and paragraphs receive stable keys.
Scrolling either pane follows the nearest stable block without fighting active
user scrolling. Clicking a mapped Preview block reveals the corresponding
source range in Monaco; Preview itself remains read-only.

### AI proposal review

AI access remains sandboxed to a single working copy under
`work/qlab-zotero/draft-changes/`. The original Draft is not modified by an
Agent run. Repeated Agent edits replace the previous proposal, so Chatero
persists only the latest AI version together with its base revision.

When a proposal exists:

1. The Draft row receives a persistent green dot.
2. Opening the Draft enters Monaco Diff Editor mode.
3. The original side is read-only; the proposed side is editable.
4. Preview defaults to Proposed and can switch between Original and Proposed.
5. Previous/next controls navigate changed regions.
6. Keep promotes the reviewed proposed text to the original Draft.
7. Reject deletes the working copy and returns to normal editing.

If the original Draft changes after the Agent captured its base, Chatero
computes the base-to-proposal patch and replays non-overlapping hunks onto the
latest original. Overlapping hunks open an explicit merge comparison. Both the
latest human Draft and the AI proposal remain available until the user resolves
or rejects the proposal. A stale proposal never disables Keep without showing a
recoverable comparison path.

AI proposal state is disk-backed, not DOM-backed, so green-dot status and Diff
review survive tab closure and application restart.

## Architecture

### `QmdDraftSession`

`QmdDraftSession` is the authoritative state owner for one open Draft. It owns:

- workspace-relative Draft path;
- Monaco model URI and buffer text;
- last saved revision and text;
- dirty, saving, and save-error state;
- selection and scroll restoration data;
- active Preview status and mapping revision;
- AI base revision, working-copy path, and review mode;
- persisted layout preferences for the native tab.

The session exposes events rather than allowing UI code to store competing
copies of the buffer in DOM properties. Existing callers go through a narrow
adapter during migration.

### `QmdMonacoBridge`

The bridge creates and disposes Monaco models, translates model-change and
cursor events into Draft-session actions, applies diagnostics and decorations,
and hosts normal, diff, and conflict views. The dedicated Monaco iframe exposes
a small asynchronous API to the parent chrome window; QLab business logic does
not reach into Monaco internals scattered across `qlabModule.js`.

### `QmdExplorer`

The Explorer owns tree snapshots and sandboxed file discovery. It emits file
selection and external-change events, but it does not read or write editor
buffers. Its watcher uses normalized canonical paths and the existing QLab
workspace boundary checks.

### `QmdPreviewController`

The controller owns Quarto process lifecycle, readiness probing, build status,
last-good URL state, restart backoff, and source-to-preview mapping. Closing a
Draft tab releases its Preview process. Reopening the same Draft may reuse a
healthy session, but duplicate processes for the same workspace path are not
allowed.

### `QmdProposalReview`

The review service reads the original, base snapshot, and latest working copy;
computes the diff; attempts a non-overlapping rebase; and returns a normal diff
or a conflict model to the Monaco bridge. Keep remains the only method that may
promote an AI proposal into `drafts/`.

### `QmdWorkspaceShell`

The shell composes Explorer, editor host, Preview host, toolbar, splitter, and
status bar. It contains presentation and event wiring only. Existing native
tab-group behavior continues to arrange QMD, PDF, and Chat tabs without
reparenting Reader content.

## State Flow

```text
Explorer selection
        │
        ▼
QmdDraftSession ───────► QmdMonacoBridge
        │                       │
        │ 800 ms autosave       │ selection / diagnostics
        ▼                       │
QmdDraftIO (CAS write)          │
        │                       │
        ├──────────────► QmdPreviewController ──► Quarto iframe
        │
        └──────────────► external-change watcher

AgentRuntime ──► latest working copy ──► QmdProposalReview
                                              │
                          Monaco Diff ◄────────┼────────► Proposed Preview
                                              │
                                         Keep / Reject
```

## Trust and Data Boundaries

- Editable paths must resolve canonically beneath `<qlab-root>/drafts/`.
- Read-only Explorer paths must resolve beneath `knowledge/` or `literature/`.
- Preview processes bind only to `127.0.0.1` and execute no document code.
- Iframes do not receive unrestricted filesystem access.
- AI writes remain under `work/qlab-zotero/draft-changes/` until Keep.
- No action in this feature writes to `knowledge/`.
- Existing user Drafts, Knowledge, Literature, Zotero profiles, and Zotero data
  directories are never replaced during application initialization or upgrade.

## Error Handling

- **Save failure:** retain the Monaco buffer and dirty state; expose Retry and
  Compare without dismissing the editor.
- **External conflict:** preserve disk and memory versions; open compare mode.
- **Quarto unavailable:** use labelled fallback Preview and keep editing active.
- **Quarto compilation error:** retain last-good HTML; map diagnostics when a
  source location is available.
- **Preview crash:** restart with bounded exponential backoff; stop after three
  consecutive failures until the user retries.
- **AI proposal conflict:** preserve original, base, and proposal; open merge
  comparison instead of disabling Keep without recovery.
- **QLab module failure:** log the failure and disable only QLab surfaces.

## Accessibility, Theme, and Copy

- Controls use Zotero theme variables and support light and dark appearance.
- Icon-only controls have Fluent-localized `aria-label` and tooltip text.
- Keyboard focus order follows Explorer → editor → Preview → status actions.
- Splitters are keyboard-adjustable and expose separator semantics.
- Status uses text and icons, never color alone.
- All new user-visible strings are English and live in Fluent resources.

## Testing Strategy

### Pure Node tests

- Draft-session state transitions and disposal.
- 800 ms save scheduling, immediate save, retry, and compare-and-swap failures.
- External-change decisions for clean and dirty buffers.
- Explorer filtering, canonical path containment, and tree diffing.
- AI base/proposal rebase for disjoint and overlapping hunks.
- Preview session deduplication, readiness, backoff, and teardown.
- QMD completion and block-map behavior for frontmatter, math, citations,
  `thm`, `lem`, `def`, and `proof`.

### UI contract tests

- QMD shell contains Explorer, Monaco iframe, Preview iframe, accessible
  splitter, compact actions, and status bar.
- Normal, dirty, saving, Preview-error, proposal, and conflict states expose the
  correct controls and labels.
- Explorer and pane visibility state round-trip through native tab sessions.
- Monaco messages cannot request writes outside the current Draft session.

### Integration and manual acceptance

- Run the complete Chatero test gate and the accepted upstream Zotero suite.
- Build and verify the ad-hoc-signed personal macOS DMG.
- In the installed application, edit and preview a Draft containing YAML,
  equations, citations, fenced code, and all four theorem-family blocks.
- Create and rename Drafts externally and verify Explorer refresh.
- Generate an AI proposal, review Original and Proposed Preview, Keep, Reject,
  restart Chatero, and verify persisted pending state.
- Modify the original while an Agent runs and verify non-overlapping rebase plus
  recoverable overlap handling.
- Arrange PDF, Chat, and QMD native tabs and verify the PDF Reader does not reload.

## Acceptance Criteria

1. The old raw textarea is no longer the primary QMD source editor.
2. Explorer, Monaco, and live Quarto Preview match the approved three-column
   layout and support a draggable divider.
3. Monaco retains buffer, undo, cursor, and scroll state across pane changes.
4. Human edits auto-save after 800 ms with revision protection; `⌘S` is immediate.
5. Full Quarto Preview updates automatically and keeps the last successful page
   visible during rebuild or failure.
6. QMD diagnostics and completions cover the repository's frontmatter contract,
   math, citations, and theorem-family blocks.
7. AI proposals are isolated, persistent, reviewable in Monaco Diff, previewable
   as Original or Proposed, and promoted only by Keep.
8. External changes and AI/human overlap preserve every version and present a
   recoverable compare or merge flow.
9. Only Draft files are writable from this workspace.
10. Chatero's automated gates pass and a verified personal-development DMG is
    produced without including personal QLab content.

