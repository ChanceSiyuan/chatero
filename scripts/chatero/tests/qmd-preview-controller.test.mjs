import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("controller retains the last good URL when a rebuild fails", async () => {
	const QLab = await loadQLab();
	let starts = ["http://127.0.0.1:43001/a.html", new Error("compile failed")];
	let quick = "<main>quick v1</main>";
	let controller = QLab.createQmdPreviewController({
		root: "/repo",
		path: "drafts/a.qmd",
		fallback: () => quick,
		startPreview: async () => {
			let next = starts.shift();
			if (next instanceof Error) throw next;
			return next;
		},
		stopPreview: () => {},
	});
	await controller.start();
	quick = "<main>quick v2</main>";
	await controller.refresh("r2");
	assert.equal(controller.snapshot().url, "http://127.0.0.1:43001/a.html");
	assert.equal(controller.snapshot().fallback, "<main>quick v2</main>");
	assert.equal(controller.snapshot().status, "error");
	assert.equal(controller.snapshot().revision, "r2");
});

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
	assert.equal(controller.snapshot().status, "ready");
});

test("an initially hidden preview defers quick rendering and Quarto until revealed", async () => {
	const QLab = await loadQLab();
	let starts = 0;
	let fallbacks = 0;
	let controller = QLab.createQmdPreviewController({
		root: "/repo",
		path: "drafts/a.qmd",
		visible: false,
		fallback: () => {
			fallbacks++;
			return "<main>quick</main>";
		},
		startPreview: async () => {
			starts++;
			return "http://127.0.0.1:43001/a.html";
		},
		stopPreview: () => {},
	});
	await controller.start();
	assert.equal(starts, 0);
	assert.equal(fallbacks, 0);
	assert.equal(controller.snapshot().status, "stale");
	await controller.setVisible(true);
	assert.equal(starts, 1);
	assert.equal(fallbacks, 1);
	assert.equal(controller.snapshot().status, "ready");
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

test("disposing during a pending launch cancels the stale generation after a rapid file switch", async () => {
	const QLab = await loadQLab();
	let release;
	let started = new Promise(resolve => { release = resolve; });
	let stops = 0;
	let controller = QLab.createQmdPreviewController({
		root: "/repo",
		path: "drafts/first.qmd",
		startPreview: () => started,
		stopPreview: () => stops++,
	});
	let launch = controller.start();
	controller.dispose();
	release("http://127.0.0.1:43001/first.html");
	await launch;
	assert.equal(stops, 1);
	assert.equal(controller.snapshot().status, "rendering");
	assert.equal(controller.snapshot().url, "");
});
