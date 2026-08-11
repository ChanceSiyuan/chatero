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

	function routeClassification(relativePath) {
		let document = Zotero.QLab.classifyWorkspaceDocument
			? Zotero.QLab.classifyWorkspaceDocument(relativePath)
			: null;
		if (!document
				|| !['draft', 'knowledge', 'literature'].includes(document.authority)
				|| !['qmd', 'markdown', 'bib', 'pdf'].includes(document.kind)) {
			throw new Error('Unsupported or unsafe workspace document route');
		}
		return document;
	}

	function canonicalRepositoryRoot(value) {
		let root = String(value || '');
		if (!root || root === '/' || !root.startsWith('/')
				|| root.endsWith('/') || root.includes(String.fromCharCode(92))
				|| root.includes(String.fromCharCode(0))) {
			throw new Error('Workspace document repository root is unsafe');
		}
		let segments = root.split('/').slice(1);
		if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
			throw new Error('Workspace document repository root is unsafe');
		}
		return root;
	}

	function validRepositoryEpoch(value) {
		return (Number.isSafeInteger(value) && value >= 0)
			|| (typeof value === 'string' && value.trim().length > 0);
	}

	function nativeStatType(stat) {
		if (!stat || typeof stat !== 'object') return '';
		if (stat.type === 'file' || stat.type === 'directory') return stat.type;
		if (stat.isFile === true || (typeof stat.isFile === 'function' && stat.isFile())) {
			return 'file';
		}
		if (stat.isDirectory === true
				|| (typeof stat.isDirectory === 'function' && stat.isDirectory())) {
			return 'directory';
		}
		return String(stat.type || '');
	}

	function nativeStatSize(stat) {
		let size = Number(stat && stat.size);
		return Number.isSafeInteger(size) && size >= 0 ? size : -1;
	}

	function nativeFileIdentity(stat) {
		let size = nativeStatSize(stat);
		if (nativeStatType(stat) !== 'file' || size < 0) return null;
		let identity = { size };
		for (let name of ['device', 'inode', 'mtimeNs', 'ctimeNs']) {
			let value = stat && stat[name];
			let normalized = null;
			if (typeof value === 'number') {
				if (Number.isSafeInteger(value) && value >= 0) normalized = String(value);
			}
			else if (typeof value === 'bigint') {
				if (value >= 0n) normalized = value.toString(10);
			}
			else if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
				normalized = value;
			}
			if (normalized === null) return null;
			identity[name] = normalized;
		}
		return Object.freeze(identity);
	}

	function sameNativeFileIdentity(left, right) {
		return !!left && !!right
			&& left.device === right.device
			&& left.inode === right.inode
			&& left.size === right.size
			&& left.mtimeNs === right.mtimeNs
			&& left.ctimeNs === right.ctimeNs;
	}

	/**
	 * Pure handle-bound broker. `nativeOps` is deliberately descriptor-shaped:
	 * open `/`, descend one segment at a time with openat/no-follow semantics,
	 * retain every handle for the lease, and read only from the retained leaf.
	 */
	Zotero.QLab.createHandleBoundWorkspaceDocumentLeaseHost = function (nativeOps) {
		if (!nativeOps || typeof nativeOps.openRoot !== 'function'
				|| typeof nativeOps.openAt !== 'function'
				|| typeof nativeOps.stat !== 'function'
				|| typeof nativeOps.canonicalPath !== 'function'
				|| typeof nativeOps.read !== 'function'
				|| typeof nativeOps.close !== 'function'
				|| typeof nativeOps.currentRepositoryState !== 'function') {
			throw new Error('Handle-bound workspace document leases require native descriptor operations');
		}
		let maxTextBytes = Number(nativeOps.maxTextBytes);
		if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes <= 0) maxTextBytes = 4 * 1024 * 1024;
		let Decoder = nativeOps.TextDecoder
			|| (typeof TextDecoder !== 'undefined' ? TextDecoder : null);
		if (typeof Decoder !== 'function') {
			throw new Error('Handle-bound workspace document leases require fatal UTF-8 decoding');
		}
		const records = new WeakMap();
		const activeRecords = new Set();
		let lifecycle = 'active';
		let inFlight = 0;
		let idleWaiters = [];
		let generation = 0;

		function beginOperation() {
			if (lifecycle !== 'active') return null;
			inFlight++;
			let ended = false;
			return () => {
				if (ended) return;
				ended = true;
				inFlight--;
				if (inFlight === 0) {
					let waiters = idleWaiters;
					idleWaiters = [];
					for (let resolve of waiters) resolve();
				}
			};
		}

		function waitForIdle() {
			if (inFlight === 0) return Promise.resolve();
			return new Promise(resolve => idleWaiters.push(resolve));
		}

		async function runRecordOperation(record, operation) {
			let previous = record.operationTail;
			let release;
			record.operationTail = new Promise(resolve => { release = resolve; });
			await previous;
			try { return await operation(); }
			finally { release(); }
		}

		async function repositoryState() {
			let state = await nativeOps.currentRepositoryState();
			if (!state || typeof state !== 'object' || !validRepositoryEpoch(state.epoch)) {
				throw new Error('Workspace document repository epoch is unavailable');
			}
			return { root: canonicalRepositoryRoot(state.root), epoch: state.epoch };
		}

		async function closeHandles(handles) {
			let ok = true;
			for (let index = handles.length - 1; index >= 0; index--) {
				try { await nativeOps.close(handles[index]); }
				catch (error) { ok = false; }
			}
			return ok;
		}

		async function openPinnedDocument(root, relativePath) {
			let expected = '/';
			let handles = [];
			let segments = root.split('/').filter(Boolean).concat(relativePath.split('/'));
			try {
				let handle = await nativeOps.openRoot(Object.freeze({
					readOnly: true, noFollow: true, closeOnExec: true,
					directory: true, nonBlocking: false,
				}));
				handles.push(handle);
				let rootStat = await nativeOps.stat(handle);
				let rootPath = await nativeOps.canonicalPath(handle);
				if (nativeStatType(rootStat) !== 'directory' || String(rootPath) !== '/') {
					throw new Error('Workspace document filesystem root is not canonical');
				}
				for (let index = 0; index < segments.length; index++) {
					let segment = segments[index];
					if (!segment || segment === '.' || segment === '..'
							|| segment.includes('/') || segment.includes(String.fromCharCode(92))
							|| segment.includes(String.fromCharCode(0))) {
						throw new Error('Workspace document path segment is unsafe');
					}
					let directory = index < segments.length - 1;
					handle = await nativeOps.openAt(handle, segment, Object.freeze({
						readOnly: true, noFollow: true, closeOnExec: true,
						directory, nonBlocking: !directory,
					}));
					handles.push(handle);
					expected = expected === '/' ? `/${segment}` : `${expected}/${segment}`;
					let stat = await nativeOps.stat(handle);
					let path = await nativeOps.canonicalPath(handle);
					if (String(path) !== expected) {
						throw new Error('Workspace document handle escaped its canonical path');
					}
					if (directory && nativeStatType(stat) !== 'directory') {
						throw new Error('Workspace document ancestor is not a directory');
					}
				}
				return { handles, leaf: handles[handles.length - 1], canonicalPath: expected };
			}
			catch (error) {
				await closeHandles(handles);
				throw error;
			}
		}

		function privateRecord(access, capability, { allowClosing = false } = {}) {
			let record = access && records.get(access);
			return record && record.active && record.capability === capability
				&& (allowClosing || !record.closing) ? record : null;
		}

		async function recordIsCurrent(record) {
			if (!record || !record.active || lifecycle !== 'active') return false;
			try {
				let current = await repositoryState();
				return current.root === record.binding.root && current.epoch === record.binding.epoch;
			}
			catch (error) { return false; }
		}

		async function acquireVerifiedDocument(request = {}) {
			let endOperation = beginOperation();
			if (!endOperation) throw new Error('Workspace document lease host was destroyed');
			let opened = null;
			try {
				let current = await repositoryState();
				let requestedRoot = canonicalRepositoryRoot(request.root);
				if (requestedRoot !== current.root) {
					throw new Error('Workspace document repository root is stale');
				}
				if (!validRepositoryEpoch(request.epoch) || request.epoch !== current.epoch) {
					throw new Error('Workspace document repository epoch is stale');
				}
				let document = routeClassification(request.relativePath);
				if (request.relativePath !== document.path
						|| request.authority !== document.authority
						|| request.kind !== document.kind
						|| request.writable !== document.writable) {
					throw new Error('Workspace document route metadata does not match its path');
				}
				opened = await openPinnedDocument(current.root, document.path);
				let leafStat = await nativeOps.stat(opened.leaf);
				let leafIdentity = nativeFileIdentity(leafStat);
				if (!leafIdentity) {
					throw new Error('Workspace document leaf regular file identity is invalid');
				}
				let readableText = document.writable === false
					&& ['knowledge', 'literature'].includes(document.authority)
					&& ['qmd', 'markdown', 'bib'].includes(document.kind);
				if (readableText && leafIdentity.size > maxTextBytes) {
					throw new Error('Workspace document text exceeds the size limit');
				}
				let confirmed = await repositoryState();
				if (lifecycle !== 'active'
						|| confirmed.root !== current.root || confirmed.epoch !== current.epoch) {
					throw new Error('Workspace document repository binding became stale');
				}
				let access = Object.freeze(Object.create(null));
				let capability = Object.freeze({
					root: current.root,
					relativePath: document.path,
					canonicalPath: opened.canonicalPath,
					authority: document.authority,
					kind: document.kind,
					writable: document.writable,
					access,
				});
				let record = {
					active: true,
					closing: false,
					readConsumed: false,
					capability,
					access,
					handles: opened.handles,
					leaf: opened.leaf,
					identity: leafIdentity,
					readableText,
					operationTail: Promise.resolve(),
					binding: Object.freeze({
						root: current.root,
						epoch: current.epoch,
						generation: ++generation,
					}),
				};
				records.set(access, record);
				activeRecords.add(record);
				return capability;
			}
			catch (error) {
				if (opened) await closeHandles(opened.handles);
				throw error;
			}
			finally { endOperation(); }
		}

		async function releaseVerifiedDocument(capability) {
			let endOperation = beginOperation();
			if (!endOperation) return false;
			try {
				let access = opaqueAccess(capability);
				let record = privateRecord(access, capability);
				if (!record) return false;
				record.closing = true;
				return await runRecordOperation(record, async () => {
					record.active = false;
					activeRecords.delete(record);
					return closeHandles(record.handles);
				});
			}
			finally { endOperation(); }
		}

		async function readVerified(access, capability) {
			let endOperation = beginOperation();
			if (!endOperation) throw new Error('Workspace document lease host was destroyed');
			try {
				let record = privateRecord(access, capability);
				if (!record) throw new Error('Workspace document lease access was revoked');
				if (!record.readableText) {
					throw new Error('Workspace document lease is not readable read-only text');
				}
				if (record.readConsumed) {
					throw new Error('Workspace document read access was already consumed');
				}
				// Claim before the first await so concurrent callers cannot both read.
				record.readConsumed = true;
				return await runRecordOperation(record, async () => {
					if (!await recordIsCurrent(record)) {
						throw new Error('Workspace document repository binding is stale or revoked');
					}
					let before = await nativeOps.stat(record.leaf);
					let beforeIdentity = nativeFileIdentity(before);
					if (!sameNativeFileIdentity(record.identity, beforeIdentity)
							|| beforeIdentity.size > maxTextBytes) {
						throw new Error('Workspace document identity changed before its verified read');
					}
					let raw = await nativeOps.read(record.leaf, maxTextBytes + 1);
					let bytes;
					if (raw && typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(raw)) {
						bytes = new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength);
					}
					else throw new Error('Workspace document native read returned invalid bytes');
					if (bytes.byteLength > maxTextBytes) {
						throw new Error('Workspace document text grew beyond the read limit');
					}
					let after = await nativeOps.stat(record.leaf);
					let afterIdentity = nativeFileIdentity(after);
					if (!sameNativeFileIdentity(record.identity, afterIdentity)
							|| !sameNativeFileIdentity(beforeIdentity, afterIdentity)
							|| bytes.byteLength !== afterIdentity.size) {
						throw new Error('Workspace document changed during its verified read');
					}
					if (!await recordIsCurrent(record)) {
						throw new Error('Workspace document repository binding changed during read');
					}
					let text;
					try { text = new Decoder('utf-8', { fatal: true }).decode(bytes); }
					catch (error) { throw new Error('Workspace document contains invalid UTF-8 encoding'); }
					return Object.freeze({
						text,
						size: afterIdentity.size,
						lastModified: Number(after.lastModified) || 0,
					});
				});
			}
			finally { endOperation(); }
		}

		async function verifyRecord(access, capability, canonical) {
			let endOperation = beginOperation();
			if (!endOperation) return false;
			try {
				let record = privateRecord(access, capability);
				return !!record
					&& (!canonical
						|| capability.canonicalPath === `${record.binding.root}/${capability.relativePath}`)
					&& await recordIsCurrent(record);
			}
			finally { endOperation(); }
		}

		let host = {
			acquireVerifiedDocument,
			verifyAccess: (access, capability) => verifyRecord(access, capability, false),
			verifyCanonicalAccess: (access, capability) => verifyRecord(access, capability, true),
			readVerified,
			releaseVerifiedDocument,
			revokeVerifiedAccess: releaseVerifiedDocument,
			async destroy() {
				if (lifecycle !== 'active') return false;
				lifecycle = 'destroying';
				await waitForIdle();
				let ok = true;
				for (let record of Array.from(activeRecords)) {
					record.active = false;
					activeRecords.delete(record);
					if (!await closeHandles(record.handles)) ok = false;
				}
				if (typeof nativeOps.destroy === 'function') {
					try { await nativeOps.destroy(); }
					catch (error) { ok = false; }
				}
				lifecycle = 'destroyed';
				return ok;
			},
		};
		return Object.freeze(host);
	};

	/**
	 * Own the small Darwin libc surface needed by the descriptor broker.
	 * The wrapper deliberately exposes byte buffers rather than raw ctypes
	 * pointers so the security-sensitive parsing remains independently testable.
	 */
	Zotero.QLab.createDarwinWorkspaceDocumentCtypesBindings = function ({
		ctypes,
		library = null,
		architecture,
	} = {}) {
		if (!ctypes || typeof ctypes !== 'object') {
			throw new Error('Darwin workspace document access requires ctypes');
		}
		let libc = library;
		let closed = false;
		let closeLibrary = () => {
			if (closed || !libc) return false;
			closed = true;
			libc.close();
			return true;
		};
		try {
			if (!libc) {
				if (typeof ctypes.open !== 'function') {
					throw new Error('Darwin ctypes library loader is unavailable');
				}
				libc = ctypes.open('/usr/lib/libSystem.B.dylib');
			}
			if (!libc || typeof libc.declare !== 'function'
					|| typeof libc.close !== 'function') {
				throw new Error('Darwin ctypes library is invalid');
			}
			let normalizedArchitecture = String(architecture || '').toLowerCase();
			let fstatSymbol;
			if (normalizedArchitecture === 'arm64' || normalizedArchitecture === 'aarch64') {
				fstatSymbol = 'fstat';
			}
			else if (normalizedArchitecture === 'x86_64' || normalizedArchitecture === 'amd64') {
				fstatSymbol = 'fstat$INODE64';
			}
			else {
				throw new Error('Unsupported Darwin architecture for workspace document access');
			}

			let open = libc.declare(
				'open', ctypes.default_abi, ctypes.int, ctypes.char.ptr, ctypes.int
			);
			let openat = libc.declare(
				'openat', ctypes.default_abi, ctypes.int,
				ctypes.int, ctypes.char.ptr, ctypes.int
			);
			let fstat = libc.declare(
				fstatSymbol, ctypes.default_abi, ctypes.int, ctypes.int, ctypes.voidptr_t
			);
			let read = libc.declare(
				'read', ctypes.default_abi, ctypes.ssize_t,
				ctypes.int, ctypes.voidptr_t, ctypes.size_t
			);
			let close = libc.declare(
				'close', ctypes.default_abi, ctypes.int, ctypes.int
			);
			let fcntl = libc.declare(
				'fcntl', ctypes.default_abi, ctypes.int,
				ctypes.int, ctypes.int, ctypes.voidptr_t
			);

			function createBuffer(size) {
				if (!Number.isSafeInteger(size) || size <= 0) {
					throw new Error('Darwin native buffer size is invalid');
				}
				let BufferType = ctypes.ArrayType(ctypes.uint8_t, size);
				return new BufferType();
			}

			function byteArray(buffer, length) {
				if (!Number.isSafeInteger(length) || length < 0) {
					throw new Error('Darwin native byte length is invalid');
				}
				let result = new Uint8Array(length);
				for (let index = 0; index < length; index++) {
					result[index] = Number(buffer[index]);
				}
				return result;
			}

			return Object.freeze({
				open: (path, flags) => Number(open(path, flags)),
				openat: (fd, segment, flags) => Number(openat(fd, segment, flags)),
				fstat: (fd, buffer) => Number(fstat(fd, buffer.address())),
				fcntl: (fd, command, buffer) => Number(fcntl(fd, command, buffer.address())),
				read(fd, buffer, offset, length) {
					let pointer = offset === 0 ? buffer.address() : buffer.addressOfElement(offset);
					return Number(read(fd, pointer, length));
				},
				close: fd => Number(close(fd)),
				createBuffer,
				bytes: byteArray,
				errno: () => Number(ctypes.errno) || 0,
				destroy: closeLibrary,
			});
		}
		catch (error) {
			try { closeLibrary(); }
			catch (closeError) {}
			throw error;
		}
	};

	/** Darwin descriptor operations backed by the owned ctypes bindings above. */
	Zotero.QLab.createDarwinWorkspaceDocumentNativeOps = function ({
		bindings,
		currentRepositoryState,
		maxTextBytes = 4 * 1024 * 1024,
		TextDecoder: Decoder = typeof TextDecoder !== 'undefined' ? TextDecoder : null,
	} = {}) {
		for (let name of [
			'open', 'openat', 'fstat', 'fcntl', 'read', 'close',
			'createBuffer', 'bytes', 'errno', 'destroy',
		]) {
			if (!bindings || typeof bindings[name] !== 'function') {
				throw new Error(`Darwin workspace document binding is missing ${name}`);
			}
		}
		if (typeof currentRepositoryState !== 'function' || typeof Decoder !== 'function') {
			throw new Error('Darwin workspace document operations require repository state and UTF-8 decoding');
		}
		if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes <= 0) {
			throw new Error('Darwin workspace document text limit is invalid');
		}

		const O_RDONLY = 0x0000;
		const O_NONBLOCK = 0x0004;
		const O_NOFOLLOW = 0x0100;
		const O_DIRECTORY = 0x00100000;
		const O_CLOEXEC = 0x01000000;
		const F_GETPATH = 50;
		const PATH_MAX = 1024;
		const DARWIN_STAT_SIZE = 144;
		const S_IFMT = 0xf000;
		const S_IFREG = 0x8000;
		const S_IFDIR = 0x4000;
		const openHandles = new WeakMap();
		let destroyed = false;

		function nativeError(operation) {
			let errno = Number(bindings.errno()) || 0;
			return new Error(`${operation} failed for workspace document descriptor (errno ${errno})`);
		}

		function flags(options = {}) {
			if (options.readOnly !== true) {
				throw new Error('Darwin workspace document descriptors must be read-only');
			}
			let value = O_RDONLY;
			if (options.noFollow === true) value |= O_NOFOLLOW;
			if (options.closeOnExec === true) value |= O_CLOEXEC;
			if (options.directory === true) value |= O_DIRECTORY;
			if (options.nonBlocking === true) value |= O_NONBLOCK;
			return value;
		}

		function makeHandle(fd) {
			if (!Number.isInteger(fd) || fd < 0) throw nativeError('open');
			let handle = Object.freeze(Object.create(null));
			openHandles.set(handle, { fd, open: true });
			return handle;
		}

		function descriptor(handle) {
			let record = handle && openHandles.get(handle);
			if (!record || !record.open) {
				throw new Error('Darwin workspace document descriptor is closed or invalid');
			}
			return record;
		}

		function safeSegment(segment) {
			let value = String(segment || '');
			if (!value || value === '.' || value === '..'
					|| value.includes('/') || value.includes(String.fromCharCode(92))
					|| value.includes(String.fromCharCode(0))) {
				throw new Error('Darwin workspace document path segment is unsafe');
			}
			return value;
		}

		function bufferBytes(buffer, length) {
			let bytes = bindings.bytes(buffer, length);
			if (!bytes || typeof ArrayBuffer === 'undefined' || !ArrayBuffer.isView(bytes)
					|| bytes.byteLength < length) {
				throw new Error('Darwin workspace document native bytes are invalid');
			}
			return new Uint8Array(bytes.buffer, bytes.byteOffset || 0, length);
		}

		return Object.freeze({
			maxTextBytes,
			TextDecoder: Decoder,
			currentRepositoryState,
			async openRoot(options) {
				if (destroyed) throw new Error('Darwin workspace document operations were destroyed');
				return makeHandle(bindings.open('/', flags(options)));
			},
			async openAt(parent, segment, options) {
				if (destroyed) throw new Error('Darwin workspace document operations were destroyed');
				let parentRecord = descriptor(parent);
				let fd = bindings.openat(parentRecord.fd, safeSegment(segment), flags(options));
				return makeHandle(fd);
			},
			async stat(handle) {
				let record = descriptor(handle);
				let buffer = bindings.createBuffer(DARWIN_STAT_SIZE);
				if (bindings.fstat(record.fd, buffer) !== 0) throw nativeError('fstat');
				let bytes = bufferBytes(buffer, DARWIN_STAT_SIZE);
				let view = new DataView(bytes.buffer, bytes.byteOffset, DARWIN_STAT_SIZE);
				let mode = view.getUint16(4, true) & S_IFMT;
				let size = view.getBigInt64(96, true);
				let mtimeSeconds = view.getBigInt64(48, true);
				let mtimeNanoseconds = view.getBigInt64(56, true);
				let ctimeSeconds = view.getBigInt64(64, true);
				let ctimeNanoseconds = view.getBigInt64(72, true);
				if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)
						|| mtimeNanoseconds < 0n || mtimeNanoseconds >= 1000000000n
						|| ctimeNanoseconds < 0n || ctimeNanoseconds >= 1000000000n) {
					throw new Error('Darwin workspace document stat identity is invalid');
				}
				let mtimeNs = mtimeSeconds * 1000000000n + mtimeNanoseconds;
				let ctimeNs = ctimeSeconds * 1000000000n + ctimeNanoseconds;
				return Object.freeze({
					type: mode === S_IFREG ? 'file' : mode === S_IFDIR ? 'directory' : 'other',
					size: Number(size),
					device: String(view.getUint32(0, true)),
					inode: view.getBigUint64(8, true).toString(10),
					mtimeNs: mtimeNs.toString(10),
					ctimeNs: ctimeNs.toString(10),
					lastModified: Number(mtimeSeconds) * 1000 + Number(mtimeNanoseconds) / 1000000,
				});
			},
			async canonicalPath(handle) {
				let record = descriptor(handle);
				let buffer = bindings.createBuffer(PATH_MAX);
				if (bindings.fcntl(record.fd, F_GETPATH, buffer) !== 0) throw nativeError('fcntl F_GETPATH');
				let bytes = bufferBytes(buffer, PATH_MAX);
				let end = bytes.indexOf(0);
				if (end <= 0) throw new Error('Darwin workspace document canonical path is invalid');
				try { return new Decoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)); }
				catch (error) { throw new Error('Darwin workspace document canonical path is not UTF-8'); }
			},
			async read(handle, limit) {
				let record = descriptor(handle);
				if (!Number.isSafeInteger(limit) || limit <= 0) {
					throw new Error('Darwin workspace document read limit is invalid');
				}
				let buffer = bindings.createBuffer(limit);
				let offset = 0;
				while (offset < limit) {
					let count = Number(bindings.read(record.fd, buffer, offset, limit - offset));
					if (!Number.isSafeInteger(count) || count < 0 || count > limit - offset) {
						throw nativeError('read');
					}
					if (count === 0) break;
					offset += count;
				}
				return bufferBytes(buffer, offset);
			},
			async close(handle) {
				let record = descriptor(handle);
				// POSIX leaves descriptor state ambiguous after an interrupted close;
				// consume it before calling libc and never retry.
				record.open = false;
				if (bindings.close(record.fd) !== 0) throw nativeError('close');
			},
			async destroy() {
				if (destroyed) return false;
				destroyed = true;
				return await bindings.destroy() === true;
			},
		});
	};

	Zotero.QLab.createGeckoWorkspaceDocumentLeaseHost = function (options = {}) {
		let platform = String(options.platform
			|| (typeof Services !== 'undefined' && Services.appinfo && Services.appinfo.OS)
			|| '');
		if (platform !== 'Darwin') {
			throw new Error('Native workspace document leases are supported only on Darwin/macOS');
		}
		if (options.nativeOps) {
			return Zotero.QLab.createHandleBoundWorkspaceDocumentLeaseHost(options.nativeOps);
		}
		let bindings = null;
		try {
			let ctypes = options.ctypes;
			if (!ctypes) {
				if (typeof ChromeUtils === 'undefined'
						|| typeof ChromeUtils.importESModule !== 'function') {
					throw new Error('Darwin ctypes module is unavailable');
				}
				({ ctypes } = ChromeUtils.importESModule('resource://gre/modules/ctypes.sys.mjs'));
			}
			let architecture = String(options.architecture
				|| (typeof Services !== 'undefined' && Services.appinfo && Services.appinfo.XPCOMABI)
				|| '');
			if (/^(?:arm64|aarch64)(?:-|$)/iu.test(architecture)) architecture = 'arm64';
			else if (/^(?:x86_64|amd64)(?:-|$)/iu.test(architecture)) architecture = 'x86_64';
			bindings = Zotero.QLab.createDarwinWorkspaceDocumentCtypesBindings({
				ctypes,
				library: options.library || null,
				architecture,
			});
			let currentRepositoryState = options.currentRepositoryState
				|| options.getSelectedRepositoryState;
			let nativeOps = Zotero.QLab.createDarwinWorkspaceDocumentNativeOps({
				bindings,
				currentRepositoryState,
				maxTextBytes: options.maxTextBytes || 4 * 1024 * 1024,
				TextDecoder: options.TextDecoder
					|| (typeof TextDecoder !== 'undefined' ? TextDecoder : null),
			});
			return Zotero.QLab.createHandleBoundWorkspaceDocumentLeaseHost(nativeOps);
		}
		catch (error) {
			if (bindings) {
				try { bindings.destroy(); }
				catch (closeError) {}
			}
			throw error;
		}
	};

	/**
	 * Window-owned facade. Repository epochs never cross this boundary as public
	 * caller input: the current live selection is sampled here and privately
	 * captured by each readonly IO instance.
	 */
	Zotero.QLab.createWindowWorkspaceDocumentAccess = function ({
		leaseHost,
		getSelectedRepositoryState,
	} = {}) {
		if (!leaseHost || typeof leaseHost.acquireVerifiedDocument !== 'function'
				|| typeof leaseHost.releaseVerifiedDocument !== 'function'
				|| typeof leaseHost.destroy !== 'function'
				|| typeof getSelectedRepositoryState !== 'function') {
			throw new Error('Window workspace document access requires an owned lease host');
		}
		let lifecycle = 'active';
		let destroyPromise = null;
		const ioByRoot = new Map();

		async function selectedState() {
			let state = await getSelectedRepositoryState();
			if (!state || typeof state !== 'object' || !validRepositoryEpoch(state.epoch)) {
				throw new Error('Selected workspace repository epoch is unavailable');
			}
			return Object.freeze({
				root: canonicalRepositoryRoot(state.root),
				epoch: state.epoch,
			});
		}

		function sameBinding(left, right) {
			return !!left && !!right && left.root === right.root && left.epoch === right.epoch;
		}

		async function acquireForBinding(binding, request = {}) {
			if (lifecycle !== 'active') {
				throw new Error('Window workspace document access was destroyed');
			}
			let before = await selectedState();
			if (!sameBinding(binding, before)) {
				throw new Error('Window workspace document repository epoch is stale');
			}
			let capability = await leaseHost.acquireVerifiedDocument(Object.freeze({
				...request,
				root: binding.root,
				epoch: binding.epoch,
			}));
			let after;
			try { after = await selectedState(); }
			catch (error) { after = null; }
			if (lifecycle !== 'active' || !sameBinding(binding, after)) {
				try { await leaseHost.releaseVerifiedDocument(capability); }
				catch (error) {}
				throw new Error('Window workspace document repository binding changed during acquisition');
			}
			return capability;
		}

		let access = {
			async acquireVerifiedDocument(request = {}) {
				let binding = await selectedState();
				let requestedRoot = canonicalRepositoryRoot(request.root || binding.root);
				if (requestedRoot !== binding.root) {
					throw new Error('Window workspace document repository root is stale');
				}
				return acquireForBinding(binding, request);
			},
			releaseVerifiedDocument: capability => leaseHost.releaseVerifiedDocument(capability),
			async readonlyDocumentIOForRoot(root) {
				if (lifecycle !== 'active') return null;
				let canonicalRoot = canonicalRepositoryRoot(root);
				let binding = await selectedState();
				if (binding.root !== canonicalRoot || lifecycle !== 'active') return null;
				let cached = ioByRoot.get(canonicalRoot);
				if (cached && sameBinding(cached.binding, binding)) return cached.io;
				let privateBinding = Object.freeze({ root: binding.root, epoch: binding.epoch });
				let io = Zotero.QLab.createReadonlyDocumentIO({
					root: privateBinding.root,
					host: leaseHost,
					acquireVerifiedDocument: request => acquireForBinding(privateBinding, request),
					releaseVerifiedDocument: capability => (
						leaseHost.releaseVerifiedDocument(capability)
					),
				});
				ioByRoot.set(canonicalRoot, { binding: privateBinding, io });
				return io;
			},
			async destroy() {
				if (lifecycle !== 'active') return false;
				lifecycle = 'destroying';
				ioByRoot.clear();
				destroyPromise = Promise.resolve(leaseHost.destroy()).then(result => {
					lifecycle = 'destroyed';
					return result === true;
				}, error => {
					lifecycle = 'destroyed';
					throw error;
				});
				return destroyPromise;
			},
		};
		return Object.freeze(access);
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
		let hasCapabilityBoundary = host
			&& typeof host.verifyCanonicalAccess === 'function';
		let hasLegacyPathBoundary = host && typeof host.realPath === 'function';
		if (!canonicalRoot || canonicalRoot === '/'
				|| !host || typeof host.verifyAccess !== 'function'
				|| (!hasCapabilityBoundary && !hasLegacyPathBoundary)
				|| typeof host.readVerified !== 'function') {
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
			if (hasCapabilityBoundary) {
				if (await host.verifyCanonicalAccess(verified.access, capability) !== true) {
					throw new Error('Read-only document capability-bound canonical access was revoked');
				}
			}
			else {
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
			if (hasCapabilityBoundary
					&& await host.verifyCanonicalAccess(verified.access, capability) !== true) {
				throw new Error('Read-only document canonical access changed during read');
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
