import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const UUID = "11111111-2222-4333-8444-555555555555";
const sha256 = value => createHash("sha256").update(value).digest("hex");

function canonicalManifestDigest(entries) {
	const canonicalEntries = entries
		.map(entry => ({
			path: entry.path,
			kind: entry.kind,
			mode: entry.mode,
			...(entry.kind === "file" ? { digest: entry.digest } : {}),
		}))
		.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
	return sha256(JSON.stringify({ schemaVersion: 1, entries: canonicalEntries }));
}

function starterAsset({ corruptArchive = false, corruptPayload = false } = {}) {
	const payloads = new Map([
		["AGENTS.md", Buffer.from("# Public agent contract\n")],
		["qlab", Buffer.from("#!/bin/sh\n")],
	]);
	const entries = [
		{ path: ".research-loop", kind: "directory", mode: "0700" },
		{ path: "AGENTS.md", kind: "file", mode: "0644", digest: sha256(payloads.get("AGENTS.md")) },
		{ path: "drafts", kind: "directory", mode: "0755" },
		{ path: "knowledge", kind: "directory", mode: "0755" },
		{ path: "literature", kind: "directory", mode: "0755" },
		{ path: "qlab", kind: "file", mode: "0755", digest: sha256(payloads.get("qlab")) },
	];
	const archive = Buffer.from("deterministic-starter-archive-v1");
	const manifest = {
		schemaVersion: 1,
		digest: canonicalManifestDigest(entries),
		archiveSha256: corruptArchive ? "f".repeat(64) : sha256(archive),
		entries,
	};
	if (corruptPayload) payloads.set("qlab", Buffer.from("tampered\n"));
	return {
		manifest,
		archive,
		payloads,
		reader: {
			readManifest: async () => structuredClone(manifest),
			readArchive: async () => Buffer.from(archive),
			readEntry: async relativePath => {
				const value = payloads.get(relativePath);
				if (!value) throw new Error(`missing payload ${relativePath}`);
				return Buffer.from(value);
			},
		},
	};
}

async function fixture(t, assetOptions) {
	const QLab = await loadQLab();
	let root = await mkdtemp(join(tmpdir(), "chatero-initialize-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	root = await fs.realpath(root);
	const host = QLab.createNodeQLabInitializerHost(fs, path, createHash);
	const asset = starterAsset(assetOptions);
	const inspection = await QLab.inspectQLabRepository(root, host);
	const plan = await QLab.planQLabStarterInstall({ root, inspection, manifest: asset.manifest, host });
	const gitCalls = [];
	const git = {
		isRepository: async repositoryRoot => host.kind(join(repositoryRoot, ".git")).then(kind => kind === "directory"),
		initialize: async options => {
			gitCalls.push(options);
			await mkdir(join(options.cwd, ".git"));
			await writeFile(join(options.cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
		},
	};
	const initializer = QLab.createQLabRepositoryInitializer({
		host,
		assetReader: asset.reader,
		git,
		now: () => "2026-08-10T00:00:00.000Z",
		uuid: () => UUID,
	});
	return { QLab, root, host, asset, inspection, plan, git, gitCalls, initializer };
}

test("initializer verifies first, preserves user bytes and modes, and reports ordered progress", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.root, "drafts"));
	await writeFile(join(f.root, "drafts", "private.qmd"), "private note\n", { mode: 0o640 });
	await chmod(join(f.root, "drafts", "private.qmd"), 0o640);
	const inspection = await f.QLab.inspectQLabRepository(f.root, f.host);
	const plan = await f.QLab.planQLabStarterInstall({ root: f.root, inspection, manifest: f.asset.manifest, host: f.host });
	const progress = [];
	const result = await f.initializer.execute(plan, event => progress.push(event.step));

	assert.equal(result.state, "ready");
	assert.equal(result.repositoryIdentity, UUID);
	assert.deepEqual(progress, [
		"verify-folder", "verify-starter", "add-missing-files",
		"initialize-git", "verify-repository", "ready",
	]);
	assert.equal(await readFile(join(f.root, "drafts", "private.qmd"), "utf8"), "private note\n");
	assert.equal((await lstat(join(f.root, "drafts", "private.qmd"))).mode & 0o777, 0o640);
	assert.equal(await readFile(join(f.root, "AGENTS.md"), "utf8"), "# Public agent contract\n");
	assert.equal((await lstat(join(f.root, "qlab"))).mode & 0o777, 0o755);
	assert.deepEqual(JSON.parse(JSON.stringify(f.gitCalls)), [{ executable: "/usr/bin/git", argv: ["init"], cwd: f.root }]);
	assert.equal((await lstat(result.receiptPath)).mode & 0o777, 0o600);
});

test("initializer makes zero target writes when archive or payload verification fails", async (t) => {
	for (const options of [{ corruptArchive: true }, { corruptPayload: true }]) {
		const f = await fixture(t, options);
		await assert.rejects(f.initializer.execute(f.plan), /digest|archive|payload/i);
		assert.deepEqual(await fs.readdir(f.root), []);
		assert.deepEqual(f.gitCalls, []);
	}
});

test("initializer reinspects the immutable plan and makes zero writes when it is stale or conflicted", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.root, "README.md"), "arrived after review\n", { mode: 0o640 });
	await assert.rejects(f.initializer.execute(f.plan), /stale|changed|conflict/i);
	assert.deepEqual((await fs.readdir(f.root)).sort(), ["README.md"]);
	assert.equal((await lstat(join(f.root, "README.md"))).mode & 0o777, 0o640);
	assert.deepEqual(f.gitCalls, []);
});

test("initializer rejects a forged plan snapshot before making target writes", async (t) => {
	const f = await fixture(t);
	const forged = {
		...f.plan,
		create: f.plan.create.filter(entry => entry.path !== "knowledge"),
	};

	await assert.rejects(f.initializer.execute(forged), /plan|snapshot|manifest/i);
	assert.deepEqual(await fs.readdir(f.root), []);
	assert.deepEqual(f.gitCalls, []);
});

test("initializer leaves an honest receipt after interruption and resumes only after validation", async (t) => {
	const f = await fixture(t);
	const create = f.host.createFileIfAbsent;
	let interrupted = false;
	f.host.createFileIfAbsent = async (...args) => {
		if (!interrupted && args[1].endsWith("qlab")) {
			interrupted = true;
			throw new Error("simulated disk interruption");
		}
		return create(...args);
	};
	await assert.rejects(f.initializer.execute(f.plan), /simulated disk interruption/);
	const receiptPath = join(f.root, ".research-loop", "starter.json");
	const failed = JSON.parse(await readFile(receiptPath, "utf8"));
	assert.equal(failed.state, "failed");
	assert.equal(failed.inFlight, "qlab");
	assert.ok(failed.completed.includes("AGENTS.md"));
	assert.equal(await fs.access(join(f.root, "AGENTS.md")).then(() => true, () => false), true);
	assert.equal(await fs.access(join(f.root, "qlab")).then(() => true, () => false), false);

	f.host.createFileIfAbsent = create;
	const resumed = await f.initializer.resume(f.root);
	assert.equal(resumed.state, "ready");
	assert.equal(resumed.repositoryIdentity, UUID);
	assert.equal(await readFile(join(f.root, "qlab"), "utf8"), "#!/bin/sh\n");
});

test("resume rejects changed completed and unrecorded targets without writing", async (t) => {
	const f = await fixture(t);
	const create = f.host.createFileIfAbsent;
	let interrupted = false;
	f.host.createFileIfAbsent = async (...args) => {
		if (!interrupted && args[1].endsWith("qlab")) {
			interrupted = true;
			throw new Error("stop before qlab");
		}
		return create(...args);
	};
	await assert.rejects(f.initializer.execute(f.plan));
	await writeFile(join(f.root, "AGENTS.md"), "user changed completed target\n");
	await writeFile(join(f.root, "qlab"), "unrecorded file\n");
	f.host.createFileIfAbsent = create;
	await assert.rejects(f.initializer.resume(f.root), /changed|digest|unrecorded/i);
	assert.equal(await readFile(join(f.root, "qlab"), "utf8"), "unrecorded file\n");
	assert.deepEqual(f.gitCalls, []);
});

test("resume validates preserved targets before continuing any writes", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.root, "drafts"));
	await writeFile(join(f.root, "drafts", "private.qmd"), "private note\n");
	const inspection = await f.QLab.inspectQLabRepository(f.root, f.host);
	const plan = await f.QLab.planQLabStarterInstall({
		root: f.root,
		inspection,
		manifest: f.asset.manifest,
		host: f.host,
	});
	const create = f.host.createFileIfAbsent;
	let interrupted = false;
	f.host.createFileIfAbsent = async (...args) => {
		if (!interrupted && args[1].endsWith("qlab")) {
			interrupted = true;
			throw new Error("stop before qlab");
		}
		return create(...args);
	};
	await assert.rejects(f.initializer.execute(plan), /stop before qlab/);
	await rm(join(f.root, "drafts"), { recursive: true });
	await writeFile(join(f.root, "drafts"), "changed preserved target\n");
	f.host.createFileIfAbsent = create;

	await assert.rejects(f.initializer.resume(f.root), /preserved|changed|kind/i);
	assert.equal(await fs.access(join(f.root, "qlab")).then(() => true, () => false), false);
	assert.deepEqual(f.gitCalls, []);
});

test("repeated initialization is idempotent and never reruns Git or rewrites existing files", async (t) => {
	const f = await fixture(t);
	const first = await f.initializer.execute(f.plan);
	const before = await readFile(join(f.root, "AGENTS.md"));
	const inspection = await f.QLab.inspectQLabRepository(f.root, f.host);
	const plan = await f.QLab.planQLabStarterInstall({ root: f.root, inspection, manifest: f.asset.manifest, host: f.host });
	const second = await f.initializer.execute(plan);
	assert.equal(second.state, "ready");
	assert.equal(second.repositoryIdentity, first.repositoryIdentity);
	assert.deepEqual(await readFile(join(f.root, "AGENTS.md")), before);
	assert.equal(f.gitCalls.length, 1);
});

test("resume rejects a ready receipt that does not describe a complete repository", async (t) => {
	const f = await fixture(t);
	const result = await f.initializer.execute(f.plan);
	const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
	receipt.completed = receipt.completed.filter(relativePath => relativePath !== "qlab");
	await writeFile(result.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
	await rm(join(f.root, "qlab"));

	await assert.rejects(f.initializer.resume(f.root), /receipt|complete|ready/i);
	assert.equal(await fs.access(join(f.root, "qlab")).then(() => true, () => false), false);
	assert.equal(f.gitCalls.length, 1);
});

test("initializer never runs Git when a repository already exists", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.root, ".git"));
	await writeFile(join(f.root, ".git", "HEAD"), "ref: refs/heads/main\n");
	const inspection = await f.QLab.inspectQLabRepository(f.root, f.host);
	const plan = await f.QLab.planQLabStarterInstall({ root: f.root, inspection, manifest: f.asset.manifest, host: f.host });
	const result = await f.initializer.execute(plan);
	assert.equal(result.state, "ready");
	assert.deepEqual(f.gitCalls, []);
});

test("initializer rejects a non-repository .git target before writing starter files", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.root, ".git"));
	await writeFile(join(f.root, ".git", "sentinel"), "not a repository\n");
	f.git.isRepository = async () => false;
	const inspection = await f.QLab.inspectQLabRepository(f.root, f.host);
	const plan = await f.QLab.planQLabStarterInstall({
		root: f.root,
		inspection,
		manifest: f.asset.manifest,
		host: f.host,
	});

	await assert.rejects(f.initializer.execute(plan), /git|repository/i);
	assert.deepEqual(await fs.readdir(f.root), [".git"]);
	assert.equal(await readFile(join(f.root, ".git", "sentinel"), "utf8"), "not a repository\n");
	assert.deepEqual(f.gitCalls, []);
});
