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

function oversizedExactSelection(label) {
	return `  ${label}\r\n${"αβ🙂\tkept  whitespace\r\n".repeat(500)}final line\t  `;
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

test("QMD Source Command-K keeps an oversized exact UTF-16 selection and does not send", async () => {
	const QLab = await loadQLab();
	QLab.ChatComposerContext.clear();
	const exact = oversizedExactSelection("$f(x)$ is selected");
	assert.ok(exact.length > 8000);
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
	assert.equal(tags[0].textSemantics, "exact-selection");
	assert.equal(tags[0].text, exact);
	assert.equal(tags[0].origin.start, 9);
	assert.equal(tags[0].origin.end, 9 + exact.length);
	assert.ok(QLab.ChatComposerContext.formatForPrompt().includes(exact));
	assert.equal(prompt.focusCount, 2);
	assert.equal(calls.filter(call => call[0] === "show").length, 1);
	assert.equal(calls.some(call => ["send", "cancel", "arrange"].includes(call[0])), false);
	assert.equal(send.clickCount, 0);
	assert.equal(runningTurn.cancelCount, 0);
	assert.equal(chatHost._qlabTurnHandle, runningTurn);
	assert.equal(tabs.selectedID, "reader-41");
});

function readonlyQmdWindow(QLab, { relativePath, source, selection = null }) {
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath });
	const qmdHost = {
		_qlabMountTabID: "qlabqmd",
		_qlabSurfaceMode: "source",
		_qlabBuffer: "caller-forged stale buffer",
		_qlabMonacoSelection: selection,
		_qlabDraftState: null,
		_qlabDocumentState: Object.freeze({
			document: descriptor,
			path: descriptor.relativePath,
			revision: "verified-1",
		}),
		_qlabQmdWorkspace: {
			documentSnapshot: () => Object.freeze({
				document: descriptor,
				path: descriptor.relativePath,
				text: source,
				revision: "verified-1",
				disposed: false,
			}),
		},
		ownerDocument: { activeElement: null, getSelection: () => "" },
		querySelector: () => null,
	};
	const chatHost = {
		ownerDocument: { createElement: () => ({ firstElementChild: null }) },
		querySelector: () => null,
	};
	const qmdContainer = { querySelector: selector => selector === ".qlab-shell-host" ? qmdHost : null };
	const chatContainer = { querySelector: selector => selector === ".qlab-shell-host" ? chatHost : null };
	const tabs = {
		_tabs: [
			{ id: "qlabqmd", type: "qlabqmd", data: {} },
			{ id: "qlabchat", type: "qlabchat", data: {} },
		],
		selectedID: "qlabqmd",
		isTabVisible: id => id === "qlabchat",
		_qlab: { ensureShellTab() {} },
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
	return { descriptor, qmdHost, windowRef };
}

test("readonly QMD Chat attaches only an exact active-session selection with canonical provenance", async t => {
	const QLab = await loadQLab();
	QLab.ChatComposerContext.clear();
	const source = "# Evidence\n\nselected theorem\n";
	const selected = "selected theorem";
	const start = source.indexOf(selected);
	const { descriptor, qmdHost, windowRef } = readonlyQmdWindow(QLab, {
		relativePath: "literature/paper.md",
		source,
		selection: { start, end: start + selected.length, text: selected },
	});
	let genericReads = 0;
	const oldRead = QLab.readWorkspaceRel;
	const oldSearch = QLab.workspaceSearch;
	QLab.readWorkspaceRel = async () => { genericReads++; throw new Error("must not read"); };
	QLab.workspaceSearch = async () => { genericReads++; throw new Error("must not search"); };
	t.after(() => {
		QLab.readWorkspaceRel = oldRead;
		QLab.workspaceSearch = oldSearch;
	});

	const tag = await QLab.addCurrentContextToChat(windowRef, {
		qmdHost,
		preference: "selection",
		focus: false,
	});
	assert.equal(tag.kind, "qmd-selection");
	assert.equal(tag.text, selected);
	assert.equal(tag.origin.relativePath, descriptor.relativePath);
	assert.equal(tag.origin.start, start);
	assert.equal(tag.origin.end, start + selected.length);
	assert.equal(tag.origin.revision, "verified-1");
	assert.equal(tag.stableKey, `qmd-selection:${descriptor.relativePath}`);
	assert.equal(genericReads, 0);
});

test("readonly QMD Chat refuses whole-document context and current-Draft picker forgery", async t => {
	const QLab = await loadQLab();
	QLab.ChatComposerContext.clear();
	const { qmdHost, windowRef } = readonlyQmdWindow(QLab, {
		relativePath: "knowledge/topic.qmd",
		source: "# Private knowledge\n",
		selection: null,
	});
	let genericReads = 0;
	const oldRead = QLab.readWorkspaceRel;
	const oldSearch = QLab.workspaceSearch;
	QLab.readWorkspaceRel = async () => { genericReads++; return "forbidden"; };
	QLab.workspaceSearch = async () => { genericReads++; return []; };
	t.after(() => {
		QLab.readWorkspaceRel = oldRead;
		QLab.workspaceSearch = oldSearch;
	});

	await assert.rejects(
		() => QLab.addCurrentContextToChat(windowRef, { qmdHost, focus: false }),
		/select.*text|selection/i,
	);
	assert.equal(QLab.ChatComposerContext.list().length, 0);
	assert.equal(
		QLab.listComposerAtPickerItems(windowRef).some(item => item.id.startsWith("current-draft")),
		false,
	);
	await assert.rejects(
		() => QLab.applyComposerAtPickerItem(windowRef, {
			id: "current-draft",
			kind: "qmd",
			relativePath: "knowledge/topic.qmd",
		}),
		/selected text|read-only/i,
	);
	assert.equal(genericReads, 0);
});

test("readonly QMD tag reveal targets only the same verified active session without Draft loading", async t => {
	const QLab = await loadQLab();
	const source = "# Evidence\n\nexact result\n";
	const selection = "exact result";
	const start = source.indexOf(selection);
	const { qmdHost, windowRef } = readonlyQmdWindow(QLab, {
		relativePath: "literature/paper.md",
		source,
		selection: { start, end: start + selection.length, text: selection },
	});
	const reveals = [];
	qmdHost._qlabQmdWorkspace.revealReadonlySelection = async request => {
		reveals.push(request);
		return true;
	};
	let draftLoads = 0;
	let selectedTabs = 0;
	windowRef.Zotero_Tabs.select = () => { selectedTabs++; };
	const oldLoad = QLab.loadDraftIntoShell;
	QLab.loadDraftIntoShell = async () => { draftLoads++; throw new Error("must not load Draft"); };
	t.after(() => { QLab.loadDraftIntoShell = oldLoad; });
	const tag = QLab.ChatComposerContext.add(QLab.createQmdComposerTag({
		relativePath: "literature/paper.md",
		source,
		selection,
		selectionStart: start,
		selectionEnd: start + selection.length,
		documentRevision: "verified-1",
		surfaceMode: "source",
	}));

	assert.equal(await QLab.revealComposerTag(tag, windowRef), true);
	assert.deepEqual(JSON.parse(JSON.stringify(reveals)), [{
		relativePath: "literature/paper.md",
		revision: "verified-1",
		start,
		end: start + selection.length,
		text: selection,
	}]);
	assert.equal(selectedTabs, 1);
	assert.equal(draftLoads, 0);

	const mismatched = {
		...tag,
		origin: { ...tag.origin, revision: "different-session" },
	};
	assert.equal(await QLab.revealComposerTag(mismatched, windowRef), false);
	assert.equal(reveals.length, 1);
	assert.equal(selectedTabs, 1);
	assert.equal(draftLoads, 0);
});

test("PDF Command-K keeps an oversized exact UTF-16 selection and does not send", async () => {
	const exact = oversizedExactSelection("PDF selection");
	assert.ok(exact.length > 8000);
	const attachment = {
		id: 12,
		key: "ABCDEFGH",
		libraryID: 1,
		parentItemID: 9,
		attachmentFilename: "paper.pdf",
		getAttachmentLastPageIndex: () => 4,
	};
	const parent = {
		id: 9,
		key: "PARENTKEY",
		getDisplayTitle: async () => "Attention Is All You Need",
	};
	const QLab = await loadQLab({
		Items: { get: id => id === attachment.id ? attachment : parent },
		Reader: { getByTabID: () => null, _readers: [] },
	});
	QLab.ChatComposerContext.clear();
	const prompt = { focusCount: 0, focus() { this.focusCount++; } };
	const runningTurn = { cancelCount: 0, cancel() { this.cancelCount++; } };
	const send = { clickCount: 0, click() { this.clickCount++; } };
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
	const chatContainer = { querySelector: selector => selector === ".qlab-shell-host" ? chatHost : null };
	let chatVisible = false;
	const calls = [];
	const tabs = {
		_tabs: [{ id: "reader-12", type: "reader" }],
		selectedID: "reader-12",
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
	};
	const windowRef = {
		Zotero_Tabs: tabs,
		document: {
			getElementById(id) {
				if (id === "qlab-chat-utility-content") return chatContainer;
				return null;
			},
		},
	};
	const reader = {
		itemID: 12,
		_internalReader: { _state: { primaryViewStats: { pageIndex: 4 } } },
	};

	await QLab.addCurrentContextToChat(windowRef, {
		reader,
		params: { annotation: { text: exact } },
		preference: "selection",
		focus: true,
	});
	await QLab.addCurrentContextToChat(windowRef, {
		reader,
		params: { annotation: { text: exact } },
		preference: "selection",
		focus: true,
	});

	const tags = QLab.ChatComposerContext.list();
	assert.equal(tags.length, 1, "stable selection identity must still deduplicate");
	assert.equal(tags[0].kind, "pdf-selection");
	assert.equal(tags[0].textSemantics, "exact-selection");
	assert.equal(tags[0].text, exact);
	assert.equal(tags[0].origin.pageIndex, 4);
	assert.equal(tags[0].origin.pageNumber, 5);
	assert.ok(QLab.ChatComposerContext.formatForPrompt().includes(exact));
	assert.equal(prompt.focusCount, 2);
	assert.equal(calls.filter(call => call[0] === "show").length, 1);
	assert.equal(send.clickCount, 0);
	assert.equal(runningTurn.cancelCount, 0);
	assert.equal(chatHost._qlabTurnHandle, runningTurn);
	assert.equal(tabs.selectedID, "reader-12");
});

test("non-selection PDF page and QMD file contexts remain safety-bounded", async () => {
	const QLab = await loadQLab();
	QLab.ChatComposerContext.clear();
	const oversized = "bounded context ".repeat(700);
	assert.ok(oversized.length > 8000);

	const pdfPage = QLab.ChatComposerContext.add(QLab.createPdfComposerTag({
		...samplePdfContext(),
		selection: null,
		page: { pageIndex: 2, pageNumber: 3, text: oversized },
	}, "page"));
	const qmdFile = QLab.ChatComposerContext.add(QLab.createQmdComposerTag({
		relativePath: "drafts/notes/bounded.qmd",
		source: oversized,
		surfaceMode: "source",
	}));

	assert.equal(pdfPage.text.length, 8000);
	assert.equal(qmdFile.text.length, 8000);
	assert.equal(pdfPage.textSemantics, "bounded");
	assert.equal(qmdFile.textSemantics, "bounded");
});
