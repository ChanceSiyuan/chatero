# XPI-Parity Three-Surface QMD Workspace Design

Date: 2026-08-08

## Product Principle

Chatero is the former Research Loop Zotero XPI internalized into a maintained
Zotero fork. Internalization removes extension-shell constraints and permits
better native interaction; it does not permit a smaller feature set. The XPI
is therefore the minimum functional baseline for Draft review, Visual Edit,
AI proposal review, and toolbar actions. Chatero may reorganize or deepen
those features, but it must not silently drop them.

## Problem

The QMD workspace can show an empty white Preview surface even while the
status bar says `Saved`. The running application confirms that Quarto itself
is healthy: the active Draft is served on loopback and returns HTTP 200.

Three implementation defects combine to hide that result:

1. `startQmdQuartoPreview` returned the server root (`/`) instead of the HTML
   path corresponding to the selected QMD.
2. The Chatero shell embedded the loopback page in an HTML `iframe`, while the
   working XPI used a native remote XUL `<browser type="content">`.
3. Preview startup had no visible intermediate content and a later `Saved`
   message could overwrite `Rendering…`.

The current process already invokes `quarto preview` for one selected QMD with
`--no-execute`; it does not intentionally render the whole Draft tree. The
remaining performance cost is Quarto startup and the first exact render.

A separate regression was introduced when the native workspace was simplified
to a binary Source/Preview shell. The earlier XPI's source-driven Visual Edit
and several Draft toolbar actions no longer participate in the active shell,
even though partial three-mode code still exists in `qmdSurface.js`. The eye
button must therefore control three first-class surfaces rather than toggle
one source pane against one preview pane.

## Goals

- Preserve every user-facing Draft capability present in the former XPI.
- Give every new Draft tab three first-class surfaces: Visual Edit, Website
  Preview, and Monaco Source.
- Cycle the eye button in this exact order: Visual Edit -> Website Preview ->
  Monaco Source -> Visual Edit.
- Default a newly opened Draft tab to Visual Edit and restore the last surface
  for a restored tab.
- Show useful content immediately after entering Website Preview, then replace
  it with the authoritative Quarto result when ready.
- Render only the active QMD, with code execution disabled.
- Use the correct HTML route for root, nested, and `index.qmd` Drafts.
- Never replace a visible last-good preview with an empty surface.
- Distinguish disk persistence from quick/exact preview progress and failure.
- Preserve autosave, formula-only editing, theorem/callout editing, canonical
  formal-block insertion, AI proposal comparison, Keep/Reject, Explorer
  behavior, and all Zotero features.
- Never copy, modify, package, or commit personal Knowledge, Drafts,
  Literature, chat history, credentials, or Zotero profile data.

## Non-goals

- Reimplementing all of Pandoc or Quarto in JavaScript.
- Executing QMD code cells in Preview.
- Publishing Drafts or changing the Knowledge publication contract.
- Keeping one permanent Quarto process for every QMD file.
- Showing two QMD surfaces simultaneously inside one QMD tab. Zotero's tab
  split system remains responsible for showing PDF, Chat, and QMD tabs side by
  side.

## Chosen Architecture

### 1. One shared document session, three resident surfaces

The Draft session is the only human-edit authority. It owns the in-memory QMD
buffer, optimistic revision, autosave, disk-conflict handling, and AI proposal
attachment. Three long-lived views consume that session:

- `visual`: source-driven Visual Edit and the default for a new Draft tab;
- `website`: quick safe rendering followed by exact Quarto output;
- `source`: Monaco editing of the same QMD buffer.

Only one view is visible at a time, but all three remain mounted. Switching
views must not recreate Monaco, discard the Visual Editor, create a second
Draft session, or restart the active Quarto process. Before leaving an active
Visual Edit field, Chatero flushes its buffered edit through the Draft session.
A persistence conflict keeps the edit recoverable and visible.

The serialized tab field is `qmdWorkspace.surface` with values `visual`,
`website`, or `source`. Migration is lossless: old `preview` becomes
`website`, old `source` remains `source`, and an absent or invalid value becomes
`visual`.

Surface mode and content version are orthogonal axes. The old XPI's eye-shaped
compare control selected Original Draft versus AI private copy; it was not the
Visual/Website toggle. Chatero may use an eye for the requested three-surface
cycle, but Original/Proposed selection must remain a separate control and must
continue to work in every applicable surface.

The eye button is one compact mode control. Its tooltip and accessible label
identify the current surface and the next surface. Each activation advances
`visual -> website -> source -> visual`.

### 2. Visual Edit

Visual Edit is ported from the former XPI rather than rebuilt from compiled
HTML. Every visible block carries an exact source range from
`visualQmdBlocks`; saving uses `applyQmdVisualBlock` plus the Draft session's
revision guard.

- Text, headings, lists, metadata, and raw/code regions open as QMD source for
  that block.
- Theorem, lemma, definition, proof, and callout Divs resemble their rendered
  cards. Clicking card text turns the complete card into fenced QMD source.
- Math remains rendered inside cards and ordinary prose. Clicking one formula
  replaces only that formula with an inline LaTeX input or display textarea;
  the rest of the card stays rendered.
- Input autosaves after a short idle delay. Blur flushes the edit and returns
  it to rendered form. A document-generation guard prevents a late save from
  an older Draft from overwriting or reporting against a newly selected Draft.
- The Visual Edit toolbar offers canonical Definition, Lemma, Theorem, and
  Proof insertion with unique anchors and valid Research Loop QMD syntax.

Compiled HTML is never edited and is never treated as the source of truth.

### 3. Immediate source-driven Website preview

When Website Preview becomes visible, Chatero renders the current in-memory
QMD buffer with the safe `renderQmdDocumentHTML` path. It provides headings,
paragraphs, lists, links, math, and theorem/callout cards without spawning a
new process. It is labelled `Quick Preview` while Quarto is pending.

This renderer is a responsiveness layer, not the authority for final visual
parity. Unsupported constructs remain readable rather than executing or
silently disappearing.

### 4. Exact single-file Quarto preview

In the background, Chatero starts or refreshes Quarto for only the selected
QMD. The process remains `--no-browser`, `--no-execute`, loopback-only, uses an
absolute discovered Quarto executable, and uses a working directory constrained
to the applicable QMD tree.

The selected routes are:

- `drafts/index.qmd` -> `/`
- `drafts/local_alg.qmd` -> `/local_alg.html`
- `drafts/topic/note.qmd` -> `/topic/note.html`
- `drafts/topic/index.qmd` -> `/topic/`

Readiness probes use the exact page URL rather than the server root.

### 5. Native Zotero web container

The exact page is hosted by a native XUL `<browser>` created with
`document.createXULElement("browser")`, `type="content"`, `remote="true"`, and
`maychangeremoteness="true"`, matching the working XPI pattern. A focused
adapter owns navigation, reload, load/error reporting, and cleanup.

The source-driven quick renderer remains an ordinary local `srcdoc` surface
and never loads an external origin.

### 6. One active exact-render session

Chatero owns at most one active Quarto preview process per QMD workspace tab.
Opening a different document stops the previous process. Reopening the same
document reuses the process after probing the exact page. Hiding Website
Preview does not stop it, and returning to Website Preview does not restart it.

Autosave does not spawn another server. The existing Quarto watch process
observes the active file; a debounced refresh updates UI state and reloads the
exact page only after it is ready.

### 7. Last-good preview

The controller stores the latest successfully displayed exact URL and latest
quick HTML for the active Draft. During refresh or transient Quarto failure it
continues showing last-good content. The Website pane is empty only before a
Draft has ever been opened.

## XPI Toolbar Compatibility

The native toolbar keeps icon-only, tooltip-labelled access to the former XPI
capabilities:

- Draft compliance status/check;
- Add to Knowledge / start approval-publish workflow;
- Complete TODOs with the authoritative Research Loop skill;
- Original versus AI-proposed version comparison;
- Keep the latest AI proposal;
- Visual Edit formal-block tools;
- open in the configured external editor;
- refresh the active surface.

Existing Chatero controls such as Explorer collapse, explicit save, and Reject
may remain when they do not duplicate or obscure these baseline actions.
Feature availability follows the active object and proposal state; disabled
actions stay discoverable through their tooltip.

## User-visible State Model

### Surface state

| Surface | Visible content | Persistence behavior |
| --- | --- | --- |
| Visual Edit | Rendered source blocks with contextual inline editors | Human edits autosave to the original Draft |
| Website Preview | Quick preview, then exact selected Quarto page | Read-only; reflects saved Draft state |
| Monaco Source | Raw QMD in Monaco | Human edits autosave to the original Draft |

The eye control always advances to the next row and never changes the selected
Draft.

### Website-preview state

| State | Visible content | Status text |
| --- | --- | --- |
| No Draft | Empty guidance | Select a Draft |
| Quick ready, Quarto starting | Current source-driven preview | Quick Preview · preparing Quarto… |
| Exact ready | Native browser on selected HTML route | Quarto Preview |
| Saving | Existing visible preview | Saving… |
| Refreshing after save | Last-good exact or quick preview | Saved · updating Quarto… |
| Quarto failed with fallback | Quick or last-good preview | Quick Preview · Quarto unavailable: … |
| Source conflict | Existing visible preview | Existing conflict message |
| AI proposal selected | Source-driven proposed preview | Proposed Preview |

`Saved` describes disk persistence only and must not imply Quarto readiness.
Preview-state updates may not overwrite an active save error or source conflict.

## Data Flow

1. The user opens a Draft. Chatero reads it once into the Draft session and
   loads the same snapshot into Monaco and Visual Edit.
2. Visual Edit is shown by default for a new tab. Restored tabs apply the
   stored surface after all three surfaces exist.
3. Human edits in Monaco or Visual Edit update the same Draft session and
   autosave through `QmdDraftIO.writeSource`.
4. Entering Website Preview displays quick HTML synchronously. The existing
   one-file Quarto session starts or is reused and probes the selected route.
5. Exact output replaces quick HTML when ready; failure retains last-good
   content.
6. AI proposals continue to use the private working copy. Proposed preview is
   source-driven until Keep promotes it through the guarded path.

## Error Handling

- Spawn and early-exit diagnostics remain visible and include Quarto output.
- A readiness timeout applies to the exact page, not `/`.
- A failed exact render does not clear quick or last-good content.
- A browser load failure reports the route and retains the fallback.
- Rapid document changes invalidate stale starts; late processes cannot
  navigate the current browser.
- A Visual Edit save is revision-guarded. Superseded generations cannot update
  the current document or surface stale errors.
- Disposal flushes recoverable visual input, stops the active Quarto process,
  and tears down the native browser.

## Security and Privacy

- The lightweight renderer escapes raw content and uses the existing safe QMD
  block renderer.
- Quarto always runs with `--no-execute`.
- Only QMD paths inside the selected external QLab repository are accepted.
- The native browser loads only the loopback URL created by the preview service.
- No QLab content is copied into the Chatero source repository or DMG.

## Test Strategy

Tests are added before implementation for:

1. correct preview routes for root, nested, and index QMD files;
2. readiness probing of the selected HTML route rather than `/`;
3. immediate quick-preview publication before Quarto resolves;
4. native XUL browser creation and exact URL navigation;
5. preservation of last-good content through refresh and failure;
6. truthful status ordering between save and preview states;
7. one active process, same-document reuse, and stale-request cancellation;
8. exact three-state cycling, new-tab default, old-state migration, and tab
   restoration;
9. Monaco, Visual Edit, and Quarto identity surviving mode switches;
10. formula-only editing and complete theorem/callout source editing;
11. Visual Edit autosave, generation safety, and canonical formal-block
    insertion;
12. former XPI toolbar capability parity and accessible icon labels;
13. unchanged AI proposal and human-save authority boundaries;
14. privacy scanning of the final DMG.

## Acceptance Criteria

- A new Draft opens in Visual Edit; a restored tab resumes its persisted
  surface.
- Repeated eye-button presses produce Visual Edit, Website Preview, Monaco
  Source, then Visual Edit again.
- A mode switch never creates a second Draft session, Monaco instance, Visual
  Editor, or Quarto process and never loses an in-progress human edit.
- Entering Website Preview shows non-empty content immediately.
- The exact selected page replaces it when ready; the Draft index is never
  shown for a non-index note.
- Switching Drafts never leaves multiple Quarto processes owned by the tab.
- A save does not spawn a second server or blank Website Preview.
- Quarto errors leave readable quick/last-good content and a useful status.
- The former XPI's Visual Edit and Draft toolbar capabilities are present and
  usable in Chatero.
- Visual/Website/Source switching, Explorer selection, autosave, AI diff,
  Keep, and Reject pass their tests.
- The Chatero test suite, build, signature, and DMG privacy checks pass.
