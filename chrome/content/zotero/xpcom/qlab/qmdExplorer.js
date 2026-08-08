/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Sandboxed QLab Explorer snapshots and bounded polling.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const ROOTS = [
		{ name: 'drafts', writable: true, extensions: ['.qmd'] },
		{ name: 'knowledge', writable: false, extensions: ['.qmd'] },
		{ name: 'literature', writable: false, extensions: ['.qmd', '.bib', '.pdf'] },
	];
	
	function normalizePath(value) {
		return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
	}
	
	function isInside(root, child) {
		let base = normalizePath(root);
		let target = normalizePath(child);
		return target === base || target.startsWith(base + '/');
	}
	
	function extensionAllowed(name, extensions) {
		let lower = String(name || '').toLowerCase();
		return extensions.some(extension => lower.endsWith(extension));
	}
	
	function fileKind(name) {
		let lower = String(name || '').toLowerCase();
		if (lower.endsWith('.qmd')) return 'qmd';
		if (lower.endsWith('.bib')) return 'bib';
		if (lower.endsWith('.pdf')) return 'pdf';
		return 'file';
	}
	
	async function safeRealPath(path, host) {
		try {
			return await host.realPath(path);
		}
		catch (e) {
			return '';
		}
	}
	
	async function fileRevision(path, host) {
		try {
			let stat = await host.stat(path);
			return `${stat.size || 0}:${stat.lastModified || 0}`;
		}
		catch (e) {
			try {
				let text = await host.read(path);
				return Zotero.QLab.QmdDraftIO && Zotero.QLab.QmdDraftIO._hash
					? Zotero.QLab.QmdDraftIO._hash(text)
					: String(text).length.toString(16);
			}
			catch (readError) {
				return '';
			}
		}
	}
	
	async function buildRoot(root, definition, host) {
		let absoluteRoot = host.join(root, definition.name);
		let node = {
			path: definition.name,
			name: definition.name,
			kind: 'root',
			writable: definition.writable,
			children: [],
			revision: '',
		};
		if (!(await host.exists(absoluteRoot))) {
			return node;
		}
		let canonicalRoot = await safeRealPath(absoluteRoot, host);
		if (!canonicalRoot) {
			return node;
		}
		async function walk(absoluteDir, relativeDir, depth) {
			if (depth > 12) {
				return [];
			}
			let entries = [];
			try {
				entries = await host.entries(absoluteDir);
			}
			catch (e) {
				return [];
			}
			let children = [];
			for (let absoluteChild of entries) {
				let name = host.filename(absoluteChild);
				if (!name || name.startsWith('.')) {
					continue;
				}
				let canonicalChild = await safeRealPath(absoluteChild, host);
				if (!canonicalChild || !isInside(canonicalRoot, canonicalChild)) {
					continue;
				}
				let relativePath = `${relativeDir}/${name}`;
				let directory = false;
				try {
					directory = (await host.stat(canonicalChild)).type === 'directory';
				}
				catch (e) {
					try {
						await host.entries(canonicalChild);
						directory = true;
					}
					catch (entryError) {}
				}
				if (directory) {
					let nested = await walk(canonicalChild, relativePath, depth + 1);
					if (nested.length) {
						children.push({
							path: relativePath,
							name,
							kind: 'directory',
							writable: definition.writable,
							children: nested,
							revision: nested.map(item => item.revision).join('|'),
						});
					}
					continue;
				}
				if (!extensionAllowed(name, definition.extensions)) {
					continue;
				}
				children.push({
					path: relativePath,
					name,
					kind: fileKind(name),
					writable: definition.writable && name.toLowerCase().endsWith('.qmd'),
					children: [],
					revision: await fileRevision(canonicalChild, host),
				});
			}
			return children.sort((a, b) => {
				if (a.kind === 'directory' && b.kind !== 'directory') return -1;
				if (a.kind !== 'directory' && b.kind === 'directory') return 1;
				return a.name.localeCompare(b.name);
			});
		}
		node.children = await walk(canonicalRoot, definition.name, 0);
		node.revision = node.children.map(child => child.revision).join('|');
		return node;
	}
	
	Zotero.QLab.buildQmdExplorerSnapshot = async function (root, host) {
		if (!root || !host) {
			return [];
		}
		let trees = [];
		for (let definition of ROOTS) {
			trees.push(await buildRoot(root, definition, host));
		}
		return trees;
	};
	
	Zotero.QLab.createQmdExplorerWatcher = function ({
		readSnapshot,
		onChange = () => {},
		schedule = setTimeout,
		cancel = clearTimeout,
		activeInterval = 1000,
		idleInterval = 5000,
	} = {}) {
		if (typeof readSnapshot !== 'function') {
			throw new Error('QMD Explorer watcher requires readSnapshot');
		}
		let active = true;
		let disposed = false;
		let timer = null;
		let previous = null;
		let polling = null;
		async function poll() {
			if (disposed) {
				return;
			}
			if (polling) {
				return polling;
			}
			polling = (async () => {
				let snapshot = await readSnapshot();
				let serialized = JSON.stringify(snapshot);
				if (serialized !== previous) {
					previous = serialized;
					onChange(snapshot);
				}
			})();
			try {
				await polling;
			}
			finally {
				polling = null;
			}
			if (!disposed) {
				if (timer !== null) {
					cancel(timer);
				}
				timer = schedule(poll, active ? activeInterval : idleInterval);
			}
		}
		return {
			poll,
			start: poll,
			setActive(value) {
				active = !!value;
			},
			dispose() {
				disposed = true;
				if (timer !== null) {
					cancel(timer);
					timer = null;
				}
			},
		};
	};
	
	Zotero.QLab.createNodeQmdExplorerHost = function (fs, pathModule) {
		return {
			exists: async path => {
				try {
					await fs.access(path);
					return true;
				}
				catch (e) {
					return false;
				}
			},
			entries: async path => (await fs.readdir(path)).map(name => pathModule.join(path, name)),
			filename: path => pathModule.basename(path),
			join: (...parts) => pathModule.join(...parts),
			realPath: path => fs.realpath(path),
			read: path => fs.readFile(path, 'utf8'),
			stat: async path => {
				let value = await fs.stat(path);
				return {
					type: value.isDirectory() ? 'directory' : 'file',
					size: value.size,
					lastModified: value.mtimeMs,
				};
			},
		};
	};
	
	Zotero.QLab.createGeckoQmdExplorerHost = function () {
		let pathHost = Zotero.QLab.createGeckoQLabPathHost();
		return {
			...pathHost,
			read: path => IOUtils.readUTF8(path),
			stat: path => IOUtils.stat(path),
		};
	};
})();
