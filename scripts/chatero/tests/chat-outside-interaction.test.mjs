import assert from "node:assert/strict";
import test from "node:test";

import { loadQLab } from "../lib/load-qlab.mjs";

class FakeEventTarget {
	constructor(name = "target") {
		this.name = name;
		this.listeners = new Map();
	}

	addEventListener(type, listener, options) {
		let entries = this.listeners.get(type) || [];
		entries.push({ listener, options });
		this.listeners.set(type, entries);
	}

	removeEventListener(type, listener, options) {
		let entries = this.listeners.get(type) || [];
		this.listeners.set(type, entries.filter(entry => (
			entry.listener !== listener || entry.options !== options
		)));
	}

	dispatch(type, event = {}) {
		event.type = type;
		event.target ||= this;
		for (let { listener } of [...(this.listeners.get(type) || [])]) {
			listener(event);
		}
		return event;
	}
}

function nodeWithClosest(...selectors) {
	return {
		closest(selector) {
			return selectors.includes(selector) ? this : null;
		},
	};
}

function pointerEvent(target, pointerId = 1) {
	let event = {
		target,
		pointerId,
		button: 0,
		defaultPrevented: false,
		cancelBubble: false,
		preventCalls: 0,
		stopCalls: 0,
		preventDefault() {
			this.preventCalls++;
			this.defaultPrevented = true;
		},
		stopPropagation() {
			this.stopCalls++;
			this.cancelBubble = true;
		},
		composedPath() {
			return [target];
		},
	};
	return event;
}

function controllerHost(QLab) {
	let controller = new QLab.ChatPresentationController({
		viewport: { width: 1200, height: 800 },
	});
	return {
		controller,
		host: {
			handleInteraction: interaction => controller.handleInteraction(interaction),
		},
	};
}

function chromeElement() {
	const element = new FakeEventTarget("chrome-element");
	element.hidden = true;
	element.attributes = new Map();
	element.style = { setProperty() {} };
	element.setAttribute = (name, value) => element.attributes.set(name, String(value));
	element.toggleAttribute = (name, force) => {
		if (force) element.attributes.set(name, "");
		else element.attributes.delete(name);
	};
	element.querySelector = () => null;
	element.contains = target => target === element;
	element.getBoundingClientRect = () => ({ width: 1200, height: 800 });
	return element;
}

function windowControllerFixture(QLab) {
	const document = new FakeEventTarget("window-document");
	const defaultView = new FakeEventTarget("window");
	defaultView.innerWidth = 1200;
	defaultView.innerHeight = 800;
	document.defaultView = defaultView;
	document.activeElement = null;
	const elements = {
		"qlab-chat-utility-layer": chromeElement(),
		"qlab-chat-utility-dialog": chromeElement(),
		"qlab-chat-utility-content": chromeElement(),
	};
	const selectors = new Map([
		["[data-qlab-chat-drag-handle]", chromeElement()],
		["[data-qlab-chat-pin]", chromeElement()],
		["[data-qlab-chat-hide]", chromeElement()],
		["[data-qlab-chat-resize]", chromeElement()],
	]);
	document.getElementById = id => elements[id] || null;
	document.querySelector = selector => selectors.get(selector) || null;
	const tabsAPI = {
		deck: { ownerDocument: document },
		_tabs: [{ id: "qlabchat", type: "qlabchat", data: {} }],
		setTabData() {},
		_onChatUtilityChanged() {},
	};
	QLab.mountShellTab = async () => ({});
	QLab.cancelShellTurn = () => {};
	QLab.cancelShellTabMount = () => {};
	const windowController = QLab.createWindowController(tabsAPI);
	tabsAPI._qlab = windowController;
	return { document, windowController };
}

test("ordinary tokenless window-controller show dismisses on the first outside interaction", async () => {
	const QLab = await loadQLab();
	const { document, windowController } = windowControllerFixture(QLab);

	await windowController.showUtility("qlabchat", null, { invocation: "native-tab" });
	assert.equal(windowController.chatUtility.snapshot().visibility, "visible");
	document.dispatch("pointerdown", pointerEvent(
		nodeWithClosest("[data-qlab-visual-surface]"),
		101,
	));
	assert.equal(windowController.chatUtility.snapshot().visibility, "hidden",
		"a tokenless show must not manufacture an undefined opening token");
	windowController.destroy();
});

test("main XUL Visual Edit activity dismisses only an unpinned Chat without consuming the click", async () => {
	const QLab = await loadQLab();
	const document = new FakeEventTarget("main-document");
	const { controller, host } = controllerHost(QLab);
	const bridge = new QLab.ChatOutsideInteractionBridge({ host, document });
	const visual = nodeWithClosest("[data-qlab-visual-surface]");

	controller.show();
	let first = pointerEvent(visual);
	document.dispatch("pointerdown", first);
	assert.equal(controller.snapshot().visibility, "hidden");
	assert.equal(first.defaultPrevented, false);
	assert.equal(first.cancelBubble, false);
	assert.equal(first.preventCalls, 0);
	assert.equal(first.stopCalls, 0);

	controller.show();
	controller.setPinned(true);
	let pinned = pointerEvent(visual, 2);
	document.dispatch("pointerdown", pinned);
	assert.equal(controller.snapshot().visibility, "visible");
	assert.equal(pinned.defaultPrevented, false);
	assert.equal(pinned.cancelBubble, false);

	bridge.dispose();
	controller.setPinned(false);
	let disposed = pointerEvent(visual, 3);
	document.dispatch("pointerdown", disposed);
	assert.equal(controller.snapshot().visibility, "visible", "dispose removes main document capture");
});

test("Chat portals, context tags, header controls, popovers, and resize handles are inside", async () => {
	const QLab = await loadQLab();
	const document = new FakeEventTarget("main-document");
	const { controller, host } = controllerHost(QLab);
	const bridge = new QLab.ChatOutsideInteractionBridge({ host, document });
	const insideSelectors = [
		"#qlab-chat-utility-dialog",
		"[data-qlab-chat-portal]",
		"[data-qlab-chat-context]",
		"[data-qlab-chat-drag-handle]",
		"[data-qlab-chat-resize]",
		"[data-qlab-chat-popover]",
	];

	for (let [index, selector] of insideSelectors.entries()) {
		controller.show();
		document.dispatch("pointerdown", pointerEvent(nodeWithClosest(selector), index + 1));
		assert.equal(controller.snapshot().visibility, "visible", `${selector} stays inside Chat`);
	}

	bridge.dispose();
});

test("Reader, Monaco, and reloaded same-origin Quick Preview adapters normalize pointer activity", async () => {
	const QLab = await loadQLab();
	const { controller, host } = controllerHost(QLab);
	const bridge = new QLab.ChatOutsideInteractionBridge({ host });
	const readerDocument = new FakeEventTarget("reader-document");
	const monacoListeners = new Set();
	const monaco = {
		onEvent(listener) {
			monacoListeners.add(listener);
			return () => monacoListeners.delete(listener);
		},
		emit(event) {
			for (let listener of monacoListeners) listener(event);
		},
	};
	let quickDocument = new FakeEventTarget("quick-one");
	const quickFrame = new FakeEventTarget("quick-frame");
	quickFrame.contentDocument = quickDocument;

	const detachReader = bridge.attachReaderDocument(readerDocument);
	const detachMonaco = bridge.attachMonaco(monaco);
	const detachQuick = bridge.attachQuickPreview(quickFrame);

	controller.show();
	const openingTarget = nodeWithClosest("[data-qlab-chat-opening]");
	readerDocument.dispatch("pointerdown", pointerEvent(openingTarget, 9));
	assert.equal(controller.snapshot().visibility, "visible",
		"the Reader Chat action is not dismissed during capture before its click handler");

	let readerPointer = pointerEvent(readerDocument);
	readerDocument.dispatch("pointerdown", readerPointer);
	assert.equal(controller.snapshot().visibility, "hidden");
	assert.equal(readerPointer.defaultPrevented, false);

	controller.show();
	monaco.emit({ type: "pointer-activity", pointerId: 2, button: 0 });
	assert.equal(controller.snapshot().visibility, "hidden");

	controller.show();
	let firstQuick = pointerEvent(quickDocument, 3);
	quickDocument.dispatch("pointerdown", firstQuick);
	assert.equal(controller.snapshot().visibility, "hidden");
	assert.equal(firstQuick.defaultPrevented, false);

	controller.show();
	let previousDocument = quickDocument;
	quickDocument = new FakeEventTarget("quick-two");
	quickFrame.contentDocument = quickDocument;
	quickFrame.dispatch("load");
	previousDocument.dispatch("pointerdown", pointerEvent(previousDocument, 4));
	assert.equal(controller.snapshot().visibility, "visible", "old Quick Preview document is detached");
	quickDocument.dispatch("pointerdown", pointerEvent(quickDocument, 5));
	assert.equal(controller.snapshot().visibility, "hidden", "new Quick Preview document is captured");

	controller.show();
	controller.setPinned(true);
	readerDocument.dispatch("pointerdown", pointerEvent(readerDocument, 6));
	monaco.emit({ type: "pointer-activity", pointerId: 7, button: 0 });
	quickDocument.dispatch("pointerdown", pointerEvent(quickDocument, 8));
	assert.equal(controller.snapshot().visibility, "visible", "all adapters honor Pin in the host controller");

	detachReader();
	detachMonaco();
	detachQuick();
	bridge.dispose();
	assert.equal(monacoListeners.size, 0);
});

test("remote Website Preview pointer messages dismiss and clean up without consuming browser events", async () => {
	const QLab = await loadQLab();
	const { controller, host } = controllerHost(QLab);
	const bridge = new QLab.ChatOutsideInteractionBridge({ host });
	const browser = new FakeEventTarget("remote-browser");
	const listeners = new Map();
	const manager = {
		loadedScripts: [],
		addMessageListener(name, listener) {
			listeners.set(name, listener);
		},
		removeMessageListener(name, listener) {
			if (listeners.get(name) === listener) listeners.delete(name);
		},
		loadFrameScript(script, delayed) {
			this.loadedScripts.push({ script, delayed });
		},
		emit(name, data) {
			listeners.get(name)?.({ name, data });
		},
	};
	browser.messageManager = manager;
	const detach = bridge.attachWebsitePreview(browser);

	assert.equal(manager.loadedScripts.length, 1);
	assert.equal(manager.loadedScripts[0].delayed, true);
	const frameScript = decodeURIComponent(manager.loadedScripts[0].script);
	assert.match(frameScript, /pointerdown/);
	assert.doesNotMatch(frameScript, /preventDefault|stopPropagation/);

	controller.show();
	manager.emit(QLab.QMD_PREVIEW_POINTER_MESSAGE, { pointerId: 11, button: 0 });
	assert.equal(controller.snapshot().visibility, "hidden");

	controller.show();
	controller.setPinned(true);
	manager.emit(QLab.QMD_PREVIEW_POINTER_MESSAGE, { pointerId: 12, button: 0 });
	assert.equal(controller.snapshot().visibility, "visible");

	const replacementListeners = new Map();
	const replacementManager = {
		loadedScripts: [],
		addMessageListener(name, listener) { replacementListeners.set(name, listener); },
		removeMessageListener(name, listener) {
			if (replacementListeners.get(name) === listener) replacementListeners.delete(name);
		},
		loadFrameScript(script, delayed) { this.loadedScripts.push({ script, delayed }); },
		emit(name, data) { replacementListeners.get(name)?.({ name, data }); },
	};
	browser.messageManager = replacementManager;
	browser.dispatch("load");
	assert.equal(listeners.size, 0, "old remote process listener is released on remoteness change");
	assert.equal(replacementManager.loadedScripts.length, 1);
	controller.setPinned(false);
	replacementManager.emit(QLab.QMD_PREVIEW_POINTER_MESSAGE, { pointerId: 14, button: 0 });
	assert.equal(controller.snapshot().visibility, "hidden");
	controller.show();

	detach();
	assert.equal(replacementListeners.size, 0);
	replacementManager.emit(QLab.QMD_PREVIEW_POINTER_MESSAGE, { pointerId: 13, button: 0 });
	assert.equal(controller.snapshot().visibility, "visible");
	bridge.dispose();
});

test("the Reader selection opening pointer is ignored exactly once", async () => {
	const QLab = await loadQLab();
	const { controller, host } = controllerHost(QLab);
	const bridge = new QLab.ChatOutsideInteractionBridge({ host });
	const opening = pointerEvent({}, 21);
	const token = bridge.interactionToken(opening);

	controller.show({ openingToken: token });
	let ignored = bridge.notify("reader", opening, { invocationToken: token });
	assert.equal(ignored.ignoredOpening, true);
	assert.equal(ignored.dismissed, false);
	assert.equal(controller.snapshot().visibility, "visible");

	let next = pointerEvent({}, 22);
	let dismissed = bridge.notify("reader", next);
	assert.equal(dismissed.ignoredOpening, false);
	assert.equal(dismissed.dismissed, true);
	assert.equal(controller.snapshot().visibility, "hidden");
	assert.equal(opening.defaultPrevented, false);
	assert.equal(next.defaultPrevented, false);
	bridge.dispose();
});
