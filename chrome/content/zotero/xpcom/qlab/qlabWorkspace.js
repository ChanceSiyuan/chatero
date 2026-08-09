/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

Zotero.QLab = Zotero.QLab || {};

(function () {
	const REQUIRED_ENTRIES = ['AGENTS.md', 'qlab', 'literature', 'drafts', 'knowledge'];
	const QLAB_STARTER_MARKER = '.research-loop/starter.json';
	const IGNORABLE_EMPTY = new Set(['.DS_Store', '.git']);
	const SAFE_PARTIAL_TREES = new Set(['knowledge', 'drafts', 'literature']);
	const WRITABLE_ROOTS = ['drafts', 'literature', 'work'];
	const REQUIRED_ENTRY_KINDS = Object.freeze({
		'AGENTS.md': 'file',
		qlab: 'file',
		literature: 'directory',
		drafts: 'directory',
		knowledge: 'directory',
	});
	const KNOWN_STARTER_ENTRY_KINDS = Object.freeze({
		...REQUIRED_ENTRY_KINDS,
		'.gitignore': 'file',
		'.node-version': 'file',
		'CLAUDE.md': 'file',
		'Makefile': 'file',
		'README.md': 'file',
		'package-lock.json': 'file',
		'package.json': 'file',
		'schemas': 'directory',
		'skills': 'directory',
		'src': 'directory',
		'tsconfig.json': 'file',
		'vite.config.ts': 'file',
	});
	
	Zotero.QLab.QLAB_STARTER_MARKER = QLAB_STARTER_MARKER;
	Zotero.QLab.QLAB_REQUIRED_ENTRIES = REQUIRED_ENTRIES.slice();
	Zotero.QLab.QLAB_WRITABLE_ROOTS = WRITABLE_ROOTS.slice();
	
	/**
	 * @typedef {{
	 *   exists: (path: string) => Promise<boolean>,
	 *   realPath: (path: string) => Promise<string>,
	 *   entries: (path: string) => Promise<string[]>,
	 *   stat: (path: string) => Promise<object>,
	 *   isSymlink: (path: string) => Promise<boolean>,
	 *   join: (...parts: string[]) => string,
	 *   filename: (path: string) => string,
	 * }} QLabPathHost
	 */
	
	function statKind(stat) {
		if (stat && typeof stat.isFile === 'function' && stat.isFile()) {
			return 'file';
		}
		if (stat && typeof stat.isDirectory === 'function' && stat.isDirectory()) {
			return 'directory';
		}
		if (stat && (stat.type === 'file' || stat.type === 'regular')) {
			return 'file';
		}
		if (stat && stat.type === 'directory') {
			return 'directory';
		}
		return '';
	}

	async function pathKind(path, host) {
		if (!host || typeof host.stat !== 'function') {
			return '';
		}
		try {
			return statKind(await host.stat(path));
		}
		catch {
			return '';
		}
	}

	async function pathIsSymlink(path, host) {
		if (!host || typeof host.isSymlink !== 'function') {
			return false;
		}
		try {
			return Boolean(await host.isSymlink(path));
		}
		catch {
			return false;
		}
	}

	async function rootEntries(root, host) {
		try {
			return await host.entries(root);
		}
		catch {
			return [];
		}
	}

	async function preservedTopLevel(root, host) {
		let preserved = [];
		for (let entry of SAFE_PARTIAL_TREES) {
			let path = host.join(root, entry);
			if (await host.exists(path)
				&& !(await pathIsSymlink(path, host))
				&& (await pathKind(path, host)) === 'directory') {
				preserved.push(entry);
			}
		}
		return preserved.sort();
	}

	async function hasStarterMarker(root, host) {
		let marker = host.join(root, QLAB_STARTER_MARKER);
		return (await host.exists(marker))
			&& !(await pathIsSymlink(marker, host))
			&& (await pathKind(marker, host)) === 'file';
	}

	async function isEmptyReceiptBootstrap(entryPath, host) {
		if (await pathIsSymlink(entryPath, host) || (await pathKind(entryPath, host)) !== 'directory') {
			return false;
		}
		try {
			return (await host.entries(entryPath)).length === 0;
		}
		catch {
			return false;
		}
	}

	async function isRecognizedPartialEntry(entryPath, root, host) {
		let entry = host.filename(entryPath);
		let expectedKind = REQUIRED_ENTRY_KINDS[entry];
		if (expectedKind
			&& !(await pathIsSymlink(entryPath, host))
			&& (await pathKind(entryPath, host)) === expectedKind) {
			return true;
		}
		let knownKind = KNOWN_STARTER_ENTRY_KINDS[entry];
		if (knownKind
			&& await hasStarterMarker(root, host)
			&& !(await pathIsSymlink(entryPath, host))
			&& (await pathKind(entryPath, host)) === knownKind) {
			return true;
		}
		return entry === '.research-loop'
			&& (!(await pathIsSymlink(entryPath, host))
				&& (await pathKind(entryPath, host)) === 'directory')
			&& (await hasStarterMarker(root, host) || await isEmptyReceiptBootstrap(entryPath, host));
	}

	async function repositoryConflicts(root, host) {
		let conflicts = [];
		for (let entryPath of await rootEntries(root, host)) {
			let entry = host.filename(entryPath);
			if (IGNORABLE_EMPTY.has(entry)) {
				continue;
			}
			if (await isRecognizedPartialEntry(entryPath, root, host)) {
				continue;
			}
			conflicts.push(entry);
		}
		return conflicts.sort();
	}

	async function inspectionFingerprint(root, host) {
		let snapshot = [];
		for (let entryPath of await rootEntries(root, host)) {
			let stat = null;
			try {
				stat = await host.stat(entryPath);
			}
			catch {}
			snapshot.push({
				name: host.filename(entryPath),
				kind: statKind(stat),
				symlink: await pathIsSymlink(entryPath, host),
				size: Number(stat && stat.size) || 0,
				modified: Number(stat && (stat.mtimeMs || stat.lastModified)) || 0,
			});
		}
		snapshot.sort((a, b) => a.name.localeCompare(b.name));
		return JSON.stringify({ root, snapshot });
	}

	Zotero.QLab.isQLabRepositoryShape = async function (root, host) {
		if (!root || !String(root).trim()) {
			return false;
		}
		for (let entry of REQUIRED_ENTRIES) {
			let path = host.join(root, entry);
			if (!(await host.exists(path))
				|| await pathIsSymlink(path, host)
				|| (await pathKind(path, host)) !== REQUIRED_ENTRY_KINDS[entry]) {
				return false;
			}
		}
		return true;
	};
	
	Zotero.QLab.normalizeQLabRoot = async function (value, host) {
		let trimmed = String(value || '').trim().replace(/[\\/]+$/, '');
		if (!trimmed) {
			return '';
		}
		return (await host.realPath(trimmed)).replace(/[\\/]+$/, '');
	};
	
	/**
	 * @returns {Promise<'missing'|'ready'|'empty'|'partial'|'incompatible'>}
	 */
	Zotero.QLab.qlabRepositoryState = async function (root, host) {
		if (!root || !String(root).trim()) {
			return 'missing';
		}
		if (await Zotero.QLab.isQLabRepositoryShape(root, host)) {
			return 'ready';
		}
		let entryPaths = await rootEntries(root, host);
		if (await Promise.all(entryPaths.map(entry => pathIsSymlink(entry, host))).then(checks => checks.some(Boolean))) {
			return 'incompatible';
		}
		let entries = entryPaths
			.map(entry => host.filename(entry))
			.filter(entry => !IGNORABLE_EMPTY.has(entry));
		if (!entries.length) {
			return 'empty';
		}
		let recognized = await Promise.all(entryPaths.map(async entry => (
			IGNORABLE_EMPTY.has(host.filename(entry))
				|| await isRecognizedPartialEntry(entry, root, host)
		)));
		if (!recognized.every(Boolean)) {
			return 'incompatible';
		}
		if (await hasStarterMarker(root, host)) {
			return 'partial';
		}
		return entries.every(entry => SAFE_PARTIAL_TREES.has(entry) || entry === '.research-loop')
			? 'partial'
			: 'incompatible';
	};

	Zotero.QLab.inspectQLabRepository = async function (root, host) {
		let canonicalRoot = await Zotero.QLab.normalizeQLabRoot(root, host);
		let state = await Zotero.QLab.qlabRepositoryState(canonicalRoot, host);
		return Object.freeze({
			root: canonicalRoot,
			state,
			preserved: Object.freeze(await preservedTopLevel(canonicalRoot, host)),
			conflicts: Object.freeze(await repositoryConflicts(canonicalRoot, host)),
			fingerprint: await inspectionFingerprint(canonicalRoot, host),
		});
	};
	
	/**
	 * Reject path traversal and option-like segments for workspace-relative paths.
	 */
	Zotero.QLab.isSafeWorkspaceRelativePath = function (relativePath, { under } = {}) {
		let normalized = String(relativePath || '');
		if (normalized.includes('\\')) {
			return false;
		}
		if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
			return false;
		}
		let segments = normalized.split('/');
		if (!segments.every(segment => segment
			&& segment !== '.'
			&& segment !== '..'
			&& !segment.startsWith('-'))) {
			return false;
		}
		if (under) {
			let prefix = String(under).replace(/\/$/, '');
			if (normalized !== prefix && !normalized.startsWith(prefix + '/')) {
				return false;
			}
		}
		return true;
	};
	
	Zotero.QLab.isAgentWritableRelativePath = function (relativePath) {
		let normalized = String(relativePath || '');
		if (normalized.includes('\\')) {
			return false;
		}
		let root = WRITABLE_ROOTS.find(name => (
			normalized === name || normalized.startsWith(name + '/')
		));
		if (!root) {
			return false;
		}
		return Zotero.QLab.isSafeWorkspaceRelativePath(normalized);
	};
	
	Zotero.QLab.createNodeQLabPathHost = function (fs, pathModule) {
		return {
			exists: async (p) => {
				try {
					await fs.access(p);
					return true;
				}
				catch {
					return false;
				}
			},
			realPath: async (p) => fs.realpath(p),
			entries: async (p) => {
				let names = await fs.readdir(p);
				return names.map(name => pathModule.join(p, name));
			},
			stat: p => fs.lstat(p),
			isSymlink: async (p) => (await fs.lstat(p)).isSymbolicLink(),
			join: (...parts) => pathModule.join(...parts),
			filename: (p) => pathModule.basename(p),
		};
	};
	
	Zotero.QLab.createGeckoQLabPathHost = function () {
		return {
			exists: path => IOUtils.exists(path),
			entries: path => IOUtils.getChildren(path),
			stat: path => IOUtils.stat(path),
			isSymlink: async (path) => {
				let file = Components.classes['@mozilla.org/file/local;1']
					.createInstance(Components.interfaces.nsIFile);
				file.initWithPath(path);
				return typeof file.isSymlink === 'function' && file.isSymlink();
			},
			realPath: async (path) => {
				let file = Components.classes['@mozilla.org/file/local;1']
					.createInstance(Components.interfaces.nsIFile);
				file.initWithPath(path);
				file.normalize();
				return String(file.path || path);
			},
			join: (...parts) => PathUtils.join(...parts),
			filename: path => PathUtils.filename(path),
		};
	};

	Zotero.QLab.joinWorkspacePath = function (root, rel) {
		let a = String(root || '').replace(/[\\/]+$/, '');
		let b = String(rel || '').replace(/^[/\\]+/, '');
		if (typeof PathUtils !== 'undefined') {
			return PathUtils.join(a, b);
		}
		return `${a}/${b}`;
	};

	Zotero.QLab.readWorkspaceRel = async function (root, rel, host, { maxChars = 256_000 } = {}) {
		if (!root || !rel || !host) {
			return '';
		}
		let abs = Zotero.QLab.joinWorkspacePath(root, rel);
		let text = '';
		if (typeof host.read === 'function') {
			text = await host.read(abs);
		}
		else if (typeof IOUtils !== 'undefined') {
			text = await IOUtils.readUTF8(abs);
		}
		text = String(text || '');
		if (maxChars && text.length > maxChars) {
			return text.slice(0, maxChars);
		}
		return text;
	};

	Zotero.QLab.writeWorkspaceRel = async function (root, rel, body, host) {
		if (!root || !rel || !host) {
			return;
		}
		let abs = Zotero.QLab.joinWorkspacePath(root, rel);
		if (typeof host.write === 'function') {
			await host.write(abs, body);
			return;
		}
		if (typeof IOUtils !== 'undefined') {
			let dir = PathUtils.parent(abs);
			await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
			await IOUtils.writeUTF8(abs, body);
		}
	};

	/**
	 * List relative file paths under a workspace prefix (recursive).
	 */
	Zotero.QLab.walkWorkspaceRelPaths = async function (root, prefix, host, {
		extensions = [],
		maxDepth = 6,
	} = {}) {
		if (!root || !prefix || !host || !host.entries) {
			return [];
		}
		let extSet = new Set(extensions.map(e => String(e).toLowerCase()));
		let out = [];
		async function walk(absDir, relDir, depth) {
			if (depth > maxDepth) {
				return;
			}
			let children = [];
			try {
				children = await host.entries(absDir);
			}
			catch (e) {
				return;
			}
			for (let childAbs of children) {
				let name = host.filename(childAbs);
				if (name.startsWith('.')) {
					continue;
				}
				let rel = relDir ? `${relDir}/${name}` : name;
				let sub = null;
				try {
					sub = await host.entries(childAbs);
				}
				catch (e) {
					sub = null;
				}
				if (Array.isArray(sub)) {
					await walk(childAbs, rel, depth + 1);
					continue;
				}
				if (!extSet.size) {
					out.push(rel);
					continue;
				}
				let lower = name.toLowerCase();
				for (let ext of extSet) {
					if (lower.endsWith(ext)) {
						out.push(rel);
						break;
					}
				}
			}
		}
		let startAbs = Zotero.QLab.joinWorkspacePath(root, prefix.replace(/\/$/, ''));
		try {
			if (!(await host.exists(startAbs))) {
				return [];
			}
			await walk(startAbs, prefix.replace(/\/$/, ''), 0);
		}
		catch (e) {}
		return out;
	};
})();
