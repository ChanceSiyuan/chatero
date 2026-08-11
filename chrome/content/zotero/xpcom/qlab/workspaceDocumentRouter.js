/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Chance Siyuan / Chatero contributors

	This file is part of Chatero (a Zotero fork).

	***** END LICENSE BLOCK *****
*/

/** Closed, authority-aware routing for Research Loop documents. */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const SOURCES = new Set(['explorer', 'quick-open', 'site', 'deep-link']);
	const PLACEMENTS = new Set(['current', 'beside']);
	const ACTION_BRIDGES = Object.freeze({
		'open-draft': 'openDraft',
		'open-readonly-qmd': 'openReadonlyQmd',
		'open-readonly-bib': 'openReadonlyBib',
		'open-knowledge-site': 'openKnowledgeSite',
		'open-native-reader': 'openNativeReader',
		'review-pdf-link': 'reviewPDFLink',
	});
	// Leases are process-scoped, not router-scoped: native tab remounts may
	// construct a new router and must not make a revoked host access reusable.
	const CONSUMED_CAPABILITIES = new WeakSet();
	const CONSUMED_ACCESS = new WeakSet();
	const ROUTE_STAGES = new WeakMap();

	function synchronousCallback(callback, name) {
		if (typeof callback !== 'function') {
			throw new Error(`Workspace document route stage requires a ${name} callback`);
		}
		let tag = Object.prototype.toString.call(callback);
		if (tag === '[object AsyncFunction]' || callback.constructor?.name === 'AsyncFunction') {
			throw new Error(`Workspace document route stage ${name} callback must be synchronous`);
		}
		return callback;
	}

	Zotero.QLab.createWorkspaceDocumentRouteStage = function ({ commit, rollback } = {}) {
		let token = Object.freeze(Object.create(null));
		ROUTE_STAGES.set(token, {
			commit: synchronousCallback(commit, 'commit'),
			rollback: synchronousCallback(rollback, 'rollback'),
			status: 'pending',
		});
		return token;
	};

	function pendingRouteStage(value) {
		let state = value && ROUTE_STAGES.get(value);
		return state && state.status === 'pending' ? state : null;
	}

	function invokeRouteStage(token, action) {
		let state = token && ROUTE_STAGES.get(token);
		if (!state) return false;
		if (action === 'commit' && state.status !== 'pending') return false;
		if (action === 'rollback'
				&& state.status !== 'pending' && state.status !== 'commit-failed') return false;
		state.status = action === 'commit' ? 'committing' : 'rolling-back';
		try {
			let result = state[action]();
			if (result && typeof result.then === 'function') {
				Promise.resolve(result).catch(error => {
					Zotero.logError && Zotero.logError(error);
				});
				state.status = action === 'commit' ? 'commit-failed' : 'rolled-back';
				return false;
			}
			let accepted = result === true;
			state.status = action === 'commit'
				? (accepted ? 'committed' : 'commit-failed')
				: 'rolled-back';
			return accepted;
		}
		catch (error) {
			state.status = action === 'commit' ? 'commit-failed' : 'rolled-back';
			Zotero.logError && Zotero.logError(error);
			return false;
		}
	}

	function requiresStagedCommit(decision) {
		return decision && (decision.action === 'open-readonly-qmd'
			|| decision.action === 'open-readonly-bib');
	}

	function refuse(reason) {
		return Object.freeze({ action: 'refuse', reason: String(reason || 'unsafe-document') });
	}

	function canonicalRoot(value) {
		let root = String(value || '');
		if (!root || !root.startsWith('/')
				|| root.includes(String.fromCharCode(92)) || root.includes(String.fromCharCode(0))
				|| (root.length > 1 && root.endsWith('/'))) return '';
		let segments = root.split('/').slice(1);
		if (segments.some(segment => !segment || segment === '.' || segment === '..')) return '';
		return root;
	}

	function safeRelativePath(value) {
		let path = String(value || '');
		if (!path || path.includes('%') || path.includes('?') || path.includes('#')
				|| path.includes(String.fromCharCode(92)) || path.includes(String.fromCharCode(0))
				|| path.startsWith('/')) return '';
		if (!Zotero.QLab.isSafeWorkspaceRelativePath
				|| !Zotero.QLab.isSafeWorkspaceRelativePath(path)) return '';
		return path;
	}

	function classification(path, kind, authority, openMode, writable) {
		return Object.freeze({ path, kind, authority, openMode, writable });
	}

	Zotero.QLab.classifyWorkspaceDocument = function (relativePath) {
		let path = safeRelativePath(relativePath);
		if (!path) return null;
		let lower = path.toLowerCase();
		if (path.startsWith('drafts/') && lower.endsWith('.qmd')) {
			return classification(path, 'qmd', 'draft', 'edit', true);
		}
		if (path.startsWith('knowledge/') && lower.endsWith('.qmd')) {
			return classification(path, 'qmd', 'knowledge', 'site', false);
		}
		if (!path.startsWith('literature/')) return null;
		if (lower.endsWith('.qmd')) return classification(path, 'qmd', 'literature', 'readonly', false);
		if (lower.endsWith('.md')) return classification(path, 'markdown', 'literature', 'readonly', false);
		if (lower.endsWith('.bib')) return classification(path, 'bib', 'literature', 'readonly', false);
		if (lower.endsWith('.pdf')) return classification(path, 'pdf', 'literature', 'reader', false);
		return null;
	};

	function knowledgeSitePath(relativePath) {
		let within = relativePath.slice('knowledge/'.length);
		let segments = within.split('/').map(segment => encodeURIComponent(segment));
		let encoded = segments.join('/');
		if (encoded === 'index.qmd') return '/knowledge/';
		if (encoded.endsWith('/index.qmd')) {
			return `/knowledge/${encoded.slice(0, -'index.qmd'.length)}`;
		}
		return `/knowledge/${encoded.slice(0, -'.qmd'.length)}.html`;
	}

	Zotero.QLab.workspaceDocumentOpenDecision = function (input = {}) {
		let root = canonicalRoot(input.root);
		let selectedRoot = canonicalRoot(input.selectedRoot);
		if (!root || !selectedRoot || root !== selectedRoot) return refuse('foreign-or-noncanonical-root');
		let source = input.source || 'explorer';
		let placement = input.placement || 'current';
		if (!SOURCES.has(source) || !PLACEMENTS.has(placement)) return refuse('unsupported-routing-context');
		let document = Zotero.QLab.classifyWorkspaceDocument(input.relativePath);
		if (!document) return refuse('unsupported-or-unsafe-document');
		let base = { root, relativePath: document.path };
		if (document.authority === 'draft') {
			return Object.freeze({ action: 'open-draft', ...base, placement });
		}
		if (document.authority === 'knowledge') {
			if (input.explicitSource === true) {
				return Object.freeze({ action: 'open-readonly-qmd', ...base, placement });
			}
			return Object.freeze({
				action: 'open-knowledge-site', ...base,
				sitePath: knowledgeSitePath(document.path), placement,
			});
		}
		if (document.kind === 'qmd' || document.kind === 'markdown') {
			return Object.freeze({ action: 'open-readonly-qmd', ...base, placement });
		}
		if (document.kind === 'bib') {
			return Object.freeze({ action: 'open-readonly-bib', ...base, placement });
		}
		if (document.kind === 'pdf') {
			let attachmentID = input.attachmentID;
			if (Number.isSafeInteger(attachmentID) && attachmentID > 0) {
				return Object.freeze({ action: 'open-native-reader', ...base, attachmentID, placement });
			}
			return Object.freeze({ action: 'review-pdf-link', ...base, placement });
		}
		return refuse('unsupported-document-kind');
	};

	function routeAvailability(input, path) {
		let available = input.availablePaths;
		if (available && typeof available.has === 'function') return available.has(path);
		if (Array.isArray(available)) return available.includes(path);
		if (typeof input.pathExists === 'function') return input.pathExists(path) === true;
		return false;
	}

	Zotero.QLab.knowledgeURLToQmdPath = function (input = {}) {
		let origin;
		let requested;
		try {
			origin = new URL(String(input.currentSiteOrigin || ''));
			requested = new URL(String(input.requestedURL || ''));
		}
		catch (error) { return null; }
		let port = Number(origin.port);
		if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
				|| !Number.isInteger(port) || port < 4180 || port > 4199
				|| origin.username || origin.password
				|| origin.origin !== String(input.currentSiteOrigin || '').replace(/\/$/, '')) return null;
		if (requested.origin !== origin.origin || requested.username || requested.password) return null;
		let raw = String(input.requestedURL || '');
		let rawPath = raw.slice(raw.indexOf(origin.origin) + origin.origin.length).split(/[?#]/, 1)[0];
		if (/%(?:2e|2f|5c)/i.test(rawPath) || rawPath.includes(String.fromCharCode(92))) return null;
		let pathname;
		try { pathname = decodeURIComponent(requested.pathname); }
		catch (error) { return null; }
		if (pathname.includes(String.fromCharCode(92)) || !pathname.startsWith('/knowledge/')) return null;
		let pieces = pathname.split('/').filter(Boolean);
		if (pieces.some(piece => piece === '.' || piece === '..')) return null;
		let within = pathname.slice('/knowledge/'.length);
		let relativePath;
		if (!within || pathname.endsWith('/')) relativePath = `knowledge/${within}index.qmd`;
		else if (within.endsWith('.html')) relativePath = `knowledge/${within.slice(0, -'.html'.length)}.qmd`;
		else return null;
		if (!Zotero.QLab.classifyWorkspaceDocument(relativePath)) return null;
		return routeAvailability(input, relativePath) ? relativePath : null;
	};

	function opaqueAccess(capability) {
		for (let name of ['access', 'handle', 'token']) {
			let value = capability && capability[name];
			if ((typeof value === 'object' && value !== null)
					|| typeof value === 'function') return value;
		}
		return null;
	}

	function verifiedCapabilityMatches(capability, request) {
		if (!capability || typeof capability !== 'object' || !Object.isFrozen(capability)
				|| !opaqueAccess(capability)) return false;
		let expectedPath = `${request.root}/${request.relativePath}`;
		return capability.root === request.root
			&& capability.relativePath === request.relativePath
			&& capability.canonicalPath === expectedPath
			&& capability.authority === request.authority
			&& capability.kind === request.kind
			&& capability.writable === request.writable;
	}

	/**
	 * `acquireVerifiedDocument` is the mandatory trusted-host boundary. It must
	 * realpath root, authority boundary, and target; reject symlink/containment
	 * mismatches; and return a frozen, host-owned access/handle/token lease.
	 * Each capability is consumed once and must be irrevocably released after its
	 * fixed bridge returns. Release must resolve true or the route fails. Write
	 * bridges must use that access or repeat no-follow verification at the actual
	 * open/write operation. The router never returns the capability to its caller.
	 */
	Zotero.QLab.createWorkspaceDocumentRouter = function (bridges = {}) {
		function validSelectionEpoch(value) {
			return (Number.isSafeInteger(value) && value >= 0)
				|| (typeof value === 'string' && value.trim().length > 0);
		}

		async function selectedState() {
			if (typeof bridges.getSelectedRepositoryState !== 'function') return null;
			let state;
			try {
				state = await bridges.getSelectedRepositoryState();
			}
			catch (error) { return null; }
			if (!state || typeof state !== 'object' || typeof state.root !== 'string') return null;
			let root = canonicalRoot(state.root);
			let epoch = state.epoch;
			if (!root || root !== state.root) return null;
			if (!validSelectionEpoch(epoch)) return null;
			return Object.freeze({ root, epoch });
		}

		function sameSelection(initial, current) {
			if (!initial || !current || initial.root !== current.root) return false;
			return current.epoch === initial.epoch;
		}

		async function canonicalizeRequestedRoot(value) {
			if (typeof bridges.canonicalizeRoot !== 'function') return '';
			try { return canonicalRoot(await bridges.canonicalizeRoot(value)); }
			catch (error) { return ''; }
		}

		async function releaseCapability(capability) {
			try { return await bridges.releaseVerifiedDocument(capability) === true; }
			catch (error) { return false; }
		}

		return Object.freeze({
			async open(input = {}) {
				if (typeof bridges.acquireVerifiedDocument !== 'function') {
					return refuse('verified-document-lease-unavailable');
				}
				if (typeof bridges.releaseVerifiedDocument !== 'function') {
					return refuse('document-lease-release-failed');
				}
				let initialSelection = await selectedState();
				if (!initialSelection) return refuse('selected-repository-unavailable');
				let requestedRoot = input.root
					? await canonicalizeRequestedRoot(input.root) : initialSelection.root;
				if (!requestedRoot || requestedRoot !== initialSelection.root) {
					return refuse('foreign-or-noncanonical-root');
				}
				let relativePath = input.relativePath;
				let explicitSource = input.explicitSource === true;
				let source = input.source || 'explorer';
				if (input.requestedURL) {
					if (typeof bridges.getCurrentSiteOrigin !== 'function'
							|| typeof bridges.getKnowledgePaths !== 'function') {
						return refuse('trusted-knowledge-route-state-unavailable');
					}
					let currentSiteOrigin;
					let availablePaths;
					try {
						currentSiteOrigin = await bridges.getCurrentSiteOrigin({ root: initialSelection.root });
						availablePaths = await bridges.getKnowledgePaths({ root: initialSelection.root });
					}
					catch (error) { return refuse('trusted-knowledge-route-state-unavailable'); }
					relativePath = Zotero.QLab.knowledgeURLToQmdPath({
						currentSiteOrigin,
						requestedURL: input.requestedURL,
						availablePaths,
					});
					if (!relativePath) return refuse('unsafe-or-missing-knowledge-route');
					explicitSource = true;
					source = 'site';
				}
				let document = Zotero.QLab.classifyWorkspaceDocument(relativePath);
				if (!document) return refuse('unsupported-or-unsafe-document');
				let verificationRequest = Object.freeze({
					root: initialSelection.root,
					relativePath: document.path,
					authority: document.authority,
					kind: document.kind,
					writable: document.writable,
				});
				let capability;
				try {
					capability = await bridges.acquireVerifiedDocument(verificationRequest);
				}
				catch (error) { return refuse('document-verification-failed'); }
				if (capability === null || capability === false || capability === undefined) {
					return refuse('verified-document-capability-mismatch');
				}
				let operationResult;
				let routeStage = null;
				let stagedDecision = null;
				if (!verifiedCapabilityMatches(capability, verificationRequest)) {
					operationResult = refuse('verified-document-capability-mismatch');
				}
				else {
					let access = opaqueAccess(capability);
					if (CONSUMED_CAPABILITIES.has(capability) || CONSUMED_ACCESS.has(access)) {
						operationResult = refuse('verified-document-capability-reused');
					}
					else {
						CONSUMED_CAPABILITIES.add(capability);
						CONSUMED_ACCESS.add(access);
					}
				}
				if (!operationResult) try {
					let attachmentID = null;
					if (document.kind === 'pdf' && typeof bridges.findAttachment === 'function') {
						let match = await bridges.findAttachment(capability);
						attachmentID = typeof match === 'object' && match ? match.id : match;
					}
					let currentSelection = await selectedState();
					if (!sameSelection(initialSelection, currentSelection)) {
						operationResult = refuse('selected-repository-changed');
					}
					else {
						let normalizedInput = {
							root: currentSelection.root,
							selectedRoot: currentSelection.root,
							relativePath: document.path,
							source,
							placement: input.placement || 'current',
							explicitSource,
							attachmentID,
						};
						let decision = Zotero.QLab.workspaceDocumentOpenDecision(normalizedInput);
						if (decision.action === 'refuse') operationResult = decision;
						else {
							let bridgeName = ACTION_BRIDGES[decision.action];
							let bridge = bridgeName && bridges[bridgeName];
							if (typeof bridge !== 'function') {
								operationResult = refuse('routing-bridge-unavailable');
							}
							else {
								// No await is permitted between the final atomic repository
								// snapshot above and this bridge invocation.
								let bridgePromise = bridge(decision, capability);
								let bridgeResult = await bridgePromise;
								if (requiresStagedCommit(decision)) {
									if (pendingRouteStage(bridgeResult)) {
										routeStage = bridgeResult;
										stagedDecision = decision;
									}
									else operationResult = refuse('routing-stage-required');
								}
								else {
									operationResult = bridgeResult === true
										? decision : refuse('routing-bridge-refused');
								}
							}
						}
					}
				}
				catch (error) { operationResult = refuse('document-lease-operation-failed'); }
				let released = await releaseCapability(capability);
				if (!released) {
					if (routeStage) invokeRouteStage(routeStage, 'rollback');
					return refuse('document-lease-release-failed');
				}
				if (routeStage) {
					let finalSelection = await selectedState();
					if (!sameSelection(initialSelection, finalSelection)) {
						invokeRouteStage(routeStage, 'rollback');
						return refuse('selected-repository-changed');
					}
					if (!invokeRouteStage(routeStage, 'commit')) {
						invokeRouteStage(routeStage, 'rollback');
						return refuse('routing-stage-commit-failed');
					}
					return stagedDecision;
				}
				return operationResult;
			},
		});
	};
})();
