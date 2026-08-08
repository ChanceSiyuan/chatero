# Cursor-Style QMD Research Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Chatero's QMD textarea/card editor with a Cursor-style Draft workspace containing a QLab Explorer, Monaco source and diff editors, live Quarto Preview, safe delayed auto-save, and persistent AI proposal review.

**Architecture:** A pure `QmdDraftSession` owns each open Draft's state. Focused modules provide QMD language services, Explorer snapshots, Monaco transport, Quarto lifecycle, and AI proposal rebase; `QmdWorkspaceShell` composes them and leaves `qlabModule.js` as the native-tab coordinator. All writes continue through `QmdDraftIO`, with human writes restricted to `drafts/` and AI writes restricted to `work/qlab-zotero/draft-changes/` until Keep.

**Tech Stack:** Zotero XUL/XHTML chrome, JavaScript loaded into `Zotero.QLab`, bundled Monaco Editor 0.47, SCSS, Fluent localization, Quarto CLI over loopback, Node `node:test` contract tests, macOS Chatero DMG scripts.

## Global Constraints

- Preserve Zotero Library, Reader, sync, and citation behavior.
- Only paths canonically beneath `<qlab-root>/drafts/` are editable.
- `knowledge/` and `literature/` are read-only context surfaces.
- AI may write only beneath `work/qlab-zotero/draft-changes/` until Keep.
- Quarto binds to `127.0.0.1` and always receives `--no-execute`.
- Human edits auto-save after 800 ms; `⌘S` saves immediately.
- One latest disk-backed AI proposal is retained per Draft.
- Missing or failed QLab components must not prevent Zotero core startup.
- New user-visible copy is English, Fluent-localized, and accessible.
- Do not add terminal, Git panel, VS Code extension compatibility, or direct Preview editing.
- Do not include personal QLab `knowledge/`, `drafts/`, or `literature/` content in the application or DMG.

---

## File Structure

- `chrome/content/zotero/xpcom/qlab/qmdDraftSession.js` -- authoritative Draft state and save scheduling.
- `chrome/content/zotero/xpcom/qlab/qmdLanguage.js` -- QMD snippets, citation parsing, decorations, diagnostics, and source block map.
- `chrome/content/zotero/xpcom/qlab/qmdExplorer.js` -- sandboxed tree snapshots and bounded external-change polling.
- `chrome/content/zotero/qlab/qmdMonaco.html` -- dedicated bundled-Monaco host.
- `chrome/content/zotero/xpcom/qlab/qmdMonacoBridge.js` -- parent/iframe protocol, models, normal/diff/conflict modes.
- `chrome/content/zotero/xpcom/qlab/qmdPreviewController.js` -- one-session-per-Draft Quarto lifecycle and last-good state.
- `chrome/content/zotero/xpcom/qlab/qmdProposalReview.js` -- base/current/proposed patch replay and conflict model.
- `chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js` -- workspace markup, event wiring, splitter, status, and cleanup.
- `scss/components/_qlabQmdWorkspace.scss` -- Cursor-style workspace layout and responsive/theme rules.
- `chrome/locale/en-US/zotero/zotero.ftl` -- accessible QMD workspace strings.
- `scripts/chatero/tests/*.test.mjs` -- behavior tests for every pure boundary.
- Existing `qmdDraftIO.js`, `qmdPreview.js`, `draftWorkingCopy.js`, `qlabModule.js`, `zotero.mjs`, `load-qlab.mjs`, `_zotero.scss`, and tab serialization receive narrow adapters only.

---

### Task 1: Authoritative Draft Session and Safe Auto-save

**Files:**
- Create: `chrome/content/zotero/xpcom/qlab/qmdDraftSession.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdDraftIO.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Test: `scripts/chatero/tests/qmd-draft-session.test.mjs`

**Interfaces:**
- Consumes: `QmdDraftIO.readSource(root, path, host)` and `QmdDraftIO.writeSource(root, path, text, expectedRevision, host)`.
- Produces: `Zotero.QLab.createQmdDraftSession(options)` returning `applyHumanEdit(text)`, `saveNow()`, `observeDisk(file)`, `attachProposal(meta)`, `clearProposal()`, `snapshot()`, and `dispose()`.
- Emits through injected callbacks: `onState(snapshot)`, `onSaved(snapshot)`, and `onConflict({ disk, buffer })`.

- [ ] **Step 1: Write failing state and scheduling tests**

```js
test("human edit is dirty immediately and schedules one 800 ms save", async () => {
	let scheduled = [];
	let session = QLab.createQmdDraftSession({
		path: "drafts/a.qmd", text: "old", revision: "r1",
		schedule: (fn, ms) => (scheduled.push({ fn, ms }), scheduled.length),
		cancel: () => {},
		onSave: async ({ text, expectedRevision }) => ({ text, revision: "r2", expectedRevision }),
	});
	session.applyHumanEdit("new");
	assert.equal(session.snapshot().dirty, true);
	assert.equal(scheduled.length, 1);
	assert.equal(scheduled[0].ms, 800);
	await scheduled[0].fn();
	assert.equal(session.snapshot().revision, "r2");
	assert.equal(session.snapshot().dirty, false);
});

test("dirty external change preserves memory and requests compare", () => {
	let conflicts = [];
	let session = QLab.createQmdDraftSession({
		path: "drafts/a.qmd", text: "old", revision: "r1",
		schedule: () => 1, cancel: () => {}, onSave: async () => ({ revision: "r2" }),
		onConflict: value => conflicts.push(value),
	});
	session.applyHumanEdit("memory");
	session.observeDisk({ text: "disk", revision: "r2" });
	assert.equal(conflicts.length, 1);
	assert.equal(session.snapshot().text, "memory");
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test scripts/chatero/tests/qmd-draft-session.test.mjs`  
Expected: FAIL because `createQmdDraftSession` is not defined.

- [ ] **Step 3: Implement the pure session state machine**

Implement a closure with one scheduled save, a monotonically increasing edit generation, CAS revision retention, and explicit disposal. A save completion clears dirty only when its generation still matches the current buffer:

```js
Zotero.QLab.createQmdDraftSession = function ({
	path, text, revision, autoSaveDelay = 800,
	schedule = setTimeout, cancel = clearTimeout,
	onSave, onState = () => {}, onSaved = () => {}, onConflict = () => {},
}) {
	let state = { path, text, savedText: text, revision, dirty: false,
		saving: false, saveError: "", proposal: null, disposed: false };
	let timer = null;
	let generation = 0;
	// applyHumanEdit, saveNow, observeDisk, proposal methods, snapshot, dispose
};
```

Add `QmdDraftIO.inspectSource()` as the same read contract used by the watcher and keep all writes behind the existing CAS check.

- [ ] **Step 4: Run focused and existing Draft IO tests**

Run: `node --test scripts/chatero/tests/qmd-draft-session.test.mjs scripts/chatero/tests/qmd-draft-io.test.mjs`  
Expected: PASS with zero failures.

- [ ] **Step 5: Commit Task 1**

```bash
git add chrome/content/zotero/xpcom/qlab/qmdDraftSession.js \
  chrome/content/zotero/xpcom/qlab/qmdDraftIO.js chrome/content/zotero/zotero.mjs \
  scripts/chatero/lib/load-qlab.mjs scripts/chatero/tests/qmd-draft-session.test.mjs
git commit -m "feat: add authoritative QMD draft sessions"
```

---

### Task 2: QMD Language Services and Citation Completion

**Files:**
- Create: `chrome/content/zotero/xpcom/qlab/qmdLanguage.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdSourceModel.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Test: `scripts/chatero/tests/qmd-language.test.mjs`

**Interfaces:**
- Consumes: `visualQmdBlocks(source)` and the text of `literature/ref.bib`.
- Produces: `qmdLanguageSnapshot(source, bibliographyText)` with `{ blocks, decorations, diagnostics, citations }`.
- Produces: `qmdCompletionItems({ source, offset, bibliographyText })` with Monaco-neutral `{ label, insertText, kind, detail }` entries.

- [ ] **Step 1: Write failing language behavior tests**

```js
test("QMD completions include theorem snippets and BibTeX citekeys", async () => {
	let items = QLab.qmdCompletionItems({
		source: "See @bra", offset: 8,
		bibliographyText: "@article{bravyi_correcting_2018, title={Correcting}}",
	});
	assert.ok(items.some(x => x.label === "Definition block" && x.insertText.includes("#def-")));
	assert.ok(items.some(x => x.label === "@bravyi_correcting_2018"));
});

test("block map recognizes math and theorem-family fenced Divs", async () => {
	let snap = QLab.qmdLanguageSnapshot("# A\n\n:::{#lem-x}\n$E=mc^2$\n:::\n", "");
	assert.equal(snap.blocks.find(x => x.semantic === "lemma").key, "div:lem-x");
	assert.ok(snap.decorations.some(x => x.kind === "math"));
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test scripts/chatero/tests/qmd-language.test.mjs`  
Expected: FAIL because `qmdCompletionItems` and `qmdLanguageSnapshot` are missing.

- [ ] **Step 3: Implement QMD-neutral language data**

Parse BibTeX keys with `/@[A-Za-z]+\s*\{\s*([^,\s]+)/g`, provide literal snippets for `thm`, `lem`, `def`, and `proof`, and build stable keys from explicit Div IDs, heading slugs, equation order, and paragraph order. Decorations use source offsets and semantic kinds; they do not contain Monaco objects.

```js
const BLOCK_SNIPPETS = [
	{ label: "Theorem block", insertText: ":::{#thm-${1:id}}\n${2:Statement.}\n:::" },
	{ label: "Lemma block", insertText: ":::{#lem-${1:id}}\n${2:Statement.}\n:::" },
	{ label: "Definition block", insertText: ":::{#def-${1:id}}\n${2:Definition.}\n:::" },
	{ label: "Proof block", insertText: ":::{#prf-${1:id}}\n${2:Proof.}\n:::" },
];
```

- [ ] **Step 4: Run language and source-model tests**

Run: `node --test scripts/chatero/tests/qmd-language.test.mjs scripts/chatero/tests/qmd-surface.test.mjs scripts/chatero/tests/qmd-math-preview.test.mjs`  
Expected: PASS with zero failures.

- [ ] **Step 5: Commit Task 2**

```bash
git add chrome/content/zotero/xpcom/qlab/qmdLanguage.js \
  chrome/content/zotero/xpcom/qlab/qmdSourceModel.js chrome/content/zotero/zotero.mjs \
  scripts/chatero/lib/load-qlab.mjs scripts/chatero/tests/qmd-language.test.mjs
git commit -m "feat: add QMD language services"
```

---

### Task 3: Sandboxed Explorer and External-change Watcher

**Files:**
- Create: `chrome/content/zotero/xpcom/qlab/qmdExplorer.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdDraftIO.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Test: `scripts/chatero/tests/qmd-explorer.test.mjs`

**Interfaces:**
- Consumes: QLab root and a host implementing `exists`, `entries`, `filename`, `read`, and canonical-path validation.
- Produces: `buildQmdExplorerSnapshot(root, host)` returning roots with `{ path, name, kind, writable, children, revision }`.
- Produces: `createQmdExplorerWatcher({ readSnapshot, onChange, schedule, cancel, activeInterval, idleInterval })`.

- [ ] **Step 1: Write failing tree and watcher tests**

```js
test("Explorer marks only Draft QMD files writable", async () => {
	let snapshot = await QLab.buildQmdExplorerSnapshot(root, host);
	let flat = snapshot.flatMap(root => [root, ...(root.children || [])]);
	let draft = flat.find(node => node.path === "drafts/a.qmd");
	let knowledge = flat.find(node => node.path === "knowledge/a.qmd");
	assert.equal(draft.writable, true);
	assert.equal(knowledge.writable, false);
});

test("watcher emits only when the snapshot changes", async () => {
	let emitted = [];
	let scheduled = [];
	let snapshots = [[{ revision: "a" }], [{ revision: "a" }], [{ revision: "b" }]];
	let watcher = QLab.createQmdExplorerWatcher({
		readSnapshot: async () => snapshots.shift(),
		onChange: value => emitted.push(value),
		schedule: fn => (scheduled.push(fn), scheduled.length), cancel: () => {},
	});
	await watcher.poll(); await watcher.poll(); await watcher.poll();
	assert.equal(emitted.length, 2);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test scripts/chatero/tests/qmd-explorer.test.mjs`  
Expected: FAIL because Explorer functions are missing.

- [ ] **Step 3: Implement deterministic snapshots and bounded polling**

Use sorted relative paths, ignore dotfiles and non-QMD Draft entries, expose read-only QMD/BibTeX/PDF context entries, and compare serialized revision summaries rather than DOM. The watcher uses 1,000 ms while visible and 5,000 ms while idle; `dispose()` cancels its timer.

- [ ] **Step 4: Run focused path and workspace tests**

Run: `node --test scripts/chatero/tests/qmd-explorer.test.mjs scripts/chatero/tests/qlab-workspace.test.mjs scripts/chatero/tests/qmd-draft-io.test.mjs`  
Expected: PASS with zero failures.

- [ ] **Step 5: Commit Task 3**

```bash
git add chrome/content/zotero/xpcom/qlab/qmdExplorer.js \
  chrome/content/zotero/xpcom/qlab/qmdDraftIO.js chrome/content/zotero/zotero.mjs \
  scripts/chatero/lib/load-qlab.mjs scripts/chatero/tests/qmd-explorer.test.mjs
git commit -m "feat: add live QLab Draft explorer"
```

---

### Task 4: Dedicated Monaco Host and Bridge

**Files:**
- Create: `chrome/content/zotero/qlab/qmdMonaco.html`
- Create: `chrome/content/zotero/xpcom/qlab/qmdMonacoBridge.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Test: `scripts/chatero/tests/qmd-monaco-bridge.test.mjs`

**Interfaces:**
- Consumes: `QmdDraftSession` and `qmdLanguageSnapshot`.
- Produces: `qmdMonacoOptions({ theme, wordWrap })`, `qmdMonacoModelURI(root, path)`, and `createQmdMonacoBridge({ frame, session, language, onCommand })`.
- Frame API: `loadQmdMonaco(config)`, `setQmdModel(payload)`, `setQmdDiff(payload)`, `setQmdDiagnostics(markers)`, `revealQmdRange(range)`, `snapshotQmdView()`, and `disposeQmdMonaco()`.

- [ ] **Step 1: Write failing bridge contract tests**

```js
test("bridge converts editor changes into human Draft edits", async () => {
	let edits = [];
	let receive;
	let adapter = { onEvent: fn => { receive = fn; }, setNormalModel: () => {}, dispose: () => {} };
	QLab.createQmdMonacoBridge({
		adapter,
		session: { applyHumanEdit: text => edits.push(text), snapshot: () => ({ text: "a" }) },
		language: () => ({ diagnostics: [], decorations: [], citations: [] }),
	});
	receive({ type: "change", text: "b" });
	assert.deepEqual(edits, ["b"]);
});

test("model URI is stable and contains no absolute workspace path", async () => {
	let uri = QLab.qmdMonacoModelURI("/Users/me/private", "drafts/a.qmd");
	assert.equal(uri, "inmemory://qlab/drafts/a.qmd");
	assert.equal(uri.includes("/Users/me/private"), false);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test scripts/chatero/tests/qmd-monaco-bridge.test.mjs`  
Expected: FAIL because the bridge functions are missing.

- [ ] **Step 3: Implement the Monaco host and narrow adapter**

Load `resource://zotero/vs/loader.js`, create Markdown/QMD models with LF EOL,
word wrap, minimap disabled, automatic layout, macOS keybindings, and light/dark
themes. Translate completion and diagnostic data into Monaco types inside the
iframe. The parent bridge receives only validated change, cursor, command, and
ready events.

- [ ] **Step 4: Run bridge tests and build the changed assets**

Run: `node --test scripts/chatero/tests/qmd-monaco-bridge.test.mjs scripts/chatero/tests/qmd-language.test.mjs`  
Run: `npm run build`  
Expected: tests PASS and build exits 0.

- [ ] **Step 5: Commit Task 4**

```bash
git add chrome/content/zotero/qlab/qmdMonaco.html \
  chrome/content/zotero/xpcom/qlab/qmdMonacoBridge.js chrome/content/zotero/zotero.mjs \
  scripts/chatero/lib/load-qlab.mjs scripts/chatero/tests/qmd-monaco-bridge.test.mjs
git commit -m "feat: embed Monaco for QMD editing"
```

---

### Task 5: Quarto Preview Lifecycle and Last-good Rendering

**Files:**
- Create: `chrome/content/zotero/xpcom/qlab/qmdPreviewController.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdPreview.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdSurface.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdMarkdownLite.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Test: `scripts/chatero/tests/qmd-preview-controller.test.mjs`

**Interfaces:**
- Consumes: `startQmdQuartoPreview`, `stopQmdQuartoPreview`, `qmdLanguageSnapshot`, and an iframe adapter.
- Produces: `createQmdPreviewController({ root, path, runner, probe, fallback, onState })` with `start()`, `refresh(savedRevision)`, `retry()`, `revealBlock(key)`, `setVisible(bool)`, `snapshot()`, and `dispose()`.

- [ ] **Step 1: Write failing lifecycle tests**

```js
test("controller retains the last good URL when a rebuild fails", async () => {
	let starts = ["http://127.0.0.1:43001/", new Error("compile failed")];
	let controller = QLab.createQmdPreviewController({ startPreview: async () => {
		let next = starts.shift(); if (next instanceof Error) throw next; return next;
	}});
	await controller.start();
	await controller.refresh("r2");
	assert.equal(controller.snapshot().url, "http://127.0.0.1:43001/");
	assert.equal(controller.snapshot().status, "error");
});

test("three consecutive crashes pause automatic restart", async () => {
	let controller = QLab.createQmdPreviewController({
		startPreview: async () => { throw new Error("crash"); },
	});
	await controller.start(); await controller.retry(); await controller.retry();
	assert.equal(controller.snapshot().canAutoRestart, false);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test scripts/chatero/tests/qmd-preview-controller.test.mjs`  
Expected: FAIL because `createQmdPreviewController` is missing.

- [ ] **Step 3: Implement session ownership, diagnostics, and fallback**

Keep the existing URL while status is `rendering` or `error`, parse Quarto
`file.qmd:line:column` output into Monaco-neutral diagnostics, deduplicate by
canonical Draft path, and stop the process on disposal. Remove all temporary
`fetch('http://127.0.0.1:7350/ingest/...')` diagnostic instrumentation from QMD
render and Preview production paths.

- [ ] **Step 4: Run Preview, math, and surface tests**

Run: `node --test scripts/chatero/tests/qmd-preview-controller.test.mjs scripts/chatero/tests/qmd-surface.test.mjs scripts/chatero/tests/qmd-math-preview.test.mjs`  
Expected: PASS with zero failures.

- [ ] **Step 5: Commit Task 5**

```bash
git add chrome/content/zotero/xpcom/qlab/qmdPreviewController.js \
  chrome/content/zotero/xpcom/qlab/qmdPreview.js chrome/content/zotero/xpcom/qlab/qmdSurface.js \
  chrome/content/zotero/xpcom/qlab/qmdMarkdownLite.js chrome/content/zotero/zotero.mjs \
  scripts/chatero/lib/load-qlab.mjs scripts/chatero/tests/qmd-preview-controller.test.mjs
git commit -m "feat: add resilient live Quarto preview"
```

---

### Task 6: Persistent AI Proposal Rebase and Diff Review

**Files:**
- Create: `chrome/content/zotero/xpcom/qlab/qmdProposalReview.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdDraftIO.js`
- Modify: `chrome/content/zotero/xpcom/qlab/draftWorkingCopy.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Test: `scripts/chatero/tests/qmd-proposal-review.test.mjs`
- Test: `scripts/chatero/tests/qmd-draft-io.test.mjs`

**Interfaces:**
- Consumes: base text/revision, latest original text/revision, and proposed text.
- Produces: `reviewQmdProposal({ base, current, proposed })` returning either `{ status: "clean", text, hunks }` or `{ status: "conflict", base, current, proposed, conflicts }`.
- Produces: `QmdDraftIO.findProposal(root, originalPath, host)`, `rejectChange(root, state, host)`, and rebase-aware `keepChange(root, state, host)`.

- [ ] **Step 1: Write failing rebase and persistence tests**

```js
test("AI edit replays over a disjoint human edit", async () => {
	let result = QLab.reviewQmdProposal({
		base: "title\nold theorem\nend\n",
		current: "new title\nold theorem\nend\n",
		proposed: "title\nnew theorem\nend\n",
	});
	assert.equal(result.status, "clean");
	assert.equal(result.text, "new title\nnew theorem\nend\n");
});

test("overlapping human and AI edits preserve all three texts", async () => {
	let result = QLab.reviewQmdProposal({
		base: "claim\n", current: "human claim\n", proposed: "AI claim\n",
	});
	assert.equal(result.status, "conflict");
	assert.equal(result.current, "human claim\n");
	assert.equal(result.proposed, "AI claim\n");
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test scripts/chatero/tests/qmd-proposal-review.test.mjs`  
Expected: FAIL because `reviewQmdProposal` is missing.

- [ ] **Step 3: Implement line-hunk replay and disk manifests**

Use an LCS-derived line patch from base to proposed. Apply a hunk only when its
base range is unchanged in current or uniquely relocates by unchanged context;
otherwise return a conflict without writing. `prepareChange` writes both
`base.qmd` and `draft.qmd` plus `manifest.json`. `findProposal` selects only the
newest manifest for a Draft. A successful Keep CAS-writes the rebased text and
removes review metadata; Reject removes only the proposal directory.

- [ ] **Step 4: Run proposal, working-copy, and Draft IO tests**

Run: `node --test scripts/chatero/tests/qmd-proposal-review.test.mjs scripts/chatero/tests/qmd-draft-io.test.mjs`  
Expected: PASS with zero failures.

- [ ] **Step 5: Commit Task 6**

```bash
git add chrome/content/zotero/xpcom/qlab/qmdProposalReview.js \
  chrome/content/zotero/xpcom/qlab/qmdDraftIO.js chrome/content/zotero/xpcom/qlab/draftWorkingCopy.js \
  chrome/content/zotero/zotero.mjs scripts/chatero/lib/load-qlab.mjs \
  scripts/chatero/tests/qmd-proposal-review.test.mjs scripts/chatero/tests/qmd-draft-io.test.mjs
git commit -m "feat: add persistent AI Draft review"
```

---

### Task 7: Cursor-style Workspace Shell Integration

**Files:**
- Create: `chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js`
- Create: `scss/components/_qlabQmdWorkspace.scss`
- Modify: `chrome/content/zotero/xpcom/qlab/qlabModule.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdSurface.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Modify: `scss/_zotero.scss`
- Test: `scripts/chatero/tests/qmd-workspace-shell.test.mjs`
- Test: `scripts/chatero/tests/qlab-visual-structure.test.mjs`

**Interfaces:**
- Consumes: session, Explorer, Monaco bridge, Preview controller, proposal review, QmdDraftIO, and existing `⌘K` Agent flow.
- Produces: `renderQmdWorkspaceHTML(snapshot)`, `createQmdWorkspaceController(dependencies)`, and `mountQmdWorkspace(host, { root, initialPath })` returning `{ refreshExplorer, openDraft, toggleExplorer, togglePreview, dispose }`.

- [ ] **Step 1: Write failing shell behavior tests**

```js
test("workspace renders Explorer, Monaco, Preview, splitter, and status semantics", async () => {
	let html = QLab.renderQmdWorkspaceHTML({ path: "drafts/a.qmd", explorer: [], status: "ready" });
	assert.match(html, /data-qlab-qmd-explorer/);
	assert.match(html, /data-qlab-qmd-monaco/);
	assert.match(html, /data-qlab-qmd-preview/);
	assert.match(html, /role="separator"/);
	assert.match(html, /data-qlab-qmd-status/);
});

test("workspace disposal closes watcher, Monaco bridge, Preview, and session", async () => {
	let calls = [];
	let workspace = QLab.createQmdWorkspaceController({
		watcher: { dispose: () => calls.push("watcher") },
		monaco: { dispose: () => calls.push("monaco") },
		preview: { dispose: () => calls.push("preview") },
		session: { dispose: () => calls.push("session") },
	});
	workspace.dispose();
	assert.deepEqual(calls, ["watcher", "monaco", "preview", "session"]);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test scripts/chatero/tests/qmd-workspace-shell.test.mjs`  
Expected: FAIL because workspace shell functions are missing.

- [ ] **Step 3: Implement shell composition and migrate QMD event wiring**

Render the approved three-column layout, replace the raw textarea and three-mode
toggle, mount Monaco only after its iframe is ready, and keep the existing
source-driven renderer exclusively as Preview fallback. Move QMD-specific click,
change, and keydown branches out of `mountShellTab` into the workspace module.
Keep Chat event wiring and native tab arrangement unchanged.

- [ ] **Step 4: Implement splitter and state restoration**

Store Explorer visibility, Preview visibility, and divider ratio in the QMD tab
session payload. Clamp the editor and Preview to 260 px minimum each. Pointer
drag and keyboard ArrowLeft/ArrowRight both update the CSS grid and session
snapshot without recreating Reader or Monaco content.

- [ ] **Step 5: Run workspace and tab-group tests**

Run: `node --test scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/qlab-visual-structure.test.mjs scripts/chatero/tests/tab-groups.test.mjs scripts/chatero/tests/qmd-surface.test.mjs`  
Expected: PASS with zero failures.

- [ ] **Step 6: Commit Task 7**

```bash
git add chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js \
  chrome/content/zotero/xpcom/qlab/qlabModule.js chrome/content/zotero/xpcom/qlab/qmdSurface.js \
  chrome/content/zotero/zotero.mjs scripts/chatero/lib/load-qlab.mjs \
  scss/components/_qlabQmdWorkspace.scss scss/_zotero.scss \
  scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/qlab-visual-structure.test.mjs
git commit -m "feat: add Cursor-style QMD workspace shell"
```

---

### Task 8: Accessible Copy, Diagnostics, and Review-state Polish

**Files:**
- Modify: `chrome/locale/en-US/zotero/zotero.ftl`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdMonacoBridge.js`
- Modify: `scss/components/_qlabQmdWorkspace.scss`
- Test: `scripts/chatero/tests/qmd-workspace-accessibility.test.mjs`

**Interfaces:**
- Consumes: workspace state and Fluent localization from the owning chrome document.
- Produces: accessible labels for actions, splitter semantics, status text, Preview failure, proposal, and conflict states.

- [ ] **Step 1: Write failing accessibility behavior tests**

```js
test("workspace controls expose names without visible toolbar text", async () => {
	let model = QLab.qmdWorkspaceAccessibilityModel({ proposal: true, previewStatus: "error" });
	assert.equal(model.actions.keep.label, "Keep AI changes");
	assert.equal(model.actions.reject.label, "Reject AI changes");
	assert.equal(model.splitter.role, "separator");
	assert.equal(model.status.includes("Preview failed"), true);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test scripts/chatero/tests/qmd-workspace-accessibility.test.mjs`  
Expected: FAIL because the accessibility model is missing.

- [ ] **Step 3: Add Fluent strings and themed interaction states**

Add English strings for Explorer, save/retry, Preview, Original/Proposed,
Keep/Reject, compare, and conflict resolution. Use `aria-label`, tooltip, focus
rings, reduced-motion support, theme variables, non-color status markers, and a
responsive mode that collapses Explorer before hiding Preview.

- [ ] **Step 4: Run accessibility and focused build checks**

Run: `node --test scripts/chatero/tests/qmd-workspace-accessibility.test.mjs scripts/chatero/tests/qmd-workspace-shell.test.mjs`  
Run: `npm run sass`  
Expected: tests PASS and Sass exits 0 without new warnings.

- [ ] **Step 5: Commit Task 8**

```bash
git add chrome/locale/en-US/zotero/zotero.ftl \
  chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js \
  chrome/content/zotero/xpcom/qlab/qmdMonacoBridge.js \
  scss/components/_qlabQmdWorkspace.scss \
  scripts/chatero/tests/qmd-workspace-accessibility.test.mjs
git commit -m "feat: polish QMD workspace interaction"
```

---

### Task 9: Regression Gate and Personal-development DMG

**Files:**
- Modify: `docs/chatero/parity-checklist.md`
- Create: `docs/chatero/qmd-workspace-review.md`
- Modify tests only if a real integration defect is found during the gate.

**Interfaces:**
- Consumes: completed Tasks 1–8 and existing Chatero package/verifier scripts.
- Produces: a verified `dist/Chatero-<version>.dmg` and a reproducible manual review checklist.

- [ ] **Step 1: Run focused QMD tests**

Run: `node --test scripts/chatero/tests/qmd-*.test.mjs scripts/chatero/tests/qlab-visual-structure.test.mjs scripts/chatero/tests/cursor-parity.test.mjs`  
Expected: PASS with zero failures.

- [ ] **Step 2: Run the complete Chatero gate**

Run: `NODE_OPTIONS=--openssl-legacy-provider npm run test:chatero`  
Expected: every Chatero test passes.

- [ ] **Step 3: Run build and lint for modified JavaScript**

Run: `npm run build`  
Run: `npx eslint chrome/content/zotero/xpcom/qlab/qmdDraftSession.js chrome/content/zotero/xpcom/qlab/qmdLanguage.js chrome/content/zotero/xpcom/qlab/qmdExplorer.js chrome/content/zotero/xpcom/qlab/qmdMonacoBridge.js chrome/content/zotero/xpcom/qlab/qmdPreviewController.js chrome/content/zotero/xpcom/qlab/qmdProposalReview.js chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js`  
Expected: build exits 0; lint reports no errors on modified lines.

- [ ] **Step 4: Package and verify the macOS DMG**

Run: `npm run package:chatero`  
Run: `npm run verify:chatero-bundle`  
Expected: an ad-hoc-signed Chatero DMG is produced and bundle verification exits 0.

- [ ] **Step 5: Write the manual review checklist and update parity**

Document exact checks for Explorer refresh, Monaco editing, YAML, math,
citations, theorem-family snippets, auto-save, Quarto success/failure,
Original/Proposed Preview, Keep/Reject, overlap recovery, restart persistence,
and PDF/Chat/QMD native-tab arrangement. Mark the richer Visual Edit parity row
as superseded by the approved source-driven Monaco workspace.

- [ ] **Step 6: Commit Task 9**

```bash
git add docs/chatero/parity-checklist.md docs/chatero/qmd-workspace-review.md
git commit -m "docs: add QMD workspace review guide"
```

---

## Completion Gate

The feature is complete only when all nine task commits exist, focused and full
Chatero tests pass, `npm run build` succeeds, the bundle verifier accepts the
staged app, and the generated personal-development DMG contains no QLab user
content. Upstream Zotero failures must be distinguished from Chatero regressions
with recorded evidence before integration.
