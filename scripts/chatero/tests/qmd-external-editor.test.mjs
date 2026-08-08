import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("installedQmdEditors detects macOS application bundles in preference order", async () => {
	const QLab = await loadQLab();
	let existing = new Set([
		"/Applications/Cursor.app",
		"/Users/me/Applications/Zed.app",
	]);
	let installed = await QLab.installedQmdEditors({
		exists: async path => existing.has(path),
		homeDirectory: () => "/Users/me",
	});
	assert.deepEqual(
		JSON.parse(JSON.stringify(installed.map(editor => editor.id))),
		["cursor", "zed"],
	);
});

test("preferredQmdEditor uses remembered installed editor then falls back", async () => {
	const QLab = await loadQLab();
	let installed = QLab.QMD_EXTERNAL_EDITORS.filter(editor => ["cursor", "zed"].includes(editor.id));
	assert.equal(QLab.preferredQmdEditor(installed, "zed").id, "zed");
	assert.equal(QLab.preferredQmdEditor(installed, "missing").id, "cursor");
	assert.equal(QLab.preferredQmdEditor([], "cursor"), null);
});

test("openQmdInExternalEditor launches the repository and exact Draft together", async () => {
	const QLab = await loadQLab();
	let launches = [];
	let runtime = {
		realPath: async path => path,
		launch: async (application, paths) => launches.push({ application, paths }),
	};
	await QLab.openQmdInExternalEditor(
		runtime,
		QLab.QMD_EXTERNAL_EDITORS[0],
		"/Users/me/qlab",
		"drafts/topic/note.qmd",
	);
	assert.deepEqual(JSON.parse(JSON.stringify(launches)), [{
		application: "Cursor",
		paths: ["/Users/me/qlab", "/Users/me/qlab/drafts/topic/note.qmd"],
	}]);
});

test("openQmdInExternalEditor rejects unsafe and symlinked Draft paths", async () => {
	const QLab = await loadQLab();
	let editor = QLab.QMD_EXTERNAL_EDITORS[0];
	let runtime = {
		realPath: async path => path,
		launch: async () => assert.fail("unsafe paths must never launch"),
	};
	await assert.rejects(
		QLab.openQmdInExternalEditor(runtime, editor, "/repo", "knowledge/a.qmd"),
		/under drafts/i,
	);
	await assert.rejects(
		QLab.openQmdInExternalEditor(runtime, editor, "/repo", "drafts/../secret.qmd"),
		/unsafe|under drafts/i,
	);
	await assert.rejects(
		QLab.openQmdInExternalEditor(runtime, editor, "/repo", "drafts/notes.txt"),
		/safe QMD path/i,
	);
	let symlinkRuntime = {
		realPath: async path => path.endsWith("/drafts/topic/note.qmd") ? "/tmp/private.qmd" : path,
		launch: async () => assert.fail("symlink targets must never launch"),
	};
	await assert.rejects(
		QLab.openQmdInExternalEditor(
			symlinkRuntime,
			editor,
			"/repo",
			"drafts/topic/note.qmd",
		),
		/symbolic link|outside/i,
	);
});

test("createQmdExternalEditorRuntime uses one open -a invocation", async () => {
	const QLab = await loadQLab();
	let argv = [];
	let runtime = QLab.createQmdExternalEditorRuntime(async value => argv.push(value), {
		exists: async () => true,
		realPath: async path => path,
		homeDirectory: () => "/Users/me",
	});
	await runtime.launch("Cursor", ["/repo", "/repo/drafts/a.qmd"]);
	assert.deepEqual(
		JSON.parse(JSON.stringify(argv)),
		[["/usr/bin/open", "-a", "Cursor", "/repo", "/repo/drafts/a.qmd"]],
	);
});
