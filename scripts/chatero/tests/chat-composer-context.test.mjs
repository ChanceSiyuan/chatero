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

test("createQmdComposerTag preserves a non-empty whitespace-only source range", async () => {
	const QLab = await loadQLab();
	const exact = " \n\t  ";
	const tag = QLab.createQmdComposerTag({
		relativePath: "drafts/notes/spacing.qmd",
		source: `before${exact}after`,
		selection: exact,
		selectionStart: 6,
		selectionEnd: 6 + exact.length,
		surfaceMode: "source",
	});

	assert.equal(tag.kind, "qmd-selection");
	assert.equal(tag.text, exact);
	assert.equal(tag.origin.start, 6);
	assert.equal(tag.origin.end, 6 + exact.length);
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

test("QMD Source selection is attached exactly once and focused in resident Chat", async () => {
	const QLab = await loadQLab();
	QLab.ChatComposerContext.clear();
	const exact = "  $f(x)$ is selected\nwith both edges preserved  ";
	const prompt = { focusCount: 0, focus() { this.focusCount++; } };
	const runningTurn = { cancelCount: 0, cancel() { this.cancelCount++; } };
	const send = { clickCount: 0, click() { this.clickCount++; } };
	const qmdHost = {
		_qlabMountTabID: "qlabqmd",
		_qlabSurfaceMode: "source",
		_qlabBuffer: `# Draft\n\n${exact}\n`,
		_qlabMonacoSelection: { start: 9, end: 9 + exact.length, text: exact },
		_qlabDraftState: { originalPath: "drafts/exact.qmd", viewingWorking: false },
		ownerDocument: { activeElement: null, getSelection: () => "wrong DOM selection" },
		querySelector: () => null,
	};
	const chatHost = {
		_qlabTurnHandle: runningTurn,
		ownerDocument: { createElement: () => ({ firstElementChild: null }) },
		querySelector(selector) {
			if (selector === "[data-qlab-context-tags]") return null;
			if (selector === "[data-qlab-prompt]") return prompt;
			if (selector === "[data-qlab-send]") return send;
			return null;
		},
	};
	const qmdContainer = { querySelector: selector => selector === ".qlab-shell-host" ? qmdHost : null };
	const chatContainer = { querySelector: selector => selector === ".qlab-shell-host" ? chatHost : null };
	let chatVisible = false;
	const calls = [];
	const tabs = {
		_tabs: [
			{ id: "qlabqmd", type: "qlabqmd", data: { primaryItemID: 41 } },
			{ id: "reader-41", type: "reader" },
		],
		selectedID: "reader-41",
		isTabVisible: id => id === "qlabchat" && chatVisible,
		_qlab: {
			async showUtility(kind, payload, options) {
				calls.push(["show", kind, payload, options]);
				chatVisible = true;
				if (!tabs._tabs.some(tab => tab.id === "qlabchat")) {
					tabs._tabs.push({ id: "qlabchat", type: "qlabchat" });
				}
			},
			ensureShellTab(kind, payload) { calls.push(["ensure", kind, payload]); },
		},
		arrangePDFChat() { calls.push(["arrange"]); },
		arrangePDFEditor() { calls.push(["arrange"]); },
		arrangeResearchDesk() { calls.push(["arrange"]); },
	};
	const windowRef = {
		Zotero_Tabs: tabs,
		document: {
			getElementById(id) {
				if (id === "qlabqmd") return qmdContainer;
				if (id === "qlab-chat-utility-content") return chatContainer;
				return null;
			},
		},
	};
	QLab.getQmdShellBuffer = host => host._qlabBuffer;

	await QLab.addCurrentContextToChat(windowRef, {
		preference: "selection",
		focus: true,
		qmdHost,
	});
	await QLab.addCurrentContextToChat(windowRef, {
		preference: "selection",
		focus: true,
		qmdHost,
	});

	const tags = QLab.ChatComposerContext.list();
	assert.equal(tags.length, 1, "the existing stable-key semantics deduplicate the selection tag");
	assert.equal(tags[0].kind, "qmd-selection");
	assert.equal(tags[0].text, exact);
	assert.equal(tags[0].origin.start, 9);
	assert.equal(tags[0].origin.end, 9 + exact.length);
	assert.equal(prompt.focusCount, 2);
	assert.equal(calls.filter(call => call[0] === "show").length, 1);
	assert.equal(calls.some(call => ["send", "cancel", "arrange"].includes(call[0])), false);
	assert.equal(send.clickCount, 0);
	assert.equal(runningTurn.cancelCount, 0);
	assert.equal(chatHost._qlabTurnHandle, runningTurn);
	assert.equal(tabs.selectedID, "reader-41");
});
