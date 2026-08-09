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

	Zotero.QLab.createWorkspaceDocumentRouter = function (bridges = {}) {
		async function canonicalize(value) {
			if (typeof bridges.canonicalizeRoot !== 'function') return '';
			try { return canonicalRoot(await bridges.canonicalizeRoot(value)); }
			catch (error) { return ''; }
		}

		return Object.freeze({
			async open(input = {}) {
				let selectedValue = typeof bridges.getSelectedRoot === 'function'
					? await bridges.getSelectedRoot() : '';
				let selectedRoot = await canonicalize(selectedValue);
				let requestedRoot = await canonicalize(input.root || selectedValue);
				if (!selectedRoot || requestedRoot !== selectedRoot) return refuse('foreign-or-noncanonical-root');
				let relativePath = input.relativePath;
				let explicitSource = input.explicitSource === true;
				let source = input.source || 'explorer';
				if (input.requestedURL) {
					relativePath = Zotero.QLab.knowledgeURLToQmdPath({
						currentSiteOrigin: input.currentSiteOrigin,
						requestedURL: input.requestedURL,
						availablePaths: input.availablePaths,
						pathExists: input.pathExists,
					});
					if (!relativePath) return refuse('unsafe-or-missing-knowledge-route');
					explicitSource = true;
					source = 'site';
				}
				let document = Zotero.QLab.classifyWorkspaceDocument(relativePath);
				if (!document) return refuse('unsupported-or-unsafe-document');
				if (typeof bridges.validateDocument === 'function') {
					let valid = await bridges.validateDocument({ root: selectedRoot, relativePath: document.path });
					if (valid !== true) return refuse('document-path-validation-failed');
				}
				let attachmentID = null;
				if (document.kind === 'pdf' && typeof bridges.findAttachment === 'function') {
					let match = await bridges.findAttachment({ root: selectedRoot, relativePath: document.path });
					attachmentID = typeof match === 'object' && match ? match.id : match;
				}
				let normalizedInput = {
					root: selectedRoot, selectedRoot, relativePath: document.path,
					source, placement: input.placement || 'current', explicitSource, attachmentID,
				};
				let decision = Zotero.QLab.workspaceDocumentOpenDecision(normalizedInput);
				if (decision.action === 'refuse') return decision;
				// Recompute from the normalized authority-bearing input immediately
				// before dispatch so caller metadata can never select a bridge.
				let verified = Zotero.QLab.workspaceDocumentOpenDecision(normalizedInput);
				if (verified.action !== decision.action
						|| verified.root !== decision.root
						|| verified.relativePath !== decision.relativePath) {
					return refuse('routing-decision-changed');
				}
				let bridgeName = ACTION_BRIDGES[verified.action];
				let bridge = bridgeName && bridges[bridgeName];
				if (typeof bridge !== 'function') return refuse('routing-bridge-unavailable');
				await bridge(verified);
				return verified;
			},
		});
	};
})();
