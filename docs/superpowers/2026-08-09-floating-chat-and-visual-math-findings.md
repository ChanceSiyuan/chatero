# Floating Chat and Visual Math — Verification Findings

**Date:** 2026-08-09

**Branch:** `feat/cursor-qmd-workspace`

**Scope:** Automated integration, build, and staged macOS bundle verification for
the approved floating Chat, Visual Edit mathematics, and Reader quote-action
design. The staged application was not launched in this task, so no graphical
DMG acceptance item is reported as passed.

## Integration Audit

The repository-wide `qlabchat` presentation audit found and corrected four
legacy content-pane assumptions:

1. Context and Draft actions used `ensureChatPaneVisible()` to rearrange a PDF
   and QMD or dock Chat into a pane. The compatibility-named helper now reveals
   the window-owned utility directly and leaves the content grid unchanged.
2. Composer focus selected the native Chat launcher as though it were content.
   It now uses the utility presentation API and queries only the resident
   utility host.
3. Opening the QMD pane treated the mere presence of a Chat launcher as a
   request for Research Desk. It now arranges only PDF and QMD; existing Chat
   visibility is unchanged.
4. Provider switching remounted `qlabchat` in the old tab container. It now
   updates the provider control and availability state on the one resident
   utility host.

Closing and reopening the native Chat launcher also re-registers the singleton
under `utilityTabs` without mounting another transcript or stream consumer.
Intentional Reader layout commands remain: PDF + floating Chat, PDF | QMD, and
PDF | QMD + floating Chat. Those are explicit user arrangements, not incidental
context or focus calls.

## Test-Driven Integration Evidence

The new end-to-end state test starts from a version-2 PDF | QMD | Chat session,
migrates it to two content panes plus one hidden utility, reveals Chat, simulates
a running stream, hides and reveals it, closes and reopens the launcher, and
then verifies:

- PDF and QMD pane identity and order never change;
- Chat is absent from every content pane and present once in `utilityTabs`;
- the resident Chat shell mounts once;
- exactly one simulated stream consumer receives five chunks in order;
- no turn cancellation occurs before window shutdown;
- window shutdown performs the single cancellation;
- provider refresh does not remount the transcript;
- focusing the composer reveals the utility without selecting Chat as content;
- opening QMD does not reveal a hidden Chat utility.

RED evidence before the integration correction:

- focused integration file: `0/3` passed initially;
- failures showed one unwanted Research Desk rearrangement, QMD routing to
  Research Desk instead of PDF | QMD, and no resident provider-refresh API;
- the focused composer test separately failed because it selected `qlabchat`
  instead of revealing the utility.

GREEN evidence after the correction:

- `scripts/chatero/tests/floating-chat-integration.test.mjs`: `4/4` passed;
- affected integration set: `81/81` passed.

## Automated Verification

All commands below ran from `/Users/chance/chatero` after the integration
correction.

| Check | Result | Evidence |
|---|---|---|
| Full Chatero tests | PASS | `NODE_OPTIONS=--openssl-legacy-provider npm run test:chatero` — 406 passed, 0 failed, exit 0 |
| Application build | PASS | `NODE_OPTIONS=--openssl-legacy-provider npm run build` — JavaScript, Sass, Reader, document worker, and note editor build completed, exit 0 |
| macOS directory staging | PASS | `app/scripts/dir_build -f -p m` — `Chatero.app` built, ad-hoc signed, valid on disk, and satisfies its Designated Requirement, exit 0 |
| Staged bundle verification | PASS | `NODE_OPTIONS=--openssl-legacy-provider npm run test:chatero:staged` — staged `Chatero.app` deep validation completed, exit 0 |
| Patch whitespace | PASS | `git diff --check` — no findings, exit 0 |
| Personal-data boundary | PASS | status contained only implementation/test/documentation paths; no `knowledge/`, `drafts/`, `literature/`, chat-history, or proposal path was modified |
| Generated-artifact boundary | PASS | staged/build products are ignored generated outputs and are not included in the source commit |

The automated suite includes the exact Definition title/body fixture, LF and
CRLF exact source ranges, KaTeX title/body rendering and editing, static XUL
stylesheet structure, legacy layout migration, floating utility lifecycle,
Reader quote-icon geometry, and embedded-surface dismissal. These tests do not
substitute for inspecting the packaged Gecko UI.

## Manual DMG Acceptance

The following checks require launching the built application and interacting
with real Zotero Reader, Monaco, Quarto, and Gecko documents. They were not run
in this task.

1. **NOT RUN** — Open a PDF and QMD Draft side by side.
2. **NOT RUN** — Open Chat from the native tab and verify PDF/QMD widths do not
   change.
3. **NOT RUN** — Drag and resize Chat, hide it, reopen it, and verify bounds are
   restored.
4. **NOT RUN** — Leave Chat unpinned, click PDF, and verify it hides.
5. **NOT RUN** — Pin Chat, click and scroll both PDF and QMD, and verify it stays
   visible.
6. **NOT RUN** — Start an Agent turn, hide Chat, continue reading/editing, then
   reopen and verify the same turn and transcript remain.
7. **NOT RUN** — Restart Chatero and verify Chat starts hidden while Pin
   preference and bounds are remembered.
8. **NOT RUN** — Select PDF text and verify the quote icon is recognizable and
   inserts the same QMD quote/deep link.
9. **NOT RUN** — Open `drafts/local_alg.qmd` in Visual Edit and verify all
   formulas, including `$r$` in the Definition title, render correctly.
10. **NOT RUN** — Click title and body formulas, edit LaTeX, leave the field,
    and verify the exact QMD source is saved and rerendered.

## Remaining Manual Risk

- Real Gecko computed style must confirm that packaged KaTeX has the expected
  font and layout rather than only the tested source/style sentinel.
- The remote Website Preview message-manager adapter is behaviorally tested,
  but its packaged `browser.messageManager` availability still requires the
  real application check.
- Dragging, resizing, focus return, Pin, and Reader popup geometry require
  direct visual inspection at normal and constrained window sizes.

No claim of packaged UI acceptance is made until the ten checks above are run.
