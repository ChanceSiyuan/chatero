/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Draft QMD IO: list / read / write / prepare working copy / Keep.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	function joinRoot(root, relative) {
		let base = String(root || '').replace(/[\\/]+$/, '');
		let rel = String(relative || '').replace(/^[/\\]+/, '');
		return `${base}/${rel}`;
	}
	
	function simpleHash(text) {
		let h = 2166136261;
		let value = String(text ?? '');
		for (let i = 0; i < value.length; i++) {
			h ^= value.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return (h >>> 0).toString(16);
	}
	
	Zotero.QLab.QmdDraftIO = {
		_hash: simpleHash,
		
		async listDrafts(root, host) {
			let draftsDir = joinRoot(root, 'drafts');
			if (!(await host.exists(draftsDir))) {
				return [];
			}
			let out = [];
			async function walk(dir, prefix) {
				let entries = await host.entries(dir);
				for (let entry of entries) {
					let name = host.filename(entry);
					if (!name || name.startsWith('.')) {
						continue;
					}
					let full = entry;
					let rel = prefix ? `${prefix}/${name}` : name;
					if (name.endsWith('.qmd')) {
						out.push(`drafts/${rel}`);
						continue;
					}
					try {
						let children = await host.entries(full);
						if (Array.isArray(children)) {
							await walk(full, rel);
						}
					}
					catch (e) {}
				}
			}
			await walk(draftsDir, '');
			return out.sort();
		},
		
		async readSource(root, relativePath, host) {
			let rel = String(relativePath || '');
			if (!rel.startsWith('drafts/') && !rel.startsWith('work/')) {
				throw new Error('Refusing to read outside drafts/ or work/');
			}
			if (rel.startsWith('drafts/')
					&& !Zotero.QLab.isSafeWorkspaceRelativePath(rel, { under: 'drafts' })) {
				throw new Error('Unsafe drafts path');
			}
			let text = await host.read(joinRoot(root, rel));
			return { path: rel, text, revision: simpleHash(text) };
		},
		
		async writeSource(root, relativePath, text, expectedRevision, host) {
			let rel = String(relativePath || '');
			let allowed = rel.startsWith('drafts/')
				|| rel.startsWith('work/qlab-zotero/draft-changes/');
			if (!allowed) {
				throw new Error('Refusing to write outside drafts/ or draft-changes/');
			}
			if (rel.startsWith('drafts/')
					&& !Zotero.QLab.isSafeWorkspaceRelativePath(rel, { under: 'drafts' })) {
				throw new Error('Unsafe drafts path');
			}
			let path = joinRoot(root, rel);
			if (expectedRevision) {
				let current = await host.read(path);
				if (simpleHash(current) !== expectedRevision) {
					throw new Error('Draft revision changed; reload before saving');
				}
			}
			await host.write(path, String(text ?? ''));
			return { path: rel, revision: simpleHash(String(text ?? '')) };
		},
		
		async prepareChange(root, relativePath, host) {
			let original = await this.readSource(root, relativePath, host);
			let token = simpleHash(`${relativePath}:${original.revision}:${Date.now()}`);
			let workingRel = `work/qlab-zotero/draft-changes/${token}/draft.qmd`;
			let workingAbs = joinRoot(root, workingRel);
			let workDir = workingAbs.replace(/\/draft\.qmd$/, '');
			await host.makeDir(workDir, { createAncestors: true });
			await host.write(workingAbs, original.text);
			await host.write(joinRoot(workDir, 'manifest.json'), JSON.stringify({
				originalPath: relativePath,
				revision: original.revision,
				createdAt: new Date().toISOString(),
			}, null, 2));
			return {
				originalPath: relativePath,
				workingPath: workingRel,
				revision: original.revision,
				text: original.text,
			};
		},
		
		async keepChange(root, state, host) {
			let plan = Zotero.QLab.DraftWorkingCopy.buildKeepPlan(state);
			let working = await host.read(joinRoot(root, plan.from));
			await this.writeSource(root, state.originalPath, working, plan.expectedRevision, host);
			return { kept: true, path: state.originalPath, revision: simpleHash(working) };
		},
		
		createGeckoHost() {
			return {
				exists: path => IOUtils.exists(path),
				entries: path => IOUtils.getChildren(path),
				filename: path => PathUtils.filename(path),
				read: path => IOUtils.readUTF8(path),
				write: (path, text) => IOUtils.writeUTF8(path, text),
				makeDir: (path, opts) => IOUtils.makeDirectory(path, {
					createAncestors: !!(opts && opts.createAncestors),
					ignoreExisting: true,
				}),
			};
		},
		
		createNodeHost(fs, pathModule) {
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
				entries: async (p) => {
					let names = await fs.readdir(p);
					return names.map(n => pathModule.join(p, n));
				},
				filename: (p) => pathModule.basename(p),
				read: (p) => fs.readFile(p, 'utf8'),
				write: (p, text) => fs.writeFile(p, text, 'utf8'),
				makeDir: (p, opts) => fs.mkdir(p, { recursive: !!(opts && opts.createAncestors) }),
			};
		},
	};
})();
