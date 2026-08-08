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
	
	function legacyHash(text) {
		let h = 2166136261;
		let value = String(text ?? '');
		for (let i = 0; i < value.length; i++) {
			h ^= value.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return (h >>> 0).toString(16);
	}

	function hex32(value) {
		return (value >>> 0).toString(16).padStart(8, '0');
	}

	// A synchronous, platform-neutral 128-bit content revision. This is based on
	// four independently mixed 32-bit lanes, so it works in both Gecko and Node
	// without WebCrypto, Node crypto, or asynchronous APIs.
	function contentRevision(text) {
		let h1 = 1779033703;
		let h2 = 3144134277;
		let h3 = 1013904242;
		let h4 = 2773480762;
		let value = String(text ?? '');
		for (let i = 0; i < value.length; i++) {
			let code = value.charCodeAt(i);
			h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
			h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
			h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
			h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
		}
		h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
		h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
		h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
		h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
		return `v2-${hex32(h1 ^ h2 ^ h3 ^ h4)}${hex32(h2 ^ h1)}${hex32(h3 ^ h1)}${hex32(h4 ^ h1)}`;
	}

	function revisionMatches(text, revision) {
		let expected = String(revision || '');
		if (/^v2-[0-9a-f]{32}$/i.test(expected)) {
			return contentRevision(text) === expected.toLowerCase();
		}
		// Existing Draft sessions and manifests used an eight-character FNV-1a
		// token. Accept it for comparison, but always emit the stronger v2 form.
		return /^[0-9a-f]{1,8}$/i.test(expected)
			&& legacyHash(text) === expected.toLowerCase();
	}

	const CHANGE_ROOT = 'work/qlab-zotero/draft-changes';
	const pathMutexes = new Map();
	let todoRunSequence = 0;

	async function mutexKey(root, relativePath, host) {
		let canonicalRoot = stripTrailingSeparators(await host.realPath(root));
		return `${canonicalRoot}\0${String(relativePath || '').replace(/\\/g, '/')}`;
	}

	async function withPathMutex(root, relativePath, host, operation) {
		let key = await mutexKey(root, relativePath, host);
		let previous = pathMutexes.get(key) || Promise.resolve();
		let release;
		let current = new Promise(resolve => { release = resolve; });
		pathMutexes.set(key, current);
		await previous.catch(() => {});
		try {
			return await operation();
		}
		finally {
			release();
			if (pathMutexes.get(key) === current) {
				pathMutexes.delete(key);
			}
		}
	}

	function assertProposalOriginalPath(originalPath) {
		let rel = String(originalPath || '').replace(/\\/g, '/');
		if (!isSafeDraftQmdPath(rel)) {
			throw new Error('Unsafe Draft proposal original path');
		}
		return rel;
	}

	function withProposalMutex(root, originalPath, host, operation) {
		let rel = assertProposalOriginalPath(originalPath);
		return withPathMutex(root, `proposal-operation:${rel}`, host, operation);
	}

	function changeDirectory(relativePath) {
		let rel = String(relativePath || '').replace(/\\/g, '/');
		if (!Zotero.QLab.isSafeWorkspaceRelativePath(rel, { under: CHANGE_ROOT })
				|| !/\/draft\.qmd$/.test(rel)) {
			throw new Error('Unsafe Draft proposal path');
		}
		return rel.replace(/\/draft\.qmd$/, '');
	}

	function stripTrailingSeparators(value) {
		let path = String(value || '').replace(/[\\/]+$/u, '');
		return path || '/';
	}

	function isSafeDraftQmdPath(relativePath) {
		let rel = String(relativePath || '').replace(/\\/g, '/');
		return Zotero.QLab.isSafeWorkspaceRelativePath(rel, { under: 'drafts' })
			&& /\.qmd$/i.test(rel);
	}

	async function assertExactWorkspacePath(root, relativePath, boundary, host, label) {
		if (!host || typeof host.realPath !== 'function') {
			throw new Error(`${label} host cannot verify real paths`);
		}
		let [realRoot, realBoundary, realPath] = await Promise.all([
			host.realPath(root),
			host.realPath(joinRoot(root, boundary)),
			host.realPath(joinRoot(root, relativePath)),
		]);
		realRoot = stripTrailingSeparators(realRoot);
		realBoundary = stripTrailingSeparators(realBoundary);
		realPath = String(realPath || '');
		if (realBoundary !== `${realRoot}/${boundary}`
				|| realPath !== `${realRoot}/${relativePath}`) {
			throw new Error(`${label} uses a symbolic link or resolves outside its allowed directory`);
		}
	}

	async function assertSafeDraftPath(root, relativePath, host) {
		if (!isSafeDraftQmdPath(relativePath)) {
			throw new Error('Unsafe Draft path');
		}
		await assertExactWorkspacePath(root, relativePath, 'drafts', host, 'Draft');
	}

	function proposalDirectory(relativePath, filename) {
		let rel = String(relativePath || '').replace(/\\/g, '/');
		let suffix = `/${filename}`;
		if (!Zotero.QLab.isSafeWorkspaceRelativePath(rel, { under: CHANGE_ROOT })
				|| !rel.endsWith(suffix)) {
			throw new Error('Unsafe Draft proposal path');
		}
		return rel.slice(0, -suffix.length);
	}

	function proposalGeneration(directory) {
		let prefix = `${CHANGE_ROOT}/`;
		let rel = String(directory || '').replace(/\\/g, '/');
		let generation = rel.startsWith(prefix) ? rel.slice(prefix.length) : '';
		if (!generation || generation.includes('/') || !/^[a-z0-9-]+$/i.test(generation)) {
			throw new Error('Invalid Draft proposal generation');
		}
		return generation;
	}

	async function assertPrivateProposalFile(root, relativePath, filename, host) {
		let directory = proposalDirectory(relativePath, filename);
		await assertExactWorkspacePath(root, directory, CHANGE_ROOT, host, 'Private Draft proposal');
		await assertExactWorkspacePath(root, relativePath, directory, host, 'Private Draft proposal');
		return directory;
	}

	async function assertPrivateWorkingCopy(root, relativePath, host) {
		return assertPrivateProposalFile(root, relativePath, 'draft.qmd', host);
	}

	async function assertPrivateProposalBase(root, relativePath, host) {
		return assertPrivateProposalFile(root, relativePath, 'base.qmd', host);
	}

	async function assertPrivateProposalManifest(root, relativePath, host) {
		return assertPrivateProposalFile(root, relativePath, 'manifest.json', host);
	}

	async function ensureExactDirectory(root, relativePath, boundary, host, label) {
		let absolutePath = joinRoot(root, relativePath);
		if (!(await host.exists(absolutePath))) {
			try {
				await host.makeDir(absolutePath, { createAncestors: false });
			}
			catch (error) {
				// Another Draft operation may have created this shared parent after
				// exists(). Only suppress that race when a path now exists; the exact
				// real-path check below still rejects a replacement symlink.
				if (!(await host.exists(absolutePath))) {
					throw error;
				}
			}
		}
		await assertExactWorkspacePath(root, relativePath, boundary, host, label);
	}

	async function ensurePrivateChangeRoot(root, host) {
		// Never ask the filesystem to create ancestors recursively: doing so would
		// follow an attacker-controlled work/ or work/qlab-zotero symlink before a
		// later real-path check could reject it.
		await ensureExactDirectory(root, 'work', 'work', host, 'Private Draft work root');
		await ensureExactDirectory(
			root,
			'work/qlab-zotero',
			'work',
			host,
			'Private Draft application root'
		);
		await ensureExactDirectory(
			root,
			CHANGE_ROOT,
			'work/qlab-zotero',
			host,
			'Private Draft proposal root'
		);
	}

	function todoCompletionRunPaths(workingPath, token) {
		let proposal = changeDirectory(workingPath);
		let safeToken = String(token || '');
		if (!/^[a-z0-9-]+$/i.test(safeToken)) {
			throw new Error('Unsafe private Draft TODO completion token');
		}
		let todoRoot = `${proposal}/todo-action`;
		let directory = `${todoRoot}/${safeToken}`;
		return {
			proposal,
			todoRoot,
			token: safeToken,
			directory,
			inputPath: `${directory}/input.qmd`,
			outputPath: `${directory}/todo-completions.json`,
		};
	}

	async function assertTodoCompletionRun(root, run, host, options = {}) {
		let workingPath = String(run && run.workingPath || '');
		let proposal = await assertPrivateWorkingCopy(root, workingPath, host);
		let token = String(run && run.token || '');
		let expected = todoCompletionRunPaths(workingPath, token);
		if (proposal !== expected.proposal
				|| !run
				|| run.token !== expected.token
				|| run.directory !== expected.directory
				|| run.inputPath !== expected.inputPath
				|| run.outputPath !== expected.outputPath) {
			throw new Error('Unsafe private Draft TODO completion run');
		}
		await assertExactWorkspacePath(
			root,
			expected.todoRoot,
			expected.proposal,
			host,
			'Private Draft TODO completion root'
		);
		if (!options.allowMissingDirectory) {
			await assertExactWorkspacePath(
				root,
				expected.directory,
				expected.proposal,
				host,
				'Private Draft TODO completion run'
			);
		}
		return expected;
	}

	async function readCanonicalProposal(root, directory, expectedState, host) {
		let workingPath = `${directory}/draft.qmd`;
		let basePath = `${directory}/base.qmd`;
		let manifestPath = `${directory}/manifest.json`;
		await Promise.all([
			assertPrivateWorkingCopy(root, workingPath, host),
			assertPrivateProposalBase(root, basePath, host),
			assertPrivateProposalManifest(root, manifestPath, host),
		]);
		let manifest;
		try {
			manifest = JSON.parse(await host.read(joinRoot(root, manifestPath)));
		}
		catch (error) {
			throw new Error(`Draft proposal manifest integrity check failed: ${error}`);
		}
		let generation = proposalGeneration(directory);
		if (!manifest
				|| manifest.schemaVersion !== 2
				|| !isSafeDraftQmdPath(manifest.originalPath)
				|| manifest.workingPath !== workingPath
				|| manifest.basePath !== basePath
				|| typeof manifest.baseRevision !== 'string'
				|| manifest.baseRevision !== manifest.revision
				|| (manifest.generation != null && manifest.generation !== generation)) {
			throw new Error('Draft proposal manifest integrity check failed');
		}
		if (expectedState) {
			if (manifest.originalPath !== expectedState.originalPath
					|| workingPath !== expectedState.workingPath
					|| (expectedState.basePath && basePath !== expectedState.basePath)
					|| String(expectedState.revision || '') !== manifest.baseRevision
					|| (expectedState.generation != null
						&& String(expectedState.generation) !== generation)) {
				throw new Error('Draft proposal manifest no longer matches its immutable review state');
			}
		}
		let base = await host.read(joinRoot(root, basePath));
		if (!revisionMatches(base, manifest.baseRevision)) {
			throw new Error('Draft proposal base revision integrity check failed');
		}
		return { manifest, manifestPath, workingPath, basePath, base, generation };
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
				await assertExactWorkspacePath(root, directory, CHANGE_ROOT, host, 'Private Draft proposal');
				let canonical = await readCanonicalProposal(root, directory, null, host);
				let { manifest, workingPath, basePath, generation } = canonical;
				if (manifest.originalPath !== originalPath) continue;
				records.push({
					...manifest,
					originalPath: manifest.originalPath,
					workingPath,
					basePath,
					generation,
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

	async function writeSourceAtPath(root, relativePath, text, expectedRevision, host) {
		let rel = String(relativePath || '');
		let allowed = rel.startsWith('drafts/')
			|| rel.startsWith(`${CHANGE_ROOT}/`);
		if (!allowed) {
			throw new Error('Refusing to write outside drafts/ or draft-changes/');
		}
		if (rel.startsWith('drafts/')
				&& !Zotero.QLab.isSafeWorkspaceRelativePath(rel, { under: 'drafts' })) {
			throw new Error('Unsafe drafts path');
		}
		if (rel.startsWith('drafts/')) {
			await assertSafeDraftPath(root, rel, host);
		}
		if (rel.startsWith(`${CHANGE_ROOT}/`)
				&& !Zotero.QLab.isSafeWorkspaceRelativePath(rel, { under: CHANGE_ROOT })) {
			throw new Error('Unsafe Draft proposal path');
		}
		if (rel.startsWith(`${CHANGE_ROOT}/`) && /\/draft\.qmd$/.test(rel)) {
			await assertPrivateWorkingCopy(root, rel, host);
		}
		let path = joinRoot(root, rel);
		if (expectedRevision) {
			let current = await host.read(path);
			if (!revisionMatches(current, expectedRevision)) {
				throw new Error('Draft revision changed; reload before saving');
			}
		}
		await host.write(path, String(text ?? ''));
		return { path: rel, revision: contentRevision(String(text ?? '')) };
	}
	
	Zotero.QLab.QmdDraftIO = {
		_hash: contentRevision,
		
		async listDrafts(root, host) {
			let draftsDir = joinRoot(root, 'drafts');
			if (!(await host.exists(draftsDir))) {
				return [];
			}
			await assertExactWorkspacePath(root, 'drafts', 'drafts', host, 'Draft');
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
						let draftPath = `drafts/${rel}`;
						await assertSafeDraftPath(root, draftPath, host);
						out.push(draftPath);
						continue;
					}
					await assertExactWorkspacePath(root, `drafts/${rel}`, 'drafts', host, 'Draft');
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
			if (rel.startsWith('drafts/')) {
				await assertSafeDraftPath(root, rel, host);
			}
			if (rel.startsWith(`${CHANGE_ROOT}/`)
					&& !Zotero.QLab.isSafeWorkspaceRelativePath(rel, { under: CHANGE_ROOT })) {
				throw new Error('Unsafe Draft proposal path');
			}
			if (rel.startsWith(`${CHANGE_ROOT}/`) && /\/draft\.qmd$/.test(rel)) {
				await assertPrivateWorkingCopy(root, rel, host);
			}
			let text = await host.read(joinRoot(root, rel));
			return { path: rel, text, revision: contentRevision(text) };
		},
		
		async writeSource(root, relativePath, text, expectedRevision, host) {
			let rel = String(relativePath || '');
			if (rel.startsWith(`${CHANGE_ROOT}/`) && /\/draft\.qmd$/.test(rel)) {
				let directory = changeDirectory(rel);
				let initial = await readCanonicalProposal(root, directory, null, host);
				return withProposalMutex(root, initial.manifest.originalPath, host, async () => {
					let canonical = await readCanonicalProposal(root, directory, null, host);
					let saved = await withPathMutex(
						root,
						rel,
						host,
						() => writeSourceAtPath(root, rel, text, expectedRevision, host)
					);
					return { ...saved, generation: canonical.generation };
				});
			}
			return withPathMutex(
				root,
				rel,
				host,
				() => writeSourceAtPath(root, rel, text, expectedRevision, host)
			);
		},

		async writeProposal(root, state, text, expectedRevision, host) {
			let originalPath = assertProposalOriginalPath(state && state.originalPath);
			let workingPath = String(state && state.workingPath || '').replace(/\\/g, '/');
			let directory = changeDirectory(workingPath);
			return withProposalMutex(root, originalPath, host, async () => {
				let canonical = await readCanonicalProposal(root, directory, state, host);
				let saved = await withPathMutex(
					root,
					workingPath,
					host,
					() => writeSourceAtPath(root, workingPath, text, expectedRevision, host)
				);
				return { ...saved, generation: canonical.generation };
			});
		},
		
		async prepareChange(root, relativePath, host) {
			let originalPath = assertProposalOriginalPath(relativePath);
			return withProposalMutex(root, originalPath, host, () => withPathMutex(
				root,
				originalPath,
				host,
				async () => {
					let original = await this.readSource(root, relativePath, host);
					let existing = await this.findProposal(root, relativePath, host);
					if (existing) {
						let working = await this.readSource(root, existing.workingPath, host);
						let canonical = await readCanonicalProposal(root, existing.directory, existing, host);
						return {
							...existing,
							revision: existing.revision || original.revision,
							proposalRevision: working.revision,
							text: working.text,
							baseText: canonical.base,
							resumed: true,
						};
					}
					// Establish and verify the private boundary before copying any Draft
					// source into it. In particular, never follow a replacement symlink at
					// work/qlab-zotero/draft-changes.
					await ensurePrivateChangeRoot(root, host);
					let token = contentRevision(
						`${relativePath}:${original.revision}:${Date.now()}:${++todoRunSequence}`
					).slice(3);
					let workingRel = `${CHANGE_ROOT}/${token}/draft.qmd`;
					let baseRel = `${CHANGE_ROOT}/${token}/base.qmd`;
					let workingAbs = joinRoot(root, workingRel);
					let workDir = workingAbs.replace(/\/draft\.qmd$/, '');
					let generation = proposalGeneration(proposalDirectory(workingRel, 'draft.qmd'));
					await host.makeDir(workDir, { createAncestors: false });
					await assertExactWorkspacePath(
						root,
						proposalDirectory(workingRel, 'draft.qmd'),
						CHANGE_ROOT,
						host,
						'Private Draft proposal'
					);
					await host.write(joinRoot(root, baseRel), original.text);
					await host.write(workingAbs, original.text);
					await host.write(joinRoot(workDir, 'manifest.json'), JSON.stringify({
						schemaVersion: 2,
						originalPath: relativePath,
						workingPath: workingRel,
						basePath: baseRel,
						baseRevision: original.revision,
						revision: original.revision,
						generation,
						createdAt: new Date().toISOString(),
					}, null, 2));
					return {
						originalPath: relativePath,
						workingPath: workingRel,
						basePath: baseRel,
							generation,
							revision: original.revision,
							proposalRevision: original.revision,
							text: original.text,
						baseText: original.text,
						resumed: false,
					};
				}
			));
		},

		async findProposal(root, originalPath, host) {
			let records = await proposalRecords(root, originalPath, host);
			return records[0] || null;
		},

		async prepareTodoCompletionRun(root, state, source, host) {
			let workingPath = String(state && state.workingPath || '');
			let proposal = await assertPrivateWorkingCopy(root, workingPath, host);
			return withPathMutex(root, `${proposal}/todo-action`, host, async () => {
				await ensureExactDirectory(
					root,
					`${proposal}/todo-action`,
					proposal,
					host,
					'Private Draft TODO completion root'
				);
				let token = contentRevision(
					`${workingPath}:${Date.now()}:${++todoRunSequence}`
				).slice(3);
				let run = {
					...todoCompletionRunPaths(workingPath, token),
					workingPath,
				};
				let absoluteDirectory = joinRoot(root, run.directory);
				await host.makeDir(absoluteDirectory, { createAncestors: false });
				await assertExactWorkspacePath(
					root,
					run.directory,
					run.todoRoot,
					host,
					'Private Draft TODO completion run'
				);
				await host.write(joinRoot(root, run.inputPath), String(source ?? ''));
				await assertExactWorkspacePath(
					root,
					run.inputPath,
					run.directory,
					host,
					'Private Draft TODO completion input'
				);
				return {
					directory: run.directory,
					inputPath: run.inputPath,
					outputPath: run.outputPath,
					workingPath,
					token,
				};
			});
		},

		async readTodoCompletions(root, run, host) {
			let expected = await assertTodoCompletionRun(root, run, host);
			await assertExactWorkspacePath(
				root,
				expected.outputPath,
				expected.directory,
				host,
				'Private Draft TODO completion output'
			);
			return host.read(joinRoot(root, expected.outputPath));
		},

		async clearTodoCompletions(root, run, host) {
			let expected = await assertTodoCompletionRun(root, run, host, {
				allowMissingDirectory: true,
			});
			let absolutePath = joinRoot(root, expected.directory);
			if (typeof host.remove !== 'function') {
				if (await host.exists(absolutePath)) {
					throw new Error('Draft proposal host cannot clear TODO completion state');
				}
			}
			else {
				// Remove the lexical child itself. Do not resolve it first: if an attacker
				// replaced the staging directory with a symlink, the link is discarded
				// without traversing into its target.
				await host.remove(absolutePath, { recursive: true });
			}
			return { cleared: true, path: expected.directory };
		},

		async keepChange(root, state, host) {
			let plan = Zotero.QLab.DraftWorkingCopy.buildKeepPlan(state);
			let originalPath = assertProposalOriginalPath(state && state.originalPath);
			return withProposalMutex(root, originalPath, host, async () => {
				let directory = await assertPrivateWorkingCopy(root, plan.from, host);
				let canonical = await readCanonicalProposal(root, directory, state, host);
				let proposed = await host.read(joinRoot(root, plan.from));
				let current = await this.readSource(root, canonical.manifest.originalPath, host);
				let review = Zotero.QLab.reviewQmdProposal({
					base: canonical.base,
					current: current.text,
					proposed,
				});
				if (review.status !== 'clean') {
					return {
						kept: false,
						conflict: true,
						generation: canonical.generation,
						review,
					};
				}
				let saved = await this.writeSource(
					root,
					canonical.manifest.originalPath,
					review.text,
					current.revision,
					host
				);
				if (typeof host.remove === 'function') {
					await host.remove(joinRoot(root, directory), { recursive: true });
				}
				return {
					kept: true,
					path: canonical.manifest.originalPath,
					revision: saved.revision,
					generation: canonical.generation,
					review,
				};
			});
		},

		async rejectChange(root, state, host) {
			let originalPath = assertProposalOriginalPath(state && state.originalPath);
			let directory = changeDirectory(state && state.workingPath);
			return withProposalMutex(root, originalPath, host, async () => {
				let canonical = await readCanonicalProposal(root, directory, state, host);
				if (typeof host.remove !== 'function') {
					throw new Error('Draft proposal host cannot remove review state');
				}
				await host.remove(joinRoot(root, directory), { recursive: true });
				return {
					rejected: true,
					path: canonical.manifest.originalPath,
					generation: canonical.generation,
				};
			});
		},
		
		createGeckoHost() {
			return {
				exists: path => IOUtils.exists(path),
				entries: path => IOUtils.getChildren(path),
				filename: path => PathUtils.filename(path),
				read: path => IOUtils.readUTF8(path),
				write: (path, text) => IOUtils.writeUTF8(path, text),
				writeNew: (path, text) => IOUtils.writeUTF8(path, text, { mode: 'create' }),
				makeDir: (path, opts) => IOUtils.makeDirectory(path, {
					createAncestors: !!(opts && opts.createAncestors),
					ignoreExisting: true,
				}),
				remove: (path, opts) => IOUtils.remove(path, {
					recursive: !!(opts && opts.recursive),
					ignoreAbsent: true,
				}),
				realPath: async path => {
					let file = Components.classes['@mozilla.org/file/local;1']
						.createInstance(Components.interfaces.nsIFile);
					file.initWithPath(path);
					file.normalize();
					return String(file.path || path);
				},
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
				writeNew: (p, text) => fs.writeFile(p, text, { encoding: 'utf8', flag: 'wx' }),
				makeDir: (p, opts) => fs.mkdir(p, { recursive: !!(opts && opts.createAncestors) }),
				remove: (p, opts) => fs.rm(p, { recursive: !!(opts && opts.recursive), force: true }),
				realPath: p => fs.realpath(p),
			};
		},
	};
})();
