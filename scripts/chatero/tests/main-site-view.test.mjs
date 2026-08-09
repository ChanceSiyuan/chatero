import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { loadQLab } from "../lib/load-qlab.mjs";

const ORIGIN = "http://127.0.0.1:4180";

class FakeElement {
	constructor(tagName, ownerDocument) {
		this.tagName = tagName;
		this.ownerDocument = ownerDocument;
		this.children = [];
		this.attributes = new Map();
		this.listeners = new Map();
		this.textContent = "";
		this.className = "";
		this.open = false;
	}
	appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
	replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); }
	remove() { this.parentNode && (this.parentNode.children = this.parentNode.children.filter(child => child !== this)); }
	setAttribute(name, value) { this.attributes.set(name, String(value)); }
	getAttribute(name) { return this.attributes.get(name) || null; }
	addEventListener(name, listener) {
		if (!this.listeners.has(name)) this.listeners.set(name, new Set());
		this.listeners.get(name).add(listener);
	}
	removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
	dispatch(name, event = {}) { for (const listener of this.listeners.get(name) || []) listener({ target: this, ...event }); }
}

class FakeBrowser extends FakeElement {
	constructor(ownerDocument) {
		super("browser", ownerDocument);
		this.loaded = [];
		this.currentURI = { spec: "about:blank" };
		this.webProgress = {
			listeners: new Set(),
			flags: null,
			addProgressListener(listener, flags) {
				this.flags = flags;
				this.listeners.add(listener);
			},
			removeProgressListener(listener) { this.listeners.delete(listener); },
		};
		this.messageManager = new FakeMessageManager();
	}
	loadURI(url) { this.loaded.push(String(url)); this.currentURI = { spec: String(url) }; }
	goBack() { this.back = (this.back || 0) + 1; }
	goForward() { this.forward = (this.forward || 0) + 1; }
	reload() { this.reloaded = (this.reloaded || 0) + 1; }
}

class FakeMessageManager {
	constructor() {
		this.listeners = new Map();
		this.loadedScripts = [];
		this.removedScripts = [];
		this.sent = [];
	}
	addMessageListener(name, listener) { this.listeners.set(name, listener); }
	removeMessageListener(name, listener) {
		if (this.listeners.get(name) === listener) this.listeners.delete(name);
	}
	loadFrameScript(url, delayed) { this.loadedScripts.push({ url, delayed }); }
	removeDelayedFrameScript(url) { this.removedScripts.push(url); }
	sendAsyncMessage(name, data) { this.sent.push({ name, data }); }
	dispatch(name, data) { this.listeners.get(name)?.({ data }); }
}

class FakeDocument {
	constructor() { this.browsers = []; this.defaultView = {}; }
	createElementNS(_namespace, tagName) { return new FakeElement(tagName, this); }
	createXULElement(tagName) {
		if (tagName === "browser") {
			const browser = new FakeBrowser(this);
			this.browsers.push(browser);
			return browser;
		}
		return new FakeElement(tagName, this);
	}
}

function fakeService() {
	const calls = { check: 0, start: 0, rebuild: 0, unsubscribed: 0 };
	let listener = null;
	return {
		calls,
		observe(_identity, next) {
			listener = next;
			next({ state: "idle", url: "", lastGoodURL: "", diagnosticTail: "", error: null });
			return () => { calls.unsubscribed++; listener = null; };
		},
		async check() { calls.check++; },
		async start() { calls.start++; },
		async rebuild() { calls.rebuild++; },
		emit(snapshot) { listener?.(snapshot); },
	};
}

test("Main Site navigation embeds only the exact active loopback origin", async () => {
	const QLab = await loadQLab();
	for (const requestedURL of [
		"http://127.0.0.1:4180/knowledge/",
		"http://127.0.0.1:4180/knowledge/topic.html?view=1#theorem",
	]) {
		assert.deepEqual(
			JSON.parse(JSON.stringify(QLab.mainSiteNavigationDecision({ currentOrigin: ORIGIN, requestedURL }))),
			{ action: "embed", url: requestedURL },
		);
	}
	for (const requestedURL of [
		"http://127.0.0.1:4181/knowledge/",
		"http://localhost:4180/knowledge/",
		"http://127.0.0.1.evil.test:4180/knowledge/",
		"http://127.0.0.1:4180@evil.test/knowledge/",
		"http://evil.test@127.0.0.1:4180/knowledge/",
	]) {
		assert.equal(QLab.mainSiteNavigationDecision({ currentOrigin: ORIGIN, requestedURL }).action, "refuse");
	}
});

test("Main Site navigation externalizes web links and routes only supported native links", async () => {
	const QLab = await loadQLab();
	assert.deepEqual(
		JSON.parse(JSON.stringify(QLab.mainSiteNavigationDecision({
			currentOrigin: ORIGIN,
			requestedURL: "https://doi.org/10.1000/example",
		}))),
		{ action: "external", url: "https://doi.org/10.1000/example" },
	);
	for (const requestedURL of [
		"zotero://open-pdf/library/items/ABCDEFGH?page=3",
		"zotero://select/library/items/ABCDEFGH",
		"chatero://open-pdf/groups/42/items/ABCDEFGH?page=2",
	]) {
		assert.deepEqual(
			JSON.parse(JSON.stringify(QLab.mainSiteNavigationDecision({ currentOrigin: ORIGIN, requestedURL }))),
			{ action: "native", url: requestedURL },
		);
	}
	for (const requestedURL of [
		"file:///Users/chance/private.qmd",
		"javascript:alert(1)",
		"data:text/html,unsafe",
		"ftp://example.test/file",
		"zotero://debug/",
		"chatero://unknown/path",
		"not a URL",
	]) {
		assert.equal(QLab.mainSiteNavigationDecision({ currentOrigin: ORIGIN, requestedURL }).action, "refuse");
	}
});

test("Main Site view restores by checking only and owns exactly one disposable remote browser", async () => {
	const QLab = await loadQLab();
	const document = new FakeDocument();
	const host = new FakeElement("div", document);
	const service = fakeService();
	const view = QLab.createMainSiteView(document, host, {
		service,
		target: { identity: "12345678-1234-4123-8123-123456789abc", root: "/tmp/research-loop" },
	});
	await view.ready;
	assert.deepEqual(service.calls, { check: 1, start: 0, rebuild: 0, unsubscribed: 0 });
	assert.equal(document.browsers.length, 1);
	assert.equal(document.browsers[0].getAttribute("remote"), "true");

	service.emit({ state: "ready", url: `${ORIGIN}/`, lastGoodURL: `${ORIGIN}/`, diagnosticTail: "ready", error: null });
	assert.deepEqual(document.browsers[0].loaded, [`${ORIGIN}/`]);
	service.emit({ state: "error", url: `${ORIGIN}/`, lastGoodURL: `${ORIGIN}/`, diagnosticTail: "build failed", error: "build failed" });
	assert.deepEqual(document.browsers[0].loaded, [`${ORIGIN}/`], "last-good page must remain visible");
	await view.buildAndStart();
	assert.equal(service.calls.rebuild, 1);
	view.dispose();
	assert.equal(service.calls.unsubscribed, 1);
	assert.equal(document.browsers[0].webProgress.listeners.size, 0);
});

test("Main Site view routes intercepted navigation without replacing the last good page", async () => {
	const QLab = await loadQLab();
	const document = new FakeDocument();
	const host = new FakeElement("div", document);
	const service = fakeService();
	const external = [];
	const native = [];
	const view = QLab.createMainSiteView(document, host, {
		service,
		target: { identity: "12345678-1234-4123-8123-123456789abc", root: "/tmp/research-loop" },
		openExternal: url => external.push(url),
		openNative: url => native.push(url),
	});
	await view.ready;
	service.emit({ state: "ready", url: `${ORIGIN}/`, lastGoodURL: `${ORIGIN}/`, diagnosticTail: "", error: null });
	assert.equal(view.navigate(`${ORIGIN}/knowledge/`), "embed");
	assert.equal(view.navigate("https://doi.org/10.1000/example"), "external");
	assert.equal(view.navigate("zotero://select/library/items/ABCDEFGH"), "native");
	assert.equal(view.navigate("file:///tmp/private.qmd"), "refuse");
	assert.deepEqual(external, ["https://doi.org/10.1000/example"]);
	assert.deepEqual(native, ["zotero://select/library/items/ABCDEFGH"]);
	view.dispose();
});

test("Main Site cancels unsafe top-level requests at STATE_START with both progress notifications", async () => {
	const QLab = await loadQLab();
	const document = new FakeDocument();
	const host = new FakeElement("div", document);
	const service = fakeService();
	const external = [];
	const notifyConstants = {
		NOTIFY_LOCATION: 0x10,
		NOTIFY_STATE_REQUEST: 0x01,
	};
	const stateConstants = {
		STATE_START: 0x40000,
		STATE_IS_DOCUMENT: 0x80000,
	};
	const view = QLab.createMainSiteView(document, host, {
		service,
		target: { identity: "12345678-1234-4123-8123-123456789abc", root: "/tmp/research-loop" },
		openExternal: url => external.push(url),
		notifyConstants,
		stateConstants,
	});
	await view.ready;
	service.emit({ state: "ready", url: `${ORIGIN}/`, lastGoodURL: `${ORIGIN}/`, diagnosticTail: "", error: null });
	const browser = document.browsers[0];
	assert.equal(browser.webProgress.flags, notifyConstants.NOTIFY_LOCATION | notifyConstants.NOTIFY_STATE_REQUEST);
	const listener = [...browser.webProgress.listeners][0];
	let cancelled = 0;
	listener.onStateChange(
		{ isTopLevel: true },
		{ URI: { spec: "https://example.test/out" }, cancel: () => { cancelled++; } },
		stateConstants.STATE_START | stateConstants.STATE_IS_DOCUMENT,
	);
	assert.equal(cancelled, 1);
	assert.deepEqual(external, ["https://example.test/out"]);
	listener.onStateChange(
		{ isTopLevel: true },
		{ URI: { spec: "https://cdn.example.test/style.css" }, cancel: () => { cancelled++; } },
		stateConstants.STATE_START,
	);
	assert.equal(cancelled, 1, "top-level document subresources must not be treated as navigations");
	assert.deepEqual(external, ["https://example.test/out"]);
	view.dispose();
});

test("Main Site content bridge blocks subframe exits and cleans every message-manager hook", async () => {
	const QLab = await loadQLab();
	const document = new FakeDocument();
	const host = new FakeElement("div", document);
	const service = fakeService();
	const external = [];
	const view = QLab.createMainSiteView(document, host, {
		service,
		target: { identity: "12345678-1234-4123-8123-123456789abc", root: "/tmp/research-loop" },
		openExternal: url => external.push(url),
	});
	await view.ready;
	service.emit({ state: "ready", url: `${ORIGIN}/`, lastGoodURL: `${ORIGIN}/`, diagnosticTail: "", error: null });
	const manager = document.browsers[0].messageManager;
	assert.equal(manager.loadedScripts.length, 1);
	assert.match(decodeURIComponent(manager.loadedScripts[0].url), /javascript:/);
	manager.dispatch("QLab:MainSiteNavigation", {
		url: "https://evil.test/from-frame", topLevel: false, kind: "click",
	});
	assert.deepEqual(external, [], "subframes may never route an external or native action");
	view.dispose();
	assert.equal(manager.listeners.size, 0);
	assert.deepEqual(manager.removedScripts, [manager.loadedScripts[0].url]);
});

test("Main Site content bridge retargets auxiliary contexts into the managed browser", async () => {
	const QLab = await loadQLab();
	const document = new FakeDocument();
	const host = new FakeElement("div", document);
	const service = fakeService();
	const view = QLab.createMainSiteView(document, host, {
		service,
		target: { identity: "12345678-1234-4123-8123-123456789abc", root: "/tmp/research-loop" },
	});
	await view.ready;
	service.emit({ state: "ready", url: `${ORIGIN}/`, lastGoodURL: `${ORIGIN}/`, diagnosticTail: "", error: null });
	const browser = document.browsers[0];
	const script = decodeURIComponent(browser.messageManager.loadedScripts[0].url);
	assert.match(script, /target/);
	assert.doesNotMatch(script, /originalOpen\.call/, "window.open must never create an unmanaged popup");
	browser.messageManager.dispatch("QLab:MainSiteNavigation", {
		url: `${ORIGIN}/knowledge/popup.html`,
		topLevel: true,
		kind: "auxiliary",
		replaceTopLevel: true,
	});
	assert.deepEqual(browser.loaded, [`${ORIGIN}/`, `${ORIGIN}/knowledge/popup.html`]);
	view.dispose();
});

test("Main Site rebinds both message and progress guards when Gecko replaces the frame loader", async () => {
	const QLab = await loadQLab();
	const document = new FakeDocument();
	const host = new FakeElement("div", document);
	const service = fakeService();
	const view = QLab.createMainSiteView(document, host, {
		service,
		target: { identity: "12345678-1234-4123-8123-123456789abc", root: "/tmp/research-loop" },
		notifyConstants: { NOTIFY_LOCATION: 0x10, NOTIFY_STATE_REQUEST: 0x01 },
		stateConstants: { STATE_START: 0x1, STATE_IS_DOCUMENT: 0x2 },
	});
	await view.ready;
	const browser = document.browsers[0];
	const oldManager = browser.messageManager;
	const oldProgress = browser.webProgress;
	const nextManager = new FakeMessageManager();
	const nextProgress = {
		listeners: new Set(), flags: null,
		addProgressListener(listener, flags) { this.flags = flags; this.listeners.add(listener); },
		removeProgressListener(listener) { this.listeners.delete(listener); },
	};
	browser.messageManager = nextManager;
	browser.webProgress = nextProgress;
	browser.dispatch("XULFrameLoaderCreated");
	assert.equal(oldManager.listeners.size, 0);
	assert.equal(oldProgress.listeners.size, 0);
	assert.equal(nextManager.listeners.size, 1);
	assert.equal(nextManager.loadedScripts.length, 1);
	assert.equal(nextProgress.listeners.size, 1);
	view.dispose();
	assert.equal(nextManager.listeners.size, 0);
	assert.equal(nextProgress.listeners.size, 0);
});

test("Main Site frame script releases obsolete document windows before tab disposal", async () => {
	const QLab = await loadQLab();
	const source = decodeURIComponent(QLab.mainSiteNavigationFrameScript());
	assert.match(source, /pagehide/);
	assert.match(source, /disposers\.delete/);
	assert.match(source, /eventRoot\.removeEventListener/, "shutdown must use the exact registration target");
});

test("Main Site frame script executes popup and subframe guards before content navigation", async () => {
	const QLab = await loadQLab();
	const listenersFor = () => new Map();
	function fakeWindow(href) {
		const listeners = listenersFor();
		let popupCalls = 0;
		const win = {
			location: { href },
			listeners,
			addEventListener(type, listener) {
				if (!listeners.has(type)) listeners.set(type, new Set());
				listeners.get(type).add(listener);
			},
			removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
			open() { popupCalls++; return {}; },
			popupCalls: () => popupCalls,
		};
		return win;
	}
	const content = fakeWindow(`${ORIGIN}/knowledge/`);
	const messages = [];
	const messageListeners = new Map();
	const encoded = QLab.mainSiteNavigationFrameScript();
	const source = decodeURIComponent(encoded.slice(encoded.indexOf(",") + 1));
	runInNewContext(source, {
		content,
		URL,
		sendAsyncMessage: (name, data) => messages.push({ name, data }),
		addMessageListener: (name, listener) => messageListeners.set(name, listener),
		removeMessageListener: (name, listener) => {
			if (messageListeners.get(name) === listener) messageListeners.delete(name);
		},
	});
	messageListeners.get("QLab:MainSiteNavigationConfig")({ data: { origin: ORIGIN } });
	let prevented = 0;
	const popupLink = {
		localName: "a", href: `${ORIGIN}/knowledge/popup.html`, target: "_blank", parentElement: null,
	};
	for (const listener of content.listeners.get("click")) {
		listener({
			button: 0, target: popupLink,
			preventDefault: () => { prevented++; }, stopPropagation() {},
		});
	}
	assert.equal(prevented, 1);
	assert.equal(content.popupCalls(), 0);
	assert.equal(messages.at(-1).data.replaceTopLevel, true);
	assert.equal(content.open(`${ORIGIN}/knowledge/window-open.html`), null);
	assert.equal(content.popupCalls(), 0);
	assert.equal(messages.at(-1).data.kind, "auxiliary");

	const frame = fakeWindow(`${ORIGIN}/knowledge/frame.html`);
	for (const listener of content.listeners.get("DOMWindowCreated")) {
		listener({ target: { defaultView: frame } });
	}
	for (const listener of frame.listeners.get("click")) {
		listener({
			button: 0,
			target: { localName: "a", href: "https://evil.test/", target: "", parentElement: null },
			preventDefault() {}, stopPropagation() {},
		});
	}
	assert.equal(messages.at(-1).data.topLevel, false);
	for (const listener of frame.listeners.get("pagehide")) listener({ persisted: false });
	assert.equal(frame.listeners.get("click").size, 0);
	assert.equal(frame.listeners.get("submit").size, 0);
});

test("top-level same-origin location changes persist without reloading the browser", async () => {
	const QLab = await loadQLab();
	const document = new FakeDocument();
	const host = new FakeElement("div", document);
	const service = fakeService();
	const persisted = [];
	const view = QLab.createMainSiteView(document, host, {
		service,
		target: { identity: "12345678-1234-4123-8123-123456789abc", root: "/tmp/research-loop" },
		onPersist: url => persisted.push(url),
	});
	await view.ready;
	service.emit({ state: "ready", url: `${ORIGIN}/`, lastGoodURL: `${ORIGIN}/`, diagnosticTail: "", error: null });
	const browser = document.browsers[0];
	const listener = [...browser.webProgress.listeners][0];
	listener.onLocationChange({ isTopLevel: true }, null, { spec: `${ORIGIN}/knowledge/topic.html#proof` });
	assert.deepEqual(browser.loaded, [`${ORIGIN}/`]);
	assert.equal(persisted.at(-1), `${ORIGIN}/knowledge/topic.html#proof`);
	assert.equal(view.snapshot().lastEmbeddedURL, `${ORIGIN}/knowledge/topic.html#proof`);
	view.dispose();
});

test("production health fetch aborts after the bounded timeout and always clears its timer", async () => {
	const QLab = await loadQLab();
	let fireTimeout = null;
	let cleared = 0;
	let receivedSignal = null;
	const pending = QLab.fetchMainSiteHealth(`${ORIGIN}/`, {
		fetchImpl: (_url, options) => {
			receivedSignal = options.signal;
			return new Promise((_resolve, reject) => {
				options.signal.addEventListener("abort", () => reject(new Error("aborted")));
			});
		},
		setTimeoutImpl: (callback, milliseconds) => {
			assert.equal(milliseconds, 1500);
			fireTimeout = callback;
			return 17;
		},
		clearTimeoutImpl: token => { assert.equal(token, 17); cleared++; },
	});
	assert.equal(receivedSignal.aborted, false);
	fireTimeout();
	await assert.rejects(pending, /aborted/);
	assert.equal(receivedSignal.aborted, true);
	assert.equal(cleared, 1);
});

test("Phase 4 Main Site entry point is thin window-controller delegation", async () => {
	const QLab = await loadQLab();
	assert.equal(QLab.Phase4.openMainSite().status, "not-ready");
	const calls = [];
	const unregister = QLab.registerMainSiteController({
		openMainSite: options => { calls.push(options); return "qlabsite"; },
	});
	assert.deepEqual(plain(QLab.Phase4.openMainSite({ root: "/tmp/research-loop" })), {
		ok: true,
		feature: "main-site",
		status: "opened",
		tabID: "qlabsite",
	});
	assert.deepEqual(calls, [{ root: "/tmp/research-loop" }]);
	unregister();
	assert.equal(QLab.Phase4.openMainSite().status, "not-ready");
});

test("Phase 4 selects the explicit or currently focused library controller, never registration order", async () => {
	const QLab = await loadQLab();
	const calls = [];
	let active = "a";
	const a = { openMainSite: () => { calls.push("a"); return "site-a"; } };
	const b = { openMainSite: () => { calls.push("b"); return "site-b"; } };
	const unregisterA = QLab.registerMainSiteController(a, { isActive: () => active === "a" });
	const unregisterB = QLab.registerMainSiteController(b, { isActive: () => active === "b" });
	assert.equal(QLab.Phase4.openMainSite().tabID, "site-a");
	assert.equal(QLab.Phase4.openMainSite({ windowController: b }).tabID, "site-b");
	active = "b";
	assert.equal(QLab.Phase4.openMainSite().tabID, "site-b");
	assert.deepEqual(calls, ["a", "b", "b"]);
	unregisterA();
	unregisterB();
});

test("Main Site service is application-global and only app shutdown stops it", async () => {
	let shutdownListener = null;
	const QLab = await loadQLab({ addShutdownListener: listener => { shutdownListener = listener; } });
	let created = 0;
	let stopped = 0;
	QLab.createGeckoMainSiteRuntime = () => ({ marker: "runtime" });
	QLab.createMainSiteService = runtime => {
		created++;
		assert.equal(runtime.marker, "runtime");
		return { async shutdown() { stopped++; } };
	};
	const first = QLab.getMainSiteService();
	assert.equal(QLab.getMainSiteService(), first);
	assert.equal(created, 1);
	assert.equal(typeof shutdownListener, "function");
	await shutdownListener();
	assert.equal(stopped, 1);
});

function plain(value) { return JSON.parse(JSON.stringify(value)); }
