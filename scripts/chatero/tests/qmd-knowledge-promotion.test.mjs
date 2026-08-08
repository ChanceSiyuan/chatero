import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("human promotion copies a Draft to a new Knowledge path without deleting the Draft", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-promote-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts", "topic"), { recursive: true });
		await mkdir(join(root, "knowledge"), { recursive: true });
		await mkdir(join(root, "literature"), { recursive: true });
		await writeFile(join(root, "literature", "ref.bib"), "", "utf8");
		const source = "---\ntitle: Note\ndescription: tbc\ncategories: [theory]\n---\n\n# Note\n";
		await writeFile(join(root, "drafts", "topic", "note.qmd"), source, "utf8");
		const result = await QLab.promoteDraftToKnowledge({
			root,
			draftPath: "drafts/topic/note.qmd",
			host,
		});
		assert.equal(result.to, "knowledge/topic/note.qmd");
		assert.equal(await readFile(join(root, result.to), "utf8"), source);
		assert.equal(await readFile(join(root, "drafts", "topic", "note.qmd"), "utf8"), source);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("human promotion never overwrites existing trusted Knowledge", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-promote-existing-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await mkdir(join(root, "knowledge"), { recursive: true });
		await mkdir(join(root, "literature"), { recursive: true });
		await writeFile(join(root, "literature", "ref.bib"), "", "utf8");
		await writeFile(join(root, "drafts", "note.qmd"), "---\ntitle: Note\ndescription: tbc\ncategories: [theory]\n---\n", "utf8");
		await writeFile(join(root, "knowledge", "note.qmd"), "trusted\n", "utf8");
		await assert.rejects(
			QLab.promoteDraftToKnowledge({ root, draftPath: "drafts/note.qmd", host }),
			/already exists|not overwritten/i,
		);
		assert.equal(await readFile(join(root, "knowledge", "note.qmd"), "utf8"), "trusted\n");
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("human promotion rejects a symlinked Knowledge parent without touching its target", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-promote-link-"));
	const outside = await mkdtemp(join(tmpdir(), "chatero-qmd-promote-outside-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await mkdir(join(root, "knowledge"), { recursive: true });
		await mkdir(join(root, "literature"), { recursive: true });
		await writeFile(join(root, "literature", "ref.bib"), "", "utf8");
		await writeFile(join(root, "drafts", "note.qmd"), "---\ntitle: Note\ndescription: tbc\ncategories: [theory]\n---\n", "utf8");
		await symlink(outside, join(root, "knowledge", "escaped"));
		await assert.rejects(
			QLab.promoteDraftToKnowledge({
				root,
				draftPath: "drafts/note.qmd",
				knowledgePath: "knowledge/escaped/note.qmd",
				host,
			}),
			/symbolic link|outside its allowed directory/i,
		);
		assert.deepEqual(await fs.readdir(outside), []);
	}
	finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("human promotion never follows a dangling Knowledge file symlink outside the workspace", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-promote-file-link-"));
	const outside = await mkdtemp(join(tmpdir(), "chatero-qmd-promote-file-outside-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	const outsideTarget = join(outside, "note.qmd");
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await mkdir(join(root, "knowledge"), { recursive: true });
		await mkdir(join(root, "literature"), { recursive: true });
		await writeFile(join(root, "literature", "ref.bib"), "", "utf8");
		await writeFile(
			join(root, "drafts", "note.qmd"),
			"---\ntitle: Note\ndescription: tbc\ncategories: [theory]\n---\n",
			"utf8",
		);
		await symlink(outsideTarget, join(root, "knowledge", "note.qmd"));

		await assert.rejects(
			QLab.promoteDraftToKnowledge({ root, draftPath: "drafts/note.qmd", host }),
			/already exists|symbolic link|not overwritten/i,
		);
		assert.equal(await host.exists(outsideTarget), false);
	}
	finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("concurrent human promotions atomically create one trusted Knowledge file", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-promote-concurrent-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	const target = join(root, "knowledge", "published.qmd");
	const ordinaryExists = host.exists;
	let targetChecks = 0;
	let releaseTargetChecks;
	const bothChecked = new Promise(resolve => { releaseTargetChecks = resolve; });
	host.exists = async candidate => {
		if (candidate !== target) return ordinaryExists(candidate);
		targetChecks++;
		if (targetChecks === 2) releaseTargetChecks();
		await bothChecked;
		return false;
	};
	host.writeNew = (candidate, text) => fs.writeFile(candidate, text, {
		encoding: "utf8",
		flag: "wx",
	});
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await mkdir(join(root, "knowledge"), { recursive: true });
		await mkdir(join(root, "literature"), { recursive: true });
		await writeFile(join(root, "literature", "ref.bib"), "", "utf8");
		const first = "---\ntitle: First\ndescription: tbc\ncategories: [theory]\n---\n\nFirst.\n";
		const second = "---\ntitle: Second\ndescription: tbc\ncategories: [theory]\n---\n\nSecond.\n";
		await writeFile(join(root, "drafts", "first.qmd"), first, "utf8");
		await writeFile(join(root, "drafts", "second.qmd"), second, "utf8");

		const results = await Promise.allSettled([
			QLab.promoteDraftToKnowledge({
				root,
				draftPath: "drafts/first.qmd",
				knowledgePath: "knowledge/published.qmd",
				host,
			}),
			QLab.promoteDraftToKnowledge({
				root,
				draftPath: "drafts/second.qmd",
				knowledgePath: "knowledge/published.qmd",
				host,
			}),
		]);

		assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
		assert.equal(results.filter(result => result.status === "rejected").length, 1);
		assert.ok([first, second].includes(await readFile(target, "utf8")));
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("human promotion refuses a Draft that does not satisfy the trusted Knowledge contract", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-promote-invalid-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await mkdir(join(root, "knowledge"), { recursive: true });
		await mkdir(join(root, "literature"), { recursive: true });
		await writeFile(join(root, "literature", "ref.bib"), "", "utf8");
		await writeFile(join(root, "drafts", "invalid.qmd"), "# Missing frontmatter\n", "utf8");
		await assert.rejects(
			QLab.promoteDraftToKnowledge({ root, draftPath: "drafts/invalid.qmd", host }),
			/compliance|trusted Knowledge contract/i,
		);
		assert.equal(await host.exists(join(root, "knowledge", "invalid.qmd")), false);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("review-and-promote waits for read-only AI review and explicit human approval", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-review-promote-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	const draftPath = "drafts/topic/note.qmd";
	const source = "---\ntitle: Note\ndescription: tbc\ncategories: [theory]\n---\n\n# Note\n";
	const events = [];
	try {
		await mkdir(join(root, "drafts", "topic"), { recursive: true });
		await mkdir(join(root, "knowledge"), { recursive: true });
		await mkdir(join(root, "literature"), { recursive: true });
		await writeFile(join(root, "literature", "ref.bib"), "", "utf8");
		await writeFile(join(root, draftPath), source, "utf8");
		const result = await QLab.reviewAndPromoteDraft({
			root,
			draftPath,
			host,
			review: async context => {
				events.push(["review", context.draftPath, context.knowledgePath]);
				return { status: "completed" };
			},
			confirm: async context => {
				events.push(["confirm", context.draftPath, context.knowledgePath]);
				return true;
			},
		});
		assert.equal(result.promoted, true);
		assert.deepEqual(events, [
			["review", draftPath, "knowledge/topic/note.qmd"],
			["confirm", draftPath, "knowledge/topic/note.qmd"],
		]);
		assert.equal(await readFile(join(root, result.to), "utf8"), source);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("review-and-promote leaves Knowledge unchanged when the human declines", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-review-decline-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await mkdir(join(root, "knowledge"), { recursive: true });
		await mkdir(join(root, "literature"), { recursive: true });
		await writeFile(join(root, "literature", "ref.bib"), "", "utf8");
		await writeFile(
			join(root, "drafts", "note.qmd"),
			"---\ntitle: Note\ndescription: tbc\ncategories: [theory]\n---\n",
			"utf8",
		);
		const result = await QLab.reviewAndPromoteDraft({
			root,
			draftPath: "drafts/note.qmd",
			host,
			review: async () => ({ status: "completed" }),
			confirm: async () => false,
		});
		assert.deepEqual(JSON.parse(JSON.stringify(result)), {
			promoted: false,
			status: "declined",
			from: "drafts/note.qmd",
			to: "knowledge/note.qmd",
		});
		assert.equal(await host.exists(join(root, "knowledge", "note.qmd")), false);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("review-and-promote refuses to publish a Draft changed during AI review", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-review-race-"));
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	const draftPath = "drafts/note.qmd";
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await mkdir(join(root, "knowledge"), { recursive: true });
		await mkdir(join(root, "literature"), { recursive: true });
		await writeFile(join(root, "literature", "ref.bib"), "", "utf8");
		await writeFile(
			join(root, draftPath),
			"---\ntitle: Note\ndescription: tbc\ncategories: [theory]\n---\n",
			"utf8",
		);
		await assert.rejects(
			QLab.reviewAndPromoteDraft({
				root,
				draftPath,
				host,
				review: async () => {
					await writeFile(join(root, draftPath), "changed while reviewing\n", "utf8");
					return { status: "completed" };
				},
				confirm: async () => true,
			}),
			/changed during AI review/i,
		);
		assert.equal(await host.exists(join(root, "knowledge", "note.qmd")), false);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});
