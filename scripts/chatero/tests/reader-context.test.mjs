import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("ReaderContextStore formats paper/page/selection chips", async () => {
	const QLab = await loadQLab();
	const store = QLab.ReaderContextStore;
	store.clear();
	assert.equal(store.formatForPrompt(), "");

	store._context = Object.freeze({
		schemaVersion: 1,
		capturedAt: "2026-08-07T00:00:00.000Z",
		attachment: Object.freeze({
			id: 12,
			key: "ABCDEFGH",
			libraryID: 1,
			filename: "paper.pdf",
		}),
		parent: Object.freeze({
			id: 9,
			key: "PARENTKEY",
			title: "Attention Is All You Need",
		}),
		page: Object.freeze({
			pageIndex: 2,
			pageNumber: 3,
			text: "page body",
		}),
		selection: Object.freeze({
			text: "scaled dot-product attention",
			pageIndex: 2,
			pageNumber: 3,
		}),
		warnings: Object.freeze([]),
	});

	const all = store.formatForPrompt();
	assert.match(all, /<reader_context>/);
	assert.match(all, /Attention Is All You Need/);
	assert.match(all, /Page: 3/);
	assert.match(all, /page body/);
	assert.match(all, /scaled dot-product attention/);

	store.setChip("page", false);
	store.setChip("selection", false);
	const paperOnly = store.formatForPrompt();
	assert.match(paperOnly, /Attention Is All You Need/);
	assert.ok(!paperOnly.includes("Page:"));
	assert.ok(!paperOnly.includes("Selection:"));
});

test("chat shell HTML exposes provider select and composer tags", async () => {
	const QLab = await loadQLab();
	QLab.ChatComposerContext && QLab.ChatComposerContext.clear();
	const html = QLab.renderShellHTML({
		kind: "qlabchat",
		workspaceState: "ready",
		root: "/tmp/ws",
		contextSummary: "Paper: Demo",
	});
	assert.match(html, /data-qlab-provider/);
	assert.match(html, /data-qlab-context-tags/);
	assert.match(html, /data-qlab-send/);
	assert.match(html, /data-qlab-output/);
	assert.match(html, /codex-cli|Local Codex/);
});

test("registerReaderHooks is a no-op without Reader host", async () => {
	const QLab = await loadQLab();
	assert.equal(typeof QLab.registerReaderHooks, "function");
	QLab.registerReaderHooks();
	QLab.unregisterReaderHooks();
});
