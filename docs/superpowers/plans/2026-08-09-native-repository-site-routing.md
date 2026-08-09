# Native Repository, Main Site, and Document Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Chatero safely initialize a Research Loop repository, build and display its local Main Site in a native tab, and open every supported Draft, Knowledge, and Literature document through one authority-aware router.

**Architecture:** Port the XPI's tested behavior contracts into small Chatero-native modules: an immutable starter planner, a create-if-absent initializer, a repository identity service, a per-repository site supervisor, a native Site view, and a unified document router. Reuse Chatero's native tabs, Reader, split layout, QMD surfaces, process runner, target epochs, and session restoration; keep `qlabModule.js` as lifecycle wiring rather than an implementation container.

**Tech Stack:** Zotero/Chatero XPCOM JavaScript, Gecko `IOUtils`/`PathUtils`/`Subprocess`, native Zotero tabs and Reader, Monaco, Quarto, Node.js `node:test`, SCSS, Fluent localization, macOS Chatero packaging scripts.

## Global Constraints

- Migrate XPI behavior, protocols, security invariants, and useful tests; redesign presentation and lifecycle as native Chatero UI.
- All new user-facing product copy is English and uses Chatero's existing light Zotero palette.
- Never overwrite, replace, delete, chmod, or silently import an existing user file, directory, symbolic link, bibliography, PDF, or note.
- Existing `knowledge/`, `drafts/`, and `literature/` bytes and modes remain unchanged during initialization.
- An `incompatible` root never offers force initialization.
- Starter paths reject absolute paths, NUL bytes, empty segments, `.`, `..`, option-like segments, symbolic-link traversal, and case-folded duplicate targets.
- Verify the starter manifest and every payload digest before the first target write.
- The starter contains no personal notes, citations, PDFs, generated site, Git history, credentials, or fixed remote hosting identity.
- `knowledge/` remains trusted and never becomes an ordinary Agent-writable root; Knowledge and Literature document sessions are read-only.
- Site processes bind only to `127.0.0.1`; port 4180 is preferred, with a bounded loopback fallback only when an unrelated process owns it.
- Opening the Site tab may check health but never installs dependencies, builds, or starts a process until the user selects **Build & Start**.
- Invoke processes through fixed executable plus argument arrays and an absolute canonical `cwd`; never interpolate a repository path into a shell command.
- Repository initialization, Main Site, preview, editing, and promotion remain local-only.
- QMD execution is disabled in all preview/build paths.
- QLab failures never prevent Zotero Library, Reader, Notes, sync, or normal application startup.
- Automated and manual fixtures use temporary repositories and never the user's personal `knowledge/`, `drafts/`, or `literature/` trees.
- Follow strict red-green-refactor: each production behavior is preceded by a test observed failing for the expected missing behavior.

---

## File Responsibility Map

New production modules:

- `chrome/content/zotero/xpcom/qlab/qlabStarterManifest.js`: manifest parsing, path policy, immutable installation plans, and plan staleness.
- `chrome/content/zotero/xpcom/qlab/qlabRepositoryIdentity.js`: Git-private path resolution and exclusive repository UUID creation.
- `chrome/content/zotero/xpcom/qlab/qlabRepositoryInitializer.js`: create-if-absent initialization transaction and resumable receipt.
- `chrome/content/zotero/xpcom/qlab/qlabWorkspaceSetupView.js`: native setup state and DOM binding.
- `chrome/content/zotero/xpcom/qlab/mainSiteService.js`: per-identity health, dependencies, build, process, port, log, and shutdown state.
- `chrome/content/zotero/xpcom/qlab/mainSiteView.js`: `qlabsite` native tab presentation and navigation policy.
- `chrome/content/zotero/xpcom/qlab/workspaceDocumentRouter.js`: safe document classification and native open action.
- `scripts/chatero/build-qlab-starter.mjs`: reproducibly build and verify the public starter asset.

Existing modules changed narrowly:

- `qlabWorkspace.js`: stronger inspection host and repository shape validation.
- `qmdExplorer.js`: stable `authority`, `kind`, and `openMode` metadata.
- `qmdWorkspaceShell.js`: read-only QMD/Bib session and router dispatch; `openDraft()` stays Draft-only.
- `phase4.js`: compatibility delegation.
- `qlabModule.js`: service construction, tab mount/dispose, and router bridge.
- `tabGroups.js`, `arrangement.js`, `tabs.js`, `zoteroPane.js`: Site payload, placement, restore, and workspace-selection entry point only.
- `chrome/content/zotero/zotero.mjs` and `scripts/chatero/lib/load-qlab.mjs`: deterministic module load order.
- Chatero SCSS and Fluent resources: setup/site/read-only controls and accessible labels.

---

### Task 1: Repository Inspection and Immutable Starter Plans

**Files:**
- Create: `chrome/content/zotero/xpcom/qlab/qlabStarterManifest.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qlabWorkspace.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Modify: `scripts/chatero/tests/qlab-workspace.test.mjs`
- Create: `scripts/chatero/tests/qlab-starter-manifest.test.mjs`

**Interfaces:**
- Consumes: `isSafeWorkspaceRelativePath()`, canonical path host operations, and repository states from `qlabWorkspace.js`.
- Produces: `validateQLabStarterManifest(raw)`, `inspectQLabRepository(root, host)`, `planQLabStarterInstall({ root, inspection, manifest, host })`, and `isQLabStarterPlanCurrent(plan, inspection)`.

- [ ] **Step 1: Write failing inspection tests**

Add tests proving that ready entries have correct file/directory types, content-only trees are `partial`, top-level symlinks are `incompatible`, and the inspection exposes conflicts without changing disk:

```js
let inspection = await QLab.inspectQLabRepository(root, host);
assert.equal(inspection.state, "partial");
assert.deepEqual(inspection.preserved.sort(), ["drafts", "knowledge", "literature"]);
assert.deepEqual(inspection.conflicts, []);
```

- [ ] **Step 2: Run the inspection tests and observe RED**

Run: `node --test scripts/chatero/tests/qlab-workspace.test.mjs`

Expected: FAIL because `inspectQLabRepository` does not exist and current ready checks accept wrong entry types.

- [ ] **Step 3: Implement strong repository inspection**

Extend the host contract with `stat()` and `isSymlink()` and return a frozen snapshot:

```js
Zotero.QLab.inspectQLabRepository = async function (root, host) {
	let canonicalRoot = await Zotero.QLab.normalizeQLabRoot(root, host);
	let state = await Zotero.QLab.qlabRepositoryState(canonicalRoot, host);
	return Object.freeze({
		root: canonicalRoot,
		state,
		preserved: Object.freeze(await preservedTopLevel(canonicalRoot, host)),
		conflicts: Object.freeze(await repositoryConflicts(canonicalRoot, host)),
		fingerprint: await inspectionFingerprint(canonicalRoot, host),
	});
};
```

- [ ] **Step 4: Write failing manifest and plan tests**

Cover valid manifests, digest format, duplicate case-folded paths, traversal, option-like segments, wrong kinds, create/preserve/conflict sets, and a stale inspection fingerprint:

```js
let plan = await QLab.planQLabStarterInstall({ root, inspection, manifest, host });
assert.deepEqual(plan.create.map(entry => entry.path), ["AGENTS.md", "qlab"]);
assert.deepEqual(plan.preserve.map(entry => entry.path), ["drafts/index.qmd"]);
assert.equal(Object.isFrozen(plan), true);
assert.equal(await QLab.isQLabStarterPlanCurrent(plan, inspection), true);
```

- [ ] **Step 5: Run the manifest tests and observe RED**

Run: `node --test scripts/chatero/tests/qlab-starter-manifest.test.mjs`

Expected: FAIL because the manifest module and APIs do not exist.

- [ ] **Step 6: Implement manifest validation and planning**

Use schema version `1`, lowercase 64-character SHA-256 digests, explicit `file`/`directory` kinds, octal modes restricted to `0600`, `0644`, `0700`, and `0755`, plus a plan digest derived from the inspection fingerprint and manifest digest. Freeze every returned array and record.

- [ ] **Step 7: Load the module before initializer consumers and run GREEN**

Run: `node --test scripts/chatero/tests/qlab-workspace.test.mjs scripts/chatero/tests/qlab-starter-manifest.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add chrome/content/zotero/xpcom/qlab/qlabWorkspace.js chrome/content/zotero/xpcom/qlab/qlabStarterManifest.js chrome/content/zotero/zotero.mjs scripts/chatero/lib/load-qlab.mjs scripts/chatero/tests/qlab-workspace.test.mjs scripts/chatero/tests/qlab-starter-manifest.test.mjs
git commit -m "feat: plan safe QLab repository setup"
```

### Task 2: Public Starter Asset and Build Verification

**Files:**
- Create: `scripts/chatero/build-qlab-starter.mjs`
- Create: `scripts/chatero/starter/generated-files.mjs`
- Create: `resource/chatero/qlab-starter/research-loop-starter.zip`
- Create: `resource/chatero/qlab-starter/manifest.json`
- Modify: `package.json`
- Modify: `app/scripts/verify_chatero_bundle`
- Create: `scripts/chatero/tests/qlab-starter-asset.test.mjs`
- Modify: `scripts/chatero/tests/dmg-scripts.test.mjs`

**Interfaces:**
- Consumes: a Research Loop architecture checkout supplied explicitly to the build script and generated safe content from `generated-files.mjs`.
- Produces: a deterministic ZIP payload plus manifest consumed by Task 3; `npm run build:qlab-starter -- --source <root>` verifies and regenerates both.

- [ ] **Step 1: Write the failing starter-asset contract test**

The test opens the committed manifest/archive, verifies every entry digest, and rejects personal/generated paths:

```js
for (let forbidden of [".git/", "node_modules/", "dist/", "public/knowledge/", "drafts/ai-contexts/"]) {
	assert.equal(entries.some(entry => entry.path.startsWith(forbidden)), false);
}
assert.equal(entries.some(entry => entry.path === "drafts/examples/theorem-blocks.qmd"), true);
assert.equal(entries.some(entry => entry.path === "literature/ref.bib"), true);
```

- [ ] **Step 2: Run the asset test and observe RED**

Run: `node --test scripts/chatero/tests/qlab-starter-asset.test.mjs`

Expected: FAIL because Chatero has no starter asset.

- [ ] **Step 3: Implement the deterministic starter builder**

Use this exact source allowlist; do not walk or inspect sibling personal content:

```js
export const STARTER_COPY_PATHS = Object.freeze([
	".gitignore", ".node-version", "AGENTS.md", "CLAUDE.md", "Makefile",
	"README.md", "eslint.config.mjs", "next.config.ts", "package-lock.json",
	"package.json", "playwright.assessment.config.ts",
	"playwright.autoresearch.config.ts", "playwright.config.ts",
	"postcss.config.mjs", "qlab", "tsconfig.json", "vite.config.ts",
	"worker-configuration.d.ts", ".research-loop", "schemas", "skills", "src",
	"public/favicon.svg", "public/og.png", "knowledge/_quarto.yml",
	"drafts/_quarto.yml",
]);
```

Do not include `.openai/hosting.json`. Generate empty Knowledge/Literature entry
points and an English theorem-block Draft containing valid `def`, `lem`, `thm`,
proof, display-math, and citation examples. Sort archive entries bytewise,
normalize timestamps and modes, and write a manifest with per-file SHA-256 plus
an archive SHA-256. The generated starter also adds
`src/app/api/qlab/health/route.ts`; it returns `{ ok: true, repositoryIdentity }`
from the process environment and exposes no filesystem path. Add this exact
package script:

```json
"build:qlab-starter": "node ./scripts/chatero/build-qlab-starter.mjs"
```

- [ ] **Step 4: Generate and inspect the committed starter asset**

Run: `npm run build:qlab-starter -- --source /Users/chance/quarto-lab`

Expected: the command validates every required allowlisted path, reads only
those paths, and writes only public infrastructure plus generated safe content.
It succeeds independently of unrelated personal or dirty files in the source
checkout and never reads personal `knowledge/`, `drafts/`, or `literature/`
files beyond `knowledge/_quarto.yml` and `drafts/_quarto.yml`.

- [ ] **Step 5: Add packaging verification**

Assert `app/scripts/verify_chatero_bundle` requires the manifest and archive inside the staged application resources and verifies their archive digest before reporting success.

- [ ] **Step 6: Run GREEN**

Run: `node --test scripts/chatero/tests/qlab-starter-asset.test.mjs scripts/chatero/tests/dmg-scripts.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add package.json scripts/chatero/build-qlab-starter.mjs scripts/chatero/starter/generated-files.mjs resource/chatero/qlab-starter/research-loop-starter.zip resource/chatero/qlab-starter/manifest.json scripts/chatero/tests/qlab-starter-asset.test.mjs scripts/chatero/tests/dmg-scripts.test.mjs app/scripts/verify_chatero_bundle
git commit -m "build: bundle public Research Loop starter"
```

### Task 3: Non-overwriting Initializer and Private Repository Identity

**Files:**
- Create: `chrome/content/zotero/xpcom/qlab/qlabRepositoryIdentity.js`
- Create: `chrome/content/zotero/xpcom/qlab/qlabRepositoryInitializer.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Create: `scripts/chatero/tests/qlab-repository-identity.test.mjs`
- Create: `scripts/chatero/tests/qlab-repository-initializer.test.mjs`

**Interfaces:**
- Consumes: Task 1 plans and Task 2 manifest/payload assets.
- Produces: `createQLabRepositoryIdentity({ root, host, uuid })`, `createGeckoQLabStarterAssetReader({ manifestURI, archiveURI })`, `createQLabRepositoryInitializer({ host, assetReader, git, now })`, `initializer.execute(plan, onProgress)`, and `initializer.resume(root)`.

- [ ] **Step 1: Write failing identity tests**

Prove exclusive creation, preservation, UUID validation, `0600`, no-follow behavior, Git worktree private paths, and out-of-root rejection:

```js
let first = await QLab.createQLabRepositoryIdentity({ root, host, uuid: () => FIXED_UUID });
let second = await QLab.createQLabRepositoryIdentity({ root, host, uuid: () => OTHER_UUID });
assert.equal(first.identity, FIXED_UUID);
assert.equal(second.identity, FIXED_UUID);
assert.equal(host.mode(identityPath), 0o600);
```

- [ ] **Step 2: Run identity tests and observe RED**

Run: `node --test scripts/chatero/tests/qlab-repository-identity.test.mjs`

Expected: FAIL because the identity service does not exist.

- [ ] **Step 3: Implement identity service and run GREEN**

Use descriptor-relative no-follow operations where Gecko supports them; expose an injected Node host for tests. Create the identity only after Git and repository validation.

Run: `node --test scripts/chatero/tests/qlab-repository-identity.test.mjs`

Expected: PASS.

- [ ] **Step 4: Write failing initializer transaction tests**

Cover zero writes on digest failure, reinspection before execution, byte-and-mode preservation, create-if-absent behavior, idempotence, interrupted receipt, explicit resume, Git-only-if-absent, and progress ordering:

```js
let receipt = await initializer.execute(plan, event => progress.push(event.step));
assert.equal(receipt.state, "ready");
assert.deepEqual(progress, [
	"verify-folder", "verify-starter", "add-missing-files",
	"initialize-git", "verify-repository", "ready",
]);
assert.deepEqual(await snapshotTree(root), beforePlusExpectedCreates);
```

- [ ] **Step 5: Run initializer tests and observe RED**

Run: `node --test scripts/chatero/tests/qlab-repository-initializer.test.mjs`

Expected: FAIL because the initializer does not exist.

- [ ] **Step 6: Implement the initializer**

Read ZIP entries through an injected archive reader, verify all bytes before
target writes, write receipt updates atomically, create only absent entries,
and refuse if any plan target changed. The Gecko adapter uses `nsIZipReader`
against the bundled application resource and never launches `unzip`. Do not
delete created paths on failure. Return
`{ state, root, repositoryIdentity, created, preserved, receiptPath }`.

- [ ] **Step 7: Run focused and baseline tests**

Run: `node --test scripts/chatero/tests/qlab-repository-initializer.test.mjs scripts/chatero/tests/qlab-repository-identity.test.mjs scripts/chatero/tests/qlab-workspace.test.mjs scripts/chatero/tests/qlab-starter-manifest.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add chrome/content/zotero/xpcom/qlab/qlabRepositoryIdentity.js chrome/content/zotero/xpcom/qlab/qlabRepositoryInitializer.js chrome/content/zotero/zotero.mjs scripts/chatero/lib/load-qlab.mjs scripts/chatero/tests/qlab-repository-identity.test.mjs scripts/chatero/tests/qlab-repository-initializer.test.mjs
git commit -m "feat: initialize QLab repositories without overwrites"
```

### Task 4: Native Workspace Setup Center

**Files:**
- Create: `chrome/content/zotero/xpcom/qlab/qlabWorkspaceSetupView.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qlabModule.js`
- Modify: `chrome/content/zotero/zoteroPane.js`
- Modify: `chrome/content/zotero/zoteroPane.xhtml`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Modify: `scss/components/_qlabShell.scss`
- Create: `scripts/chatero/tests/qlab-workspace-setup-view.test.mjs`
- Modify: `scripts/chatero/tests/qlab-tab-lifecycle.test.mjs`

**Interfaces:**
- Consumes: Task 1 inspection/plans and Task 3 initializer progress.
- Produces: `workspaceSetupPresentation(snapshot)`, `createQLabWorkspaceSetupController(options)`, and a Site-tab-compatible setup view with `choose`, `review`, `initialize`, `resume`, `reveal`, and `dispose` actions.

- [ ] **Step 1: Write failing state-presentation tests**

Assert exact actions for missing, empty, partial, incompatible, ready, initializing, and failed states. Confirm incompatible state has no initialize action and the review screen contains `Will add`, `Will preserve`, and `Needs attention`.

- [ ] **Step 2: Run view tests and observe RED**

Run: `node --test scripts/chatero/tests/qlab-workspace-setup-view.test.mjs`

Expected: FAIL because the setup view does not exist.

- [ ] **Step 3: Implement pure presentation and controller**

Use one immutable controller snapshot:

```js
{
	state: "review",
	repositoryState: "partial",
	root,
	plan,
	progress: null,
	error: null,
}
```

Require an explicit second action after plan review before `initializer.execute()`. Closing/hiding the tab does not cancel initialization; restarting after an interrupted receipt returns to review rather than resuming writes.

- [ ] **Step 4: Write failing native wiring tests**

Assert choosing an empty/partial root opens `qlabsite` with setup payload, successful initialization activates the repository identity, refreshes Chat/QMD/Explorer target epochs, and opens `drafts/examples/theorem-blocks.qmd` beside the Site tab.

Also assert target switching remains blocked by a running Agent turn, an
unsaved Visual Edit buffer, or a pending AI proposal; setup never interrupts or
silently discards those states.

- [ ] **Step 5: Run lifecycle tests and observe RED**

Run: `node --test scripts/chatero/tests/qlab-tab-lifecycle.test.mjs scripts/chatero/tests/qlab-workspace-setup-view.test.mjs`

Expected: FAIL because workspace selection still has no native setup flow.

- [ ] **Step 6: Wire the setup controller and accessible light UI**

Keep implementation outside `qlabModule.js`; the module constructs dependencies and mounts/disposes the view only. Add progress steps, inline diagnostics, Copy Diagnostics, Choose Another Folder, and Reveal in Finder without modal loops.

- [ ] **Step 7: Run GREEN and commit Task 4**

Run: `node --test scripts/chatero/tests/qlab-workspace-setup-view.test.mjs scripts/chatero/tests/qlab-tab-lifecycle.test.mjs scripts/chatero/tests/qlab-mount-gate.test.mjs`

Expected: PASS.

```bash
git add chrome/content/zotero/xpcom/qlab/qlabWorkspaceSetupView.js chrome/content/zotero/xpcom/qlab/qlabModule.js chrome/content/zotero/zoteroPane.js chrome/content/zotero/zoteroPane.xhtml chrome/content/zotero/zotero.mjs scripts/chatero/lib/load-qlab.mjs scss/components/_qlabShell.scss scripts/chatero/tests/qlab-workspace-setup-view.test.mjs scripts/chatero/tests/qlab-tab-lifecycle.test.mjs
git commit -m "feat: add native QLab setup center"
```

### Task 5: Per-repository Main Site Service

**Files:**
- Create: `chrome/content/zotero/xpcom/qlab/mainSiteService.js`
- Modify: `chrome/content/zotero/xpcom/qlab/processRunner.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Create: `scripts/chatero/tests/main-site-service.test.mjs`
- Modify: `scripts/chatero/tests/process-runner.test.mjs`

**Interfaces:**
- Consumes: canonical root, repository identity, existing process runner, fetch health adapter, port allocator, dependency resolver, clock, and shutdown signal.
- Produces: `createMainSiteService(runtime)`, `service.observe(identity, listener)`, `service.check(target)`, `service.start(target)`, `service.rebuild(target)`, `service.stop(identity)`, and `service.shutdown()`.

- [ ] **Step 1: Write failing state-machine tests**

Cover preferred port, unrelated 4180 fallback, repository-identity health matching, concurrent Start merging, explicit-action-only start, dependency failure, install/build/start output, early exit, bounded diagnostic tail, last-good URL, owned/external stop policy, and shutdown timeout.

```js
let first = service.start(target);
let second = service.start(target);
assert.equal(first, second);
await first;
assert.equal(runtime.spawnCalls.length, 1);
assert.equal(service.snapshot(identity).state, "ready");
```

- [ ] **Step 2: Run service tests and observe RED**

Run: `node --test scripts/chatero/tests/main-site-service.test.mjs`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Extend ProcessRunner only where required**

Add separate stdout/stderr streaming, cancellation registration, and bounded exit waiting without changing Codex provider behavior. Keep executable and argument arrays separate.

- [ ] **Step 4: Implement MainSiteService**

Use states `idle`, `checking`, `installing`, `building`, `starting`, `ready`,
`stale`, `stopping`, and `error`. Health data must include repository identity.
Prefer port 4180; allocate only from `4181..4199`. Never reuse or terminate an
unrelated process. Require Node.js `22.13.0` or newer and an available Quarto
binary. Run these process stages with separate executable/argument arrays:

```js
[
	{ command: npm, args: ["ci"], cwd: root },
	{ command: npm, args: ["run", "build"], cwd: root },
	{ command: npm, args: ["run", "start", "--", "--hostname", "127.0.0.1", "--port", String(port)], cwd: root },
]
```

The start environment includes only appended safe values plus
`QLAB_REPOSITORY_ID=<identity>`. The generated health route returns that value.
Existing repositories without the route are never guessed to match; an
unidentified external server is treated as unrelated and a fallback port is
used.

- [ ] **Step 5: Run focused tests and existing provider tests**

Run: `node --test scripts/chatero/tests/main-site-service.test.mjs scripts/chatero/tests/process-runner.test.mjs scripts/chatero/tests/codex-cli-provider.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add chrome/content/zotero/xpcom/qlab/mainSiteService.js chrome/content/zotero/xpcom/qlab/processRunner.js chrome/content/zotero/zotero.mjs scripts/chatero/lib/load-qlab.mjs scripts/chatero/tests/main-site-service.test.mjs scripts/chatero/tests/process-runner.test.mjs
git commit -m "feat: supervise local Research Loop sites"
```

### Task 6: Native Main Site Tab and Safe Navigation

**Files:**
- Create: `chrome/content/zotero/xpcom/qlab/mainSiteView.js`
- Modify: `chrome/content/zotero/xpcom/qlab/phase4.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qlabModule.js`
- Modify: `chrome/content/zotero/xpcom/qlab/tabGroups.js`
- Modify: `chrome/content/zotero/tabs.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Modify: `scss/components/_qlabShell.scss`
- Create: `scripts/chatero/tests/main-site-view.test.mjs`
- Modify: `scripts/chatero/tests/tab-restore-integration.test.mjs`

**Interfaces:**
- Consumes: Task 4 setup presentation and Task 5 site service snapshots.
- Produces: `mainSiteNavigationDecision({ currentOrigin, requestedURL })`, `createMainSiteView(document, host, options)`, and a functional `Zotero.QLab.Phase4.openMainSite()` delegation.

- [ ] **Step 1: Write failing navigation-policy tests**

Assert same-origin loopback stays embedded, external HTTPS opens externally, `chatero://`/supported `zotero://` route natively, `file://` and unknown protocols are refused, and userinfo/host-confusion URLs fail closed.

- [ ] **Step 2: Run navigation tests and observe RED**

Run: `node --test scripts/chatero/tests/main-site-view.test.mjs`

Expected: FAIL because the Site view does not exist.

- [ ] **Step 3: Implement Site view and toolbar**

Render Back, Forward, Home, Reload, status, Build & Start/Retry, Open Source Beside Site, and a collapsed Build Log. Create one native remote browser whose allowed origin follows the current service snapshot. Preserve last-good browser content during rebuild failure.

- [ ] **Step 4: Write failing tab lifecycle tests**

Prove fresh UI can open `qlabsite`, tab restore performs health check without auto-start, drag/split/close works, disposal detaches observers, and QLab mount failure leaves native tabs functional.

- [ ] **Step 5: Run lifecycle tests and observe RED**

Run: `node --test scripts/chatero/tests/main-site-view.test.mjs scripts/chatero/tests/tab-restore-integration.test.mjs scripts/chatero/tests/qlab-tab-lifecycle.test.mjs`

Expected: FAIL until Site mount and payload restoration are wired.

- [ ] **Step 6: Replace the Phase 4 placeholder with thin delegation**

`phase4.js` calls the registered Site controller and returns structured errors only when no window/controller exists. `qlabModule.js` mounts and disposes the view but contains no site state machine.

- [ ] **Step 7: Run GREEN and commit Task 6**

Run: `node --test scripts/chatero/tests/main-site-view.test.mjs scripts/chatero/tests/tab-restore-integration.test.mjs scripts/chatero/tests/qlab-tab-lifecycle.test.mjs scripts/chatero/tests/qlab-mount-gate.test.mjs`

Expected: PASS.

```bash
git add chrome/content/zotero/xpcom/qlab/mainSiteView.js chrome/content/zotero/xpcom/qlab/phase4.js chrome/content/zotero/xpcom/qlab/qlabModule.js chrome/content/zotero/xpcom/qlab/tabGroups.js chrome/content/zotero/tabs.js chrome/content/zotero/zotero.mjs scripts/chatero/lib/load-qlab.mjs scss/components/_qlabShell.scss scripts/chatero/tests/main-site-view.test.mjs scripts/chatero/tests/tab-restore-integration.test.mjs
git commit -m "feat: open Main Site in a native Chatero tab"
```

### Task 7: Authority-aware Workspace Document Router

**Files:**
- Create: `chrome/content/zotero/xpcom/qlab/workspaceDocumentRouter.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdExplorer.js`
- Modify: `chrome/content/zotero/zotero.mjs`
- Modify: `scripts/chatero/lib/load-qlab.mjs`
- Modify: `scripts/chatero/tests/qmd-explorer.test.mjs`
- Create: `scripts/chatero/tests/workspace-document-router.test.mjs`

**Interfaces:**
- Consumes: Explorer nodes, safe relative path policy, selected canonical root, Zotero attachment lookup, and native tab bridges.
- Produces: `classifyWorkspaceDocument(relativePath)`, `workspaceDocumentOpenDecision(input)`, `knowledgeURLToQmdPath(input)`, and `createWorkspaceDocumentRouter(bridges).open(input)`.

- [ ] **Step 1: Write failing Explorer metadata tests**

Assert every file node includes exact authority and default mode:

```js
assert.deepEqual(project(node), {
	path: "knowledge/topic.qmd",
	kind: "qmd",
	authority: "knowledge",
	openMode: "site",
	writable: false,
});
```

- [ ] **Step 2: Run Explorer tests and observe RED**

Run: `node --test scripts/chatero/tests/qmd-explorer.test.mjs`

Expected: FAIL because authority/openMode metadata is absent.

- [ ] **Step 3: Implement Explorer metadata**

Support `literature/**/*.md` in addition to QMD, BibTeX, and PDF. Preserve current symlink and depth protections.

- [ ] **Step 4: Write failing router-decision tests**

Cover Draft edit, Knowledge site/read-only source, Literature read-only QMD/Markdown/Bib, matched PDF Reader reuse, unmatched PDF review prompt, foreign roots, unsupported extensions, safe Knowledge URL mapping, directory indexes, query/fragment stripping, and traversal refusal.

- [ ] **Step 5: Run router tests and observe RED**

Run: `node --test scripts/chatero/tests/workspace-document-router.test.mjs`

Expected: FAIL because the router does not exist.

- [ ] **Step 6: Implement the pure decisions and bridge dispatcher**

Return actions from the closed set `open-draft`, `open-readonly-qmd`, `open-readonly-bib`, `open-knowledge-site`, `open-native-reader`, `review-pdf-link`, or `refuse`. Never let untrusted file metadata select an arbitrary executable or URL.

- [ ] **Step 7: Run GREEN and commit Task 7**

Run: `node --test scripts/chatero/tests/qmd-explorer.test.mjs scripts/chatero/tests/workspace-document-router.test.mjs`

Expected: PASS.

```bash
git add chrome/content/zotero/xpcom/qlab/workspaceDocumentRouter.js chrome/content/zotero/xpcom/qlab/qmdExplorer.js chrome/content/zotero/zotero.mjs scripts/chatero/lib/load-qlab.mjs scripts/chatero/tests/qmd-explorer.test.mjs scripts/chatero/tests/workspace-document-router.test.mjs
git commit -m "feat: route QLab documents by authority"
```

### Task 8: Read-only QMD and BibTeX Surfaces

**Files:**
- Modify: `chrome/content/zotero/xpcom/qlab/qmdDraftSession.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdMonacoBridge.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js`
- Modify: `chrome/content/zotero/qlab/qmdMonaco.html`
- Modify: `scss/components/_qlabShell.scss`
- Create: `scripts/chatero/tests/qmd-readonly-session.test.mjs`
- Modify: `scripts/chatero/tests/qmd-workspace-shell.test.mjs`
- Modify: `scripts/chatero/tests/qmd-monaco-bridge.test.mjs`

**Interfaces:**
- Consumes: Task 7 `open-readonly-qmd` and `open-readonly-bib` actions.
- Produces: `openWorkspaceDocument({ relativePath, authority, format, readOnly })`, read-only Monaco model options, and authority-specific toolbar presentation.

- [ ] **Step 1: Write failing read-only session tests**

Prove Knowledge/Literature sessions can read and externally reload but cannot autosave, mutate source, attach/Keep proposals, complete gaps, promote, insert blocks, or open a writable external editor:

```js
let session = QLab.createQmdDocumentSession({ readOnly: true, text: source, revision: "r1" });
assert.throws(() => session.applyHumanEdit("changed"), /read-only/i);
assert.equal(session.snapshot().text, source);
```

- [ ] **Step 2: Run session tests and observe RED**

Run: `node --test scripts/chatero/tests/qmd-readonly-session.test.mjs`

Expected: FAIL because only editable Draft sessions exist.

- [ ] **Step 3: Implement read-only document session and Monaco bridge**

Use a separate constructor or explicit immutable mode; do not weaken Draft behavior. Monaco receives `readOnly: true`, Visual cards never enter source editing, and Website Preview remains navigable.

- [ ] **Step 4: Write failing workspace presentation tests**

Assert Trusted Knowledge and External Evidence badges, read-only tooltip, hidden mutation controls, visible Visual/Website/Source cycle for QMD, and Source-only citekey-search presentation for BibTeX.

- [ ] **Step 5: Run shell tests and observe RED**

Run: `node --test scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/qmd-monaco-bridge.test.mjs`

Expected: FAIL until the workspace accepts read-only router actions.

- [ ] **Step 6: Wire read-only surfaces without widening `openDraft()`**

Keep `openDraft(relativePath)` restricted to `drafts/`. Add `openWorkspaceDocument(spec)` beside it and route read-only QMD/Bib through guarded reads. Ensure every DOM event handler checks session capabilities, not just hidden buttons.

- [ ] **Step 7: Run GREEN and commit Task 8**

Run: `node --test scripts/chatero/tests/qmd-readonly-session.test.mjs scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/qmd-monaco-bridge.test.mjs scripts/chatero/tests/qmd-three-surface-integration.test.mjs`

Expected: PASS.

```bash
git add chrome/content/zotero/xpcom/qlab/qmdDraftSession.js chrome/content/zotero/xpcom/qlab/qmdMonacoBridge.js chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js chrome/content/zotero/qlab/qmdMonaco.html scss/components/_qlabShell.scss scripts/chatero/tests/qmd-readonly-session.test.mjs scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/qmd-monaco-bridge.test.mjs
git commit -m "feat: open trusted and evidence documents read-only"
```

### Task 9: Explorer, Site Source, Reader, Split, and Session Integration

**Files:**
- Modify: `chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js`
- Modify: `chrome/content/zotero/xpcom/qlab/mainSiteView.js`
- Modify: `chrome/content/zotero/xpcom/qlab/qlabModule.js`
- Modify: `chrome/content/zotero/xpcom/qlab/arrangement.js`
- Modify: `chrome/content/zotero/xpcom/qlab/tabGroups.js`
- Modify: `chrome/content/zotero/tabs.js`
- Modify: `chrome/content/zotero/zoteroPane.js`
- Modify: `scripts/chatero/tests/qmd-workspace-shell.test.mjs`
- Modify: `scripts/chatero/tests/arrangement.test.mjs`
- Modify: `scripts/chatero/tests/tab-restore-integration.test.mjs`
- Create: `scripts/chatero/tests/repository-site-routing.integration.test.mjs`

**Interfaces:**
- Consumes: Tasks 4, 6, 7, and 8 controllers/actions.
- Produces: complete native user flow from workspace selection or Explorer/site click to Site/QMD/Reader tabs with `current` or `beside` placement and restorable payloads.

- [ ] **Step 1: Write the failing end-to-end Node integration test**

Exercise a temporary ready repository through Explorer clicks:

```js
await shell.click("drafts/a.qmd");
assert.equal(native.lastAction.kind, "open-draft");
await shell.click("knowledge/topic.qmd");
assert.equal(native.lastAction.kind, "open-knowledge-site");
await site.openSourceBeside();
assert.deepEqual(native.panes(), ["qlabsite", "qlabqmd"]);
await shell.click("literature/paper.pdf");
assert.equal(native.readerItemID, 42);
```

- [ ] **Step 2: Run the integration test and observe RED**

Run: `node --test scripts/chatero/tests/repository-site-routing.integration.test.mjs`

Expected: FAIL because the modules are not wired through native tabs.

- [ ] **Step 3: Wire Explorer and Quick Open to the router**

Use one delegated row click handler and make folder expansion independent of file opening. Refresh after initialization and external changes without remounting the active document.

- [ ] **Step 4: Wire Site source beside the current tab**

Use the existing content-group arrangement model. Keep Site mounted, ensure the singleton QMD tab, open the read-only Knowledge source, and select the adjacent group. Missing mapping shows inline feedback and leaves the page unchanged.

- [ ] **Step 5: Wire Literature PDF decisions to native Reader**

Reuse an existing attachment Reader when the file uniquely matches. For unmatched or ambiguous files, display a review action; do not create an item in this phase.

- [ ] **Step 6: Persist and restore safe payloads**

Persist relative path, authority, format, safe site path, and repository identity. On restore, revalidate against the current root and fall back to Site/Explorer empty state rather than opening stale absolute paths or auto-starting a server.

- [ ] **Step 7: Run focused layout and integration tests**

Run: `node --test scripts/chatero/tests/repository-site-routing.integration.test.mjs scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/arrangement.test.mjs scripts/chatero/tests/tab-restore-integration.test.mjs scripts/chatero/tests/qlab-tab-lifecycle.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit Task 9**

```bash
git add chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js chrome/content/zotero/xpcom/qlab/mainSiteView.js chrome/content/zotero/xpcom/qlab/qlabModule.js chrome/content/zotero/xpcom/qlab/arrangement.js chrome/content/zotero/xpcom/qlab/tabGroups.js chrome/content/zotero/tabs.js chrome/content/zotero/zoteroPane.js scripts/chatero/tests/qmd-workspace-shell.test.mjs scripts/chatero/tests/arrangement.test.mjs scripts/chatero/tests/tab-restore-integration.test.mjs scripts/chatero/tests/repository-site-routing.integration.test.mjs
git commit -m "feat: connect repository documents to native tabs"
```

### Task 10: Whole-phase Verification, Packaging, and Acceptance Record

**Files:**
- Create: `docs/superpowers/2026-08-09-native-repository-site-routing-findings.md`
- Modify: `docs/chatero/parity-checklist.md`

**Interfaces:**
- Consumes: all phase deliverables.
- Produces: verified test/build/package evidence and a manual macOS checklist that uses temporary fixtures only.

- [ ] **Step 1: Run the complete Chatero unit/integration suite**

Run: `npm run test:chatero`

Expected: all tests pass with zero failures and no unhandled rejection.

- [ ] **Step 2: Build Chatero from a clean source state**

Run: `npm run build`

Expected: exit 0 and generated product metadata identifies Chatero.

- [ ] **Step 3: Stage and verify the application bundle**

Run: `npm run test:chatero:staged`

Expected: exit 0; the staged application contains the QLab starter manifest/archive, new QLab scripts, Monaco assets, and Chatero identity.

- [ ] **Step 4: Package the personal-development DMG**

Run: `npm run package:chatero`

Expected: exit 0 and a new Chatero `.dmg` is produced without touching the user's installed application.

- [ ] **Step 5: Publish the ten-item macOS acceptance checklist for the user**

The checklist uses two temporary directories and one temporary Zotero item/PDF.
It asks the user to record exact pass/fail evidence for empty initialization,
content preservation hashes, incompatible refusal, interrupted resume, Main
Site build/display, Site layout lifecycle, every document type, Source Beside
Site, repository switching, and owned-process shutdown. Do not operate the
user's graphical Chatero session in this task.

- [ ] **Step 6: Update the parity checklist from evidence**

Mark only Repository Initialize, Main Site, and Knowledge/Literature opening as complete. Leave phases 2–6 incomplete. Link the findings file and record any native-only limitations explicitly.

- [ ] **Step 7: Re-run verification after any regression fixes**

Run: `npm run test:chatero && npm run build && npm run test:chatero:staged`

Expected: all commands exit 0.

- [ ] **Step 8: Commit Task 10**

```bash
git add docs/superpowers/2026-08-09-native-repository-site-routing-findings.md docs/chatero/parity-checklist.md
git commit -m "test: verify native repository and site workflow"
```

---

## Plan Self-review Checklist

- Every design requirement maps to at least one task: Tasks 1–4 cover initialization, Tasks 5–6 cover Main Site, Tasks 7–9 cover document routing, and Task 10 covers native acceptance.
- All cross-task interfaces use the same names as their producing task.
- No task writes personal repository content or starts from a personal fixture.
- Each production task contains an explicit RED command before implementation and a GREEN command after implementation.
- Every task ends in an independently reviewable commit.
- Phase 2 does not leak into this plan: unmatched PDFs stop at reviewed linking, and Zotero Literature/ref.bib synchronization remains out of scope.
