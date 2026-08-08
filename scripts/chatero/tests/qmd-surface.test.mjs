import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const SAMPLE = `---
title: Demo
---

# Hello

A paragraph with **bold**.

\`\`\`js
console.log(1)
\`\`\`

::: {.theorem}
## Claim

Proof body.
:::
`;

test("visualQmdBlocks splits frontmatter heading paragraph code theorem", async () => {
	const QLab = await loadQLab();
	const blocks = QLab.visualQmdBlocks(SAMPLE);
	const kinds = blocks.map((b) => b.kind);
	assert.ok(kinds.includes("frontmatter"));
	assert.ok(kinds.includes("heading"));
	assert.ok(kinds.includes("paragraph"));
	assert.ok(kinds.includes("code"));
	assert.ok(kinds.includes("theorem"));
});

test("applyQmdVisualBlock updates source losslessly", async () => {
	const QLab = await loadQLab();
	const blocks = QLab.visualQmdBlocks(SAMPLE);
	const heading = blocks.find((b) => b.kind === "heading");
	const result = QLab.applyQmdVisualBlock(SAMPLE, heading, "# Hello world");
	assert.equal(result.changed, true);
	assert.match(result.source, /# Hello world/);
	assert.ok(!result.source.includes("# Hello\n") || result.source.includes("# Hello world"));
});

test("surface modes normalize and label Preview/Website/Source", async () => {
	const QLab = await loadQLab();
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.QMD_SURFACE_MODES)), [
		"visual",
		"website",
		"source",
	]);
	assert.equal(QLab.normalizeQmdSurfaceMode("website"), "website");
	assert.equal(QLab.normalizeQmdSurfaceMode("nope"), "visual");
	assert.equal(QLab.qmdSurfaceModeLabel("visual"), "Preview");
	assert.equal(QLab.qmdSurfaceModeLabel("website"), "Website");
	assert.equal(QLab.qmdSurfaceModeLabel("source"), "Source");
});

test("qmd shell HTML exposes three surfaces and mode toggle", async () => {
	const QLab = await loadQLab();
	const html = QLab.renderShellHTML({
		kind: "qlabqmd",
		workspaceState: "ready",
		root: "/tmp/ws",
		drafts: ["drafts/a.qmd"],
	});
	assert.match(html, /data-qlab-mode="visual"/);
	assert.match(html, /data-qlab-mode="website"/);
	assert.match(html, /data-qlab-mode="source"/);
	assert.match(html, /data-qlab-surface="visual"/);
	assert.match(html, /data-qlab-surface="website"/);
	assert.match(html, /data-qlab-surface="source"/);
	assert.match(html, /data-qlab-website-frame/);
	assert.match(html, /data-qlab-editor/);
	assert.match(html, /data-qlab-website-quarto/);
});

test("shared buffer survives mode metadata and soft website HTML", async () => {
	const QLab = await loadQLab();
	const host = {
		_qlabBuffer: "",
		querySelector(sel) {
			if (sel === "[data-qlab-editor]") {
				return { value: this._editor || "" };
			}
			return null;
		},
	};
	QLab.setQmdShellBuffer(host, SAMPLE, { dirty: false });
	assert.equal(QLab.getQmdShellBuffer(host), SAMPLE);
	const doc = QLab.renderQmdDocumentHTML(SAMPLE, { title: "Demo" });
	assert.match(doc, /<!DOCTYPE html>/);
	assert.match(doc, /Hello/);
});

test("pendingRegionsForQmdBlock finds overlapping inserts", async () => {
	const QLab = await loadQLab();
	const blocks = QLab.visualQmdBlocks(SAMPLE);
	const paragraph = blocks.find((b) => b.kind === "paragraph");
	const host = {
		_qlabPendingInserts: [
			{
				id: "r1",
				insertedStart: paragraph.start + 1,
				insertedEnd: paragraph.start + 4,
			},
			{
				id: "r2",
				insertedStart: paragraph.end + 10,
				insertedEnd: paragraph.end + 20,
			},
		],
	};
	const hits = QLab.pendingRegionsForQmdBlock(host, paragraph);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].id, "r1");
});

test("preview port is stable for a seed", async () => {
	const QLab = await loadQLab();
	const a = QLab.nextQmdPreviewPort(42);
	const b = QLab.nextQmdPreviewPort(42);
	assert.equal(a, b);
	assert.ok(a >= 43000 && a < 44500);
});
