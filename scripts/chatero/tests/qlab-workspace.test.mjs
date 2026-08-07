import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadQLab } from "../lib/load-qlab.mjs";

test("qlabRepositoryState classifies empty / partial / ready / incompatible", async () => {
	const QLab = await loadQLab();
	const host = QLab.createNodeQLabPathHost(fs, path);
	const root = await mkdtemp(join(tmpdir(), "chatero-qlab-"));
	try {
		assert.equal(await QLab.qlabRepositoryState(root, host), "empty");

		await mkdir(join(root, "knowledge"));
		await mkdir(join(root, "drafts"));
		await mkdir(join(root, "literature"));
		assert.equal(await QLab.qlabRepositoryState(root, host), "partial");

		await writeFile(join(root, "AGENTS.md"), "# agents\n");
		await writeFile(join(root, "qlab"), "stub\n");
		assert.equal(await QLab.qlabRepositoryState(root, host), "ready");

		const other = await mkdtemp(join(tmpdir(), "chatero-qlab-other-"));
		try {
			await writeFile(join(other, "README.md"), "nope\n");
			assert.equal(await QLab.qlabRepositoryState(other, host), "incompatible");
		}
		finally {
			await rm(other, { recursive: true, force: true });
		}
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("agent writable paths reject knowledge and traversal", async () => {
	const QLab = await loadQLab();
	assert.equal(QLab.isAgentWritableRelativePath("drafts/a.qmd"), true);
	assert.equal(QLab.isAgentWritableRelativePath("literature/x.pdf"), true);
	assert.equal(QLab.isAgentWritableRelativePath("work/tmp"), true);
	assert.equal(QLab.isAgentWritableRelativePath("knowledge/a.qmd"), false);
	assert.equal(QLab.isAgentWritableRelativePath("drafts/../knowledge/a.qmd"), false);
	assert.equal(QLab.isSafeWorkspaceRelativePath("drafts/note.qmd", { under: "drafts" }), true);
	assert.equal(QLab.isSafeWorkspaceRelativePath("knowledge/a.qmd", { under: "drafts" }), false);
});
