import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("controller retains the last good URL when a rebuild fails", async () => {
	const QLab = await loadQLab();
	let starts = ["http://127.0.0.1:43001/", new Error("compile failed")];
	let controller = QLab.createQmdPreviewController({
		root: "/repo",
		path: "drafts/a.qmd",
		startPreview: async () => {
			let next = starts.shift();
			if (next instanceof Error) throw next;
			return next;
		},
		stopPreview: () => {},
	});
	await controller.start();
	await controller.refresh("r2");
	assert.equal(controller.snapshot().url, "http://127.0.0.1:43001/");
	assert.equal(controller.snapshot().status, "error");
	assert.equal(controller.snapshot().revision, "r2");
});

test("three consecutive crashes pause automatic restart", async () => {
	const QLab = await loadQLab();
	let controller = QLab.createQmdPreviewController({
		root: "/repo",
		path: "drafts/a.qmd",
		startPreview: async () => { throw new Error("crash"); },
		stopPreview: () => {},
	});
	await controller.start();
	await controller.retry();
	await controller.retry();
	assert.equal(controller.snapshot().canAutoRestart, false);
	assert.equal(controller.snapshot().crashCount, 3);
	let before = controller.snapshot().crashCount;
	await controller.refresh("r3");
	assert.equal(controller.snapshot().crashCount, before);
});

test("hidden preview defers refresh until it becomes visible", async () => {
	const QLab = await loadQLab();
	let starts = 0;
	let controller = QLab.createQmdPreviewController({
		root: "/repo",
		path: "drafts/a.qmd",
		startPreview: async () => `http://127.0.0.1:${43000 + ++starts}/`,
		stopPreview: () => {},
	});
	controller.setVisible(false);
	await controller.refresh("r2");
	assert.equal(starts, 0);
	assert.equal(controller.snapshot().status, "stale");
	await controller.setVisible(true);
	assert.equal(starts, 1);
	assert.equal(controller.snapshot().status, "ready");
});

test("Quarto stderr is converted into Draft diagnostics", async () => {
	const QLab = await loadQLab();
	let diagnostics = QLab.parseQmdQuartoDiagnostics(
		"ERROR: drafts/a.qmd:12:7 unexpected fenced div\n"
		+ "drafts/a.qmd:12:7 unexpected fenced div\n"
		+ "other.qmd:2:1 unrelated",
		"drafts/a.qmd"
	);
	assert.deepEqual(JSON.parse(JSON.stringify(diagnostics)), [{
		code: "quarto",
		severity: "error",
		message: "unexpected fenced div",
		line: 12,
		column: 7,
	}]);
});

test("disposing a preview controller stops its owned session once", async () => {
	const QLab = await loadQLab();
	let stops = 0;
	let controller = QLab.createQmdPreviewController({
		root: "/repo",
		path: "drafts/a.qmd",
		startPreview: async () => "http://127.0.0.1:43001/",
		stopPreview: () => stops++,
	});
	await controller.start();
	controller.dispose();
	controller.dispose();
	assert.equal(stops, 1);
	assert.equal(controller.snapshot().disposed, true);
});
