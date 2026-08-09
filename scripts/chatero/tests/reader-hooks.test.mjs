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
	assert.match(quoteSVG, /stroke="currentColor"/);
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
