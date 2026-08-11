import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("human edit is dirty immediately and schedules one 800 ms save", async () => {
	const QLab = await loadQLab();
	let scheduled = [];
	let saveCalls = [];
	let session = QLab.createQmdDraftSession({
		path: "drafts/a.qmd",
		text: "old",
		revision: "r1",
		schedule: (fn, ms) => {
			scheduled.push({ fn, ms });
			return scheduled.length;
		},
		cancel: () => {},
		onSave: async (request) => {
			saveCalls.push(request);
			return { path: request.path, revision: "r2" };
		},
	});

	session.applyHumanEdit("new");
	assert.equal(session.snapshot().dirty, true);
	assert.equal(session.snapshot().text, "new");
	assert.equal(scheduled.length, 1);
	assert.equal(scheduled[0].ms, 800);

	await scheduled[0].fn();
	assert.equal(saveCalls.length, 1);
	assert.equal(saveCalls[0].path, "drafts/a.qmd");
	assert.equal(saveCalls[0].text, "new");
	assert.equal(saveCalls[0].expectedRevision, "r1");
	assert.equal(session.snapshot().revision, "r2");
	assert.equal(session.snapshot().dirty, false);
});

test("dirty buffer ignores an unchanged disk revision", async () => {
	const QLab = await loadQLab();
	let conflicts = [];
	let session = QLab.createQmdDraftSession({
		path: "drafts/a.qmd",
		text: "old",
		revision: "r1",
		schedule: () => 1,
		cancel: () => {},
		onSave: async () => ({ revision: "r2" }),
		onConflict: value => conflicts.push(value),
	});

	session.applyHumanEdit("memory");
	session.observeDisk({ text: "old", revision: "r1" });

	assert.equal(conflicts.length, 0);
	assert.equal(session.snapshot().text, "memory");
});

test("clean external change reloads while a dirty change requests compare", async () => {
	const QLab = await loadQLab();
	let conflicts = [];
	let session = QLab.createQmdDraftSession({
		path: "drafts/a.qmd",
		text: "old",
		revision: "r1",
		schedule: () => 1,
		cancel: () => {},
		onSave: async () => ({ revision: "r3" }),
		onConflict: value => conflicts.push(value),
	});

	session.observeDisk({ text: "disk", revision: "r2" });
	assert.equal(session.snapshot().text, "disk");
	assert.equal(session.snapshot().dirty, false);

	session.applyHumanEdit("memory");
	session.observeDisk({ text: "new disk", revision: "r3" });
	assert.equal(conflicts.length, 1);
	assert.equal(conflicts[0].disk.text, "new disk");
	assert.equal(conflicts[0].buffer.text, "memory");
});

test("failed save preserves the dirty buffer and exposes the error", async () => {
	const QLab = await loadQLab();
	let scheduled = [];
	let session = QLab.createQmdDraftSession({
		path: "drafts/a.qmd",
		text: "old",
		revision: "r1",
		schedule: fn => (scheduled.push(fn), scheduled.length),
		cancel: () => {},
		onSave: async () => { throw new Error("disk full"); },
	});
	session.applyHumanEdit("new");
	await assert.rejects(() => scheduled[0](), /disk full/);
	assert.equal(session.snapshot().dirty, true);
	assert.equal(session.snapshot().saveError, "disk full");
});

test("proposal state and disposal are explicit and cancel scheduled work", async () => {
	const QLab = await loadQLab();
	let cancelled = [];
	let states = 0;
	let session = QLab.createQmdDraftSession({
		path: "drafts/a.qmd",
		text: "old",
		revision: "r1",
		schedule: () => 17,
		cancel: id => cancelled.push(id),
		onSave: async () => ({ revision: "r2" }),
		onState: () => { states++; },
	});
	session.attachProposal({ workingPath: "work/qlab-zotero/draft-changes/x/draft.qmd" });
	assert.equal(session.snapshot().proposal.workingPath,
		"work/qlab-zotero/draft-changes/x/draft.qmd");
	session.clearProposal();
	assert.equal(session.snapshot().proposal, null);
	session.applyHumanEdit("new");
	const statesBeforeDispose = states;
	session.dispose();
	session.dispose();
	assert.deepEqual(cancelled, [17]);
	assert.equal(states, statesBeforeDispose + 1, "disposal must be observable exactly once");
	assert.equal(session.snapshot().disposed, true);
});

test("auto-saves are serialized and the newest buffer uses the new revision", async () => {
	const QLab = await loadQLab();
	let scheduled = [];
	let saveCalls = [];
	let releaseFirst;
	let first = new Promise(resolve => { releaseFirst = resolve; });
	let session = QLab.createQmdDraftSession({
		path: "drafts/a.qmd",
		text: "old",
		revision: "r1",
		schedule: fn => (scheduled.push(fn), scheduled.length),
		cancel: () => {},
		onSave: async (request) => {
			saveCalls.push({ ...request });
			if (saveCalls.length === 1) {
				await first;
				return { revision: "r2" };
			}
			return { revision: "r3" };
		},
	});

	session.applyHumanEdit("first");
	let firstSave = scheduled[0]();
	session.applyHumanEdit("second");
	let secondSave = scheduled[1]();
	assert.equal(saveCalls.length, 1);
	releaseFirst();
	await Promise.all([firstSave, secondSave]);
	assert.equal(saveCalls.length, 2);
	assert.equal(saveCalls[1].text, "second");
	assert.equal(saveCalls[1].expectedRevision, "r2");
	assert.equal(session.snapshot().dirty, false);
	assert.equal(session.snapshot().revision, "r3");
});
