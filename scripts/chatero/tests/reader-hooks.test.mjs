import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { loadQLab } from "../lib/load-qlab.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const qlabRoot = join(root, "chrome/content/zotero/xpcom/qlab");

test("reader toolbar uses icon-only buttons aligned with the XPI", async () => {
	const hooks = await readFile(join(qlabRoot, "readerHooks.js"), "utf8");
	const icons = await readFile(join(qlabRoot, "readerIcons.js"), "utf8");

	assert.match(hooks, /makeIconButton/);
	assert.match(hooks, /ReaderIcons/);
	assert.match(hooks, /createElement\('img'\)/);
	assert.doesNotMatch(hooks, /label:\s*['"]Chat['"]/);
	assert.doesNotMatch(hooks, /label:\s*['"]QMD['"]/);
	assert.doesNotMatch(hooks, /label:\s*['"]Desk['"]/);
	assert.doesNotMatch(hooks, /label:\s*['"]⌘L['"]/);
	assert.doesNotMatch(hooks, /label:\s*['"]Quote/);

	assert.match(icons, /ReaderIcons/);
	assert.match(icons, /chat:/);
	assert.match(icons, /editorSplit:/);
	assert.match(icons, /desk:/);
	assert.match(icons, /quote:/);
});

test("reader icons are inlined SVG data URLs", async () => {
	const icons = await readFile(join(qlabRoot, "readerIcons.js"), "utf8");
	assert.match(icons, /svgDataUrl/);
	assert.match(icons, /encodeURIComponent/);
	assert.match(icons, /return 'data:image\/svg\+xml,'/);
});

test("Reader quote action uses an unambiguous blockquote glyph", async () => {
	const hooks = await readFile(join(qlabRoot, "readerHooks.js"), "utf8");
	const icons = await readFile(join(qlabRoot, "readerIcons.js"), "utf8");
	const context = { Zotero: { QLab: {} } };
	runInNewContext(icons, context, { filename: "readerIcons.js" });

	const quoteURL = context.Zotero.QLab.ReaderIcons.quote;
	assert.match(quoteURL, /^data:image\/svg\+xml,/);
	const quoteSVG = decodeURIComponent(quoteURL.slice(quoteURL.indexOf(",") + 1));
	const lines = [...quoteSVG.matchAll(/<line\s+([^>]+)\/>/g)].map((match) => {
		return Object.fromEntries(
			[...match[1].matchAll(/([\w-]+)="([^"]+)"/g)]
				.map((attribute) => [attribute[1], attribute[2]]),
		);
	});
	const verticalBars = lines.filter((line) => line.x1 === line.x2 && line.y1 !== line.y2);
	const textLines = lines.filter((line) => line.y1 === line.y2 && line.x1 !== line.x2);

	assert.equal(verticalBars.length, 1, "blockquote glyph has one vertical quote bar");
	assert.equal(textLines.length, 3, "blockquote glyph has three horizontal text lines");
	assert.doesNotMatch(
		quoteSVG,
		/currentColor/,
		"an SVG loaded through img cannot inherit Reader toolbar currentColor",
	);
	assert.match(
		quoteSVG,
		/stroke="#5a5a5f"/,
		"the quote icon uses the same explicit neutral stroke as Reader toolbar actions",
	);
	assert.doesNotMatch(quoteSVG, /c0-1\.4 1-2\.5 2\.5-2\.5/,
		"old paired open-loop quotation paths are removed");

	const accessibleLabel = "Insert selection into QMD as quote (⌘⇧K)";
	assert.match(hooks, new RegExp(`title: '${accessibleLabel.replace(/[()]/g, "\\$&")}'`));
	assert.match(hooks, /button\.title = title/);
	assert.match(hooks, /button\.setAttribute\('aria-label', title\)/);
});

test("Reader hooks register every rendered Reader document and guard the Chat-opening action once", async () => {
	const hooks = await readFile(join(qlabRoot, "readerHooks.js"), "utf8");
	assert.match(hooks, /attachReaderDocument\(doc\)/);
	assert.match(hooks, /interactionToken\(activationEvent\)/);
	assert.match(hooks, /data-qlab-chat-opening/);
	assert.match(hooks, /openingToken/);
	assert.match(hooks, /notify\(['"]reader['"],\s*activationEvent/);
});

test("Reader selection Chat action opens with and consumes only its own invocation token", async () => {
	const hooks = await readFile(join(qlabRoot, "readerHooks.js"), "utf8");
	const registered = new Map();
	const calls = [];
	const interactionBridge = {
		attachReaderDocument(doc) {
			calls.push(["attach", doc]);
		},
		interactionToken(event) {
			calls.push(["token", event]);
			return "selection-opening";
		},
		notify(source, event, options) {
			calls.push(["notify", source, event, options]);
		},
	};
	const win = {
		Zotero_Tabs: {
			_qlab: {
				chatOutsideInteraction: interactionBridge,
				showUtility(kind, payload, options) {
					calls.push(["show", kind, payload, options]);
				},
			},
		},
	};
	function element(tagName) {
		return {
			tagName,
			children: [],
			style: {},
			setAttribute() {},
			append(child) { this.children.push(child); },
			appendChild(child) { this.children.push(child); },
			addEventListener(type, listener) { this[`on${type}`] = listener; },
		};
	}
	const doc = {
		defaultView: { addEventListener() {} },
		createElement: element,
	};
	const Zotero = {
		QLab: {
			ReaderIcons: { chat: "chat", quote: "quote", chatLayout: "layout", editorSplit: "edit", desk: "desk" },
			ReaderContextStore: { captureFromEvent: async () => calls.push(["capture"]) },
			addCurrentContextToChat: async () => calls.push(["context"]),
			installMainWindowShortcuts: null,
		},
		Reader: {
			registerEventListener(type, listener) { registered.set(type, listener); },
			unregisterEventListener() {},
		},
		getMainWindow: () => win,
		logError(error) { throw error; },
	};
	runInNewContext(hooks, { Zotero }, { filename: "readerHooks.js" });
	Zotero.QLab.registerReaderHooks();
	let group;
	registered.get("renderTextSelectionPopup")({
		doc,
		reader: { _window: win },
		params: {},
		append(value) { group = value; },
	});
	const activationEvent = {
		preventDefault() {},
		stopPropagation() {},
	};
	group.children[0].onclick(activationEvent);
	await new Promise(resolve => setTimeout(resolve, 0));

	const tokenIndex = calls.findIndex(call => call[0] === "token");
	const showIndex = calls.findIndex(call => call[0] === "show");
	const notifyIndex = calls.findIndex(call => call[0] === "notify");
	assert.ok(tokenIndex >= 0 && tokenIndex < showIndex && showIndex < notifyIndex);
	assert.deepEqual(JSON.parse(JSON.stringify(calls[showIndex].slice(1))), [
		"qlabchat",
		null,
		{ invocation: "reader-selection", openingToken: "selection-opening" },
	]);
	assert.equal(calls[notifyIndex][1], "reader");
	assert.equal(calls[notifyIndex][2], activationEvent);
	assert.deepEqual(JSON.parse(JSON.stringify(calls[notifyIndex][3])), {
		invocationToken: "selection-opening",
	});
	assert.equal(calls.filter(call => call[0] === "notify").length, 1);
	assert.ok(calls.some(call => call[0] === "context"));
});

class LifecycleTarget {
	constructor(name) {
		this.name = name;
		this.listeners = new Map();
	}

	addEventListener(type, listener) {
		let values = this.listeners.get(type) || [];
		values.push(listener);
		this.listeners.set(type, values);
	}

	removeEventListener(type, listener) {
		let values = this.listeners.get(type) || [];
		this.listeners.set(type, values.filter(value => value !== listener));
	}

	dispatch(type, event = {}) {
		event.type = type;
		event.target ||= this;
		for (let listener of [...(this.listeners.get(type) || [])]) listener(event);
	}
}

function lifecycleReaderDocument(name) {
	const document = new LifecycleTarget(name);
	document.defaultView = new LifecycleTarget(`${name}-window`);
	document.createElement = tagName => {
		const element = new LifecycleTarget(tagName);
		element.children = [];
		element.style = {};
		element.setAttribute = () => {};
		element.append = child => element.children.push(child);
		return element;
	};
	return document;
}

function lifecyclePointer(target) {
	return {
		target,
		button: 0,
		pointerId: 1,
		composedPath: () => [target],
	};
}

test("closing one Reader document releases only its adapter while the other Reader and window stay active", async () => {
	const registered = new Map();
	const Reader = {
		registerEventListener(type, listener) { registered.set(type, listener); },
		unregisterEventListener(type, listener) {
			if (registered.get(type) === listener) registered.delete(type);
		},
	};
	let mainWindow = null;
	const QLab = await loadQLab({
		Reader,
		getMainWindow: () => mainWindow,
	});
	const controller = new QLab.ChatPresentationController({
		viewport: { width: 1200, height: 800 },
	});
	const mainDocument = new LifecycleTarget("main-document");
	const bridge = new QLab.ChatOutsideInteractionBridge({
		host: { handleInteraction: value => controller.handleInteraction(value) },
		document: mainDocument,
	});
	mainWindow = {
		Zotero_Tabs: { _qlab: { chatOutsideInteraction: bridge } },
	};
	QLab.registerReaderHooks();
	const first = lifecycleReaderDocument("reader-one");
	const second = lifecycleReaderDocument("reader-two");
	registered.get("renderToolbar")({
		doc: first,
		reader: { _window: mainWindow },
		append() {},
	});
	registered.get("renderToolbar")({
		doc: second,
		reader: { _window: mainWindow },
		append() {},
	});

	first.defaultView.dispatch("pagehide");
	controller.show();
	first.dispatch("pointerdown", lifecyclePointer(first));
	assert.equal(controller.snapshot().visibility, "visible",
		"the closed Reader no longer owns a pointer listener");
	second.dispatch("pointerdown", lifecyclePointer(second));
	assert.equal(controller.snapshot().visibility, "hidden",
		"the other Reader remains registered");

	controller.show();
	mainDocument.dispatch("pointerdown", lifecyclePointer({
		closest: selector => selector === "[data-qlab-visual-surface]" ? {} : null,
	}));
	assert.equal(controller.snapshot().visibility, "hidden",
		"the containing Zotero window remains registered");

	QLab.unregisterReaderHooks();
	controller.show();
	second.dispatch("pointerdown", lifecyclePointer(second));
	assert.equal(controller.snapshot().visibility, "visible",
		"plugin teardown releases remaining Reader document adapters");
	bridge.dispose();
});

test("Reader Command-K attaches the exact PDF selection once and focuses floating Chat", async () => {
	const registered = new Map();
	const attachment = {
		id: 71,
		key: "PDFKEY71",
		libraryID: 1,
		parentItemID: null,
		attachmentFilename: "selection-paper.pdf",
		getField: () => "Selection paper",
	};
	const exact = "  exact PDF selection\nwith preserved whitespace  ";
	let mainWindow;
	const reader = {
		itemID: attachment.id,
		_internalReader: { _state: { primaryViewStats: { pageIndex: 4 } } },
		get _window() { return mainWindow; },
	};
	const Reader = {
		_readers: [reader],
		getByTabID: id => id === "reader-71" ? reader : null,
		registerEventListener(type, listener) { registered.set(type, listener); },
		unregisterEventListener() {},
	};
	const QLab = await loadQLab({
		Reader,
		Items: { get: id => id === attachment.id ? attachment : null },
	});
	QLab.ChatComposerContext.clear();
	const calls = [];
	const prompt = { focusCount: 0, focus() { this.focusCount++; } };
	const chatHost = {
		ownerDocument: { createElement: () => ({ firstElementChild: null }) },
		querySelector(selector) {
			if (selector === "[data-qlab-context-tags]") return null;
			if (selector === "[data-qlab-prompt]") return prompt;
			return null;
		},
	};
	const chatContainer = { querySelector: selector => selector === ".qlab-shell-host" ? chatHost : null };
	let chatVisible = false;
	const tabs = {
		_tabs: [
			{ id: "reader-71", type: "reader" },
			{ id: "qlabqmd", type: "qlabqmd" },
		],
		// A split workspace may leave QMD as the native selected content tab
		// while the keyboard event comes from the visible Reader document.
		selectedID: "qlabqmd",
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
	};
	mainWindow = {
		Zotero_Tabs: tabs,
		document: {
			getElementById(id) {
				return id === "qlab-chat-utility-content" ? chatContainer : null;
			},
		},
	};
	const readerWindow = new LifecycleTarget("reader-shortcut-window");
	const doc = lifecycleReaderDocument("reader-shortcut-document");
	doc.defaultView = readerWindow;
	QLab.registerReaderHooks();
	registered.get("renderTextSelectionPopup")({
		doc,
		reader,
		params: { annotation: { text: exact } },
		append() {},
	});
	await new Promise(resolve => setTimeout(resolve, 0));
	function commandK() {
		const event = {
			key: "k",
			metaKey: true,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			isComposing: false,
			target: {},
			prevented: 0,
			stopped: 0,
			preventDefault() { this.prevented++; },
			stopPropagation() { this.stopped++; },
		};
		readerWindow.dispatch("keydown", event);
		return event;
	}
	const first = commandK();
	await new Promise(resolve => setTimeout(resolve, 0));
	const second = commandK();
	await new Promise(resolve => setTimeout(resolve, 0));

	const tags = QLab.ChatComposerContext.list();
	assert.equal(tags.length, 1);
	assert.equal(tags[0].kind, "pdf-selection");
	assert.equal(tags[0].text, exact);
	assert.equal(tags[0].origin.pageNumber, 5);
	assert.equal(prompt.focusCount, 2);
	assert.equal(first.prevented, 1);
	assert.equal(first.stopped, 1);
	assert.equal(second.prevented, 1);
	assert.equal(second.stopped, 1);
	assert.equal(calls.filter(call => call[0] === "show").length, 1);
	assert.equal(calls.some(call => call[0] === "arrange"), false);
	QLab.unregisterReaderHooks();
});
