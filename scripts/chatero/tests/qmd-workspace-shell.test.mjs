import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("workspace renders Explorer and one switchable Source or Preview surface", async () => {
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
	assert.match(html, /data-qlab-qmd-preview/);
	assert.match(html, /data-qlab-preview-stage/);
	assert.match(html, /data-qlab-preview-quick/);
	assert.match(html, /data-qlab-preview-browser-host/);
	assert.match(html, /data-qlab-primary-surface/);
	assert.match(html, /data-qlab-preview-toggle[^>]+aria-pressed="false"/);
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

test("workspace toggles Source and Preview while remembering Explorer visibility", async () => {
	const QLab = await loadQLab();
	let layouts = [];
	let workspace = QLab.createQmdWorkspaceController({
		onLayout: value => layouts.push(value),
		previewVisible: false,
	});
	assert.equal(workspace.snapshot().surface, "source");
	workspace.toggleSurface();
	assert.equal(workspace.snapshot().surface, "preview");
	workspace.toggleSurface();
	assert.equal(workspace.snapshot().surface, "source");
	workspace.toggleExplorer(false);
	let state = workspace.snapshot();
	assert.equal(state.explorerVisible, false);
	assert.equal(layouts.length, 3);
});
