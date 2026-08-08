import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("workspace controls expose names without visible toolbar text", async () => {
	const QLab = await loadQLab();
	let model = QLab.qmdWorkspaceAccessibilityModel({ proposal: true, previewStatus: "error" });
	assert.equal(model.actions.keep.label, "Keep AI changes");
	assert.equal(model.actions.reject.label, "Reject AI changes");
	assert.equal(model.splitter.role, "separator");
	assert.equal(model.status.includes("Preview failed"), true);
});

test("rendered controls have labels, live status, and keyboard separator semantics", async () => {
	const QLab = await loadQLab();
	let html = QLab.renderQmdWorkspaceHTML({ status: "Ready", proposal: true });
	assert.match(html, /aria-label="Keep AI changes"/);
	assert.match(html, /aria-label="Reject AI changes"/);
	assert.match(html, /role="separator" tabindex="0"/);
	assert.match(html, /role="status" aria-live="polite"/);
	assert.match(html, /data-l10n-id="qlab-qmd-keep"/);
});

test("workspace styles preserve Preview at medium widths and honor reduced motion", async () => {
	let source = await readFile(
		new URL("../../../scss/components/_qlabQmdWorkspace.scss", import.meta.url),
		"utf8",
	);
	assert.match(source, /max-width:\s*1050px/);
	assert.match(source, /max-width:\s*720px/);
	assert.match(source, /prefers-reduced-motion:\s*reduce/);
	assert.match(source, /:focus-visible/);
});

test("English Fluent catalog contains the QMD workspace vocabulary", async () => {
	let source = await readFile(
		new URL("../../../chrome/locale/en-US/zotero/zotero.ftl", import.meta.url),
		"utf8",
	);
	for (let id of ["qlab-qmd-explorer", "qlab-qmd-preview", "qlab-qmd-keep", "qlab-qmd-reject", "qlab-qmd-conflict"]) {
		assert.match(source, new RegExp(`^${id}\\s*=`, "m"));
	}
});
