# Floating Chat and Visual Math Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep PDF and QMD as the two primary panes, present the existing full Chat workbench as a persistent draggable/pinnable floating utility, repair Visual Edit mathematics, and replace the ambiguous Reader quote icon without changing personal research content.

**Architecture:** Separate content-pane state from window-owned utility presentation. `TabGroups` v3 owns only content panes plus utility launcher metadata; a pure `ChatPresentationController` owns float visibility, Pin, bounds, focus return, and persistence; the existing Chat host is mounted once in a utility layer under `#tabs-deck`. Visual Edit stays source-authoritative, with exact source ranges for title and body formulas and a static KaTeX stylesheet in the XUL window.

**Tech Stack:** Zotero/Gecko XUL, JavaScript XPCOM modules, React Zotero tabs, SCSS, KaTeX, Monaco iframe, Node `node:test`, Chatero build and DMG staging scripts.

## Global Constraints

- Do not read, rewrite, migrate, or commit personal files under `knowledge/`, `drafts/`, or `literature/`.
- Preserve Zotero Reader, Library, annotations, citations, synchronization, native tab close/undo, and ordinary next/previous content-tab behavior.
- Reuse the existing full Chat host and Agent lifecycle. Hiding or closing the launcher must not cancel work, duplicate stream consumers, clear history, or remount the host.
- Use test-driven development for every behavior: add one focused failing test, observe the intended failure, implement the minimum change, rerun the focused test, then run the affected suite.
- Use only light/theme-derived colors and accessible icon-only controls with labels and tooltips.
- Keep Website Preview read-only and Visual Edit source-authoritative.

---

## Task 1: Repair the Reader quote action

**Files:**

- Modify: `chrome/content/zotero/xpcom/qlab/readerIcons.js`
- Test: `scripts/chatero/tests/reader-hooks.test.mjs`

- [ ] Add a behavioral regression test that decodes `ReaderIcons.quote`, asserts a single vertical quote bar plus three horizontal text lines, rejects the old paired open-loop paths, and confirms the existing tooltip/accessibility text remains in `readerHooks.js`.
- [ ] Run `NODE_OPTIONS=--openssl-legacy-provider node --test scripts/chatero/tests/reader-hooks.test.mjs` and observe the geometry assertion fail for the current icon.
- [ ] Replace only `ReaderIcons.quote` with the blockquote geometry using theme-compatible `currentColor`; do not alter the button click handler, shortcut, tooltip, or deep-link insertion path.
- [ ] Rerun the focused test and `NODE_OPTIONS=--openssl-legacy-provider npm run test:chatero`.
- [ ] Commit as `fix: clarify Reader quote action icon`.

## Task 2: Make Visual Edit math styled and source-driven everywhere

**Files:**

- Modify: `chrome/content/zotero/zoteroPane.xhtml`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdSourceModel.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdVisualEditor.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qlabModule.js`
- Modify if needed: `chrome/content/zotero/xpcom/qlab/qmdMathRender.js`
- Test: `scripts/chatero/tests/qmd-surface.test.mjs`
- Test: `scripts/chatero/tests/qmd-visual-editor.test.mjs`
- Test: `scripts/chatero/tests/qmd-math-preview.test.mjs`
- Test: `scripts/chatero/tests/qlab-visual-structure.test.mjs`

- [ ] Add the exact `def-r-local-function` fixture from the approved design. Assert `visualQmdBlocks()` returns the formal title text and an exact block-local `titleRange` covering only the heading contents after `## `; verify `block.start + titleRange.start/end` slices the original LF or CRLF source exactly.
- [ ] Add editor tests showing both `$r$` in the title and body formulas produce rendered math nodes with exact `data-source-start`/`data-source-end` coordinates, while clicking non-formula title text retains whole-card source editing.
- [ ] Add a structural test requiring `resource://zotero/katex.min.css` in `zoteroPane.xhtml`, plus a loader test proving an HTML document still receives the dynamic stylesheet.
- [ ] Run the four focused files and observe failures for title range, title KaTeX, and XUL stylesheet loading.
- [ ] Extend `fenceTitle()`/`visualQmdBlocks()` to expose the exact title region without changing coordinates for CRLF documents.
- [ ] Render the formal-card label/number as plain text and its title through the same sanitized inline-QMD renderer as body text. Bind title formula editors to exact ranges and preserve byte-for-byte content outside the edited range.
- [ ] Add a computed-style KaTeX sentinel. When styles are unavailable, render the original delimited expression in an explicit source-like error span instead of unstyled KaTeX markup.
- [ ] Add the static XUL KaTeX stylesheet while retaining defensive dynamic loading for HTML documents.
- [ ] Rerun focused tests, then the complete Chatero suite.
- [ ] Commit as `fix: render Visual Edit math from exact QMD ranges`.

## Task 3: Separate utility launchers from content panes in TabGroups v3

**Files:**

- Modify: `chrome/content/zotero/xpcom/qlab/tabGroups.js`
- Modify: `chrome/content/zotero/xpcom/qlab/splitLayout.js`
- Modify: `chrome/content/zotero/xpcom/qlab/arrangement.js`
- Test: `scripts/chatero/tests/tab-groups.test.mjs`
- Test: `scripts/chatero/tests/split-layout.test.mjs`
- Test: `scripts/chatero/tests/arrangement.test.mjs`

- [ ] Replace legacy expectations that place `qlabchat` in `right`/`third` panes with v3 expectations: PDF/QMD are content panes, Chat exists once in `utilityTabs`, and the Research Desk returns `showUtilities: ['qlabchat']`.
- [ ] Add v2 migration tests for PDF|Chat and PDF|QMD|Chat snapshots. Assert PDF/QMD order and ratios survive, Chat is removed from panes, no ungrouped Chat is healed into pane 0, and restore starts the utility hidden.
- [ ] Add v3 serialization/restore tests and malformed-layout fallback tests.
- [ ] Run the three focused files and observe current v2 pane membership fail.
- [ ] Introduce serialization version 3 with explicit `utilityTabs`; make `qlabchat` a utility singleton that `openTab`, `moveTab`, `normalize`, and `restore` cannot put into content panes.
- [ ] Update split visibility to derive only content panes. Update PDF|Chat and Research Desk arrangements to reveal Chat as a utility while preserving PDF/QMD content.
- [ ] Rerun focused tests and the complete Chatero suite.
- [ ] Commit as `refactor: separate Chat utility from content tab groups`.

## Task 4: Build the pure Chat presentation controller

**Files:**

- Create: `chrome/content/zotero/xpcom/qlab/chatPresentationController.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Create: `scripts/chatero/tests/chat-presentation.test.mjs`

- [ ] Write state-machine tests for `show`, `hide`, `toggle`, `setPinned`, `setBounds`, `snapshot`, and `restore`; include hidden-on-restart semantics, invocation metadata, and focus-return intent.
- [ ] Write bounds tests for 720×680 defaults, 480×420 minimums, 860 maximum width, 24/16 px margins, resize/display clamping, and invalid persisted bounds recentering.
- [ ] Write outside-interaction tests: Chat-owned paths remain visible; PDF/QMD paths hide only while unpinned; the one-shot invocation token ignores the opening pointer event; no handler consumes the underlying event.
- [ ] Run `NODE_OPTIONS=--openssl-legacy-provider node --test scripts/chatero/tests/chat-presentation.test.mjs` and observe the missing controller failure.
- [ ] Implement a DOM-independent controller and classifier in `chatPresentationController.js`. Persist only Pin and bounds; restore presentation as hidden.
- [ ] Register the module in production and test loaders, rerun the focused test, then the complete suite.
- [ ] Commit as `feat: add floating Chat presentation controller`.

## Task 5: Mount one window-owned Chat utility surface

**Files:**

- Modify: `chrome/content/zotero/zoteroPane.xhtml`
- Modify: `chrome/content/zotero/tabs.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qlabModule.js`
- Create: `chrome/content/zotero/xpcom/qlab/chatUtilityHost.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Create: `scss/components/_qlabChatUtility.scss`
- Modify: `scss/_zotero.scss`
- Test: `scripts/chatero/tests/qlab-tab-lifecycle.test.mjs`
- Create: `scripts/chatero/tests/chat-utility-host.test.mjs`
- Modify: `scripts/chatero/tests/qlab-visual-structure.test.mjs`

- [ ] Add tests proving selecting Chat does not change `_selectedID`, `selectedType`, Reader lookup, close/undo target, or next/previous content-tab cycling; it only toggles the utility launcher pressed state.
- [ ] Add host tests proving one resident Chat DOM/stream consumer is reused across show, hide, launcher close, and launcher reopen, including while a simulated Agent stream is running.
- [ ] Add structure/accessibility tests for a non-modal dialog, draggable header, Pin and Hide icon buttons, corner resize handle, light theme, and launcher running/completed/error badges.
- [ ] Run the focused tests and observe current native content-tab selection and remount behavior fail.
- [ ] Add one utility layer inside `#tabs-deck`. Mount the existing `qlabchat` shell once into that layer and dispose it only on window shutdown.
- [ ] Intercept Chat tab selection so the last content `_selectedID` stays intact. Treat its native tab as a launcher with `aria-pressed`, skip it during ordinary content cycling, and keep launcher close semantics independent from Chat history/Agent state.
- [ ] Wire controller state to show/hide, Pin, drag pointer capture, resize pointer capture, bounds persistence, focus return, viewport clamping, and accessible labels/tooltips.
- [ ] Add scoped SCSS and reduced-motion handling; do not alter Zotero dialogs or Reader popups.
- [ ] Rerun focused tests and the complete suite.
- [ ] Commit as `feat: present full Chat as a floating utility`.

## Task 6: Dismiss unpinned Chat consistently from embedded PDF/QMD surfaces

**Files:**

- Create: `chrome/content/zotero/xpcom/qlab/chatOutsideInteractionBridge.js`
- Modify: `chrome/content/zotero/xpcom/qlab/readerHooks.js`
- Modify: `chrome/content/zotero/qlab/qmdMonaco.html`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdSurface.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Create: `scripts/chatero/tests/chat-outside-interaction.test.mjs`
- Modify: `scripts/chatero/tests/qmd-monaco-host.test.mjs`
- Modify: `scripts/chatero/tests/qmd-workspace-shell.test.mjs`
- Modify: `scripts/chatero/tests/reader-hooks.test.mjs`

- [ ] Add adapter tests for main XUL/Visual Edit, Reader, Monaco, same-origin Quick Preview reloads, and remote Website Preview messages. Assert unpinned hides, pinned stays, and document events are not cancelled or prevented.
- [ ] Add a selection-popup invocation test proving the opening pointer is ignored once, then the next PDF interaction dismisses normally.
- [ ] Run focused tests and observe missing bridge events.
- [ ] Implement one window-scoped bridge with adapter registration/disposal. Reuse Reader lifecycle hooks, post normalized pointer activity from Monaco, attach capture listeners after each Quick Preview load, and use `qmdPreviewController.js`/`qmdPreview.js` as the remote browser parent/child bridge for Website Preview.
- [ ] Treat Chat portals, popovers, context tags, header controls, and resize handles as inside interactions.
- [ ] Rerun focused tests and the complete suite.
- [ ] Commit as `feat: coordinate Chat dismissal across research surfaces`.

## Task 7: Integrate migration, build, and manual DMG acceptance

**Files:**

- Modify if needed: `chrome/content/zotero/xpcom/qlab/chatComposerContext.js`
- Modify if needed: `chrome/content/zotero/xpcom/qlab/qmdApply.js`
- Modify: `docs/superpowers/specs/2026-08-09-floating-chat-and-visual-math-design.md`
- Create: `docs/superpowers/2026-08-09-floating-chat-and-visual-math-findings.md`
- Test: all `scripts/chatero/tests/*.test.mjs`

- [ ] Search for every remaining call that docks, selects, or assumes `qlabchat` is a content pane. Route invocations through the utility controller without changing context capture or Agent commands.
- [ ] Add an end-to-end state test: restore a legacy three-pane desk, reveal Chat, start simulated streaming, hide/unhide, close/reopen launcher, and verify one transcript with no cancellation or duplicate chunks.
- [ ] Run `NODE_OPTIONS=--openssl-legacy-provider npm run test:chatero` and require all tests to pass.
- [ ] Run `NODE_OPTIONS=--openssl-legacy-provider npm run build`.
- [ ] Run `app/scripts/dir_build -f -p m`.
- [ ] Run `NODE_OPTIONS=--openssl-legacy-provider npm run test:chatero:staged`.
- [ ] Run `git diff --check` and verify `git status --short` contains no personal research files or generated DMG/build artifacts intended to remain untracked.
- [ ] Record automated results and the ten manual DMG checks from the design in the findings document. Do not claim the macOS UI checks passed unless they were actually performed.
- [ ] Commit as `test: verify floating research workspace integration`.

## Task 8: Open Chat from a PDF or QMD Source selection with Command-K

**Files:**

- Modify: `chrome/content/zotero/xpcom/qlab/readerHooks.js`
- Modify: `chrome/content/zotero/qlab/qmdMonaco.html`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js`
- Modify: `chrome/content/zotero/xpcom/qlab/chatComposerContext.js`
- Test: `scripts/chatero/tests/reader-hooks.test.mjs`
- Test: `scripts/chatero/tests/qmd-monaco-host.test.mjs`
- Test: `scripts/chatero/tests/qmd-workspace-shell.test.mjs`
- Test: `scripts/chatero/tests/chat-composer-context.test.mjs`

- [x] Add failing behavioral tests proving PDF selection + `⌘K` and Monaco selection + `⌘K` each add the exact selection as one context tag, reveal the resident Chat utility, and focus the composer without sending a message.
- [x] Add a Monaco regression proving `⌘K` with no selection still invokes the existing inline-write action.
- [x] Run the focused files and observe the selection-routing failures before production changes.
- [x] Route Reader `⌘K` through the captured Reader selection context. Do not change `⌘⇧K` quote-to-QMD or `⌘L` pin-context behavior.
- [x] Make Monaco emit a distinct selection-to-Chat command when its selection is non-empty; retain `ai` for an empty selection. Handle the new command in the QMD workspace without rewriting the Draft.
- [x] Teach QMD composer-context capture to prefer the exact Monaco selection/range when Source is active, then reveal and focus Chat with `focus: true`.
- [x] Verify Chat opening does not auto-submit, cancel a running turn, rearrange PDF/QMD panes, or duplicate an existing selection tag.
- [x] Run focused tests and the complete Chatero suite.
- [x] Commit as `feat: open Chat from research selections`.

## Completion Gate

- [ ] Request a whole-branch code review against the approved design and resolve all material findings.
- [ ] Re-run the full verification sequence after the final fix.
- [ ] Confirm the Chat host survives hide/show and launcher close/reopen without Agent interruption.
- [ ] Confirm PDF and QMD remain the only content panes while Chat floats.
- [ ] Confirm the Definition fixture renders and edits title/body math from exact QMD ranges.
- [ ] Confirm no personal Knowledge, Draft, Literature, chat-history, or proposal data was changed.
