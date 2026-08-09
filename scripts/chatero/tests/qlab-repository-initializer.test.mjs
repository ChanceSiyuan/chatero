import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadQLab } from "../lib/load-qlab.mjs";

const UUID = "11111111-2222-4333-8444-555555555555";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const execFile = promisify(execFileCallback);

function receiptDigest(receipt) {
	const canonical = { ...receipt };
	delete canonical.receiptDigest;
	return sha256(JSON.stringify(canonical));
}

function geckoFilesystemDependencies(hooks = {}) {
	class LocalFile {
		initWithPath(value) { this.path = value; }
		normalize() { this.path = fsSync.realpathSync(this.path); }
		isSymlink() {
			try { return fsSync.lstatSync(this.path).isSymbolicLink(); }
			catch { return false; }
		}
		create(type, mode) {
			if (type === 1) fsSync.mkdirSync(this.path, { mode });
			else fsSync.closeSync(fsSync.openSync(this.path, "wx", mode));
		}
	}
	class FileOutputStream {
		init(file, _flags, mode) {
			this.fd = fsSync.openSync(file.path, "wx", mode);
			this.position = 0;
		}
		QueryInterface() { return this; }
		seek(whence, offset) {
			assert.equal(whence, 0);
			this.position = offset;
		}
		setEOF() { fsSync.ftruncateSync(this.fd, this.position); }
	}
	class BinaryOutputStream {
		setOutputStream(stream) { this.stream = stream; }
		writeByteArray(bytes) {
			const value = Buffer.from(bytes);
			fsSync.writeSync(this.stream.fd, value, 0, value.length, this.stream.position);
			this.stream.position += value.length;
		}
		flush() { fsSync.fsyncSync(this.stream.fd); }
		close() { fsSync.closeSync(this.stream.fd); }
	}
	return {
		Components: {
			classes: {
				"@mozilla.org/file/local;1": { createInstance: () => new LocalFile() },
				"@mozilla.org/network/file-output-stream;1": { createInstance: () => new FileOutputStream() },
				"@mozilla.org/binaryoutputstream;1": { createInstance: () => new BinaryOutputStream() },
			},
			interfaces: {
				nsIFile: { DIRECTORY_TYPE: 1, NORMAL_FILE_TYPE: 0 },
				nsIFileOutputStream: {}, nsIBinaryOutputStream: {}, nsISeekableStream: { NS_SEEK_SET: 0 },
			},
			results: {},
		},
		IOUtils: {
			stat: async value => {
				const stat = await fs.stat(value);
				return { type: stat.isDirectory() ? "directory" : "regular", size: stat.size, lastModified: stat.mtimeMs };
			},
			getChildren: async value => (await fs.readdir(value)).map(name => join(value, name)),
			read: value => fs.readFile(value),
			move: (from, to) => fs.rename(from, to),
			remove: async (value, options) => {
				if (!options?.recursive && await fs.stat(value).then(stat => stat.isDirectory(), () => false)) {
					return fs.rmdir(value);
				}
				return fs.rm(value, { force: options?.ignoreAbsent, recursive: options?.recursive });
			},
		},
		PathUtils: {
			join: (...parts) => path.join(...parts), parent: value => path.dirname(value),
			filename: value => path.basename(value), normalize: value => path.normalize(value),
			isAbsolute: value => path.isAbsolute(value),
		},
		crypto: globalThis.crypto,
		TextEncoder: globalThis.TextEncoder,
		TextDecoder: globalThis.TextDecoder,
		...hooks,
	};
}

function storedArchiveFiles(archive) {
	const files = new Map();
	let offset = 0;
	while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034B50) {
		const method = archive.readUInt16LE(offset + 8);
		const size = archive.readUInt32LE(offset + 18);
		const nameLength = archive.readUInt16LE(offset + 26);
		const extraLength = archive.readUInt16LE(offset + 28);
		assert.equal(method, 0, "committed starter must use stored ZIP entries");
		const nameStart = offset + 30;
		const dataStart = nameStart + nameLength + extraLength;
		const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
		files.set(name, archive.subarray(dataStart, dataStart + size));
		offset = dataStart + size;
	}
	return files;
}

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

function starterAsset({
	corruptArchive = false,
	corruptPayload = false,
	includeReceiptDirectory = true,
	includeDraftEntry = false,
} = {}) {
	const payloads = new Map([
		["AGENTS.md", Buffer.from("# Public agent contract\n")],
		["qlab", Buffer.from("#!/bin/sh\n")],
		...(includeDraftEntry ? [["drafts/index.qmd", Buffer.from("# Starter draft\n")]] : []),
	]);
	const entries = [
		...(includeReceiptDirectory ? [{ path: ".research-loop", kind: "directory", mode: "0700" }] : []),
		{ path: "AGENTS.md", kind: "file", mode: "0644", digest: sha256(payloads.get("AGENTS.md")) },
		{ path: "drafts", kind: "directory", mode: "0755" },
		...(includeDraftEntry ? [{ path: "drafts/index.qmd", kind: "file", mode: "0644", digest: sha256(payloads.get("drafts/index.qmd")) }] : []),
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

async function latestReceipt(root, host) {
	const candidates = await host.readReceiptCandidates(join(root, ".research-loop", "starter.json"));
	assert.ok(candidates.length, "expected an initialization receipt");
	return JSON.parse(candidates[0].text);
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
	const failed = await latestReceipt(f.root, f.host);
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

test("initializer creates a local Git repository when the selected root is nested inside a parent worktree", async (t) => {
	const QLab = await loadQLab();
	const parent = await mkdtemp(join(tmpdir(), "chatero-parent-worktree-"));
	const root = join(parent, "selected-qlab");
	t.after(() => rm(parent, { recursive: true, force: true }));
	await execFile("/usr/bin/git", ["init", parent]);
	await mkdir(root);
	const canonicalRoot = await fs.realpath(root);
	const host = QLab.createNodeQLabInitializerHost(fs, path, createHash);
	const asset = starterAsset();
	const inspection = await QLab.inspectQLabRepository(canonicalRoot, host);
	const plan = await QLab.planQLabStarterInstall({ root: canonicalRoot, inspection, manifest: asset.manifest, host });
	const gitCalls = [];
	const git = {
		// Deliberately mirrors the old weak implementation: Git reports true in a
		// parent worktree even when this selected root owns no local .git.
		isRepository: async target => {
			const { stdout } = await execFile("/usr/bin/git", ["-C", target, "rev-parse", "--is-inside-work-tree"]);
			return stdout.trim() === "true";
		},
		initialize: async options => {
			gitCalls.push(options);
			await execFile(options.executable, ["-C", options.cwd, ...options.argv]);
		},
	};
	const initializer = QLab.createQLabRepositoryInitializer({
		host,
		assetReader: asset.reader,
		git,
		now: () => "2026-08-10T00:00:00.000Z",
		uuid: () => UUID,
	});

	const result = await initializer.execute(plan);
	assert.equal(result.state, "ready");
	assert.equal(await host.kind(join(canonicalRoot, ".git")), "directory");
	assert.deepEqual(JSON.parse(JSON.stringify(gitCalls)), [{ executable: "/usr/bin/git", argv: ["init"], cwd: canonicalRoot }]);
});

test("Gecko Git service accepts only the selected top-level with an in-root common directory", async () => {
	const QLab = await loadQLab();
	const calls = [];
	const responses = [
		"true\n", // Parent worktree: old is-inside-work-tree check alone is insufficient.
		"true\n/selected\n/outside/.git\n",
		"true\n/selected\n/selected/.git\n",
	];
	const git = QLab.createGeckoQLabGitService({
		Subprocess: {
			call: async options => {
				calls.push(options);
				const output = responses.shift();
				return {
					stdout: { readString: async () => output },
					wait: async () => ({ exitCode: 0 }),
				};
			},
		},
	});
	assert.equal(await git.isRepository("/selected"), false);
	assert.equal(await git.isRepository("/selected"), false);
	assert.equal(await git.isRepository("/selected"), true);
	for (const call of calls) {
		assert.equal(call.command, "/usr/bin/git");
		assert.equal(call.workdir, "/selected");
		assert.deepEqual(Array.from(call.arguments), [
			"rev-parse", "--is-inside-work-tree", "--show-toplevel", "--path-format=absolute", "--git-common-dir",
		]);
	}
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

test("initializer preflights every Git-private identity component before any repository write", async (t) => {
	const fixtures = [
		async root => {
			await mkdir(join(root, ".git"));
			await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
			await writeFile(join(root, ".git", "qlab"), "identity parent conflict\n");
		},
		async root => {
			await mkdir(join(root, ".git"));
			await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
			await writeFile(join(root, ".git", "commondir"), "../../outside\n");
		},
	];
	for (const prepare of fixtures) {
		const f = await fixture(t);
		await prepare(f.root);
		f.git.isRepository = async () => true;
		const inspection = await f.QLab.inspectQLabRepository(f.root, f.host);
		const plan = await f.QLab.planQLabStarterInstall({
			root: f.root,
			inspection,
			manifest: f.asset.manifest,
			host: f.host,
		});

		await assert.rejects(f.initializer.execute(plan), /identity|private|common|outside|ancestor/i);
		for (const target of ["AGENTS.md", "qlab", "drafts", "knowledge", "literature", ".research-loop"]) {
			assert.equal(await fs.access(join(f.root, target)).then(() => true, () => false), false, target);
		}
		assert.deepEqual(f.gitCalls, []);
	}
});

test("initializer persists a receipt before attempting the first ordinary starter target", async (t) => {
	const f = await fixture(t, { includeReceiptDirectory: false });
	const originalCreateFile = f.host.createFileIfAbsent;
	f.host.createFileIfAbsent = async (...args) => {
		if (args[1] === join(f.root, "AGENTS.md")) {
			assert.equal(
				await fs.access(join(f.root, ".research-loop", "starter.json")).then(() => true, () => false),
				true,
				"the durable receipt must precede ordinary starter writes",
			);
			throw new Error("stop after receipt bootstrap");
		}
		return originalCreateFile(...args);
	};

	await assert.rejects(f.initializer.execute(f.plan), /stop after receipt bootstrap/);
	const receipt = await latestReceipt(f.root, f.host);
	assert.equal(receipt.state, "failed");
	assert.deepEqual(receipt.completed, []);
	assert.equal(await fs.access(join(f.root, "AGENTS.md")).then(() => true, () => false), false);
});

test("a receipt write failure after its directory bootstrap can be safely retried", async (t) => {
	const f = await fixture(t);
	const writeReceipt = f.host.writeReceipt;
	let failFirstReceipt = true;
	f.host.writeReceipt = async (target, text, options) => {
		if (failFirstReceipt && options?.exclusive) {
			failFirstReceipt = false;
			throw new Error("simulated receipt write failure");
		}
		return writeReceipt(target, text, options);
	};

	await assert.rejects(f.initializer.execute(f.plan), /simulated receipt write failure/);
	assert.equal(await f.QLab.qlabRepositoryState(f.root, f.host), "partial");
	assert.equal(await fs.access(join(f.root, ".research-loop", "starter.json")).then(() => true, () => false), false);
	assert.deepEqual((await fs.readdir(f.root)).sort(), [".research-loop"]);

	f.host.writeReceipt = writeReceipt;
	const inspection = await f.QLab.inspectQLabRepository(f.root, f.host);
	const plan = await f.QLab.planQLabStarterInstall({ root: f.root, inspection, manifest: f.asset.manifest, host: f.host });
	const result = await f.initializer.execute(plan);
	assert.equal(result.state, "ready");
	assert.equal(f.gitCalls.length, 1);
});

test("receipt updates are immutable generations and restart falls back from a tampered latest generation", async (t) => {
	const f = await fixture(t);
	const first = await f.initializer.execute(f.plan);
	const bootstrapPath = join(f.root, ".research-loop", "starter.json");
	const bootstrapBytes = await readFile(bootstrapPath, "utf8");
	const candidates = await f.host.readReceiptCandidates(bootstrapPath);
	assert.ok(candidates.length > 2);
	assert.equal(candidates.at(-1).bootstrap, true);
	assert.equal(candidates.at(-1).revision, 0);
	for (const candidate of candidates.filter(candidate => !candidate.bootstrap)) {
		const receipt = JSON.parse(candidate.text);
		assert.equal(candidate.revision, receipt.revision);
		assert.equal(candidate.digest, receipt.receiptDigest);
		assert.match(candidate.path, /starter\.[1-9][0-9]*\.[a-f0-9]{64}\.json$/);
	}
	await assert.rejects(
		f.host.writeReceipt(bootstrapPath, "cannot overwrite\n", { exclusive: true }),
		/already exists|generation/i,
	);
	assert.equal(await readFile(bootstrapPath, "utf8"), bootstrapBytes);

	await writeFile(candidates[0].path, "{not valid JSON\n", { mode: 0o600 });
	const recovered = await f.initializer.resume(f.root);
	assert.equal(recovered.state, "ready");
	assert.notEqual(recovered.receiptPath, candidates[0].path);
	assert.equal(first.repositoryIdentity, recovered.repositoryIdentity);
});

test("Gecko initializer construction binds packaged starter resources and a complete host", async () => {
	const QLab = await loadQLab();
	const host = { marker: "host" };
	const git = { marker: "git" };
	const assetReader = { marker: "asset" };
	const createPrototypeHost = QLab.createGeckoQLabInitializerHost;
	let resourceOptions;
	let initializerOptions;
	QLab.createGeckoQLabInitializerHost = () => host;
	QLab.createGeckoQLabGitService = () => git;
	QLab.createGeckoQLabStarterAssetReader = options => {
		resourceOptions = options;
		return assetReader;
	};
	QLab.createQLabRepositoryInitializer = options => {
		initializerOptions = options;
		return { marker: "initializer" };
	};

	const initializer = QLab.createGeckoQLabRepositoryInitializer();
	assert.deepEqual(JSON.parse(JSON.stringify(resourceOptions)), {
		manifestURI: "resource://zotero/chatero/qlab-starter/manifest.json",
		archiveURI: "resource://zotero/chatero/qlab-starter/research-loop-starter.zip",
	});
	assert.equal(initializerOptions.host, host);
	assert.equal(initializerOptions.assetReader, assetReader);
	assert.equal(initializerOptions.git, git);
	assert.equal(initializer.marker, "initializer");

	const requiredHostMethods = [
		"entries", "filename", "stat", "isSymlink", "exists", "existsNoFollow",
		"realPath", "normalize", "isAbsolute", "isPathInside", "resolvePath", "join",
		"kind", "assertNoSymlinkComponents", "readTextNoFollow", "readPrivateNoFollow",
		"createPrivateIfAbsent", "sha256", "readBytesNoFollow", "createDirectoryIfAbsent",
		"createFileIfAbsent", "readReceiptCandidates", "readReceipt", "writeReceipt",
	];
	const prototypeHost = createPrototypeHost({
		IOUtils: {}, PathUtils: {}, Components: {}, crypto: {},
	});
	for (const method of requiredHostMethods) assert.equal(typeof prototypeHost[method], "function", method);
});

test("Node initializer host revalidates a target parent after a missing-leaf race", async (t) => {
	const QLab = await loadQLab();
	for (const operation of ["file", "directory"]) {
		const root = await mkdtemp(join(tmpdir(), `chatero-node-race-${operation}-`));
		const outside = await mkdtemp(join(tmpdir(), `chatero-node-race-outside-${operation}-`));
		t.after(() => rm(root, { recursive: true, force: true }));
		t.after(() => rm(outside, { recursive: true, force: true }));
		const parent = join(root, "nested");
		const target = join(parent, operation === "file" ? "note.qmd" : "child");
		await mkdir(parent, { recursive: true });
		let attacked = false;
		const racingFs = new Proxy(fs, {
			get(source, property) {
				if (property === "lstat") {
					return async pathValue => {
						try { return await fs.lstat(pathValue); }
						catch (error) {
							if (!attacked && pathValue === target && error?.code === "ENOENT") {
								attacked = true;
								await rm(parent, { recursive: true });
								await symlink(outside, parent);
							}
							throw error;
						}
					};
				}
				const value = Reflect.get(source, property);
				return typeof value === "function" ? value.bind(source) : value;
			},
		});
		const host = QLab.createNodeQLabInitializerHost(racingFs, path, createHash);

		await assert.rejects(
			operation === "file"
				? host.createFileIfAbsent(root, target, Buffer.from("must stay inside\n"), 0o600)
				: host.createDirectoryIfAbsent(root, target, 0o700),
			/symbolic|outside|ancestor|parent/i,
		);
		assert.equal(attacked, true);
		assert.equal(
			await fs.access(join(outside, path.basename(target))).then(() => true, () => false),
			false,
			`${operation} creation escaped the repository root`,
		);
	}
});

test("Node create operations clean only their own escaped leaf after a final-operation parent swap", async (t) => {
	const QLab = await loadQLab();
	for (const operation of ["file", "directory", "receipt", "private"]) {
		let root = await mkdtemp(join(tmpdir(), `chatero-final-race-${operation}-`));
		let outside = await mkdtemp(join(tmpdir(), `chatero-final-race-outside-${operation}-`));
		t.after(() => rm(root, { recursive: true, force: true }));
		t.after(() => rm(outside, { recursive: true, force: true }));
		root = await fs.realpath(root);
		outside = await fs.realpath(outside);
		const parent = operation === "private"
			? join(root, ".git", "qlab")
			: join(root, operation === "receipt" ? ".research-loop" : "nested");
		const leaf = operation === "directory" ? "child" : operation === "private" ? "repository-id" : "note.qmd";
		const target = join(parent, leaf);
		const sentinel = join(outside, "user-sentinel.txt");
		await mkdir(parent, { recursive: true });
		await writeFile(sentinel, "do not touch\n");
		let swapped = false;
		const beforeCreate = async () => {
			if (swapped) return;
			swapped = true;
			await rm(parent, { recursive: true });
			await symlink(outside, parent);
		};
		const host = operation === "private"
			? QLab.createNodeQLabRepositoryHost(fs, path, { beforeCreate })
			: QLab.createNodeQLabInitializerHost(fs, path, createHash, { beforeCreate });

		let promise = operation === "directory"
			? host.createDirectoryIfAbsent(root, target, 0o700)
			: operation === "private"
				? host.createPrivateIfAbsent(root, target, "11111111-2222-4333-8444-555555555555\n", 0o600, 0o700)
				: host.createFileIfAbsent(root, target, Buffer.from("must stay inside\n"), 0o600);
		try {
			await promise;
			assert.fail(`expected escaped ${operation} creation to reject`);
		}
		catch (error) {
			assert.match(String(error?.message || error), /symbolic|outside|escaped|parent/i, operation);
		}
		assert.equal(swapped, true, operation);
		assert.equal(await readFile(sentinel, "utf8"), "do not touch\n", operation);
		assert.equal(await fs.access(join(outside, leaf)).then(() => true, () => false), false, operation);
	}
});

test("initializer fingerprints preserved nested content and makes zero writes after an in-place mutation", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.root, "drafts", "topic"), { recursive: true });
	const note = join(f.root, "drafts", "topic", "private.qmd");
	await writeFile(note, "private alpha\n", { mode: 0o640 });
	const inspection = await f.QLab.inspectQLabRepository(f.root, f.host);
	const plan = await f.QLab.planQLabStarterInstall({
		root: f.root,
		inspection,
		manifest: f.asset.manifest,
		host: f.host,
	});
	const drafts = plan.preserve.find(entry => entry.path === "drafts");
	assert.match(drafts.fingerprint, /^[a-f0-9]{64}$/);
	await writeFile(note, "private omega\n", { mode: 0o640 });

	await assert.rejects(f.initializer.execute(plan), /changed|stale|snapshot|fingerprint/i);
	assert.equal(await readFile(note, "utf8"), "private omega\n");
	for (const target of ["AGENTS.md", "qlab", "knowledge", "literature", ".research-loop"]) {
		assert.equal(await fs.access(join(f.root, target)).then(() => true, () => false), false, target);
	}
	assert.deepEqual(f.gitCalls, []);
});

test("partial repositories exclude planned starter descendants but retain nested user-content fingerprints", async (t) => {
	const f = await fixture(t, { includeDraftEntry: true });
	await mkdir(join(f.root, "drafts", "topic"), { recursive: true });
	const note = join(f.root, "drafts", "topic", "private.qmd");
	await writeFile(note, "private alpha\n", { mode: 0o640 });
	await chmod(note, 0o640);
	let inspection = await f.QLab.inspectQLabRepository(f.root, f.host);
	let plan = await f.QLab.planQLabStarterInstall({ root: f.root, inspection, manifest: f.asset.manifest, host: f.host });
	const first = await f.initializer.execute(plan);
	assert.equal(first.state, "ready");

	inspection = await f.QLab.inspectQLabRepository(f.root, f.host);
	plan = await f.QLab.planQLabStarterInstall({ root: f.root, inspection, manifest: f.asset.manifest, host: f.host });
	const second = await f.initializer.execute(plan);
	assert.equal(second.state, "ready");
	assert.equal(f.gitCalls.length, 1);

	await writeFile(note, "private omega\n", { mode: 0o640 });
	await assert.rejects(f.initializer.resume(f.root), /preserved|changed|fingerprint|receipt/i);
	assert.equal(await readFile(note, "utf8"), "private omega\n");
});

test("chmod-only mutations of preserved content reject before starter writes", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.root, "drafts", "topic"), { recursive: true });
	const note = join(f.root, "drafts", "topic", "private.qmd");
	await writeFile(note, "private note\n", { mode: 0o640 });
	await chmod(note, 0o640);
	const inspection = await f.QLab.inspectQLabRepository(f.root, f.host);
	const plan = await f.QLab.planQLabStarterInstall({ root: f.root, inspection, manifest: f.asset.manifest, host: f.host });
	await chmod(note, 0o600);

	await assert.rejects(f.initializer.execute(plan), /changed|stale|snapshot|fingerprint/i);
	for (const target of ["AGENTS.md", "qlab", "knowledge", "literature", ".research-loop"]) {
		assert.equal(await fs.access(join(f.root, target)).then(() => true, () => false), false, target);
	}
	assert.equal((await lstat(note)).mode & 0o777, 0o600);
	assert.deepEqual(f.gitCalls, []);
});

test("ready receipts carry a digest and reject a forged plan digest even when the receipt digest is updated", async (t) => {
	const f = await fixture(t);
	const result = await f.initializer.execute(f.plan);
	for (const candidate of await f.host.readReceiptCandidates(join(f.root, ".research-loop", "starter.json"))) {
		const receipt = JSON.parse(candidate.text);
		assert.match(receipt.receiptDigest, /^[a-f0-9]{64}$/);
		assert.equal(receipt.receiptDigest, receiptDigest(receipt));
		receipt.planDigest = "e".repeat(64);
		receipt.receiptDigest = receiptDigest(receipt);
		await writeFile(candidate.path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
	}

	await assert.rejects(f.initializer.resume(f.root), /plan|receipt|digest|stale/i);
	assert.equal(f.gitCalls.length, 1);
});

test("ready receipt reconciliation rejects changed nested preserved content", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.root, "drafts", "topic"), { recursive: true });
	const note = join(f.root, "drafts", "topic", "private.qmd");
	await writeFile(note, "private alpha\n", { mode: 0o640 });
	const inspection = await f.QLab.inspectQLabRepository(f.root, f.host);
	const plan = await f.QLab.planQLabStarterInstall({
		root: f.root,
		inspection,
		manifest: f.asset.manifest,
		host: f.host,
	});
	await f.initializer.execute(plan);
	await writeFile(note, "private omega\n", { mode: 0o640 });

	await assert.rejects(f.initializer.resume(f.root), /preserved|changed|fingerprint|receipt/i);
	assert.equal(await readFile(note, "utf8"), "private omega\n");
	assert.equal(f.gitCalls.length, 1);
});

test("committed Task 2 starter manifest and archive initialize idempotently", async (t) => {
	const QLab = await loadQLab();
	const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
	const starterRoot = join(repositoryRoot, "resource", "chatero", "qlab-starter");
	const manifest = JSON.parse(await readFile(join(starterRoot, "manifest.json"), "utf8"));
	const archive = await readFile(join(starterRoot, "research-loop-starter.zip"));
	const files = storedArchiveFiles(archive);
	let root = await mkdtemp(join(tmpdir(), "chatero-real-starter-initialize-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	root = await fs.realpath(root);
	const host = QLab.createNodeQLabInitializerHost(fs, path, createHash);
	const gitCalls = [];
	const git = {
		isRepository: async target => host.kind(join(target, ".git")).then(kind => kind === "directory"),
		initialize: async options => {
			gitCalls.push(options);
			await mkdir(join(options.cwd, ".git"));
			await writeFile(join(options.cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
		},
	};
	const initializer = QLab.createQLabRepositoryInitializer({
		host,
		assetReader: {
			readManifest: async () => structuredClone(manifest),
			readArchive: async () => Buffer.from(archive),
			readEntry: async relativePath => Buffer.from(files.get(relativePath)),
		},
		git,
		now: () => "2026-08-10T00:00:00.000Z",
		uuid: () => UUID,
	});
	let inspection = await QLab.inspectQLabRepository(root, host);
	let plan = await QLab.planQLabStarterInstall({ root, inspection, manifest, host });
	const first = await initializer.execute(plan);
	const qlabBefore = await readFile(join(root, "qlab"));
	assert.equal(await QLab.qlabRepositoryState(root, host), "ready");
	assert.equal(first.created.length, plan.create.length);

	inspection = await QLab.inspectQLabRepository(root, host);
	plan = await QLab.planQLabStarterInstall({ root, inspection, manifest, host });
	const second = await initializer.execute(plan);
	assert.equal(second.repositoryIdentity, first.repositoryIdentity);
	assert.deepEqual(await readFile(join(root, "qlab")), qlabBefore);
	assert.equal(gitCalls.length, 1);
});

test("Gecko initializer host cleans escaped leaves after final-operation parent swaps", async (t) => {
	const QLab = await loadQLab();
	for (const operation of ["file", "directory", "receipt", "private"]) {
		let root = await mkdtemp(join(tmpdir(), `chatero-gecko-race-${operation}-`));
		let outside = await mkdtemp(join(tmpdir(), `chatero-gecko-race-outside-${operation}-`));
		t.after(() => rm(root, { recursive: true, force: true }));
		t.after(() => rm(outside, { recursive: true, force: true }));
		root = await fs.realpath(root);
		outside = await fs.realpath(outside);
		const parent = operation === "private"
			? join(root, ".git", "qlab")
			: join(root, operation === "receipt" ? ".research-loop" : "nested");
		const leaf = operation === "directory" ? "child" : operation === "private" ? "repository-id" : "note.qmd";
		const target = join(parent, leaf);
		const sentinel = join(outside, "user-sentinel.txt");
		await mkdir(parent, { recursive: true });
		await writeFile(sentinel, "do not touch\n");
		let attacked = false;
		const host = QLab.createGeckoQLabInitializerHost(geckoFilesystemDependencies({
			beforeCreate: async () => {
				if (attacked) return;
				attacked = true;
				await rm(parent, { recursive: true });
				await symlink(outside, parent);
			},
		}));

		let operationPromise = operation === "directory"
			? host.createDirectoryIfAbsent(root, target, 0o700)
			: operation === "private"
				? host.createPrivateIfAbsent(root, target, "11111111-2222-4333-8444-555555555555\n", 0o600, 0o700)
				: host.createFileIfAbsent(root, target, Buffer.from("must stay inside\n"), 0o600);
		let rejected = false;
		try { await operationPromise; }
		catch (error) {
			rejected = true;
			assert.match(String(error?.message || error), /symbolic|outside|escaped|parent/i, operation);
		}
		assert.equal(rejected, true, operation);
		assert.equal(attacked, true);
		assert.equal(await readFile(sentinel, "utf8"), "do not touch\n");
		assert.equal(await fs.access(join(outside, leaf)).then(() => true, () => false), false);
	}
});

test("Gecko private identity tracks a missing parent across a final Git-directory swap", async (t) => {
	const QLab = await loadQLab();
	let root = await mkdtemp(join(tmpdir(), "chatero-gecko-private-parent-race-"));
	let outside = await mkdtemp(join(tmpdir(), "chatero-gecko-private-parent-outside-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => rm(outside, { recursive: true, force: true }));
	root = await fs.realpath(root);
	outside = await fs.realpath(outside);
	const gitDirectory = join(root, ".git");
	const privateParent = join(gitDirectory, "qlab");
	const target = join(privateParent, "repository-id");
	const sentinel = join(outside, "user-sentinel.txt");
	await mkdir(gitDirectory);
	await writeFile(sentinel, "do not touch\n");
	let attacked = false;
	const host = QLab.createGeckoQLabInitializerHost(geckoFilesystemDependencies({
		beforeCreate: async ({ target: createTarget, kind }) => {
			if (attacked || createTarget !== privateParent || kind !== "directory") return;
			attacked = true;
			await rm(gitDirectory, { recursive: true });
			await symlink(outside, gitDirectory);
		},
	}));

	await assert.rejects(
		host.createPrivateIfAbsent(root, target, `${UUID}\n`, 0o600, 0o700),
		/symbolic|outside|escaped|parent/i,
	);
	assert.equal(attacked, true);
	assert.equal(await readFile(sentinel, "utf8"), "do not touch\n");
	assert.equal(await fs.access(join(outside, "qlab")).then(() => true, () => false), false);
});

test("Gecko escaped cleanup preserves unrelated same-type substitutes without its create proof", async (t) => {
	const QLab = await loadQLab();
	for (const operation of ["file", "directory"]) {
		let root = await mkdtemp(join(tmpdir(), `chatero-gecko-proof-${operation}-`));
		let outside = await mkdtemp(join(tmpdir(), `chatero-gecko-proof-outside-${operation}-`));
		t.after(() => rm(root, { recursive: true, force: true }));
		t.after(() => rm(outside, { recursive: true, force: true }));
		root = await fs.realpath(root);
		outside = await fs.realpath(outside);
		const parent = join(root, "nested");
		const leaf = operation === "file" ? "note.qmd" : "child";
		const target = join(parent, leaf);
		const resolvedTarget = join(outside, leaf);
		await mkdir(parent);
		let attacked = false;
		let substituted = false;
		const host = QLab.createGeckoQLabInitializerHost(geckoFilesystemDependencies({
			beforeCreate: async ({ target: createTarget }) => {
				if (attacked || createTarget !== target) return;
				attacked = true;
				await rm(parent, { recursive: true });
				await symlink(outside, parent);
			},
			beforeEscapedCleanup: async event => {
				if (substituted || event.target !== target || event.kind !== operation) return;
				substituted = true;
				await rm(resolvedTarget, { recursive: true, force: true });
				if (operation === "file") {
					await writeFile(resolvedTarget, "unrelated file\n");
				}
				else {
					await mkdir(resolvedTarget);
					await writeFile(join(resolvedTarget, "unrelated.txt"), "unrelated directory\n");
				}
			},
		}));

		await assert.rejects(
			operation === "file"
				? host.createFileIfAbsent(root, target, Buffer.from("starter bytes\n"), 0o600)
				: host.createDirectoryIfAbsent(root, target, 0o700),
			/escaped|proof|outside|symbolic|parent/i,
		);
		assert.equal(attacked, true, operation);
		assert.equal(substituted, true, operation);
		if (operation === "file") {
			assert.equal(await readFile(resolvedTarget, "utf8"), "unrelated file\n");
		}
		else {
			assert.equal(await readFile(join(resolvedTarget, "unrelated.txt"), "utf8"), "unrelated directory\n");
		}
	}
});

test("Gecko proven file creation replaces the nonce with the exact original bytes on the held stream", async (t) => {
	const QLab = await loadQLab();
	let root = await mkdtemp(join(tmpdir(), "chatero-gecko-proof-finalize-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	root = await fs.realpath(root);
	const parent = join(root, "nested");
	const target = join(parent, "payload.bin");
	const expected = Buffer.from([0x00, 0xff, 0x41, 0x80, 0x0a]);
	await mkdir(parent);
	const host = QLab.createGeckoQLabInitializerHost(geckoFilesystemDependencies());

	assert.equal(await host.createFileIfAbsent(root, target, expected, 0o600), "created");
	assert.deepEqual(await readFile(target), expected);
});
