import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, readFile, unlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

test("QmdDraftIO lists, reads, writes with revision CAS", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts", "notes"), { recursive: true });
		await writeFile(join(root, "drafts", "notes", "a.qmd"), "# hello\n", "utf8");
		const listed = await QLab.QmdDraftIO.listDrafts(root, host);
		assert.deepEqual(JSON.parse(JSON.stringify(listed)), ["drafts/notes/a.qmd"]);

		const doc = await QLab.QmdDraftIO.readSource(root, "drafts/notes/a.qmd", host);
		assert.equal(doc.text, "# hello\n");
		assert.ok(doc.revision);

		await assert.rejects(
			() => QLab.QmdDraftIO.writeSource(
				root,
				"drafts/notes/a.qmd",
				"# changed\n",
				"stale-rev",
				host
			),
			/revision changed/i
		);

		const saved = await QLab.QmdDraftIO.writeSource(
			root,
			"drafts/notes/a.qmd",
			"# changed\n",
			doc.revision,
			host
		);
		assert.equal(await readFile(join(root, "drafts", "notes", "a.qmd"), "utf8"), "# changed\n");
		assert.ok(saved.revision);
		assert.notEqual(saved.revision, doc.revision);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("QmdDraftIO serializes concurrent CAS writes so one stale writer loses", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-cas-race-"));
	const baseHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	const target = join(root, "drafts", "note.qmd");
	const host = {
		...baseHost,
		async read(filePath) {
			const value = await baseHost.read(filePath);
			if (filePath === target) {
				await delay(30);
			}
			return value;
		},
	};
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(target, "original\n", "utf8");
		const revision = (await QLab.QmdDraftIO.readSource(root, "drafts/note.qmd", baseHost)).revision;

		const results = await Promise.allSettled([
			QLab.QmdDraftIO.writeSource(root, "drafts/note.qmd", "writer A\n", revision, host),
			QLab.QmdDraftIO.writeSource(root, "drafts/note.qmd", "writer B\n", revision, host),
		]);

		assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
		assert.equal(results.filter(result => result.status === "rejected").length, 1);
		assert.match(String(results.find(result => result.status === "rejected").reason), /revision changed/i);
		assert.ok(["writer A\n", "writer B\n"].includes(await readFile(target, "utf8")));
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("QmdDraftIO writeNew creates a file once without overwriting its first writer", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-write-new-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	const target = join(root, "new.qmd");
	try {
		await host.writeNew(target, "first\n");
		await assert.rejects(
			host.writeNew(target, "second\n"),
			error => error && error.code === "EEXIST",
		);
		assert.equal(await readFile(target, "utf8"), "first\n");
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("QmdDraftIO uses a strong revision while accepting legacy 32-bit CAS tokens", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-revision-v2-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "costarring", "utf8");

		assert.notEqual(QLab.QmdDraftIO._hash("costarring"), QLab.QmdDraftIO._hash("liquid"));
		assert.match(QLab.QmdDraftIO._hash("costarring"), /^v2-[0-9a-f]{32}$/);
		const saved = await QLab.QmdDraftIO.writeSource(
			root,
			"drafts/note.qmd",
			"updated\n",
			"5e4daa9d",
			host,
		);
		assert.match(saved.revision, /^v2-[0-9a-f]{32}$/);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), "updated\n");

		await writeFile(join(root, "drafts", "note.qmd"), "68", "utf8");
		await QLab.QmdDraftIO.writeSource(
			root,
			"drafts/note.qmd",
			"legacy short token accepted\n",
			"de8d5a3",
			host,
		);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("QmdDraftIO rejects Draft file and ancestor symlinks but accepts a symlinked repository root", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-drafts-link-"));
	const outside = await mkdtemp(join(tmpdir(), "chatero-qmd-private-"));
	const rootEntry = `${root}-entry`;
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts", "nested"), { recursive: true });
		await writeFile(join(root, "drafts", "safe.qmd"), "safe\n", "utf8");
		await writeFile(join(outside, "private.qmd"), "private\n", "utf8");
		await symlink(root, rootEntry);
		assert.deepEqual(
			JSON.parse(JSON.stringify(await QLab.QmdDraftIO.listDrafts(rootEntry, host))),
			["drafts/safe.qmd"],
		);
		assert.equal((await QLab.QmdDraftIO.readSource(rootEntry, "drafts/safe.qmd", host)).text, "safe\n");

		await symlink(join(outside, "private.qmd"), join(root, "drafts", "linked.qmd"));
		await assert.rejects(QLab.QmdDraftIO.listDrafts(root, host), /symbolic link|outside drafts/i);
		await assert.rejects(QLab.QmdDraftIO.readSource(root, "drafts/linked.qmd", host), /symbolic link|outside drafts/i);
		await assert.rejects(QLab.QmdDraftIO.writeSource(root, "drafts/linked.qmd", "changed\n", null, host), /symbolic link|outside drafts/i);
		assert.equal(await readFile(join(outside, "private.qmd"), "utf8"), "private\n");

		await rm(join(root, "drafts", "linked.qmd"), { force: true });
		await rm(join(root, "drafts", "nested"), { recursive: true, force: true });
		await mkdir(join(outside, "subdir"), { recursive: true });
		await writeFile(join(outside, "subdir", "escaped.qmd"), "private\n", "utf8");
		await symlink(join(outside, "subdir"), join(root, "drafts", "nested"));
		await assert.rejects(QLab.QmdDraftIO.listDrafts(root, host), /symbolic link|outside drafts/i);
		await assert.rejects(QLab.QmdDraftIO.readSource(root, "drafts/nested/escaped.qmd", host), /symbolic link|outside drafts/i);
	}
	finally {
		await rm(rootEntry, { force: true });
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("QmdDraftIO validates the private proposal root before copying Draft content", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-proposal-root-link-"));
	const outside = await mkdtemp(join(tmpdir(), "chatero-qmd-proposal-outside-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await mkdir(join(root, "work", "qlab-zotero"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "private Draft text\n", "utf8");
		await symlink(outside, join(root, "work", "qlab-zotero", "draft-changes"));

		await assert.rejects(
			QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host),
			/symbolic link|outside its allowed directory/i,
		);
		assert.deepEqual(await fs.readdir(outside), []);
	}
	finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("QmdDraftIO creates each private parent safely and never follows work parent symlinks", async () => {
	const QLab = await loadQLab();
	for (const linkedParent of ["work", "work/qlab-zotero"]) {
		const root = await mkdtemp(join(tmpdir(), "chatero-qmd-parent-link-"));
		const outside = await mkdtemp(join(tmpdir(), "chatero-qmd-parent-outside-"));
		const host = QLab.QmdDraftIO.createNodeHost(fs, path);
		try {
			await mkdir(join(root, "drafts"), { recursive: true });
			await writeFile(join(root, "drafts", "note.qmd"), "private Draft text\n", "utf8");
			if (linkedParent === "work/qlab-zotero") {
				await mkdir(join(root, "work"));
			}
			await symlink(outside, join(root, linkedParent));

			await assert.rejects(
				QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host),
				/symbolic link|outside its allowed directory/i,
			);
			assert.deepEqual(await fs.readdir(outside), []);
		}
		finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	}
});

test("QmdDraftIO prepareChange + Keep promotes working copy only", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-keep-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "original\n", "utf8");

		const prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		assert.match(prepared.workingPath, /^work\/qlab-zotero\/draft-changes\//);
		assert.equal(prepared.text, "original\n");
		assert.equal(prepared.proposalRevision, QLab.QmdDraftIO._hash("original\n"));

		await host.write(join(root, prepared.workingPath), "ai edit\n");
		const kept = await QLab.QmdDraftIO.keepChange(root, {
			originalPath: prepared.originalPath,
			workingPath: prepared.workingPath,
			revision: prepared.revision,
		}, host);
		assert.equal(kept.kept, true);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), "ai edit\n");
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("QmdDraftIO resumes the one cumulative AI proposal instead of replacing it", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-resume-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "original\n", "utf8");
		const first = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		await host.write(join(root, first.workingPath), "first AI version\n");

		const resumed = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		assert.equal(resumed.workingPath, first.workingPath);
		assert.equal(resumed.basePath, first.basePath);
		assert.equal(resumed.text, "first AI version\n");
		assert.equal(resumed.proposalRevision, QLab.QmdDraftIO._hash("first AI version\n"));
		assert.equal(resumed.baseText, "original\n");
		assert.equal(resumed.resumed, true);
		assert.equal(await readFile(join(root, first.workingPath), "utf8"), "first AI version\n");
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Keep serializes with proposal CAS so it cannot delete a newer AI version", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-keep-cas-race-"));
	const baseHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	const originalPath = join(root, "drafts", "note.qmd");
	const keepWriteStarted = deferred();
	const allowKeepWrite = deferred();
	let blockOriginalWrite = false;
	const host = {
		...baseHost,
		async write(filePath, text) {
			if (blockOriginalWrite && filePath === originalPath) {
				keepWriteStarted.resolve();
				await allowKeepWrite.promise;
			}
			return baseHost.write(filePath, text);
		},
	};
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(originalPath, "original\n", "utf8");
		const prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		const proposal = await QLab.QmdDraftIO.readSource(root, prepared.workingPath, host);
		await QLab.QmdDraftIO.writeProposal(
			root,
			prepared,
			"first AI version\n",
			proposal.revision,
			host,
		);
		const firstVersion = await QLab.QmdDraftIO.readSource(root, prepared.workingPath, host);

		blockOriginalWrite = true;
		const keepPromise = QLab.QmdDraftIO.keepChange(root, prepared, host);
		await keepWriteStarted.promise;
		const newerWritePromise = QLab.QmdDraftIO.writeProposal(
			root,
			prepared,
			"second AI version\n",
			firstVersion.revision,
			host,
		);
		await delay(20);
		allowKeepWrite.resolve();

		const [keepOutcome, newerWriteOutcome] = await Promise.allSettled([
			keepPromise,
			newerWritePromise,
		]);
		assert.equal(keepOutcome.status, "fulfilled");
		assert.equal(keepOutcome.value.kept, true);
		assert.equal(newerWriteOutcome.status, "rejected");
		assert.match(String(newerWriteOutcome.reason), /proposal|generation|no longer|ENOENT/i);
		assert.equal(await readFile(originalPath, "utf8"), "first AI version\n");
		assert.equal(await QLab.QmdDraftIO.findProposal(root, "drafts/note.qmd", host), null);
	}
	finally {
		allowKeepWrite.resolve();
		await rm(root, { recursive: true, force: true });
	}
});

test("Reject serializes with prepareChange so a newly attached proposal survives", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-reject-attach-race-"));
	const baseHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	const removeStarted = deferred();
	const allowRemove = deferred();
	let rejectedDirectory = "";
	const host = {
		...baseHost,
		async remove(filePath, options) {
			if (filePath === rejectedDirectory) {
				removeStarted.resolve();
				await allowRemove.promise;
			}
			return baseHost.remove(filePath, options);
		},
	};
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "original\n", "utf8");
		const first = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		rejectedDirectory = join(root, first.workingPath.replace(/\/draft\.qmd$/, ""));

		const rejectPromise = QLab.QmdDraftIO.rejectChange(root, first, host);
		await removeStarted.promise;
		const attachPromise = QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		await delay(20);
		allowRemove.resolve();
		const [rejected, attached] = await Promise.all([rejectPromise, attachPromise]);

		assert.equal(rejected.rejected, true);
		assert.notEqual(attached.generation, first.generation);
		assert.notEqual(attached.workingPath, first.workingPath);
		assert.equal(await baseHost.exists(join(root, attached.workingPath)), true);
		const found = await QLab.QmdDraftIO.findProposal(root, "drafts/note.qmd", host);
		assert.equal(found.generation, attached.generation);
		assert.equal(found.workingPath, attached.workingPath);
	}
	finally {
		allowRemove.resolve();
		await rm(root, { recursive: true, force: true });
	}
});

test("proposal operations reject a stale generation without changing the attached proposal", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-generation-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "original\n", "utf8");
		const prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		assert.match(prepared.generation, /^[0-9a-f]{32}$/);
		const stale = { ...prepared, generation: `${prepared.generation}-stale` };
		const working = await QLab.QmdDraftIO.readSource(root, prepared.workingPath, host);

		await assert.rejects(
			QLab.QmdDraftIO.writeProposal(root, stale, "stale write\n", working.revision, host),
			/generation|review state|proposal/i,
		);
		await assert.rejects(
			QLab.QmdDraftIO.keepChange(root, stale, host),
			/generation|review state|proposal/i,
		);
		await assert.rejects(
			QLab.QmdDraftIO.rejectChange(root, stale, host),
			/generation|review state|proposal/i,
		);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), "original\n");
		assert.ok(await QLab.QmdDraftIO.findProposal(root, "drafts/note.qmd", host));
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("QmdDraftIO serializes concurrent prepareChange calls into one proposal", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-prepare-race-"));
	const baseHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	const changesRoot = join(root, "work", "qlab-zotero", "draft-changes");
	let initialLookups = 0;
	const host = {
		...baseHost,
		async exists(filePath) {
			if (filePath === changesRoot && initialLookups < 2) {
				initialLookups += 1;
				await delay(30);
				return false;
			}
			return baseHost.exists(filePath);
		},
	};
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "original\n", "utf8");

		const firstPromise = QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		await delay(5);
		const secondPromise = QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		const [first, second] = await Promise.all([firstPromise, secondPromise]);

		assert.equal(second.workingPath, first.workingPath);
		assert.equal(second.basePath, first.basePath);
		assert.equal((await fs.readdir(changesRoot)).length, 1);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("QmdDraftIO safely shares private parent creation across different Drafts", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-parent-race-"));
	const baseHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	const workRoot = join(root, "work");
	let initialLookups = 0;
	const host = {
		...baseHost,
		async exists(filePath) {
			if (filePath === workRoot && initialLookups < 2) {
				initialLookups += 1;
				await delay(30);
				return false;
			}
			return baseHost.exists(filePath);
		},
	};
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "a.qmd"), "A\n", "utf8");
		await writeFile(join(root, "drafts", "b.qmd"), "B\n", "utf8");

		const outcomes = await Promise.allSettled([
			QLab.QmdDraftIO.prepareChange(root, "drafts/a.qmd", host),
			QLab.QmdDraftIO.prepareChange(root, "drafts/b.qmd", host),
		]);

		assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 2);
		const results = outcomes.map(outcome => outcome.value);
		assert.notEqual(results[0].workingPath, results[1].workingPath);
		assert.equal((await fs.readdir(join(root, "work", "qlab-zotero", "draft-changes"))).length, 2);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("QmdDraftIO reads and clears only the guarded TODO completion artifact", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-todo-artifact-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await mkdir(join(root, "knowledge"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "[todo: x]\n", "utf8");
		await writeFile(join(root, "knowledge", "private.md"), "private\n", "utf8");
		const prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		const run = await QLab.QmdDraftIO.prepareTodoCompletionRun(
			root,
			prepared,
			prepared.text,
			host,
		);
		assert.equal(await readFile(join(root, run.inputPath), "utf8"), prepared.text);
		assert.match(run.directory, /\/todo-action\/[a-z0-9-]+$/);
		await writeFile(join(root, run.outputPath), '{"version":1,"completions":[]}', "utf8");
		assert.equal(
			await QLab.QmdDraftIO.readTodoCompletions(root, run, host),
			'{"version":1,"completions":[]}',
		);
		await QLab.QmdDraftIO.clearTodoCompletions(root, run, host);
		assert.equal(await host.exists(join(root, run.directory)), false);

		const second = await QLab.QmdDraftIO.prepareTodoCompletionRun(
			root,
			prepared,
			prepared.text,
			host,
		);
		await symlink(join(root, "knowledge", "private.md"), join(root, second.outputPath));
		await assert.rejects(
			QLab.QmdDraftIO.readTodoCompletions(root, second, host),
			/symbolic link|private Draft proposal/i,
		);
		await QLab.QmdDraftIO.clearTodoCompletions(root, second, host);
		assert.equal(await readFile(join(root, "knowledge", "private.md"), "utf8"), "private\n");
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("QmdDraftIO isolates concurrent TODO runs and clearing one leaves the other intact", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-todo-race-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "[todo: x]\n", "utf8");
		const prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		const [first, second] = await Promise.all([
			QLab.QmdDraftIO.prepareTodoCompletionRun(root, prepared, "first input\n", host),
			QLab.QmdDraftIO.prepareTodoCompletionRun(root, prepared, "second input\n", host),
		]);

		assert.notEqual(first.directory, second.directory);
		assert.equal(await readFile(join(root, first.inputPath), "utf8"), "first input\n");
		assert.equal(await readFile(join(root, second.inputPath), "utf8"), "second input\n");
		await writeFile(join(root, first.outputPath), '{"run":"first"}', "utf8");
		await writeFile(join(root, second.outputPath), '{"run":"second"}', "utf8");
		assert.equal(await QLab.QmdDraftIO.readTodoCompletions(root, first, host), '{"run":"first"}');
		assert.equal(await QLab.QmdDraftIO.readTodoCompletions(root, second, host), '{"run":"second"}');

		await QLab.QmdDraftIO.clearTodoCompletions(root, first, host);
		assert.equal(await host.exists(join(root, first.directory)), false);
		assert.equal(await QLab.QmdDraftIO.readTodoCompletions(root, second, host), '{"run":"second"}');
		await QLab.QmdDraftIO.clearTodoCompletions(root, second, host);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("QmdDraftIO rejects a proposal draft symlink before read, restore, or Keep", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-symlink-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "original\n", "utf8");
		const prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		const working = join(root, prepared.workingPath);
		await unlink(working);
		await symlink(join(root, "drafts", "note.qmd"), working);

		await assert.rejects(
			QLab.QmdDraftIO.readSource(root, prepared.workingPath, host),
			/symbolic link|private Draft proposal/i,
		);
		await assert.rejects(
			QLab.QmdDraftIO.writeSource(root, prepared.workingPath, "restore\n", null, host),
			/symbolic link|private Draft proposal/i,
		);
		await assert.rejects(
			QLab.QmdDraftIO.keepChange(root, prepared, host),
			/symbolic link|private Draft proposal/i,
		);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), "original\n");
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("QmdDraftIO ignores tampered proposal manifests and rejects a symlinked base on Keep", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-manifest-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await mkdir(join(root, "knowledge"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "original\n", "utf8");
		await writeFile(join(root, "knowledge", "private.md"), "private\n", "utf8");
		let prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		let manifestPath = join(root, prepared.workingPath.replace(/\/draft\.qmd$/, ""), "manifest.json");
		let manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		manifest.workingPath = "knowledge/private.md";
		manifest.basePath = "knowledge/private.md";
		await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
		assert.equal(await QLab.QmdDraftIO.findProposal(root, "drafts/note.qmd", host), null);

		prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		manifestPath = join(root, prepared.workingPath.replace(/\/draft\.qmd$/, ""), "manifest.json");
		manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		manifest.workingPath = "../drafts/note.qmd";
		await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
		assert.equal(await QLab.QmdDraftIO.findProposal(root, "drafts/note.qmd", host), null);

		prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		await rm(join(root, prepared.basePath), { force: true });
		await symlink(join(root, "knowledge", "private.md"), join(root, prepared.basePath));
		assert.equal(await QLab.QmdDraftIO.findProposal(root, "drafts/note.qmd", host), null);
		await assert.rejects(QLab.QmdDraftIO.keepChange(root, prepared, host), /symbolic link|private Draft proposal/i);
		assert.equal(await readFile(join(root, "knowledge", "private.md"), "utf8"), "private\n");
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Keep rejects modified base content or manifest identity without overwriting the human Draft", async () => {
	const QLab = await loadQLab();
	for (const tamper of ["base", "baseRevision", "revision", "originalPath"]) {
		const root = await mkdtemp(join(tmpdir(), "chatero-qmd-keep-integrity-"));
		const host = QLab.QmdDraftIO.createNodeHost(fs, path);
		try {
			await mkdir(join(root, "drafts"), { recursive: true });
			await writeFile(join(root, "drafts", "note.qmd"), "original\n", "utf8");
			const prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
			await writeFile(join(root, prepared.workingPath), "AI proposal\n", "utf8");
			const manifestPath = join(root, prepared.workingPath.replace(/\/draft\.qmd$/, "/manifest.json"));
			if (tamper === "base") {
				await writeFile(join(root, prepared.basePath), "tampered base\n", "utf8");
			}
			else {
				const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
				manifest[tamper] = tamper === "originalPath" ? "drafts/other.qmd" : "tampered-revision";
				await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
			}

			await assert.rejects(
				QLab.QmdDraftIO.keepChange(root, prepared, host),
				/integrity|manifest|base|revision|proposal/i,
			);
			assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), "original\n");
		}
		finally {
			await rm(root, { recursive: true, force: true });
		}
	}
});

test("Keep accepts an intact legacy manifest revision for an existing proposal", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-legacy-proposal-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "original\n", "utf8");
		const prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		const manifestPath = join(root, prepared.workingPath.replace(/\/draft\.qmd$/, "/manifest.json"));
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		manifest.baseRevision = "c78c8de8";
		manifest.revision = "c78c8de8";
		await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
		await writeFile(join(root, prepared.workingPath), "AI proposal\n", "utf8");

		const kept = await QLab.QmdDraftIO.keepChange(root, {
			...prepared,
			revision: "c78c8de8",
		}, host);
		assert.equal(kept.kept, true);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), "AI proposal\n");
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("qmd shell HTML exposes draft controls and Keep", async () => {
	const QLab = await loadQLab();
	const html = QLab.renderShellHTML({
		kind: "qlabqmd",
		workspaceState: "ready",
		root: "/tmp/ws",
		drafts: ["drafts/a.qmd"],
	});
	assert.match(html, /data-qlab-draft/);
	assert.match(html, /data-qlab-draft-ai/);
	assert.match(html, /data-qlab-draft-keep/);
	assert.match(html, /data-qlab-editor/);
	assert.match(html, /drafts\/a\.qmd/);
});

test("DraftWorkingCopy accepts string revision hashes", async () => {
	const QLab = await loadQLab();
	const plan = QLab.DraftWorkingCopy.buildKeepPlan({
		originalPath: "drafts/note.qmd",
		workingPath: "work/qlab-zotero/draft-changes/t/draft.qmd",
		revision: "abc123",
	});
	assert.equal(plan.expectedRevision, "abc123");
});

test("latest AI proposal is discoverable, rebased on Keep, and then cleared", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-rebase-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "title\nold theorem\nend\n", "utf8");
		const prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		assert.equal(await readFile(join(root, prepared.basePath), "utf8"), prepared.text);
		await host.write(join(root, prepared.workingPath), "title\nnew theorem\nend\n");
		await writeFile(join(root, "drafts", "note.qmd"), "new title\nold theorem\nend\n", "utf8");

		let found = await QLab.QmdDraftIO.findProposal(root, "drafts/note.qmd", host);
		assert.equal(found.workingPath, prepared.workingPath);
		let kept = await QLab.QmdDraftIO.keepChange(root, found, host);
		assert.equal(kept.kept, true);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), "new title\nnew theorem\nend\n");
		assert.equal(await QLab.QmdDraftIO.findProposal(root, "drafts/note.qmd", host), null);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Reject removes only the AI proposal and never changes the Draft", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-reject-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "original\n", "utf8");
		const prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		await host.write(join(root, prepared.workingPath), "proposal\n");
		let rejected = await QLab.QmdDraftIO.rejectChange(root, prepared, host);
		assert.equal(rejected.rejected, true);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), "original\n");
		assert.equal(await QLab.QmdDraftIO.findProposal(root, "drafts/note.qmd", host), null);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Keep reports a three-way conflict without overwriting human edits", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-conflict-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "claim\n", "utf8");
		const prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", host);
		await host.write(join(root, prepared.workingPath), "AI claim\n");
		await writeFile(join(root, "drafts", "note.qmd"), "human claim\n", "utf8");

		let kept = await QLab.QmdDraftIO.keepChange(root, prepared, host);
		assert.equal(kept.kept, false);
		assert.equal(kept.conflict, true);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), "human claim\n");
		assert.ok(await QLab.QmdDraftIO.findProposal(root, "drafts/note.qmd", host));
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});
