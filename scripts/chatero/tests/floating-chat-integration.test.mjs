import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const plain = value => JSON.parse(JSON.stringify(value));

class FakeEventTarget {
	constructor() {
		this.listeners = new Map();
	}

	addEventListener(type, listener) {
		let listeners = this.listeners.get(type) || [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type, listener) {
		let listeners = this.listeners.get(type) || [];
		this.listeners.set(type, listeners.filter(candidate => candidate !== listener));
	}
}

class FakeElement extends FakeEventTarget {
	constructor() {
		super();
		this.hidden = true;
		this.attributes = new Map();
		this.queries = new Map();
		this.style = { setProperty() {} };
	}

	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}

	toggleAttribute(name, force) {
		if (force) this.attributes.set(name, "");
		else this.attributes.delete(name);
	}

	removeAttribute(name) {
		this.attributes.delete(name);
	}

	querySelector(selector) {
		return this.queries.get(selector) || null;
	}

	register(selector, value) {
		this.queries.set(selector, value);
	}

	contains(target) {
		return target === this;
	}

	getBoundingClientRect() {
		return { width: 1440, height: 900 };
	}
}

function integrationFixture(QLab) {
	const document = new FakeEventTarget();
	const defaultView = new FakeEventTarget();
	defaultView.innerWidth = 1440;
	defaultView.innerHeight = 900;
	document.defaultView = defaultView;
	document.activeElement = null;

	const elements = {
		"qlab-chat-utility-layer": new FakeElement(),
		"qlab-chat-utility-dialog": new FakeElement(),
		"qlab-chat-utility-content": new FakeElement(),
	};
	const selectors = new Map([
		["[data-qlab-chat-drag-handle]", new FakeElement()],
		["[data-qlab-chat-pin]", new FakeElement()],
		["[data-qlab-chat-hide]", new FakeElement()],
		["[data-qlab-chat-resize]", new FakeElement()],
	]);
	document.getElementById = id => elements[id] || null;
	document.querySelector = selector => selectors.get(selector) || null;

	let mounts = 0;
	let cancellations = 0;
	let streamConsumers = 0;
	const transcript = [];
	const providerSelect = { value: "codex-cli" };
	const runtime = {
		running: true,
		publish(chunk) {
			transcript.push(chunk);
		},
	};
	const residentHost = {
		_qlabTurnHandle: { cancel: () => cancellations++ },
		querySelector(selector) {
			return selector === "[data-qlab-provider]" ? providerSelect : null;
		},
	};
	QLab.mountShellTab = async container => {
		mounts++;
		streamConsumers++;
		container.register(".qlab-shell-host", residentHost);
		return runtime;
	};
	QLab.cancelShellTurn = host => host._qlabTurnHandle.cancel();
	QLab.cancelShellTabMount = () => {};

	let arrangementCalls = 0;
	let selectedID = "reader-live";
	const tabsAPI = {
		deck: { ownerDocument: document },
		_tabs: [
			{ id: "zotero-pane", type: "library", data: {} },
			{ id: "reader-live", type: "reader", data: { itemID: 42 } },
			{ id: "qlabqmd", type: "qlabqmd", data: { primaryItemID: 42 } },
			{ id: "qlabchat", type: "qlabchat", data: { primaryItemID: 42 } },
		],
		get selectedID() {
			return selectedID;
		},
		getTabIDByItemID(itemID) {
			return itemID === 42 ? "reader-live" : null;
		},
		setTabData(id, payload) {
			let tab = this._tabs.find(candidate => candidate.id === id);
			if (tab) tab.data = { ...tab.data, ...payload };
		},
		add({ id, type, data }) {
			this._tabs.push({ id, type, data: data || {} });
			return { id, container: elements["qlab-chat-utility-content"] };
		},
		select(id) {
			selectedID = id;
		},
		_applySplitVisibility() {},
		_onChatUtilityChanged() {},
	};
	const controller = QLab.createWindowController(tabsAPI);
	tabsAPI._qlab = controller;
	tabsAPI.isTabVisible = id => id === "qlabchat"
		? controller.utilityLauncherState("qlabchat").pressed
		: controller.groups.snapshot().panes.some(pane => pane.activeTabID === id);
	tabsAPI.arrangeResearchDesk = async itemID => {
		arrangementCalls++;
		return controller.arrangeResearchDesk(itemID);
	};

	return {
		controller,
		document,
		elements,
		runtime,
		tabsAPI,
		transcript,
		providerSelect,
		counts: () => ({ mounts, cancellations, streamConsumers, arrangementCalls }),
	};
}

const LEGACY_THREE_PANE = {
	version: 2,
	tabs: [
		{ id: "zotero-pane", kind: "library", title: "Library" },
		{ id: "reader-live", kind: "reader", title: "Paper", payload: { itemID: 42 } },
		{ id: "qlabqmd", kind: "qlabqmd", title: "QMD Editor" },
		{ id: "qlabchat", kind: "qlabchat", title: "Chat" },
	],
	panes: [
		{ tabIDs: ["zotero-pane", "reader-live"], activeTabID: "reader-live" },
		{ tabIDs: ["qlabqmd"], activeTabID: "qlabqmd" },
		{ tabIDs: ["qlabchat"], activeTabID: "qlabchat" },
	],
	focusedGroup: "center",
	splitRatios: [0.36, 0.68],
};

test("legacy Research Desk reveal keeps PDF/QMD fixed and one Chat stream through launcher reopen", async () => {
	const QLab = await loadQLab();
	const fixture = integrationFixture(QLab);
	const { controller, runtime, tabsAPI, transcript } = fixture;
	controller.restoreGroupsState(LEGACY_THREE_PANE);

	let migrated = controller.groups.snapshot();
	assert.deepEqual(
		plain(migrated.panes.map(pane => pane.activeTabID)),
		["reader-live", "qlabqmd"],
	);
	assert.equal(migrated.panes.some(pane => pane.tabIDs.includes("qlabchat")), false);
	assert.equal(controller.chatUtility.snapshot().visibility, "hidden");

	const windowRef = { document: fixture.document, Zotero_Tabs: tabsAPI };
	await QLab.ensureChatPaneVisible(windowRef, { itemID: 42 });
	assert.equal(
		fixture.counts().arrangementCalls,
		0,
		"revealing floating Chat must not rearrange the migrated PDF/QMD panes",
	);
	assert.equal(controller.chatUtility.snapshot().visibility, "visible");
	runtime.publish("one");

	controller.hideUtility("qlabchat");
	runtime.publish(" two");
	await controller.showUtility("qlabchat", null, { invocation: "native-tab" });
	runtime.publish(" three");

	controller.closeUtilityLauncher("qlabchat");
	tabsAPI._tabs = tabsAPI._tabs.filter(tab => tab.id !== "qlabchat");
	controller.groups.closeTab("qlabchat");
	runtime.publish(" four");
	await controller.showUtility("qlabchat", null, { invocation: "native-tab" });
	runtime.publish(" five");

	const reopened = controller.groups.snapshot();
	assert.deepEqual(plain(reopened.utilityTabs.map(tab => tab.id)), ["qlabchat"]);
	assert.deepEqual(plain(reopened.panes.map(pane => pane.activeTabID)), ["reader-live", "qlabqmd"]);
	assert.deepEqual(transcript, ["one", " two", " three", " four", " five"]);
	assert.deepEqual(fixture.counts(), {
		mounts: 1,
		cancellations: 0,
		streamConsumers: 1,
		arrangementCalls: 0,
	});

	controller.destroy();
	assert.equal(fixture.counts().cancellations, 1, "only window shutdown cancels the turn");
});

test("opening the QMD content pane does not reveal an existing hidden Chat launcher", async () => {
	const QLab = await loadQLab();
	const calls = [];
	const tabs = {
		_tabs: [
			{ id: "reader-live", type: "reader" },
			{ id: "qlabqmd", type: "qlabqmd" },
			{ id: "qlabchat", type: "qlabchat" },
		],
		isTabVisible: id => id === "reader-live",
		arrangePDFEditor: async itemID => calls.push(["pdf-editor", itemID]),
		arrangeResearchDesk: async itemID => calls.push(["research-desk", itemID]),
	};

	await QLab.ensureQmdPaneVisible({ Zotero_Tabs: tabs }, { itemID: 42 });
	assert.deepEqual(calls, [["pdf-editor", 42]]);
});

test("provider changes update the resident Chat host without mounting a second transcript", async () => {
	const QLab = await loadQLab();
	QLab.refreshChatProviderAvailability = async () => {};
	const fixture = integrationFixture(QLab);

	await fixture.controller.showUtility("qlabchat", null, { invocation: "native-tab" });
	await fixture.controller.refreshChatProvider("openai-compat");

	assert.equal(fixture.providerSelect.value, "openai-compat");
	assert.equal(fixture.counts().mounts, 1);
	assert.equal(fixture.counts().streamConsumers, 1);
	fixture.controller.destroy();
});

test("composer focus reveals the utility without selecting Chat as content", async () => {
	const QLab = await loadQLab();
	const calls = [];
	const prompt = { focus: () => calls.push(["focus"]) };
	const host = {
		querySelector(selector) {
			if (selector === "[data-qlab-context-tags]") return null;
			if (selector === "[data-qlab-prompt]") return prompt;
			return null;
		},
	};
	const content = { querySelector: () => host };
	const windowRef = {
		document: {
			getElementById(id) {
				return id === "qlab-chat-utility-content" ? content : null;
			},
		},
		Zotero_Tabs: {
			_tabs: [{ id: "qlabchat", type: "qlabchat" }],
			isTabVisible: () => false,
			select: id => calls.push(["select", id]),
			_qlab: {
				showUtility: (kind, payload, options) => {
					calls.push(["show", kind, payload, options]);
				},
			},
		},
	};

	QLab.focusChatComposer(windowRef, { focus: true });

	assert.equal(calls.some(call => call[0] === "select"), false);
	assert.deepEqual(plain(calls.find(call => call[0] === "show")), [
		"show",
		"qlabchat",
		null,
		{ invocation: "composer-focus", focusComposer: true },
	]);
});
