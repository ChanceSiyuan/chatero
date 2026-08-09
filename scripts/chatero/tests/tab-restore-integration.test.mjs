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
	};
}

test("native tab restoration finishes before legacy groups reconcile onto the minted Reader id", async () => {
	const QLab = await loadQLab();
	const state = legacyState();
	let releaseNative;
	const nativeReady = new Promise(resolve => { releaseNative = resolve; });
	let restoredGroups = null;
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
