import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("TabGroups defaults to library on the left", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const snapshot = groups.snapshot();
	assert.equal(snapshot.focusedGroup, "left");
	assert.equal(snapshot.groups.right, null);
	assert.equal(JSON.stringify([...snapshot.groups.left.tabIDs]), JSON.stringify(["zotero-pane"]));
	assert.equal(snapshot.groups.left.activeTabID, "zotero-pane");
});

test("TabGroups arrange PDF | Chat is idempotent and opens a right group", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const arrangement = QLab.buildPDFChatArrangement({ itemID: 42, title: "Paper" });
	groups.arrange(arrangement.left, arrangement.right);
	groups.arrange(arrangement.left, arrangement.right);
	const snapshot = groups.snapshot();
	assert.ok(snapshot.groups.right);
	assert.equal(snapshot.groups.left.activeTabID, "reader:42");
	assert.equal(snapshot.groups.right.activeTabID, "qlabchat");
	assert.equal(groups.tabs().filter((tab) => tab.kind === "qlabchat").length, 1);
});

test("TabGroups arrange PDF | Editor uses qlabqmd singleton", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const arrangement = QLab.buildPDFEditorArrangement({ itemID: 7 });
	groups.arrange(arrangement.left, arrangement.right);
	assert.equal(groups.snapshot().groups.right.activeTabID, "qlabqmd");
});

test("TabGroups serialize/restore round-trip keeps split", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	groups.arrange(
		QLab.buildPDFChatArrangement({ itemID: 1 }).left,
		QLab.buildPDFChatArrangement({ itemID: 1 }).right,
	);
	groups.setSplitRatio(0.4);
	const serialized = groups.serialize();
	const restored = new QLab.TabGroups();
	restored.restore(serialized);
	assert.equal(restored.snapshot().splitRatio, 0.4);
	assert.equal(restored.snapshot().groups.right.activeTabID, "qlabchat");
	assert.ok(restored.tab("zotero-pane"));
});

test("closing the last right tab collapses the split", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	groups.arrange(
		QLab.buildPDFChatArrangement({ itemID: 9 }).left,
		QLab.buildPDFChatArrangement({ itemID: 9 }).right,
	);
	groups.closeTab("qlabchat");
	assert.equal(groups.snapshot().groups.right, null);
});

test("library tab cannot move to the right group", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	assert.throws(() => groups.moveTab("zotero-pane", "right"));
});

test("research desk arranges PDF | QMD | Chat across three panes", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const desk = QLab.buildResearchDeskArrangement({ itemID: 11, title: "Paper" });
	groups.arrange(desk.left, desk.center, desk.right);
	groups.arrange(desk.left, desk.center, desk.right);
	const snapshot = groups.snapshot();
	assert.equal(snapshot.paneCount, 3);
	assert.equal(snapshot.groups.left.activeTabID, "reader:11");
	assert.equal(snapshot.groups.center.activeTabID, "qlabqmd");
	assert.equal(snapshot.groups.right.activeTabID, "qlabchat");
	assert.equal(snapshot.splitRatios.length, 2);
	assert.ok(snapshot.splitRatios[0] < snapshot.splitRatios[1]);
});

test("arranging two panes folds a third pane back in without closing tabs", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const desk = QLab.buildResearchDeskArrangement({ itemID: 3 });
	groups.arrange(desk.left, desk.center, desk.right);
	const chat = QLab.buildPDFChatArrangement({ itemID: 3 });
	groups.arrange(chat.left, chat.right);
	const snapshot = groups.snapshot();
	assert.equal(snapshot.paneCount, 2);
	assert.equal(snapshot.groups.right.activeTabID, "qlabchat");
	assert.ok(snapshot.groups.right.tabIDs.includes("qlabqmd"));
	assert.ok(groups.tab("qlabqmd"));
});

test("closing the center tab collapses the desk back to two panes", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const desk = QLab.buildResearchDeskArrangement({ itemID: 4 });
	groups.arrange(desk.left, desk.center, desk.right);
	groups.closeTab("qlabqmd");
	const snapshot = groups.snapshot();
	assert.equal(snapshot.paneCount, 2);
	assert.equal(snapshot.groups.center, null);
	assert.equal(snapshot.groups.right.activeTabID, "qlabchat");
});

test("three-pane serialize/restore keeps pane order and both ratios", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const desk = QLab.buildResearchDeskArrangement({ itemID: 8 });
	groups.arrange(desk.left, desk.center, desk.right);
	groups.setSplitRatioAt(0, 0.3);
	groups.setSplitRatioAt(1, 0.62);
	const restored = new QLab.TabGroups();
	restored.restore(groups.serialize());
	const snapshot = restored.snapshot();
	assert.equal(snapshot.paneCount, 3);
	assert.equal(snapshot.groups.center.activeTabID, "qlabqmd");
	assert.equal(JSON.stringify(snapshot.splitRatios), JSON.stringify([0.3, 0.62]));
});

test("version 1 session state restores as a two-pane layout", async () => {
	const QLab = await loadQLab();
	const restored = new QLab.TabGroups();
	restored.restore({
		version: 1,
		tabs: [
			{ id: "zotero-pane", kind: "library", title: "Library" },
			{ id: "qlabchat", kind: "qlabchat", title: "Chat" },
		],
		groups: {
			left: { tabIDs: ["zotero-pane"], activeTabID: "zotero-pane" },
			right: { tabIDs: ["qlabchat"], activeTabID: "qlabchat" },
		},
		focusedGroup: "left",
		splitRatio: 0.45,
	});
	const snapshot = restored.snapshot();
	assert.equal(snapshot.paneCount, 2);
	assert.equal(snapshot.groups.right.activeTabID, "qlabchat");
	assert.equal(snapshot.splitRatio, 0.45);
});
