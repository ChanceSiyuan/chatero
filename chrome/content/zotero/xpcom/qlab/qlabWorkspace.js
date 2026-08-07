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
})();
