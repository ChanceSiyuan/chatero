import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("workspace renders Explorer and three resident QMD surfaces", async () => {
	const QLab = await loadQLab();
	let html = QLab.renderQmdWorkspaceHTML({
		path: "drafts/a.qmd",
		explorer: [{
			path: "drafts",
			name: "drafts",
			kind: "root",
			writable: true,
			children: [{ path: "drafts/a.qmd", name: "a.qmd", kind: "qmd", writable: true, children: [] }],
		}],
		status: "ready",
	});
	assert.match(html, /data-qlab-qmd-explorer/);
	assert.match(html, /data-qlab-qmd-monaco/);
	assert.match(html, /qmdMonaco\.html/);
	assert.match(html, /data-qlab-visual-surface/);
	assert.match(html, /<div class="qlab-qmd-visual-editor" data-qlab-visual-editor-root/);
	assert.match(html, /data-qlab-qmd-preview/);
	assert.match(html, /data-qlab-preview-stage/);
	assert.match(html, /data-qlab-preview-quick/);
	assert.match(html, /data-qlab-preview-browser-host/);
	assert.match(html, /data-qlab-primary-surface/);
	assert.match(html, /data-qlab-preview-toggle[^>]+data-qlab-current-surface="visual"/);
	assert.doesNotMatch(html, /data-qlab-preview-toggle[^>]+aria-pressed=/);
	assert.match(html, /data-surface="visual"/);
	assert.doesNotMatch(html, /role="separator"/);
	assert.match(html, /data-qlab-qmd-status/);
	assert.match(html, /data-qlab-draft-row="drafts\/a\.qmd"/);
	assert.match(html, /data-qlab-preview-version="original"/);
	assert.match(html, /data-qlab-preview-version="proposed"/);
});

function fakeElement(name = "div") {
	let attributes = new Map();
	let listeners = new Map();
	return {
		name,
		hidden: false,
		srcdoc: "",
		children: [],
		setAttribute(key, value) {
			attributes.set(key, String(value));
		},
		getAttribute(key) {
			return attributes.get(key) || "";
		},
		removeAttribute(key) {
			attributes.delete(key);
		},
		appendChild(child) {
			this.children.push(child);
			return child;
		},
		addEventListener(type, listener) {
			listeners.set(type, listener);
		},
		removeEventListener(type, listener) {
			if (listeners.get(type) === listener) listeners.delete(type);
		},
		dispatch(type) {
			listeners.get(type)?.({ type, target: this });
		},
		remove() {
			this.removed = true;
		},
	};
}

test("preview surface uses a native Zotero browser for exact loopback content", async () => {
	const QLab = await loadQLab();
	let quick = fakeElement("iframe");
	let browserHost = fakeElement("host");
	let empty = fakeElement("empty");
	let createdName = "";
	let browser;
	let errors = [];
	let document = {
		createXULElement(name) {
			createdName = name;
			browser = fakeElement(name);
			return browser;
		},
	};
	let host = {
		querySelector(selector) {
			return {
				"[data-qlab-preview-quick]": quick,
				"[data-qlab-preview-browser-host]": browserHost,
				"[data-qlab-preview-empty]": empty,
			}[selector] || null;
		},
	};
	let surface = QLab.createQmdPreviewSurface(document, host, {
		onLoadError: url => errors.push(url),
	});
	assert.equal(createdName, "browser");
	assert.equal(browser.getAttribute("type"), "content");
	assert.equal(browser.getAttribute("remote"), "true");
	assert.equal(browser.getAttribute("maychangeremoteness"), "true");

	surface.showQuick("<main>quick</main>");
	assert.equal(quick.srcdoc, "<main>quick</main>");
	assert.equal(browser.hidden, true);
	assert.equal(empty.hidden, true);

	let exact = "http://127.0.0.1:43104/topic/note.html";
	surface.showExact(exact);
	assert.equal(browser.getAttribute("src"), exact);
	assert.equal(browser.hidden, false);
	assert.equal(quick.hidden, true);

	browser.dispatch("error");
	assert.deepEqual(errors, [exact]);
	assert.equal(quick.hidden, false);
	assert.equal(browser.hidden, true);
	surface.dispose();
	assert.equal(browser.removed, true);
});

test("preview surface registers and disposes Quick and remote Website interaction adapters", async () => {
	const QLab = await loadQLab();
	let quick = fakeElement("iframe");
	let browserHost = fakeElement("host");
	let empty = fakeElement("empty");
	let browser;
	let calls = [];
	let document = {
		createXULElement(name) {
			browser = fakeElement(name);
			return browser;
		},
	};
	let host = {
		querySelector(selector) {
			return {
				"[data-qlab-preview-quick]": quick,
				"[data-qlab-preview-browser-host]": browserHost,
				"[data-qlab-preview-empty]": empty,
			}[selector] || null;
		},
	};
	let interactionBridge = {
		attachQuickPreview(frame) {
			calls.push(["attach-quick", frame]);
			return () => calls.push(["detach-quick", frame]);
		},
		attachWebsitePreview(frame) {
			calls.push(["attach-website", frame]);
			return () => calls.push(["detach-website", frame]);
		},
	};
	let surface = QLab.createQmdPreviewSurface(document, host, { interactionBridge });
	assert.deepEqual(calls, [
		["attach-quick", quick],
		["attach-website", browser],
	]);
	surface.dispose();
	assert.deepEqual(calls, [
		["attach-quick", quick],
		["attach-website", browser],
		["detach-quick", quick],
		["detach-website", browser],
	]);
});

test("preview presentation distinguishes quick, exact, and last-good content", async () => {
	const QLab = await loadQLab();
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdPreviewPresentation({
		status: "rendering",
		fallback: "<main>quick</main>",
		url: "",
	}))), {
		mode: "quick",
		status: "Quick Preview · preparing Quarto…",
		tone: "rendering",
	});
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdPreviewPresentation({
		status: "ready",
		fallback: "<main>quick</main>",
		url: "http://127.0.0.1:43104/a.html",
	}))), {
		mode: "exact",
		status: "Quarto Preview",
		tone: "ready",
	});
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdPreviewPresentation({
		status: "error",
		fallback: "<main>quick</main>",
		url: "",
		error: "bad yaml",
	}))), {
		mode: "quick",
		status: "Quick Preview · Quarto unavailable: bad yaml",
		tone: "error",
	});
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdPreviewPresentation({
		status: "error",
		fallback: "<main>latest quick</main>",
		url: "http://127.0.0.1:43104/a.html",
		error: "bad yaml",
	}))), {
		mode: "exact",
		status: "Quarto Preview · showing last good result: bad yaml",
		tone: "error",
	});
});

test("workspace status gives persistence failures priority without hiding Preview progress", async () => {
	const QLab = await loadQLab();
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdWorkspaceStatus({
		persistence: "saved",
		preview: {},
	}))), { text: "Saved", tone: "saved" });
	let rendering = {
		status: "rendering",
		fallback: "<main>quick</main>",
		url: "",
	};
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdWorkspaceStatus({
		persistence: "conflict",
		message: "Draft changed on disk",
		preview: rendering,
	}))), { text: "Draft changed on disk", tone: "conflict" });
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdWorkspaceStatus({
		persistence: "error",
		message: "Save failed",
		preview: rendering,
	}))), { text: "Save failed", tone: "error" });
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdWorkspaceStatus({
		persistence: "saving",
		preview: rendering,
	}))), { text: "Saving…", tone: "saving" });
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdWorkspaceStatus({
		persistence: "saved",
		surface: "website",
		preview: rendering,
	}))), { text: "Quick Preview · preparing Quarto…", tone: "rendering" });
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdWorkspaceStatus({
		persistence: "saved",
		surface: "website",
		preview: {
			status: "rendering",
			fallback: "<main>quick</main>",
			url: "http://127.0.0.1:43104/a.html",
		},
	}))), { text: "Saved · updating Quarto…", tone: "rendering" });
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdWorkspaceStatus({
		persistence: "saved",
		surface: "website",
		preview: {
			status: "ready",
			fallback: "<main>quick</main>",
			url: "http://127.0.0.1:43104/a.html",
		},
	}))), { text: "Quarto Preview", tone: "ready" });
});

test("background Quarto progress never replaces Visual Edit or Monaco persistence status", async () => {
	const QLab = await loadQLab();
	const preview = {
		status: "rendering",
		fallback: "<main>quick</main>",
		url: "http://127.0.0.1:43104/a.html",
	};
	for (const surface of ["visual", "source"]) {
		assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdWorkspaceStatus({
			persistence: "saved",
			message: "Saved",
			surface,
			preview,
		}))), { text: "Saved", tone: "saved" });
		assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdWorkspaceStatus({
			persistence: "dirty",
			surface,
			preview,
		}))), { text: "Unsaved changes", tone: "dirty" });
	}
});

test("workspace disposal closes watcher, Monaco bridge, Preview, and session", async () => {
	const QLab = await loadQLab();
	let calls = [];
	let workspace = QLab.createQmdWorkspaceController({
		watcher: { dispose: () => calls.push("watcher") },
		monaco: { dispose: () => calls.push("monaco") },
		preview: { dispose: () => calls.push("preview") },
		session: { dispose: () => calls.push("session") },
	});
	workspace.dispose();
	workspace.dispose();
	assert.deepEqual(calls, ["watcher", "monaco", "preview", "session"]);
});

test("workspace quiesce synchronously stops callbacks before a best-effort Draft flush", async () => {
	const QLab = await loadQLab();
	let calls = [];
	let workspace = QLab.createQmdWorkspaceController({
		watcher: { dispose: () => calls.push("watcher") },
		monaco: { dispose: () => calls.push("monaco") },
		visual: { dispose: () => calls.push("visual") },
		preview: { dispose: () => calls.push("preview") },
		session: { dispose: () => calls.push("session") },
	});
	workspace.quiesce();
	workspace.quiesce();
	assert.deepEqual(calls, ["watcher", "monaco", "preview"]);
	workspace.dispose();
	assert.deepEqual(calls, ["watcher", "monaco", "preview", "visual", "session"]);
});

test("workspace cycles Visual Edit, Website Preview, and Monaco Source", async () => {
	const QLab = await loadQLab();
	let layouts = [];
	let workspace = QLab.createQmdWorkspaceController({
		onLayout: value => layouts.push(value),
	});
	assert.equal(workspace.snapshot().surface, "visual");
	workspace.toggleSurface();
	assert.equal(workspace.snapshot().surface, "website");
	workspace.toggleSurface();
	assert.equal(workspace.snapshot().surface, "source");
	workspace.toggleSurface();
	assert.equal(workspace.snapshot().surface, "visual");
	workspace.toggleExplorer(false);
	let state = workspace.snapshot();
	assert.equal(state.explorerVisible, false);
	assert.equal(layouts.length, 4);
});

test("disposed workspace mutators and a queued surface transition cannot layout", async () => {
	const QLab = await loadQLab();
	const layouts = [];
	let releaseEdit;
	const editing = new Promise(resolve => { releaseEdit = resolve; });
	const visual = {
		finishActiveEdit: () => editing,
		isEditing: () => false,
	};
	const workspace = QLab.createQmdWorkspaceController({
		surface: "visual",
		onLayout: state => layouts.push(state),
	});
	const transition = QLab.transitionQmdWorkspaceSurface(workspace, visual, "website");
	workspace.dispose();
	workspace.toggleExplorer(false);
	workspace.showSurface("source");
	workspace.showVersionTarget("proposed");
	workspace.toggleSurface();
	releaseEdit();

	assert.equal(await transition, false);
	assert.deepEqual(layouts, []);
	assert.deepEqual(JSON.parse(JSON.stringify(workspace.snapshot())), {
		explorerVisible: true,
		surface: "visual",
		versionTarget: "original",
		disposed: true,
	});
});

test("workspace migrates legacy Preview state and preserves explicit restored surfaces", async () => {
	const QLab = await loadQLab();
	assert.equal(QLab.createQmdWorkspaceController({ surface: "preview" }).snapshot().surface, "website");
	assert.equal(QLab.createQmdWorkspaceController({ surface: "source" }).snapshot().surface, "source");
	assert.equal(QLab.createQmdWorkspaceController({ surface: "website" }).snapshot().surface, "website");
	assert.equal(QLab.createQmdWorkspaceController({ surface: "invalid" }).snapshot().surface, "visual");
});

test("surface action model names the current and next surface", async () => {
	const QLab = await loadQLab();
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdSurfaceActionModel("visual"))), {
		current: "visual",
		next: "website",
		label: "Visual Edit · switch to Website Preview",
	});
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdSurfaceActionModel("website"))), {
		current: "website",
		next: "source",
		label: "Website Preview · switch to Monaco Source",
	});
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdSurfaceActionModel("source"))), {
		current: "source",
		next: "visual",
		label: "Monaco Source · switch to Visual Edit",
	});
});

test("Visual Edit saves through the active Draft session without bypassing revision guards", async () => {
	const QLab = await loadQLab();
	let documentState = { source: "old", revision: "r1" };
	let visual = {
		setDocument(snapshot, editable, generation) {
			documentState = { ...snapshot, editable, generation };
		},
		snapshot: () => ({ source: documentState.source, revision: documentState.revision }),
		isEditing: () => false,
		finishActiveEdit: async () => {},
	};
	let state = { text: "old", revision: "r1" };
	let edits = [];
	let session = {
		snapshot: () => ({ ...state }),
		applyHumanEdit(text) {
			edits.push(text);
			state.text = text;
		},
		async saveNow() {
			state.revision = "r2";
			return { ...state };
		},
	};
	let savedSnapshots = [];
	let bridge = QLab.createQmdVisualSessionBridge(visual, {
		onSaved: snapshot => savedSnapshots.push(snapshot),
	});
	let generation = bridge.setSession(session);
	let result = await bridge.save("new", "r1", generation);

	assert.deepEqual(edits, ["new"]);
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { source: "new", revision: "r2" });
	assert.deepEqual(JSON.parse(JSON.stringify(savedSnapshots)), [{ source: "new", revision: "r2" }]);
	assert.equal(documentState.editable, true);
});

test("Visual Edit rejects stale documents and a newer unsaved Monaco buffer", async () => {
	const QLab = await loadQLab();
	let visualSource = "old";
	let visual = {
		setDocument(snapshot) { visualSource = snapshot.source; },
		snapshot: () => ({ source: visualSource, revision: "r1" }),
		isEditing: () => false,
		finishActiveEdit: async () => {},
	};
	let state = { text: "old", revision: "r1" };
	let session = {
		snapshot: () => ({ ...state }),
		applyHumanEdit(text) { state.text = text; },
		saveNow: async () => ({ ...state }),
	};
	let bridge = QLab.createQmdVisualSessionBridge(visual);
	let firstGeneration = bridge.setSession(session);
	state.text = "newer Monaco buffer";
	await assert.rejects(
		() => bridge.save("visual overwrite", "r1", firstGeneration),
		/changed since Visual Edit loaded/i,
	);

	state.text = "next Draft";
	state.revision = "r2";
	bridge.setSession(session);
	await assert.rejects(
		() => bridge.save("stale Draft result", "r1", firstGeneration),
		/document changed/i,
	);
});

test("leaving Visual Edit flushes the active field before the surface changes", async () => {
	const QLab = await loadQLab();
	let editing = true;
	let finishes = 0;
	let visual = {
		async finishActiveEdit() {
			finishes++;
			editing = false;
		},
		isEditing: () => editing,
	};
	let controller = QLab.createQmdWorkspaceController({ surface: "visual" });
	assert.equal(await QLab.transitionQmdWorkspaceSurface(controller, visual, "website"), true);
	assert.equal(finishes, 1);
	assert.equal(controller.snapshot().surface, "website");

	controller.showSurface("visual");
	visual.finishActiveEdit = async () => { finishes++; };
	editing = true;
	assert.equal(await QLab.transitionQmdWorkspaceSurface(controller, visual, "website"), false);
	assert.equal(controller.snapshot().surface, "visual");
});

test("switching Drafts flushes Visual Edit and the shared session before reading another file", async () => {
	const QLab = await loadQLab();
	let order = [];
	let editing = true;
	let visual = {
		async finishActiveEdit() {
			order.push("visual");
			editing = false;
		},
		isEditing: () => editing,
	};
	let session = {
		async saveNow() {
			order.push("session");
			return { dirty: false, saveError: "" };
		},
		snapshot: () => ({ dirty: false, saveError: "" }),
	};
	assert.equal(await QLab.flushQmdDraftBeforeTransition(session, visual), true);
	assert.deepEqual(order, ["visual", "session"]);

	visual.finishActiveEdit = async () => { order.push("blocked"); };
	editing = true;
	assert.equal(await QLab.flushQmdDraftBeforeTransition(session, visual), false);
	assert.deepEqual(order, ["visual", "session", "blocked"]);
});

test("the latest Draft-open request invalidates every older asynchronous continuation", async () => {
	const QLab = await loadQLab();
	let gate = QLab.createQmdLatestRequestGate();
	let first = gate.begin();
	assert.equal(first.isCurrent(), true);
	let second = gate.begin();
	assert.equal(first.isCurrent(), false);
	assert.equal(second.isCurrent(), true);
	gate.dispose();
	assert.equal(second.isCurrent(), false);
});

test("TODO completion remains available while an AI proposal is awaiting review", async () => {
	const QLab = await loadQLab();
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdTodoActionAvailability(false))), {
		allowed: true,
		reason: "",
	});
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdTodoActionAvailability(true))), {
		allowed: true,
		reason: "",
	});
});

test("an AI proposal can attach only to the Draft that created it", async () => {
	const QLab = await loadQLab();
	assert.equal(QLab.qmdProposalBelongsToDraft({
		originalPath: "drafts/a.qmd",
		workingPath: "work/qlab-zotero/draft-changes/x/draft.qmd",
	}, "drafts/a.qmd"), true);
	assert.equal(QLab.qmdProposalBelongsToDraft({
		originalPath: "drafts/a.qmd",
		workingPath: "work/qlab-zotero/draft-changes/x/draft.qmd",
	}, "drafts/b.qmd"), false);
	assert.equal(QLab.qmdProposalBelongsToDraft(null, "drafts/a.qmd"), false);
});

test("an async proposal action cannot clear a newer Draft or proposal", async () => {
	const QLab = await loadQLab();
	const proposalA = {
		state: {
			originalPath: "drafts/a.qmd",
			workingPath: "work/qlab-zotero/draft-changes/a/draft.qmd",
		},
	};
	const proposalB = {
		state: {
			originalPath: "drafts/b.qmd",
			workingPath: "work/qlab-zotero/draft-changes/b/draft.qmd",
		},
	};
	const captured = { proposal: proposalA, path: "drafts/a.qmd", generation: 3 };
	assert.equal(QLab.qmdProposalActionStillCurrent(captured, { ...captured }), true);
	assert.equal(QLab.qmdProposalActionStillCurrent(captured, {
		proposal: proposalB,
		path: "drafts/b.qmd",
		generation: 4,
	}), false);
	assert.equal(QLab.qmdProposalActionStillCurrent(captured, {
		proposal: { ...proposalA },
		path: "drafts/a.qmd",
		generation: 3,
	}), false);
});

test("compliance results apply only to the exact Draft buffer that was checked", async () => {
	const QLab = await loadQLab();
	let checked = {
		path: "drafts/a.qmd",
		generation: 3,
		revision: "r1",
		text: "original",
	};
	assert.equal(QLab.qmdComplianceSnapshotMatches(checked, { ...checked }), true);
	assert.equal(QLab.qmdComplianceSnapshotMatches(checked, { ...checked, revision: "r2" }), false);
	assert.equal(QLab.qmdComplianceSnapshotMatches(checked, { ...checked, text: "edited" }), false);
	assert.equal(QLab.qmdComplianceSnapshotMatches(checked, { ...checked, path: "drafts/b.qmd" }), false);
	assert.equal(QLab.qmdComplianceSnapshotMatches(checked, { ...checked, generation: 4 }), false);
	assert.equal(QLab.qmdComplianceResultMatches({ checked }, { ...checked }), true);
	assert.equal(QLab.qmdComplianceResultMatches({ checked }, { ...checked, text: "edited" }), false);
	assert.equal(QLab.qmdComplianceResultMatches(null, checked), false);
});

test("workspace event bindings are removed exactly once on disposal", async () => {
	const QLab = await loadQLab();
	let listeners = new Map();
	let target = {
		addEventListener(type, listener) { listeners.set(type, listener); },
		removeEventListener(type, listener) {
			if (listeners.get(type) === listener) listeners.delete(type);
		},
	};
	let calls = 0;
	let dispose = QLab.bindDisposableQmdWorkspaceEvent(target, "click", () => calls++);
	listeners.get("click")();
	dispose();
	dispose();
	assert.equal(calls, 1);
	assert.equal(listeners.has("click"), false);
});

test("Monaco selection command opens focused Chat context without starting an inline rewrite", async () => {
	const QLab = await loadQLab();
	const exact = "  selected QMD source\nwithout normalization  ";
	const calls = [];
	const host = {};
	const view = { name: "research-window" };
	QLab.addCurrentContextToChat = async (windowRef, options) => {
		calls.push(["chat", windowRef, options]);
		return { kind: "qmd-selection" };
	};

	const result = await QLab.handleQmdMonacoWorkspaceCommand({
		host,
		view,
		command: "chat-selection",
		event: { selection: exact, start: 11, end: 11 + exact.length },
		onSave: () => calls.push(["save"]),
		onInlineWrite: () => calls.push(["inline"]),
	});

	assert.equal(result.kind, "qmd-selection");
	assert.deepEqual(JSON.parse(JSON.stringify(host._qlabMonacoSelection)), {
		start: 11,
		end: 11 + exact.length,
		text: exact,
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0][0], "chat");
	assert.equal(calls[0][1], view);
	assert.equal(calls[0][2].preference, "selection");
	assert.equal(calls[0][2].focus, true);
	assert.equal(calls[0][2].qmdHost, host, "the emitting QMD host remains authoritative");
});

test("empty Monaco Command-K still opens the existing inline-write bar", async () => {
	const QLab = await loadQLab();
	const calls = [];
	const host = {};
	QLab.addCurrentContextToChat = async () => calls.push("chat");

	const result = await QLab.handleQmdMonacoWorkspaceCommand({
		host,
		view: {},
		command: "ai",
		event: { selection: "", start: 23, end: 23 },
		onSave: () => calls.push("save"),
		onInlineWrite: () => calls.push("inline"),
	});

	assert.equal(result, "ai");
	assert.deepEqual(JSON.parse(JSON.stringify(host._qlabMonacoSelection)), {
		start: 23,
		end: 23,
		text: "",
	});
	assert.deepEqual(calls, ["inline"]);
});
