import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const FIXED_UUID = "11111111-2222-4333-8444-555555555555";
const OTHER_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function repository(t) {
	const root = await mkdtemp(join(tmpdir(), "chatero-identity-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, ".git"));
	return fs.realpath(root);
}

test("repository identity is exclusively created with owner-only mode and then preserved", async (t) => {
	const QLab = await loadQLab();
	const root = await repository(t);
	const host = QLab.createNodeQLabRepositoryHost(fs, path);
	const first = await QLab.createQLabRepositoryIdentity({ root, host, uuid: () => FIXED_UUID });
	const second = await QLab.createQLabRepositoryIdentity({ root, host, uuid: () => OTHER_UUID });
	const identityPath = join(root, ".git", "qlab", "repository-id");

	assert.equal(first.identity, FIXED_UUID);
	assert.equal(second.identity, FIXED_UUID);
	assert.equal(first.created, true);
	assert.equal(second.created, false);
	assert.equal((await lstat(identityPath)).mode & 0o777, 0o600);
	assert.equal((await lstat(join(root, ".git", "qlab"))).mode & 0o777, 0o700);
	assert.equal(await readFile(identityPath, "utf8"), `${FIXED_UUID}\n`);
});

test("repository identity rejects malformed or oversized existing content without replacing it", async (t) => {
	const QLab = await loadQLab();
	const root = await repository(t);
	const host = QLab.createNodeQLabRepositoryHost(fs, path);
	await mkdir(join(root, ".git", "qlab"));
	const identityPath = join(root, ".git", "qlab", "repository-id");
	for (const invalid of ["not-a-uuid\n", `${"x".repeat(1024)}\n`]) {
		await writeFile(identityPath, invalid, { mode: 0o640 });
		await assert.rejects(
			QLab.createQLabRepositoryIdentity({ root, host, uuid: () => FIXED_UUID }),
			/invalid|oversized/i,
		);
		assert.equal(await readFile(identityPath, "utf8"), invalid);
		assert.equal((await lstat(identityPath)).mode & 0o777, 0o640);
		await rm(identityPath);
	}
});

test("repository identity refuses symlink targets and every symlinked private ancestor", async (t) => {
	const QLab = await loadQLab();
	const host = QLab.createNodeQLabRepositoryHost(fs, path);
	const outside = await mkdtemp(join(tmpdir(), "chatero-identity-outside-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	const root = await repository(t);
	await rm(join(root, ".git"), { recursive: true });
	await symlink(outside, join(root, ".git"));
	await assert.rejects(
		QLab.createQLabRepositoryIdentity({ root, host, uuid: () => FIXED_UUID }),
		/symbolic link|symlink/i,
	);
	assert.equal(await fs.access(join(outside, "qlab", "repository-id")).then(() => true, () => false), false);

	const leafRoot = await repository(t);
	await mkdir(join(leafRoot, ".git", "qlab"));
	const outsideIdentity = join(outside, "outside-id");
	await writeFile(outsideIdentity, "outside-sentinel\n");
	await symlink(outsideIdentity, join(leafRoot, ".git", "qlab", "repository-id"));
	await assert.rejects(
		QLab.createQLabRepositoryIdentity({ root: leafRoot, host, uuid: () => FIXED_UUID }),
		/symbolic link|symlink/i,
	);
	assert.equal(await readFile(outsideIdentity, "utf8"), "outside-sentinel\n");
});

test("repository identity resolves an in-root Git worktree private path and rejects an out-of-root path", async (t) => {
	const QLab = await loadQLab();
	const root = await repository(t);
	await rm(join(root, ".git"), { recursive: true });
	await mkdir(join(root, ".git-private", "worktrees", "current"), { recursive: true });
	await writeFile(join(root, ".git"), "gitdir: .git-private/worktrees/current\n");
	const host = QLab.createNodeQLabRepositoryHost(fs, path);
	const result = await QLab.createQLabRepositoryIdentity({ root, host, uuid: () => FIXED_UUID });
	assert.equal(result.path, join(root, ".git-private", "worktrees", "current", "qlab", "repository-id"));

	const rejected = await repository(t);
	await rm(join(rejected, ".git"), { recursive: true });
	await writeFile(join(rejected, ".git"), `gitdir: ${join(root, ".git-private")}\n`);
	await assert.rejects(
		QLab.createQLabRepositoryIdentity({ root: rejected, host, uuid: () => OTHER_UUID }),
		/outside|root/i,
	);
});

test("repository identity uses an in-root Git common directory for linked worktrees", async (t) => {
	const QLab = await loadQLab();
	const root = await repository(t);
	await rm(join(root, ".git"), { recursive: true });
	await mkdir(join(root, ".git-private", "worktrees", "current"), { recursive: true });
	await mkdir(join(root, ".git-private", "common"), { recursive: true });
	await writeFile(join(root, ".git"), "gitdir: .git-private/worktrees/current\n");
	await writeFile(join(root, ".git-private", "worktrees", "current", "commondir"), "../../common\n");
	const host = QLab.createNodeQLabRepositoryHost(fs, path);
	const result = await QLab.createQLabRepositoryIdentity({ root, host, uuid: () => FIXED_UUID });
	assert.equal(result.path, join(root, ".git-private", "common", "qlab", "repository-id"));
});

test("repository identity requires a canonical absolute root and a valid generated UUID", async (t) => {
	const QLab = await loadQLab();
	const root = await repository(t);
	const host = QLab.createNodeQLabRepositoryHost(fs, path);
	await assert.rejects(
		QLab.createQLabRepositoryIdentity({ root: path.relative(process.cwd(), root), host, uuid: () => FIXED_UUID }),
		/absolute|canonical/i,
	);
	await assert.rejects(
		QLab.createQLabRepositoryIdentity({ root, host, uuid: () => "INVALID" }),
		/uuid/i,
	);
});

test("repository identity does not chmod an existing valid identity", async (t) => {
	const QLab = await loadQLab();
	const root = await repository(t);
	const host = QLab.createNodeQLabRepositoryHost(fs, path);
	await mkdir(join(root, ".git", "qlab"));
	const identityPath = join(root, ".git", "qlab", "repository-id");
	await writeFile(identityPath, `${FIXED_UUID}\n`, { mode: 0o640 });
	await chmod(identityPath, 0o640);
	const result = await QLab.createQLabRepositoryIdentity({ root, host, uuid: () => OTHER_UUID });
	assert.equal(result.identity, FIXED_UUID);
	assert.equal((await lstat(identityPath)).mode & 0o777, 0o640);
});

test("repository identity creation revalidates its private parent after a race", async (t) => {
	const QLab = await loadQLab();
	const root = await repository(t);
	const outside = await mkdtemp(join(tmpdir(), "chatero-identity-race-outside-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	const privateParent = join(root, ".git", "qlab");
	let attacked = false;
	const racingFs = new Proxy(fs, {
		get(source, property) {
			if (property === "lstat") {
				return async target => {
					const result = await fs.lstat(target);
					if (!attacked && target === privateParent && result.isDirectory()) {
						attacked = true;
						await rm(privateParent, { recursive: true });
						await symlink(outside, privateParent);
					}
					return result;
				};
			}
			const value = Reflect.get(source, property);
			return typeof value === "function" ? value.bind(source) : value;
		},
	});
	const host = QLab.createNodeQLabRepositoryHost(racingFs, path);

	await assert.rejects(
		QLab.createQLabRepositoryIdentity({ root, host, uuid: () => FIXED_UUID }),
		/symbolic|outside|ancestor|parent/i,
	);
	assert.equal(attacked, true);
	assert.equal(
		await fs.access(join(outside, "repository-id")).then(() => true, () => false),
		false,
	);
});
