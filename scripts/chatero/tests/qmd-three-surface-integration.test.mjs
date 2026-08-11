import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

function disposableResource(name, calls) {
	return {
		name,
		dispose() {
			calls.push(name);
		},
	};
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function workspaceElement(extra = {}) {
	const attributes = new Map();
	const classes = new Set();
	return {
		hidden: false,
		disabled: false,
		textContent: "",
		value: "",
		dataset: {},
		style: {},
		children: [],
		classList: {
			toggle(name, force) {
				const enabled = force === undefined ? !classes.has(name) : !!force;
				if (enabled) classes.add(name);
				else classes.delete(name);
				return enabled;
			},
			contains: name => classes.has(name),
		},
		setAttribute(name, value) { attributes.set(name, String(value)); },
		removeAttribute(name) { attributes.delete(name); },
		getAttribute(name) { return attributes.get(name) || ""; },
		replaceChildren(...children) { this.children = children; },
		querySelector() { return null; },
		querySelectorAll() { return []; },
		addEventListener() {},
		removeEventListener() {},
		...extra,
	};
}

async function mountProductionWorkspace(QLab, t, {
	readReadonly,
	throwReadonlyMonaco = false,
	throwReadonlyReloadMonaco = false,
	flushDraft = null,
	readDraft = null,
	findDraftProposal = null,
	failReadonlyResourceCommit = false,
	trackTimers = false,
	throwVisualClear = false,
} = {}) {
	const readonly = readonlyManagerHarness(QLab, { read: readReadonly });
	const root = readonly.root;
	const visualTitle = workspaceElement({ textContent: "VISUAL EDIT" });
	const visualPane = workspaceElement({
		querySelector: selector => selector === ".qlab-qmd-pane-title span" ? visualTitle : null,
	});
	const formalMenu = workspaceElement({ hidden: true });
	const formalToggle = workspaceElement({ hidden: true });
	const visualTools = workspaceElement({
		querySelector(selector) {
			if (selector === "[data-qlab-formal-menu]") return formalMenu;
			if (selector === "[data-qlab-formal-toggle]") return formalToggle;
			return null;
		},
	});
	const surfaceToggleLabel = workspaceElement();
	const surfaceToggle = workspaceElement({
		querySelector: selector => selector === ".sr-only" ? surfaceToggleLabel : null,
	});
	const nodes = new Map([
		[".qlab-qmd-workspace", workspaceElement()],
		["[data-qlab-primary-surface]", workspaceElement()],
		["[data-qlab-visual-surface]", visualPane],
		["[data-qlab-source-surface]", workspaceElement()],
		["[data-qlab-preview-surface]", workspaceElement()],
		["[data-qlab-visual-tools]", visualTools],
		["[data-qlab-preview-toggle]", surfaceToggle],
		["[data-qlab-qmd-status]", workspaceElement()],
		["[data-qlab-qmd-monaco]", workspaceElement({ title: "QMD source editor" })],
		["[data-qlab-visual-editor-root]", workspaceElement()],
		["[data-qlab-draft-path]", workspaceElement({ textContent: "drafts/active.qmd", title: "drafts/active.qmd" })],
		["[data-qlab-editor-tab]", workspaceElement({ textContent: "active.qmd" })],
		["[data-qlab-draft]", workspaceElement({ value: "drafts/active.qmd" })],
		["[data-qlab-editor]", workspaceElement({ value: "" })],
		["[data-qlab-dirty-dot]", workspaceElement({ hidden: true })],
		["[data-qlab-authority-badge]", workspaceElement({ textContent: "Draft" })],
		[".qlab-qmd-path-wrap", workspaceElement()],
		[".qlab-qmd-authority", workspaceElement()],
		[".qlab-qmd-tab-q", workspaceElement({ textContent: "Q" })],
		["[data-qlab-inline]", workspaceElement({ hidden: true })],
		["[data-qlab-inline-prompt]", workspaceElement()],
		["[data-qlab-pending]", workspaceElement({ hidden: true })],
		["[data-qlab-compliance]", workspaceElement()],
		["[data-qlab-compliance-details]", workspaceElement({ hidden: true })],
		["[data-qlab-formal-menu]", formalMenu],
		["[data-qlab-formal-toggle]", formalToggle],
		["[data-qlab-bib-search]", workspaceElement({ hidden: true })],
		[".qlab-qmd-preview-versions", workspaceElement({ hidden: true })],
	]);
	const tabWrites = [];
	const timerState = { scheduled: [], cleared: [] };
	let nextTimer = 0;
	const view = {
		setTimeout: trackTimers
			? (callback, delay) => {
				const id = Object.freeze({ id: ++nextTimer, callback, delay });
				timerState.scheduled.push(id);
				return id;
			}
			: setTimeout,
		clearTimeout: trackTimers
			? id => { timerState.cleared.push(id); }
			: clearTimeout,
		Zotero_Tabs: {
			_qlab: {},
			setTabData(_tabID, data) {
				tabWrites.push(data);
			},
		},
	};
	const document = { defaultView: view };
	const host = workspaceElement({
		ownerDocument: document,
		_qlabMountTabID: "qmd-test",
		querySelector: selector => nodes.get(selector) || null,
		querySelectorAll(selector) {
			const node = nodes.get(selector);
			return node ? [node] : [];
		},
	});

	const replacements = [];
	function replace(target, key, value) {
		replacements.push([target, key, target[key]]);
		target[key] = value;
	}
	t.after(() => {
		for (const [target, key, value] of replacements.reverse()) target[key] = value;
	});

	let draftSession;
	let readonlySession;
	let draftDisposals = 0;
	let readonlyDisposals = 0;
	const originalCreateDraft = QLab.createQmdDraftSession;
	const originalCreateReadonly = QLab.createQmdDocumentSession;
	replace(QLab, "createQmdDraftSession", options => {
		draftSession = originalCreateDraft({
			...options,
			onState(snapshot) {
				if (snapshot.disposed) draftDisposals += 1;
				options.onState?.(snapshot);
			},
		});
		return draftSession;
	});
	replace(QLab, "createQmdDocumentSession", options => {
		readonlySession = originalCreateReadonly({
			...options,
			onState(snapshot) {
				if (snapshot.disposed) readonlyDisposals += 1;
				options.onState?.(snapshot);
			},
		});
		return readonlySession;
	});

	const visualState = { path: "", writes: [] };
	const visualEditor = {
		root: workspaceElement(),
		setDocument(current, descriptor) {
			if (throwVisualClear && !descriptor) {
				throw new Error("visual neutralization failure");
			}
			visualState.path = descriptor?.relativePath || "";
			visualState.writes.push(visualState.path);
			if (throwReadonlyMonaco && descriptor?.readOnly) {
				// The separate Monaco throw occurs after the Visual bridge has switched.
			}
			visualState.source = current.source;
		},
		snapshot: () => ({ source: visualState.source || "" }),
		isEditing: () => false,
		finishActiveEdit: async () => true,
		dispose() {},
	};
	replace(QLab, "createQmdVisualEditor", () => visualEditor);

	const previewSurfaceState = { mode: "empty", clears: 0, writes: 0 };
	const previewSurface = {
		showQuick() { previewSurfaceState.writes += 1; previewSurfaceState.mode = "quick"; },
		showExact() { previewSurfaceState.writes += 1; previewSurfaceState.mode = "exact"; },
		showEmpty() { previewSurfaceState.writes += 1; previewSurfaceState.mode = "empty"; },
		clear() {
			previewSurfaceState.clears += 1;
			previewSurfaceState.mode = "empty";
			return true;
		},
		dispose() {},
	};
	replace(QLab, "createQmdPreviewSurface", () => previewSurface);
	let draftPreviewDisposals = 0;
	let draftPreviewRetries = 0;
	let draftPreview;
	replace(QLab, "createQmdPreviewController", options => {
		const state = {
			status: "ready",
			url: "",
			fallback: "<main>active draft</main>",
		};
		draftPreview = {
			async start() { options.onState(state); return true; },
			async retry() { draftPreviewRetries += 1; options.onState(state); return true; },
			async refresh() { options.onState(state); return true; },
			setVisible() { return Promise.resolve(true); },
			snapshot: () => state,
			dispose() { draftPreviewDisposals += 1; },
		};
		return draftPreview;
	});

	let monacoOptions;
	const monacoState = { path: "", writes: [] };
	let readonlyMonacoWrites = 0;
	replace(QLab, "createQmdMonacoFrameAdapter", () => ({}));
	replace(QLab, "createQmdMonacoBridge", options => {
		monacoOptions = options;
		return {
			showNormal() {
				const snapshot = monacoOptions.session.snapshot();
				monacoState.path = snapshot.path || "";
				monacoState.writes.push(monacoState.path);
				if (snapshot.document?.readOnly) readonlyMonacoWrites += 1;
				if (throwReadonlyMonaco && snapshot.document?.readOnly) {
					throw new Error("late readonly Monaco activation failure");
				}
				if (throwReadonlyReloadMonaco && snapshot.document?.readOnly
						&& readonlyMonacoWrites > 1) {
					throw new Error("readonly Monaco reload failure");
				}
				return true;
			},
			clear() {
				monacoState.path = "";
				monacoState.writes.push("");
				return true;
			},
			showDiff() { return true; },
			showSearch() { return true; },
			setDiagnostics() { return true; },
			revealRange() { return true; },
			dispose() {},
		};
	});

	const watcher = {
		start: async () => true,
		poll: async () => true,
		dispose() {},
	};
	replace(QLab, "createQmdExplorerWatcher", () => watcher);
	replace(QLab, "createGeckoQmdExplorerHost", () => ({}));
	replace(QLab.QmdDraftIO, "createGeckoHost", () => ({}));
	if (flushDraft) replace(QLab, "flushQmdDraftBeforeTransition", flushDraft);
	replace(QLab.QmdDraftIO, "readSource", readDraft || (async () => ({
		text: "active draft\n",
		revision: "draft-r1",
	})));
	replace(QLab.QmdDraftIO, "findProposal", findDraftProposal || (async () => null));

	let mountedManager;
	const originalCreateManager = QLab.createQmdWorkspaceDocumentManager;
	replace(QLab, "createQmdWorkspaceDocumentManager", options => {
		mountedManager = originalCreateManager(options);
		return mountedManager;
	});
	let controllerResources;
	const originalCreateController = QLab.createQmdWorkspaceController;
	replace(QLab, "createQmdWorkspaceController", options => {
		controllerResources = {
			watcher: options.watcher,
			monaco: options.monaco,
			visual: options.visual,
			preview: options.preview,
			session: options.session,
		};
		const controller = originalCreateController(options);
		const originalSetResources = controller.setResources.bind(controller);
		controller.setResources = next => {
			const result = originalSetResources(next);
			if (result) Object.assign(controllerResources, next);
			return result;
		};
		const originalBeginResourceTransaction = controller.beginResourceTransaction.bind(controller);
		controller.beginResourceTransaction = next => {
			const previous = { ...controllerResources };
			const transaction = originalBeginResourceTransaction(next);
			return Object.freeze({
				apply() {
					const result = transaction.apply();
					if (result) Object.assign(controllerResources, next);
					return result;
				},
				commit: () => failReadonlyResourceCommit
					&& next.session?.snapshot?.().document?.readOnly === true
					? false
					: transaction.commit(),
				rollback() {
					const result = transaction.rollback();
					if (result) controllerResources = previous;
					return result;
				},
			});
		};
		return controller;
	});

	const workspace = await QLab.mountQmdWorkspace(host, {
		root,
		initialPath: "drafts/active.qmd",
		readonlyDocumentIO: readonly.io,
	});
	return {
		root,
		readonly,
		host,
		nodes,
		workspace,
		manager: () => mountedManager,
		draftSession: () => draftSession,
		readonlySession: () => readonlySession,
		controllerResources: () => controllerResources,
		visualState,
		monacoState,
		previewSurfaceState,
		draftPreview: () => draftPreview,
		disposals: () => ({ draft: draftDisposals, readonly: readonlyDisposals, preview: draftPreviewDisposals }),
		draftPreviewRetries: () => draftPreviewRetries,
		tabWrites,
		timerState,
	};
}

function readonlyCapability(root, relativePath, classification, access) {
	return Object.freeze({
		root,
		relativePath,
		canonicalPath: `${root}/${relativePath}`,
		authority: classification.authority,
		kind: classification.kind,
		writable: false,
		access,
	});
}

function readonlyManagerHarness(QLab, { read } = {}) {
	const root = "/repo";
	const active = new WeakSet();
	const issue = relativePath => {
		const access = Object.freeze({ relativePath, sequence: Math.random() });
		active.add(access);
		return readonlyCapability(
			root,
			relativePath,
			QLab.classifyWorkspaceDocument(relativePath),
			access,
		);
	};
	const io = QLab.createReadonlyDocumentIO({
		root,
		host: {
			verifyAccess: access => active.has(access),
			realPath: async value => value,
			readVerified: async (_access, capability) => ({
				text: await (read || (async path => path.endsWith("topic.qmd") ? "# Trusted\n" : "# Evidence\n"))(
					capability.canonicalPath,
				),
				size: 10,
				lastModified: 1,
			}),
		},
		acquireVerifiedDocument: async request => issue(request.relativePath),
		releaseVerifiedDocument: async capability => {
			active.delete(capability.access);
			return true;
		},
	});
	return { root, active, issue, io };
}

test("three resident surface resources survive a complete mode cycle", async () => {
	const QLab = await loadQLab();
	let disposals = [];
	let resources = {
		watcher: disposableResource("watcher", disposals),
		monaco: disposableResource("monaco", disposals),
		visual: disposableResource("visual", disposals),
		preview: disposableResource("preview", disposals),
		session: disposableResource("session", disposals),
	};
	let workspace = QLab.createQmdWorkspaceController(resources);

	workspace.toggleSurface();
	workspace.toggleSurface();
	workspace.toggleSurface();

	assert.equal(workspace.snapshot().surface, "visual");
	assert.deepEqual(disposals, [], "a surface switch must not dispose a resident resource");

	workspace.dispose();
	assert.deepEqual(
		disposals,
		["watcher", "monaco", "visual", "preview", "session"],
		"a standalone controller owns its explicitly supplied resident resources",
	);
});

test("Website Preview starts once on first entry and remains warm across mode changes", async () => {
	const QLab = await loadQLab();
	let starts = 0;
	let pendingVisibility = [];
	let preview = QLab.createQmdPreviewController({
		root: "/tmp/qlab",
		path: "drafts/note.qmd",
		visible: false,
		startPreview: async () => {
			starts++;
			return "http://127.0.0.1:43104/note.html";
		},
		stopPreview: () => {},
	});
	let workspace = QLab.createQmdWorkspaceController({
		preview,
		onLayout(state) {
			pendingVisibility.push(preview.setVisible(state.surface === "website"));
		},
	});

	await preview.start();
	assert.equal(starts, 0, "the hidden Website surface must defer Quarto startup");

	workspace.toggleSurface(); // Visual Edit -> Website Preview
	await Promise.all(pendingVisibility.splice(0));
	assert.equal(starts, 1);
	assert.equal(preview.snapshot().status, "ready");

	workspace.toggleSurface(); // Website Preview -> Monaco Source
	workspace.toggleSurface(); // Monaco Source -> Visual Edit
	workspace.toggleSurface(); // Visual Edit -> Website Preview
	await Promise.all(pendingVisibility.splice(0));

	assert.equal(starts, 1, "returning to a warm Website surface must reuse Quarto");
	assert.equal(preview.snapshot().url, "http://127.0.0.1:43104/note.html");
	workspace.dispose();
});

test("legacy previewVisible layout state migrates without changing its meaning", async () => {
	const QLab = await loadQLab();
	assert.equal(
		QLab.createQmdWorkspaceController({ previewVisible: true }).snapshot().surface,
		"website",
	);
	assert.equal(
		QLab.createQmdWorkspaceController({ previewVisible: false }).snapshot().surface,
		"source",
	);
	assert.equal(
		QLab.createQmdWorkspaceController().snapshot().surface,
		"visual",
	);
	assert.equal(
		QLab.createQmdWorkspaceController({
			surface: "visual",
			previewVisible: true,
		}).snapshot().surface,
		"visual",
		"the explicit three-surface state wins over the retired boolean",
	);
});

test("Original or Proposed selection is independent from surface cycling", async () => {
	const QLab = await loadQLab();
	let workspace = QLab.createQmdWorkspaceController({
		surface: "visual",
		versionTarget: "proposed",
	});

	assert.equal(workspace.snapshot().versionTarget, "proposed");
	workspace.toggleSurface();
	assert.equal(workspace.snapshot().surface, "website");
	assert.equal(workspace.snapshot().versionTarget, "proposed");
	workspace.toggleSurface();
	assert.equal(workspace.snapshot().surface, "source");
	assert.equal(workspace.snapshot().versionTarget, "proposed");
	workspace.toggleSurface();
	assert.equal(workspace.snapshot().surface, "visual");
	assert.equal(workspace.snapshot().versionTarget, "proposed");
});

test("workspace document manager opens only the path-classified readonly document from verified bytes", async () => {
	const QLab = await loadQLab();
	const harness = readonlyManagerHarness(QLab);
	const manager = QLab.createQmdWorkspaceDocumentManager({
		root: harness.root,
		readonlyIO: harness.io,
	});
	const relativePath = "knowledge/topic.qmd";
	const opened = await manager.openWorkspaceDocument({
		relativePath,
		authority: "draft",
		format: "bibtex",
		readOnly: false,
	}, harness.issue(relativePath));

	assert.equal(opened, true);
	const snapshot = manager.snapshot();
	assert.equal(snapshot.document.relativePath, relativePath);
	assert.equal(snapshot.document.authority, "knowledge");
	assert.equal(snapshot.document.format, "qmd");
	assert.equal(snapshot.document.readOnly, true);
	assert.equal(snapshot.session.snapshot().text, "# Trusted\n");
	assert.equal(Object.isFrozen(snapshot.document), true);
});

test("workspace document manager fails closed without an injected verified readonly adapter", async () => {
	const QLab = await loadQLab();
	assert.throws(
		() => QLab.createQmdWorkspaceDocumentManager({ root: "/repo" }),
		/verified read-only IO/i,
	);
});

test("workspace document manager rejects a verified IO identity bound to another root", async () => {
	const QLab = await loadQLab();
	const foreign = readonlyManagerHarness(QLab);
	assert.throws(
		() => QLab.createQmdWorkspaceDocumentManager({
			root: "/another-repository",
			readonlyIO: foreign.io,
		}),
		/root|identity|verified read-only IO/i,
	);
});

test("workspace document manager rejects copied methods with forged public identity fields", async () => {
	const QLab = await loadQLab();
	const verified = readonlyManagerHarness(QLab);
	const forged = Object.freeze({
		read: verified.io.read,
		reload: verified.io.reload,
		root: verified.root,
		canonicalRoot: verified.root,
		workspaceIdentity: Object.freeze({ trusted: true }),
	});
	assert.throws(
		() => QLab.createQmdWorkspaceDocumentManager({
			root: verified.root,
			readonlyIO: forged,
		}),
		/identity|verified read-only IO/i,
	);
});

test("a newer readonly open invalidates an older in-flight reload before the new read finishes", async () => {
	const QLab = await loadQLab();
	const reloadA = deferred();
	const openB = deferred();
	let readsA = 0;
	let reloadStarted;
	let openBStarted;
	const sawReload = new Promise(resolve => { reloadStarted = resolve; });
	const sawOpenB = new Promise(resolve => { openBStarted = resolve; });
	const harness = readonlyManagerHarness(QLab, {
		read: async path => {
			if (path.endsWith("knowledge/topic.qmd")) {
				readsA += 1;
				if (readsA === 1) return "A original\n";
				reloadStarted();
				return reloadA.promise;
			}
			openBStarted();
			return openB.promise;
		},
	});
	const manager = QLab.createQmdWorkspaceDocumentManager({
		root: harness.root,
		readonlyIO: harness.io,
	});
	const pathA = "knowledge/topic.qmd";
	const pathB = "literature/paper.md";
	assert.equal(await manager.openWorkspaceDocument({ relativePath: pathA }, harness.issue(pathA)), true);

	const staleReload = manager.reloadActive();
	await sawReload;
	const newerOpen = manager.openWorkspaceDocument({ relativePath: pathB }, harness.issue(pathB));
	await sawOpenB;
	reloadA.resolve("A stale reload\n");
	assert.equal(await staleReload, false);
	assert.equal(manager.snapshot().session.snapshot().text, "A original\n");

	openB.resolve("B current\n");
	assert.equal(await newerOpen, true);
	assert.equal(manager.snapshot().document.relativePath, pathB);
	assert.equal(manager.snapshot().session.snapshot().text, "B current\n");
});

test("an invalidated readonly reload rejection is stale completion, not a current error", async () => {
	const QLab = await loadQLab();
	const reloadA = deferred();
	let readsA = 0;
	let reloadStarted;
	const sawReload = new Promise(resolve => { reloadStarted = resolve; });
	const harness = readonlyManagerHarness(QLab, {
		read: async path => {
			if (path.endsWith("knowledge/topic.qmd")) {
				readsA += 1;
				if (readsA === 1) return "A original\n";
				reloadStarted();
				return reloadA.promise;
			}
			return "B current\n";
		},
	});
	const manager = QLab.createQmdWorkspaceDocumentManager({
		root: harness.root,
		readonlyIO: harness.io,
	});
	const pathA = "knowledge/topic.qmd";
	const pathB = "literature/paper.md";
	assert.equal(await manager.openWorkspaceDocument({ relativePath: pathA }, harness.issue(pathA)), true);

	const staleReload = manager.reloadActive();
	await sawReload;
	assert.equal(await manager.openWorkspaceDocument({ relativePath: pathB }, harness.issue(pathB)), true);
	reloadA.reject(new Error("stale A reload failed"));

	assert.equal(await staleReload, false);
	assert.equal(manager.snapshot().document.relativePath, pathB);
	assert.equal(manager.snapshot().session.snapshot().text, "B current\n");
});

test("a newer same-document reload cannot be overwritten by an older completion", async () => {
	const QLab = await loadQLab();
	const older = deferred();
	const newer = deferred();
	let reads = 0;
	let firstStarted;
	let secondStarted;
	const sawFirst = new Promise(resolve => { firstStarted = resolve; });
	const sawSecond = new Promise(resolve => { secondStarted = resolve; });
	const harness = readonlyManagerHarness(QLab, {
		read: async () => {
			reads += 1;
			if (reads === 1) return "original\n";
			if (reads === 2) {
				firstStarted();
				return older.promise;
			}
			secondStarted();
			return newer.promise;
		},
	});
	const manager = QLab.createQmdWorkspaceDocumentManager({
		root: harness.root,
		readonlyIO: harness.io,
	});
	const relativePath = "knowledge/topic.qmd";
	assert.equal(await manager.openWorkspaceDocument(
		{ relativePath },
		harness.issue(relativePath),
	), true);

	const olderReload = manager.reloadActive();
	await sawFirst;
	const newerReload = manager.reloadActive();
	await sawSecond;
	newer.resolve("newer\n");
	assert.equal(await newerReload, true);
	assert.equal(manager.snapshot().session.snapshot().text, "newer\n");

	older.resolve("older\n");
	assert.equal(await olderReload, false);
	assert.equal(manager.snapshot().session.snapshot().text, "newer\n");
});

test("opening readonly clears all Draft-only host state before activation", async () => {
	const QLab = await loadQLab();
	const harness = readonlyManagerHarness(QLab);
	let cancelled = 0;
	let aborted = 0;
	const inline = { hidden: false };
	const inlinePrompt = { value: "rewrite this" };
	const pending = { hidden: false, replaceChildren() { this.cleared = true; } };
	const compliance = { hidden: false, disabled: false, dataset: { compliance: "failed" }, title: "Failed" };
	const complianceDetails = { hidden: false, textContent: "stale Draft diagnostics" };
	const formalMenu = { hidden: false };
	const formalToggle = {
		hidden: false,
		disabled: false,
		ariaExpanded: "true",
		setAttribute(name, value) {
			if (name === "aria-expanded") this.ariaExpanded = value;
		},
	};
	const visualTools = { hidden: false };
	const mutationControls = Array.from({ length: 8 }, () => ({ hidden: false, disabled: false }));
	const host = {
		_qlabDraftState: { originalPath: "drafts/a.qmd", workingPath: "work/proposal.qmd" },
		_qlabPendingInserts: [{ id: "stale" }],
		_qlabActiveBlockIndex: 2,
		_qlabMonacoSelection: { start: 1, end: 3, text: "stale" },
		_qlabDirty: true,
		_qlabLastSaved: "Draft source",
		_qlabTurnHandle: {
			cancel() { cancelled++; },
			abort() { aborted++; },
		},
		querySelector(selector) {
			return {
				"[data-qlab-inline]": inline,
				"[data-qlab-inline-prompt]": inlinePrompt,
				"[data-qlab-pending]": pending,
				"[data-qlab-compliance]": compliance,
				"[data-qlab-compliance-details]": complianceDetails,
				"[data-qlab-formal-menu]": formalMenu,
				"[data-qlab-formal-toggle]": formalToggle,
				"[data-qlab-visual-tools]": visualTools,
			}[selector] || null;
		},
		querySelectorAll(selector) {
			return selector.includes("[data-qlab-draft-save]") ? mutationControls : [];
		},
	};
	const manager = QLab.createQmdWorkspaceDocumentManager({
		root: harness.root,
		readonlyIO: harness.io,
		host,
	});
	const relativePath = "literature/paper.md";
	assert.equal(await manager.openWorkspaceDocument(
		{ relativePath },
		harness.issue(relativePath),
	), true);

	assert.equal(host._qlabDraftState, null);
	assert.deepEqual(Array.from(host._qlabPendingInserts), []);
	assert.equal(host._qlabActiveBlockIndex, null);
	assert.equal(host._qlabMonacoSelection, null);
	assert.equal(host._qlabDirty, false);
	assert.equal(host._qlabLastSaved, null);
	assert.equal(host._qlabTurnHandle, null);
	assert.equal(cancelled, 1);
	assert.equal(aborted, 0, "cancel is the primary Agent turn contract");
	assert.equal(inline.hidden, true);
	assert.equal(inlinePrompt.value, "");
	assert.equal(pending.hidden, true);
	assert.equal(pending.cleared, true);
	assert.equal(compliance.hidden, true);
	assert.equal(compliance.disabled, true);
	assert.equal(complianceDetails.hidden, true);
	assert.equal(complianceDetails.textContent, "");
	assert.equal(formalMenu.hidden, true);
	assert.equal(formalToggle.hidden, true);
	assert.equal(formalToggle.disabled, true);
	assert.equal(formalToggle.ariaExpanded, "false");
	assert.equal(visualTools.hidden, true);
	assert.equal(mutationControls.every(control => control.hidden && control.disabled), true);
	assert.equal(Object.isFrozen(host._qlabDocumentState), true);
	assert.equal(host._qlabDocumentState.document.relativePath, relativePath);
	assert.equal(host._qlabDocumentState.path, relativePath);
	assert.equal(host._qlabDocumentState.revision, manager.snapshot().session.snapshot().revision);
	assert.equal("_qlabDocument" in host, false);
	assert.equal(host._qlabBuffer, "# Evidence\n");
});

test("readonly activation callbacks must be synchronous and cannot open an async race window", async () => {
	const QLab = await loadQLab();
	const harness = readonlyManagerHarness(QLab);
	const effects = [];
	assert.throws(
		() => QLab.createQmdWorkspaceDocumentManager({
			root: harness.root,
			readonlyIO: harness.io,
			async onActivate() { effects.push("called"); },
		}),
		/synchronous|promise|async/i,
	);
	assert.deepEqual(effects, []);
});

test("readonly reload callbacks must be synchronous and cannot resume against a newer document", async () => {
	const QLab = await loadQLab();
	const harness = readonlyManagerHarness(QLab);
	const effects = [];
	assert.throws(
		() => QLab.createQmdWorkspaceDocumentManager({
			root: harness.root,
			readonlyIO: harness.io,
			async onReload() { effects.push("called"); },
		}),
		/synchronous|promise|async/i,
	);
	assert.deepEqual(effects, []);
});

test("a sync callback returning a Promise receives an invalidated intent before continuation", async () => {
	const QLab = await loadQLab();
	const harness = readonlyManagerHarness(QLab);
	const effects = [];
	const manager = QLab.createQmdWorkspaceDocumentManager({
		root: harness.root,
		readonlyIO: harness.io,
		onActivate(context) {
			return Promise.resolve().then(() => {
				if (context.isCurrent()) effects.push("stale");
			});
		},
	});
	const relativePath = "knowledge/topic.qmd";
	await assert.rejects(
		() => manager.openWorkspaceDocument({ relativePath }, harness.issue(relativePath)),
		/synchronous|promise|async/i,
	);
	await Promise.resolve();
	assert.deepEqual(effects, []);
	assert.equal(manager.snapshot().document, null);
});

test("a reload callback returning a Promise clears the active readonly session and host", async () => {
	const QLab = await loadQLab();
	let reads = 0;
	const harness = readonlyManagerHarness(QLab, {
		read: async () => ++reads === 1 ? "original\n" : "reloaded\n",
	});
	const editor = { value: "" };
	const host = {
		querySelector(selector) {
			return selector === "[data-qlab-editor]" ? editor : null;
		},
	};
	const effects = [];
	const manager = QLab.createQmdWorkspaceDocumentManager({
		root: harness.root,
		readonlyIO: harness.io,
		host,
		onReload(context) {
			return Promise.resolve().then(() => {
				if (context.isCurrent()) effects.push("stale");
			});
		},
	});
	const relativePath = "knowledge/topic.qmd";
	assert.equal(await manager.openWorkspaceDocument(
		{ relativePath },
		harness.issue(relativePath),
	), true);
	assert.equal(host._qlabBuffer, "original\n");

	await assert.rejects(() => manager.reloadActive(), /synchronous|promise|async/i);
	await Promise.resolve();

	assert.deepEqual(effects, []);
	assert.equal(manager.snapshot().document, null);
	assert.equal(manager.snapshot().session, null);
	assert.equal(host._qlabDocumentState, null);
	assert.equal(host._qlabBuffer, "");
	assert.equal(host._qlabDirty, false);
	assert.equal(editor.value, "");
	assert.equal(await manager.reloadActive(), false);
});

test("manager and controller ownership makes every session disposal observable once", async t => {
	const QLab = await loadQLab();
	const harness = readonlyManagerHarness(QLab);
	const originalCreateReadonlySession = QLab.createQmdDocumentSession;
	let readonlyDisposed = 0;
	QLab.createQmdDocumentSession = options => originalCreateReadonlySession({
		...options,
		onState(snapshot) {
			if (snapshot.disposed) readonlyDisposed += 1;
			options.onState?.(snapshot);
		},
	});
	t.after(() => { QLab.createQmdDocumentSession = originalCreateReadonlySession; });

	function draft(path, counter) {
		return QLab.createQmdDraftSession({
			path,
			text: "draft\n",
			revision: "d1",
			onSave: async () => ({ revision: "d2" }),
			onState(snapshot) {
				if (snapshot.disposed) counter.count += 1;
			},
		});
	}

	const firstDraftDisposed = { count: 0 };
	const secondDraftDisposed = { count: 0 };
	const firstDraft = draft("drafts/first.qmd", firstDraftDisposed);
	const secondDraft = draft("drafts/second.qmd", secondDraftDisposed);
	const controller = QLab.createQmdWorkspaceController({ ownsSession: false });
	const manager = QLab.createQmdWorkspaceDocumentManager({
		root: harness.root,
		readonlyIO: harness.io,
		onActivate({ session }) {
			controller.setResources({ session });
		},
	});

	assert.equal(manager.activateDraft(firstDraft), true);
	controller.setResources({ session: firstDraft });
	const relativePath = "knowledge/topic.qmd";
	assert.equal(await manager.openWorkspaceDocument(
		{ relativePath },
		harness.issue(relativePath),
	), true);
	assert.equal(firstDraftDisposed.count, 1, "Draft to readonly disposes the Draft once");

	assert.equal(manager.activateDraft(secondDraft), true);
	controller.setResources({ session: secondDraft });
	assert.equal(readonlyDisposed, 1, "readonly to Draft disposes the readonly session once");

	manager.dispose();
	controller.dispose();
	assert.equal(secondDraftDisposed.count, 1, "workspace teardown disposes the active Draft once");
});

test("a no-manager controller owns Draft switches and teardown including autosave timer cleanup", async () => {
	const QLab = await loadQLab();
	const disposed = { a: 0, b: 0 };
	const cancelled = { a: 0, b: 0 };
	function draft(path, key) {
		return QLab.createQmdDraftSession({
			path,
			text: "original\n",
			revision: "d1",
			schedule: () => ({ key }),
			cancel: () => { cancelled[key] += 1; },
			onSave: async () => ({ revision: "d2" }),
			onState(snapshot) {
				if (snapshot.disposed) disposed[key] += 1;
			},
		});
	}
	const first = draft("drafts/first.qmd", "a");
	const second = draft("drafts/second.qmd", "b");
	const controller = QLab.createQmdWorkspaceController({
		ownsSession: true,
		session: first,
	});
	first.applyHumanEdit("first dirty\n");
	assert.equal(controller.setResources({ session: second }), true);
	assert.deepEqual(disposed, { a: 1, b: 0 });
	assert.deepEqual(cancelled, { a: 1, b: 0 });
	second.applyHumanEdit("second dirty\n");
	controller.dispose();
	controller.dispose();
	assert.deepEqual(disposed, { a: 1, b: 1 });
	assert.deepEqual(cancelled, { a: 1, b: 1 });
});

test("failed staged commit preserves the previous Draft and disposes only the unpublished session once", async t => {
	const QLab = await loadQLab();
	const harness = readonlyManagerHarness(QLab);
	let draftDisposals = 0;
	const draft = QLab.createQmdDraftSession({
		path: "drafts/active.qmd",
		text: "active draft\n",
		revision: "d1",
		onSave: async () => ({ revision: "d2" }),
		onState(snapshot) {
			if (snapshot.disposed) draftDisposals += 1;
		},
	});
	const host = { _qlabDocumentState: null, _qlabBuffer: "", _qlabDirty: false };
	let readonlyDisposals = 0;
	let preparedSession;
	const originalCreateReadonlySession = QLab.createQmdDocumentSession;
	QLab.createQmdDocumentSession = options => {
		preparedSession = originalCreateReadonlySession({
			...options,
			onState(snapshot) {
				if (snapshot.disposed) readonlyDisposals += 1;
				options.onState?.(snapshot);
			},
		});
		return preparedSession;
	};
	t.after(() => { QLab.createQmdDocumentSession = originalCreateReadonlySession; });
	const manager = QLab.createQmdWorkspaceDocumentManager({
		root: harness.root,
		readonlyIO: harness.io,
		host,
		onActivate() {
			host._qlabDocumentState = Object.freeze({ path: "knowledge/topic.qmd" });
			host._qlabBuffer = "half-switched readonly";
			host._qlabDirty = true;
			throw new Error("activation failed");
		},
	});
	assert.equal(manager.activateDraft(draft), true);
	const before = manager.snapshot();
	const router = QLab.createWorkspaceDocumentRouter({
		getSelectedRepositoryState: async () => ({ root: harness.root, epoch: 1 }),
		canonicalizeRoot: async value => value,
		acquireVerifiedDocument: async request => harness.issue(request.relativePath),
		releaseVerifiedDocument: async capability => {
			harness.active.delete(capability.access);
			return true;
		},
		openReadonlyQmd: (decision, capability) => (
			manager.prepareWorkspaceDocument(decision, capability)
		),
	});

	const result = await router.open({
		root: harness.root,
		relativePath: "knowledge/topic.qmd",
		explicitSource: true,
	});
	assert.equal(result.action, "refuse");
	assert.equal(result.reason, "routing-stage-commit-failed");
	assert.equal(manager.snapshot().document, before.document);
	assert.equal(manager.snapshot().session, draft);
	assert.equal(host._qlabDocumentState.document.relativePath, "drafts/active.qmd");
	assert.equal(host._qlabBuffer, "active draft\n");
	assert.equal(draftDisposals, 0);
	assert.equal(draft.snapshot().disposed, false);
	assert.equal(readonlyDisposals, 1);
	assert.equal(preparedSession.snapshot().disposed, true);
	manager.dispose();
	assert.equal(draftDisposals, 1);
});

test("production workspace activation rolls every resident Draft resource back after a late throw", async t => {
	const QLab = await loadQLab();
	const mounted = await mountProductionWorkspace(QLab, t, {
		throwReadonlyMonaco: true,
	});
	t.after(() => mounted.workspace.dispose());
	await mounted.workspace.showSurface("website");
	const draft = mounted.draftSession();
	const draftPreview = mounted.draftPreview();
	const managerBefore = mounted.manager().snapshot();
	const documentBefore = mounted.workspace.document();
	const snapshotBefore = mounted.workspace.documentSnapshot();
	const statusBefore = mounted.nodes.get("[data-qlab-qmd-status]").textContent;
	const pathBefore = mounted.nodes.get("[data-qlab-draft-path]").textContent;
	const tabBefore = mounted.nodes.get("[data-qlab-editor-tab]").textContent;

	const router = QLab.createWorkspaceDocumentRouter({
		getSelectedRepositoryState: async () => ({ root: mounted.root, epoch: 1 }),
		canonicalizeRoot: async value => value,
		acquireVerifiedDocument: async request => mounted.readonly.issue(request.relativePath),
		releaseVerifiedDocument: async capability => {
			mounted.readonly.active.delete(capability.access);
			return true;
		},
		openReadonlyQmd: (decision, capability) => (
			mounted.workspace.prepareWorkspaceDocument(decision, capability)
		),
	});
	const result = await router.open({
		root: mounted.root,
		relativePath: "knowledge/topic.qmd",
		explicitSource: true,
	});

	assert.deepEqual(JSON.parse(JSON.stringify(result)), {
		action: "refuse",
		reason: "routing-stage-commit-failed",
	});
	assert.equal(mounted.manager().snapshot().document, managerBefore.document);
	assert.equal(mounted.manager().snapshot().session, draft);
	assert.equal(mounted.workspace.document(), documentBefore);
	assert.deepEqual(
		JSON.parse(JSON.stringify(mounted.workspace.documentSnapshot())),
		JSON.parse(JSON.stringify(snapshotBefore)),
	);
	assert.equal(mounted.visualState.path, "drafts/active.qmd");
	assert.equal(mounted.controllerResources().session, draft);
	assert.equal(mounted.controllerResources().preview, draftPreview);
	assert.equal(mounted.nodes.get("[data-qlab-draft-path]").textContent, pathBefore);
	assert.equal(mounted.nodes.get("[data-qlab-editor-tab]").textContent, tabBefore);
	assert.equal(mounted.nodes.get("[data-qlab-qmd-status]").textContent, statusBefore);
	assert.equal(mounted.previewSurfaceState.mode, "quick");
	assert.deepEqual(mounted.disposals(), { draft: 0, readonly: 1, preview: 0 });
	assert.equal(draft.snapshot().disposed, false);
	assert.equal(mounted.readonlySession().snapshot().disposed, true);
});

test("production Draft routing stages the real mounted workspace until lease release and final epoch", async t => {
	const QLab = await loadQLab();
	const order = [];
	const targetPath = "drafts/a.qmd";
	let targetPathReads = 0;
	const mounted = await mountProductionWorkspace(QLab, t, {
		readDraft: async (_root, relativePath) => {
			if (relativePath === targetPath) {
				targetPathReads++;
				return { text: "PATH-SWAPPED\n", revision: "path-r1" };
			}
			return { text: `${relativePath}\n`, revision: "active-r1" };
		},
		findDraftProposal: async (_root, relativePath) => {
			if (relativePath === targetPath) order.push("proposal-read");
			return null;
		},
	});
	t.after(() => mounted.workspace.dispose());
	const previousSession = mounted.draftSession();
	const previousSnapshot = mounted.workspace.documentSnapshot();
	let stageCommits = 0;
	let stageRollbacks = 0;
	const originalCreateStage = QLab.createWorkspaceDocumentRouteStage;
	QLab.createWorkspaceDocumentRouteStage = callbacks => originalCreateStage({
		commit() {
			stageCommits++;
			order.push("commit");
			return callbacks.commit();
		},
		rollback() {
			stageRollbacks++;
			order.push("rollback");
			return callbacks.rollback();
		},
	});
	t.after(() => { QLab.createWorkspaceDocumentRouteStage = originalCreateStage; });
	let selectionReads = 0;
	const selectedState = async () => {
		order.push(`selection:${++selectionReads}`);
		return { root: mounted.root, epoch: 11 };
	};
	let liveCapability = null;
	const leaseHost = {
		async acquireVerifiedDocument(request) {
			liveCapability = Object.freeze({
				root: request.root,
				relativePath: request.relativePath,
				canonicalPath: `${request.root}/${request.relativePath}`,
				authority: request.authority,
				kind: request.kind,
				writable: request.writable,
				access: Object.freeze({ retained: targetPath }),
			});
			return liveCapability;
		},
		async readVerified(access, capability) {
			assert.equal(capability, liveCapability);
			assert.equal(access, liveCapability.access);
			order.push("handle-read");
			return Object.freeze({
				text: "HANDLE-BOUND\n",
				size: 13,
				lastModified: 23,
			});
		},
		async releaseVerifiedDocument(capability) {
			assert.equal(capability, liveCapability);
			liveCapability = null;
			return true;
		},
		async destroy() { return true; },
	};
	const windowAccess = QLab.createWindowWorkspaceDocumentAccess({
		leaseHost,
		getSelectedRepositoryState: selectedState,
	});
	t.after(() => windowAccess.destroy());
	const router = QLab.createWorkspaceDocumentRouter({
		getSelectedRepositoryState: selectedState,
		canonicalizeRoot: async value => value,
		acquireVerifiedDocument: request => windowAccess.acquireVerifiedDocument(request),
		releaseVerifiedDocument: async capability => {
			order.push("release");
			assert.equal(mounted.workspace.document().relativePath, "drafts/active.qmd");
			assert.deepEqual(
				JSON.parse(JSON.stringify(mounted.workspace.documentSnapshot())),
				JSON.parse(JSON.stringify(previousSnapshot)),
				"preparation cannot publish the target Draft before release",
			);
			assert.equal(previousSession.snapshot().disposed, false);
			return windowAccess.releaseVerifiedDocument(capability);
		},
		openDraft: async (decision, capability) => {
			order.push("prepare");
			let verifiedDraft = await windowAccess.readVerifiedDraft(capability);
			return mounted.workspace.prepareWorkspaceDocument(
				decision, capability, verifiedDraft
			);
		},
	});

	const result = await router.open({ root: mounted.root, relativePath: targetPath });
	assert.equal(result.action, "open-draft");
	assert.equal(mounted.workspace.document().relativePath, targetPath);
	assert.equal(mounted.workspace.documentSnapshot().text, "HANDLE-BOUND\n");
	assert.equal(targetPathReads, 0, "routed Draft preparation cannot read the pathname host");
	assert.equal(stageCommits, 1);
	assert.equal(stageRollbacks, 0);
	const prepareIndex = order.indexOf("prepare");
	const handleReadIndex = order.indexOf("handle-read");
	const proposalReadIndex = order.indexOf("proposal-read");
	const releaseIndex = order.indexOf("release");
	const finalSelectionIndex = order.lastIndexOf(`selection:${selectionReads}`);
	const commitIndex = order.indexOf("commit");
	assert.ok(prepareIndex < handleReadIndex);
	assert.ok(handleReadIndex < proposalReadIndex);
	assert.ok(proposalReadIndex < releaseIndex);
	assert.ok(releaseIndex < finalSelectionIndex);
	assert.ok(finalSelectionIndex < commitIndex);
});

test("post-reset activation failure cannot cancel the previous Draft turn or compliance timer", async t => {
	const QLab = await loadQLab();
	const mounted = await mountProductionWorkspace(QLab, t, {
		failReadonlyResourceCommit: true,
		trackTimers: true,
	});
	t.after(() => mounted.workspace.dispose());
	const previousDraft = mounted.draftSession();
	const previousPreview = mounted.draftPreview();
	const previousTimer = mounted.timerState.scheduled.at(-1);
	let cancelled = 0;
	const previousTurn = { cancel() { cancelled += 1; } };
	mounted.host._qlabTurnHandle = previousTurn;

	const path = "knowledge/topic.qmd";
	const result = await mounted.workspace.openWorkspaceDocument(
		{ relativePath: path },
		mounted.readonly.issue(path),
	);

	assert.equal(result, false);
	assert.equal(cancelled, 0, "rollback cannot revive a cancelled Agent turn");
	assert.equal(mounted.host._qlabTurnHandle, previousTurn);
	assert.equal(mounted.timerState.cleared.includes(previousTimer), false);
	assert.equal(mounted.workspace.document().relativePath, "drafts/active.qmd");
	assert.equal(mounted.workspace.documentSnapshot().disposed, false);
	assert.equal(mounted.controllerResources().session, previousDraft);
	assert.equal(mounted.controllerResources().preview, previousPreview);
	assert.deepEqual(mounted.disposals(), { draft: 0, readonly: 1, preview: 0 });
});

test("successful readonly publication finalizes the previous Draft turn and timer exactly once", async t => {
	const QLab = await loadQLab();
	const mounted = await mountProductionWorkspace(QLab, t, { trackTimers: true });
	t.after(() => mounted.workspace.dispose());
	const previousTimer = mounted.timerState.scheduled.at(-1);
	let cancelled = 0;
	mounted.host._qlabTurnHandle = { cancel() { cancelled += 1; } };
	const path = "knowledge/topic.qmd";

	assert.equal(await mounted.workspace.openWorkspaceDocument(
		{ relativePath: path },
		mounted.readonly.issue(path),
	), true);
	assert.equal(cancelled, 1);
	assert.equal(mounted.host._qlabTurnHandle, null);
	assert.equal(
		mounted.timerState.cleared.filter(timer => timer === previousTimer).length,
		1,
	);
});

test("production reload failure clears every mounted reference to the disposed readonly session", async t => {
	const QLab = await loadQLab();
	let reads = 0;
	const mounted = await mountProductionWorkspace(QLab, t, {
		throwReadonlyReloadMonaco: true,
		readReadonly: async () => ++reads === 1 ? "first bytes\n" : "changed bytes\n",
	});
	t.after(() => mounted.workspace.dispose());
	const path = "knowledge/topic.qmd";
	assert.equal(await mounted.workspace.openWorkspaceDocument(
		{ relativePath: path },
		mounted.readonly.issue(path),
	), true);
	const failedSession = mounted.readonlySession();

	await assert.rejects(
		() => mounted.workspace.reloadActiveDocument(),
		/Monaco reload failure/i,
	);
	assert.equal(mounted.manager().snapshot().session, null);
	assert.equal(mounted.manager().snapshot().document, null);
	assert.equal(failedSession.snapshot().disposed, true);
	assert.equal(mounted.workspace.document(), null);
	assert.equal(mounted.workspace.documentSnapshot(), null);
	assert.equal(mounted.controllerResources().session, null);
	assert.equal(mounted.controllerResources().preview, null);
	assert.equal(mounted.visualState.path, "");
	assert.equal(mounted.monacoState.path, "");
	assert.equal(mounted.host._qlabDocumentState, null);
	assert.equal(mounted.nodes.get("[data-qlab-draft-path]").textContent, "No document");
	assert.equal(mounted.nodes.get("[data-qlab-editor-tab]").textContent, "No document");
});

test("fail-closed cleanup continues after one surface refuses neutralization", async t => {
	const QLab = await loadQLab();
	let reads = 0;
	const mounted = await mountProductionWorkspace(QLab, t, {
		throwReadonlyReloadMonaco: true,
		throwVisualClear: true,
		readReadonly: async () => ++reads === 1 ? "first bytes\n" : "changed bytes\n",
	});
	t.after(() => mounted.workspace.dispose());
	const path = "knowledge/topic.qmd";
	assert.equal(await mounted.workspace.openWorkspaceDocument(
		{ relativePath: path },
		mounted.readonly.issue(path),
	), true);

	await assert.rejects(
		() => mounted.workspace.reloadActiveDocument(),
		/Monaco reload failure/i,
	);
	assert.equal(mounted.manager().snapshot().session, null);
	assert.equal(mounted.workspace.document(), null);
	assert.equal(mounted.workspace.documentSnapshot(), null);
	assert.equal(mounted.controllerResources().session, null);
	assert.equal(mounted.controllerResources().preview, null);
	assert.equal(mounted.monacoState.path, "");
	assert.equal(mounted.previewSurfaceState.mode, "empty");
	assert.equal(mounted.host._qlabDocumentState, null);
	assert.equal(mounted.nodes.get("[data-qlab-draft-path]").textContent, "No document");
	assert.equal(mounted.nodes.get("[data-qlab-editor-tab]").textContent, "No document");
	assert.equal(mounted.tabWrites.at(-1)?.draftPath, null);
	assert.equal(mounted.tabWrites.at(-1)?.workspaceDocument, null);
	assert.equal(
		mounted.nodes.get("[data-qlab-qmd-status]").textContent,
		"Read-only document closed after reload failure",
	);
});

test("a stale rejected readonly open cannot publish an error over the newer document", async t => {
	const QLab = await loadQLab();
	const staleRead = deferred();
	let staleStarted;
	const sawStaleRead = new Promise(resolve => { staleStarted = resolve; });
	const mounted = await mountProductionWorkspace(QLab, t, {
		readReadonly: async path => {
			if (path.endsWith("knowledge/topic.qmd")) {
				staleStarted();
				return staleRead.promise;
			}
			return "B current\n";
		},
	});
	t.after(() => mounted.workspace.dispose());
	const pathA = "knowledge/topic.qmd";
	const pathB = "literature/paper.md";
	const staleOpen = mounted.workspace.openWorkspaceDocument(
		{ relativePath: pathA },
		mounted.readonly.issue(pathA),
	);
	await sawStaleRead;
	assert.equal(await mounted.workspace.openWorkspaceDocument(
		{ relativePath: pathB },
		mounted.readonly.issue(pathB),
	), true);
	const status = mounted.nodes.get("[data-qlab-qmd-status]");
	const currentStatus = status.textContent;
	const currentTone = mounted.nodes.get(".qlab-qmd-workspace").dataset.status;

	staleRead.reject(new Error("stale A open failed"));
	assert.equal(await staleOpen, false);
	assert.equal(mounted.workspace.document().relativePath, pathB);
	assert.equal(status.textContent, currentStatus);
	assert.equal(mounted.nodes.get(".qlab-qmd-workspace").dataset.status, currentTone);
});

for (const staleCompletion of ["resolve", "reject"]) {
	test(`a stale readonly refresh ${staleCompletion} cannot retry or repaint the newer preview`, async t => {
		const QLab = await loadQLab();
		const staleReload = deferred();
		let readsA = 0;
		let reloadStarted;
		const sawReload = new Promise(resolve => { reloadStarted = resolve; });
		const mounted = await mountProductionWorkspace(QLab, t, {
			readReadonly: async path => {
				if (path.endsWith("knowledge/topic.qmd")) {
					readsA += 1;
					if (readsA === 1) return "A original\n";
					reloadStarted();
					return staleReload.promise;
				}
				return "B current\n";
			},
		});
		t.after(() => mounted.workspace.dispose());
		const pathA = "knowledge/topic.qmd";
		const pathB = "literature/paper.md";
		assert.equal(await mounted.workspace.openWorkspaceDocument(
			{ relativePath: pathA },
			mounted.readonly.issue(pathA),
		), true);
		await mounted.workspace.showSurface("website");
		const refresh = mounted.workspace.refreshActiveSurface();
		await sawReload;
		assert.equal(await mounted.workspace.openWorkspaceDocument(
			{ relativePath: pathB },
			mounted.readonly.issue(pathB),
		), true);
		const status = mounted.nodes.get("[data-qlab-qmd-status]");
		const currentStatus = status.textContent;
		const currentTone = mounted.nodes.get(".qlab-qmd-workspace").dataset.status;
		const currentWrites = mounted.previewSurfaceState.writes;

		if (staleCompletion === "resolve") staleReload.resolve("A stale reload\n");
		else staleReload.reject(new Error("stale A reload failed"));
		assert.equal(await refresh, false);
		assert.equal(mounted.workspace.document().relativePath, pathB);
		assert.equal(mounted.previewSurfaceState.writes, currentWrites);
		assert.equal(status.textContent, currentStatus);
		assert.equal(mounted.nodes.get(".qlab-qmd-workspace").dataset.status, currentTone);
	});
}

for (const staleFailure of ["flush", "readSource", "findProposal"]) {
	test(`a stale Draft ${staleFailure} rejection cannot escape or overwrite the newer document status`, async t => {
		const QLab = await loadQLab();
		const stale = deferred();
		let started;
		const sawStaleOperation = new Promise(resolve => { started = resolve; });
		let flushCalls = 0;
		let readCalls = 0;
		let proposalCalls = 0;
		const mounted = await mountProductionWorkspace(QLab, t, {
			flushDraft: async () => {
				flushCalls += 1;
				if (staleFailure === "flush" && flushCalls === 2) {
					started();
					return stale.promise;
				}
				return true;
			},
			readDraft: async (_root, relativePath) => {
				readCalls += 1;
				if (staleFailure === "readSource" && readCalls === 2) {
					started();
					return stale.promise;
				}
				return {
					text: `${relativePath}\n`,
					revision: `draft-r${readCalls}`,
				};
			},
			findDraftProposal: async () => {
				proposalCalls += 1;
				if (staleFailure === "findProposal" && proposalCalls === 2) {
					started();
					return stale.promise;
				}
				return null;
			},
		});
		t.after(() => mounted.workspace.dispose());
		const staleOpen = mounted.workspace.openDraft("drafts/stale.qmd");
		await sawStaleOperation;
		const currentPath = "literature/paper.md";
		assert.equal(await mounted.workspace.openWorkspaceDocument(
			{ relativePath: currentPath },
			mounted.readonly.issue(currentPath),
		), true);
		const status = mounted.nodes.get("[data-qlab-qmd-status]");
		const currentStatus = status.textContent;
		const currentTone = mounted.nodes.get(".qlab-qmd-workspace").dataset.status;

		stale.reject(new Error(`stale ${staleFailure} failed`));
		assert.equal(await staleOpen, false);
		assert.equal(mounted.workspace.document().relativePath, currentPath);
		assert.equal(status.textContent, currentStatus);
		assert.equal(mounted.nodes.get(".qlab-qmd-workspace").dataset.status, currentTone);
	});
}
