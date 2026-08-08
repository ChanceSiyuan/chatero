# Hybrid Single-File QMD Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the QMD Preview surface display immediately, then replace its safe source-driven result with the exact selected Quarto page in a native Zotero browser without blanking or rendering the entire Draft tree.

**Architecture:** `qmdPreview.js` owns selected-page routing and the one-file Quarto process. `qmdPreviewController.js` owns quick/exact/last-good state. A focused preview-surface adapter in `qmdWorkspaceShell.js` switches one visible pane between a local quick-preview iframe and a native remote XUL browser. The existing Draft session remains the source of truth and Quarto continues to watch only the active QMD with execution disabled.

**Tech Stack:** Zotero/Gecko JavaScript, XUL `<browser>`, Quarto CLI 1.8.x, safe source-driven QMD renderer with KaTeX, SCSS, Node `node:test`, macOS Chatero packaging.

## Global Constraints

- Human writes remain limited to QMD files under `drafts/` and continue through `QmdDraftIO.writeSource` revision checks.
- AI output remains a private proposal until Keep.
- Quarto remains loopback-only and always uses `--no-execute`.
- Only the active QMD is previewed; Drafts are never published.
- `knowledge/`, `literature/`, Zotero profiles, chat history, credentials, and personal QLab content must never be packaged, overwritten, or committed.
- Source/Preview switching, Explorer selection, autosave, AI proposal comparison, Keep/Reject, native PDF tabs, and Zotero core behavior retain their current contracts.

---

### Task 1: Route Quarto to the Selected QMD Page

**Files:**
- Modify: `scripts/chatero/tests/qmd-math-preview.test.mjs`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdPreview.js`

**Interfaces:**
- Produces: `qmdQuartoPagePath(relativeFile): string`, where `relativeFile` is
  the file argument relative to Quarto's selected working directory.
- Extends: `resolveQuartoPreviewTarget(root, relativePath)` to return `{ cwd, file, page }`.
- Changes: `startQmdQuartoPreview(root, relativePath, options)` resolves only after `http://127.0.0.1:<port><page>` responds and returns that exact URL.
- Preserves: the absolute Quarto discovery path, loopback host, `--no-browser`, and `--no-execute`.

- [ ] **Step 1: Write failing literal route tests**

Add table-driven cases whose expected routes are hand-derived:

```js
for (let [path, page] of [
	["index.qmd", "/"],
	["local_alg.qmd", "/local_alg.html"],
	["topic/note.qmd", "/topic/note.html"],
	["topic/index.qmd", "/topic/"],
]) {
	test(`selected Quarto route for ${path}`, async () => {
		const QLab = await loadQLab();
		assert.equal(QLab.qmdQuartoPagePath(path), page);
	});
}
```

Add a startup test that records every fetched URL and asserts both the probe
and returned value are `http://127.0.0.1:43104/topic/note.html`, never `/`.
This catches a regression where a healthy Draft index makes the wrong page
appear ready.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test scripts/chatero/tests/qmd-math-preview.test.mjs
```

Expected: FAIL because `qmdQuartoPagePath` is missing and the current starter
returns/probes the server root.

- [ ] **Step 3: Implement the minimal route mapping**

Normalize separators, remove the `drafts/` prefix for Draft targets, then map
the path without reusing the implementation in test expectations:

```js
Zotero.QLab.qmdQuartoPagePath = function (relativePath) {
	let within = String(relativePath).replace(/\\/g, '/').replace(/^\/+/, '');
	if (within === 'index.qmd') return '/';
	if (within.endsWith('/index.qmd')) return `/${within.slice(0, -'index.qmd'.length)}`;
	return `/${within.slice(0, -'.qmd'.length)}.html`;
};
```

Store `page: qmdQuartoPagePath(file)` on the resolved target, build
`readyURL = new URL(page, url).href`, probe `readyURL`, persist it in the
session, and return it.

- [ ] **Step 4: Run Preview tests and verify GREEN**

Run:

```bash
node --test scripts/chatero/tests/qmd-math-preview.test.mjs scripts/chatero/tests/qmd-preview-controller.test.mjs
```

- [ ] **Step 5: Commit the route fix**

```bash
git add scripts/chatero/tests/qmd-math-preview.test.mjs chrome/content/zotero/xpcom/qlab/qmdPreview.js
git commit -m "fix: open the selected QMD preview page"
```

### Task 2: Publish Quick Preview Before Quarto Is Ready

**Files:**
- Modify: `scripts/chatero/tests/qmd-preview-controller.test.mjs`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdPreviewController.js`

**Interfaces:**
- Extends: `createQmdPreviewController({ fallback, visible })` where `visible` defaults to `true` for compatibility.
- Produces controller state fields: `fallback`, `url`, `status`, `error`, `visible`, and `pendingRefresh`.
- Contract: while exact rendering is pending, `status === "rendering"` and `fallback` contains the current safe quick-preview HTML.
- Contract: an exact-render failure retains both the last successful `url` and a readable `fallback`.

- [ ] **Step 1: Write a failing deferred-render test**

Use a manually controlled Promise for `startPreview` and a real fallback
function. Assert that the first published `rendering` state already contains
the literal quick HTML before the exact Promise resolves:

```js
test("controller publishes quick HTML while exact Quarto is pending", async () => {
	const QLab = await loadQLab();
	let release;
	let exact = new Promise(resolve => { release = resolve; });
	let states = [];
	let controller = QLab.createQmdPreviewController({
		root: "/repo",
		path: "drafts/a.qmd",
		fallback: () => "<main>quick a</main>",
		startPreview: () => exact,
		stopPreview: () => {},
		onState: state => states.push(state),
	});
	let pending = controller.start();
	await Promise.resolve();
	assert.equal(states.at(-1).status, "rendering");
	assert.equal(states.at(-1).fallback, "<main>quick a</main>");
	release("http://127.0.0.1:43001/a.html");
	await pending;
});
```

Add a hidden-initial-state test: `visible: false` plus `start()` performs no
Quarto start; `setVisible(true)` publishes quick HTML and starts exactly once.

Extend the existing last-good failure test to assert its URL remains exact and
its fallback changes to the latest quick HTML after a failed refresh.

- [ ] **Step 2: Run the controller test and verify RED**

Run:

```bash
node --test scripts/chatero/tests/qmd-preview-controller.test.mjs
```

Expected: FAIL because fallback is currently generated only after an error and
the controller has no initial visibility option.

- [ ] **Step 3: Implement quick-first state transitions**

Before publishing `rendering`, resolve `fallback({ root, path, phase:
"rendering" })` and retain the prior fallback if generation changes. Do not
clear `state.url` during start or refresh. Accept `visible = true` in the
factory options and initialize `state.visible` from it. Hidden starts set
`pendingRefresh` without invoking fallback or Quarto.

On failure, keep `url` unchanged, keep or refresh `fallback`, set the exact
error, and publish once. On success, keep fallback cached but let the UI prefer
the exact URL.

- [ ] **Step 4: Run the controller and route tests and verify GREEN**

Run:

```bash
node --test scripts/chatero/tests/qmd-preview-controller.test.mjs scripts/chatero/tests/qmd-math-preview.test.mjs
```

- [ ] **Step 5: Commit the quick-first controller**

```bash
git add scripts/chatero/tests/qmd-preview-controller.test.mjs chrome/content/zotero/xpcom/qlab/qmdPreviewController.js
git commit -m "feat: show quick QMD preview while Quarto renders"
```

### Task 3: Replace the Exact iframe with a Native Zotero Browser

**Files:**
- Modify: `scripts/chatero/tests/qmd-workspace-shell.test.mjs`
- Modify: `scripts/chatero/tests/qlab-visual-structure.test.mjs`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js`
- Modify: `scss/components/_qlabQmdWorkspace.scss`

**Interfaces:**
- Produces: `createQmdPreviewSurface(document, host, { onLoadError }): QmdPreviewSurface`.
- `QmdPreviewSurface.showQuick(html)` displays safe local `srcdoc` content.
- `QmdPreviewSurface.showExact(url, { reload = false } = {})` navigates the native browser.
- `QmdPreviewSurface.showEmpty(message)` displays guidance only when no Draft exists.
- `QmdPreviewSurface.dispose()` removes listeners and browser content.
- Consumes: preview-controller snapshots from Task 2.

- [ ] **Step 1: Write a failing real-adapter behavior test**

Create a small fake Document whose `createXULElement("browser")` returns a
recording element with real attribute, append, hidden, and listener behavior.
Exercise `createQmdPreviewSurface` directly and assert:

```js
assert.equal(createdName, "browser");
assert.equal(browser.getAttribute("type"), "content");
assert.equal(browser.getAttribute("remote"), "true");
assert.equal(browser.getAttribute("maychangeremoteness"), "true");
surface.showQuick("<main>quick</main>");
assert.equal(quick.srcdoc, "<main>quick</main>");
assert.equal(browser.hidden, true);
surface.showExact("http://127.0.0.1:43104/topic/note.html");
assert.equal(browser.getAttribute("src"), "http://127.0.0.1:43104/topic/note.html");
assert.equal(browser.hidden, false);
assert.equal(quick.hidden, true);
```

This test catches reintroduction of an HTML iframe for exact loopback content.
Dispatch the fake browser's `error` event and assert `onLoadError` receives the
literal selected URL while the quick frame becomes visible again.
Update the rendered-shell assertion to require separate
`data-qlab-preview-quick` and `data-qlab-preview-browser-host` elements.

- [ ] **Step 2: Run shell tests and verify RED**

Run:

```bash
node --test scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/qlab-visual-structure.test.mjs
```

Expected: FAIL because the current shell has one sandboxed HTML iframe and no
native-browser adapter.

- [ ] **Step 3: Implement the native preview surface**

Render a stable preview stage:

```html
<div class="qlab-qmd-preview-stage" data-qlab-preview-stage>
  <iframe data-qlab-preview-quick title="Quick QMD Preview"></iframe>
  <div data-qlab-preview-browser-host></div>
  <div data-qlab-preview-empty>Select a Draft to preview it.</div>
</div>
```

Create the XUL browser only at mount time with `document.createXULElement`.
`showQuick` removes no last-good exact URL; it only changes which child is
visible. `showExact` accepts only `http://127.0.0.1:<port>/…` or
`http://localhost:<port>/…`, then navigates and reveals the native browser.
The browser's load error handler restores quick content and reports the exact
route through `onLoadError`.
If native creation is unavailable, keep quick content visible and return a
clear adapter error rather than blanking.

Update SCSS so the stage, quick iframe, native browser host, and native browser
all fill the available white surface. Remove the retired exact-frame selector.

- [ ] **Step 4: Run shell tests and Sass build and verify GREEN**

Run:

```bash
node --test scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/qlab-visual-structure.test.mjs
npm run sass
```

- [ ] **Step 5: Commit the native surface**

```bash
git add scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/qlab-visual-structure.test.mjs chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js scss/components/_qlabQmdWorkspace.scss
git commit -m "feat: host exact QMD previews in a native browser"
```

### Task 4: Integrate Truthful Status and Last-Good Switching

**Files:**
- Modify: `scripts/chatero/tests/qmd-workspace-shell.test.mjs`
- Modify: `scripts/chatero/tests/qmd-workspace-accessibility.test.mjs`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js`

**Interfaces:**
- Consumes: `QmdPreviewSurface` from Task 3 and controller states from Task 2.
- Produces: `qmdPreviewPresentation(state)` returning `{ mode, status, tone }`.
- Produces: `qmdWorkspaceStatus({ persistence, preview })`, where persistence
  is `saved | saving | dirty | conflict | error` and preview is a controller
  snapshot.
- `mode` is one of `empty | quick | exact`.
- Status values distinguish disk save state from preview render state.

- [ ] **Step 1: Write failing presentation tests**

Assert literal mappings independent of DOM text construction:

```js
assert.deepEqual(
	JSON.parse(JSON.stringify(QLab.qmdPreviewPresentation({
		status: "rendering", fallback: "<main>quick</main>", url: "",
	}))),
	{ mode: "quick", status: "Quick Preview · preparing Quarto…", tone: "rendering" }
);
assert.equal(QLab.qmdPreviewPresentation({
	status: "ready", url: "http://127.0.0.1:43104/a.html", fallback: "quick",
}).mode, "exact");
assert.match(QLab.qmdPreviewPresentation({
	status: "error", url: "", fallback: "quick", error: "bad yaml",
}).status, /Quick Preview · Quarto unavailable: bad yaml/);
```

Test status precedence through the real pure status combiner: `conflict` and
save `error` win over Preview; `saving` wins while a write is active; a saved
Draft plus a rendering controller yields `Saved · updating Quarto…`; and a
ready controller yields `Quarto Preview`. These assertions catch the current
bug where the unconditional `Saved` write hides Preview progress.

- [ ] **Step 2: Run workspace tests and verify RED**

Run:

```bash
node --test scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/qmd-workspace-accessibility.test.mjs
```

Expected: FAIL because preview presentation is embedded in
`showPreviewState`, there is no status combiner, and `openDraft` overwrites
rendering state with `Saved`.

- [ ] **Step 3: Implement state-driven presentation**

Move pure mapping into `qmdPreviewPresentation(state)` and status precedence
into `qmdWorkspaceStatus({ persistence, preview })`. In
`showPreviewState`, proposed mode remains source-driven; original mode calls
`previewSurface.showExact(state.url)` only for `ready`, otherwise shows
fallback/last-good according to the presentation mode. Do not remove a
previous exact URL during `rendering` or `error` unless no last-good content
exists.

Create the controller with initial visibility derived from the persisted
Source/Preview surface. Set `Saved` before starting Preview, not after it.
`onSaved` continues to call `refresh(revision)`; the controller's synchronous
rendering publication then changes the message to
`Saved · updating Quarto…` or `Quick Preview · preparing Quarto…`.

- [ ] **Step 4: Run all QMD tests and verify GREEN**

Run:

```bash
node --test scripts/chatero/tests/qmd-*.test.mjs scripts/chatero/tests/qlab-visual-structure.test.mjs
```

- [ ] **Step 5: Commit the integrated state model**

```bash
git add scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/qmd-workspace-accessibility.test.mjs chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js
git commit -m "fix: keep QMD preview visible through render states"
```

### Task 5: Harden Active-Process Lifecycle and Rapid File Switching

**Files:**
- Modify: `scripts/chatero/tests/qmd-math-preview.test.mjs`
- Modify: `scripts/chatero/tests/qmd-preview-controller.test.mjs`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdPreview.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdPreviewController.js`

**Interfaces:**
- Preserves: one controller owns at most one active selected-file session.
- Changes: a cached session is reused only when its exact selected page still answers.
- Changes: a stop that occurs before `registerKill` immediately invokes the later kill callback.
- Preserves: generation cancellation prevents a stale exact URL from replacing the current Draft.

- [ ] **Step 1: Write failing lifecycle tests**

Add three behavior tests:

1. Same-document reopen probes the exact URL and does not spawn a second
   process when it is healthy.
2. A cached process whose exact page no longer answers is stopped and restarted.
3. Calling `stopQmdQuartoPreview` before the runner registers its kill callback
   causes that callback to run immediately when registered.

Extend the controller stale-generation test with two deferred starts and
assert the first late result never becomes the final `snapshot().url`.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run:

```bash
node --test scripts/chatero/tests/qmd-math-preview.test.mjs scripts/chatero/tests/qmd-preview-controller.test.mjs
```

Expected: at least the dead-cache and late-kill cases fail against the existing
session registry.

- [ ] **Step 3: Implement minimal lifecycle hardening**

Before returning an existing session, probe `existing.url`. If the exact page
is unavailable, invoke its stop function and delete it before spawning. In the
runner's `registerKill`, set the callback and invoke it immediately when
`abort === true`. Keep generation checks in the controller before assigning an
exact URL.

- [ ] **Step 4: Run focused and full Chatero tests and verify GREEN**

Run:

```bash
node --test scripts/chatero/tests/qmd-math-preview.test.mjs scripts/chatero/tests/qmd-preview-controller.test.mjs
NODE_OPTIONS=--openssl-legacy-provider npm run test:chatero
```

- [ ] **Step 5: Commit lifecycle hardening**

```bash
git add scripts/chatero/tests/qmd-math-preview.test.mjs scripts/chatero/tests/qmd-preview-controller.test.mjs chrome/content/zotero/xpcom/qlab/qmdPreview.js chrome/content/zotero/xpcom/qlab/qmdPreviewController.js
git commit -m "fix: harden active QMD preview lifecycle"
```

### Task 6: Live Single-File Verification, Documentation, and Private DMG

**Files:**
- Modify: `docs/chatero/qmd-workspace-review.md`
- Generated, not committed: `app/dist/Chatero-11.0.SOURCE.dmg`

**Interfaces:**
- Consumes: completed hybrid Preview flow.
- Produces: updated manual review instructions and a verified personal DMG.

- [ ] **Step 1: Verify a real single-file Quarto route**

Use a temporary QLab fixture created by the test harness, or a temporary copy
outside the source tree. Start the same command Chatero uses and verify the
selected `.html` route returns HTTP 200 while no code cell executes. Do not
edit or copy personal Drafts for this check.

- [ ] **Step 2: Update the manual review guide**

Document these visible checks:

- eye toggle shows Quick Preview immediately;
- status changes from Quick Preview to Quarto Preview;
- the selected note, not Draft Workspace index, appears;
- save never blanks the pane;
- malformed QMD retains readable quick/last-good content;
- Source, Explorer, AI comparison, Keep, and Reject still work.

- [ ] **Step 3: Run fresh focused, full, and build verification**

Run:

```bash
node --test scripts/chatero/tests/qmd-*.test.mjs scripts/chatero/tests/qlab-visual-structure.test.mjs
NODE_OPTIONS=--openssl-legacy-provider npm run test:chatero
npm run build
```

- [ ] **Step 4: Commit the review guide**

```bash
git add docs/chatero/qmd-workspace-review.md
git commit -m "docs: add hybrid QMD preview review steps"
```

- [ ] **Step 5: Package and verify the DMG**

Run:

```bash
npm run package:chatero
npm run verify:chatero-bundle
shasum -a 256 app/dist/Chatero-11.0.SOURCE.dmg
```

Mount the DMG read-only and verify the application contains no `.qmd`, `.bib`,
`.pdf`, `knowledge/`, `drafts/`, or `literature/` personal data. Record the
artifact path and checksum in the completion report; do not commit generated
DMG files.
