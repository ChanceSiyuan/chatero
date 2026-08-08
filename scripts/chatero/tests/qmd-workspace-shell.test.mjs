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
	assert.match(html, /data-qlab-primary-surface/);
	assert.match(html, /data-qlab-preview-toggle[^>]+aria-pressed="false"/);
	assert.doesNotMatch(html, /role="separator"/);
	assert.match(html, /data-qlab-qmd-status/);
	assert.match(html, /data-qlab-draft-row="drafts\/a\.qmd"/);
	assert.match(html, /data-qlab-preview-version="original"/);
	assert.match(html, /data-qlab-preview-version="proposed"/);
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
