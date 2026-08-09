# Floating Chat and Visual-Math Repair Design

**Date:** 2026-08-09

**Status:** Approved for implementation

**Product:** Chatero

**Scope:** Native PDF/QMD research layout, `qlabchat`, Reader selection actions,
and source-driven QMD Visual Edit

## Summary

Make PDF reading and QMD writing the stable primary workspace. Chat remains a
native, persistent Chatero conversation with the same history, context, and
Agent lifecycle, but it no longer consumes a third split pane. Opening Chat
presents its existing full interface in a centered, draggable, resizable
floating surface over the PDF/QMD workspace. A Pin control selects whether the
surface stays visible while the user interacts with the documents behind it.

This change also repairs two problems visible in the current research desk:

1. the Reader's quote action uses an ambiguous SVG that resembles corrupt text;
2. Visual Edit produces KaTeX markup without loading KaTeX CSS in Zotero's
   headless XUL document, and theorem-family titles bypass inline math
   rendering entirely.

The implementation reuses the existing Chat DOM and runtime rather than
creating a second compact-chat product or duplicating conversation state.

## XPI Lineage and Chatero Improvements

The earlier XPI `⌘K` compact float is the interaction reference. Its proven
mechanics are carried forward:

- one resident Chat view that is shown and hidden rather than reconstructed;
- a draggable title bar;
- a familiar corner-resize interaction;
- viewport clamping after drag, resize, and window changes;
- remembered size;
- focus restoration after dismissal.

Chatero can integrate those mechanics below Zotero's native tab strip instead
of injecting an add-on panel into the whole window, so the new surface improves
the XPI design in several ways:

- it contains the complete Chat transcript, history controls, actions, context
  tags, streaming progress, and composer instead of only the latest exchange;
- it persists both position and size, not size alone;
- it uses pointer capture and a dedicated presentation controller rather than
  document-wide mouse listeners scattered through plugin state;
- it introduces explicit pinned and unpinned outside-click behavior;
- it is constrained to the usable tab deck and cannot cover the native tab bar,
  application menus, or unrelated Zotero chrome;
- it uses an opaque, theme-matched reading surface rather than requiring an
  opacity slider, which previously reduced text contrast and complicated focus;
- it exposes running, completed, and error state through the native Chat tab and
  launchers while the surface is hidden.

The old XPI is therefore a behavioral reference, not a second implementation to
embed or maintain.

## Goals

1. Preserve useful horizontal space for the two primary tasks: reading a PDF
   and editing or previewing a QMD Draft.
2. Let Chat be summoned quickly, moved, resized, pinned, or hidden without
   interrupting an Agent turn or losing conversation state.
3. Make outside-click dismissal predictable: unpinned Chat hides when the user
   returns to PDF/QMD; pinned Chat remains until explicitly hidden.
4. Render inline and display mathematics correctly throughout Visual Edit,
   including theorem-family card titles and bodies.
5. Replace the misleading quote glyph with an unambiguous icon-only action and
   an accessible explanation.
6. Migrate existing two- and three-pane Chatero sessions without closing PDF,
   QMD, or Chat tabs and without losing persisted chat history.

## Non-goals

- A second Chat implementation or separate prompt system.
- A modal dialog that prevents interaction with PDF or QMD.
- Making Chat a webview, browser tab, or independent macOS window.
- Cancelling Agent work when Chat is hidden.
- Making compiled Website Preview editable.
- Replacing KaTeX or Quarto with a new math renderer.
- Changing the trusted `knowledge/`, editable `drafts/`, or evidence
  `literature/` boundaries.

## Considered Chat Presentations

### 1. Utility overlay — selected

The native Chat session is presented as a floating utility surface inside the
main tab deck. It can overlap content, but it does not change the PDF/QMD split
ratio. It retains the existing Chat host and therefore preserves transcript,
composer state, context tags, history, running-turn handle, and streaming
output while hidden.

This best matches the product's research workflow because the user can read and
write at full width, reveal Chat for a focused exchange, then dismiss it with a
single click back into the document.

### 2. Wide right drawer — rejected

A drawer is predictable and never floats over the document, but it recreates
the current problem by taking horizontal space from PDF and QMD. It also makes
long mathematical answers too narrow when the document split is active.

### 3. Detached Chat window — deferred

A detached window is useful on multiple monitors, but it adds window ownership,
focus, context, restoration, and lifecycle complexity. It is not needed to
solve the current layout problem and remains a possible future presentation of
the same Chat session.

## Primary Workspace

The normal research layout has two content panes:

```text
┌─────────────────────────────── Chatero ───────────────────────────────┐
│ Native tabs                                                         │
├─────────────────────────────┬────────────────────────────────────────┤
│ PDF Reader                  │ QMD Editor / Visual Edit / Website     │
│                             │ Preview                                │
│                             │                                        │
│              ┌──────────────┴──────────────────────┐                 │
│              │ Floating Chat (when visible)        │                 │
│              │ drag · pin · hide · resize          │                 │
│              └─────────────────────────────────────┘                 │
└─────────────────────────────┴────────────────────────────────────────┘
```

The divider between PDF and QMD remains draggable and is restored normally.
Chat is a utility presentation layered above `#tabs-deck`; it is not a third
member of the content grid.

The Chat tab remains in the native tab strip for discoverability, history, and
close semantics. Selecting it reveals and focuses the floating surface while
leaving the current PDF/QMD panes visible. The native tab is therefore a
launcher and conversation entry, not a content-grid destination or DOM owner.

More precisely, the Chat launcher does not become Zotero's selected content
tab. `_selectedID`, `selectedType`, `deck-selected`, native tab notifications,
Reader lookup, close/undo, and session focus continue to observe the last PDF,
QMD, Library, or other content tab. Chat has a separate `aria-pressed` and
visible state rendered by the tab strip. Hiding Chat clears that state without
fabricating a content-tab selection change. Ordinary next/previous content-tab
cycling skips utility launchers; Chat has its explicit launcher and shortcut.

## Chat Surface State

Each Chatero window owns one presentation state:

```text
visibility: hidden | visible
pinned: false | true
bounds: { left, top, width, height }
focusReturn: last meaningful PDF/QMD control
invocation: tab | toolbar | shortcut | pdf-selection | qmd-selection
```

The conversation and Agent state are not fields of the presentation state.
They remain owned by the existing Chat host and runtime.

### Visibility transitions

| Event | Unpinned | Pinned |
|---|---|---|
| Select Chat tab or invoke Chat action | Show and focus composer | Show and focus composer |
| Click inside Chat | Stay visible | Stay visible |
| Drag or resize Chat | Stay visible | Stay visible |
| Use a Chat menu or context tag | Stay visible | Stay visible |
| Click PDF or QMD behind Chat | Hide and return focus | Stay visible |
| Click Hide | Hide | Hide |
| Press Chat toggle shortcut | Toggle | Toggle |
| Agent begins or continues a turn | No visibility change | No visibility change |
| Agent completes while hidden | Remain hidden; show completion badge | Remain hidden; show completion badge |
| Close Chat tab | Hide and remove its tab-strip launcher; do not delete history or cancel work | Same |

Outside-click handling is based on the composed event path, not a broad blur
handler. Because Zotero Reader, Monaco Source, Quick Preview, and Website
Preview use embedded documents, one window-scoped interaction bridge receives
normalized activity from the main XUL document plus surface-specific adapters:

- Reader documents register through the existing Reader lifecycle hooks;
- Monaco posts pointer activity through its existing parent bridge;
- same-origin Quick Preview documents attach capture listeners after every load;
- remote Website Preview uses the browser's parent/child message bridge rather
  than assuming DOM events cross the process boundary.

Popovers, dropdowns, context menus, resize handles, and other Chat-owned portals
count as inside Chat. Focus changes caused by macOS window activation do not
dismiss it.

An outside pointer event hides an unpinned surface without cancelling or
preventing that event, so the same click still places the PDF cursor, changes a
page, selects QMD text, or focuses Monaco. There is no modal scrim.

Hiding never invokes Agent cancellation, disposes the Chat host, resets scroll,
or clears a draft/PDF context tag. A running turn continues to stream into the
hidden resident host.

Closing the native Chat launcher hides the window-owned utility host but never
removes it. Reopening Chat in the same Chatero window reveals that same host; it
never creates a second transcript or stream consumer. The host is disposed only
when its Chatero window closes, after normal conversation persistence. This is
true whether the Agent is idle or running.

### Pin

The title bar contains an icon-only Pin button with a tooltip and accessible
label:

- unpinned: `Pin Chat`; outside PDF/QMD interaction hides the surface;
- pinned: `Unpin Chat`; PDF/QMD remains operable and Chat stays visible.

Pin changes only presentation behavior. It does not pin PDF/QMD context and is
visually distinct from composer context tags.

The pinned preference and bounds are persisted per Chatero window session.
After an application restart, the size, location, and Pin preference are
restored, but Chat starts hidden so it never unexpectedly covers the workspace.

## Placement and Sizing

On the first invocation in a window, Chat is centered within the usable tab
deck, below the native tab strip. It does not use full-window coordinates that
could cover unrelated macOS or Zotero chrome.

Default bounds:

- preferred width: 720 px;
- preferred height: 680 px;
- maximum width: the smaller of 860 px and the deck width minus 48 px;
- maximum height: the deck height minus 48 px;
- minimum size: 480 × 420 px;
- minimum deck margin: 24 px.

For a deck smaller than the minimum, the surface fits the available deck with a
16 px margin and internal transcript/composer scrolling. It never forces the
PDF/QMD grid wider.

After the user drags or resizes Chat, reopening uses the last bounds. Window
resize, display changes, or session restoration clamp those bounds into the
current visible deck. Bounds are stored after pointer release rather than on
every pointer movement.

The surface uses the existing light Chatero/Zotero palette, a subtle border and
shadow, and no black editor-like background. The header is the drag handle but
buttons and interactive descendants never initiate dragging. Pointer capture
keeps drag and resize stable if the pointer leaves the surface.

## Invocation Rules

- Selecting the native Chat tab reveals the surface without replacing either
  primary pane.
- The Reader Chat icon captures the current PDF/selection context, reveals
  Chat, and focuses the composer.
- `⌘L` adds current context and reveals Chat only when the existing focus rule
  requests it; context pinning itself never changes a running turn.
- The Research Desk command becomes `PDF | QMD + floating Chat`.
- Legacy `PDF | Chat` arrangements migrate to PDF/QMD when a QMD tab is
  available and reveal floating Chat. If no QMD tab exists yet, PDF remains the
  sole content pane and Chat still floats.
- The PDF | QMD command continues to arrange only those two panes and does not
  force Chat open.

When an unpinned Chat was invoked from a selection popup, the originating
outside click is ignored so the surface cannot immediately dismiss itself.
Subsequent PDF/QMD clicks hide it normally.

## Running and Hidden Feedback

The Chat native-tab icon and every Chat launcher share a small state indicator:

- neutral: idle, hidden;
- blue dot: unread completed response;
- animated ring: Agent running;
- red dot: actionable connection or Agent error.

These indicators do not expose chain-of-thought. Reopening Chat shows the same
user-visible progress and tool activity already supported by the workbench.
Closing or hiding Chat never converts a running turn into an error.

## Reader Quote Icon Repair

The existing `ReaderIcons.quote` consists of two open loop paths that resemble
corrupt characters at 20 px. Replace only this icon with a standard blockquote
metaphor: a vertical quote bar plus three short text lines. Preserve:

- the existing `Insert selection into QMD as quote (⌘⇧K)` tooltip;
- the accessible label;
- the current click handler and QMD deep-link insertion path;
- icon-only presentation.

The SVG uses `currentColor` or a theme-compatible source rather than a hardcoded
light-mode stroke where Reader embedding permits it.

## Visual Edit Mathematics Repair

### Root causes

The math renderer already produces correct KaTeX HTML. The stylesheet loader
currently looks only for an HTML `<head>`, while `zoteroPane.xhtml` is a XUL
`<window>` with no `<head>`. The loader therefore returns without installing
KaTeX CSS, causing valid KaTeX markup to appear as flattened or duplicated
text.

The theorem-family card header independently writes `block.title` with
`textContent`. A title such as `## ($r$-local function)` can never reach the
inline QMD/KaTeX renderer.

### Required behavior

1. Load `resource://zotero/katex.min.css` from the main XUL document's static
   stylesheet declarations so Visual Edit never depends on `<head>` injection.
2. Retain the defensive dynamic loader for HTML-hosted documents, but make a
   missing `<head>` an observable test case rather than the only production
   path.
3. Build formal-card headers from a plain label/number node and a separately
   sanitized inline-QMD title node.
4. Render title and body formulas with the same KaTeX configuration and CSS.
5. Extend the source model with the exact title source range so clicking a
   title formula opens only its LaTeX body, just like a body formula.
6. Clicking non-formula title text still opens the complete formal block source,
   preserving the current source-authoritative editing model.
7. Invalid LaTeX remains visible as an explicit source-like error span and can
   be clicked for correction; it is never silently discarded.

The exact reported fixture must render correctly:

```qmd
::: {#def-r-local-function .callout-note icon="false"}
## ($r$-local function)

A function $f(u,G,x)$ is $r$-local iff
$f(u,G,x)=F\!\left(\mathcal V_r(u,G,x)\right).$
:::
```

## Architecture

### `ChatPresentationController`

A window-scoped controller owns visibility, Pin, bounds, invocation source,
outside-click policy, focus restoration, persistence, and viewport clamping.
It does not own messages or Agent execution.

The controller exposes a narrow API:

```text
show({ invocation, focusComposer })
hide({ restoreFocus })
toggle(options)
setPinned(boolean)
setBounds(bounds)
snapshot()
restore(snapshot)
```

### Window-owned utility layer and existing Chat host

Each Chatero window creates one `qlab-chat-utility-layer` inside the usable tab
deck. The current `qlabchat` host is mounted there once and remains owned by the
window, not by a disposable native `tab-content` container. Presentation
classes move the same host between hidden and floating states without calling
`mountShellTab`, replacing its DOM, or creating a second transcript. This
prevents duplicate stream output and preserves the running turn handle.

The native Chat tab is only a launcher/lifecycle entry. Its placeholder content
is never inserted into the deck grid. Closing the launcher does not remove the
utility layer; reopening reuses it. Window shutdown performs the one definitive
host disposal.

### `ChatOutsideInteractionBridge`

The bridge attaches capture listeners to the main XUL document and coordinates
the Reader, Monaco, Quick Preview, and Website Preview adapters described above.
It handles embedded-surface creation, reload, and destruction, maps events into
a normalized `insideChat` decision, and never suppresses the underlying
PDF/QMD event. A one-shot invocation token ignores the pointer event that opened
Chat from a Reader selection popup.

### Tab groups

`TabGroups` version 3 separates `contentTabs`/`panes` from `utilityTabs`.
`qlabchat` remains in the tab model as a utility launcher but cannot be inserted
into a pane. `openTab`, `moveTab`, normalization, restore, and round-trip
serialization enforce that invariant.

Version-2 layouts are migrated once: Chat is removed from pane membership,
revived under `utilityTabs`, and restored as a hidden utility presentation with
its conversation untouched. Unlike the current version-2 restore path, an
ungrouped utility is never reinserted into pane 0.

The native tabs controller keeps `_selectedID` as the single selected content
identity and stores Chat presentation separately. Existing `selectedType`,
Reader/QMD commands, close/undo, notifications, restore, and keyboard navigation
continue to operate on content tabs; activating Chat only toggles the utility
launcher's pressed state and floating visibility.

The migration must preserve any PDF and QMD pane order and ratios. A previous
three-way PDF/QMD/Chat layout becomes the same PDF/QMD split plus an initially
hidden Chat surface.

### Styling

Floating-surface styles live in a dedicated Chatero SCSS component. They do not
reuse old XPI CSS wholesale, but may reuse its proven bounds clamping,
drag/resize, focus-return, and persisted-size behavior. Selectors are scoped to
the Chat utility host and must not change Zotero dialogs or Reader popups.

## Accessibility and Keyboard Behavior

- The surface has `role="dialog"` and `aria-modal="false"`.
- Pin and Hide buttons have localized accessible labels and hover tooltips.
- Opening Chat moves focus to the composer only when the invocation requests
  it; context-only attachment can leave focus in PDF/QMD.
- Hiding returns focus to the last connected meaningful control.
- Tab traversal stays within normal document order; this is not a modal focus
  trap.
- The existing Agent Stop/Escape behavior takes precedence while a turn is
  running. Chat visibility is toggled through its explicit shortcut/button so
  Escape cannot accidentally both stop work and hide the surface.
- Reduced-motion preferences disable nonessential opening and indicator
  animations.

## Failure Handling

- If bounds restoration is invalid, recenter with defaults.
- If the Chat host fails to mount, leave PDF/QMD fully usable and expose one
  non-blocking launcher error.
- Visual Edit verifies a small KaTeX computed-style sentinel before showing
  rendered math. If the packaged stylesheet cannot load, it shows the original
  delimited formula in an explicit source-like error span instead of exposing
  unstyled KaTeX markup. Website Preview remains independent.
- A Chat UI error cannot cancel or dispose an already-running provider turn.
- A failed persistence write affects only future bounds restoration, not Chat
  visibility or conversation history.

## Testing Strategy

### Unit tests

- Chat presentation state transitions for hidden/visible and pinned/unpinned.
- Outside composed-path classification for Chat controls, portals, PDF, and QMD.
- Embedded Reader events reach the outside-interaction bridge without consuming
  the original Reader click.
- Bounds defaults, resize clamping, display-size changes, and persistence.
- Hide and close paths never call Agent cancellation.
- Tab-group migration removes Chat from the pane grid without removing its tab
  or changing PDF/QMD order.
- Version-2-to-version-3 and version-3 round trips preserve utility tabs without
  normalizing them back into pane 0.
- Chat activation leaves `_selectedID`, `selectedType`, Reader commands,
  close/undo, and next/previous content-tab cycling unchanged.
- Reader quote action still emits an image-only accessible button and the SVG
  uses the new blockquote geometry.
- Formal-title parsing returns an exact title range.
- Title and body formula rendering both produce KaTeX nodes and preserve exact
  source ranges.

### Integration tests

- Selecting Chat while PDF/QMD are split leaves both panes visible.
- An unpinned surface hides on a PDF or QMD click; a pinned surface does not.
- Unpinned dismissal works independently in Reader, Visual Edit, Monaco Source,
  Quick Preview, and Website Preview.
- Drag, resize, menu, composer, and context-tag interactions do not count as
  outside clicks.
- A simulated streaming turn continues while hidden and resumes rendering once
  shown, without duplicated chunks.
- Closing and reopening Chat during a simulated stream reuses one host and one
  stream consumer.
- Main XUL build output statically includes `resource://zotero/katex.min.css`,
  and a Gecko/XUL integration check verifies the KaTeX sentinel and representative
  formula nodes have the expected computed font/layout styles.
- The `local_alg.qmd` regression fixture renders KaTeX in the display formula,
  surrounding paragraph, formal-card title, and formal-card body.
- Clicking title/body formulas opens their exact LaTeX editor and saving changes
  no other QMD bytes.
- A rendered screenshot regression covers inline math, display math, and a
  theorem title/body in the real light-theme Visual Edit surface.

### Manual DMG acceptance

1. Open a PDF and QMD Draft side by side.
2. Open Chat from the native tab and verify PDF/QMD widths do not change.
3. Drag and resize Chat, hide it, reopen it, and verify bounds are restored.
4. Leave Chat unpinned, click PDF, and verify it hides.
5. Pin Chat, click and scroll both PDF and QMD, and verify it stays visible.
6. Start an Agent turn, hide Chat, continue reading/editing, then reopen and
   verify the same turn and transcript remain.
7. Restart Chatero and verify Chat starts hidden while Pin preference and bounds
   are remembered.
8. Select PDF text and verify the quote icon is recognizable and inserts the
   same QMD quote/deep link.
9. Open `drafts/local_alg.qmd` in Visual Edit and verify all formulas, including
   `$r$` in the Definition title, render correctly.
10. Click title and body formulas, edit LaTeX, leave the field, and verify the
    exact QMD source is saved and rerendered.

## Rollout and Compatibility

The feature remains behind the existing QLab enable preference. No personal
Knowledge, Draft, Literature, chat-history, or proposal files are migrated or
rewritten. Only Chatero window/session layout metadata changes.

The first compatible launch lazily migrates a legacy layout when it is restored.
Unknown or malformed layout data falls back to the normal PDF/QMD arrangement
without deleting native tabs. Disabling QLab restores ordinary Zotero tab
behavior and must leave Library, Reader, sync, annotations, and citation tools
unchanged.

## Acceptance Criteria

- PDF and QMD remain the only content panes when Chat is open.
- Chat opens centered on first use, can be dragged and resized, and stays within
  the visible deck.
- Unpinned Chat hides on PDF/QMD interaction; pinned Chat remains visible until
  explicitly hidden.
- Hiding Chat never interrupts or duplicates an Agent response.
- Existing Chat history and context tags survive the presentation change.
- The Reader quote action is visually unambiguous and functionally unchanged.
- Visual Edit loads KaTeX styling in the real XUL window.
- Mathematics renders in ordinary paragraphs, display blocks, formal-card
  titles, and formal-card bodies.
- Formula editing remains source-driven and byte-preserving outside the chosen
  source range.
- Legacy three-pane sessions migrate without loss of user content or tabs.
- Automated tests, Chatero build, and signed/notarized-DMG-independent local DMG
  packaging complete without regressions.
