# Single-View QMD Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the side-by-side Source/Preview workspace with a light single surface toggled by the eye action, make its navigation responsive beside PDFs, and make Quarto Preview reliable from a Finder-launched Chatero app.

**Architecture:** `qmdWorkspaceShell.js` owns a persisted `source | preview` surface state and renders both long-lived surfaces into one grid cell, hiding only the inactive surface. `_qlabQmdWorkspace.scss` owns the compact overlay and one-row toolbar. `qmdPreview.js` resolves Quarto before spawning and races readiness against an explicit launch-failure channel so the controller receives the real error.

**Tech Stack:** Zotero/Gecko JavaScript, Monaco Editor, Quarto CLI, SCSS, Node `node:test`, macOS DMG tooling.

## Global Constraints

- Human writes remain limited to QMD files under `drafts/`.
- AI output remains a private proposal until Keep.
- Quarto remains loopback-only and always uses `--no-execute`.
- `knowledge/`, `literature/`, Zotero profiles, and personal QLab content must never be packaged or overwritten.
- Source, Preview, AI proposal, PDF/Chat/QMD tabs, and Zotero native functionality retain their current data contracts.

---

### Task 1: Single Source/Preview Surface

**Files:**
- Modify: `scripts/chatero/tests/qmd-workspace-shell.test.mjs`
- Modify: `scripts/chatero/tests/qmd-workspace-accessibility.test.mjs`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qlabModule.js`

**Interfaces:**
- Produces: `createQmdWorkspaceController({ surface })` with `toggleSurface()`, `showSurface(name)`, and `snapshot().surface`.
- Produces: markup where `.qlab-qmd-editor-pane` and `.qlab-qmd-preview-pane` share `.qlab-qmd-primary-surface` and no Source/Preview splitter exists.
- Preserves: `workspace.showPreview(version)` for Original/Proposed selection and `workspace.showProposalDiff()` for AI review.

- [ ] **Step 1: Write failing single-surface tests**

Assert that rendered markup has one `data-qlab-primary-surface`, contains Source and Preview inside it, contains no separator, and exposes the eye button with `aria-pressed="false"`. Assert controller toggles `source → preview → source` and maps old `previewVisible: false` to Source.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/qmd-workspace-accessibility.test.mjs`

Expected: failures for the missing primary surface and `toggleSurface` behavior.

- [ ] **Step 3: Implement the minimal state and markup change**

Replace the editor/splitter/preview grid with:

```html
<main data-qlab-primary-surface>
  <section class="qlab-qmd-editor-pane is-active">…</section>
  <section class="qlab-qmd-preview-pane" hidden>…</section>
</main>
```

Have `applyLayout()` set `data-surface`, `hidden`, and eye `aria-pressed`. `showProposalDiff()` selects Source before opening Monaco diff. Toggling to Preview calls `activePreview.setVisible(true)` without recreating its process.

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `node --test scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/qmd-workspace-accessibility.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/qmd-workspace-accessibility.test.mjs chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js chrome/content/zotero/xpcom/qlab/qlabModule.js
git commit -m "feat: switch QMD source and preview in one surface"
```

### Task 2: Light Editor and Compact Responsive Chrome

**Files:**
- Modify: `scripts/chatero/tests/qmd-monaco-bridge.test.mjs`
- Modify: `scripts/chatero/tests/qmd-monaco-host.test.mjs`
- Modify: `scripts/chatero/tests/qmd-workspace-accessibility.test.mjs`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdMonacoBridge.js`
- Modify: `chrome/content/zotero/qlab/qmdMonaco.html`
- Modify: `scss/components/_qlabQmdWorkspace.scss`

**Interfaces:**
- Produces: `qmdMonacoOptions()` defaulting to Monaco `vs`.
- Produces: icon button labels that are visually hidden but readable by assistive technology.
- Produces: fixed Explorer at wide widths and a QMD-contained overlay drawer below the compact breakpoint.

- [ ] **Step 1: Write failing theme and layout tests**

Assert default Monaco options use `vs`, the iframe declares `color-scheme: light`, workspace CSS contains a visually hidden `.sr-only` rule, toolbar actions cannot shrink/overflow labels, and the compact Explorer uses `position: absolute` inside `.qlab-qmd-workspace-main`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test scripts/chatero/tests/qmd-monaco-bridge.test.mjs scripts/chatero/tests/qmd-monaco-host.test.mjs scripts/chatero/tests/qmd-workspace-accessibility.test.mjs`

Expected: failures for dark defaults and missing responsive rules.

- [ ] **Step 3: Implement light Monaco and responsive CSS**

Set both boot-time Monaco options and parent payload options to `vs`. Give Source and Preview the same white/light surface. Hide `.sr-only` with the standard one-pixel clipping pattern. Keep the toolbar on one row, make its path flex/truncate, and make Explorer an absolute QMD-local drawer with a bounded width at compact sizes.

- [ ] **Step 4: Run focused tests and the Sass build**

Run: `node --test scripts/chatero/tests/qmd-monaco-bridge.test.mjs scripts/chatero/tests/qmd-monaco-host.test.mjs scripts/chatero/tests/qmd-workspace-accessibility.test.mjs`

Run: `npm run build`

- [ ] **Step 5: Commit**

```bash
git add scripts/chatero/tests/qmd-monaco-bridge.test.mjs scripts/chatero/tests/qmd-monaco-host.test.mjs scripts/chatero/tests/qmd-workspace-accessibility.test.mjs chrome/content/zotero/xpcom/qlab/qmdMonacoBridge.js chrome/content/zotero/qlab/qmdMonaco.html scss/components/_qlabQmdWorkspace.scss
git commit -m "feat: make QMD workspace light and compact"
```

### Task 3: Reliable Finder-Launched Quarto Preview

**Files:**
- Modify: `scripts/chatero/tests/qmd-math-preview.test.mjs`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdPreview.js`

**Interfaces:**
- Produces: `discoverQuartoExecutable(host): Promise<string | null>`.
- Consumes discovery host methods `pathSearch(name)` and `exists(path)`.
- Produces: `startQmdQuartoPreview()` that rejects immediately with spawn/exit diagnostics while retaining readiness polling for a live server.

- [ ] **Step 1: Write failing discovery and failure-propagation tests**

Cover `/usr/local/bin/quarto`, `/opt/homebrew/bin/quarto`, `/Applications/quarto/bin/quarto`, a direct PATH result, a runner throw, and an early non-zero exit whose stderr is included in the rejection.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test scripts/chatero/tests/qmd-math-preview.test.mjs`

Expected: failures because discovery and launch-failure propagation do not exist.

- [ ] **Step 3: Implement discovery and a readiness/failure race**

Resolve Quarto to an absolute executable before starting the runner. Record bounded stdout/stderr, reject the launch signal on runner exceptions or an early non-zero exit, and race that signal against each readiness probe. Remove failed sessions immediately so Retry starts cleanly.

- [ ] **Step 4: Verify the focused Preview tests**

Run: `node --test scripts/chatero/tests/qmd-math-preview.test.mjs scripts/chatero/tests/qmd-preview-controller.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add scripts/chatero/tests/qmd-math-preview.test.mjs chrome/content/zotero/xpcom/qlab/qmdPreview.js
git commit -m "fix: launch Quarto reliably from Chatero"
```

### Task 4: Regression Verification and Personal DMG

**Files:**
- Modify: `docs/chatero/qmd-workspace-review.md`
- Generated, not committed: `app/dist/Chatero-11.0.SOURCE.dmg`

**Interfaces:**
- Consumes: completed single-surface workspace and Quarto launch behavior.
- Produces: an installation artifact and updated manual review instructions.

- [ ] **Step 1: Update the manual review checklist**

Replace simultaneous Source/Preview instructions with the eye toggle, compact Explorer drawer, light editor, actionable Preview failure, and Retry behavior.

- [ ] **Step 2: Run focused and full verification**

Run: `node --test scripts/chatero/tests/qmd-*.test.mjs scripts/chatero/tests/qlab-visual-structure.test.mjs`

Run: `NODE_OPTIONS=--openssl-legacy-provider npm run test:chatero`

Run: `npm run build`

- [ ] **Step 3: Commit the review guide**

```bash
git add docs/chatero/qmd-workspace-review.md
git commit -m "docs: update single-view QMD review steps"
```

- [ ] **Step 4: Package and verify**

Run: `npm run package:chatero`

Run: `npm run verify:chatero-bundle`

Run the checksum from `app/dist/`, then mount the DMG read-only and verify it contains no personal `.qmd`, `.bib`, `.pdf`, `knowledge/`, `drafts/`, or `literature/` data.
