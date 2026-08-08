import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

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
		select: (id) => calls.push(["select", id]),
	});
	assert.ok(snapshot.groups.right);
	assert.deepEqual(calls[0], ["reader", 11]);
	assert.equal(calls[1][0], "shell");
	assert.equal(calls[1][1], "qlabchat");
	assert.equal(calls.some((call) => call[0] === "select"), true);
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
	const visibility = QLab.resolveSplitVisibility(snapshot, "tab-reader-42");
	assert.equal(visibility.rightID, "tab-random-qmd");
	assert.equal(
		JSON.stringify(QLab.paneClassForTab("tab-random-qmd", visibility).slice().sort()),
		JSON.stringify(["deck-selected", "qlab-visible-right"].sort()),
	);
});
