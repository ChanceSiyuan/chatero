import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

function samplePdfContext() {
	return {
		attachment: {
			id: 12,
			key: "ABCDEFGH",
			libraryID: 1,
			filename: "paper.pdf",
		},
		parent: {
			id: 9,
			key: "PARENTKEY",
			title: "Attention Is All You Need",
		},
		page: {
			pageIndex: 2,
			pageNumber: 3,
			text: "page body",
		},
		selection: {
			text: "scaled dot-product attention",
			pageIndex: 2,
			pageNumber: 3,
		},
	};
}

test("createPdfComposerTag prefers selection then page then paper", async () => {
	const QLab = await loadQLab();
	const ctx = samplePdfContext();
	const sel = QLab.createPdfComposerTag(ctx, "auto");
	assert.equal(sel.kind, "pdf-selection");
	assert.match(sel.label, /sel/);
	assert.equal(sel.origin.type, "pdf");
	assert.equal(sel.origin.pageNumber, 3);

	const page = QLab.createPdfComposerTag({ ...ctx, selection: null }, "auto");
	assert.equal(page.kind, "pdf-page");
	assert.match(page.label, /p\.3/);

	const paper = QLab.createPdfComposerTag({
		...ctx,
		selection: null,
		page: null,
	}, "auto");
	assert.equal(paper.kind, "pdf-paper");
});

test("createQmdComposerTag pins selection or whole live draft", async () => {
	const QLab = await loadQLab();
	const file = QLab.createQmdComposerTag({
		relativePath: "drafts/notes/a.qmd",
		source: "# Hello\n\nBody\n",
		surfaceMode: "source",
	});
	assert.equal(file.kind, "qmd-file");
	assert.match(file.label, /a\.qmd/);

	const sel = QLab.createQmdComposerTag({
		relativePath: "drafts/notes/a.qmd",
		source: "# Hello\n\nBody\n",
		selection: "Body",
		surfaceMode: "visual",
	});
	assert.equal(sel.kind, "qmd-selection");
	assert.equal(sel.text, "Body");
	assert.equal(sel.origin.type, "qmd");
});

test("ChatComposerContext upserts stableKey and formats prompt", async () => {
	const QLab = await loadQLab();
	QLab.ChatComposerContext.clear();
	const a = QLab.ChatComposerContext.add(QLab.createPdfComposerTag(samplePdfContext()));
	assert.equal(QLab.ChatComposerContext.list().length, 1);
	QLab.ChatComposerContext.add({
		...QLab.createPdfComposerTag(samplePdfContext()),
		text: "updated selection",
	});
	assert.equal(QLab.ChatComposerContext.list().length, 1);
	assert.equal(QLab.ChatComposerContext.list()[0].text, "updated selection");

	const prompt = QLab.ChatComposerContext.formatForPrompt();
	assert.match(prompt, /<composer_context>/);
	assert.match(prompt, /@pdf-selection/);
	assert.match(prompt, /updated selection/);

	QLab.ChatComposerContext.remove(a.id);
	// removed old id; upsert replaced it so remove may no-op — clear instead
	QLab.ChatComposerContext.clear();
	assert.equal(QLab.ChatComposerContext.list().length, 0);
});

test("chat shell HTML shows composer tags row not ambient checkboxes", async () => {
	const QLab = await loadQLab();
	QLab.ChatComposerContext.clear();
	QLab.ChatComposerContext.add(QLab.createQmdComposerTag({
		relativePath: "drafts/a.qmd",
		source: "x",
	}));
	const html = QLab.renderShellHTML({
		kind: "qlabchat",
		workspaceState: "ready",
		root: "/tmp/ws",
	});
	assert.match(html, /data-qlab-context-tags/);
	assert.match(html, /data-qlab-tag-reveal/);
	assert.match(html, /data-qlab-tag-remove/);
	assert.ok(!html.includes('data-qlab-chip="paper"'));
	assert.match(html, /⌘L/);
});

test("renderComposerTagsHTML empty state hints ⌘L", async () => {
	const QLab = await loadQLab();
	QLab.ChatComposerContext.clear();
	const html = QLab.renderComposerTagsHTML();
	assert.match(html, /⌘L/);
});
