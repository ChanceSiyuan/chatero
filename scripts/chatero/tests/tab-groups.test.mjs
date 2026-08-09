import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const assertJSON = (actual, expected) => {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
};

test("TabGroups defaults to library on the left", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const snapshot = groups.snapshot();
	assert.equal(snapshot.focusedGroup, "left");
	assert.equal(snapshot.groups.right, null);
	assert.equal(JSON.stringify([...snapshot.groups.left.tabIDs]), JSON.stringify(["zotero-pane"]));
	assert.equal(snapshot.groups.left.activeTabID, "zotero-pane");
	assertJSON(snapshot.utilityTabs, []);
});

test("TabGroups arrange PDF + floating Chat is idempotent and keeps Chat out of panes", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const arrangement = QLab.buildPDFChatArrangement({ itemID: 42, title: "Paper" });
	groups.arrange(...QLab.arrangementPanes(arrangement), ...QLab.arrangementUtilities(arrangement));
	groups.arrange(...QLab.arrangementPanes(arrangement), ...QLab.arrangementUtilities(arrangement));
	const snapshot = groups.snapshot();
	assert.equal(snapshot.paneCount, 1);
	assert.equal(snapshot.groups.right, null);
	assert.equal(snapshot.groups.left.activeTabID, "reader:42");
	assertJSON(snapshot.utilityTabs.map((tab) => tab.id), ["qlabchat"]);
	assert.equal(snapshot.panes.some((pane) => pane.tabIDs.includes("qlabchat")), false);
	assert.equal(groups.tabs().filter((tab) => tab.kind === "qlabchat").length, 1);
});

test("TabGroups arrange PDF | Editor uses qlabqmd singleton", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const arrangement = QLab.buildPDFEditorArrangement({ itemID: 7 });
	groups.arrange(arrangement.left, arrangement.right);
	assert.equal(groups.snapshot().groups.right.activeTabID, "qlabqmd");
});

test("TabGroups v3 serialize/restore round-trip separates utilities from content", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const desk = QLab.buildResearchDeskArrangement({ itemID: 1 });
	groups.arrange(...QLab.arrangementPanes(desk), ...QLab.arrangementUtilities(desk));
	groups.setSplitRatio(0.4);
	const serialized = groups.serialize();
	assert.equal(serialized.version, 3);
	assertJSON(serialized.contentTabs.map((tab) => tab.kind), ["library", "reader", "qlabqmd"]);
	assertJSON(serialized.utilityTabs.map((tab) => tab.kind), ["qlabchat"]);
	assert.equal(Object.hasOwn(serialized, "tabs"), false);
	const restored = new QLab.TabGroups();
	restored.restore(serialized);
	assert.equal(restored.snapshot().splitRatio, 0.4);
	assert.equal(restored.snapshot().groups.right.activeTabID, "qlabqmd");
	assertJSON(restored.snapshot().utilityTabs.map((tab) => tab.id), ["qlabchat"]);
	assert.equal(restored.snapshot().panes.some((pane) => pane.tabIDs.includes("qlabchat")), false);
	assert.ok(restored.tab("zotero-pane"));
});

test("closing Chat removes the utility without changing the content panes", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const desk = QLab.buildResearchDeskArrangement({ itemID: 9 });
	groups.arrange(...QLab.arrangementPanes(desk), ...QLab.arrangementUtilities(desk));
	groups.closeTab("qlabchat");
	assert.equal(groups.snapshot().groups.right.activeTabID, "qlabqmd");
	assertJSON(groups.snapshot().utilityTabs, []);
});

test("library tab cannot move to the right group", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	assert.throws(() => groups.moveTab("zotero-pane", "right"));
});

test("research desk arranges PDF | QMD and registers one Chat utility", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const desk = QLab.buildResearchDeskArrangement({ itemID: 11, title: "Paper" });
	groups.arrange(...QLab.arrangementPanes(desk), ...QLab.arrangementUtilities(desk));
	groups.arrange(...QLab.arrangementPanes(desk), ...QLab.arrangementUtilities(desk));
	const snapshot = groups.snapshot();
	assert.equal(snapshot.paneCount, 2);
	assert.equal(snapshot.groups.left.activeTabID, "reader:11");
	assert.equal(snapshot.groups.center, null);
	assert.equal(snapshot.groups.right.activeTabID, "qlabqmd");
	assertJSON(snapshot.utilityTabs.map((tab) => tab.id), ["qlabchat"]);
	assert.equal(snapshot.splitRatios.length, 1);
});

test("PDF | QMD does not force floating Chat open or duplicate its launcher", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const desk = QLab.buildResearchDeskArrangement({ itemID: 3 });
	groups.arrange(...QLab.arrangementPanes(desk), ...QLab.arrangementUtilities(desk));
	const editor = QLab.buildPDFEditorArrangement({ itemID: 3 });
	groups.arrange(...QLab.arrangementPanes(editor));
	const snapshot = groups.snapshot();
	assert.equal(snapshot.paneCount, 2);
	assert.equal(snapshot.groups.right.activeTabID, "qlabqmd");
	assertJSON(snapshot.utilityTabs.map((tab) => tab.id), ["qlabchat"]);
	assert.equal(editor.showUtilities, undefined);
	assert.ok(groups.tab("qlabqmd"));
});

test("utility tabs cannot be moved or healed into a content pane", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	groups.openTab({ kind: "qlabchat" }, "right");
	groups.moveTab("qlabchat", "left", 0);
	const snapshot = groups.snapshot();
	assert.equal(snapshot.paneCount, 1);
	assert.equal(snapshot.groups.left.activeTabID, "zotero-pane");
	assert.equal(snapshot.panes.some((pane) => pane.tabIDs.includes("qlabchat")), false);
	assertJSON(snapshot.utilityTabs.map((tab) => tab.id), ["qlabchat"]);
});

test("v2 PDF | QMD | Chat migration preserves content order and first divider", async () => {
	const QLab = await loadQLab();
	const restored = new QLab.TabGroups();
	restored.restore({
		version: 2,
		tabs: [
			{ id: "zotero-pane", kind: "library", title: "Library" },
			{ id: "reader:8", kind: "reader", title: "Paper", payload: { itemID: 8 } },
			{ id: "qlabqmd", kind: "qlabqmd", title: "QMD Editor" },
			{ id: "qlabchat", kind: "qlabchat", title: "Chat" },
		],
		panes: [
			{ tabIDs: ["zotero-pane", "reader:8"], activeTabID: "reader:8" },
			{ tabIDs: ["qlabqmd"], activeTabID: "qlabqmd" },
			{ tabIDs: ["qlabchat"], activeTabID: "qlabchat" },
		],
		focusedGroup: "center",
		splitRatios: [0.3, 0.62],
	});
	const snapshot = restored.snapshot();
	assert.equal(snapshot.paneCount, 2);
	assertJSON(snapshot.panes.map((pane) => pane.activeTabID), ["reader:8", "qlabqmd"]);
	assertJSON(snapshot.splitRatios, [0.3]);
	assert.equal(snapshot.focusedGroup, "right");
	assertJSON(snapshot.utilityTabs.map((tab) => tab.id), ["qlabchat"]);
	assert.equal(snapshot.panes.some((pane) => pane.tabIDs.includes("qlabchat")), false);
});

test("v2 PDF | Chat migration keeps Chat out of pane zero and preserves ratio for a later split", async () => {
	const QLab = await loadQLab();
	const restored = new QLab.TabGroups();
	restored.restore({
		version: 2,
		tabs: [
			{ id: "zotero-pane", kind: "library", title: "Library" },
			{ id: "reader:15", kind: "reader", title: "Paper", payload: { itemID: 15 } },
			{ id: "qlabchat", kind: "qlabchat", title: "Chat" },
		],
		groups: {
			left: { tabIDs: ["zotero-pane", "reader:15"], activeTabID: "reader:15" },
			right: { tabIDs: ["qlabchat"], activeTabID: "qlabchat" },
		},
		focusedGroup: "left",
		splitRatio: 0.41,
	});
	assert.equal(restored.snapshot().paneCount, 1);
	assertJSON(restored.snapshot().panes[0].tabIDs, ["zotero-pane", "reader:15"]);
	assertJSON(restored.snapshot().utilityTabs.map((tab) => tab.id), ["qlabchat"]);
	assert.equal(restored.snapshot().panes[0].tabIDs.includes("qlabchat"), false);
	// Visibility is an invocation intent, not persisted session state: restore is hidden.
	assert.equal(Object.hasOwn(restored.serialize(), "showUtilities"), false);
	restored.openTab({ kind: "qlabqmd" }, "right");
	assertJSON(restored.snapshot().splitRatios, [0.41]);
});

test("malformed v3 panes fall back without dropping valid native content tabs", async () => {
	const QLab = await loadQLab();
	const restored = new QLab.TabGroups();
	restored.restore({
		version: 3,
		contentTabs: [
			{ id: "zotero-pane", kind: "library", title: "Library" },
			{ id: "reader-live", kind: "reader", title: "Paper", payload: { itemID: 22 } },
			{ id: "note-live", kind: "note", title: "Note", payload: { itemID: 23 } },
		],
		utilityTabs: [
			{ id: "qlabchat", kind: "qlabchat", title: "Chat" },
		],
		panes: [{ tabIDs: "not-an-array", activeTabID: "reader-live" }],
		splitRatios: [0.47],
	});
	const snapshot = restored.snapshot();
	assertJSON(snapshot.panes[0].tabIDs, ["zotero-pane", "reader-live", "note-live"]);
	assert.equal(snapshot.panes[0].tabIDs.includes("qlabchat"), false);
	assertJSON(snapshot.utilityTabs.map((tab) => tab.id), ["qlabchat"]);
	assert.ok(restored.tab("reader-live"));
	assert.ok(restored.tab("note-live"));
});

test("rekeyTab retargets pane membership onto a live tab id", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	groups.arrange(
		{ kind: "reader", id: "reader:1", payload: { itemID: 1 } },
		{ kind: "qlabqmd" },
	);
	assert.equal(groups.snapshot().groups.right.activeTabID, "qlabqmd");
	assert.equal(groups.rekeyTab("qlabqmd", "tab-restored-qmd"), true);
	assert.equal(groups.snapshot().groups.right.activeTabID, "tab-restored-qmd");
	assert.equal(groups.tab("qlabqmd"), null);
	assert.ok(groups.tab("tab-restored-qmd"));
});
