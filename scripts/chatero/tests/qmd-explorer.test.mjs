import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

function flatten(nodes) {
	let out = [];
	for (let node of nodes) {
		out.push(node);
		out.push(...flatten(Array.from(node.children || [])));
	}
	return out;
}

test("Explorer marks only Draft QMD files writable and rejects symlink escapes", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-explorer-"));
	const outside = await mkdtemp(join(tmpdir(), "chatero-explorer-outside-"));
	try {
		await mkdir(join(root, "drafts", "nested"), { recursive: true });
		await mkdir(join(root, "knowledge"), { recursive: true });
		await mkdir(join(root, "literature"), { recursive: true });
		await writeFile(join(root, "drafts", "nested", "a.qmd"), "# Draft\n", "utf8");
		await writeFile(join(root, "drafts", "ignore.txt"), "ignore\n", "utf8");
		await writeFile(join(root, "knowledge", "a.qmd"), "# Knowledge\n", "utf8");
		await writeFile(join(root, "literature", "paper.qmd"), "# Evidence\n", "utf8");
		await writeFile(join(root, "literature", "notes.md"), "# Notes\n", "utf8");
		await writeFile(join(root, "literature", "ref.bib"), "@book{x}\n", "utf8");
		await writeFile(join(root, "literature", "paper.pdf"), "%PDF fixture\n", "utf8");
		await writeFile(join(outside, "private.qmd"), "# Private\n", "utf8");
		await symlink(outside, join(root, "drafts", "escape"));

		let host = QLab.createNodeQmdExplorerHost(fs, path);
		let snapshot = await QLab.buildQmdExplorerSnapshot(root, host);
		let nodes = flatten(Array.from(snapshot));
		let draft = nodes.find(node => node.path === "drafts/nested/a.qmd");
		let knowledge = nodes.find(node => node.path === "knowledge/a.qmd");
		let bibliography = nodes.find(node => node.path === "literature/ref.bib");
		let evidenceQmd = nodes.find(node => node.path === "literature/paper.qmd");
		let evidenceMarkdown = nodes.find(node => node.path === "literature/notes.md");
		let evidencePDF = nodes.find(node => node.path === "literature/paper.pdf");
		assert.equal(draft.writable, true);
		assert.equal(knowledge.writable, false);
		assert.equal(bibliography.writable, false);
		assert.equal(nodes.some(node => node.path.endsWith("ignore.txt")), false);
		assert.equal(nodes.some(node => node.path.endsWith("private.qmd")), false);
		const project = node => ({
			path: node.path,
			kind: node.kind,
			authority: node.authority,
			openMode: node.openMode,
			writable: node.writable,
		});
		assert.deepEqual(project(draft), {
			path: "drafts/nested/a.qmd", kind: "qmd", authority: "draft", openMode: "edit", writable: true,
		});
		assert.deepEqual(project(knowledge), {
			path: "knowledge/a.qmd", kind: "qmd", authority: "knowledge", openMode: "site", writable: false,
		});
		assert.deepEqual(project(evidenceQmd), {
			path: "literature/paper.qmd", kind: "qmd", authority: "literature", openMode: "readonly", writable: false,
		});
		assert.deepEqual(project(evidenceMarkdown), {
			path: "literature/notes.md", kind: "markdown", authority: "literature", openMode: "readonly", writable: false,
		});
		assert.deepEqual(project(bibliography), {
			path: "literature/ref.bib", kind: "bib", authority: "literature", openMode: "readonly", writable: false,
		});
		assert.deepEqual(project(evidencePDF), {
			path: "literature/paper.pdf", kind: "pdf", authority: "literature", openMode: "reader", writable: false,
		});
	}
	finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("Explorer stat failures never fall back to reading Knowledge or Literature contents", async () => {
	const QLab = await loadQLab();
	const root = "/repo";
	const children = new Map([
		["/repo/drafts", []],
		["/repo/knowledge", ["/repo/knowledge/topic.qmd"]],
		["/repo/literature", [
			"/repo/literature/paper.qmd",
			"/repo/literature/notes.md",
			"/repo/literature/ref.bib",
			"/repo/literature/paper.pdf",
		]],
	]);
	const reads = [];
	const host = {
		join: (...parts) => parts.join("/").replace(/\/{2,}/g, "/"),
		filename: value => value.split("/").at(-1),
		exists: async value => children.has(value),
		realPath: async value => value,
		entries: async value => {
			if (!children.has(value)) throw new Error("not a directory");
			return children.get(value);
		},
		stat: async value => {
			if (children.has(value)) return { type: "directory", size: 0, lastModified: 1 };
			throw new Error("metadata unavailable");
		},
		read: async value => {
			reads.push(value);
			throw new Error("Explorer must not read content");
		},
	};

	const snapshot = await QLab.buildQmdExplorerSnapshot(root, host);
	const readonlyFiles = flatten(Array.from(snapshot)).filter(node => (
		node.authority === "knowledge" || node.authority === "literature"
	) && node.kind !== "root" && node.kind !== "directory");
	assert.deepEqual(readonlyFiles.map(node => node.path), [
		"knowledge/topic.qmd",
		"literature/notes.md",
		"literature/paper.pdf",
		"literature/paper.qmd",
		"literature/ref.bib",
	]);
	assert.equal(readonlyFiles.every(node => node.revision === ""), true);
	assert.deepEqual(reads, []);
});

test("watcher emits only when the Explorer revision changes", async () => {
	const QLab = await loadQLab();
	let emitted = [];
	let scheduled = [];
	let snapshots = [
		[{ path: "drafts/a.qmd", revision: "a" }],
		[{ path: "drafts/a.qmd", revision: "a" }],
		[{ path: "drafts/a.qmd", revision: "b" }],
	];
	let watcher = QLab.createQmdExplorerWatcher({
		readSnapshot: async () => snapshots.shift(),
		onChange: value => emitted.push(value),
		schedule: (fn, ms) => {
			scheduled.push({ fn, ms });
			return scheduled.length;
		},
		cancel: () => {},
	});
	await watcher.poll();
	await watcher.poll();
	await watcher.poll();
	assert.equal(emitted.length, 2);
	assert.equal(scheduled[0].ms, 1000);
	watcher.setActive(false);
	await watcher.poll();
	assert.equal(scheduled.at(-1).ms, 5000);
	watcher.dispose();
});
