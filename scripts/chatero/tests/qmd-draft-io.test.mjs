import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

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
