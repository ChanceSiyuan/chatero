import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { transformAsync } from "@babel/core";
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

async function loadNativeTabs(QLab, document) {
	const sourceURL = new URL("../../../chrome/content/zotero/tabs.js", import.meta.url);
	const source = await readFile(sourceURL, "utf8");
	const transformed = await transformAsync(source, {
		filename: fileURLToPath(sourceURL),
	});
	const Zotero = {
		QLab,
		Notifier: {
			trigger() {},
			registerObserver: () => "tabs-observer",
			unregisterObserver() {},
		},
		Prefs: {
			registerObserver: () => "tabs-pref-observer",
			unregisterObserver() {},
		},
		Session: { debounceSave() {} },
		Utilities: { randomString: () => "native-id" },
		logError() {},
	};
	const window = document.defaultView;
	const sandbox = {
		console,
		document,
		window,
		Services: {
			sysinfo: { getProperty: () => 16 * 1024 ** 3 },
		},
		Zotero,
		ZoteroPane: {},
		ZoteroContextPane: {},
		setTimeout,
		clearTimeout,
		setInterval: () => 1,
		clearInterval() {},
		module: { exports: {} },
		exports: {},
		require(id) {
			if (id === "react") {
				return { createRef: () => ({ current: null }), createElement: () => null };
			}
			if (id === "react-dom") {
				return { createRoot: () => ({ render() {} }) };
			}
			if (id === "components/tabBar") {
				return function TabBar() {};
			}
			throw new Error(`Unexpected tabs.js dependency: ${id}`);
		},
	};
	runInNewContext(`${transformed.code}\nthis.__nativeTabs = Zotero_Tabs;`, sandbox, {
		filename: "tabs.js",
	});
	window.Zotero_Tabs = sandbox.__nativeTabs;
	return sandbox.__nativeTabs;
}

function integrationFixture(QLab, { productionMount = false } = {}) {
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
	if (!productionMount) {
		QLab.mountShellTab = async container => {
			mounts++;
			streamConsumers++;
			container.register(".qlab-shell-host", residentHost);
			return runtime;
		};
	}
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

test("a production Agent turn survives actual native Chat tab close and reopen exactly once", async () => {
	const QLab = await loadQLab();
	const document = new FakeEventTarget();
	const window = new FakeEventTarget();
	window.innerWidth = 1440;
	window.innerHeight = 900;
	window.setTimeout = setTimeout;
	document.defaultView = window;
	document.activeElement = null;

	const layer = new FakeElement();
	const dialog = new FakeElement();
	const content = new FakeElement();
	const deck = new FakeElement();
	deck._qlabDeckShim = true;
	deck.ownerDocument = document;
	deck.children = [];
	content.ownerDocument = document;
	const elements = new Map([
		["tabs-deck", deck],
		["qlab-chat-utility-layer", layer],
		["qlab-chat-utility-dialog", dialog],
		["qlab-chat-utility-content", content],
	]);
	const selectors = new Map([
		["[data-qlab-chat-drag-handle]", new FakeElement()],
		["[data-qlab-chat-pin]", new FakeElement()],
		["[data-qlab-chat-hide]", new FakeElement()],
		["[data-qlab-chat-resize]", new FakeElement()],
	]);
	document.getElementById = id => elements.get(id) || null;
	document.querySelector = selector => selectors.get(selector) || null;
	document.createXULElement = () => new FakeElement();

	const prompt = new FakeElement();
	prompt.value = "Explain the invariant";
	const status = new FakeElement();
	status.textContent = "";
	const send = new FakeElement();
	const stop = new FakeElement();
	const controls = new Map([
		["[data-qlab-prompt]", prompt],
		[".qlab-shell-status", status],
		["[data-qlab-send]", send],
		["[data-qlab-stop]", stop],
	]);
	const host = {
		ownerDocument: document,
		_qlabMountRoot: "/workspace",
		_qlabMountWorkspaceState: "ready",
		_qlabMountedKind: "qlabchat",
		_qlabMessages: [],
		_qlabTurnHandle: null,
		querySelector(selector) {
			return controls.get(selector) || null;
		},
	};
	content.register(".qlab-shell-host", host);

	let starts = 0;
	let cancellations = 0;
	let firstChunkResolve;
	let releaseResolve;
	const firstChunk = new Promise(resolve => { firstChunkResolve = resolve; });
	const release = new Promise(resolve => { releaseResolve = resolve; });
	const provider = {
		id: "lifecycle-provider",
		label: "Lifecycle provider",
		status: "ready",
		capabilities: { streaming: true },
		async *startTurn(_turn, _text, { cancelToken }) {
			starts++;
			cancelToken.onCancel(() => cancellations++);
			yield { type: "text-delta", text: "first" };
			firstChunkResolve();
			await release;
			yield { type: "text-delta", text: " second" };
			yield { type: "done", status: "ok" };
		},
	};
	const registry = new QLab.AgentProviderRegistry([provider]);
	const runtime = new QLab.AgentRuntime({ registry, defaultProviderId: provider.id });
	QLab.Settings.getAgentProviderId = () => provider.id;
	QLab.Settings.getAgentModel = () => "";
	QLab.Settings.getChatMode = () => "ask";
	QLab.Settings.getChatTranscriptMaxChars = () => 24_000;
	QLab.getAgentRuntime = () => runtime;
	QLab.loadChatRulesPreamble = async () => "";
	QLab.renderChatMessages = () => {};
	QLab.updateChatContextMeter = () => {};
	QLab.persistChatHost = async () => {};
	QLab.hideComposerAtPicker = () => {};
	QLab.refreshChatProviderAvailability = async () => {};

	let mounts = 0;
	QLab.mountShellTab = async container => {
		mounts++;
		container.register(".qlab-shell-host", host);
		return host;
	};
	QLab.cancelShellTabMount = () => {};
	QLab.cancelShellTurn = resident => resident?._qlabTurnHandle?.cancel?.();

	const tabs = await loadNativeTabs(QLab, document);
	tabs._update = () => {};
	tabs._applySplitVisibility = () => {};
	tabs._tabs = [
		{ id: "zotero-pane", type: "library", title: "Library", data: {} },
		{ id: "reader-live", type: "reader", title: "Paper", data: { itemID: 42 } },
		{ id: "qlabqmd", type: "qlabqmd", title: "QMD Editor", data: {} },
	];
	tabs._selectedID = "reader-live";
	const controller = QLab.createWindowController(tabs);
	tabs._qlab = controller;
	controller.restoreGroupsState({
		version: 3,
		contentTabs: [
			{ id: "zotero-pane", kind: "library", title: "Library" },
			{ id: "reader-live", kind: "reader", title: "Paper", payload: { itemID: 42 } },
			{ id: "qlabqmd", kind: "qlabqmd", title: "QMD Editor" },
		],
		utilityTabs: [],
		panes: [
			{ tabIDs: ["zotero-pane", "reader-live"], activeTabID: "reader-live" },
			{ tabIDs: ["qlabqmd"], activeTabID: "qlabqmd" },
		],
		focusedGroup: "left",
		splitRatios: [0.5],
	});

	await controller.showUtility("qlabchat", null, { invocation: "native-tab" });
	const before = plain(controller.groups.snapshot().panes.map(pane => pane.activeTabID));
	const turnPromise = QLab.runShellFreeform(host, "/workspace", "ready");
	await firstChunk;
	assert.ok(host._qlabTurnHandle, "the production AgentRuntime owns the in-flight turn");

	tabs.close("qlabchat");
	assert.ok(host._qlabTurnHandle, "closing the native launcher must not cancel resident work");
	assert.equal(cancellations, 0);
	assert.equal(tabs._tabs.some(tab => tab.id === "qlabchat"), false);

	await controller.showUtility("qlabchat", null, { invocation: "native-tab" });
	assert.equal(tabs._tabs.some(tab => tab.id === "qlabchat"), true);
	releaseResolve();
	await turnPromise;

	assert.equal(starts, 1, "one prompt starts one provider stream");
	assert.equal(cancellations, 0);
	assert.equal(mounts, 1, "the native launcher reuses the resident shell mount");
	assert.deepEqual(
		plain(host._qlabMessages.map(message => ({ role: message.role, text: message.text }))),
		[
			{ role: "user", text: "Explain the invariant" },
			{ role: "assistant", text: "first second" },
		],
		"the production transcript receives each message and delta exactly once",
	);
	assert.deepEqual(
		plain(controller.groups.snapshot().panes.map(pane => pane.activeTabID)),
		before,
		"native launcher lifecycle leaves the PDF/QMD content panes unchanged",
	);
	controller.destroy();
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

test("workspace refresh retargets the resident Chat host and its existing handlers", async () => {
	const QLab = await loadQLab();
	let root = "/workspaces/new";
	QLab.Settings.getRoot = () => root;
	QLab.createGeckoQLabPathHost = () => ({});
	QLab.qlabRepositoryState = async () => "ready";
	QLab.ReaderContextStore.formatForPrompt = () => "";
	QLab.renderChatMessages = () => {};
	QLab.refreshComposerTags = () => {};
	QLab.refreshChatProviderAvailability = async () => {};
	let refreshDetails = null;
	QLab.refreshShellWorkspaceChrome = (host, details) => {
		refreshDetails = { host, details };
	};

	let handlerRoot = null;
	const marker = {};
	const host = {
		_qlabMountRoot: "/workspaces/old",
		_qlabMountWorkspaceState: "ready",
		_qlabMountedKind: "qlabchat",
		_qlabMessages: [{ role: "assistant", text: "resident transcript" }],
		querySelector(selector) {
			return selector === '[data-qlab-kind="qlabchat"]' ? marker : null;
		},
		onclick() {
			handlerRoot = host._qlabMountRoot;
		},
	};
	const originalHandler = host.onclick;
	const fixture = integrationFixture(QLab, { productionMount: true });
	fixture.elements["qlab-chat-utility-content"].register(".qlab-shell-host", host);

	await fixture.controller.refreshWorkspace();
	host.onclick({ target: { closest: () => null } });

	assert.equal(host._qlabMountRoot, root);
	assert.equal(host._qlabMountWorkspaceState, "ready");
	assert.equal(host.onclick, originalHandler, "refresh reuses the resident handler and host");
	assert.equal(handlerRoot, root, "the existing handler reads the refreshed workspace");
	assert.equal(refreshDetails.host, host);
	assert.equal(refreshDetails.details.root, root);
	assert.deepEqual(host._qlabMessages, [{ role: "assistant", text: "resident transcript" }]);
	fixture.controller.destroy();
});

test("workspace refresh replaces the previous root's approval policy in place", async () => {
	const QLab = await loadQLab();
	const oldRoot = "/workspaces/old";
	const newRoot = "/workspaces/new";
	const oldPolicy = { defaultAction: "allow", allow: [], deny: [] };
	const newPolicy = { defaultAction: "ask", allow: [], deny: ["unlisted-tool"] };
	const loadedRoots = [];
	QLab.Settings.getRoot = () => newRoot;
	QLab.createGeckoQLabPathHost = () => ({});
	QLab.qlabRepositoryState = async () => "ready";
	QLab.ReaderContextStore.formatForPrompt = () => "";
	QLab.refreshShellWorkspaceChrome = () => {};
	QLab.loadApprovalPolicy = async root => {
		loadedRoots.push(root);
		return root === newRoot ? newPolicy : oldPolicy;
	};

	const marker = {};
	const runningTurn = { cancel() {} };
	const messages = [{ role: "assistant", text: "resident transcript" }];
	const host = {
		_qlabMountRoot: oldRoot,
		_qlabMountWorkspaceState: "ready",
		_qlabMountedKind: "qlabchat",
		_qlabApprovalPolicy: oldPolicy,
		_qlabApprovalPolicyRoot: oldRoot,
		_qlabMessages: messages,
		_qlabTurnHandle: runningTurn,
		querySelector(selector) {
			return selector === '[data-qlab-kind="qlabchat"]' ? marker : null;
		},
	};
	const fixture = integrationFixture(QLab, { productionMount: true });
	fixture.elements["qlab-chat-utility-content"].register(".qlab-shell-host", host);

	await fixture.controller.refreshWorkspace();
	await Promise.resolve();

	assert.deepEqual(loadedRoots, [newRoot]);
	assert.equal(host._qlabApprovalPolicyRoot, newRoot);
	assert.equal(host._qlabApprovalPolicy, newPolicy);
	assert.equal(
		QLab.evaluateApproval(host._qlabApprovalPolicy, { tool: "unlisted-tool" }),
		"deny",
		"later approvals must use the new workspace policy",
	);
	assert.equal(host._qlabMessages, messages, "workspace refresh preserves the transcript");
	assert.equal(host._qlabTurnHandle, runningTurn, "workspace refresh preserves a live turn");
	fixture.controller.destroy();
});

test("an in-flight turn keeps the approval policy of the workspace where it started", async () => {
	const QLab = await loadQLab();
	const oldRoot = "/workspaces/old";
	const newRoot = "/workspaces/new";
	const oldPolicy = { defaultAction: "ask", allow: [], deny: ["workspace_write"] };
	const newPolicy = { defaultAction: "ask", allow: ["workspace_write"], deny: [] };
	const prompt = { value: "Update the old workspace", focus() {} };
	const status = { textContent: "" };
	const send = { disabled: false };
	const stop = { hidden: true };
	const controls = new Map([
		["[data-qlab-prompt]", prompt],
		[".qlab-shell-status", status],
		["[data-qlab-send]", send],
		["[data-qlab-stop]", stop],
	]);
	const host = {
		_qlabMountRoot: oldRoot,
		_qlabMountWorkspaceState: "ready",
		_qlabMessages: [],
		_qlabApprovalPolicy: oldPolicy,
		_qlabApprovalPolicyRoot: oldRoot,
		querySelector(selector) {
			return controls.get(selector) || null;
		},
	};

	let streamStartedResolve;
	let releaseApprovalResolve;
	const streamStarted = new Promise(resolve => { streamStartedResolve = resolve; });
	const releaseApproval = new Promise(resolve => { releaseApprovalResolve = resolve; });
	let cancellations = 0;
	let turnInput;
	const turn = {
		cancel() {
			cancellations++;
		},
		async *[Symbol.asyncIterator]() {
			streamStartedResolve();
			await releaseApproval;
			yield {
				type: "approval-needed",
				tool: "workspace_write",
				reason: "Write the requested Draft change",
			};
			yield { type: "done", status: "ok" };
		},
	};
	QLab.Settings.getAgentProviderId = () => "test-provider";
	QLab.Settings.getAgentModel = () => "";
	QLab.Settings.getChatMode = () => "agent";
	QLab.Settings.getChatTranscriptMaxChars = () => 24_000;
	QLab.getAgentRuntime = () => ({
		startTurn(input) {
			turnInput = input;
			return turn;
		},
	});
	QLab.loadChatRulesPreamble = async () => "";
	QLab.renderChatMessages = () => {};
	QLab.updateChatContextMeter = () => {};
	QLab.persistChatHost = async () => {};
	QLab.hideComposerAtPicker = () => {};
	QLab.refreshChatProviderAvailability = async () => {};
	const loadedRoots = [];
	QLab.loadApprovalPolicy = async root => {
		loadedRoots.push(root);
		return root === oldRoot ? oldPolicy : newPolicy;
	};

	const run = QLab.runShellFreeform(host, oldRoot, "ready");
	await streamStarted;
	assert.equal(turnInput.workspaceRoot, oldRoot);
	host._qlabMountRoot = newRoot;
	host._qlabApprovalPolicy = newPolicy;
	host._qlabApprovalPolicyRoot = newRoot;
	releaseApprovalResolve();
	await run;

	assert.deepEqual(loadedRoots, [oldRoot]);
	assert.equal(cancellations, 1, "the old workspace deny rule must cancel the turn");
	assert.match(host._qlabMessages.at(-1).text, /\[denied\]/i);
});

test("Chat Pin and bounds restore only into their own window session", async () => {
	const preference = new Map();
	const QLab = await loadQLab({
		Prefs: {
			get: key => preference.get(key),
			set: (key, value) => preference.set(key, value),
		},
		Session: { debounceSave() {} },
	});
	const first = integrationFixture(QLab);
	first.controller.chatUtility.setPinned(true);
	first.controller.chatUtility._controller.setBounds({
		left: 120,
		top: 90,
		width: 640,
		height: 560,
	});
	const firstState = first.controller.getChatPresentationState();

	const second = integrationFixture(QLab);
	assert.equal(second.controller.chatUtility.snapshot().pinned, false);
	assert.notDeepEqual(
		plain(second.controller.chatUtility.snapshot().bounds),
		plain(first.controller.chatUtility.snapshot().bounds),
	);

	const restored = integrationFixture(QLab);
	restored.controller.restoreChatPresentationState(firstState);
	assert.equal(restored.controller.chatUtility.snapshot().pinned, true);
	assert.deepEqual(
		plain(restored.controller.chatUtility.snapshot().bounds),
		plain(first.controller.chatUtility.snapshot().bounds),
	);
	assert.equal(restored.controller.chatUtility.snapshot().visibility, "hidden");

	first.controller.destroy();
	second.controller.destroy();
	restored.controller.destroy();
});
