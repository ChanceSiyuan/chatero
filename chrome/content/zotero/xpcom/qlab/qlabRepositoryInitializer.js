/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Chance Siyuan / Chatero contributors

	This file is part of Chatero (a Zotero fork).

	***** END LICENSE BLOCK *****
*/

Zotero.QLab = Zotero.QLab || {};

(function () {
	const RECEIPT_RELATIVE_PATH = '.research-loop/starter.json';
	const RECEIPT_SCHEMA = 1;
	const SHA256 = /^[a-f0-9]{64}$/;
	const RECEIPT_STATES = new Set(['running', 'failed', 'ready']);
	const STARTER_MANIFEST_URI = 'resource://zotero/chatero/qlab-starter/manifest.json';
	const STARTER_ARCHIVE_URI = 'resource://zotero/chatero/qlab-starter/research-loop-starter.zip';

	function immutableResult(receipt, receiptPath) {
		return Object.freeze({
			state: receipt.state,
			root: receipt.root,
			repositoryIdentity: receipt.repositoryIdentity || null,
			created: Object.freeze([...(receipt.completed || [])]),
			preserved: Object.freeze((receipt.preserve || []).map(entry => entry.path)),
			receiptPath,
		});
	}

	function sameRecord(left, right) {
		return left && right
			&& left.path === right.path
			&& left.kind === right.kind
			&& left.mode === right.mode
			&& (left.digest || '') === (right.digest || '')
			&& (left.fingerprint || '') === (right.fingerprint || '')
			&& (left.reason || '') === (right.reason || '');
	}

	function sameStarterRecord(left, right) {
		return left && right
			&& left.path === right.path
			&& left.kind === right.kind
			&& left.mode === right.mode
			&& (left.digest || '') === (right.digest || '');
	}

	function sameRecordList(left, right) {
		return Array.isArray(left)
			&& Array.isArray(right)
			&& left.length === right.length
			&& left.every((entry, index) => sameRecord(entry, right[index]));
	}

	function samePlanSnapshot(plan, expected) {
		return plan && expected
			&& plan.root === expected.root
			&& plan.inspectionFingerprint === expected.inspectionFingerprint
			&& plan.manifestDigest === expected.manifestDigest
			&& plan.digest === expected.digest
			&& sameRecordList(plan.create, expected.create)
			&& sameRecordList(plan.preserve, expected.preserve)
			&& sameRecordList(plan.conflicts, expected.conflicts);
	}

	function safeError(error) {
		let message = String(error && error.message || error || 'Initialization failed');
		return message.replace(/[\r\n]+/g, ' ').slice(0, 512);
	}

	async function verifyAssets(assetReader, host) {
		let rawManifest = await assetReader.readManifest();
		let manifest = Zotero.QLab.validateQLabStarterManifest(rawManifest);
		if (!rawManifest || typeof rawManifest.archiveSha256 !== 'string' || !SHA256.test(rawManifest.archiveSha256)) {
			throw new Error('Starter archive digest is missing or invalid');
		}
		let archive = await assetReader.readArchive();
		if (await host.sha256(archive) !== rawManifest.archiveSha256) {
			throw new Error('Starter archive digest mismatch');
		}
		let payloads = new Map();
		for (let entry of manifest.entries) {
			if (entry.kind !== 'file') continue;
			let bytes = await assetReader.readEntry(entry.path);
			if (await host.sha256(bytes) !== entry.digest) {
				throw new Error(`Starter payload digest mismatch for ${entry.path}`);
			}
			payloads.set(entry.path, bytes);
		}
		return { rawManifest, manifest, payloads };
	}

	async function targetStatus(root, entry, host) {
		let target = host.join(root, entry.path);
		await host.assertNoSymlinkComponents(root, target, { allowMissingParent: true, allowMissingLeaf: true });
		let kind = await host.kind(target);
		if (kind === 'symlink') throw new Error(`Symbolic link refused at ${entry.path}`);
		return { target, kind };
	}

	async function verifyEntry(root, entry, payloads, host) {
		let { target, kind } = await targetStatus(root, entry, host);
		if (kind !== entry.kind) return false;
		if (entry.kind === 'file') {
			let bytes = await host.readBytesNoFollow(target);
			return await host.sha256(bytes) === entry.digest
				&& await host.sha256(payloads.get(entry.path)) === entry.digest;
		}
		return true;
	}

	async function verifyPreservedEntries(root, entries, create, host) {
		let excluded = [
			...(create || []).map(entry => entry.path),
			'.research-loop/starter.json',
		];
		for (let entry of entries) {
			let { kind } = await targetStatus(root, entry, host);
			if (kind !== entry.kind) {
				throw new Error(`Preserved starter target changed: ${entry.path}`);
			}
			if (!SHA256.test(String(entry.fingerprint || ''))
				|| await Zotero.QLab.fingerprintQLabPreservedTarget(root, entry.path, host, { exclude: excluded }) !== entry.fingerprint) {
				throw new Error(`Preserved starter target fingerprint changed: ${entry.path}`);
			}
		}
	}

	function receiptFor(plan, verified, now) {
		return {
			schemaVersion: RECEIPT_SCHEMA,
			state: 'running',
			root: plan.root,
			manifestDigest: verified.manifest.digest,
			archiveSha256: verified.rawManifest.archiveSha256,
			planDigest: plan.digest,
			inspectionFingerprint: plan.inspectionFingerprint,
			create: plan.create.map(entry => ({ ...entry })),
			preserve: plan.preserve.map(entry => ({ ...entry })),
			conflicts: plan.conflicts.map(entry => ({ ...entry })),
			completed: [],
			inFlight: null,
			repositoryIdentity: null,
			error: null,
			updatedAt: now(),
		};
	}

	async function validateReceipt(receipt, root, verified, host) {
		if (!receipt || receipt.schemaVersion !== RECEIPT_SCHEMA || receipt.root !== root) {
			throw new Error('Initialization receipt does not match this repository');
		}
		let canonicalReceipt = { ...receipt };
		delete canonicalReceipt.receiptDigest;
		if (!SHA256.test(String(receipt.receiptDigest || ''))
			|| await host.sha256(JSON.stringify(canonicalReceipt)) !== receipt.receiptDigest) {
			throw new Error('Initialization receipt digest is stale or invalid');
		}
		if (receipt.manifestDigest !== verified.manifest.digest
			|| receipt.archiveSha256 !== verified.rawManifest.archiveSha256
			|| !SHA256.test(String(receipt.planDigest || ''))
			|| typeof receipt.inspectionFingerprint !== 'string'
			|| !RECEIPT_STATES.has(receipt.state)
			|| !Array.isArray(receipt.create)
			|| !Array.isArray(receipt.preserve)
			|| !Array.isArray(receipt.conflicts)
			|| !Array.isArray(receipt.completed)) {
			throw new Error('Initialization receipt is stale or invalid');
		}
		if (receipt.planDigest !== Zotero.QLab.computeQLabStarterPlanDigest(receipt)) {
			throw new Error('Initialization receipt plan digest is stale or invalid');
		}
		let manifestByPath = new Map(verified.manifest.entries.map(entry => [entry.path, entry]));
		for (let entry of [...receipt.create, ...receipt.preserve]) {
			if (!sameStarterRecord(entry, manifestByPath.get(entry.path))) {
				throw new Error('Initialization receipt plan does not match the starter manifest');
			}
		}
		let planned = new Set([...receipt.create, ...receipt.preserve].map(entry => entry.path));
		if (planned.size !== verified.manifest.entries.length
			|| verified.manifest.entries.some(entry => !planned.has(entry.path))) {
			throw new Error('Initialization receipt plan is incomplete');
		}
		let createPaths = new Set(receipt.create.map(entry => entry.path));
		let completed = new Set(receipt.completed);
		if (completed.size !== receipt.completed.length
			|| receipt.completed.some(path => typeof path !== 'string' || !createPaths.has(path))) {
			throw new Error('Initialization receipt has invalid completed targets');
		}
		if (receipt.inFlight !== null
			&& (typeof receipt.inFlight !== 'string' || !createPaths.has(receipt.inFlight))) {
			throw new Error('Initialization receipt has an invalid in-flight target');
		}
		if (receipt.state === 'ready'
			&& (receipt.inFlight !== null || completed.size !== createPaths.size)) {
			throw new Error('Ready initialization receipt is incomplete');
		}
		return receipt;
	}

	async function assertNoUnplannedTopLevel(root, receipt, host) {
		let allowed = new Set(['.git', '.DS_Store']);
		for (let entry of [...receipt.create, ...receipt.preserve]) allowed.add(entry.path.split('/')[0]);
		for (let target of await host.entries(root)) {
			let name = host.filename(target);
			if (!allowed.has(name)) throw new Error(`Repository changed: unplanned target ${name}`);
			if (await host.isSymlink(target)) throw new Error(`Repository changed: symbolic link ${name}`);
		}
	}

	Zotero.QLab.createQLabRepositoryInitializer = function ({ host, assetReader, git, now, uuid }) {
		if (!host || !assetReader || !git) throw new Error('QLab initializer requires host, starter reader, and Git service');
		now = typeof now === 'function' ? now : () => new Date().toISOString();
		uuid = typeof uuid === 'function' ? uuid : () => String(Services.uuid.generateUUID()).replace(/[{}]/g, '');

		async function writeReceipt(receiptPath, receipt, exclusive = false) {
			receipt.updatedAt = now();
			delete receipt.receiptDigest;
			receipt.receiptDigest = await host.sha256(JSON.stringify(receipt));
			await host.writeReceipt(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { exclusive });
		}

		async function ensureReadyIdentity(root, receipt) {
			let identity = await Zotero.QLab.createQLabRepositoryIdentity({ root, host, uuid });
			if (receipt.repositoryIdentity && receipt.repositoryIdentity !== identity.identity) {
				throw new Error('Repository identity changed during initialization');
			}
			receipt.repositoryIdentity = identity.identity;
			return identity.identity;
		}

		async function initializeGit(root) {
			let dotGit = host.join(root, '.git');
			let kind = await host.kind(dotGit);
			if (kind === 'missing') {
				await git.initialize({ executable: '/usr/bin/git', argv: ['init'], cwd: root });
				if (!await git.isRepository(root)) throw new Error('Git initialization did not produce a repository');
				return;
			}
			if (kind === 'symlink' || !await git.isRepository(root)) {
				throw new Error('Existing .git target is not a valid Git repository');
			}
		}

		async function verifyGitTarget(root) {
			let kind = await host.kind(host.join(root, '.git'));
			if (kind === 'missing') return;
			if (kind === 'symlink' || !await git.isRepository(root)) {
				throw new Error('Existing .git target is not a valid Git repository');
			}
		}

		async function continueReceipt(receipt, verified, onProgress, receiptPath, { existingReceipt = true } = {}) {
			let createdSet = new Set(receipt.completed);
			let report = step => { if (typeof onProgress === 'function') onProgress(Object.freeze({ step })); };
			try {
				if (!existingReceipt) {
					let markerEntry = receipt.create.find(entry => entry.path === '.research-loop' && entry.kind === 'directory');
					let markerParent = host.join(receipt.root, '.research-loop');
					let outcome = await host.createDirectoryIfAbsent(
						receipt.root,
						markerParent,
						markerEntry ? parseInt(markerEntry.mode, 8) : 0o700
					);
					if (outcome !== 'created' && outcome !== 'exists') throw new Error('Could not create private receipt directory');
					if (markerEntry) {
						createdSet.add(markerEntry.path);
						receipt.completed = [...createdSet];
					}
					await writeReceipt(receiptPath, receipt, true);
					existingReceipt = true;
				}
				report('add-missing-files');
				for (let entry of receipt.create) {
					if (createdSet.has(entry.path)) continue;
					receipt.inFlight = entry.path;
					if (existingReceipt) await writeReceipt(receiptPath, receipt);
					let { target, kind } = await targetStatus(receipt.root, entry, host);
					if (kind !== 'missing') {
						throw new Error(`Repository changed: unrecorded target ${entry.path}`);
					}
					let outcome = entry.kind === 'directory'
						? await host.createDirectoryIfAbsent(receipt.root, target, parseInt(entry.mode, 8))
						: await host.createFileIfAbsent(receipt.root, target, verified.payloads.get(entry.path), parseInt(entry.mode, 8));
					if (outcome !== 'created') throw new Error(`Repository changed while creating ${entry.path}`);
					createdSet.add(entry.path);
					receipt.completed = [...createdSet];
					receipt.inFlight = null;
					if (existingReceipt) await writeReceipt(receiptPath, receipt);
				}
				report('initialize-git');
				await initializeGit(receipt.root);
				report('verify-repository');
				if (!await Zotero.QLab.isQLabRepositoryShape(receipt.root, host)) {
					throw new Error('Initialized repository does not satisfy the QLab shape');
				}
				for (let entry of receipt.create) {
					if (!await verifyEntry(receipt.root, entry, verified.payloads, host)) {
						throw new Error(`Created starter target changed: ${entry.path}`);
					}
				}
				await ensureReadyIdentity(receipt.root, receipt);
				receipt.state = 'ready';
				receipt.error = null;
				receipt.inFlight = null;
				await writeReceipt(receiptPath, receipt);
				report('ready');
				return immutableResult(receipt, receiptPath);
			}
			catch (error) {
				receipt.state = 'failed';
				receipt.error = safeError(error);
				if (existingReceipt) {
					try { await writeReceipt(receiptPath, receipt); }
					catch {}
				}
				throw error;
			}
		}

		return Object.freeze({
			async execute(plan, onProgress) {
				if (!plan || typeof plan !== 'object' || !plan.root) throw new Error('Initialization plan is required');
				let report = step => { if (typeof onProgress === 'function') onProgress(Object.freeze({ step })); };
				report('verify-folder');
				let inspection = await Zotero.QLab.inspectQLabRepository(plan.root, host);
				if (inspection.state === 'incompatible' || (plan.conflicts && plan.conflicts.length)) {
					throw new Error('QLab initialization plan has repository conflicts');
				}
				if (!await Zotero.QLab.isQLabStarterPlanCurrent(plan, inspection)) {
					throw new Error('QLab initialization plan is stale because the folder changed');
				}
				report('verify-starter');
				let verified = await verifyAssets(assetReader, host);
				if (verified.manifest.digest !== plan.manifestDigest) throw new Error('Starter manifest changed after planning');
				inspection = await Zotero.QLab.inspectQLabRepository(plan.root, host);
				let expectedPlan = await Zotero.QLab.planQLabStarterInstall({
					root: plan.root,
					inspection,
					manifest: verified.rawManifest,
					host,
				});
				if (!samePlanSnapshot(plan, expectedPlan) || expectedPlan.conflicts.length) {
					throw new Error('QLab initialization plan snapshot no longer matches the repository and starter manifest');
				}
				await verifyGitTarget(plan.root);
				await Zotero.QLab.preflightQLabRepositoryIdentity({ root: plan.root, host });
				let receiptPath = host.join(plan.root, RECEIPT_RELATIVE_PATH);
				let existing = await host.readReceipt(receiptPath);
				if (existing) {
					let receipt = await validateReceipt(existing, plan.root, verified, host);
					if (receipt.state !== 'ready') throw new Error('Interrupted initialization must be resumed explicitly');
					await assertNoUnplannedTopLevel(plan.root, receipt, host);
					await verifyPreservedEntries(plan.root, receipt.preserve, receipt.create, host);
					for (let entry of receipt.create) {
						if (!await verifyEntry(plan.root, entry, verified.payloads, host)) {
							throw new Error(`Created starter target changed: ${entry.path}`);
						}
					}
					if (!await Zotero.QLab.isQLabRepositoryShape(plan.root, host)) {
						throw new Error('Ready initialization receipt does not satisfy the QLab shape');
					}
					let identity = await ensureReadyIdentity(plan.root, receipt);
					receipt.repositoryIdentity = identity;
					report('add-missing-files'); report('initialize-git'); report('verify-repository'); report('ready');
					return immutableResult(receipt, receiptPath);
				}
				let receipt = receiptFor(plan, verified, now);
				return continueReceipt(receipt, verified, onProgress, receiptPath, { existingReceipt: false });
			},

			async resume(root, onProgress) {
				let canonical = await host.realPath(root);
				canonical = host.normalize(canonical).replace(/[\\/]+$/, '');
				if (!host.isAbsolute(root) || canonical !== root.replace(/[\\/]+$/, '')) {
					throw new Error('Resume requires a canonical absolute repository root');
				}
				let receiptPath = host.join(canonical, RECEIPT_RELATIVE_PATH);
				let stored = await host.readReceipt(receiptPath);
				if (!stored) throw new Error('No interrupted initialization receipt exists');
				let report = step => { if (typeof onProgress === 'function') onProgress(Object.freeze({ step })); };
				report('verify-folder');
				report('verify-starter');
				let verified = await verifyAssets(assetReader, host);
				let receipt = await validateReceipt(stored, canonical, verified, host);
				await assertNoUnplannedTopLevel(canonical, receipt, host);
				await verifyPreservedEntries(canonical, receipt.preserve, receipt.create, host);
				await verifyGitTarget(canonical);
				let createByPath = new Map(receipt.create.map(entry => [entry.path, entry]));
				let completed = new Set(receipt.completed);
				for (let path of completed) {
					let entry = createByPath.get(path);
					if (!entry || !await verifyEntry(canonical, entry, verified.payloads, host)) {
						throw new Error(`Completed starter target changed: ${path}`);
					}
				}
				if (receipt.inFlight) {
					let entry = createByPath.get(receipt.inFlight);
					if (!entry) throw new Error('Initialization receipt has an invalid in-flight target');
					let status = await targetStatus(canonical, entry, host);
					if (status.kind !== 'missing') {
						if (!await verifyEntry(canonical, entry, verified.payloads, host)) {
							throw new Error(`In-flight starter target changed: ${entry.path}`);
						}
						completed.add(entry.path);
						receipt.completed = [...completed];
					}
					receipt.inFlight = null;
					await writeReceipt(receiptPath, receipt);
				}
				for (let entry of receipt.create) {
					if (completed.has(entry.path)) continue;
					let status = await targetStatus(canonical, entry, host);
					if (status.kind !== 'missing') throw new Error(`Repository changed: unrecorded target ${entry.path}`);
				}
				if (receipt.state === 'ready') {
					if (!await Zotero.QLab.isQLabRepositoryShape(canonical, host)) {
						throw new Error('Ready initialization receipt does not satisfy the QLab shape');
					}
					await ensureReadyIdentity(canonical, receipt);
					return immutableResult(receipt, receiptPath);
				}
				receipt.state = 'running';
				receipt.error = null;
				await writeReceipt(receiptPath, receipt);
				return continueReceipt(receipt, verified, onProgress, receiptPath);
			},
		});
	};

	Zotero.QLab.createNodeQLabInitializerHost = function (fs, pathModule, createHash) {
		let base = Zotero.QLab.createNodeQLabRepositoryHost(fs, pathModule);
		async function revalidateParent(root, target) {
			let parent = pathModule.dirname(target);
			await base.assertNoSymlinkComponents(root, parent);
			let resolvedParent = pathModule.normalize(await fs.realpath(parent));
			if (resolvedParent !== pathModule.normalize(parent) || !base.isPathInside(root, resolvedParent)) {
				throw new Error('Target parent escaped the repository root');
			}
			await base.assertNoSymlinkComponents(root, parent);
		}
		async function readBytesNoFollow(target) {
			let handle = await fs.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
			try { return await handle.readFile(); }
			finally { await handle.close(); }
		}
		async function createDirectoryIfAbsent(root, target, mode) {
			await base.assertNoSymlinkComponents(root, target, { allowMissingLeaf: true });
			await revalidateParent(root, target);
			try { await fs.mkdir(target, { mode }); return 'created'; }
			catch (error) {
				if (error && error.code === 'EEXIST' && await base.kind(target) === 'directory') return 'exists';
				throw error;
			}
		}
		async function createFileIfAbsent(root, target, bytes, mode) {
			await base.assertNoSymlinkComponents(root, target, { allowMissingLeaf: true });
			await revalidateParent(root, target);
			let handle;
			try {
				handle = await fs.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode);
			}
			catch (error) {
				if (error && error.code === 'EEXIST') return 'exists';
				throw error;
			}
			try { await handle.writeFile(bytes); await handle.sync(); }
			finally { await handle.close(); }
			return 'created';
		}
		return {
			...base,
			entries: async target => (await fs.readdir(target)).map(name => pathModule.join(target, name)),
			filename: target => pathModule.basename(target),
			stat: target => fs.lstat(target),
			isSymlink: async target => (await fs.lstat(target)).isSymbolicLink(),
			sha256: async bytes => createHash('sha256').update(bytes).digest('hex'),
			readBytesNoFollow,
			createDirectoryIfAbsent,
			createFileIfAbsent,
			readReceipt: async target => {
				try { return JSON.parse((await readBytesNoFollow(target)).toString('utf8')); }
				catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }
			},
			writeReceipt: async (target, text, { exclusive } = {}) => {
				if (exclusive) {
					let outcome = await createFileIfAbsent(pathModule.dirname(pathModule.dirname(target)), target, text, 0o600);
					if (outcome !== 'created') throw new Error('Initialization receipt already exists');
					return;
				}
				let temporary = `${target}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
				let outcome = await createFileIfAbsent(pathModule.dirname(pathModule.dirname(target)), temporary, text, 0o600);
				if (outcome !== 'created') throw new Error('Could not create private receipt staging file');
				await fs.rename(temporary, target);
			},
		};
	};

	Zotero.QLab.createGeckoQLabInitializerHost = function (dependencies = {}) {
		let io = dependencies.IOUtils || (typeof IOUtils !== 'undefined' ? IOUtils : null);
		let paths = dependencies.PathUtils || (typeof PathUtils !== 'undefined' ? PathUtils : null);
		let xpcom = dependencies.Components || (typeof Components !== 'undefined' ? Components : null);
		let cryptoAPI = dependencies.crypto || (typeof crypto !== 'undefined' ? crypto : null);

		function localFile(path) {
			let file = xpcom.classes['@mozilla.org/file/local;1']
				.createInstance(xpcom.interfaces.nsIFile);
			file.initWithPath(path);
			return file;
		}

		function normalized(path) {
			if (paths && typeof paths.normalize === 'function') return paths.normalize(path);
			let file = localFile(path);
			try { file.normalize(); }
			catch {}
			return String(file.path || path);
		}

		function separator(path) {
			return String(path).includes('\\') && !String(path).includes('/') ? '\\' : '/';
		}

		function isInside(root, target) {
			let canonicalRoot = normalized(root).replace(/[\\/]+$/, '');
			let candidate = normalized(target).replace(/[\\/]+$/, '');
			let boundary = separator(canonicalRoot);
			return candidate === canonicalRoot || candidate.startsWith(canonicalRoot + boundary);
		}

		async function isSymlink(target) {
			try {
				let file = localFile(target);
				return typeof file.isSymlink === 'function' && file.isSymlink();
			}
			catch { return false; }
		}

		async function kind(target) {
			if (await isSymlink(target)) return 'symlink';
			try {
				let stat = await io.stat(target);
				if (stat.type === 'directory') return 'directory';
				if (stat.type === 'file' || stat.type === 'regular') return 'file';
				return 'other';
			}
			catch (error) {
				if (error && (error.name === 'NotFoundError' || error.result === xpcom.results.NS_ERROR_FILE_NOT_FOUND)) return 'missing';
				throw error;
			}
		}

		async function assertNoSymlinkComponents(root, target, options = {}) {
			let canonicalRoot = normalized(root).replace(/[\\/]+$/, '');
			let candidate = normalized(target);
			if (!isInside(canonicalRoot, candidate)) throw new Error('Path is outside the repository root');
			let suffix = candidate.slice(canonicalRoot.length).replace(/^[\\/]+/, '');
			let components = suffix ? suffix.split(/[\\/]+/) : [];
			let current = canonicalRoot;
			for (let index = 0; index < components.length; index++) {
				current = paths.join(current, components[index]);
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

		async function readBytesNoFollow(target, maxBytes) {
			if (await isSymlink(target)) throw new Error(`Symbolic link refused at ${target}`);
			if (maxBytes !== undefined) {
				let stat = await io.stat(target);
				if (Number(stat.size) > maxBytes) throw new Error('Private file is oversized');
			}
			let bytes = await io.read(target, maxBytes === undefined ? undefined : { maxBytes });
			if (await isSymlink(target)) throw new Error(`Symbolic link refused at ${target}`);
			return bytes;
		}

		async function revalidateParent(root, target) {
			let parent = paths.parent(target);
			await assertNoSymlinkComponents(root, parent);
			let resolvedParent = await host.realPath(parent);
			if (normalized(resolvedParent) !== normalized(parent) || !isInside(root, resolvedParent)) {
				throw new Error('Target parent escaped the repository root');
			}
			await assertNoSymlinkComponents(root, parent);
		}

		async function writeExclusive(target, bytes, mode, root) {
			let file = localFile(target);
			if (typeof file.isSymlink === 'function' && file.isSymlink()) throw new Error(`Symbolic link refused at ${target}`);
			if (root) await revalidateParent(root, target);
			let stream = xpcom.classes['@mozilla.org/network/file-output-stream;1']
				.createInstance(xpcom.interfaces.nsIFileOutputStream);
			stream.init(file, 0x02 | 0x08 | 0x80, mode, 0);
			let binary = xpcom.classes['@mozilla.org/binaryoutputstream;1']
				.createInstance(xpcom.interfaces.nsIBinaryOutputStream);
			binary.setOutputStream(stream);
			try {
				let data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes));
				binary.writeByteArray(Array.from(data), data.length);
				binary.flush();
			}
			finally { binary.close(); }
		}

		async function createDirectoryIfAbsent(root, target, mode) {
			await assertNoSymlinkComponents(root, target, { allowMissingLeaf: true });
			await revalidateParent(root, target);
			let file = localFile(target);
			try { file.create(xpcom.interfaces.nsIFile.DIRECTORY_TYPE, mode); }
			catch (error) {
				if (await kind(target) === 'directory') return 'exists';
				throw error;
			}
			await assertNoSymlinkComponents(root, target);
			return 'created';
		}

		async function createFileIfAbsent(root, target, bytes, mode) {
			await assertNoSymlinkComponents(root, target, { allowMissingLeaf: true });
			await revalidateParent(root, target);
			try { await writeExclusive(target, bytes, mode, root); }
			catch (error) {
				if (await kind(target) !== 'missing') return 'exists';
				throw error;
			}
			await assertNoSymlinkComponents(root, target);
			return 'created';
		}

		let host = {
			entries: target => io.getChildren(target),
			filename: target => paths.filename(target),
			stat: target => io.stat(target),
			isSymlink,
			exists: async target => (await kind(target)) !== 'missing',
			existsNoFollow: async target => (await kind(target)) !== 'missing',
			realPath: async target => {
				let file = localFile(target);
				file.normalize();
				return String(file.path);
			},
			normalize: normalized,
			isAbsolute: target => paths.isAbsolute(target),
			isPathInside: isInside,
			resolvePath: (base, value) => normalized(paths.isAbsolute(value) ? value : paths.join(base, value)),
			join: (...parts) => paths.join(...parts),
			kind,
			assertNoSymlinkComponents,
			readTextNoFollow: async (target, maxBytes) => new TextDecoder().decode(await readBytesNoFollow(target, maxBytes)),
			readPrivateNoFollow: async (target, maxBytes) => {
				try { return new TextDecoder().decode(await readBytesNoFollow(target, maxBytes)); }
				catch (error) {
					if (await kind(target) === 'missing') return null;
					throw error;
				}
			},
			createPrivateIfAbsent: async (root, target, value, mode, directoryMode) => {
				let parent = paths.parent(target);
				let parentKind = await kind(parent);
				if (parentKind === 'missing') {
					let ancestor = paths.parent(parent);
					if (await kind(ancestor) !== 'directory' || await isSymlink(ancestor)) throw new Error('Private identity parent is unsafe');
					let file = localFile(parent);
					file.create(xpcom.interfaces.nsIFile.DIRECTORY_TYPE, directoryMode);
				}
				else if (parentKind !== 'directory') throw new Error('Private identity parent is unsafe');
				await assertNoSymlinkComponents(root, parent);
				let resolvedParent = await host.realPath(parent);
				if (normalized(resolvedParent) !== normalized(parent) || !isInside(root, resolvedParent)) {
					throw new Error('Private identity parent escaped the repository root');
				}
				await assertNoSymlinkComponents(root, parent);
				try { await writeExclusive(target, value, mode, root); return 'created'; }
				catch (error) {
					if (await kind(target) !== 'missing') return 'exists';
					throw error;
				}
			},
			sha256: async bytes => {
				let input = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
				let digest = new Uint8Array(await cryptoAPI.subtle.digest('SHA-256', input));
				return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
			},
			readBytesNoFollow,
			createDirectoryIfAbsent,
			createFileIfAbsent,
			readReceipt: async target => {
				try { return JSON.parse(new TextDecoder().decode(await readBytesNoFollow(target))); }
				catch (error) {
					if (await kind(target) === 'missing') return null;
					throw error;
				}
			},
			writeReceipt: async (target, text, { exclusive } = {}) => {
				let root = paths.parent(paths.parent(target));
				if (exclusive) {
					let outcome = await createFileIfAbsent(root, target, new TextEncoder().encode(text), 0o600);
					if (outcome !== 'created') throw new Error('Initialization receipt already exists');
					return;
				}
				await assertNoSymlinkComponents(root, target, { allowMissingLeaf: true });
				let temporary = paths.join(paths.parent(target), `.starter-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
				let outcome = await createFileIfAbsent(root, temporary, new TextEncoder().encode(text), 0o600);
				if (outcome !== 'created') throw new Error('Could not create private receipt staging file');
				try { await io.move(temporary, target, { noOverwrite: false }); }
				catch (error) { try { await io.remove(temporary, { ignoreAbsent: true }); } catch {} throw error; }
			},
		};
		return host;
	};

	Zotero.QLab.createGeckoQLabGitService = function (dependencies = {}) {
		function normalizeAbsolutePath(value) {
			let raw = String(value || '').trim().replace(/\\/g, '/');
			if (!raw.startsWith('/')) return '';
			let segments = [];
			for (let segment of raw.split('/')) {
				if (!segment || segment === '.') continue;
				if (segment === '..') {
					if (!segments.length) return '';
					segments.pop();
					continue;
				}
				segments.push(segment);
			}
			return `/${segments.join('/')}`;
		}

		function commonDirectoryIsOwnedBy(root, common) {
			return common === root || common.startsWith(`${root}/`);
		}

		function subprocess() {
			if (dependencies.Subprocess) return dependencies.Subprocess;
			return ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs').Subprocess;
		}
		async function call(root, argumentsList) {
			let proc = await subprocess().call({
				command: '/usr/bin/git',
				arguments: argumentsList,
				workdir: root,
			});
			let output = '';
			try { output = await proc.stdout.readString(); }
			catch {}
			let result = await proc.wait();
			return { exitCode: result.exitCode, output };
		}
		return Object.freeze({
			isRepository: async root => {
				let canonicalRoot = normalizeAbsolutePath(root);
				if (!canonicalRoot) return false;
				let result = await call(root, [
					'rev-parse', '--is-inside-work-tree', '--show-toplevel',
					'--path-format=absolute', '--git-common-dir',
				]);
				let lines = result.output.replace(/\r\n/g, '\n').split('\n');
				if (lines[lines.length - 1] === '') lines.pop();
				if (result.exitCode !== 0 || lines.length !== 3 || lines[0] !== 'true') return false;
				let topLevel = normalizeAbsolutePath(lines[1]);
				let commonDirectory = normalizeAbsolutePath(lines[2]);
				return topLevel === canonicalRoot
					&& Boolean(commonDirectory)
					&& commonDirectoryIsOwnedBy(canonicalRoot, commonDirectory);
			},
			initialize: async ({ executable, argv, cwd }) => {
				if (executable !== '/usr/bin/git' || !Array.isArray(argv) || argv.length !== 1 || argv[0] !== 'init') {
					throw new Error('Refusing an unexpected Git initialization command');
				}
				let result = await call(cwd, ['init']);
				if (result.exitCode !== 0) throw new Error('Git initialization failed');
			},
		});
	};

	Zotero.QLab.createGeckoQLabRepositoryInitializer = function (options = {}) {
		let host = options.host || Zotero.QLab.createGeckoQLabInitializerHost();
		let assetReader = options.assetReader || Zotero.QLab.createGeckoQLabStarterAssetReader({
			manifestURI: STARTER_MANIFEST_URI,
			archiveURI: STARTER_ARCHIVE_URI,
		});
		let git = options.git || Zotero.QLab.createGeckoQLabGitService();
		return Zotero.QLab.createQLabRepositoryInitializer({
			host,
			assetReader,
			git,
			now: options.now,
			uuid: options.uuid,
		});
	};

	async function readBundledBytes(uri) {
		let response = await fetch(uri);
		if (!response.ok && response.status !== 0) throw new Error(`Could not read bundled QLab starter asset (${response.status})`);
		return new Uint8Array(await response.arrayBuffer());
	}

	Zotero.QLab.createGeckoQLabStarterAssetReader = function ({ manifestURI, archiveURI }) {
		if (!manifestURI || !archiveURI) throw new Error('Bundled starter manifest and archive URIs are required');
		function resolvedArchiveURI() {
			let uri = Services.io.newURI(archiveURI);
			if (uri.scheme === 'resource') uri = Services.io.newURI(Services.io.getProtocolHandler('resource').resolveURI(uri));
			return uri;
		}
		function zipReader() {
			return Components.classes['@mozilla.org/libjar/zip-reader;1']
				.createInstance(Components.interfaces.nsIZipReader);
		}
		function openArchive() {
			let uri = resolvedArchiveURI();
			if (uri.scheme === 'jar') {
				let jar = uri.QueryInterface(Components.interfaces.nsIJARURI);
				let outerURI = jar.JARFile;
				if (outerURI.scheme !== 'file') throw new Error('Bundled QLab starter archive must resolve to a local application JAR');
				let outer = zipReader();
				outer.open(outerURI.QueryInterface(Components.interfaces.nsIFileURL).file);
				let inner = zipReader();
				try { inner.openInner(outer, jar.JAREntry); }
				catch (error) { outer.close(); throw error; }
				return {
					reader: inner,
					close: () => {
						try { inner.close(); }
						finally { outer.close(); }
					},
				};
			}
			if (uri.scheme !== 'file') throw new Error('Bundled QLab starter archive must resolve to a local file or application JAR');
			let reader = zipReader();
			reader.open(uri.QueryInterface(Components.interfaces.nsIFileURL).file);
			return { reader, close: () => reader.close() };
		}
		return Object.freeze({
			readManifest: async () => JSON.parse(new TextDecoder().decode(await readBundledBytes(manifestURI))),
			readArchive: () => readBundledBytes(archiveURI),
			readEntry: async relativePath => {
				if (!Zotero.QLab.isSafeWorkspaceRelativePath(relativePath)) throw new Error('Unsafe starter archive entry path');
				let archive = openArchive();
				try {
					let stream = archive.reader.getInputStream(relativePath);
					try {
						let binary = Components.classes['@mozilla.org/binaryinputstream;1']
							.createInstance(Components.interfaces.nsIBinaryInputStream);
						binary.setInputStream(stream);
						return Uint8Array.from(binary.readByteArray(binary.available()));
					}
					finally { stream.close(); }
				}
				finally { archive.close(); }
			},
		});
	};
})();
