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

	const CHANGE_ROOT = 'work/qlab-zotero/draft-changes';

	function changeDirectory(relativePath) {
		let rel = String(relativePath || '').replace(/\\/g, '/');
		if (!Zotero.QLab.isSafeWorkspaceRelativePath(rel, { under: CHANGE_ROOT })
				|| !/\/draft\.qmd$/.test(rel)) {
			throw new Error('Unsafe Draft proposal path');
		}
		return rel.replace(/\/draft\.qmd$/, '');
	}

	async function proposalRecords(root, originalPath, host) {
		let changesPath = joinRoot(root, CHANGE_ROOT);
		if (!(await host.exists(changesPath))) return [];
		let entries = await host.entries(changesPath);
		let records = [];
		for (let entry of entries) {
			let token = host.filename(entry);
			if (!token || token.startsWith('.') || token.includes('/')) continue;
			let directory = `${CHANGE_ROOT}/${token}`;
			try {
				let manifest = JSON.parse(await host.read(joinRoot(root, `${directory}/manifest.json`)));
				if (manifest.originalPath !== originalPath) continue;
				records.push({
					...manifest,
					originalPath: manifest.originalPath,
					workingPath: manifest.workingPath || `${directory}/draft.qmd`,
					basePath: manifest.basePath || `${directory}/base.qmd`,
					revision: manifest.baseRevision || manifest.revision,
					directory,
				});
			}
			catch (error) {
				Zotero.debug && Zotero.debug(`Skipping invalid QLab Draft proposal: ${error}`);
			}
		}
		return records.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
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
			if (!rel.startsWith('drafts/') && !rel.startsWith(`${CHANGE_ROOT}/`)) {
				throw new Error('Refusing to read outside drafts/ or work/');
			}
			if (rel.startsWith('drafts/')
					&& !Zotero.QLab.isSafeWorkspaceRelativePath(rel, { under: 'drafts' })) {
				throw new Error('Unsafe drafts path');
			}
			if (rel.startsWith(`${CHANGE_ROOT}/`)
					&& !Zotero.QLab.isSafeWorkspaceRelativePath(rel, { under: CHANGE_ROOT })) {
				throw new Error('Unsafe Draft proposal path');
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
			if (rel.startsWith(`${CHANGE_ROOT}/`)
					&& !Zotero.QLab.isSafeWorkspaceRelativePath(rel, { under: CHANGE_ROOT })) {
				throw new Error('Unsafe Draft proposal path');
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
			let workingRel = `${CHANGE_ROOT}/${token}/draft.qmd`;
			let baseRel = `${CHANGE_ROOT}/${token}/base.qmd`;
			let workingAbs = joinRoot(root, workingRel);
			let workDir = workingAbs.replace(/\/draft\.qmd$/, '');
			await host.makeDir(workDir, { createAncestors: true });
			await host.write(joinRoot(root, baseRel), original.text);
			await host.write(workingAbs, original.text);
			await host.write(joinRoot(workDir, 'manifest.json'), JSON.stringify({
				schemaVersion: 2,
				originalPath: relativePath,
				workingPath: workingRel,
				basePath: baseRel,
				baseRevision: original.revision,
				revision: original.revision,
				createdAt: new Date().toISOString(),
			}, null, 2));
			if (typeof host.remove === 'function') {
				let records = await proposalRecords(root, relativePath, host);
				for (let record of records) {
					if (record.workingPath !== workingRel) {
						await host.remove(joinRoot(root, record.directory), { recursive: true });
					}
				}
			}
			return {
				originalPath: relativePath,
				workingPath: workingRel,
				basePath: baseRel,
				revision: original.revision,
				text: original.text,
			};
		},

		async findProposal(root, originalPath, host) {
			let records = await proposalRecords(root, originalPath, host);
			return records[0] || null;
		},
		
		async keepChange(root, state, host) {
			let plan = Zotero.QLab.DraftWorkingCopy.buildKeepPlan(state);
			let proposed = await host.read(joinRoot(root, plan.from));
			let current = await this.readSource(root, state.originalPath, host);
			let directory = changeDirectory(plan.from);
			let basePath = state.basePath || `${directory}/base.qmd`;
			let base = null;
			if (await host.exists(joinRoot(root, basePath))) {
				base = await host.read(joinRoot(root, basePath));
			}
			let review = base === null
				? { status: 'clean', text: proposed, hunks: [] }
				: Zotero.QLab.reviewQmdProposal({ base, current: current.text, proposed });
			if (review.status !== 'clean') {
				return { kept: false, conflict: true, review };
			}
			let saved = await this.writeSource(
				root,
				state.originalPath,
				review.text,
				base === null ? plan.expectedRevision : current.revision,
				host
			);
			if (typeof host.remove === 'function') {
				await host.remove(joinRoot(root, directory), { recursive: true });
			}
			return { kept: true, path: state.originalPath, revision: saved.revision, review };
		},

		async rejectChange(root, state, host) {
			let directory = changeDirectory(state && state.workingPath);
			if (typeof host.remove !== 'function') {
				throw new Error('Draft proposal host cannot remove review state');
			}
			await host.remove(joinRoot(root, directory), { recursive: true });
			return { rejected: true, path: state.originalPath };
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
				remove: (path, opts) => IOUtils.remove(path, {
					recursive: !!(opts && opts.recursive),
					ignoreAbsent: true,
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
				remove: (p, opts) => fs.rm(p, { recursive: !!(opts && opts.recursive), force: true }),
			};
		},
	};
})();
