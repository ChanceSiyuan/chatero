import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("workspace controls expose names without visible toolbar text", async () => {
	const QLab = await loadQLab();
	let model = QLab.qmdWorkspaceAccessibilityModel({ proposal: true, previewStatus: "error" });
	assert.equal(model.actions.keep.label, "Keep AI changes");
	assert.equal(model.actions.reject.label, "Reject AI changes");
	assert.equal(model.actions.retry.label, "Retry Quarto Preview");
	assert.equal(model.status.includes("Preview failed"), true);
});

test("rendered controls have labels, pressed state, and live status semantics", async () => {
	const QLab = await loadQLab();
	let html = QLab.renderQmdWorkspaceHTML({ status: "Ready", proposal: true });
	assert.match(html, /aria-label="Keep AI changes"/);
	assert.match(html, /aria-label="Reject AI changes"/);
	assert.match(html, /data-qlab-preview-toggle[^>]+aria-pressed="false"/);
	assert.doesNotMatch(html, /role="separator"/);
	assert.match(html, /role="status" aria-live="polite"/);
	assert.match(html, /data-l10n-id="qlab-qmd-keep"/);
	assert.match(html, /data-qlab-preview-retry/);
});

test("workspace styles hide icon labels and use a QMD-local compact Explorer drawer", async () => {
	let source = await readFile(
		new URL("../../../scss/components/_qlabQmdWorkspace.scss", import.meta.url),
		"utf8",
	);
	assert.match(source, /\.qlab-qmd-workspace-action\s*\{[\s\S]+\.sr-only\s*\{[\s\S]+clip:/);
	assert.match(source, /\.qlab-qmd-primary-surface/);
	assert.match(source, /@media\s*\(max-width:\s*900px\)[\s\S]+\.qlab-qmd-explorer[\s\S]+position:\s*absolute/);
	assert.match(source, /\.qlab-qmd-toolbar-actions[\s\S]+overflow:\s*hidden/);
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
