import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const plain = value => JSON.parse(JSON.stringify(value));

function legacyState() {
	return {
		tabs: [
			{ type: "library", title: "Library", data: {}, selected: false },
			{ type: "reader", title: "Paper", data: { itemID: 42 }, selected: true },
			{ type: "qlabqmd", title: "QMD Editor", data: {}, selected: false },
			{ type: "qlabchat", title: "Chat", data: {}, selected: false },
		],
		qlabGroups: {
			version: 2,
			tabs: [
				{ id: "zotero-pane", kind: "library", title: "Library" },
				{ id: "old-reader-id", kind: "reader", title: "Paper", payload: { itemID: 42 } },
				{ id: "qlabqmd", kind: "qlabqmd", title: "QMD Editor" },
				{ id: "qlabchat", kind: "qlabchat", title: "Chat" },
			],
			panes: [
				{ tabIDs: ["zotero-pane", "old-reader-id"], activeTabID: "old-reader-id" },
				{ tabIDs: ["qlabqmd"], activeTabID: "qlabqmd" },
				{ tabIDs: ["qlabchat"], activeTabID: "qlabchat" },
			],
			focusedGroup: "center",
			splitRatios: [0.37, 0.72],
		},
		qlabChatPresentation: {
			pinned: true,
			bounds: { left: 88, top: 64, width: 680, height: 600 },
		},
	};
}

test("native qlabsite restore drops legacy absolute URLs and preserves only a safe relative page", async () => {
	const QLab = await loadQLab();
	const payload = {
		setupRoot: "/tmp/research-loop",
		repositoryIdentity: "12345678-1234-4123-8123-123456789abc",
		siteURL: "http://127.0.0.1:4180/knowledge/topic.html",
		sitePath: "/knowledge/topic.html",
	};
	let restoredTabs = null;
	const tabsAPI = {
		_tabs: [{ id: "zotero-pane", type: "library", data: {} }],
		async restoreState(tabs) {
			restoredTabs = tabs;
			this._tabs = [
				{ id: "zotero-pane", type: "library", data: {} },
				{ id: "qlabsite", type: "qlabsite", data: payload },
			];
		},
		restoreQLabGroupsState() {},
	};
	await QLab.restoreNativeAndQLabTabState(tabsAPI, {
		tabs: [
			{ type: "library", data: {} },
			{ type: "qlabsite", title: "Knowledge Site", data: payload, selected: true },
		],
	});
	assert.deepEqual(plain(restoredTabs[1].data), {
		setupRoot: "/tmp/research-loop",
		repositoryIdentity: "12345678-1234-4123-8123-123456789abc",
		sitePath: "/knowledge/topic.html",
	});
});

test("native tab restoration finishes before legacy groups reconcile onto the minted Reader id", async () => {
	const QLab = await loadQLab();
	const state = legacyState();
	let releaseNative;
	const nativeReady = new Promise(resolve => { releaseNative = resolve; });
	let restoredGroups = null;
	let restoredChatPresentation = null;
	const tabsAPI = {
		_tabs: [{ id: "zotero-pane", type: "library", data: {} }],
		async restoreState() {
			await nativeReady;
			this._tabs = [
				{ id: "zotero-pane", type: "library", data: {} },
				{ id: "minted-reader-id", type: "reader-unloaded", data: { itemID: 42 } },
				{ id: "qlabqmd", type: "qlabqmd", data: {} },
				{ id: "qlabchat", type: "qlabchat", data: {} },
			];
		},
		restoreQLabGroupsState(data) {
			restoredGroups = new QLab.TabGroups();
			restoredGroups.restore(data);
		},
		restoreQLabChatPresentationState(data) {
			restoredChatPresentation = data;
		},
	};

	const restoring = QLab.restoreNativeAndQLabTabState(tabsAPI, state);
	await Promise.resolve();
	assert.equal(restoredGroups, null, "group restoration must wait for native tabs");
	releaseNative();
	await restoring;

	const snapshot = restoredGroups.snapshot();
	assert.deepEqual(
		plain(snapshot.panes.map(pane => pane.activeTabID)),
		["minted-reader-id", "qlabqmd"],
	);
	assert.equal(snapshot.panes.some(pane => pane.tabIDs.includes("old-reader-id")), false);
	assert.equal(restoredGroups.groupOf("minted-reader-id"), "left");
	assert.deepEqual(plain(snapshot.splitRatios), [0.37]);
	assert.deepEqual(plain(snapshot.utilityTabs.map(tab => tab.id)), ["qlabchat"]);
	assert.deepEqual(
		plain(restoredChatPresentation),
		plain(state.qlabChatPresentation),
		"the current window restores only its own serialized Chat presentation",
	);
});

test("QLab restore claims native ownership before restore and keeps it across later failure", async () => {
	const QLab = await loadQLab();
	const events = [];
	const failure = new Error("group restore failed");
	const tabsAPI = {
		_tabs: [{ id: "zotero-pane", type: "library", data: {} }],
		async restoreState() {
			events.push("native");
		},
		restoreQLabGroupsState() {
			events.push("groups");
			throw failure;
		},
	};
	const progress = {
		claimNativeRestore() {
			events.push("claimed");
		},
	};

	await assert.rejects(
		QLab.restoreNativeAndQLabTabState(tabsAPI, legacyState(), progress),
		failure,
	);
	assert.deepEqual(events, ["claimed", "native", "groups"]);
});

test("restored duplicate Reader and Note identities reconcile one-to-one in session order", async () => {
	const QLab = await loadQLab();
	const reconciled = QLab.reconcileRestoredTabGroupState({
		version: 3,
		contentTabs: [
			{ id: "zotero-pane", kind: "library", title: "Library" },
			{ id: "old-reader-a", kind: "reader", payload: { itemID: 7 } },
			{ id: "old-reader-b", kind: "reader", payload: { itemID: 7 } },
			{ id: "old-note", kind: "note", payload: { itemID: 8 } },
		],
		utilityTabs: [],
		panes: [{
			tabIDs: ["zotero-pane", "old-reader-a", "old-reader-b", "old-note"],
			activeTabID: "old-reader-b",
		}],
	}, [
		{ id: "zotero-pane", type: "library", data: {} },
		{ id: "reader-live-a", type: "reader-unloaded", data: { itemID: 7 } },
		{ id: "reader-live-b", type: "reader", data: { itemID: 7 } },
		{ id: "note-live", type: "note-loading", data: { itemID: 8 } },
	]);

	assert.deepEqual(plain(reconciled.contentTabs.map(tab => tab.id)), [
		"zotero-pane",
		"reader-live-a",
		"reader-live-b",
		"note-live",
	]);
	assert.deepEqual(plain(reconciled.panes[0].tabIDs), [
		"zotero-pane",
		"reader-live-a",
		"reader-live-b",
		"note-live",
	]);
	assert.equal(reconciled.panes[0].activeTabID, "reader-live-b");
});

test("missing restored Reader and Note tabs are removed with safe pane fallbacks", async () => {
	const QLab = await loadQLab();
	const reconciled = QLab.reconcileRestoredTabGroupState({
		version: 3,
		contentTabs: [
			{ id: "zotero-pane", kind: "library", title: "Library" },
			{ id: "missing-reader", kind: "reader", payload: { itemID: 7 } },
			{ id: "missing-note", kind: "note", payload: { itemID: 8 } },
			{ id: "qlabqmd", kind: "qlabqmd", title: "QMD Editor" },
		],
		utilityTabs: [],
		panes: [
			{ tabIDs: ["zotero-pane", "missing-reader"], activeTabID: "missing-reader" },
			{ tabIDs: ["missing-note"], activeTabID: "missing-note" },
			{ tabIDs: ["qlabqmd"], activeTabID: "qlabqmd" },
		],
		groups: {
			left: { tabIDs: ["zotero-pane", "missing-reader"], activeTabID: "missing-reader" },
			right: { tabIDs: ["missing-note"], activeTabID: "missing-note" },
		},
	}, [
		{ id: "zotero-pane", type: "library", data: {} },
		{ id: "qlabqmd", type: "qlabqmd", data: {} },
	]);

	assert.deepEqual(plain(reconciled.contentTabs.map(tab => tab.id)), [
		"zotero-pane",
		"qlabqmd",
	]);
	assert.deepEqual(plain(reconciled.panes), [
		{ tabIDs: ["zotero-pane"], activeTabID: "zotero-pane" },
		{ tabIDs: [], activeTabID: null },
		{ tabIDs: ["qlabqmd"], activeTabID: "qlabqmd" },
	]);
	assert.deepEqual(plain(reconciled.groups), {
		left: { tabIDs: ["zotero-pane"], activeTabID: "zotero-pane" },
		right: { tabIDs: [], activeTabID: null },
	});
	assert.doesNotMatch(JSON.stringify(reconciled), /missing-(?:reader|note)/);

	const restored = new QLab.TabGroups();
	restored.restore(reconciled);
	assert.deepEqual(
		plain(restored.snapshot().panes.map(pane => pane.activeTabID)),
		["zotero-pane", "qlabqmd"],
	);
});
