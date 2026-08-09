/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Chance Siyuan / Chatero contributors

	This file is part of Chatero (a Zotero fork).

	***** END LICENSE BLOCK *****
*/

Zotero.QLab = Zotero.QLab || {};

(function () {
	const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	const MAX_IDENTITY_BYTES = 128;

	function requireCanonicalAbsoluteRoot(root, canonical, host) {
		if (!root || typeof host.isAbsolute !== 'function' || !host.isAbsolute(root)) {
			throw new Error('QLab repository root must be an absolute canonical path');
		}
		let normalized = host.normalize(root);
		if (normalized !== canonical || normalized !== root.replace(/[\\/]+$/, '')) {
			throw new Error('QLab repository root must be an absolute canonical path');
		}
	}

	function parsePrivatePathFile(value, label) {
		let text = String(value || '');
		if (!text || text.includes('\0') || text.includes('\r') || !text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
			throw new Error(`Invalid Git ${label} path`);
		}
		let path = text.slice(0, -1);
		if (!path || path !== path.trim()) throw new Error(`Invalid Git ${label} path`);
		return path;
	}

	function assertInside(root, candidate, host) {
		if (!host.isPathInside(root, candidate)) {
			throw new Error('Git-private repository identity path is outside the repository root');
		}
	}

	async function resolveGitPrivatePath(root, host) {
		if (typeof host.gitPrivatePath === 'function') {
			let raw = await host.gitPrivatePath(root);
			if (typeof raw !== 'string' || raw !== raw.trim() || raw.includes('\0') || /[\r\n]/.test(raw)) {
				throw new Error('Invalid Git-private repository identity path');
			}
			let candidate = host.resolvePath(root, raw);
			assertInside(root, candidate, host);
			return candidate;
		}
		let dotGit = host.join(root, '.git');
		await host.assertNoSymlinkComponents(root, dotGit, { allowLeafFile: true });
		let kind = await host.kind(dotGit);
		let gitDirectory;
		if (kind === 'directory') {
			gitDirectory = dotGit;
		}
		else if (kind === 'file') {
			let pointer = parsePrivatePathFile(await host.readTextNoFollow(dotGit, 4096), 'worktree');
			if (!pointer.startsWith('gitdir: ')) throw new Error('Invalid Git worktree path');
			gitDirectory = host.resolvePath(root, pointer.slice('gitdir: '.length));
			assertInside(root, gitDirectory, host);
			await host.assertNoSymlinkComponents(root, gitDirectory);
		}
		else {
			throw new Error('Git-private repository identity is unavailable');
		}
		let commonFile = host.join(gitDirectory, 'commondir');
		if (await host.existsNoFollow(commonFile)) {
			await host.assertNoSymlinkComponents(root, commonFile, { allowLeafFile: true });
			let common = parsePrivatePathFile(await host.readTextNoFollow(commonFile, 4096), 'common directory');
			gitDirectory = host.resolvePath(gitDirectory, common);
			assertInside(root, gitDirectory, host);
			await host.assertNoSymlinkComponents(root, gitDirectory);
		}
		let candidate = host.join(gitDirectory, 'qlab', 'repository-id');
		assertInside(root, candidate, host);
		return candidate;
	}

	function validatedIdentity(value) {
		let text = String(value || '');
		if (text.length > MAX_IDENTITY_BYTES) {
			throw new Error('Existing repository identity is oversized');
		}
		if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
			throw new Error('Existing repository identity is invalid');
		}
		let identity = text.slice(0, -1);
		if (!UUID_PATTERN.test(identity)) throw new Error('Existing repository identity is invalid');
		return identity;
	}

	Zotero.QLab.createQLabRepositoryIdentity = async function ({ root, host, uuid }) {
		if (!host || typeof uuid !== 'function') throw new Error('QLab repository identity requires a host and UUID source');
		let canonical = await host.realPath(root);
		canonical = host.normalize(canonical).replace(/[\\/]+$/, '');
		requireCanonicalAbsoluteRoot(root, canonical, host);
		let path = await resolveGitPrivatePath(canonical, host);
		await host.assertNoSymlinkComponents(canonical, path, { allowMissingParent: true, allowMissingLeaf: true });
		let existing = await host.readPrivateNoFollow(path, MAX_IDENTITY_BYTES + 1);
		if (existing !== null) {
			return Object.freeze({ identity: validatedIdentity(existing), path, created: false });
		}
		let generated = String(await uuid()).toLowerCase();
		if (!UUID_PATTERN.test(generated)) throw new Error('Generated repository UUID is invalid');
		let outcome = await host.createPrivateIfAbsent(path, `${generated}\n`, 0o600, 0o700);
		let winner = await host.readPrivateNoFollow(path, MAX_IDENTITY_BYTES + 1);
		if (winner === null) throw new Error('Repository identity creation did not produce a readable identity');
		return Object.freeze({ identity: validatedIdentity(winner), path, created: outcome === 'created' });
	};

	Zotero.QLab.createNodeQLabRepositoryHost = function (fs, pathModule) {
		function normalized(path) {
			return pathModule.normalize(path);
		}
		function isInside(root, candidate) {
			let relative = pathModule.relative(root, candidate);
			return relative === '' || (!relative.startsWith('..' + pathModule.sep) && relative !== '..' && !pathModule.isAbsolute(relative));
		}
		async function kind(target) {
			try {
				let stat = await fs.lstat(target);
				if (stat.isSymbolicLink()) return 'symlink';
				if (stat.isDirectory()) return 'directory';
				if (stat.isFile()) return 'file';
				return 'other';
			}
			catch (error) {
				if (error && error.code === 'ENOENT') return 'missing';
				throw error;
			}
		}
		async function assertNoSymlinkComponents(root, target, options = {}) {
			let candidate = normalized(target);
			if (!isInside(root, candidate)) throw new Error('Path is outside the repository root');
			let relative = pathModule.relative(root, candidate);
			let current = root;
			let components = relative ? relative.split(pathModule.sep) : [];
			for (let index = 0; index < components.length; index++) {
				current = pathModule.join(current, components[index]);
				let value = await kind(current);
				let leaf = index === components.length - 1;
				if (value === 'symlink') throw new Error(`Symbolic link refused at ${current}`);
				if (value === 'missing') {
					if ((leaf && options.allowMissingLeaf) || options.allowMissingParent) return;
					throw new Error(`Private path component is missing at ${current}`);
				}
				if (!leaf && value !== 'directory') throw new Error(`Private path ancestor is not a directory at ${current}`);
			}
		}
		async function readTextNoFollow(p, maxBytes) {
			let handle = await fs.open(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
			try {
				let stat = await handle.stat();
				if (stat.size > maxBytes) throw new Error('Private file is oversized');
				return await handle.readFile({ encoding: 'utf8' });
			}
			finally { await handle.close(); }
		}
		return {
			exists: async p => (await kind(p)) !== 'missing',
			existsNoFollow: async p => (await kind(p)) !== 'missing',
			realPath: p => fs.realpath(p),
			normalize: normalized,
			isAbsolute: p => pathModule.isAbsolute(p),
			isPathInside: isInside,
			resolvePath: (base, value) => normalized(pathModule.isAbsolute(value) ? value : pathModule.resolve(base, value)),
			join: (...parts) => pathModule.join(...parts),
			kind,
			assertNoSymlinkComponents,
			readTextNoFollow,
			readPrivateNoFollow: async (p, maxBytes) => {
				try {
					await assertNoSymlinkComponents(pathModule.parse(p).root, p, { allowMissingParent: true, allowMissingLeaf: true });
					return await readTextNoFollow(p, maxBytes);
				}
				catch (error) {
					if (error && error.code === 'ENOENT') return null;
					throw error;
				}
			},
			createPrivateIfAbsent: async (p, value, mode, directoryMode) => {
				let parent = pathModule.dirname(p);
				await fs.mkdir(parent, { recursive: true, mode: directoryMode });
				await assertNoSymlinkComponents(pathModule.parse(p).root, parent);
				let handle;
				try {
					handle = await fs.open(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode);
				}
				catch (error) {
					if (error && error.code === 'EEXIST') return 'exists';
					throw error;
				}
				try { await handle.writeFile(value, { encoding: 'utf8' }); await handle.sync(); }
				finally { await handle.close(); }
				return 'created';
			},
		};
	};
})();
