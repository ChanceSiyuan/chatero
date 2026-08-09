import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const assertJSON = (actual, expected) => {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
};

test("resolveSplitVisibility is single-pane when no right group", async () => {
	const QLab = await loadQLab();
	const visibility = QLab.resolveSplitVisibility({
		groups: {
			left: { tabIDs: ["zotero-pane"], activeTabID: "zotero-pane" },
			right: null,
		},
		splitRatio: 0.5,
	}, "zotero-pane");
	assert.equal(visibility.split, false);
	assert.equal(JSON.stringify(visibility.visibleIDs), JSON.stringify(["zotero-pane"]));
});

test("resolveSplitVisibility ignores legacy utility-only panes", async () => {
	const QLab = await loadQLab();
	const visibility = QLab.resolveSplitVisibility({
		groups: {
			left: { tabIDs: ["tab-reader"], activeTabID: "tab-reader" },
			right: { tabIDs: ["qlabchat"], activeTabID: "qlabchat" },
		},
		focusedGroup: "left",
		splitRatio: 0.4,
		utilityTabs: [{ id: "qlabchat", kind: "qlabchat" }],
	}, "tab-reader");
	assert.equal(visibility.split, false);
	assert.equal(visibility.leftID, "tab-reader");
	assert.equal(visibility.rightID, null);
	assert.equal(visibility.splitRatio, 0.4);
	assertJSON(visibility.visibleIDs, ["tab-reader"]);
});

test("paneClassForTab marks both hosts deck-selected in split mode", async () => {
	const QLab = await loadQLab();
	const visibility = {
		split: true,
		leftID: "a",
		rightID: "b",
		focusedID: "a",
		splitRatio: 0.5,
		visibleIDs: ["a", "b"],
	};
	assert.equal(
		JSON.stringify(QLab.paneClassForTab("a", visibility)),
		JSON.stringify(["deck-selected", "qlab-visible-left"]),
	);
	assert.equal(
		JSON.stringify(QLab.paneClassForTab("b", visibility)),
		JSON.stringify(["deck-selected", "qlab-visible-right"]),
	);
	assert.equal(JSON.stringify(QLab.paneClassForTab("c", visibility)), JSON.stringify([]));
});

test("resolveSplitVisibility exposes PDF and QMD only for the research desk", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const desk = QLab.buildResearchDeskArrangement({ itemID: 6 });
	groups.arrange(...QLab.arrangementPanes(desk), ...QLab.arrangementUtilities(desk));
	const visibility = QLab.resolveSplitVisibility(groups.snapshot(), "reader:6");
	assert.equal(visibility.split, true);
	assert.equal(visibility.paneCount, 2);
	assert.equal(visibility.leftID, "reader:6");
	assert.equal(visibility.centerID, null);
	assert.equal(visibility.rightID, "qlabqmd");
	assertJSON(visibility.visibleIDs, ["reader:6", "qlabqmd"]);
});

test("paneClassForTab marks the center host in a three-pane deck", async () => {
	const QLab = await loadQLab();
	const visibility = {
		split: true,
		paneCount: 3,
		paneIDs: ["a", "b", "c"],
		focusedID: "a",
		splitRatios: [0.34, 0.67],
		visibleIDs: ["a", "b", "c"],
	};
	const classesFor = id => JSON.stringify(QLab.paneClassForTab(id, visibility));
	assert.equal(classesFor("a"), JSON.stringify(["deck-selected", "qlab-visible-left"]));
	assert.equal(classesFor("b"), JSON.stringify(["deck-selected", "qlab-visible-center"]));
	assert.equal(classesFor("c"), JSON.stringify(["deck-selected", "qlab-visible-right"]));
	assert.equal(classesFor("d"), JSON.stringify([]));
});

test("isTabVisible reports panes that are on screen right now", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const desk = QLab.buildResearchDeskArrangement({ itemID: 2 });
	groups.arrange(...QLab.arrangementPanes(desk), ...QLab.arrangementUtilities(desk));
	const visibility = QLab.resolveSplitVisibility(groups.snapshot(), "reader:2");
	assert.equal(QLab.isTabVisible(visibility, "qlabchat"), false);
	assert.equal(QLab.isTabVisible(visibility, "qlabqmd"), true);
	assert.equal(QLab.isTabVisible(visibility, "zotero-pane"), false);
});

test("arrange PDF + floating Chat yields one content pane for chrome", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const arrangement = QLab.buildPDFChatArrangement({ itemID: 5, title: "P" });
	groups.arrange(...QLab.arrangementPanes(arrangement), ...QLab.arrangementUtilities(arrangement));
	const visibility = QLab.resolveSplitVisibility(groups.snapshot(), "reader:5");
	assert.equal(visibility.split, false);
	assert.equal(visibility.rightID, null);
	assertJSON(visibility.visibleIDs, ["reader:5"]);
});
