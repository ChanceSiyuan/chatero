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
	
	Zotero.QLab.QLAB_STARTER_MARKER = QLAB_STARTER_MARKER;
	Zotero.QLab.QLAB_REQUIRED_ENTRIES = REQUIRED_ENTRIES.slice();
	Zotero.QLab.QLAB_WRITABLE_ROOTS = WRITABLE_ROOTS.slice();
	
	/**
	 * @typedef {{
	 *   exists: (path: string) => Promise<boolean>,
	 *   realPath: (path: string) => Promise<string>,
	 *   entries: (path: string) => Promise<string[]>,
	 *   join: (...parts: string[]) => string,
	 *   filename: (path: string) => string,
	 * }} QLabPathHost
	 */
	
	Zotero.QLab.isQLabRepositoryShape = async function (root, host) {
		if (!root || !String(root).trim()) {
			return false;
		}
		let checks = await Promise.all(
			REQUIRED_ENTRIES.map(entry => host.exists(host.join(root, entry)))
		);
		return checks.every(Boolean);
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
		if (await host.exists(host.join(root, QLAB_STARTER_MARKER))) {
			return 'partial';
		}
		let entries = (await host.entries(root))
			.map(entry => host.filename(entry))
			.filter(entry => !IGNORABLE_EMPTY.has(entry));
		if (!entries.length) {
			return 'empty';
		}
		return entries.every(entry => SAFE_PARTIAL_TREES.has(entry))
			? 'partial'
			: 'incompatible';
	};
	
	/**
	 * Reject path traversal and option-like segments for workspace-relative paths.
	 */
	Zotero.QLab.isSafeWorkspaceRelativePath = function (relativePath, { under } = {}) {
		let normalized = String(relativePath || '').replace(/\\/g, '/');
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
		let normalized = String(relativePath || '').replace(/\\/g, '/');
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
			join: (...parts) => pathModule.join(...parts),
			filename: (p) => pathModule.basename(p),
		};
	};
	
	Zotero.QLab.createGeckoQLabPathHost = function () {
		return {
			exists: path => IOUtils.exists(path),
			entries: path => IOUtils.getChildren(path),
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
