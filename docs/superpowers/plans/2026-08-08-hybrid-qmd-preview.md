# XPI-Parity Three-Surface QMD Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
> Every behavior change follows red-green-refactor. Do not touch personal QLab
> content.

**Goal:** Internalize the former Research Loop XPI's complete Draft editing
workflow in Chatero and provide one eye control that cycles Visual Edit,
Website Preview, and Monaco Source without losing state or restarting Quarto.

**Architecture:** One `QmdDraftSession` owns the authoritative human-edit
buffer and revision. A resident `QmdVisualEditor`, resident Monaco bridge, and
resident native Website Preview consume that session. The surface state and
the Original/AI version target are orthogonal. `qmdPreview.js` owns the
selected-file Quarto process; `qmdPreviewController.js` owns quick, exact, and
last-good Website state. The old XPI is the minimum toolbar and Visual Edit
feature baseline.

**Tech Stack:** Zotero/Gecko JavaScript, XUL `<browser>`, Monaco, safe
source-driven QMD rendering with KaTeX, Quarto CLI 1.8.x, SCSS, Node
`node:test`, macOS Chatero packaging.

## Global Constraints

- Human edits remain limited to QMD files under `drafts/` and save through the
  revision-guarded Draft session.
- AI output remains a private proposal until Keep.
- Surface mode (`visual | website | source`) and version target
  (`original | proposed`) are independent state axes.
- New Draft tabs default to `visual`; restored `preview` migrates to `website`.
- Surface switches never recreate the Draft session, Monaco, Visual Editor, or
  active Quarto session.
- Quarto remains loopback-only and always uses `--no-execute`.
- `knowledge/`, `literature/`, Zotero profiles, chat history, credentials, and
  personal QLab content must never be packaged, overwritten, or committed.

---

### Task 1: Route Quarto to the Selected QMD Page — COMPLETE

**Commit:** `d31237ab3 fix: open the selected QMD preview page`

- [x] Added literal route tests for root, nested, and index QMD paths.
- [x] Added `qmdQuartoPagePath` and exact-page readiness probing.
- [x] Returned the selected HTML URL rather than the Draft index.

### Task 2: Publish Quick Preview Before Quarto Is Ready — COMPLETE

**Commit:** `5f5b87551 feat: show quick QMD preview while Quarto renders`

- [x] Added deferred-render and hidden-start tests.
- [x] Published safe quick HTML before exact Quarto readiness.
- [x] Retained latest fallback and last-good exact URL on failure.

### Task 3: Replace the Exact iframe with a Native Zotero Browser — COMPLETE

**Commit:** `bd2ed5b4d feat: host exact QMD previews in a native browser`

- [x] Added native browser adapter behavior tests.
- [x] Created a remote XUL `<browser>` for exact loopback content.
- [x] Kept quick source rendering in a sandboxed local iframe.
- [x] Added safe URL validation, error fallback, and disposal.

### Task 4: Define and Persist the Three-Surface State Machine

**Files:**
- Modify: `scripts/chatero/tests/qmd-workspace-shell.test.mjs`
- Modify: `scripts/chatero/tests/qmd-workspace-accessibility.test.mjs`
- Modify: `scripts/chatero/tests/qmd-surface.test.mjs`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdSurface.js`

**Interfaces:**
- `normalizeQmdWorkspaceSurface(value): visual | website | source`
- `nextQmdWorkspaceSurface(value)` cycles
  `visual -> website -> source -> visual`.
- `qmdSurfaceActionModel(value)` returns current/next labels and accessible
  tooltip text.
- `createQmdWorkspaceController({ surface })` defaults to `visual`, migrates
  old `preview` to `website`, and serializes the normalized value.

- [ ] Write literal cycle/default/migration/restoration tests.
- [ ] Assert the shell renders all three resident panes and the eye action is
  not a binary `aria-pressed` switch.
- [ ] Run focused tests and verify RED.
- [ ] Implement the pure state helpers and controller behavior.
- [ ] Update shell layout so all three surfaces remain mounted and only the
  active one is hidden.
- [ ] Keep `versionTarget` independent of mode; the Original/Proposed control
  may not be repurposed as the eye control.
- [ ] Run focused tests and commit.

### Task 5: Port the XPI Visual Editor Source Model and Save Engine

**Files:**
- Modify: `chrome/content/zotero/xpcom/qlab/qmdSourceModel.js`
- Create: `chrome/content/zotero/xpcom/qlab/qmdVisualEditor.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Create: `scripts/chatero/tests/qmd-visual-editor.test.mjs`
- Modify: `scripts/chatero/tests/qmd-surface.test.mjs`

**Interfaces:**
- `qmdMathSpans(source)` returns exact inline/display LaTeX ranges.
- `createQmdVisualEditor(document, options)` retains the XPI contracts:
  `setDocument`, `snapshot`, `isEditing`, `finishActiveEdit`,
  `insertFormalBlock`, and `dispose`.
- `options.save(source, expectedRevision, generation)` is the only persistence
  path and returns the new source/revision.

- [ ] Port XPI behavior tests for theorem/lemma/definition/proof cards,
  formula-only editing, complete-card source editing, idle autosave, unique
  formal anchors, and stale-generation suppression.
- [ ] Add pure math-range and formal-template tests where full DOM behavior is
  not required.
- [ ] Run focused tests and verify RED.
- [ ] Port the mature XPI implementation into Gecko JavaScript, reusing
  Chatero's `visualQmdBlocks`, `renderQmdBlockHTML`, and KaTeX output.
- [ ] Ensure rendered formulas stop card click propagation and only replace
  their exact LaTeX range.
- [ ] Run focused tests and commit.

### Task 6: Wire Visual Edit to the Shared Draft Session

**Files:**
- Modify: `scripts/chatero/tests/qmd-workspace-shell.test.mjs`
- Modify: `scripts/chatero/tests/qmd-draft-session.test.mjs`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js`
- Modify: `scss/components/_qlabQmdWorkspace.scss`

**Contracts:**
- Opening a Draft loads one snapshot into both Monaco and Visual Edit.
- A visual save calls the active Draft session, then `saveNow`, and returns the
  session's current saved source and revision.
- Leaving Visual Edit flushes an active field before changing surface.
- Programmatic session updates refresh the inactive views without recreating
  them.
- Hidden Website state remains warm; mode switches do not stop/start Quarto.

- [ ] Write identity/state-retention tests using recording Monaco, Visual
  Editor, Preview, and Draft-session fakes.
- [ ] Write a conflict test proving a visual save cannot overwrite a newer
  disk revision.
- [ ] Run focused tests and verify RED.
- [ ] Mount Visual Edit as a third resident surface and connect it to the
  Draft session.
- [ ] Make surface changes await `finishActiveEdit` when needed.
- [ ] Style cards, formula editors, and source editors to match the light
  native Chatero/Quarto workspace rather than a black code theme.
- [ ] Run focused tests and Sass build; commit.

### Task 7: Preserve the Former XPI Toolbar Capabilities

**Files:**
- Modify: `scripts/chatero/tests/qmd-workspace-accessibility.test.mjs`
- Create or modify: `scripts/chatero/tests/qmd-toolbar-parity.test.mjs`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qlabModule.js`
- Modify: `scss/components/_qlabQmdWorkspace.scss`

**Required independent actions:**
- compliance check/status;
- Add to Knowledge approval-publish workflow;
- Complete TODOs via the existing Research Loop skill/action path;
- Original/AI proposed version comparison;
- Keep proposal;
- Definition/Lemma/Theorem/Proof insertion in Visual Edit;
- open in configured external editor;
- refresh active surface.

- [ ] Write a capability inventory test based on stable action identifiers,
  not icon glyphs.
- [ ] Assert every icon-only action has an English accessible label and title.
- [ ] Assert formal-block tools are visible only in Visual Edit and proposal
  actions follow proposal availability without being conflated with mode.
- [ ] Run focused tests and verify RED.
- [ ] Wire existing Chatero action services; port only missing XPI adapters and
  do not create a second prompt system.
- [ ] Keep Explorer/save/Reject only when they add distinct behavior.
- [ ] Run focused tests and commit.

### Task 8: Integrate Truthful Persistence and Website Status

**Files:**
- Modify: `scripts/chatero/tests/qmd-workspace-shell.test.mjs`
- Modify: `scripts/chatero/tests/qmd-workspace-accessibility.test.mjs`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js`

**Interfaces:**
- `qmdPreviewPresentation(state)` returns `empty | quick | exact` presentation.
- `qmdWorkspaceStatus({ persistence, preview, surface })` gives save conflicts
  and errors priority while keeping Website progress truthful.

- [x] Wrote initial quick/exact/last-good presentation tests.
- [x] Wrote save-state precedence tests.
- [x] Added the first production status combiner and removed the unconditional
  post-start `Saved` overwrite.
- [ ] Adapt the partially implemented status code to `website` rather than the
  retired binary `preview` surface.
- [ ] Keep Visual Edit/Monaco persistence messages independent from hidden
  Website progress; show Website progress when Website is active.
- [ ] Run all QMD tests and commit the integrated status model.

### Task 9: Harden Active-Process Lifecycle and Rapid File Switching

**Files:**
- Modify: `scripts/chatero/tests/qmd-math-preview.test.mjs`
- Modify: `scripts/chatero/tests/qmd-preview-controller.test.mjs`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdPreview.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdPreviewController.js`

- [ ] Test same-document reuse, dead-cache restart, late kill registration,
  and stale-generation cancellation.
- [ ] Run focused tests and verify RED.
- [ ] Implement the minimal lifecycle hardening.
- [ ] Run focused and full Chatero tests; commit.

### Task 10: Live Verification, Review Guide, and Private DMG

**Files:**
- Modify: `docs/chatero/qmd-workspace-review.md`
- Generated, not committed: `app/dist/Chatero-11.0.SOURCE.dmg`

- [ ] Verify a temporary one-file QLab fixture without touching personal data.
- [ ] Manually verify the exact three-mode cycle, restored mode, Visual Edit
  math/card behavior, toolbar actions, last-good fallback, Explorer, AI diff,
  Keep, Reject, PDF tabs, and Zotero core behavior.
- [ ] Run all focused QMD tests, full Chatero tests, Sass, and build.
- [ ] Update and commit the review guide.
- [ ] Package and verify the DMG, scan it for private QLab content, and report
  its checksum without committing the artifact.
