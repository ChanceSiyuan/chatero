import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test("AI edit replays over a disjoint human edit", async () => {
	const QLab = await loadQLab();
	let result = QLab.reviewQmdProposal({
		base: "title\nold theorem\nend\n",
		current: "new title\nold theorem\nend\n",
		proposed: "title\nnew theorem\nend\n",
	});
	assert.equal(result.status, "clean");
	assert.equal(result.text, "new title\nnew theorem\nend\n");
	assert.equal(result.hunks.length, 1);
});

test("overlapping human and AI edits preserve all three texts", async () => {
	const QLab = await loadQLab();
	let result = plain(QLab.reviewQmdProposal({
		base: "claim\n",
		current: "human claim\n",
		proposed: "AI claim\n",
	}));
	assert.equal(result.status, "conflict");
	assert.equal(result.base, "claim\n");
	assert.equal(result.current, "human claim\n");
	assert.equal(result.proposed, "AI claim\n");
	assert.equal(result.conflicts.length, 1);
});

test("AI insertion replays at an unchanged line boundary", async () => {
	const QLab = await loadQLab();
	let result = QLab.reviewQmdProposal({
		base: "A\nB\n",
		current: "human heading\nA\nB\n",
		proposed: "A\nAI detail\nB\n",
	});
	assert.equal(result.status, "clean");
	assert.equal(result.text, "human heading\nA\nAI detail\nB\n");
});

test("unchanged AI proposal leaves the current Draft intact", async () => {
	const QLab = await loadQLab();
	let result = QLab.reviewQmdProposal({
		base: "A\n",
		current: "human\nA\n",
		proposed: "A\n",
	});
	assert.equal(result.status, "clean");
	assert.equal(result.text, "human\nA\n");
	assert.equal(result.hunks.length, 0);
});
