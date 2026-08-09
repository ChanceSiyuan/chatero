import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

function canonicalManifestDigest(entries) {
	const canonicalEntries = entries
		.map(entry => ({
			path: entry.path,
			kind: entry.kind,
			mode: entry.mode,
			...(entry.kind === "file" ? { digest: entry.digest } : {}),
		}))
		.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
	return createHash("sha256")
		.update(JSON.stringify({ schemaVersion: 1, entries: canonicalEntries }))
		.digest("hex");
}

function validManifest(entries = [
	{ path: "AGENTS.md", kind: "file", mode: "0644", digest: DIGEST_A },
	{ path: "qlab", kind: "file", mode: "0755", digest: DIGEST_B },
	{ path: "drafts/index.qmd", kind: "file", mode: "0644", digest: DIGEST_C },
]) {
	return { schemaVersion: 1, digest: canonicalManifestDigest(entries), entries };
}

test("starter manifest accepts only immutable, safe file and directory records", async () => {
	const QLab = await loadQLab();
	const manifest = QLab.validateQLabStarterManifest(validManifest([
		{ path: "AGENTS.md", kind: "file", mode: "0644", digest: DIGEST_A },
		{ path: "drafts", kind: "directory", mode: "0755" },
	]));
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(Object.isFrozen(manifest), true);
	assert.equal(Object.isFrozen(manifest.entries), true);
	assert.equal(Object.isFrozen(manifest.entries[0]), true);

	assert.throws(() => QLab.validateQLabStarterManifest({ ...validManifest(), digest: DIGEST_A.toUpperCase() }), /digest/);
	assert.throws(() => QLab.validateQLabStarterManifest(validManifest([
		{ path: "AGENTS.md", kind: "file", mode: "0644", digest: DIGEST_A },
		{ path: "agents.md", kind: "file", mode: "0644", digest: DIGEST_B },
	])), /duplicate/);
	assert.throws(() => QLab.validateQLabStarterManifest(validManifest([
		{ path: "drafts/file.qmd", kind: "file", mode: "0644", digest: DIGEST_A },
		{ path: "drafts", kind: "file", mode: "0644", digest: DIGEST_B },
	])), /file target is a parent/);
	assert.throws(() => QLab.validateQLabStarterManifest(validManifest([
		{ path: "../escape", kind: "file", mode: "0644", digest: DIGEST_A },
	])), /path/);
	assert.throws(() => QLab.validateQLabStarterManifest(validManifest([
		{ path: "drafts/-option.qmd", kind: "file", mode: "0644", digest: DIGEST_A },
	])), /path/);
	assert.throws(() => QLab.validateQLabStarterManifest(validManifest([
		{ path: "drafts\\index.qmd", kind: "file", mode: "0644", digest: DIGEST_A },
	])), /path/);
	assert.throws(() => QLab.validateQLabStarterManifest(validManifest([
		{ path: "drafts", kind: "symlink", mode: "0755" },
	])), /kind/);
	assert.throws(() => QLab.validateQLabStarterManifest(validManifest([
		{ path: "AGENTS.md", kind: "file", mode: "0777", digest: DIGEST_A },
	])), /mode/);
});

test("starter manifest rejects every stale canonical digest field", async () => {
	const QLab = await loadQLab();
	const base = validManifest([
		{ path: "AGENTS.md", kind: "file", mode: "0644", digest: DIGEST_A },
		{ path: "drafts", kind: "directory", mode: "0755" },
	]);
	for (const mutate of [
		manifest => ({ ...manifest, entries: [{ ...manifest.entries[0], path: "CLAUDE.md" }, manifest.entries[1]] }),
		manifest => ({ ...manifest, entries: [{ ...manifest.entries[0], mode: "0600" }, manifest.entries[1]] }),
		manifest => ({ ...manifest, entries: [{ ...manifest.entries[0], kind: "directory", digest: undefined }, manifest.entries[1]] }),
		manifest => ({ ...manifest, entries: [{ ...manifest.entries[0], digest: DIGEST_B }, manifest.entries[1]] }),
	]) {
		assert.throws(() => QLab.validateQLabStarterManifest(mutate(base)), /manifest digest mismatch/);
	}
});

test("Gecko regular stats classify ready repositories and preserve starter files", async () => {
	const QLab = await loadQLab();
	const nodeHost = QLab.createNodeQLabPathHost(fs, path);
	const host = {
		...nodeHost,
		stat: async target => {
			const stat = await nodeHost.stat(target);
			return {
				type: stat.isDirectory() ? "directory" : "regular",
				size: stat.size,
				lastModified: stat.mtimeMs,
			};
		},
	};
	const root = await mkdtemp(join(tmpdir(), "chatero-qlab-"));
	try {
		await Promise.all(["knowledge", "drafts", "literature"].map(name => mkdir(join(root, name))));
		await writeFile(join(root, "AGENTS.md"), "# Agents\n");
		await writeFile(join(root, "qlab"), "#!/bin/sh\n");
		await writeFile(join(root, "drafts/index.qmd"), "# Draft\n");
		const inspection = await QLab.inspectQLabRepository(root, host);
		assert.equal(inspection.state, "ready");
		const plan = await QLab.planQLabStarterInstall({ root, inspection, manifest: validManifest(), host });
		assert.deepEqual(Array.from(plan.preserve, entry => entry.path), ["AGENTS.md", "drafts/index.qmd", "qlab"]);
		assert.deepEqual(Array.from(plan.conflicts), []);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("preserved fingerprints include normalized Gecko permissions", async () => {
	const QLab = await loadQLab();
	const nodeHost = QLab.createNodeQLabPathHost(fs, path);
	const root = await mkdtemp(join(tmpdir(), "chatero-qlab-mode-fingerprint-"));
	try {
		await mkdir(join(root, "drafts"));
		const note = join(root, "drafts", "private.qmd");
		await writeFile(note, "private note\n", { mode: 0o640 });
		await chmod(note, 0o640);
		const geckoHost = {
			...nodeHost,
			stat: async target => {
				const stat = await nodeHost.stat(target);
				return {
					type: stat.isDirectory() ? "directory" : "regular",
					size: stat.size,
					lastModified: stat.mtimeMs,
					permissions: stat.mode & 0o777,
				};
			},
		};
		const before = await QLab.fingerprintQLabPreservedTarget(root, "drafts", geckoHost);
		await chmod(note, 0o600);
		const after = await QLab.fingerprintQLabPreservedTarget(root, "drafts", geckoHost);
		assert.notEqual(after, before);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("incompatible marker inspection cannot plan starter writes", async () => {
	const QLab = await loadQLab();
	const host = QLab.createNodeQLabPathHost(fs, path);
	const root = await mkdtemp(join(tmpdir(), "chatero-qlab-"));
	try {
		await mkdir(join(root, ".research-loop"));
		await writeFile(join(root, ".research-loop/starter.json"), "{}\n");
		await writeFile(join(root, "personal.txt"), "user content\n");
		const inspection = await QLab.inspectQLabRepository(root, host);
		const plan = await QLab.planQLabStarterInstall({ root, inspection, manifest: validManifest(), host });
		assert.equal(inspection.state, "incompatible");
		assert.deepEqual(Array.from(plan.create), []);
		assert.deepEqual(Array.from(plan.conflicts, entry => entry.path), ["personal.txt"]);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("starter install plan separates creates, preserves, and conflicts from an inspection", async () => {
	const QLab = await loadQLab();
	const host = QLab.createNodeQLabPathHost(fs, path);
	const root = await mkdtemp(join(tmpdir(), "chatero-qlab-"));
	try {
		await mkdir(join(root, "drafts"));
		await writeFile(join(root, "drafts/index.qmd"), "# Existing draft\n");
		const inspection = await QLab.inspectQLabRepository(root, host);
		const plan = await QLab.planQLabStarterInstall({
			root,
			inspection,
			manifest: validManifest(),
			host,
		});
		assert.deepEqual(Array.from(plan.create, entry => entry.path), ["AGENTS.md", "qlab"]);
		assert.deepEqual(Array.from(plan.preserve, entry => entry.path), ["drafts/index.qmd"]);
		assert.deepEqual(Array.from(plan.conflicts), []);
		assert.match(plan.digest, /^[a-f0-9]{64}$/);
		assert.equal(Object.isFrozen(plan), true);
		assert.equal(Object.isFrozen(plan.create), true);
		assert.equal(Object.isFrozen(plan.create[0]), true);
		assert.equal(await QLab.isQLabStarterPlanCurrent(plan, inspection), true);

		await writeFile(join(root, "README.md"), "unrelated\n");
		const staleInspection = await QLab.inspectQLabRepository(root, host);
		assert.equal(await QLab.isQLabStarterPlanCurrent(plan, staleInspection), false);

		const conflictPlan = await QLab.planQLabStarterInstall({
			root,
			inspection: staleInspection,
			manifest: validManifest(),
			host,
		});
		assert.deepEqual(Array.from(conflictPlan.conflicts, entry => entry.path), ["README.md"]);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("starter install plan does not create through a dangling nested symlink", async () => {
	const QLab = await loadQLab();
	const host = QLab.createNodeQLabPathHost(fs, path);
	const root = await mkdtemp(join(tmpdir(), "chatero-qlab-"));
	try {
		await mkdir(join(root, "drafts"));
		await symlink(join(root, "missing.qmd"), join(root, "drafts/index.qmd"));
		const inspection = await QLab.inspectQLabRepository(root, host);
		const plan = await QLab.planQLabStarterInstall({
			root,
			inspection,
			manifest: validManifest(),
			host,
		});
		assert.deepEqual(Array.from(plan.conflicts, entry => entry.path), ["drafts/index.qmd"]);
		assert.equal(plan.conflicts[0].reason, "symlink-target");
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});
