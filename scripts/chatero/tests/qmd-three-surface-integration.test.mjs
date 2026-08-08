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
		"the workspace remains the sole owner of every resident surface resource",
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
