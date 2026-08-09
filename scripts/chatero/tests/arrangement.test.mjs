import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const assertJSON = (actual, expected) => {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
};

test("applyArrangement updates groups and invokes bridge hooks", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const calls = [];
	const arrangement = QLab.buildPDFChatArrangement({ itemID: 11, title: "T" });
	const snapshot = await QLab.applyArrangement(groups, arrangement, {
		ensureReader: async (itemID) => {
			calls.push(["reader", itemID]);
			return `tab-reader-${itemID}`;
		},
		ensureShellTab: async (kind, payload) => {
			calls.push(["shell", kind, payload]);
			return kind;
		},
		showUtility: async (kind, payload) => calls.push(["show", kind, payload]),
		select: (id) => calls.push(["select", id]),
	});
	assert.equal(snapshot.groups.right, null);
	assertJSON(snapshot.utilityTabs.map((tab) => tab.id), ["qlabchat"]);
	assert.deepEqual(calls[0], ["reader", 11]);
	assert.equal(calls[1][0], "shell");
	assert.equal(calls[1][1], "qlabchat");
	assert.equal(calls[2][0], "show");
	assert.equal(calls[2][1], "qlabchat");
	assert.equal(calls.some((call) => call[0] === "select"), true);
});

test("arrangement builders expose floating Chat intent without making it a pane", async () => {
	const QLab = await loadQLab();
	const pdfChat = QLab.buildPDFChatArrangement({ itemID: 5 });
	assertJSON(QLab.arrangementPanes(pdfChat).map((spec) => spec.kind), ["reader"]);
	assertJSON(QLab.arrangementUtilities(pdfChat).map((spec) => spec.kind), ["qlabchat"]);
	assertJSON(pdfChat.showUtilities, ["qlabchat"]);
	const desk = QLab.buildResearchDeskArrangement({ itemID: 5, draftPath: "drafts/a.qmd" });
	assertJSON(QLab.arrangementPanes(desk).map((spec) => spec.kind), ["reader", "qlabqmd"]);
	assertJSON(QLab.arrangementUtilities(desk).map((spec) => spec.kind), ["qlabchat"]);
	assertJSON(desk.showUtilities, ["qlabchat"]);
	assert.equal(desk.right.kind, "qlabqmd");
});

test("buildPDF*Arrangement rejects non-numeric itemIDs", async () => {
	const QLab = await loadQLab();
	assert.throws(() => QLab.buildPDFChatArrangement({ itemID: "x" }));
	assert.throws(() => QLab.buildPDFEditorArrangement({}));
});

test("applyArrangement remaps shell tab ids onto the live host id", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const arrangement = QLab.buildPDFEditorArrangement({ itemID: 42, title: "Paper" });
	const snapshot = await QLab.applyArrangement(groups, arrangement, {
		ensureReader: async () => "tab-reader-42",
		// Session-restored shell tabs historically used a random id.
		ensureShellTab: async () => "tab-random-qmd",
		select: () => {},
	});
	assert.equal(snapshot.groups.right.activeTabID, "tab-random-qmd");
	assert.equal(snapshot.groups.left.activeTabID, "tab-reader-42");
	assert.equal(groups.tab("reader:42"), null, "the synthetic Reader id must be rekeyed");
	const visibility = QLab.resolveSplitVisibility(snapshot, "tab-reader-42");
	assert.equal(visibility.rightID, "tab-random-qmd");
	assert.equal(
		JSON.stringify(QLab.paneClassForTab("tab-random-qmd", visibility).slice().sort()),
		JSON.stringify(["deck-selected", "qlab-visible-right"].sort()),
	);
});

test("applyArrangement replaces the synthetic Reader id with the one live native Reader", async () => {
	const QLab = await loadQLab();
	const groups = new QLab.TabGroups();
	const arrangement = QLab.buildResearchDeskArrangement({
		itemID: 42,
		title: "Paper",
		draftPath: "drafts/paper.qmd",
	});
	const bridge = {
		ensureReader: async () => {
			// Opening the native Reader registers its minted tab id while the
			// arrangement's synthetic reader:42 entry is still present.
			groups.openTab({
				kind: "reader",
				id: "tab-reader-42",
				title: "Paper",
				payload: { itemID: 42 },
			}, "left");
			return "tab-reader-42";
		},
		ensureShellTab: async kind => kind,
		select: () => {},
	};

	await QLab.applyArrangement(groups, arrangement, bridge);
	await QLab.applyArrangement(groups, arrangement, bridge);

	const readers = groups.contentTabs().filter(tab => (
		tab.kind === "reader" && tab.payload?.itemID === 42
	));
	assertJSON(readers.map(tab => tab.id), ["tab-reader-42"]);
	assert.equal(groups.tab("reader:42"), null);
	assertJSON(
		groups.serialize().contentTabs
			.filter(tab => tab.kind === "reader" && tab.payload?.itemID === 42)
			.map(tab => tab.id),
		["tab-reader-42"],
	);

	groups.closeTab("tab-reader-42");
	const afterClose = groups.snapshot();
	const liveIDs = new Set(groups.contentTabs().map(tab => tab.id));
	assert.equal(afterClose.groups.left.activeTabID, "zotero-pane");
	assert.equal(
		afterClose.panes.every(pane => (
			pane.activeTabID === null || liveIDs.has(pane.activeTabID)
		)),
		true,
		"closing the native Reader must not activate a nonexistent synthetic host",
	);
});
