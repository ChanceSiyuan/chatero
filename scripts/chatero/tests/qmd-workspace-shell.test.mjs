import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";
import { createVerifiedReadonlySession } from "../lib/verified-readonly-session.mjs";

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

test("readonly Knowledge QMD presentation keeps three views but exposes no mutation controls", async () => {
	const QLab = await loadQLab();
	const document = QLab.createWorkspaceDocumentDescriptor({
		relativePath: "knowledge/topic.qmd",
		authority: "draft",
		format: "bibtex",
		readOnly: false,
	});
	const html = QLab.renderQmdWorkspaceHTML({
		path: document.relativePath,
		document,
	});

	assert.match(html, /Trusted Knowledge/);
	assert.match(html, /Trusted Knowledge is read-only in Chatero\./);
	assert.match(html, /data-qlab-document-readonly="true"/);
	assert.deepEqual(
		Array.from(html.matchAll(/data-qlab-surface="(visual|website|source)"/g), match => match[1]),
		["visual", "source", "website"],
	);
	for (const mutation of [
		"data-qlab-draft-save", "data-qlab-draft-ai", "data-qlab-add-to-knowledge",
		"data-qlab-complete-todos", "data-qlab-proposal-compare", "data-qlab-draft-keep",
		"data-qlab-draft-reject", "data-qlab-formal-toggle", "data-qlab-external-editor",
		"data-qlab-compliance", "data-qlab-compliance-details",
	]) {
		assert.equal(html.includes(mutation), false, mutation);
	}
	assert.match(html, /data-qlab-refresh-surface/);
	assert.match(html, /title="QMD source viewer"/);
	assert.doesNotMatch(html, /title="QMD source editor"/);
});

test("readonly BibTeX presentation is Source-only and offers citekey search", async () => {
	const QLab = await loadQLab();
	const document = QLab.createWorkspaceDocumentDescriptor({
		relativePath: "literature/references.bib",
		authority: "draft",
		format: "qmd",
		readOnly: false,
	});
	const html = QLab.renderQmdWorkspaceHTML({
		path: document.relativePath,
		document,
	});

	assert.match(html, /External Evidence/);
	assert.match(html, /External Evidence is read-only in Chatero\./);
	assert.deepEqual(
		Array.from(html.matchAll(/data-qlab-surface="(visual|website|source)"/g), match => match[1]),
		["source"],
	);
	assert.doesNotMatch(html, /data-qlab-preview-toggle/);
	assert.match(html, /data-qlab-bib-search/);
	assert.match(html, /Citekey search/);
	assert.match(html, /data-qlab-bib-search[^>]*>[\s\S]*?data-qlab-icon="search"/);
	assert.match(html, /class="qlab-qmd-tab-q">@<\/span>/);
	assert.match(html, /title="BibTeX source viewer"/);
	assert.doesNotMatch(html, /title="QMD source editor"/);
});

test("workspace mount never reads Literature bibliography through generic Draft IO", async () => {
	const source = await readFile(new URL(
		"../../../chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js",
		import.meta.url,
	), "utf8");
	assert.doesNotMatch(source, /literature\/ref\.bib/);
	assert.doesNotMatch(source, /ioHost\.(?:exists|read)\([^)]*bib/i);
	assert.match(source, /requiresProposal[\s\S]+control\.disabled\s*=\s*!allowed\s*\|\|\s*\(requiresProposal\s*&&\s*!proposal\)/);
	assert.equal(
		Array.from(source.matchAll(/let request = openGate\.begin\(\);\s*documentManager\.invalidatePrepared\(\);/g)).length,
		2,
		"both direct and staged readonly opens invalidate an older prepared stage before Draft flush",
	);
});

test("document chrome transitions Draft to Bib or readonly QMD and back without stale semantics", async () => {
	const QLab = await loadQLab();
	function element(extra = {}) {
		const attributes = new Map();
		return {
			hidden: false,
			disabled: false,
			textContent: "",
			dataset: {},
			setAttribute(name, value) { attributes.set(name, String(value)); },
			removeAttribute(name) { attributes.delete(name); },
			getAttribute(name) { return attributes.get(name) || ""; },
			...extra,
		};
	}
	const shell = element({ classList: { toggle() {} } });
	const badge = element();
	const pathWrap = element();
	const authority = element();
	const sourceMarker = element({ textContent: "Q" });
	const sourceFrame = element({ title: "QMD source editor" });
	const sourcePane = element();
	const visualPaneTitle = element({ textContent: "VISUAL EDIT" });
	const visualPane = element({
		querySelector: selector => selector === ".qlab-qmd-pane-title span" ? visualPaneTitle : null,
	});
	const visualRoot = element();
	const visualTools = element();
	const inline = element({ hidden: true });
	const formalToggle = element();
	const compare = element();
	const keep = element();
	const reject = element();
	const search = element();
	const previewToggle = element();
	const preview = element();
	const selectors = new Map([
		[".qlab-qmd-workspace", shell],
		["[data-qlab-authority-badge]", badge],
		[".qlab-qmd-path-wrap", pathWrap],
		[".qlab-qmd-authority", authority],
		[".qlab-qmd-tab-q", sourceMarker],
		["[data-qlab-qmd-monaco]", sourceFrame],
		["[data-qlab-source-surface]", sourcePane],
		["[data-qlab-visual-surface]", visualPane],
		["[data-qlab-visual-editor-root]", visualRoot],
		["[data-qlab-visual-tools]", visualTools],
		["[data-qlab-inline]", inline],
		["[data-qlab-formal-toggle]", formalToggle],
		["[data-qlab-proposal-compare]", compare],
		["[data-qlab-draft-keep]", keep],
		["[data-qlab-draft-reject]", reject],
		["[data-qlab-bib-search]", search],
		["[data-qlab-preview-toggle]", previewToggle],
		["[data-qlab-preview-surface]", preview],
	]);
	const host = {
		_qlabSurfaceMode: "visual",
		querySelector: selector => selectors.get(selector) || null,
		querySelectorAll: selector => selectors.has(selector) ? [selectors.get(selector)] : [],
	};
	const draft = QLab.createQmdDraftDocumentDescriptor({ relativePath: "drafts/a.qmd" });
	const bib = QLab.createWorkspaceDocumentDescriptor({ relativePath: "literature/ref.bib" });
	const knowledge = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/topic.qmd" });

	assert.equal(QLab.applyQmdDocumentChrome(host, draft, { proposal: false }), true);
	assert.equal(inline.hidden, true, "opening a Draft must not expand the stateful AI bar");
	assert.equal(compare.disabled && keep.disabled && reject.disabled, true);
	QLab.applyQmdDocumentChrome(host, bib);
	assert.equal(sourceMarker.textContent, "@");
	assert.equal(sourceFrame.title, "BibTeX source viewer");
	assert.equal(sourcePane.getAttribute("aria-label"), "Monaco BibTeX source viewer");
	assert.equal(visualTools.hidden, true);
	QLab.applyQmdDocumentChrome(host, knowledge);
	assert.equal(sourceFrame.title, "QMD source viewer");
	assert.equal(visualPaneTitle.textContent, "VISUAL VIEW");
	assert.equal(visualPane.getAttribute("aria-label"), "Visual QMD view");
	assert.equal(visualRoot.getAttribute("aria-label"), "Visual QMD view");
	assert.equal(visualRoot.getAttribute("aria-readonly"), "true");
	QLab.applyQmdDocumentChrome(host, draft, { proposal: false });
	assert.equal(sourceMarker.textContent, "Q");
	assert.equal(sourceFrame.title, "QMD source editor");
	assert.equal(sourcePane.getAttribute("aria-label"), "Monaco QMD source editor");
	assert.equal(visualPaneTitle.textContent, "VISUAL EDIT");
	assert.equal(visualPane.getAttribute("aria-label"), "Visual QMD editor");
	assert.equal(visualRoot.getAttribute("aria-label"), "Visual QMD editor");
	assert.equal(visualRoot.getAttribute("aria-readonly"), "false");
	assert.equal(visualTools.hidden, false, "Draft Visual tools must be restored");
	assert.equal(inline.hidden, true, "returning to Draft still must not auto-open AI");
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

	assert.equal(surface.clear(), true);
	assert.equal(quick.srcdoc, "");
	assert.equal(quick.hidden, true);
	assert.equal(browser.getAttribute("src"), "");
	assert.equal(browser.hidden, true);
	assert.equal(browserHost.hidden, true);
	assert.equal(empty.hidden, false);
	assert.match(empty.textContent, /preview unavailable/i);
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
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdPreviewPresentation({}))), {
		mode: "empty",
		status: "Preview unavailable",
		tone: "idle",
	});
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

test("workspace refresh failures become an error status and resolve false", async () => {
	const QLab = await loadQLab();
	const errors = [];
	const result = await QLab.runQmdWorkspaceRefresh(
		async () => { throw new Error("verified reload failed"); },
		error => errors.push(error.message),
	);
	assert.equal(result, false);
	assert.deepEqual(errors, ["verified reload failed"]);
});

test("an unchanged verified readonly reload still continues the active-surface refresh", async () => {
	const source = await readFile(new URL(
		"../../../chrome/content/zotero/xpcom/qlab/qmdWorkspaceShell.js",
		import.meta.url,
	), "utf8");
	assert.match(source, /await documentManager\.reloadActive\(\);[\s\S]+let surface = controller\.snapshot\(\)\.surface/);
	assert.doesNotMatch(source, /!await documentManager\.reloadActive\(\)/);
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

test("workspace disposal closes surface resources but leaves manager-owned sessions alone", async () => {
	const QLab = await loadQLab();
	let calls = [];
	let workspace = QLab.createQmdWorkspaceController({
		ownsSession: false,
		watcher: { dispose: () => calls.push("watcher") },
		monaco: { dispose: () => calls.push("monaco") },
		preview: { dispose: () => calls.push("preview") },
		session: { dispose: () => calls.push("session") },
	});
	workspace.dispose();
	workspace.dispose();
	assert.deepEqual(calls, ["watcher", "monaco", "preview"]);
});

test("workspace quiesce synchronously stops callbacks before a best-effort Draft flush", async () => {
	const QLab = await loadQLab();
	let calls = [];
	let workspace = QLab.createQmdWorkspaceController({
		ownsSession: false,
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
	assert.deepEqual(calls, ["watcher", "monaco", "preview", "visual"]);
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
	let state = { path: "drafts/a.qmd", text: "old", revision: "r1" };
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
	assert.equal(documentState.editable.capabilities.edit, true);
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
	let state = { path: "drafts/a.qmd", text: "old", revision: "r1" };
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

test("Visual bridge gives readonly documents frozen authority and rejects its direct save seam", async () => {
	const QLab = await loadQLab();
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "literature/paper.qmd" });
	const session = await createVerifiedReadonlySession(QLab, {
		descriptor,
		text: "# Evidence\n",
	});
	let received;
	const visual = {
		setDocument(snapshot, document, generation) {
			received = { snapshot, document, generation };
		},
		snapshot: () => ({ source: "# Evidence\n", revision: "r1" }),
		isEditing: () => false,
	};
	const bridge = QLab.createQmdVisualSessionBridge(visual);
	const generation = bridge.setSession(session);
	const sessionDescriptor = session.snapshot().document;

	assert.notEqual(sessionDescriptor, descriptor, "the session must discard caller-owned descriptor identity");
	assert.equal(received.document, sessionDescriptor);
	assert.equal(Object.isFrozen(received.document.capabilities), true);
	assert.equal(received.document.capabilities.edit, false);
	await assert.rejects(
		() => bridge.save("attack\n", "r1", generation),
		/read-only/i,
	);
	assert.equal(session.snapshot().text, "# Evidence\n");
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
		snapshot: () => ({ path: "drafts/a.qmd", dirty: false, saveError: "" }),
	};
	assert.equal(await QLab.flushQmdDraftBeforeTransition(session, visual), true);
	assert.deepEqual(order, ["visual", "session"]);

	visual.finishActiveEdit = async () => { order.push("blocked"); };
	editing = true;
	assert.equal(await QLab.flushQmdDraftBeforeTransition(session, visual), false);
	assert.deepEqual(order, ["visual", "session", "blocked"]);
});

test("readonly surface navigation never calls a save method", async () => {
	const QLab = await loadQLab();
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/topic.qmd" });
	const session = await createVerifiedReadonlySession(QLab, {
		descriptor,
		text: "# Trusted\n",
	});
	assert.equal(await QLab.flushQmdDraftBeforeTransition(session, null), true);
	assert.equal(session.snapshot().text, "# Trusted\n");
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
	const document = QLab.createQmdDraftDocumentDescriptor({ relativePath: "drafts/a.qmd" });
	const session = { snapshot: () => ({ path: document.relativePath, document }) };
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
		session,
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
	const document = QLab.createQmdDraftDocumentDescriptor({ relativePath: "drafts/a.qmd" });
	const session = { snapshot: () => ({ path: document.relativePath, document }) };
	const calls = [];
	const host = {};
	QLab.addCurrentContextToChat = async () => calls.push("chat");

	const result = await QLab.handleQmdMonacoWorkspaceCommand({
		host,
		view: {},
		session,
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

test("readonly Monaco commands reject Save and AI while preserving Chat selection", async () => {
	const QLab = await loadQLab();
	const document = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/topic.qmd" });
	const session = await createVerifiedReadonlySession(QLab, {
		descriptor: document,
		text: "# Trusted\n",
	});
	const calls = [];
	const host = {};
	QLab.addCurrentContextToChat = async () => {
		calls.push("chat");
		return "chat";
	};

	assert.equal(await QLab.handleQmdMonacoWorkspaceCommand({
		host,
		session,
		command: "save",
		onSave: () => calls.push("save"),
	}), null);
	assert.equal(await QLab.handleQmdMonacoWorkspaceCommand({
		host,
		session,
		command: "ai",
		event: { selection: "Trusted", start: 2, end: 9 },
		onInlineWrite: () => calls.push("inline"),
	}), null);
	assert.equal(await QLab.handleQmdMonacoWorkspaceCommand({
		host,
		session,
		command: "chat-selection",
		event: { selection: "Trusted", start: 2, end: 9 },
	}), "chat");
	assert.deepEqual(calls, ["chat"]);
	assert.equal(session.snapshot().text, "# Trusted\n");
});

test("workspace session capability checks always use a path-derived descriptor", async () => {
	const QLab = await loadQLab();
	const normalized = QLab.createWorkspaceDocumentDescriptor({ relativePath: "literature/paper.qmd" });
	const denied = Object.entries(normalized.capabilities)
		.filter(([, allowed]) => allowed === false)
		.map(([name]) => name);
	for (const capability of denied) {
		const capabilities = Object.freeze({ ...normalized.capabilities, [capability]: true });
		const forged = Object.freeze({ ...normalized, capabilities });
		const session = {
			snapshot: () => ({ path: normalized.relativePath, document: forged }),
		};
		assert.equal(QLab.qmdSessionAllows(session, capability), false, capability);
	}
});

test("workspace mutation boundary rejects every readonly write capability before invocation", async () => {
	const QLab = await loadQLab();
	const document = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/topic.qmd" });
	const session = await createVerifiedReadonlySession(QLab, { descriptor: document, text: "trusted\n" });
	const denied = Object.entries(document.capabilities)
		.filter(([, allowed]) => allowed === false)
		.map(([name]) => name);
	let calls = 0;
	for (const capability of denied) {
		const result = QLab.runQmdWorkspaceCapability(
			session,
			capability,
			() => { calls++; return "mutated"; },
			"blocked",
		);
		assert.equal(result, "blocked", capability);
	}
	assert.equal(calls, 0);
	assert.equal(session.snapshot().text, "trusted\n");

	const draft = QLab.createQmdDraftDocumentDescriptor({ relativePath: "drafts/a.qmd" });
	const draftSession = { snapshot: () => ({ path: draft.relativePath, document: draft }) };
	assert.equal(QLab.runQmdWorkspaceCapability(
		draftSession,
		"save",
		() => { calls++; return "saved"; },
	), "saved");
	assert.equal(calls, 1);
});
