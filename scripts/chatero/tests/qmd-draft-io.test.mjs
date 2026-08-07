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
