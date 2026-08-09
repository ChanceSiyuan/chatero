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

The integration suite combines a version-2 PDF | QMD | Chat migration test with
a production-path lifecycle test. The latter loads the real native Tabs API,
starts `runShellFreeform()` through `AgentRuntime`, closes the Chat launcher via
`Zotero_Tabs.close()`, and reopens it through the public utility API and native
`Zotero_Tabs.add()` path. Together they verify:

- PDF and QMD pane identity and order never change;
- Chat is absent from every content pane and present once in `utilityTabs`;
- the resident Chat shell mounts once;
- exactly one provider stream updates the resident production transcript;
- closing and reopening through the native Tabs API neither duplicates stream
  deltas nor cancels the live turn;
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

GREEN evidence after the correction and review fixes:

- `scripts/chatero/tests/floating-chat-integration.test.mjs`: `8/8` passed;
- final approval-policy focused set: `46/46` passed;
- affected integration set before the final focused correction: `81/81`
  passed.

## Fix Round 1

Whole-branch review identified additional lifecycle and presentation gaps. The
follow-up corrections now:

- reconcile restored Reader and Note identities after native tab restoration;
- refresh the resident Chat host when the workspace changes, while preserving
  its transcript, handlers, live turn, and lazy-mount behavior;
- serialize Pin and bounds with the owning window session rather than a global
  preference, always restoring Chat hidden;
- exempt the visible Chat utility from the inactive-tab subtree hiding rule;
- use a blue unread completion marker only while Chat is hidden, clearing it
  when Chat is shown;
- use an explicit Reader-toolbar stroke for the inline quote SVG instead of
  relying on `currentColor` inheritance through an `<img>`;
- exercise a real production Agent stream across actual native Chat launcher
  close and reopen operations.

Focused follow-up verification passed 61 tests across Chat utility, native tab
lifecycle, workspace refresh, Reader hooks, restored identities, tab groups,
and split layout. The full build evidence below was rerun after these fixes.

The late restore audit at `c0a43a771` also confirmed that unavailable Reader
and Note tabs must not survive restoration. The reconciler now drops those
entries, removes their pane and group references, and chooses a valid active
fallback. The complete suite passed `418/418` after that correction.

## Fix Round 2

A final review of `c0a43a771` found that refreshing the resident Chat utility
into another QLab workspace preserved the previous workspace's cached approval
policy. Commit `961f8952b` now clears and reloads the policy whenever the root
changes. The asynchronous loader is guarded by both the current mount
generation and root identity, so a late result from the old workspace cannot
replace the new policy. The existing transcript and live Agent turn remain in
place.

The regression first failed because the new workspace policy was never loaded
(`loadedRoots` was empty). It then passed with the production correction. The
focused Chat/Agent set passed `45/45`, and the complete Chatero suite passed
`419/419` at that point.

## Fix Round 3

The final re-review then exercised an Agent turn that started in workspace A,
switched the resident utility to workspace B, and delivered an approval event
after the switch. Although future turns correctly used B's policy, the
in-flight turn could also read B's mutable cache. The RED regression therefore
observed no reload of A's policy and would have allowed an operation that A
denied.

Commit `e1d394a1a` captures the immutable workspace root at turn start and
passes it through stream approval evaluation. A delayed approval now reads A's
policy locally even while the resident host displays B; it never replaces B's
cache. Draft review and Research Action streams use the same root-bound path.
The final focused Chat/Agent set passed `46/46`, and the complete Chatero suite
passed `420/420`.

## Automated Verification

All commands below ran from the repository root after the integration
correction.

| Check | Result | Evidence |
|---|---|---|
| Full Chatero tests | PASS | `NODE_OPTIONS=--openssl-legacy-provider npm run test:chatero` — 420 passed, 0 failed, exit 0 |
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
7. **NOT RUN** — Restart Chatero and verify Chat starts hidden while that
   window's Pin setting and bounds are remembered.
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
