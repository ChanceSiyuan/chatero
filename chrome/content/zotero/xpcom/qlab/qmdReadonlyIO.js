/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Chance Siyuan / Chatero contributors

	This file is part of Chatero (a Zotero fork).

	***** END LICENSE BLOCK *****
*/

/** Verified, read-only access to trusted Knowledge and external Literature. */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const VERIFIED_READS = new WeakSet();
	const VERIFIED_READ_CONTEXTS = new WeakMap();
	const READONLY_IO_CONTEXTS = new WeakMap();
	const READONLY_SESSION_CONTEXTS = new WeakMap();
	const CONSUMED_READS = new WeakSet();
	const CONSUMED_CAPABILITIES = new WeakSet();
	const CONSUMED_ACCESS = new WeakSet();
	const READONLY_CAPABILITIES = Object.freeze({
		read: true,
		reload: true,
		surfaceNavigation: true,
		websiteNavigation: true,
		selection: true,
		chatSelection: true,
		edit: false,
		save: false,
		autosave: false,
		proposal: false,
		keepReject: false,
		completeTodos: false,
		promote: false,
		insertFormalBlock: false,
		externalEditor: false,
		pdfQuote: false,
		pendingReview: false,
		aiWrite: false,
		sharedBufferWrite: false,
	});

	function stripTrailingSeparators(value) {
		let path = String(value || '').replace(/[\\/]+$/u, '');
		return path || '/';
	}

	function opaqueAccess(capability) {
		for (let name of ['access', 'handle', 'token']) {
			let value = capability && capability[name];
			if ((typeof value === 'object' && value !== null)
					|| typeof value === 'function') return value;
		}
		return null;
	}

	function readonlyClassification(relativePath) {
		let document = Zotero.QLab.classifyWorkspaceDocument
			? Zotero.QLab.classifyWorkspaceDocument(relativePath)
			: null;
		if (!document || document.writable
				|| !['knowledge', 'literature'].includes(document.authority)
				|| !['qmd', 'markdown', 'bib'].includes(document.kind)) {
			throw new Error('Unsupported or unsafe read-only workspace document');
		}
		return document;
	}

	function descriptorMatches(left, right) {
		if (!left || !right) return false;
		for (let name of [
			'relativePath', 'authority', 'kind', 'format', 'readOnly', 'writable',
			'badge', 'tooltip', 'modelLanguage',
		]) {
			if (left[name] !== right[name]) return false;
		}
		if (!Array.isArray(left.surfaces) || !Array.isArray(right.surfaces)
				|| left.surfaces.length !== right.surfaces.length
				|| left.surfaces.some((name, index) => name !== right.surfaces[index])) {
			return false;
		}
		let leftCapabilities = left.capabilities && Object.keys(left.capabilities).sort();
		let rightCapabilities = right.capabilities && Object.keys(right.capabilities).sort();
		return !!leftCapabilities && !!rightCapabilities
			&& leftCapabilities.length === rightCapabilities.length
			&& leftCapabilities.every((name, index) => (
				name === rightCapabilities[index]
				&& left.capabilities[name] === right.capabilities[name]
			));
	}

	Zotero.QLab.createWorkspaceDocumentDescriptor = function (input = {}) {
		let relativePath = String(input.relativePath || input.path || '');
		let classification = readonlyClassification(relativePath);
		let format = classification.kind === 'bib'
			? 'bibtex'
			: classification.kind === 'markdown' ? 'markdown' : 'qmd';
		let surfaces = Object.freeze(format === 'bibtex'
			? ['source']
			: ['visual', 'website', 'source']);
		let capabilities = format === 'bibtex'
			? Object.freeze({ ...READONLY_CAPABILITIES, websiteNavigation: false })
			: READONLY_CAPABILITIES;
		return Object.freeze({
			relativePath: classification.path,
			authority: classification.authority,
			kind: classification.kind,
			format,
			readOnly: true,
			writable: false,
			badge: classification.authority === 'knowledge'
				? 'Trusted Knowledge'
				: 'External Evidence',
			tooltip: classification.authority === 'knowledge'
				? 'Trusted Knowledge is read-only in Chatero.'
				: 'External Evidence is read-only in Chatero.',
			modelLanguage: format === 'bibtex' ? 'bibtex' : 'markdown',
			surfaces,
			capabilities,
		});
	};

	/**
	 * Node/test broker that retains a leaf O_NOFOLLOW handle for each lease.
	 * It does not claim openat-style ancestor pinning and is not a Gecko fallback;
	 * native production routing must inject its own handle-bound broker (Task 9).
	 */
	Zotero.QLab.createNodeReadonlyDocumentLeaseHost = function (fs, pathModule) {
		if (!fs || typeof fs.realpath !== 'function' || typeof fs.open !== 'function'
				|| !pathModule || typeof pathModule.join !== 'function') {
			throw new Error('Node read-only lease host requires fs.promises and path');
		}
		let noFollow = fs.constants && fs.constants.O_NOFOLLOW;
		if (!Number.isInteger(noFollow) || noFollow === 0) {
			throw new Error('Atomic read-only leases require O_NOFOLLOW');
		}
		const records = new WeakMap();

		function recordFor(access, capability) {
			let record = records.get(access);
			return record && record.active && record.capability === capability ? record : null;
		}

		async function acquireVerifiedDocument(request = {}) {
			let classified = readonlyClassification(request.relativePath);
			let requestedRoot = stripTrailingSeparators(request.root);
			let realRoot = stripTrailingSeparators(await fs.realpath(requestedRoot));
			if (realRoot !== requestedRoot
					|| request.authority !== classified.authority
					|| request.kind !== classified.kind
					|| request.writable !== false) {
				throw new Error('Verified document request does not match its canonical path');
			}
			let boundary = pathModule.join(realRoot, classified.authority);
			let target = pathModule.join(realRoot, classified.path);
			let realBoundary = stripTrailingSeparators(await fs.realpath(boundary));
			if (realBoundary !== boundary || target !== `${realRoot}/${classified.path}`) {
				throw new Error('Verified document authority boundary is not canonical');
			}
			let handle = await fs.open(
				target,
				fs.constants.O_RDONLY | noFollow
			);
			try {
				let stat = await handle.stat();
				if (!stat.isFile()) throw new Error('Verified document target is not a file');
				let realTarget = String(await fs.realpath(target));
				if (realTarget !== target || !realTarget.startsWith(`${realBoundary}/`)) {
					throw new Error('Verified document target escaped its authority boundary');
				}
				let access = Object.freeze({});
				let capability = Object.freeze({
					root: realRoot,
					relativePath: classified.path,
					canonicalPath: target,
					authority: classified.authority,
					kind: classified.kind,
					writable: false,
					access,
				});
				records.set(access, { active: true, capability, handle });
				return capability;
			}
			catch (error) {
				try { await handle.close(); }
				catch (closeError) {}
				throw error;
			}
		}

		async function closeCapability(capability) {
			let access = opaqueAccess(capability);
			let record = access && recordFor(access, capability);
			if (!record) return false;
			record.active = false;
			try {
				await record.handle.close();
				return true;
			}
			catch (error) {
				return false;
			}
		}

		return Object.freeze({
			acquireVerifiedDocument,
			verifyAccess(access, capability) {
				return !!recordFor(access, capability);
			},
			realPath: value => fs.realpath(value),
			async readVerified(access, capability) {
				let record = recordFor(access, capability);
				if (!record) throw new Error('Verified document lease access was revoked');
				let [text, stat] = await Promise.all([
					record.handle.readFile({ encoding: 'utf8' }),
					record.handle.stat(),
				]);
				if (!recordFor(access, capability)) {
					throw new Error('Verified document lease was revoked during read');
				}
				return Object.freeze({
					text: String(text),
					size: Number(stat.size) || 0,
					lastModified: Number(stat.mtimeMs) || 0,
				});
			},
			releaseVerifiedDocument: closeCapability,
			revokeVerifiedAccess: closeCapability,
		});
	};

	function validateCapability(capability, descriptor, root) {
		if (!capability || typeof capability !== 'object' || !Object.isFrozen(capability)) {
			throw new Error('Verified read-only document capability is required');
		}
		let access = opaqueAccess(capability);
		if (!access) throw new Error('Verified read-only document access is required');
		let classified = readonlyClassification(capability.relativePath);
		let normalized = Zotero.QLab.createWorkspaceDocumentDescriptor({
			relativePath: classified.path,
		});
		let expectedRoot = stripTrailingSeparators(root);
		let expectedPath = `${expectedRoot}/${normalized.relativePath}`;
		if (!descriptorMatches(descriptor, normalized)
				|| capability.root !== expectedRoot
				|| capability.relativePath !== normalized.relativePath
				|| capability.canonicalPath !== expectedPath
				|| capability.authority !== normalized.authority
				|| capability.kind !== normalized.kind
				|| capability.writable !== false) {
			throw new Error('Verified read-only document capability does not match the canonical document');
		}
		return { access, normalized, expectedRoot, expectedPath };
	}

	function verifiedReadMatches(read, descriptor) {
		if (!read || typeof read !== 'object' || !VERIFIED_READS.has(read)
				|| !read.document || !descriptor) return false;
		try {
			let normalizedRead = Zotero.QLab.createWorkspaceDocumentDescriptor({
				relativePath: read.document.relativePath,
			});
			let normalizedExpected = Zotero.QLab.createWorkspaceDocumentDescriptor({
				relativePath: descriptor.relativePath,
			});
			return descriptorMatches(read.document, normalizedRead)
				&& descriptorMatches(descriptor, normalizedExpected)
				&& normalizedRead.relativePath === normalizedExpected.relativePath;
		}
		catch (error) {
			return false;
		}
	}

	Zotero.QLab.isVerifiedReadonlyDocumentRead = function (read, descriptor) {
		return !CONSUMED_READS.has(read) && verifiedReadMatches(read, descriptor);
	};

	Zotero.QLab.consumeVerifiedReadonlyDocumentRead = function (read, descriptor, consumer) {
		if (!read || typeof read !== 'object' || !VERIFIED_READS.has(read)
				|| CONSUMED_READS.has(read)) return false;
		CONSUMED_READS.add(read);
		if (!verifiedReadMatches(read, descriptor)
				|| !consumer || (typeof consumer !== 'object' && typeof consumer !== 'function')) {
			return false;
		}
		let readContext = VERIFIED_READ_CONTEXTS.get(read);
		let sessionContext = READONLY_SESSION_CONTEXTS.get(consumer);
		if (!readContext || (sessionContext && sessionContext !== readContext)) return false;
		if (!sessionContext) READONLY_SESSION_CONTEXTS.set(consumer, readContext);
		return true;
	};

	Zotero.QLab.readonlyDocumentIOOwnsRoot = function (io, root) {
		let context = io && READONLY_IO_CONTEXTS.get(io);
		return !!context && context.root === stripTrailingSeparators(root);
	};

	Zotero.QLab.readonlyDocumentIOOwnsSession = function (io, session) {
		let ioContext = io && READONLY_IO_CONTEXTS.get(io);
		let sessionContext = session && READONLY_SESSION_CONTEXTS.get(session);
		return !!ioContext && ioContext === sessionContext;
	};

	Zotero.QLab.createReadonlyDocumentIO = function ({
		root,
		host,
		acquireVerifiedDocument = null,
		releaseVerifiedDocument = null,
		onRead = () => {},
	} = {}) {
		let canonicalRoot = stripTrailingSeparators(root);
		if (!canonicalRoot || canonicalRoot === '/'
				|| !host || typeof host.verifyAccess !== 'function'
				|| typeof host.realPath !== 'function' || typeof host.readVerified !== 'function') {
			throw new Error('Read-only document IO requires an atomic readVerified lease host');
		}
		let context = Object.freeze({
			root: canonicalRoot,
			identity: Object.freeze(Object.create(null)),
		});

		async function read(capability, expectedDescriptor = null) {
			let candidate = expectedDescriptor
				|| Zotero.QLab.createWorkspaceDocumentDescriptor({
					relativePath: capability && capability.relativePath,
				});
			if (!Object.isFrozen(candidate) || !Object.isFrozen(candidate.capabilities)
					|| !Object.isFrozen(candidate.surfaces)) {
				throw new Error('A frozen read-only document descriptor is required');
			}
			let descriptor = Zotero.QLab.createWorkspaceDocumentDescriptor({
				relativePath: candidate.relativePath,
			});
			let verified = validateCapability(capability, descriptor, canonicalRoot);
			if (CONSUMED_CAPABILITIES.has(capability) || CONSUMED_ACCESS.has(verified.access)) {
				throw new Error('Verified read-only document lease was already consumed');
			}
			// Claim before the first await so a concurrent caller cannot pass the
			// reuse check. Failed verification intentionally burns the lease.
			CONSUMED_CAPABILITIES.add(capability);
			CONSUMED_ACCESS.add(verified.access);
			if (await host.verifyAccess(verified.access, capability) !== true) {
				throw new Error('Verified read-only document access was revoked');
			}
			onRead(capability);
			let boundary = descriptor.authority;
			let [realRoot, realBoundary, realPath] = await Promise.all([
				host.realPath(canonicalRoot),
				host.realPath(`${canonicalRoot}/${boundary}`),
				host.realPath(verified.expectedPath),
			]);
			realRoot = stripTrailingSeparators(realRoot);
			realBoundary = stripTrailingSeparators(realBoundary);
			realPath = String(realPath || '');
			if (realRoot !== canonicalRoot
					|| realBoundary !== `${realRoot}/${boundary}`
					|| realPath !== `${realRoot}/${descriptor.relativePath}`) {
				throw new Error('Read-only document uses a symbolic link or resolves outside its canonical authority boundary');
			}
			if (await host.verifyAccess(verified.access, capability) !== true) {
				throw new Error('Verified read-only document access was revoked before read');
			}
			let atomicRead = await host.readVerified(verified.access, capability);
			if (!atomicRead || typeof atomicRead !== 'object'
					|| typeof atomicRead.text !== 'string') {
				throw new Error('Atomic verified document read returned an invalid result');
			}
			if (await host.verifyAccess(verified.access, capability) !== true) {
				throw new Error('Verified read-only document access was revoked during read');
			}
			let text = atomicRead.text;
			let metadata = `${Number(atomicRead.size) || 0}:${Number(atomicRead.lastModified) || 0}`;
			let contentHash = Zotero.QLab.QmdDraftIO && Zotero.QLab.QmdDraftIO._hash
				? Zotero.QLab.QmdDraftIO._hash(text)
				: String(text.length);
			let revision = `${metadata || 'unknown'}:${contentHash}`;
			let result = Object.freeze({
				document: descriptor,
				text,
				revision,
			});
			VERIFIED_READS.add(result);
			VERIFIED_READ_CONTEXTS.set(result, context);
			return result;
		}

		async function reload(descriptor) {
			if (typeof acquireVerifiedDocument !== 'function'
					|| typeof releaseVerifiedDocument !== 'function') {
				throw new Error('Read-only document reload requires fresh verified lease acquisition');
			}
			let normalized = Zotero.QLab.createWorkspaceDocumentDescriptor({
				relativePath: descriptor && descriptor.relativePath,
			});
			let request = Object.freeze({
				root: canonicalRoot,
				relativePath: normalized.relativePath,
				authority: normalized.authority,
				kind: normalized.kind,
				writable: false,
			});
			let capability = await acquireVerifiedDocument(request);
			let result;
			let operationError = null;
			try {
				result = await read(capability, normalized);
			}
			catch (error) {
				operationError = error;
			}
			let released = false;
			try {
				released = await releaseVerifiedDocument(capability) === true;
			}
			catch (error) {}
			if (!released && typeof host.revokeVerifiedAccess === 'function') {
				try { await host.revokeVerifiedAccess(capability); }
				catch (error) {}
			}
			if (!released) {
				throw new Error('Read-only document lease release/revocation failed');
			}
			if (operationError) throw operationError;
			return result;
		}

		let io = Object.freeze({ read, reload });
		READONLY_IO_CONTEXTS.set(io, context);
		return io;
	};
})();
