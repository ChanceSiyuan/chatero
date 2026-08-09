import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("repository inspection rejects wrong required types and top-level symlinks", async () => {
	const QLab = await loadQLab();
	const host = QLab.createNodeQLabPathHost(fs, path);
	const root = await mkdtemp(join(tmpdir(), "chatero-qlab-"));
	const target = await mkdtemp(join(tmpdir(), "chatero-qlab-target-"));
	try {
		await Promise.all(["knowledge", "drafts", "literature"].map(name => mkdir(join(root, name))));
		await writeFile(join(root, "AGENTS.md"), "# agents\n");
		await mkdir(join(root, "qlab"));
		assert.equal(await QLab.qlabRepositoryState(root, host), "incompatible");

		await rm(join(root, "qlab"), { recursive: true });
		await writeFile(join(root, "qlab"), "#!/bin/sh\n");
		assert.equal(await QLab.qlabRepositoryState(root, host), "ready");

		await rm(join(root, "knowledge"), { recursive: true });
		await symlink(target, join(root, "knowledge"));
		assert.equal(await QLab.qlabRepositoryState(root, host), "incompatible");
	}
	finally {
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(target, { recursive: true, force: true }),
		]);
	}
});

test("repository inspection preserves content-only trees and reports conflicts without writes", async () => {
	const QLab = await loadQLab();
	const host = QLab.createNodeQLabPathHost(fs, path);
	const root = await mkdtemp(join(tmpdir(), "chatero-qlab-"));
	try {
		await Promise.all(["knowledge", "drafts", "literature"].map(name => mkdir(join(root, name))));
		const inspection = await QLab.inspectQLabRepository(root, host);
		assert.equal(inspection.state, "partial");
		assert.deepEqual(Array.from(inspection.preserved).sort(), ["drafts", "knowledge", "literature"]);
		assert.deepEqual(Array.from(inspection.conflicts), []);
		assert.equal(Object.isFrozen(inspection), true);
		assert.equal(Object.isFrozen(inspection.preserved), true);
		assert.equal(Object.isFrozen(inspection.conflicts), true);

		await rm(join(root, "knowledge"), { recursive: true });
		await writeFile(join(root, "knowledge"), "not a content tree\n");
		assert.equal(await QLab.qlabRepositoryState(root, host), "incompatible");
		await rm(join(root, "knowledge"));
		await mkdir(join(root, "knowledge"));

		await writeFile(join(root, "README.md"), "keep me\n");
		const before = await readFile(join(root, "README.md"), "utf8");
		const conflictInspection = await QLab.inspectQLabRepository(root, host);
		assert.equal(conflictInspection.state, "incompatible");
		assert.deepEqual(Array.from(conflictInspection.conflicts), ["README.md"]);
		assert.equal(await readFile(join(root, "README.md"), "utf8"), before);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("starter marker does not make an unknown root entry resumable", async () => {
	const QLab = await loadQLab();
	const host = QLab.createNodeQLabPathHost(fs, path);
	const root = await mkdtemp(join(tmpdir(), "chatero-qlab-"));
	try {
		await mkdir(join(root, ".research-loop"));
		await writeFile(join(root, ".research-loop/starter.json"), "{}\n");
		await writeFile(join(root, "personal.txt"), "user content\n");
		const inspection = await QLab.inspectQLabRepository(root, host);
		assert.equal(inspection.state, "incompatible");
		assert.deepEqual(Array.from(inspection.conflicts), ["personal.txt"]);

		await rm(join(root, "personal.txt"));
		assert.equal(await QLab.qlabRepositoryState(root, host), "partial");
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("starter marker recognizes known bundled top-level targets while unknown targets fail closed", async () => {
	const QLab = await loadQLab();
	const host = QLab.createNodeQLabPathHost(fs, path);
	const root = await mkdtemp(join(tmpdir(), "chatero-qlab-known-partial-"));
	try {
		await mkdir(join(root, ".research-loop"));
		await writeFile(join(root, ".research-loop", "starter.json"), "{}\n");
		await writeFile(join(root, "README.md"), "public starter readme\n");
		await writeFile(join(root, "package.json"), "{}\n");
		await mkdir(join(root, "skills"));
		let inspection = await QLab.inspectQLabRepository(root, host);
		assert.equal(inspection.state, "partial");
		assert.deepEqual(Array.from(inspection.conflicts), []);

		await writeFile(join(root, "unrecognized.data"), "private unknown\n");
		inspection = await QLab.inspectQLabRepository(root, host);
		assert.equal(inspection.state, "incompatible");
		assert.deepEqual(Array.from(inspection.conflicts), ["unrecognized.data"]);
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
	assert.equal(QLab.isSafeWorkspaceRelativePath("drafts\\note.qmd", { under: "drafts" }), false);
	assert.equal(QLab.isSafeWorkspaceRelativePath("knowledge/a.qmd", { under: "drafts" }), false);
});
