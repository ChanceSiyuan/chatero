# Hybrid Single-File QMD Preview Design

Date: 2026-08-08

## Problem

The QMD workspace can show an empty white Preview surface even while the
status bar says `Saved`. The running application confirms that Quarto itself
is healthy: the active Draft is served on loopback and returns HTTP 200.

Three implementation defects combine to hide that result:

1. `startQmdQuartoPreview` returns the server root (`/`) instead of the HTML
   path corresponding to the selected QMD. For example,
   `drafts/local_alg.qmd` is served as `/local_alg.html`, while `/` is the
   Draft workspace index.
2. The Chatero shell embeds the loopback page in an HTML `iframe`. The earlier
   Zotero XPI uses a native remote XUL `<browser type="content">`, which is the
   supported container for web content inside a privileged Zotero window.
3. Preview startup has no visible intermediate content. A later `Saved`
   message overwrites `Rendering…`, so the empty frame gives neither progress
   nor a useful error.

The current process already invokes `quarto preview` for one selected QMD with
`--no-execute`; it does not intentionally render the whole Draft tree. The
remaining performance cost is Quarto startup and the first exact render.

## Goals

- Show useful preview content immediately after the user switches from Source
  to Preview.
- Replace the immediate preview with the authoritative Quarto result when it
  becomes ready.
- Render only the active QMD, with code execution disabled.
- Use the correct HTML route for root, nested, and `index.qmd` Drafts.
- Never replace a visible last-good preview with an empty surface.
- Make `Saved`, `Rendering`, `Quick Preview`, `Quarto Preview`, and failures
  distinguishable.
- Preserve Source editing, autosave, AI proposal comparison, Keep/Reject,
  Explorer behavior, and all Zotero features.
- Never copy, modify, package, or commit personal Knowledge, Drafts,
  Literature, chat history, credentials, or Zotero profile data.

## Non-goals

- Reimplementing all of Pandoc or Quarto in JavaScript.
- Executing QMD code cells in Preview.
- Publishing Drafts or changing the Knowledge publication contract.
- Keeping one permanent Quarto process for every QMD file.
- Reintroducing simultaneous Source and Preview panes inside one QMD tab.

## Chosen Architecture

The Preview surface has two renderers behind one stable container.

### 1. Immediate source-driven preview

When Preview becomes visible, Chatero renders the current in-memory QMD buffer
with the existing safe `renderQmdDocumentHTML` path. This provides headings,
paragraphs, lists, links, math, and theorem/callout cards without spawning a
new process. The preview is labelled `Quick Preview` while Quarto is pending.

This renderer is a responsiveness layer, not the authority for final visual
parity. Unsupported constructs remain readable rather than executing or
silently disappearing.

### 2. Exact single-file Quarto preview

In the background, Chatero starts or refreshes Quarto for only the selected
QMD. The process keeps these existing safety properties:

- `--no-browser`
- `--no-execute`
- loopback host only
- an absolute discovered Quarto executable
- a working directory constrained to the applicable QMD tree

The URL returned to the UI includes the selected document route:

- `drafts/index.qmd` becomes `/`
- `drafts/local_alg.qmd` becomes `/local_alg.html`
- `drafts/topic/note.qmd` becomes `/topic/note.html`
- `drafts/topic/index.qmd` becomes `/topic/`

Readiness probes use this exact page URL rather than the server root.

### 3. Native Zotero web container

The exact page is hosted by a native XUL `<browser>` created with
`document.createXULElement("browser")`. It uses `type="content"`,
`remote="true"`, and `maychangeremoteness="true"`, matching the working XPI
pattern. A small adapter owns navigation, reload, load/error reporting, and
cleanup so the workspace does not depend on browser internals.

The source-driven renderer remains an ordinary local DOM/`srcdoc` surface. It
is never loaded from an external origin.

### 4. One active exact-render session

Chatero owns at most one active Quarto preview process per QMD workspace tab.
Opening a different document stops the previous process before starting the
new one. Reopening the same document reuses the process after probing the
exact page. This copies the earlier XPI's lifecycle instead of retaining a
process for every visited Draft.

Autosave does not spawn another server. The existing Quarto watch process
observes the active file. A debounced refresh request updates UI state and
reloads the exact page only after it is ready.

### 5. Last-good preview

The controller stores the latest successfully displayed exact URL and the
latest quick-preview HTML for the active Draft. During refresh or a transient
Quarto failure, it continues showing the last-good content. The pane is empty
only before any Draft has ever been opened.

## User-visible State Model

The Preview surface uses these states:

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

`Saved` describes disk persistence only and must not imply that Quarto is
ready. Preview-state updates may not overwrite an active save error or source
conflict.

## Data Flow

1. The user opens a Draft. Chatero reads it once into the existing Draft
   session and Monaco buffer.
2. Chatero builds and caches safe quick-preview HTML from that same buffer.
3. The user presses the eye icon. The quick preview appears synchronously.
4. The preview controller starts the one-file Quarto session in the
   background and probes the selected HTML route.
5. When the exact route returns successfully, the native browser navigates to
   it and replaces the quick preview in the same surface.
6. Human edits autosave through `QmdDraftIO.writeSource`. The quick preview is
   regenerated from the saved buffer, while the existing Quarto process
   updates the exact result.
7. AI proposals continue to use the private working copy. Proposed Preview is
   source-driven until Keep promotes it through the existing guarded path.

## Error Handling

- Spawn and early-exit diagnostics remain visible and include captured Quarto
  output.
- A readiness timeout applies to the exact page, not `/`.
- A failed exact render does not clear the quick or last-good preview.
- A browser load failure reports the route and retains the fallback.
- Rapid document changes invalidate stale starts; a late process is stopped
  and may not navigate the current browser.
- Disposal stops the active Quarto process and tears down the native browser.

## Security and Privacy

- The lightweight renderer escapes raw content and follows the existing safe
  QMD block renderer.
- Quarto always runs with `--no-execute`.
- Only QMD paths inside the selected external QLab repository are accepted.
- The native browser loads only the loopback URL created by the preview
  service.
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
8. unchanged AI proposal and human-save authority boundaries;
9. privacy scanning of the final DMG.

## Acceptance Criteria

- Pressing the eye icon shows non-empty content immediately for an open Draft.
- The exact selected page replaces it when Quarto is ready; the Draft index is
  never shown for a non-index note.
- Switching among Drafts never leaves multiple Quarto preview processes owned
  by that QMD tab.
- A save does not spawn a second server or blank the Preview.
- Quarto errors leave a readable quick/last-good preview and a useful status.
- Source/Preview switching, Explorer selection, autosave, AI diff, Keep, and
  Reject pass their existing tests.
- The Chatero test suite, build, signature, and DMG privacy checks pass.
