# Chatero ↔ QLab XPI Parity Checklist

- **Date:** 2026-08-07
- **XPI baseline:** `quarto-lab/integrations/zotero` v0.12.0 (frozen)
- **XPI tests:** ~1219 Vitest + visual/native suites
- **Chatero target:** `chrome/content/zotero/xpcom/qlab/` + shell tabs

A feature is **ported** only when behavior and tests exist in Chatero.
Priority: A → D first (daily read + reading notes), then E → G (Phase 4).

Legend: `P0` required for daily path · `P1` Phase 4 RC · `P2` polish

---

## A. Workspace selection + path sandbox — P0 (Phase 3)

### Behaviors
- [x] Valid root requires `AGENTS.md`, `qlab`, `literature/`, `drafts/`, `knowledge/`
- [x] Canonicalize with `realPath` before persist
- [x] `empty` / content-only `partial` may Initialize; unrelated non-empty is `incompatible`
- [ ] Initialize fills missing skeleton only; never overwrites user files
- [ ] Private repo UUID under `.git/qlab/repository-id` (no symlink escape)
- [x] Agent writable roots default to `drafts|literature|work`; not `knowledge/`
- [x] Editable QMD paths only under `drafts/**` / `knowledge/**`; reject `..`
- [x] Stale/missing workspace never blocks Zotero core startup
- [x] Tools → Choose QLab Workspace… persists `extensions.zotero.qlab.root`

### XPI sources
`qlab-workspace.ts`, `local-repository-target-resolver.ts`, `repository-target.ts`,
`repository-target-controller.ts`, `editor-tree.ts`, `settings.ts`, `qlab-commands.ts`

### XPI tests
`qlab-workspace.test.ts`, `local-repository-target-resolver.test.ts`,
`repository-target.test.ts`, `repository-target-controller.test.ts`,
`editor-tree.test.ts`, `qlab-commands.test.ts`, `starter-template.test.mjs`

### Chatero targets
`xpcom/qlab/qlabWorkspace.js`, `settings.js`, `repositoryTarget.js`,
`localRepositoryTargetResolver.js`, `repositoryTargetController.js`

### Chatero tests
`scripts/chatero/tests/qlab-workspace.test.mjs`

---

## B. Reader context + Chat + Codex helper — P0 (Phase 3)

### Behaviors
- [x] Reader context store: paper / page / selection chips → prompt block
- [x] Reader toolbar Chat / QMD + selection Ask (native tabs, not nested Workbench)
- [x] Chat shell tab retains payload slot for paper context (`primaryItemID`)
- [x] Chat composer + Research Actions prepend `<reader_context>` / composer tags
- [x] Cursor-like ⌘L: PDF selection/page/paper or live QMD → composer tag
- [x] Composer tags clickable to reveal source; × removes
- [x] AgentRuntime + Provider registry (UI never calls HTTP/API keys)
- [x] Chat / Tools UI to switch `codex-cli` / `openai-compat` / `prove-harness`
- [x] Local `codex-cli` via `codex exec --json` + Subprocess runner (Phase 3B)
- [ ] Full Codex app-server / NativeBridge parity (optional upgrade path)
- [ ] Native helper spawn for PTY/terminal; long tasks survive tab hide/move
- [ ] Region + page capture attachments (bounded; page text still stub)
- [x] Full Chat is native tab (`qlabchat`); float panel deferred
- [ ] Remote Chat withholds local Zotero paths from prompts
- [x] Shell UI mounts without blocking Zotero core

### XPI sources
`reader-context.ts`, `codex-service.ts`, `codex-app-server.ts`, `agent-client.ts`,
`sidebar.ts`, `float-panel.ts`, `region-capture.ts`, `native-bridge.ts`,
`workbench-*.ts`

### XPI tests
`reader-context.test.ts`, `codex-service.test.ts`, `codex-app-server.test.ts`,
`sidebar.test.ts`, `float-panel.test.ts`, `region-capture.test.ts`,
`plugin-state.test.ts` (chat/workbench subset)

### Chatero targets
`xpcom/qlab/readerContext.js`, `readerHooks.js`, `codexExecProvider.js`,
`agentProviders.js`, `qlabModule.js` (chat shell)

### Chatero tests
`scripts/chatero/tests/reader-context.test.mjs`, `codex-cli-provider.test.mjs`,
`agent-runtime.test.mjs`

---

## C. QMD Draft + Visual Edit + Keep — P0 (Phase 3)

### Behaviors
- [x] QMD shell tab registered; drafts path messaging when workspace ready
- [x] Three switchable surfaces: **Preview** (visual) · **Website** (HTML) · **Source** (QMD)
- [x] Shared buffer across modes (Cursor-like; switch does not drop edits)
- [x] Preview: source-driven block cards; click → edit → write back to QMD
- [x] Website: soft HTML always; optional Quarto live preview button
- [x] Draft list / read / save with hash revision CAS
- [ ] Richer Visual Edit (LaTeX/theorem toolbars, KaTeX) — incremental
- [x] CAS / revision checks on save; no silent overwrite
- [x] Agent edits in one private working copy (`work/qlab-zotero/draft-changes/…`)
- [x] **Keep** is the only AI→Draft promotion (`QmdDraftIO.keepChange` + `DraftWorkingCopy`)
- [x] Unknown syntax retained as raw blocks (lossless Preview)
- [x] **Apply**: Chat reply / PDF selection → live buffer as a human edit (still needs Save)
- [x] Inserts snap to block boundaries; never split a fence, math block, or frontmatter
- [x] PDF quotes carry a `chatero://open-pdf/...?page=N` link back to the page
- [x] Multiple pending regions per shell; per-hunk Accept / Reject / Reject all
- [x] Reject re-anchors by content and refuses ambiguous matches
- [x] Pending markers clear on Save and on Draft reload
- [x] ⌘K writes a passage at the anchor (`ask` mode → pending region, never writes the file)

### XPI sources
`qmd-workspace.ts`, `qmd-visual-editor.ts`, `qmd-source-model.ts`,
`qmd-render.ts`, `qmd-index.ts`, `external-editor.ts`

### XPI tests
`qmd-workspace.test.ts`, `qmd-visual-editor.test.ts`, `qmd-source-model.test.ts`,
`qmd-render.test.ts`, `external-editor.test.ts`, `test/visual/draft-parity.test.mjs`

### Chatero targets
`xpcom/qlab/qmdDraftIO.js`, `qmdSourceModel.js`, `qmdSurface.js`,
`qmdMarkdownLite.js`, `qmdPreview.js`, `draftWorkingCopy.js`, `qlabModule.js`

### Chatero tests
`scripts/chatero/tests/qmd-draft-io.test.mjs`, `qmd-surface.test.mjs`

---

## D. Research Actions → skills — P0 (Phase 3)

### Behaviors
- [x] Catalogue: Summarize / Evidence QA / Compare Papers / Analyze Figure / Write Draft
- [x] Filter by object kind (`pdf|note|collection|draft`)
- [x] Bind to repository skills only; no second prompt system
- [ ] Analysis actions force host read-only sandbox
- [x] Write Draft routes PDF → `capture-chat-draft`, else `expand-notes`
- [x] Prompt is skill binding + single `<research_object>` envelope
- [x] Shell tab Action buttons build prompts (Codex send pending 3B)

### XPI sources
`research-actions.ts`, `plugin.ts` (`runResearchAction`), `sidebar.ts`, `codex-service.ts`

### XPI tests
`research-actions.test.ts`, `plugin-research-actions.test.ts`,
`codex-service.test.ts` (read-only sandbox cases)

### Chatero targets
`xpcom/qlab/researchActions.js`

### Chatero tests
`scripts/chatero/tests/research-actions.test.mjs`

---

## E. Note ↔ QMD bridge — P1 (Phase 4)

### Behaviors
- [ ] Note → QMD inert import; QMD remains writing authority
- [ ] QMD → Note reviewed mirror with revision/content conflict checks
- [ ] Source marker avoids duplicate Notes
- [ ] Annotation proposals: geometry from Reader only; batch apply/rollback

### XPI sources / tests
`note-draft-bridge.ts`, `noting.ts`, `annotation-proposals.ts`,
`note-draft-bridge.test.ts`, `annotation-proposals.test.ts`, `zotero-mutations.test.ts`

### Chatero targets
`xpcom/qlab/noteDraftBridge.js`, `annotationProposals.js`

---

## F. Knowledge preview / promotion — P1 (Phase 4)

### Behaviors
- [ ] Add to Knowledge starts non-mutating Agent review
- [ ] Explicit approve + `knowledge-check` before trusted write
- [ ] Draft preview vs Knowledge preview routing
- [ ] Autoresearch output never silently enters `knowledge/`

### XPI sources / tests
`qlab-commands.ts`, `qmd-workspace.ts`, `research-loop-site.ts`,
`editor-tree.test.ts`, `qlab-commands.test.ts`, `qmd-workspace.test.ts`

### Chatero targets
`xpcom/qlab/qlabCommands.js`, `researchLoopSite.js`

---

## G. Literature import / Site / Terminal / remote — P1 optional (Phase 4)

SSH / remote Codex is **optional and deferred**. Daily path uses local
providers (`codex-cli`, `openai-compat`, `prove-harness`). Remote work is the
`remote-execution` AgentProvider slot, not a core product requirement.

### Behaviors
- [ ] Import/refresh nested QLab Literature collections (primary PDF + LaTeX entry)
- [ ] Main Site on loopback; Initialize empty/partial roots
- [ ] Terminal drawer: real local shell at workspace cwd
- [x] SSH demoted: `Phase4.connectSSH()` → `deferred-optional` / `remote-execution`
- [x] AgentProvider registry with local core + optional remote slot
- [ ] Concrete remote backend (SSH helper or personal sidecar) when needed

### XPI sources / tests
`zotero-library-import.ts`, `reviewed-library-import.ts`, `research-loop-site.ts`,
`terminal-panel.ts`, `ssh-target-transport.ts`, `remote-helper-*.ts` + matching tests

### Chatero targets
`xpcom/qlab/agentProviders.js` (`remote-execution`), `agentRuntime.js`,
`zoteroLibraryImport.js`, `researchLoopSite.js`, `terminalPanel.js` (later)

### Chatero tests
`scripts/chatero/tests/agent-runtime.test.mjs`

---

## Phase 2 cross-cutting (before A–G UI)

### Behaviors
- [x] Pure ordered-pane tab state (left/center/right, focus, divider positions)
- [x] Idempotent arrange PDF\|Chat and PDF\|Editor (API + Tools menu)
- [x] Research Desk: PDF \| QMD \| Chat on screen at once (⌘⇧D + Tools menu)
- [x] Arranging fewer panes folds surplus panes in; never closes tabs
- [x] No nested Workbench tab bar (native shell tab types)
- [x] Session serialize/restore groups field (`qlabGroups`, v2 with v1 migration)
- [x] Shell tab types registered; QLab disable preference exists
- [x] Up to three visible chrome hosts (CSS grid) without Reader reload
- [x] ⌘L docks Chat instead of collapsing the pane the user is reading in

### XPI sources / tests
`workbench-layout.ts`, `workbench-shell.ts`, `workbench-layout` / `workbench-shell` tests

### Chatero targets
`xpcom/qlab/tabGroups.js`, `arrangement.js`, `qlabModule.js`, tabs hooks in `tabs.js`

### Chatero tests
`scripts/chatero/tests/tab-groups.test.mjs`, `arrangement.test.mjs`
