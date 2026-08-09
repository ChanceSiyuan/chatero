import assert from "node:assert/strict";
import test from "node:test";
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
			addProgressListener: listener => this.webProgress.listeners.add(listener),
			removeProgressListener: listener => this.webProgress.listeners.delete(listener),
		};
	}
	loadURI(url) { this.loaded.push(String(url)); this.currentURI = { spec: String(url) }; }
	goBack() { this.back = (this.back || 0) + 1; }
	goForward() { this.forward = (this.forward || 0) + 1; }
	reload() { this.reloaded = (this.reloaded || 0) + 1; }
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
