/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Cursor-style QMD workspace composition for a native Chatero tab.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const WORKSPACE_ACTIVATION_TRANSACTIONS = new WeakMap();

	function workspaceActivationTransaction({
		commit,
		rollback,
		afterCommit = () => {},
		managesHostReset = false,
	}) {
		let token = Object.freeze(Object.create(null));
		WORKSPACE_ACTIVATION_TRANSACTIONS.set(token, Object.freeze({
			commit,
			rollback,
			afterCommit,
			managesHostReset: managesHostReset === true,
		}));
		return token;
	}

	function escapeHTML(value) {
		return String(value || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function icon(name) {
		if (name === 'cursor') {
			return '<img class="qlab-qmd-cursor-icon" src="chrome://zotero/skin/qlab-cursor.svg" alt="" aria-hidden="true"/>';
		}
		let paths = {
			folder: '<path d="M3 6.5h6l1.6 2H21v9.5H3z"/><path d="M3 6.5V5h6l1.6 2"/>',
			reload: '<path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-1.8 6.7"/>',
			save: '<path d="M5 3h12l3 3v15H4V3z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
			ai: '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
			diff: '<path d="M7 3v18M17 3v18M4 7h6M14 17h6"/>',
			keep: '<path d="M5 12l4 4L19 6"/>',
			reject: '<path d="M6 6l12 12M18 6L6 18"/>',
			preview: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/>',
			compliance: '<circle cx="12" cy="12" r="9"/><path d="M7.5 12l3 3 6-6"/>',
			promote: '<path d="M12 20V5M6.5 10.5L12 5l5.5 5.5"/><path d="M4 20h16"/>',
			todos: '<path d="M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10"/><path d="M4 12l1.2 1.2L8 10.4"/>',
			formal: '<path d="M4 6l8-3 8 3-8 3zM4 6v10l8 5 8-5V6M12 9v12"/>',
			external: '<path d="M5 5h7M5 5v14h14v-7"/><path d="M11 13L20 4M14 4h6v6"/>',
			search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
		};
		return `<svg viewBox="0 0 24 24" aria-hidden="true" data-qlab-icon="${escapeHTML(name)}">${paths[name] || paths.preview}</svg>`;
	}

	function iconButton(name, label, attribute, { disabled = false, l10nId = '', pressed = null } = {}) {
		return `<button type="button" class="qlab-qmd-workspace-action" ${attribute} `
			+ `${l10nId ? `data-l10n-id="${escapeHTML(l10nId)}" ` : ''}`
			+ `${pressed === null ? '' : `aria-pressed="${pressed ? 'true' : 'false'}" `}`
			+ `title="${escapeHTML(label)}" aria-label="${escapeHTML(label)}"${disabled ? ' disabled' : ''}>`
			+ `${icon(name)}<span class="sr-only">${escapeHTML(label)}</span></button>`;
	}

	function normalizedDocumentDescriptor(relativePath) {
		let classification = Zotero.QLab.classifyWorkspaceDocument
			? Zotero.QLab.classifyWorkspaceDocument(relativePath)
			: null;
		if (!classification) throw new Error('Unsupported or unsafe workspace document');
		if (classification.authority === 'draft') {
			return Zotero.QLab.createQmdDraftDocumentDescriptor({
				relativePath: classification.path,
			});
		}
		return Zotero.QLab.createWorkspaceDocumentDescriptor({
			relativePath: classification.path,
		});
	}

	function sessionDocument(session) {
		let snapshot = session && typeof session.snapshot === 'function'
			? session.snapshot()
			: null;
		if (!snapshot || !snapshot.path) return null;
		let normalized = normalizedDocumentDescriptor(snapshot.path);
		let candidate = snapshot.document;
		if (!candidate || !Object.isFrozen(candidate)
				|| !Object.isFrozen(candidate.capabilities)
				|| !Object.isFrozen(candidate.surfaces)) return normalized;
		for (let name of ['relativePath', 'authority', 'kind', 'format', 'readOnly', 'writable']) {
			if (candidate[name] !== normalized[name]) return normalized;
		}
		let normalizedCapabilities = Object.keys(normalized.capabilities).sort();
		let candidateCapabilities = Object.keys(candidate.capabilities).sort();
		if (normalizedCapabilities.length !== candidateCapabilities.length
				|| normalizedCapabilities.some((name, index) => (
					name !== candidateCapabilities[index]
					|| candidate.capabilities[name] !== normalized.capabilities[name]
				))) return normalized;
		if (candidate.surfaces.length !== normalized.surfaces.length
				|| candidate.surfaces.some((name, index) => name !== normalized.surfaces[index])) {
			return normalized;
		}
		return candidate;
	}

	Zotero.QLab.qmdSessionAllows = function (session, capability) {
		try {
			let snapshot = session && typeof session.snapshot === 'function'
				? session.snapshot()
				: null;
			let descriptor = snapshot && normalizedDocumentDescriptor(snapshot.path);
			return !!descriptor && descriptor.capabilities[String(capability || '')] === true;
		}
		catch (error) {
			return false;
		}
	};

	Zotero.QLab.runQmdWorkspaceCapability = function (
		session,
		capability,
		operation,
		deniedValue = false
	) {
		if (!Zotero.QLab.qmdSessionAllows(session, capability)) return deniedValue;
		return operation();
	};

	Zotero.QLab.runQmdWorkspaceRefresh = async function (operation, onError = () => {}) {
		try {
			return await operation();
		}
		catch (error) {
			onError(error);
			return false;
		}
	};

	function setHostDocumentState(host, descriptor, sessionSnapshot) {
		if (!host) return;
		let snapshot = sessionSnapshot || {};
		host._qlabDocumentState = Object.freeze({
			document: descriptor,
			path: descriptor.relativePath,
			revision: String(snapshot.revision || ''),
		});
		host._qlabBuffer = String(snapshot.text ?? '');
		host._qlabDirty = !!snapshot.dirty;
		let legacy = host.querySelector && host.querySelector('[data-qlab-editor]');
		if (legacy) legacy.value = host._qlabBuffer;
	}

	function clearHostDocumentState(host) {
		if (!host) return;
		host._qlabDocumentState = null;
		host._qlabBuffer = '';
		host._qlabDirty = false;
		let legacy = host.querySelector && host.querySelector('[data-qlab-editor]');
		if (legacy) legacy.value = '';
	}

	Zotero.QLab.finalizeQmdHostReadonlyActivation = function (host) {
		if (!host) return false;
		try {
			Zotero.QLab.releaseQmdWebsitePreviewLease?.(host);
		}
		catch (error) {
			Zotero.logError && Zotero.logError(error);
		}
		let turn = host._qlabTurnHandle;
		host._qlabTurnHandle = null;
		try {
			if (turn && typeof turn.cancel === 'function') turn.cancel();
			else if (turn && typeof turn.abort === 'function') turn.abort();
		}
		catch (error) {
			Zotero.logError && Zotero.logError(error);
		}
		return true;
	};

	Zotero.QLab.resetQmdHostForReadonlyDocument = function (
		host,
		descriptor,
		sessionSnapshot = {},
		{ finalizeTurn = true } = {}
	) {
		let normalized = Zotero.QLab.createWorkspaceDocumentDescriptor({
			relativePath: descriptor && descriptor.relativePath,
		});
		if (!host) return normalized;
		if (finalizeTurn) Zotero.QLab.finalizeQmdHostReadonlyActivation(host);
		host._qlabDraftState = null;
		host._qlabPendingInserts = [];
		host._qlabActiveBlockIndex = null;
		host._qlabMonacoSelection = null;
		host._qlabDirty = false;
		host._qlabLastSaved = null;
		host._qlabWebsiteUrl = '';
		let inline = host.querySelector && host.querySelector('[data-qlab-inline]');
		if (inline) inline.hidden = true;
		let prompt = host.querySelector && host.querySelector('[data-qlab-inline-prompt]');
		if (prompt) prompt.value = '';
		let pending = host.querySelector && host.querySelector('[data-qlab-pending]');
		if (pending) {
			pending.hidden = true;
			if (typeof pending.replaceChildren === 'function') pending.replaceChildren();
		}
		let compliance = host.querySelector && host.querySelector('[data-qlab-compliance]');
		if (compliance) {
			compliance.hidden = true;
			compliance.disabled = true;
			if (compliance.dataset) compliance.dataset.compliance = 'unavailable';
		}
		let complianceDetails = host.querySelector
			&& host.querySelector('[data-qlab-compliance-details]');
		if (complianceDetails) {
			complianceDetails.hidden = true;
			complianceDetails.textContent = '';
		}
		let mutationSelector = [
			'[data-qlab-draft-save]',
			'[data-qlab-draft-ai]',
			'[data-qlab-proposal-compare]',
			'[data-qlab-draft-keep]',
			'[data-qlab-draft-reject]',
			'[data-qlab-add-to-knowledge]',
			'[data-qlab-complete-todos]',
			'[data-qlab-formal-toggle]',
			'[data-qlab-external-editor]',
		].join(', ');
		for (let control of host.querySelectorAll ? host.querySelectorAll(mutationSelector) : []) {
			control.hidden = true;
			if ('disabled' in control) control.disabled = true;
		}
		let formalMenu = host.querySelector && host.querySelector('[data-qlab-formal-menu]');
		if (formalMenu) formalMenu.hidden = true;
		let formalToggle = host.querySelector && host.querySelector('[data-qlab-formal-toggle]');
		if (formalToggle) {
			formalToggle.hidden = true;
			if ('disabled' in formalToggle) formalToggle.disabled = true;
			formalToggle.setAttribute && formalToggle.setAttribute('aria-expanded', 'false');
		}
		let visualTools = host.querySelector && host.querySelector('[data-qlab-visual-tools]');
		if (visualTools) visualTools.hidden = true;
		setHostDocumentState(host, normalized, {
			...sessionSnapshot,
			dirty: false,
		});
		return normalized;
	};

	Zotero.QLab.createQmdWorkspaceDocumentManager = function ({
		root,
		readonlyIO,
		host = null,
		onActivate = () => {},
		onReload = () => {},
		onFailClosed = () => {},
	} = {}) {
		if (!root || !readonlyIO || typeof readonlyIO.read !== 'function'
				|| typeof readonlyIO.reload !== 'function'
				|| typeof Zotero.QLab.readonlyDocumentIOOwnsRoot !== 'function'
				|| !Zotero.QLab.readonlyDocumentIOOwnsRoot(readonlyIO, root)) {
			throw new Error('QMD workspace document manager requires verified read-only IO');
		}
		for (let [name, callback] of [
			['activation', onActivate],
			['reload', onReload],
			['fail-closed', onFailClosed],
		]) {
			let tag = Object.prototype.toString.call(callback);
			if (tag === '[object AsyncFunction]' || callback?.constructor?.name === 'AsyncFunction') {
				throw new Error(`QMD workspace ${name} callback must be synchronous`);
			}
		}
		let generation = 0;
		let activeDocument = null;
		let activeSession = null;
		let reloadGeneration = 0;
		let preparationGeneration = 0;
		let disposed = false;

		function safeDispose(session) {
			try {
				if (session && typeof session.dispose === 'function') session.dispose();
			}
			catch (error) {
				Zotero.logError && Zotero.logError(error);
			}
		}

		function captureHostState() {
			if (!host) return null;
			let values = new Map();
			for (let key of Object.keys(host)) {
				if (key.startsWith('_qlab')) values.set(key, host[key]);
			}
			return values;
		}

		function restoreHostState(values) {
			if (!host || !values) return;
			for (let key of Object.keys(host)) {
				if (key.startsWith('_qlab') && !values.has(key)) delete host[key];
			}
			for (let [key, value] of values) host[key] = value;
		}

		function requireSynchronousCallback(result, name, invalidate) {
			if (result && typeof result.then === 'function') {
				invalidate();
				Promise.resolve(result).catch(error => {
					Zotero.logError && Zotero.logError(error);
				});
				throw new Error(`QMD workspace ${name} callback must be synchronous`);
			}
		}

		function failClosedActive(session, error = null) {
			if (activeSession !== session) return false;
			let document = activeDocument;
			generation += 1;
			safeDispose(session);
			activeSession = null;
			activeDocument = null;
			clearHostDocumentState(host);
			try {
				requireSynchronousCallback(onFailClosed(Object.freeze({
					document,
					session,
					error,
					generation,
				})), 'fail-closed', () => {});
			}
			catch (callbackError) {
				Zotero.logError && Zotero.logError(callbackError);
			}
			return true;
		}

		function prepareDraftActivation(session) {
			if (disposed) return null;
			let descriptor = sessionDocument(session);
			if (!descriptor || descriptor.authority !== 'draft') {
				throw new Error('Workspace Draft activation requires a safe Draft session');
			}
			let ownPreparation = ++preparationGeneration;
			reloadGeneration += 1;
			let previous = {
				generation,
				document: activeDocument,
				session: activeSession,
				host: captureHostState(),
			};
			let state = 'pending';

			function apply() {
				if (state !== 'pending' || disposed
						|| ownPreparation !== preparationGeneration) return false;
				state = 'applying';
				try {
					generation = previous.generation + 1;
					activeDocument = descriptor;
					activeSession = session;
					setHostDocumentState(host, descriptor, session.snapshot());
					state = 'applied';
					return true;
				}
				catch (error) {
					generation = previous.generation;
					activeDocument = previous.document;
					activeSession = previous.session;
					restoreHostState(previous.host);
					state = 'pending';
					throw error;
				}
			}

			function commit() {
				if (state !== 'applied') return false;
				state = 'committed';
				if (previous.session && previous.session !== session) {
					safeDispose(previous.session);
				}
				return true;
			}

			function rollback() {
				if (state === 'committed' || state === 'rolled-back') return false;
				if (state === 'applied') {
					generation = previous.generation;
					activeDocument = previous.document;
					activeSession = previous.session;
					restoreHostState(previous.host);
				}
				state = 'rolled-back';
				if (session !== previous.session) safeDispose(session);
				return true;
			}

			return Object.freeze({ apply, commit, rollback });
		}

		async function prepareDocument(spec = {}, capability) {
			if (disposed) return null;
			let ownPreparation = ++preparationGeneration;
			reloadGeneration += 1;
			let descriptor = Zotero.QLab.createWorkspaceDocumentDescriptor({
				relativePath: spec.relativePath || spec.path,
			});
			let read;
			try {
				read = await readonlyIO.read(capability, descriptor);
			}
			catch (error) {
				if (disposed || ownPreparation !== preparationGeneration) return null;
				throw error;
			}
			if (disposed || ownPreparation !== preparationGeneration) return null;
			let session = Zotero.QLab.createQmdDocumentSession({
				verifiedRead: read,
				onState: snapshot => {
					if (disposed || activeSession !== session) return;
					setHostDocumentState(host, descriptor, snapshot);
				},
			});
			if (!Zotero.QLab.readonlyDocumentIOOwnsSession(readonlyIO, session)) {
				safeDispose(session);
				throw new Error('Verified read-only session identity does not match its workspace IO');
			}
			let settled = false;
			let committing = false;

			function rollback() {
				if (settled || activeSession === session) return false;
				settled = true;
				committing = false;
				safeDispose(session);
				return true;
			}

			function commit() {
				if (settled || disposed || ownPreparation !== preparationGeneration) return false;
				committing = true;
				let nextGeneration = generation + 1;
				let previousHostState = captureHostState();
				let activation = null;
				try {
					let activationResult = onActivate(Object.freeze({
						document: descriptor,
						session,
						read,
						generation: nextGeneration,
						isCurrent: () => !disposed && ownPreparation === preparationGeneration
							&& (committing || activeSession === session),
					}));
					requireSynchronousCallback(activationResult, 'activation', () => {
						if (ownPreparation === preparationGeneration) preparationGeneration += 1;
						committing = false;
					});
					activation = WORKSPACE_ACTIVATION_TRANSACTIONS.get(activationResult) || null;
					if (activation) {
						let activated = activation.commit();
						requireSynchronousCallback(activated, 'activation transaction', () => {
							if (ownPreparation === preparationGeneration) preparationGeneration += 1;
							committing = false;
						});
						if (activated !== true) {
							throw new Error('QMD workspace activation transaction refused');
						}
					}
					if (!activation || !activation.managesHostReset) {
						Zotero.QLab.resetQmdHostForReadonlyDocument(
							host, descriptor, session.snapshot(), { finalizeTurn: false }
						);
					}
				}
				catch (error) {
					committing = false;
					if (activation) {
						try { activation.rollback(); }
						catch (rollbackError) {
							Zotero.logError && Zotero.logError(rollbackError);
						}
					}
					restoreHostState(previousHostState);
					rollback();
					throw error;
				}
				let previous = activeSession;
				generation = nextGeneration;
				activeDocument = descriptor;
				activeSession = session;
				settled = true;
				committing = false;
				if (previous && previous !== session) safeDispose(previous);
				try {
					if (activation) activation.afterCommit();
					else Zotero.QLab.finalizeQmdHostReadonlyActivation(host);
				}
				catch (error) {
					Zotero.logError && Zotero.logError(error);
				}
				return true;
			}

			return Object.freeze({
				stage: Zotero.QLab.createWorkspaceDocumentRouteStage({ commit, rollback }),
				commit,
				rollback,
			});
		}

		return Object.freeze({
			prepareDraftActivation,
			async prepareWorkspaceDocument(spec = {}, capability) {
				let prepared = await prepareDocument(spec, capability);
				return prepared ? prepared.stage : false;
			},
			async openWorkspaceDocument(spec = {}, capability) {
				let prepared = await prepareDocument(spec, capability);
				if (!prepared) return false;
				try {
					let committed = prepared.commit();
					if (!committed) prepared.rollback();
					return committed;
				}
				catch (error) {
					prepared.rollback();
					throw error;
				}
			},
			activateDraft(session) {
				let activation = prepareDraftActivation(session);
				if (!activation || !activation.apply()) return false;
				if (activation.commit()) return true;
				activation.rollback();
				return false;
			},
			async reloadActive() {
				if (disposed || !activeDocument || !activeSession
						|| activeDocument.readOnly !== true) return false;
				let ownGeneration = generation;
				let ownReloadGeneration = ++reloadGeneration;
				let descriptor = activeDocument;
				let session = activeSession;
				let read;
				try {
					read = await readonlyIO.reload(descriptor);
				}
				catch (error) {
					if (disposed || ownGeneration !== generation
							|| ownReloadGeneration !== reloadGeneration
							|| activeDocument !== descriptor || activeSession !== session) return false;
					throw error;
				}
				if (disposed || ownGeneration !== generation
						|| ownReloadGeneration !== reloadGeneration
						|| activeDocument !== descriptor || activeSession !== session) return false;
				let changed = session.observeDisk(read);
				if (changed) {
					setHostDocumentState(host, descriptor, session.snapshot());
					try {
						requireSynchronousCallback(onReload(Object.freeze({
							document: descriptor,
							session,
							read,
							generation: ownGeneration,
							isCurrent: () => !disposed && ownGeneration === generation
								&& activeDocument === descriptor && activeSession === session,
						})), 'reload', () => {
							if (ownGeneration === generation) generation += 1;
						});
					}
					catch (error) {
					failClosedActive(session, error);
						throw error;
					}
				}
				return changed;
			},
			closeActiveReadonly(error = null) {
				if (disposed || !activeDocument || activeDocument.readOnly !== true
						|| !activeSession) return false;
				return failClosedActive(activeSession, error);
			},
			invalidate() {
				if (disposed) return false;
				preparationGeneration += 1;
				reloadGeneration += 1;
				generation += 1;
				return true;
			},
			invalidatePrepared() {
				if (disposed) return false;
				preparationGeneration += 1;
				reloadGeneration += 1;
				return true;
			},
			snapshot() {
				return Object.freeze({
					document: activeDocument,
					session: activeSession,
					generation,
					disposed,
				});
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				preparationGeneration += 1;
				generation += 1;
				if (activeSession && typeof activeSession.dispose === 'function') {
					activeSession.dispose();
				}
				activeSession = null;
				activeDocument = null;
			},
		});
	};

	Zotero.QLab.createQmdPreviewSurface = function (document, host, {
		onLoadError = () => {},
		interactionBridge = null,
	} = {}) {
		let quick = host && host.querySelector('[data-qlab-preview-quick]');
		let browserHost = host && host.querySelector('[data-qlab-preview-browser-host]');
		let empty = host && host.querySelector('[data-qlab-preview-empty]');
		let browser = null;
		let exactURL = '';
		let quickHTML = '';
		let disposed = false;
		let detachQuickInteraction = null;
		let detachWebsiteInteraction = null;

		if (document && typeof document.createXULElement === 'function' && browserHost) {
			browser = document.createXULElement('browser');
			browser.setAttribute('class', 'qlab-qmd-preview-browser');
			browser.setAttribute('type', 'content');
			browser.setAttribute('remote', 'true');
			browser.setAttribute('maychangeremoteness', 'true');
			browser.hidden = true;
			browserHost.appendChild(browser);
		}

		function showQuick(html = quickHTML) {
			if (disposed || !quick) return false;
			quickHTML = String(html || quickHTML || '');
			quick.removeAttribute('src');
			quick.srcdoc = quickHTML;
			quick.hidden = false;
			if (browser) browser.hidden = true;
			if (browserHost) browserHost.hidden = true;
			if (empty) empty.hidden = true;
			return true;
		}

		function onBrowserError() {
			let failedURL = exactURL;
			if (quickHTML) showQuick();
			else {
				if (browser) browser.hidden = true;
				if (browserHost) browserHost.hidden = true;
				if (empty) empty.hidden = false;
			}
			onLoadError(failedURL);
		}

		if (browser) browser.addEventListener('error', onBrowserError);
		if (interactionBridge) {
			detachQuickInteraction = interactionBridge.attachQuickPreview
				? interactionBridge.attachQuickPreview(quick)
				: null;
			detachWebsiteInteraction = browser && interactionBridge.attachWebsitePreview
				? interactionBridge.attachWebsitePreview(browser)
				: null;
		}

		return {
			showQuick,
			showExact(url, { reload = false } = {}) {
				if (disposed || !browser) return false;
				let value = String(url || '');
				if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/|$)/.test(value)) {
					throw new Error('QMD Preview accepts only a loopback Quarto URL');
				}
				exactURL = value;
				let current = browser.getAttribute('src') || '';
				if (current !== value) browser.setAttribute('src', value);
				else if (reload && typeof browser.reload === 'function') browser.reload();
				if (quick) quick.hidden = true;
				if (empty) empty.hidden = true;
				if (browserHost) browserHost.hidden = false;
				browser.hidden = false;
				return true;
			},
			showEmpty(message = 'Preview unavailable for this document.') {
				if (disposed) return;
				if (quick) quick.hidden = true;
				if (browser) browser.hidden = true;
				if (browserHost) browserHost.hidden = true;
				if (empty) {
					empty.textContent = message;
					empty.hidden = false;
				}
			},
			clear() {
				if (disposed) return false;
				exactURL = '';
				quickHTML = '';
				if (quick) {
					quick.removeAttribute('src');
					quick.srcdoc = '';
					quick.hidden = true;
				}
				if (browser) {
					browser.removeAttribute('src');
					browser.hidden = true;
				}
				if (browserHost) browserHost.hidden = true;
				if (empty) {
					empty.textContent = 'Preview unavailable for this document.';
					empty.hidden = false;
				}
				return true;
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				detachQuickInteraction && detachQuickInteraction();
				detachWebsiteInteraction && detachWebsiteInteraction();
				detachQuickInteraction = null;
				detachWebsiteInteraction = null;
				if (browser) {
					browser.removeEventListener('error', onBrowserError);
					browser.removeAttribute('src');
					browser.remove();
				}
			},
		};
	};

	Zotero.QLab.qmdWorkspaceAccessibilityModel = function ({
		proposal = false,
		previewStatus = 'ready',
		conflict = false,
		surface = 'visual',
	} = {}) {
		let surfaceAction = Zotero.QLab.qmdSurfaceActionModel(surface);
		let status = conflict
			? 'Draft conflict. Compare the on-disk and editor versions before saving.'
			: previewStatus === 'error'
				? 'Preview failed. The last successful render remains visible.'
				: proposal
					? 'AI changes are ready for review.'
					: 'Draft ready.';
		return {
			actions: {
				explorer: { label: 'Toggle QLab Explorer', l10nId: 'qlab-qmd-toggle-explorer' },
				reload: { label: 'Reload Draft', l10nId: 'qlab-qmd-reload' },
				save: { label: 'Save now', l10nId: 'qlab-qmd-save' },
				preview: { label: surfaceAction.label, l10nId: 'qlab-qmd-toggle-preview' },
				retry: { label: 'Retry Quarto Preview', l10nId: 'qlab-qmd-preview-retry' },
				ai: { label: 'Edit with AI', l10nId: 'qlab-qmd-edit-ai' },
				compare: { label: 'Compare AI changes', l10nId: 'qlab-qmd-compare' },
				keep: { label: 'Keep AI changes', l10nId: 'qlab-qmd-keep' },
				reject: { label: 'Reject AI changes', l10nId: 'qlab-qmd-reject' },
				compliance: { label: 'Check Draft compliance', l10nId: '' },
				promote: { label: 'Add to Knowledge…', l10nId: '' },
				todos: { label: 'Complete TODOs with AI', l10nId: '' },
				formal: { label: 'Insert Definition, Lemma, Theorem, or Proof', l10nId: '' },
				external: { label: 'Open Draft in external editor', l10nId: '' },
				refresh: { label: 'Refresh active QMD surface', l10nId: '' },
			},
			status,
		};
	};

	Zotero.QLab.qmdPreviewPresentation = function (state = {}) {
		let status = String(state.status || 'idle');
		let error = String(state.error || '');
		if (state.url) {
			if (status === 'error') {
				return {
					mode: 'exact',
					status: `Quarto Preview · showing last good result: ${error || 'render failed'}`,
					tone: 'error',
				};
			}
			return {
				mode: 'exact',
				status: status === 'rendering' ? 'Quarto Preview · updating…' : 'Quarto Preview',
				tone: status === 'rendering' ? 'rendering' : 'ready',
			};
		}
		if (state.fallback) {
			if (status === 'error') {
				return {
					mode: 'quick',
					status: `Quick Preview · Quarto unavailable: ${error || 'render failed'}`,
					tone: 'error',
				};
			}
			return {
				mode: 'quick',
				status: status === 'rendering'
					? 'Quick Preview · preparing Quarto…'
					: 'Quick Preview',
				tone: status === 'rendering' ? 'rendering' : 'ready',
			};
		}
		return { mode: 'empty', status: 'Preview unavailable', tone: 'idle' };
	};

	Zotero.QLab.qmdWorkspaceStatus = function ({
		persistence = 'saved',
		message = '',
		preview = {},
		surface = 'website',
	} = {}) {
		if (persistence === 'conflict') {
			return { text: message || 'Draft changed on disk', tone: 'conflict' };
		}
		if (persistence === 'error') {
			return { text: message || 'Unable to save Draft', tone: 'error' };
		}
		if (persistence === 'saving') return { text: 'Saving…', tone: 'saving' };
		if (persistence === 'dirty') return { text: 'Unsaved changes', tone: 'dirty' };
		if (persistence === 'proposal') {
			return { text: message || 'AI proposal ready for review', tone: 'proposal' };
		}
		if (Zotero.QLab.normalizeQmdSurfaceMode(surface) !== 'website') {
			return { text: message || 'Saved', tone: 'saved' };
		}
		if (!preview || !preview.status || ['idle', 'stale'].includes(preview.status)) {
			return { text: message || 'Saved', tone: 'saved' };
		}
		if (preview.status === 'rendering' && preview.url) {
			return { text: 'Saved · updating Quarto…', tone: 'rendering' };
		}
		let presentation = Zotero.QLab.qmdPreviewPresentation(preview);
		return { text: presentation.status, tone: presentation.tone };
	};

	Zotero.QLab.qmdCompliancePresentation = function (result = {}) {
		let diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
		if (result.ok) {
			return {
				state: 'passed',
				summary: 'Draft complies with the current Knowledge contract',
				details: 'No compliance issues found.',
			};
		}
		let count = diagnostics.length;
		return {
			state: 'failed',
			summary: `${count} compliance issue${count === 1 ? '' : 's'}`,
			details: diagnostics.length
				? diagnostics.map(item => (
					`L${Number(item.line) || 1} · ${String(item.code || 'CHECK')} · ${String(item.message || '')}`
				)).join('\n')
				: 'Draft compliance could not be determined.',
		};
	};

	function rootFromDrafts(drafts) {
		return [{
			path: 'drafts',
			name: 'drafts',
			kind: 'root',
			writable: true,
			children: (drafts || []).map(path => ({
				path,
				name: String(path).split('/').pop(),
				kind: 'qmd',
				writable: true,
				children: [],
			})),
		}];
	}

	function treeNodeHTML(node, depth = 0) {
		let children = Array.isArray(node.children) ? node.children : [];
		if (node.kind === 'root' || node.kind === 'directory') {
			let open = depth < 1 ? ' open' : '';
			return `<details class="qlab-qmd-explorer-group"${open}>`
				+ `<summary><span>${escapeHTML(node.name)}</span></summary>`
				+ `<div class="qlab-qmd-explorer-children">`
				+ children.map(child => treeNodeHTML(child, depth + 1)).join('')
				+ `</div></details>`;
		}
		let isDraft = !!node.writable && node.kind === 'qmd';
		let authorityAttribute = isDraft
			? `data-qlab-draft-row="${escapeHTML(node.path)}"`
			: `data-qlab-context-path="${escapeHTML(node.path)}"`;
		let readonly = isDraft ? '' : ' aria-readonly="true"';
		return `<button type="button" class="qlab-qmd-explorer-file is-${escapeHTML(node.kind)}" `
			+ `data-qlab-document-row="${escapeHTML(node.path)}" ${authorityAttribute}`
			+ `${readonly} title="${escapeHTML(node.path)}">`
			+ `<span class="qlab-qmd-file-icon" aria-hidden="true">${node.kind === 'qmd' ? 'Q' : node.kind === 'bib' ? '@' : '•'}</span>`
			+ `<span>${escapeHTML(node.name)}</span></button>`;
	}

	Zotero.QLab.renderQmdExplorerHTML = function (explorer = []) {
		let roots = explorer.length ? explorer : rootFromDrafts([]);
		return roots.map(root => treeNodeHTML(root)).join('');
	};

	Zotero.QLab.createQmdExplorerDocumentDelegate = function ({
		root,
		route,
		onResult = () => {},
		onError = () => {},
	} = {}) {
		if (!root || typeof route !== 'function') {
			throw new Error('QMD Explorer document routing requires a root and window router');
		}
		return async function routeExplorerDocument(event) {
			let row = event && event.target && event.target.closest
				? event.target.closest('[data-qlab-document-row]')
				: null;
			if (!row || row.disabled) return false;
			let relativePath = String(row.dataset && row.dataset.qlabDocumentRow || '');
			let document = Zotero.QLab.classifyWorkspaceDocument(relativePath);
			if (!document || document.path !== relativePath) return false;
			event.preventDefault && event.preventDefault();
			event.stopImmediatePropagation && event.stopImmediatePropagation();
			try {
				let result = await route(Object.freeze({
					root,
					relativePath: document.path,
					source: 'explorer',
					placement: 'current',
				}));
				onResult(result, document);
				return result;
			}
			catch (error) {
				onError(error, document);
				return false;
			}
		};
	};

	Zotero.QLab.renderQmdWorkspaceHTML = function ({
		path = '',
		document: requestedDocument = null,
		explorer = [],
		drafts = [],
		status = 'ready',
		proposal = false,
	} = {}) {
		let tree = explorer.length ? explorer : rootFromDrafts(drafts);
		let requestedPath = path || (requestedDocument && requestedDocument.relativePath) || '';
		let workspaceDocument = normalizedDocumentDescriptor(
			requestedPath || 'drafts/untitled.qmd'
		);
		let label = requestedPath || 'No Draft selected';
		let readOnly = workspaceDocument.readOnly === true;
		let capabilities = workspaceDocument.capabilities;
		let allowedSurfaces = Array.from(workspaceDocument.surfaces);
		let initialSurface = allowedSurfaces.includes('visual') ? 'visual' : 'source';
		let isBibTeX = workspaceDocument.format === 'bibtex';
		let accessibility = Zotero.QLab.qmdWorkspaceAccessibilityModel({ proposal, surface: initialSurface });
		let actions = accessibility.actions;
		let options = drafts.map(draft => (
			`<option value="${escapeHTML(draft)}">${escapeHTML(draft)}</option>`
		)).join('');
		let mutationActions = capabilities.edit ? [
			iconButton('promote', actions.promote.label,
				'data-qlab-add-to-knowledge data-qlab-qmd-action="add-to-knowledge"'),
			iconButton('todos', actions.todos.label,
				'data-qlab-complete-todos data-qlab-qmd-action="complete-todos"'),
			iconButton('save', actions.save.label, 'data-qlab-draft-save', {
				l10nId: actions.save.l10nId,
			}),
			iconButton('ai', actions.ai.label, 'data-qlab-draft-ai', {
				l10nId: actions.ai.l10nId,
			}),
			iconButton('diff', actions.compare.label,
				'data-qlab-proposal-compare data-qlab-qmd-action="compare-proposal"', {
					disabled: !proposal,
					l10nId: actions.compare.l10nId,
				}),
			iconButton('keep', actions.keep.label,
				'data-qlab-draft-keep data-qlab-qmd-action="keep-proposal"', {
					disabled: !proposal,
					l10nId: actions.keep.l10nId,
				}),
			iconButton('reject', actions.reject.label, 'data-qlab-draft-reject', {
				disabled: !proposal,
				l10nId: actions.reject.l10nId,
			}),
			`<div class="qlab-qmd-visual-tools" data-qlab-visual-tools>`,
			iconButton('formal', actions.formal.label,
				'data-qlab-formal-toggle data-qlab-qmd-action="insert-formal-block" '
				+ 'aria-expanded="false" aria-controls="qlab-qmd-formal-tools"'),
			`<div class="qlab-qmd-formal-menu" id="qlab-qmd-formal-tools" `
			+ `data-qlab-formal-menu hidden role="group" aria-label="Formal QMD block">`,
			`<button type="button" data-qlab-formal-kind="def">Definition</button>`,
			`<button type="button" data-qlab-formal-kind="lem">Lemma</button>`,
			`<button type="button" data-qlab-formal-kind="thm">Theorem</button>`,
			`<button type="button" data-qlab-formal-kind="proof">Proof</button>`,
			`</div></div>`,
			iconButton('cursor', actions.external.label,
				'data-qlab-external-editor data-qlab-qmd-action="open-external-editor"'),
		].join('') : '';
		let inlineBar = capabilities.aiWrite
			? `<div class="qlab-qmd-inline" data-qlab-inline hidden>`
				+ `<input type="text" data-qlab-inline-prompt placeholder="Describe a focused QMD edit…"/>`
				+ `<button type="button" data-qlab-inline-run>Write</button>`
				+ `<button type="button" data-qlab-inline-stop hidden>Stop</button>`
				+ `<button type="button" data-qlab-inline-cancel>Cancel</button></div>`
			: '';
		let previewPane = allowedSurfaces.includes('website') ? [
			`<section class="qlab-qmd-preview-pane" data-qlab-qmd-preview data-qlab-preview-surface `
			+ `data-qlab-surface="website" aria-label="Quarto Preview" hidden>`,
			`<div class="qlab-qmd-pane-title"><span data-l10n-id="qlab-qmd-preview">QUARTO PREVIEW</span>`,
			`<div class="qlab-qmd-preview-versions" role="group" aria-label="Preview version"${proposal ? '' : ' hidden'}>`,
			`<button type="button" class="is-active" data-qlab-preview-version="original">Original</button>`,
			`<button type="button" data-qlab-preview-version="proposed"${proposal ? '' : ' disabled'}>Proposed</button>`,
			`</div>`,
			iconButton('reload', actions.retry.label, 'data-qlab-preview-retry', {
				l10nId: actions.retry.l10nId,
			}),
			`</div>`,
			`<div class="qlab-qmd-preview-stage" data-qlab-preview-stage>`,
			`<iframe class="qlab-qmd-preview-quick" data-qlab-preview-quick title="Quick QMD Preview" `
			+ `sandbox="allow-same-origin"></iframe>`,
			`<div class="qlab-qmd-preview-browser-host" data-qlab-preview-browser-host hidden></div>`,
			`<div class="qlab-qmd-preview-empty" data-qlab-preview-empty>Preview unavailable for this document.</div>`,
			`</div></section>`,
		].join('') : '';
		return [
			`<div class="qlab-shell qlab-shell-qmd qlab-qmd-workspace" data-qlab-kind="qlabqmd" `
			+ `data-status="${escapeHTML(status)}" data-qlab-document-readonly="${readOnly ? 'true' : 'false'}" `
			+ `data-qlab-document-authority="${escapeHTML(workspaceDocument.authority)}" `
			+ `data-qlab-document-format="${escapeHTML(workspaceDocument.format)}">`,
			`<header class="qlab-qmd-toolbar">`,
			iconButton('folder', actions.explorer.label, 'data-qlab-files-toggle', {
				l10nId: actions.explorer.l10nId,
			}),
			allowedSurfaces.length > 1 ? iconButton('preview', actions.preview.label,
				`data-qlab-preview-toggle data-qlab-current-surface="${initialSurface}"`, {
					l10nId: actions.preview.l10nId,
				}) : '',
			`<div class="qlab-qmd-path-wrap" title="${escapeHTML(workspaceDocument.tooltip)}">`
			+ `<span class="qlab-qmd-tree-badge" data-qlab-authority-badge>${escapeHTML(workspaceDocument.badge)}</span>`,
			`<strong class="qlab-qmd-path" data-qlab-draft-path>${escapeHTML(label)}</strong></div>`,
			`<div class="qlab-qmd-toolbar-actions" role="toolbar" aria-label="QMD actions">`,
			capabilities.edit && !isBibTeX ? iconButton('compliance', actions.compliance.label,
				'data-qlab-compliance data-qlab-qmd-action="check-compliance"') : '',
			mutationActions,
			iconButton('search', 'Citekey search', `data-qlab-bib-search${isBibTeX ? '' : ' hidden'}`),
			iconButton('reload', actions.refresh.label,
				'data-qlab-refresh-surface data-qlab-qmd-action="refresh-surface"'),
			`</div></header>`,
			capabilities.edit
				? `<output class="qlab-qmd-compliance-details" data-qlab-compliance-details hidden `
					+ `aria-live="polite"></output>`
				: '',
			inlineBar,
			`<div class="qlab-qmd-workspace-main">`,
			`<aside class="qlab-qmd-explorer" data-qlab-file-column aria-label="QLab Explorer">`,
			`<div class="qlab-qmd-pane-title"><span data-l10n-id="qlab-qmd-explorer">QLAB EXPLORER</span></div>`,
			`<div class="qlab-qmd-explorer-tree" data-qlab-qmd-explorer>${Zotero.QLab.renderQmdExplorerHTML(tree)}</div>`,
			`<label class="qlab-qmd-select-fallback">Draft<select data-qlab-draft>`
			+ `<option value="">Select…</option>${options}</select></label></aside>`,
			`<main class="qlab-qmd-primary-surface" data-qlab-primary-surface data-surface="${initialSurface}">`,
			allowedSurfaces.includes('visual')
				? `<section class="qlab-qmd-visual-pane${initialSurface === 'visual' ? ' is-active' : ''}" `
					+ `data-qlab-visual-surface data-qlab-surface="visual" `
					+ `aria-label="Visual QMD ${readOnly ? 'view' : 'editor'}"${initialSurface === 'visual' ? '' : ' hidden'}>`
					+ `<div class="qlab-qmd-pane-title"><span>${readOnly ? 'VISUAL VIEW' : 'VISUAL EDIT'}</span></div>`
					+ `<div class="qlab-qmd-visual-editor" data-qlab-visual-editor-root `
					+ `aria-label="Visual QMD ${readOnly ? 'view' : 'editor'}"></div></section>`
				: '',
			`<section class="qlab-qmd-editor-pane" data-qlab-source-surface data-qlab-surface="source" `
			+ `aria-label="Monaco ${isBibTeX ? 'BibTeX' : 'QMD'} source ${readOnly ? 'viewer' : 'editor'}"`
			+ `${initialSurface === 'source' ? '' : ' hidden'}>`,
			`<div class="qlab-qmd-pane-title qlab-qmd-editor-tab"><span class="qlab-qmd-tab-q">${isBibTeX ? '@' : 'Q'}</span>`
			+ `<span data-qlab-editor-tab>${escapeHTML(label)}</span><i data-qlab-dirty-dot hidden></i></div>`,
			`<iframe class="qlab-qmd-monaco-frame" data-qlab-qmd-monaco `
			+ `src="chrome://zotero/content/qlab/qmdMonaco.html" title="${isBibTeX
				? 'BibTeX source viewer'
				: readOnly ? 'QMD source viewer' : 'QMD source editor'}"></iframe>`,
			`<textarea data-qlab-editor hidden aria-hidden="true"></textarea></section>`,
			previewPane,
			`</main></div>`,
			`<footer class="qlab-qmd-workspace-status">`,
			`<span class="qlab-shell-status" data-qlab-qmd-status role="status" aria-live="polite">${escapeHTML(status)}</span>`,
			`<span class="qlab-qmd-authority">${escapeHTML(readOnly
				? workspaceDocument.tooltip
				: 'Human edits autosave · AI changes require Keep')}</span>`,
			`</footer>`,
			`</div>`,
		].join('');
	};

	Zotero.QLab.createQmdWorkspaceController = function ({
		watcher = null,
		monaco = null,
		visual = null,
		preview = null,
		session = null,
		ownsSession = true,
		onLayout = () => {},
		explorerVisible = true,
		surface = null,
		previewVisible = null,
		versionTarget = 'original',
	} = {}) {
		let restoredSurface = surface;
		if (!restoredSurface && previewVisible !== null) {
			restoredSurface = previewVisible ? 'website' : 'source';
		}
		let resources = { watcher, monaco, visual, preview, session };
		let quiesced = false;
		let state = {
			explorerVisible: !!explorerVisible,
			surface: Zotero.QLab.normalizeQmdSurfaceMode(restoredSurface),
			versionTarget: versionTarget === 'proposed' ? 'proposed' : 'original',
			disposed: false,
		};
		function canMutate() {
			return !state.disposed && !quiesced;
		}
		function layout() {
			if (!canMutate()) return false;
			onLayout({ ...state });
			return true;
		}
		function disposeResourceValue(name, value) {
			if ((name === 'session' && !ownsSession) || !value
					|| typeof value.dispose !== 'function') return;
			try { value.dispose(); }
			catch (error) { Zotero.logError && Zotero.logError(error); }
		}
		function disposeResource(name) {
			disposeResourceValue(name, resources[name]);
			resources[name] = null;
		}
		return {
			setResources(next = {}) {
				if (!canMutate()) return false;
				for (let name of ['visual', 'preview', 'session']) {
					if (Object.prototype.hasOwnProperty.call(next, name) && resources[name] !== next[name]) {
						if (name !== 'session' || ownsSession) disposeResource(name);
						resources[name] = next[name];
					}
				}
				return true;
			},
			beginResourceTransaction(next = {}) {
				if (!canMutate()) return null;
				let names = ['visual', 'preview', 'session'].filter(name => (
					Object.prototype.hasOwnProperty.call(next, name)
					&& resources[name] !== next[name]
				));
				let previous = Object.fromEntries(names.map(name => [name, resources[name]]));
				let applied = false;
				let settled = false;
				return Object.freeze({
					apply() {
						if (settled || !canMutate()) return false;
						for (let name of names) resources[name] = next[name];
						applied = true;
						return true;
					},
					commit() {
						if (settled || !applied) return false;
						settled = true;
						for (let name of names) disposeResourceValue(name, previous[name]);
						return true;
					},
					rollback() {
						if (settled) return false;
						if (applied) {
							for (let name of names) resources[name] = previous[name];
						}
						settled = true;
						for (let name of names) disposeResourceValue(name, next[name]);
						return true;
					},
				});
			},
			restoreState(snapshot = {}) {
				if (!canMutate()) return false;
				state.explorerVisible = snapshot.explorerVisible !== false;
				state.surface = Zotero.QLab.normalizeQmdSurfaceMode(snapshot.surface);
				state.versionTarget = snapshot.versionTarget === 'proposed'
					? 'proposed'
					: 'original';
				return layout();
			},
			quiesce() {
				if (quiesced) return;
				quiesced = true;
				for (let name of ['watcher', 'monaco', 'preview']) disposeResource(name);
			},
			toggleExplorer(value = !state.explorerVisible) {
				if (!canMutate()) return false;
				state.explorerVisible = !!value;
				return layout();
			},
			showSurface(value) {
				if (!canMutate()) return false;
				state.surface = Zotero.QLab.normalizeQmdSurfaceMode(value);
				return layout();
			},
			showVersionTarget(value) {
				if (!canMutate()) return false;
				state.versionTarget = value === 'proposed' ? 'proposed' : 'original';
				return layout();
			},
			toggleSurface() {
				if (!canMutate()) return false;
				state.surface = Zotero.QLab.nextQmdSurfaceMode(state.surface);
				return layout();
			},
			snapshot() {
				return { ...state };
			},
			dispose() {
				if (state.disposed) return;
				state.disposed = true;
				for (let name of ['watcher', 'monaco', 'visual', 'preview']) disposeResource(name);
				if (ownsSession) disposeResource('session');
			},
		};
	};

	Zotero.QLab.createQmdVisualSessionBridge = function (visual, {
		onSaved = () => {},
	} = {}) {
		if (!visual || typeof visual.setDocument !== 'function') {
			throw new Error('QMD Visual session bridge requires a Visual Editor');
		}
		let session = null;
		let generation = 0;

		function currentDocument() {
			if (!session) return { source: '', revision: '', document: null };
			let snapshot = session.snapshot();
			return {
				source: String(snapshot && snapshot.text || ''),
				revision: String(snapshot && snapshot.revision || ''),
				document: sessionDocument(session),
			};
		}

		return {
			setSession(nextSession) {
				session = nextSession || null;
				generation += 1;
				let current = currentDocument();
				visual.setDocument(current, current.document, generation);
				return generation;
			},
			sync({ force = false } = {}) {
				if (!session || (!force && visual.isEditing && visual.isEditing())) return false;
				let current = currentDocument();
				visual.setDocument(current, current.document, generation);
				return true;
			},
			async save(nextSource, expectedRevision, saveGeneration) {
				if (!session || saveGeneration !== generation) {
					throw new Error('The Visual Edit document changed before save');
				}
				let saveSession = session;
				if (!Zotero.QLab.qmdSessionAllows(saveSession, 'edit')
						|| !Zotero.QLab.qmdSessionAllows(saveSession, 'save')) {
					throw new Error('The Visual document is read-only');
				}
				let snapshot = saveSession.snapshot();
				if (String(snapshot.revision || '') !== String(expectedRevision || '')) {
					throw new Error('The Draft revision changed before Visual Edit could save');
				}
				let visualSnapshot = visual.snapshot ? visual.snapshot() : null;
				if (visualSnapshot
						&& String(snapshot.text || '') !== String(visualSnapshot.source || '')) {
					throw new Error('The Draft changed since Visual Edit loaded it');
				}
				saveSession.applyHumanEdit(String(nextSource ?? ''));
				if (saveGeneration !== generation || saveSession !== session
						|| !Zotero.QLab.qmdSessionAllows(saveSession, 'save')) {
					throw new Error('The Visual Edit document changed before save');
				}
				let saved = await saveSession.saveNow();
				if (saveGeneration !== generation || saveSession !== session) {
					throw new Error('The Visual Edit document changed while saving');
				}
				let result = {
					source: String(saved && saved.text || ''),
					revision: String(saved && saved.revision || ''),
				};
				onSaved(result);
				return result;
			},
			generation() {
				return generation;
			},
		};
	};

	Zotero.QLab.transitionQmdWorkspaceSurface = async function (controller, visual, value) {
		let state = controller.snapshot();
		if (state.disposed) return false;
		let target = value === undefined
			? Zotero.QLab.nextQmdSurfaceMode(state.surface)
			: Zotero.QLab.normalizeQmdSurfaceMode(value);
		if (state.surface === 'visual' && target !== 'visual'
				&& visual && typeof visual.finishActiveEdit === 'function') {
			await visual.finishActiveEdit();
			if (typeof visual.isEditing === 'function' && visual.isEditing()) {
				return false;
			}
		}
		if (controller.snapshot().disposed) return false;
		return controller.showSurface(target) !== false;
	};

	Zotero.QLab.flushQmdDraftBeforeTransition = async function (session, visual) {
		if (visual && typeof visual.finishActiveEdit === 'function') {
			await visual.finishActiveEdit();
			if (typeof visual.isEditing === 'function' && visual.isEditing()) return false;
		}
		if (!session) return true;
		if (!Zotero.QLab.qmdSessionAllows(session, 'save')) return true;
		await session.saveNow();
		let snapshot = session.snapshot();
		return !snapshot.dirty && !snapshot.saveError;
	};

	Zotero.QLab.createQmdLatestRequestGate = function () {
		let generation = 0;
		let disposed = false;
		return {
			begin() {
				let ownGeneration = ++generation;
				return {
					generation: ownGeneration,
					isCurrent: () => !disposed && ownGeneration === generation,
				};
			},
			dispose() {
				disposed = true;
				generation += 1;
			},
		};
	};

	Zotero.QLab.qmdTodoActionAvailability = function () {
		return { allowed: true, reason: '' };
	};

	Zotero.QLab.qmdProposalBelongsToDraft = function (state, activePath) {
		return !!state
			&& typeof state.originalPath === 'string'
			&& state.originalPath === String(activePath || '')
			&& typeof state.workingPath === 'string'
			&& state.workingPath.length > 0;
	};

	Zotero.QLab.qmdProposalActionStillCurrent = function (captured, current) {
		return !!captured
			&& !!current
			&& captured.proposal === current.proposal
			&& Number(captured.generation) === Number(current.generation)
			&& String(captured.path || '') === String(current.path || '')
			&& Zotero.QLab.qmdProposalBelongsToDraft(
				captured.proposal && captured.proposal.state,
				captured.path
			);
	};

	Zotero.QLab.qmdComplianceSnapshotMatches = function (checked, current) {
		if (!checked || !current) return false;
		return String(checked.path || '') === String(current.path || '')
			&& Number(checked.generation) === Number(current.generation)
			&& String(checked.revision || '') === String(current.revision || '')
			&& String(checked.text || '') === String(current.text || '');
	};

	Zotero.QLab.qmdComplianceResultMatches = function (cached, current) {
		return !!cached
			&& Zotero.QLab.qmdComplianceSnapshotMatches(cached.checked, current);
	};

	Zotero.QLab.bindDisposableQmdWorkspaceEvent = function (target, type, listener) {
		if (!target || typeof target.addEventListener !== 'function'
				|| typeof target.removeEventListener !== 'function') {
			throw new Error('QMD workspace event binding requires an EventTarget');
		}
		target.addEventListener(type, listener);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			target.removeEventListener(type, listener);
		};
	};

	Zotero.QLab.applyQmdDocumentChrome = function (host, descriptor, { proposal = false } = {}) {
		if (!host || !descriptor || !descriptor.relativePath) return false;
		let normalized;
		try {
			normalized = descriptor.authority === 'draft'
				? Zotero.QLab.createQmdDraftDocumentDescriptor({
					relativePath: descriptor.relativePath,
				})
				: Zotero.QLab.createWorkspaceDocumentDescriptor({
					relativePath: descriptor.relativePath,
				});
		}
		catch (error) { return false; }
		let capabilities = normalized.capabilities;
		let shell = host.querySelector('.qlab-qmd-workspace');
		if (shell) {
			shell.dataset.qlabDocumentReadonly = normalized.readOnly ? 'true' : 'false';
			shell.dataset.qlabDocumentAuthority = normalized.authority;
			shell.dataset.qlabDocumentFormat = normalized.format;
		}
		let badge = host.querySelector('[data-qlab-authority-badge]');
		if (badge) badge.textContent = normalized.badge;
		let pathWrap = host.querySelector('.qlab-qmd-path-wrap');
		if (pathWrap) pathWrap.title = normalized.tooltip;
		let authority = host.querySelector('.qlab-qmd-authority');
		if (authority) {
			authority.textContent = normalized.readOnly
				? normalized.tooltip
				: 'Human edits autosave · AI changes require Keep';
		}
		let guardedControls = [
			['[data-qlab-compliance]', 'edit'],
			['[data-qlab-draft-save]', 'save'],
			['[data-qlab-draft-ai]', 'aiWrite'],
			['[data-qlab-proposal-compare]', 'proposal'],
			['[data-qlab-draft-keep]', 'keepReject'],
			['[data-qlab-draft-reject]', 'keepReject'],
			['[data-qlab-add-to-knowledge]', 'promote'],
			['[data-qlab-complete-todos]', 'completeTodos'],
			['[data-qlab-formal-toggle]', 'insertFormalBlock'],
			['[data-qlab-external-editor]', 'externalEditor'],
		];
		for (let [selector, capability] of guardedControls) {
			for (let control of host.querySelectorAll(selector)) {
				let allowed = capabilities[capability] === true;
				let requiresProposal = selector === '[data-qlab-proposal-compare]'
					|| selector === '[data-qlab-draft-keep]'
					|| selector === '[data-qlab-draft-reject]';
				control.hidden = !allowed;
				if ('disabled' in control) {
					control.disabled = !allowed || (requiresProposal && !proposal);
				}
			}
		}
		// The inline AI bar is stateful: readonly closes it, while returning to
		// Draft must not open it without an explicit user action.
		let inline = host.querySelector('[data-qlab-inline]');
		if (inline && capabilities.aiWrite !== true) inline.hidden = true;
		let search = host.querySelector('[data-qlab-bib-search]');
		if (search) search.hidden = normalized.format !== 'bibtex';
		let toggle = host.querySelector('[data-qlab-preview-toggle]');
		if (toggle) toggle.hidden = normalized.surfaces.length < 2;
		let visual = host.querySelector('[data-qlab-visual-surface]');
		if (visual) {
			if (!normalized.surfaces.includes('visual')) visual.hidden = true;
			visual.setAttribute('aria-label', `Visual QMD ${normalized.readOnly ? 'view' : 'editor'}`);
			let title = visual.querySelector && visual.querySelector('.qlab-qmd-pane-title span');
			if (title) title.textContent = normalized.readOnly ? 'VISUAL VIEW' : 'VISUAL EDIT';
		}
		let visualRoot = host.querySelector('[data-qlab-visual-editor-root]');
		if (visualRoot) {
			visualRoot.setAttribute('aria-label', `Visual QMD ${normalized.readOnly ? 'view' : 'editor'}`);
			visualRoot.setAttribute('aria-readonly', normalized.readOnly ? 'true' : 'false');
		}
		let visualTools = host.querySelector('[data-qlab-visual-tools]');
		if (visualTools) {
			visualTools.hidden = capabilities.insertFormalBlock !== true
				|| host._qlabSurfaceMode !== 'visual';
		}
		let preview = host.querySelector('[data-qlab-preview-surface]');
		if (preview && !normalized.surfaces.includes('website')) preview.hidden = true;
		let sourceMarker = host.querySelector('.qlab-qmd-tab-q');
		if (sourceMarker) sourceMarker.textContent = normalized.format === 'bibtex' ? '@' : 'Q';
		let sourcePane = host.querySelector('[data-qlab-source-surface]');
		if (sourcePane) {
			sourcePane.setAttribute(
				'aria-label',
				`Monaco ${normalized.format === 'bibtex' ? 'BibTeX' : 'QMD'} source ${normalized.readOnly ? 'viewer' : 'editor'}`
			);
		}
		let sourceFrame = host.querySelector('[data-qlab-qmd-monaco]');
		if (sourceFrame) {
			sourceFrame.title = normalized.format === 'bibtex'
				? 'BibTeX source viewer'
				: normalized.readOnly ? 'QMD source viewer' : 'QMD source editor';
		}
		return true;
	};

	Zotero.QLab.handleQmdMonacoWorkspaceCommand = async function ({
		host,
		view,
		session,
		command,
		event = {},
		onSave = () => {},
		onInlineWrite = () => {},
	} = {}) {
		if (command === 'save') {
			if (!Zotero.QLab.qmdSessionAllows(session, 'save')) return null;
			onSave();
			return 'save';
		}
		if (command !== 'ai' && command !== 'chat-selection') return null;
		let capability = command === 'chat-selection' ? 'chatSelection' : 'aiWrite';
		if (!Zotero.QLab.qmdSessionAllows(session, capability)) return null;
		let selection = {
			start: Number(event.start) || 0,
			end: Number(event.end) || 0,
			text: String(event.selection || ''),
		};
		host._qlabMonacoSelection = selection;
		if (command === 'chat-selection' && selection.text && selection.end > selection.start) {
			return Zotero.QLab.addCurrentContextToChat(view, {
				preference: 'selection',
				focus: true,
				qmdHost: host,
			});
		}
		onInlineWrite();
		return 'ai';
	};

	function joinRoot(root, relativePath) {
		return `${String(root || '').replace(/[\\/]+$/, '')}/${String(relativePath || '').replace(/^[\\/]+/, '')}`;
	}

	function diagnosticOffsets(text, diagnostics) {
		let starts = [0];
		for (let i = 0; i < text.length; i++) {
			if (text[i] === '\n') starts.push(i + 1);
		}
		return (diagnostics || []).map(item => {
			let line = Math.max(1, Number(item.line) || 1);
			let column = Math.max(1, Number(item.column) || 1);
			let start = (starts[line - 1] || 0) + column - 1;
			return { ...item, start, end: start + 1 };
		});
	}

	Zotero.QLab.mountQmdWorkspace = async function (host, {
		root,
		initialPath = '',
		layout = {},
		readonlyIO = null,
		readonlyDocumentIO = null,
		isCurrent = () => true,
	} = {}) {
		if (!host || !root || !isCurrent()) return null;
		if (host._qlabQmdWorkspace) return host._qlabQmdWorkspace;
		let document = host.ownerDocument;
		let view = document.defaultView;
		let verifiedReadonlyIO = readonlyDocumentIO || readonlyIO;
		let outsideInteractionBridge = view && view.Zotero_Tabs
			&& view.Zotero_Tabs._qlab
			&& view.Zotero_Tabs._qlab.chatOutsideInteraction;
		let ioHost = Zotero.QLab.QmdDraftIO.createGeckoHost();
		let explorerHost = Zotero.QLab.createGeckoQmdExplorerHost();
		let frame = host.querySelector('[data-qlab-qmd-monaco]');
		let visualHost = host.querySelector('[data-qlab-visual-editor-root]');
		let previewSurface = Zotero.QLab.createQmdPreviewSurface(document, host, {
			interactionBridge: outsideInteractionBridge,
			onLoadError(url) {
				setStatus(`Preview error · unable to load ${url}`, 'error');
			},
		});
		let activeSession = null;
		let activePreview = null;
		let activePath = '';
		let proposal = null;
		let bibliographyText = '';
		let previewVersion = 'original';
		let persistence = 'saved';
		let persistenceMessage = 'Saved';
		let latestPreviewState = null;
		let activeDocumentGeneration = 0;
		let documentManager = null;
		let openGate = Zotero.QLab.createQmdLatestRequestGate();
		const preparedDraftRoutes = new WeakMap();
		const pendingPreparedDraftRoutes = new Set();
		let surfaceTransition = Promise.resolve(true);
		let disposing = false;
		let complianceTimer = null;
		let complianceResult = null;
		let externalEditorsPromise = null;
		let visualBridge = null;
		let monacoBridge = null;
		let visualEditor = Zotero.QLab.createQmdVisualEditor(document, {
			save: (source, expectedRevision, generation) => (
				visualBridge.save(source, expectedRevision, generation)
			),
			onStatus(message, state, generation) {
				if (!visualBridge || generation !== visualBridge.generation()) return;
				setPersistenceStatus(
					state === 'editing' ? 'dirty' : state,
					message
				);
			},
		});
		visualBridge = Zotero.QLab.createQmdVisualSessionBridge(visualEditor, {
			onSaved() {
				monacoBridge?.showNormal();
			},
		});
		if (visualHost) visualHost.replaceChildren(visualEditor.root);

		if (!isCurrent()) {
			previewSurface.dispose();
			visualEditor.dispose?.();
			return null;
		}

		let sessionProxy = {
			applyHumanEdit(text) {
				return Zotero.QLab.runQmdWorkspaceCapability(
					activeSession,
					'edit',
					() => activeSession.applyHumanEdit(text),
					false
				);
			},
			snapshot() {
				return activeSession
					? activeSession.snapshot()
					: { path: 'drafts/untitled.qmd', text: '', revision: '' };
			},
		};
		let monacoAdapter = Zotero.QLab.createQmdMonacoFrameAdapter(frame);
		let detachMonacoInteraction = outsideInteractionBridge
			&& outsideInteractionBridge.attachMonaco
			? outsideInteractionBridge.attachMonaco(monacoAdapter)
			: null;
		monacoBridge = Zotero.QLab.createQmdMonacoBridge({
			adapter: monacoAdapter,
			session: sessionProxy,
			language: text => Zotero.QLab.qmdLanguageSnapshot(text, bibliographyText),
			bibliographyText,
			onCommand(command, event) {
				void Zotero.QLab.handleQmdMonacoWorkspaceCommand({
					host,
					view,
					session: activeSession,
					command,
					event,
					onSave: () => workspace.saveNow(),
					onInlineWrite: () => Zotero.QLab.toggleQmdInlineBar(host, true),
				}).catch(error => Zotero.logError && Zotero.logError(error));
			},
			onCursor(event) {
				let offset = Number(event.offset) || 0;
				host._qlabMonacoSelection = { start: offset, end: offset, text: '' };
			},
		});

		function setStatus(text, state = '') {
			let element = host.querySelector('[data-qlab-qmd-status]');
			if (element) element.textContent = text;
			let shell = host.querySelector('.qlab-qmd-workspace');
			if (shell) shell.dataset.status = state;
		}

		function setPersistenceStatus(state, message = '') {
			persistence = state;
			persistenceMessage = message;
			let combined = Zotero.QLab.qmdWorkspaceStatus({
				persistence,
				message: persistenceMessage,
				preview: latestPreviewState || {},
				surface: controller ? controller.snapshot().surface : 'visual',
			});
			setStatus(combined.text, combined.tone);
		}

		function renderCompliance(result, { showDetails = false, checked = null } = {}) {
			let presentation = Zotero.QLab.qmdCompliancePresentation(result);
			if (checked) complianceResult = { checked, result, presentation };
			let button = host.querySelector('[data-qlab-compliance]');
			if (button) {
				button.dataset.compliance = presentation.state;
				button.title = `Check Draft compliance · ${presentation.summary}`;
			}
			let details = host.querySelector('[data-qlab-compliance-details]');
			if (details) {
				details.textContent = `${presentation.summary}\n${presentation.details}`;
				if (showDetails) details.hidden = false;
			}
			if (result.diagnostics && activeSession) {
				monacoBridge.setDiagnostics(diagnosticOffsets(
					activeSession.snapshot().text,
					result.diagnostics
				));
			}
			return presentation;
		}

		async function checkCompliance({ showDetails = false } = {}) {
			if (!Zotero.QLab.qmdSessionAllows(activeSession, 'edit')
					|| !activePath || typeof Zotero.QLab.runQmdCompliance !== 'function') return null;
			let sessionSnapshot = activeSession ? activeSession.snapshot() : {};
			let checked = {
				path: activePath,
				generation: activeDocumentGeneration,
				revision: String(sessionSnapshot.revision || ''),
				text: String(sessionSnapshot.text || ''),
			};
			let button = host.querySelector('[data-qlab-compliance]');
			if (button) button.disabled = true;
			try {
				let result = await Zotero.QLab.runQmdCompliance(root, checked.path, {
					source: checked.text,
				});
				let currentSession = activeSession ? activeSession.snapshot() : {};
				let current = {
					path: activePath,
					generation: activeDocumentGeneration,
					revision: String(currentSession.revision || ''),
					text: String(currentSession.text || ''),
				};
				if (!Zotero.QLab.qmdComplianceSnapshotMatches(checked, current)) return null;
				let presentation = renderCompliance(result, { showDetails, checked });
				if (showDetails) setStatus(presentation.summary, presentation.state === 'passed' ? 'saved' : 'error');
				return result;
			}
			finally {
				if (button && checked.generation === activeDocumentGeneration
						&& checked.path === activePath) button.disabled = false;
			}
		}

		function scheduleCompliance(delay = 700) {
			if (complianceTimer !== null) view.clearTimeout(complianceTimer);
			complianceTimer = view.setTimeout(() => {
				complianceTimer = null;
				void checkCompliance();
			}, delay);
		}

		function markComplianceStale() {
			complianceResult = null;
			let button = host.querySelector('[data-qlab-compliance]');
			if (button) {
				button.dataset.compliance = 'stale';
				button.title = 'Check Draft compliance · Draft changed since last check';
			}
			let details = host.querySelector('[data-qlab-compliance-details]');
			if (details) details.hidden = true;
		}

		function updateProposalControls() {
			let hasProposal = !!proposal;
			for (let control of host.querySelectorAll(
				'[data-qlab-proposal-compare], [data-qlab-draft-keep], [data-qlab-draft-reject], [data-qlab-preview-version="proposed"]'
			)) {
				control.disabled = !hasProposal;
			}
			let shell = host.querySelector('.qlab-qmd-workspace');
			if (shell) shell.classList.toggle('is-working-copy', hasProposal);
			let versions = host.querySelector('.qlab-qmd-preview-versions');
			if (versions) versions.hidden = !hasProposal;
		}

		function applyLayout(state) {
			let shell = host.querySelector('.qlab-qmd-workspace');
			if (!shell) return;
			shell.classList.toggle('is-files-collapsed', !state.explorerVisible);
			shell.dataset.surface = state.surface;
			shell.dataset.versionTarget = state.versionTarget;
			host._qlabSurfaceMode = state.surface;
			previewVersion = state.versionTarget;
			let primary = host.querySelector('[data-qlab-primary-surface]');
			if (primary) primary.dataset.surface = state.surface;
			let visual = host.querySelector('[data-qlab-visual-surface]');
			let source = host.querySelector('[data-qlab-source-surface]');
			let preview = host.querySelector('[data-qlab-preview-surface]');
			if (visual) visual.hidden = state.surface !== 'visual';
			if (source) source.hidden = state.surface !== 'source';
			if (preview) preview.hidden = state.surface !== 'website';
			let visualTools = host.querySelector('[data-qlab-visual-tools]');
			if (visualTools) {
				visualTools.hidden = state.surface !== 'visual';
				if (visualTools.hidden) {
					let formalMenu = visualTools.querySelector('[data-qlab-formal-menu]');
					if (formalMenu) formalMenu.hidden = true;
					let formalToggle = visualTools.querySelector('[data-qlab-formal-toggle]');
					if (formalToggle) formalToggle.setAttribute('aria-expanded', 'false');
				}
			}
			let toggle = host.querySelector('[data-qlab-preview-toggle]');
			if (toggle) {
				let action = Zotero.QLab.qmdSurfaceActionModel(state.surface);
				toggle.dataset.qlabCurrentSurface = action.current;
				toggle.title = action.label;
				toggle.setAttribute('aria-label', action.label);
				let hiddenLabel = toggle.querySelector('.sr-only');
				if (hiddenLabel) hiddenLabel.textContent = action.label;
			}
			activePreview?.setVisible(state.surface === 'website');
			let combined = Zotero.QLab.qmdWorkspaceStatus({
				persistence,
				message: persistenceMessage,
				preview: latestPreviewState || {},
				surface: state.surface,
			});
			setStatus(combined.text, combined.tone);
			for (let button of host.querySelectorAll('[data-qlab-preview-version]')) {
				button.classList.toggle(
					'is-active',
					button.dataset.qlabPreviewVersion === state.versionTarget
				);
			}
			let tabs = view.Zotero_Tabs;
			if (tabs && tabs.setTabData && host._qlabMountTabID) {
				tabs.setTabData(host._qlabMountTabID, {
					qmdWorkspace: {
						explorerVisible: state.explorerVisible,
						surface: state.surface,
						versionTarget: state.versionTarget,
					},
				});
			}
		}

		let watcher = Zotero.QLab.createQmdExplorerWatcher({
			readSnapshot: () => Zotero.QLab.buildQmdExplorerSnapshot(root, explorerHost),
			onChange: async snapshot => {
				let tree = host.querySelector('[data-qlab-qmd-explorer]');
				if (tree) Zotero.QLab.setHTML(tree, Zotero.QLab.renderQmdExplorerHTML(snapshot));
				for (let row of host.querySelectorAll('[data-qlab-document-row]')) {
					row.classList.toggle('is-active', row.dataset.qlabDocumentRow === activePath);
				}
				if (activeSession) {
					try {
						let descriptor = sessionDocument(activeSession);
						let observedSession = activeSession;
						let observedPath = activePath;
						await Zotero.QLab.reconcileQmdExplorerActiveDocument({
							snapshot,
							activeDocument: descriptor,
							reloadReadonly: async () => {
								if (!documentManager) throw new Error('Verified read-only reload is unavailable');
								return documentManager.reloadActive();
							},
							failClosedReadonly: error => documentManager?.closeActiveReadonly(error),
							observeDraft: async () => {
								let disk = await Zotero.QLab.QmdDraftIO.readSource(
									root, observedPath, ioHost
								);
								if (activeSession === observedSession && activePath === observedPath) {
									observedSession.observeDisk(disk);
								}
							},
						});
					}
					catch (error) {
						Zotero.logError && Zotero.logError(error);
					}
				}
			},
			schedule: (fn, ms) => view.setTimeout(fn, ms),
			cancel: id => view.clearTimeout(id),
		});

		let controller = Zotero.QLab.createQmdWorkspaceController({
			watcher,
			monaco: monacoBridge,
			visual: visualEditor,
			ownsSession: !verifiedReadonlyIO,
			onLayout: applyLayout,
			explorerVisible: !layout || layout.explorerVisible !== false,
			surface: layout && layout.surface,
			previewVisible: layout && layout.previewVisible,
			versionTarget: layout && layout.versionTarget,
		});
		if (verifiedReadonlyIO) {
			documentManager = Zotero.QLab.createQmdWorkspaceDocumentManager({
				root,
				readonlyIO: verifiedReadonlyIO,
				host,
				onActivate: activateReadonlyDocument,
				onReload({ document: descriptor, session }) {
					if (activeSession !== session || activePath !== descriptor.relativePath) return;
					monacoBridge.showNormal();
					visualBridge.sync({ force: true });
					void activePreview?.refresh(session.snapshot().revision);
					setPersistenceStatus('saved', 'Read-only document reloaded');
				},
				onFailClosed: deactivateReadonlyDocument,
			});
		}

		function showPreviewState(state) {
			latestPreviewState = state;
			if (previewVersion !== 'original') return;
			let presentation = Zotero.QLab.qmdPreviewPresentation(state);
			if (presentation.mode === 'exact') {
				previewSurface.showExact(state.url);
			}
			else if (presentation.mode === 'quick') {
				previewSurface.showQuick(state.fallback);
			}
			else previewSurface.showEmpty();
			if (state.diagnostics && state.diagnostics.length && activeSession) {
				monacoBridge.setDiagnostics(diagnosticOffsets(activeSession.snapshot().text, state.diagnostics));
			}
			let combined = Zotero.QLab.qmdWorkspaceStatus({
				persistence,
				message: persistenceMessage,
				preview: state,
				surface: controller.snapshot().surface,
			});
			setStatus(combined.text, combined.tone);
		}

		async function showPreview(version) {
			previewVersion = version === 'proposed' && proposal ? 'proposed' : 'original';
			controller.showVersionTarget(previewVersion);
			if (previewVersion === 'proposed') {
				previewSurface.showQuick(Zotero.QLab.renderQmdDocumentHTML(proposal.proposed, {
					title: `${activePath} · Proposed`,
				}));
				return;
			}
			showPreviewState(activePreview ? activePreview.snapshot() : {});
		}

		function applyDocumentChrome(descriptor) {
			return Zotero.QLab.applyQmdDocumentChrome(host, descriptor, {
				proposal: !!proposal,
			});
		}

		function deactivateReadonlyDocument({ session }) {
			if (activeSession !== session) return false;
			activeDocumentGeneration += 1;
			activePath = '';
			activeSession = null;
			proposal = null;
			previewVersion = 'original';
			latestPreviewState = null;
			persistence = 'error';
			persistenceMessage = 'Read-only document closed after reload failure';
			complianceResult = null;
			activePreview = null;

			// Fail-closed neutralization must be exhaustive. A broken surface adapter
			// must not leave another surface, the tab payload, or the chrome pointing
			// at the disposed read-only session.
			let cleanupError = null;
			function cleanup(operation) {
				try {
					operation();
				}
				catch (error) {
					if (!cleanupError) cleanupError = error;
				}
			}
			cleanup(() => controller.setResources({ preview: null, session: null }));
			cleanup(() => visualBridge.setSession(null));
			cleanup(() => monacoBridge.clear());
			cleanup(() => previewSurface.clear());
			cleanup(() => { host._qlabDraftState = null; });
			cleanup(() => { host._qlabPendingInserts = []; });
			cleanup(() => { host._qlabMonacoSelection = null; });
			cleanup(() => {
				let pathLabel = host.querySelector('[data-qlab-draft-path]');
				if (pathLabel) {
					pathLabel.textContent = 'No document';
					pathLabel.title = '';
				}
			});
			cleanup(() => {
				let tab = host.querySelector('[data-qlab-editor-tab]');
				if (tab) tab.textContent = 'No document';
			});
			cleanup(() => {
				let select = host.querySelector('[data-qlab-draft]');
				if (select) select.value = '';
			});
			cleanup(() => {
				for (let row of host.querySelectorAll('[data-qlab-document-row]')) {
					row.classList.toggle('is-active', false);
				}
			});
			cleanup(() => {
				let badge = host.querySelector('[data-qlab-authority-badge]');
				if (badge) badge.textContent = 'No document';
			});
			cleanup(() => {
				let authority = host.querySelector('.qlab-qmd-authority');
				if (authority) authority.textContent = '';
			});
			cleanup(() => {
				let shell = host.querySelector('.qlab-qmd-workspace');
				if (shell) {
					shell.dataset.qlabDocumentReadonly = 'true';
					shell.dataset.qlabDocumentAuthority = '';
					shell.dataset.qlabDocumentFormat = '';
				}
			});
			cleanup(() => {
				let tabs = view.Zotero_Tabs;
				if (tabs && tabs.setTabData && host._qlabMountTabID) {
					tabs.setTabData(host._qlabMountTabID, {
						draftPath: null,
						workspaceDocument: null,
					});
				}
			});
			cleanup(() => setStatus(persistenceMessage, 'error'));
			if (cleanupError) {
				try {
					Zotero.logError && Zotero.logError(cleanupError);
				}
				catch (_error) {}
			}
			return true;
		}

		function createReadonlyPreview(session, descriptor, sessionGeneration) {
			if (!descriptor.surfaces.includes('website')) return null;
			let disposed = false;
			let visible = controller.snapshot().surface === 'website';
			function state() {
				return {
					status: 'ready',
					url: '',
					fallback: Zotero.QLab.renderQmdDocumentHTML(session.snapshot().text, {
						title: descriptor.relativePath,
					}),
				};
			}
			function publish() {
				if (disposed || !visible || sessionGeneration !== activeDocumentGeneration) return false;
				showPreviewState(state());
				return true;
			}
			return {
				start: async () => publish(),
				retry: async () => publish(),
				refresh: async () => publish(),
				setVisible(next) {
					visible = !!next;
					return Promise.resolve(publish());
				},
				snapshot: state,
				dispose() { disposed = true; },
			};
		}

		function captureWorkspaceActivationDOM() {
			let records = new Map();
			let attributeNames = [
				'aria-label', 'aria-readonly', 'aria-expanded', 'aria-pressed',
			];
			function capture(selector, properties = [], classNames = [], children = false) {
				let elements = host.querySelectorAll ? Array.from(host.querySelectorAll(selector)) : [];
				if (!elements.length) {
					let element = host.querySelector && host.querySelector(selector);
					if (element) elements = [element];
				}
				for (let element of elements) {
					let record = records.get(element);
					if (!record) {
						record = {
							element,
							properties: new Map(),
							attributes: new Map(),
							dataset: element.dataset ? { ...element.dataset } : null,
							classes: new Map(),
							children: null,
						};
						records.set(element, record);
						for (let name of attributeNames) {
							record.attributes.set(name, element.getAttribute
								? element.getAttribute(name)
								: null);
						}
					}
					for (let name of properties) {
						if (!record.properties.has(name) && name in element) {
							record.properties.set(name, element[name]);
						}
					}
					for (let name of classNames) {
						if (!record.classes.has(name) && element.classList) {
							record.classes.set(name, element.classList.contains(name));
						}
					}
					if (children && record.children === null) {
						record.children = Array.from(element.childNodes || element.children || []);
					}
				}
			}
			capture('.qlab-qmd-workspace', [], ['is-files-collapsed', 'is-working-copy']);
			capture('[data-qlab-primary-surface]');
			capture('[data-qlab-visual-surface]', ['hidden']);
			capture('[data-qlab-source-surface]', ['hidden']);
			capture('[data-qlab-preview-surface]', ['hidden']);
			capture('[data-qlab-visual-editor-root]');
			capture('[data-qlab-visual-tools]', ['hidden']);
			capture('[data-qlab-formal-menu]', ['hidden']);
			capture('[data-qlab-formal-toggle]', ['hidden', 'disabled']);
			capture('[data-qlab-preview-toggle]', ['hidden', 'title']);
			capture('[data-qlab-draft-path]', ['textContent', 'title']);
			capture('[data-qlab-editor-tab]', ['textContent']);
			capture('[data-qlab-draft]', ['value']);
			capture('[data-qlab-draft-row]', [], ['is-active']);
			capture('[data-qlab-authority-badge]', ['textContent']);
			capture('.qlab-qmd-path-wrap', ['title']);
			capture('.qlab-qmd-authority', ['textContent']);
			capture('.qlab-qmd-tab-q', ['textContent']);
			capture('[data-qlab-qmd-monaco]', ['title']);
			capture('[data-qlab-inline]', ['hidden']);
			capture('[data-qlab-inline-prompt]', ['value']);
			capture('[data-qlab-pending]', ['hidden'], [], true);
			capture('[data-qlab-compliance]', ['hidden', 'disabled', 'title']);
			capture('[data-qlab-compliance-details]', ['hidden', 'textContent']);
			capture('[data-qlab-bib-search]', ['hidden']);
			capture('.qlab-qmd-preview-versions', ['hidden']);
			capture('[data-qlab-preview-version]', ['hidden', 'disabled'], ['is-active']);
			capture('[data-qlab-proposal-compare]', ['hidden', 'disabled']);
			capture('[data-qlab-draft-keep]', ['hidden', 'disabled']);
			capture('[data-qlab-draft-reject]', ['hidden', 'disabled']);
			capture('[data-qlab-draft-save]', ['hidden', 'disabled']);
			capture('[data-qlab-draft-ai]', ['hidden', 'disabled']);
			capture('[data-qlab-add-to-knowledge]', ['hidden', 'disabled']);
			capture('[data-qlab-complete-todos]', ['hidden', 'disabled']);
			capture('[data-qlab-external-editor]', ['hidden', 'disabled']);
			capture('[data-qlab-qmd-status]', ['textContent']);
			capture('[data-qlab-dirty-dot]', ['hidden']);
			capture('[data-qlab-editor]', ['value']);
			return Object.freeze({
				restore() {
					for (let record of records.values()) {
						let { element } = record;
						if (record.children !== null && element.replaceChildren) {
							element.replaceChildren(...record.children);
						}
						for (let [name, value] of record.properties) element[name] = value;
						if (record.dataset && element.dataset) {
							for (let name of Object.keys(element.dataset)) {
								if (!Object.prototype.hasOwnProperty.call(record.dataset, name)) {
									delete element.dataset[name];
								}
							}
							for (let [name, value] of Object.entries(record.dataset)) {
								element.dataset[name] = value;
							}
						}
						for (let [name, value] of record.attributes) {
							if (!element.setAttribute) continue;
							if (value === null || value === '') element.removeAttribute?.(name);
							else element.setAttribute(name, value);
						}
						for (let [name, value] of record.classes) {
							element.classList?.toggle(name, value);
						}
					}
					return true;
				},
			});
		}

		function activateReadonlyDocument({ document: descriptor, session }) {
			let previous = {
				activeDocumentGeneration,
				activePath,
				activeSession,
				activePreview,
				proposal,
				previewVersion,
				latestPreviewState,
				persistence,
				persistenceMessage,
				complianceResult,
				controller: controller.snapshot(),
				previewState: activePreview && typeof activePreview.snapshot === 'function'
					? activePreview.snapshot()
					: null,
				document: sessionDocument(activeSession),
			};
			let dom = captureWorkspaceActivationDOM();
			let sessionGeneration = previous.activeDocumentGeneration + 1;
			let preview = createReadonlyPreview(session, descriptor, sessionGeneration);
			let resources = controller.beginResourceTransaction({ preview, session });
			if (!resources) throw new Error('QMD workspace activation resources are unavailable');
			let state = 'pending';

			function restorePreviousView() {
				if (state === 'rolling-back' || state === 'rolled-back' || state === 'committed') {
					return false;
				}
				state = 'rolling-back';
				let rollbackError = null;
				function restore(operation) {
					try { operation(); }
					catch (error) {
						if (!rollbackError) rollbackError = error;
						Zotero.logError && Zotero.logError(error);
					}
				}
				restore(() => {
					activeDocumentGeneration = previous.activeDocumentGeneration;
					activePath = previous.activePath;
					activeSession = previous.activeSession;
					activePreview = previous.activePreview;
					proposal = previous.proposal;
					previewVersion = previous.previewVersion;
					latestPreviewState = previous.latestPreviewState;
					persistence = previous.persistence;
					persistenceMessage = previous.persistenceMessage;
					complianceResult = previous.complianceResult;
				});
				restore(() => { resources.rollback(); });
				restore(() => { controller.restoreState(previous.controller); });
				restore(() => { visualBridge.setSession(previous.activeSession); });
				restore(() => {
					if (previous.previewState) showPreviewState(previous.previewState);
					else previewSurface.clear();
				});
				restore(() => { monacoBridge.showNormal(); });
				restore(() => { dom.restore(); });
				let tabs = view.Zotero_Tabs;
				if (tabs && tabs.setTabData && host._qlabMountTabID) {
					restore(() => { tabs.setTabData(host._qlabMountTabID, {
						draftPath: previous.document && !previous.document.readOnly
							? previous.document.relativePath
							: null,
						workspaceDocument: previous.document && previous.document.readOnly
							? {
								path: previous.document.relativePath,
								authority: previous.document.authority,
								format: previous.document.format,
								readOnly: true,
							}
							: null,
						qmdWorkspace: {
							explorerVisible: previous.controller.explorerVisible,
							surface: previous.controller.surface,
							versionTarget: previous.controller.versionTarget,
						},
					}); });
				}
				state = 'rolled-back';
				if (rollbackError) throw rollbackError;
				return true;
			}

			function commitReadonlyView() {
				if (state !== 'pending') return false;
				state = 'applying';
				try {
					activeDocumentGeneration = sessionGeneration;
					activePath = descriptor.relativePath;
					activeSession = session;
					activePreview = preview;
					proposal = null;
					previewVersion = 'original';
					latestPreviewState = null;
					persistence = 'saved';
					persistenceMessage = 'Read-only';
					complianceResult = null;
					previewSurface.clear();
					visualBridge.setSession(session);
					if (!resources.apply()) {
						throw new Error('QMD workspace activation resources refused');
					}
					if (controller.showVersionTarget('original') === false) {
						throw new Error('QMD workspace version activation refused');
					}
					let currentSurface = controller.snapshot().surface;
					if (!descriptor.surfaces.includes(currentSurface)) {
						if (controller.showSurface(descriptor.surfaces[0]) === false) {
							throw new Error('QMD workspace surface activation refused');
						}
					}
					let pathLabel = host.querySelector('[data-qlab-draft-path]');
					if (pathLabel) {
						pathLabel.textContent = descriptor.relativePath;
						pathLabel.title = descriptor.relativePath;
					}
					let tab = host.querySelector('[data-qlab-editor-tab]');
					if (tab) tab.textContent = descriptor.relativePath.split('/').pop();
					let select = host.querySelector('[data-qlab-draft]');
					if (select) select.value = '';
					updateProposalControls();
					if (!applyDocumentChrome(descriptor)) {
						throw new Error('QMD workspace document chrome activation refused');
					}
					monacoBridge.showNormal();
					visualBridge.sync({ force: true });
					setPersistenceStatus('saved', `${descriptor.badge} · read-only`);
					let tabs = view.Zotero_Tabs;
					if (tabs && tabs.setTabData && host._qlabMountTabID) {
						tabs.setTabData(host._qlabMountTabID, {
							draftPath: null,
							workspaceDocument: {
								path: descriptor.relativePath,
								authority: descriptor.authority,
								format: descriptor.format,
								readOnly: true,
							},
						});
					}
					let started = preview && preview.start();
					if (started && typeof started.then === 'function') {
						Promise.resolve(started).catch(error => {
							if (state === 'committed') Zotero.logError && Zotero.logError(error);
						});
					}
					Zotero.QLab.resetQmdHostForReadonlyDocument(
						host, descriptor, session.snapshot(), { finalizeTurn: false }
					);
					if (!resources.commit()) {
						throw new Error('QMD workspace activation resources could not commit');
					}
					state = 'committed';
					return true;
				}
				catch (error) {
					try { restorePreviousView(); }
					catch (rollbackError) {
						Zotero.logError && Zotero.logError(rollbackError);
					}
					throw error;
				}
			}

			return workspaceActivationTransaction({
				commit: commitReadonlyView,
				rollback: restorePreviousView,
				afterCommit() {
					Zotero.QLab.finalizeQmdHostReadonlyActivation(host);
					if (complianceTimer !== null) {
						view.clearTimeout(complianceTimer);
						complianceTimer = null;
					}
				},
				managesHostReset: true,
			});
		}

		function queueSurfaceTransition(value) {
			if (!Zotero.QLab.qmdSessionAllows(activeSession, 'surfaceNavigation')) {
				return Promise.resolve(false);
			}
			let run = () => {
				let descriptor = sessionDocument(activeSession);
				let state = controller.snapshot();
				let target = value === undefined
					? (descriptor && descriptor.surfaces.length
						? descriptor.surfaces[(descriptor.surfaces.indexOf(state.surface) + 1)
							% descriptor.surfaces.length]
						: Zotero.QLab.nextQmdSurfaceMode(state.surface))
					: Zotero.QLab.normalizeQmdSurfaceMode(value);
				if (descriptor && !descriptor.surfaces.includes(target)) return false;
				return Zotero.QLab.transitionQmdWorkspaceSurface(
					controller, visualEditor, target
				);
			};
			let operation = surfaceTransition.catch(() => false).then(run);
			surfaceTransition = operation;
			return operation;
		}

		async function openWorkspaceDocument(spec = {}, capability) {
			if (!documentManager) return false;
			let request = openGate.begin();
			documentManager.invalidatePrepared();
			try {
				if (!await Zotero.QLab.flushQmdDraftBeforeTransition(activeSession, visualEditor)) {
					return false;
				}
			}
			catch (error) {
				if (!request.isCurrent()) return false;
				setPersistenceStatus('error', error && error.message || String(error));
				return false;
			}
			if (!request.isCurrent()) return false;
			try {
				return await documentManager.openWorkspaceDocument(spec, capability);
			}
			catch (error) {
				if (!request.isCurrent()) return false;
				setPersistenceStatus('error', error && error.message || String(error));
				return false;
			}
		}

		async function prepareDraftDocument(relativePath, verifiedDraft = null) {
			let classification = Zotero.QLab.classifyWorkspaceDocument(relativePath);
			if (!classification || classification.authority !== 'draft'
					|| classification.kind !== 'qmd' || !classification.writable) return false;
			let request = openGate.begin();
			documentManager?.invalidatePrepared();
			try {
				if (!await Zotero.QLab.flushQmdDraftBeforeTransition(activeSession, visualEditor)) {
					return false;
				}
			}
			catch (error) {
				if (!request.isCurrent()) return false;
				setPersistenceStatus('error', error && error.message || String(error));
				return false;
			}
			if (!request.isCurrent()) return false;
			if (activeSession && activePath === relativePath) {
				let state = 'pending';
				let commit = () => {
					if (state !== 'pending' || disposing || !request.isCurrent()
							|| activeSession === null || activePath !== relativePath) return false;
					state = 'committed';
					return true;
				};
				let rollback = () => {
					if (state !== 'pending') return false;
					state = 'rolled-back';
					return true;
				};
				return Object.freeze({
					stage: Zotero.QLab.createWorkspaceDocumentRouteStage({ commit, rollback }),
					commit,
					rollback,
				});
			}
			let doc;
			if (verifiedDraft !== null) {
				if (!Zotero.QLab.verifiedWorkspaceDraftReadMatches?.(
					verifiedDraft, relativePath
				)) {
					throw new Error('Routed Draft preparation requires handle-bound verified bytes');
				}
				doc = verifiedDraft;
			}
			else {
				try {
					doc = await Zotero.QLab.QmdDraftIO.readSource(root, relativePath, ioHost);
				}
				catch (error) {
					if (!request.isCurrent()) return false;
					setPersistenceStatus('error', error && error.message || String(error));
					return false;
				}
			}
			if (!request.isCurrent()) return false;
			let nextProposal = null;
			let found;
			try {
				found = await Zotero.QLab.QmdDraftIO.findProposal(root, relativePath, ioHost);
			}
			catch (error) {
				if (!request.isCurrent()) return false;
				setPersistenceStatus('error', error && error.message || String(error));
				return false;
			}
			if (!request.isCurrent()) return false;
			if (found) {
				try {
					let [base, proposed] = await Promise.all([
						ioHost.read(joinRoot(root, found.basePath)),
						ioHost.read(joinRoot(root, found.workingPath)),
					]);
					if (!request.isCurrent()) return false;
					nextProposal = {
						state: found,
						base,
						proposed,
					};
				}
				catch (error) {
					if (!request.isCurrent()) return false;
					Zotero.logError && Zotero.logError(error);
				}
			}
			if (!request.isCurrent()) return false;
			let sessionGeneration = activeDocumentGeneration + 1;
			let session = Zotero.QLab.createQmdDraftSession({
				path: relativePath,
				text: doc.text,
				revision: doc.revision,
				schedule: (fn, ms) => view.setTimeout(fn, ms),
				cancel: id => view.clearTimeout(id),
				onSave: ({ text, expectedRevision }) => Zotero.QLab.QmdDraftIO.writeSource(
					root, relativePath, text, expectedRevision, ioHost
				),
				onState: snapshot => {
					if (sessionGeneration !== activeDocumentGeneration) return;
					let textChanged = host._qlabBuffer !== snapshot.text;
					host._qlabBuffer = snapshot.text;
					host._qlabDirty = snapshot.dirty;
					let legacy = host.querySelector('[data-qlab-editor]');
					if (legacy) legacy.value = snapshot.text;
					let dot = host.querySelector('[data-qlab-dirty-dot]');
					if (dot) dot.hidden = !snapshot.dirty;
					if (snapshot.saveError) setPersistenceStatus('error', snapshot.saveError);
					else if (snapshot.saving) setPersistenceStatus('saving');
					else if (snapshot.dirty) {
						setPersistenceStatus('dirty');
						markComplianceStale();
					}
					else {
						setPersistenceStatus(proposal ? 'proposal' : 'saved');
						if (textChanged) monacoBridge.showNormal();
					}
					visualBridge.sync();
				},
				onSaved: snapshot => {
					if (sessionGeneration !== activeDocumentGeneration) return;
					host._qlabLastSaved = snapshot.text;
					if (host._qlabDraftState) host._qlabDraftState.revision = snapshot.revision;
					setPersistenceStatus(proposal ? 'proposal' : 'saved');
					visualBridge.sync();
					void activePreview?.refresh(snapshot.revision);
					scheduleCompliance();
				},
				onConflict: ({ disk, buffer }) => {
					if (sessionGeneration !== activeDocumentGeneration) return;
					setPersistenceStatus('conflict', 'Draft changed on disk · compare before saving');
					monacoBridge.showDiff({ original: disk.text, proposed: buffer.text });
				},
			});
			let preview = Zotero.QLab.createQmdPreviewController({
				root,
				path: relativePath,
				visible: controller.snapshot().surface === 'website',
				fallback: () => Zotero.QLab.renderQmdDocumentHTML(session.snapshot().text, {
					title: relativePath,
				}),
				onState: state => {
					if (sessionGeneration === activeDocumentGeneration) showPreviewState(state);
				},
			});
			if (!request.isCurrent()) {
				session.dispose();
				preview.dispose();
				return false;
			}
			let state = 'pending';
			let resources = null;
			let managerActivation = null;
			let previous = null;
			let dom = null;

			function disposePrepared() {
				try { session.dispose(); }
				catch (error) { Zotero.logError && Zotero.logError(error); }
				try { preview.dispose(); }
				catch (error) { Zotero.logError && Zotero.logError(error); }
			}

			function restorePreviousView() {
				if (state === 'committed' || state === 'rolled-back') return false;
				state = 'rolling-back';
				let rollbackError = null;
				function restore(operation) {
					try { operation(); }
					catch (error) {
						if (!rollbackError) rollbackError = error;
						Zotero.logError && Zotero.logError(error);
					}
				}
				if (previous) {
					restore(() => { managerActivation?.rollback(); });
					restore(() => { resources?.rollback(); });
					if (!resources) restore(disposePrepared);
					else if (documentManager && !managerActivation) {
						restore(() => { session.dispose(); });
					}
					restore(() => {
						activeDocumentGeneration = previous.activeDocumentGeneration;
						activePath = previous.activePath;
						activeSession = previous.activeSession;
						activePreview = previous.activePreview;
						proposal = previous.proposal;
						previewVersion = previous.previewVersion;
						latestPreviewState = previous.latestPreviewState;
						persistence = previous.persistence;
						persistenceMessage = previous.persistenceMessage;
						complianceResult = previous.complianceResult;
						host._qlabDraftState = previous.draftState;
						host._qlabLastSaved = previous.lastSaved;
						host._qlabBuffer = previous.buffer;
						host._qlabDirty = previous.dirty;
					});
					restore(() => { controller.restoreState(previous.controller); });
					restore(() => { visualBridge.setSession(previous.activeSession); });
					restore(() => {
						if (previous.previewState) showPreviewState(previous.previewState);
						else previewSurface.clear();
					});
					restore(() => { monacoBridge.showNormal(); });
					restore(() => { dom?.restore(); });
					let tabs = view.Zotero_Tabs;
					if (tabs && tabs.setTabData && host._qlabMountTabID) {
						restore(() => { tabs.setTabData(host._qlabMountTabID, {
							draftPath: previous.document && !previous.document.readOnly
								? previous.document.relativePath
								: null,
							workspaceDocument: previous.document && previous.document.readOnly
								? {
									path: previous.document.relativePath,
									authority: previous.document.authority,
									format: previous.document.format,
									readOnly: true,
								}
								: null,
						}); });
					}
				}
				else disposePrepared();
				state = 'rolled-back';
				if (rollbackError) throw rollbackError;
				return true;
			}

			function commit() {
				if (state !== 'pending' || disposing || !request.isCurrent()) return false;
				previous = {
					activeDocumentGeneration,
					activePath,
					activeSession,
					activePreview,
					proposal,
					previewVersion,
					latestPreviewState,
					persistence,
					persistenceMessage,
					complianceResult,
					draftState: host._qlabDraftState,
					lastSaved: host._qlabLastSaved,
					buffer: host._qlabBuffer,
					dirty: host._qlabDirty,
					controller: controller.snapshot(),
					previewState: activePreview && typeof activePreview.snapshot === 'function'
						? activePreview.snapshot()
						: null,
					document: sessionDocument(activeSession),
				};
				dom = captureWorkspaceActivationDOM();
				resources = controller.beginResourceTransaction({ preview, session });
				if (!resources) return false;
				managerActivation = documentManager
					? documentManager.prepareDraftActivation(session)
					: null;
				if (documentManager && !managerActivation) return false;
				state = 'applying';
				try {
					activeDocumentGeneration = sessionGeneration;
					activePath = relativePath;
					latestPreviewState = null;
					persistence = 'saved';
					persistenceMessage = 'Saved';
					proposal = nextProposal;
					complianceResult = null;
					let complianceDetails = host.querySelector('[data-qlab-compliance-details]');
					if (complianceDetails) {
						complianceDetails.hidden = true;
						complianceDetails.textContent = '';
					}
					activeSession = session;
					activePreview = preview;
					visualBridge.setSession(session);
					if (proposal) session.attachProposal(proposal.state);
					previewSurface.clear();
					if (!resources.apply()) throw new Error('Draft workspace resources refused');
					host._qlabDraftState = {
						originalPath: relativePath,
						workingPath: proposal ? proposal.state.workingPath : null,
						basePath: proposal ? proposal.state.basePath : null,
						revision: doc.revision,
						viewingWorking: false,
					};
					host._qlabLastSaved = doc.text;
					host._qlabBuffer = doc.text;
					let tabs = view.Zotero_Tabs;
					if (tabs && tabs.setTabData && host._qlabMountTabID) {
						tabs.setTabData(host._qlabMountTabID, {
							draftPath: relativePath,
							workspaceDocument: null,
						});
					}
					let pathLabel = host.querySelector('[data-qlab-draft-path]');
					if (pathLabel) {
						pathLabel.textContent = relativePath;
						pathLabel.title = relativePath;
					}
					let tab = host.querySelector('[data-qlab-editor-tab]');
					if (tab) tab.textContent = relativePath.split('/').pop();
					let select = host.querySelector('[data-qlab-draft]');
					if (select) select.value = relativePath;
					for (let row of host.querySelectorAll('[data-qlab-draft-row]')) {
						row.classList.toggle('is-active', row.dataset.qlabDraftRow === relativePath);
					}
					updateProposalControls();
					if (!applyDocumentChrome(session.document)) {
						throw new Error('Draft workspace document chrome refused');
					}
					previewVersion = 'original';
					if (controller.showVersionTarget('original') === false) {
						throw new Error('Draft workspace version activation refused');
					}
					monacoBridge.showNormal();
					setPersistenceStatus(proposal ? 'proposal' : 'saved');
					if (managerActivation) {
						if (!managerActivation.apply()) {
							throw new Error('Draft document-manager activation refused');
						}
					}
					else setHostDocumentState(host, session.document, session.snapshot());
					if (!resources.commit()) {
						throw new Error('Draft workspace resources could not commit');
					}
					if (managerActivation && !managerActivation.commit()) {
						throw new Error('Draft document-manager activation could not commit');
					}
					state = 'committed';
				}
				catch (error) {
					restorePreviousView();
					throw error;
				}
				try {
					let started = preview.start();
					if (started && typeof started.then === 'function') {
						Promise.resolve(started).catch(error => {
							if (state === 'committed') Zotero.logError && Zotero.logError(error);
						});
					}
					scheduleCompliance(0);
				}
				catch (error) { Zotero.logError && Zotero.logError(error); }
				return true;
			}

			return Object.freeze({
				stage: Zotero.QLab.createWorkspaceDocumentRouteStage({
					commit,
					rollback: restorePreviousView,
				}),
				commit,
				rollback: restorePreviousView,
			});
		}

		async function prepareWorkspaceDocument(spec = {}, capability, verifiedDraft = null) {
			let classification = Zotero.QLab.classifyWorkspaceDocument(
				spec.relativePath || spec.path
			);
			if (classification && classification.authority === 'draft') {
				if (!Zotero.QLab.verifiedWorkspaceDraftReadMatches?.(
					verifiedDraft, classification.path
				)) return false;
				let prepared = await prepareDraftDocument(classification.path, verifiedDraft);
				return prepared ? prepared.stage : false;
			}
			if (!documentManager) return false;
			let request = openGate.begin();
			documentManager.invalidatePrepared();
			try {
				if (!await Zotero.QLab.flushQmdDraftBeforeTransition(activeSession, visualEditor)) {
					return false;
				}
			}
			catch (error) {
				if (!request.isCurrent()) return false;
				setPersistenceStatus('error', error && error.message || String(error));
				return false;
			}
			if (!request.isCurrent()) return false;
			try {
				return await documentManager.prepareWorkspaceDocument(spec, capability);
			}
			catch (error) {
				if (!request.isCurrent()) return false;
				setPersistenceStatus('error', error && error.message || String(error));
				return false;
			}
		}

		async function openDraft(relativePath) {
			let prepared = await prepareDraftDocument(relativePath);
			if (!prepared) return false;
			try {
				let committed = prepared.commit();
				if (!committed) prepared.rollback();
				return committed;
			}
			catch (error) {
				prepared.rollback();
				setPersistenceStatus('error', error && error.message || String(error));
				return false;
			}
		}

		async function prepareDraftRoute(relativePath) {
			let prepared = await prepareDraftDocument(relativePath);
			if (!prepared || disposing) {
				prepared?.rollback();
				return false;
			}
			let token = Object.freeze(Object.create(null));
			let record = { prepared, state: 'pending' };
			preparedDraftRoutes.set(token, record);
			pendingPreparedDraftRoutes.add(record);
			return token;
		}

		function commitPreparedDraftRoute(token) {
			let record = token && preparedDraftRoutes.get(token);
			if (!record || record.state !== 'pending' || disposing) return false;
			let committed = record.prepared.commit();
			if (committed !== true) return false;
			record.state = 'committed';
			preparedDraftRoutes.delete(token);
			pendingPreparedDraftRoutes.delete(record);
			return true;
		}

		function rollbackPreparedDraftRoute(token) {
			let record = token && preparedDraftRoutes.get(token);
			if (!record || record.state !== 'pending') return false;
			record.state = 'rolling-back';
			try { return record.prepared.rollback() === true; }
			finally {
				record.state = 'rolled-back';
				preparedDraftRoutes.delete(token);
				pendingPreparedDraftRoutes.delete(record);
			}
		}

		async function runComplianceAction() {
			if (!Zotero.QLab.qmdSessionAllows(activeSession, 'edit')) return null;
			let details = host.querySelector('[data-qlab-compliance-details]');
			let snapshot = activeSession ? activeSession.snapshot() : {};
			let current = {
				path: activePath,
				generation: activeDocumentGeneration,
				revision: String(snapshot.revision || ''),
				text: String(snapshot.text || ''),
			};
			if (Zotero.QLab.qmdComplianceResultMatches(complianceResult, current)) {
				if (details && !details.hidden) {
					details.hidden = true;
					return complianceResult.result;
				}
				renderCompliance(complianceResult.result, {
					showDetails: true,
					checked: complianceResult.checked,
				});
				return complianceResult.result;
			}
			complianceResult = null;
			return checkCompliance({ showDetails: true });
		}

		async function refreshActiveSurface() {
			let intent = {
				session: activeSession,
				path: activePath,
				generation: activeDocumentGeneration,
				preview: activePreview,
			};
			let isCurrent = () => !disposing
				&& activeSession === intent.session
				&& activePath === intent.path
				&& activeDocumentGeneration === intent.generation
				&& activePreview === intent.preview;
			return Zotero.QLab.runQmdWorkspaceRefresh(async () => {
				if (!await Zotero.QLab.flushQmdDraftBeforeTransition(intent.session, visualEditor)) {
					return false;
				}
				if (!isCurrent()) return false;
				let descriptor = sessionDocument(intent.session);
				if (descriptor && descriptor.readOnly) {
					if (!documentManager) throw new Error('Verified read-only reload is unavailable');
					await documentManager.reloadActive();
					if (!isCurrent()) return false;
				}
				let surface = controller.snapshot().surface;
				if (surface === 'website') {
					await intent.preview?.retry();
				}
				else if (surface === 'source') {
					monacoBridge.showNormal();
				}
				else {
					visualBridge.sync({ force: true });
				}
				if (!isCurrent()) return false;
				setPersistenceStatus(proposal ? 'proposal' : 'saved');
				return true;
			}, error => {
				if (isCurrent()) {
					setPersistenceStatus('error', error && error.message || String(error));
				}
			});
		}

		async function openExternalEditor() {
			try {
				if (!Zotero.QLab.qmdSessionAllows(activeSession, 'externalEditor')) return false;
				let editorSession = activeSession;
				let editorGeneration = activeDocumentGeneration;
				let editorPath = activePath;
				if (!activePath) throw new Error('Open a Draft first');
				if (!await Zotero.QLab.flushQmdDraftBeforeTransition(activeSession, visualEditor)) {
					return false;
				}
				let runtime = Zotero.QLab.createQmdExternalEditorRuntime();
				if (!externalEditorsPromise) {
					externalEditorsPromise = Zotero.QLab.installedQmdEditors(runtime);
				}
				let installed = await externalEditorsPromise;
				if (editorSession !== activeSession || editorGeneration !== activeDocumentGeneration
						|| editorPath !== activePath
						|| !Zotero.QLab.qmdSessionAllows(activeSession, 'externalEditor')) return false;
				let remembered = '';
				try {
					remembered = String(Zotero.Prefs.get('qlab.qmdExternalEditor') || 'cursor');
				}
				catch (e) {}
				let editor = Zotero.QLab.preferredQmdEditor(installed, remembered);
				if (!editor) throw new Error('Install Cursor or another supported editor first');
				await Zotero.QLab.openQmdInExternalEditor(runtime, editor, root, editorPath);
				try {
					Zotero.Prefs.set('qlab.qmdExternalEditor', editor.id);
				}
				catch (e) {}
				if (editorSession !== activeSession || editorGeneration !== activeDocumentGeneration) return false;
				setStatus(`Opened ${editorPath} in ${editor.label}`, 'saved');
				return true;
			}
			catch (error) {
				setStatus(error && error.message || String(error), 'error');
				return false;
			}
		}

		async function runDraftReview() {
			let button = host.querySelector('[data-qlab-add-to-knowledge]');
			try {
				if (!Zotero.QLab.qmdSessionAllows(activeSession, 'promote')) return null;
				let reviewSession = activeSession;
				if (!activePath) throw new Error('Open a Draft first');
				if (proposal) throw new Error('Keep or Reject the AI proposal before adding this Draft to Knowledge');
				if (!await Zotero.QLab.flushQmdDraftBeforeTransition(activeSession, visualEditor)) {
					return null;
				}
				let reviewPath = activePath;
				let reviewGeneration = activeDocumentGeneration;
				if (button) button.disabled = true;
				setStatus('Checking the Draft, then starting read-only AI review…', 'saving');
				let result = await Zotero.QLab.reviewAndPromoteDraft({
					root,
					draftPath: reviewPath,
					host: ioHost,
					review: () => Zotero.QLab.runQmdDraftReviewAction({
						host,
						window: view,
						root,
						workspaceState: 'ready',
						relativePath: reviewPath,
						title: reviewPath.split('/').pop(),
					}),
					confirm: ({ draftPath, knowledgePath }) => {
						if (reviewGeneration !== activeDocumentGeneration || reviewPath !== activePath) {
							throw new Error('The active Draft changed during review; open the reviewed Draft and try again');
						}
						if (reviewSession !== activeSession
								|| !Zotero.QLab.qmdSessionAllows(activeSession, 'promote')) {
							throw new Error('The active document is not an editable Draft');
						}
						if (proposal) {
							throw new Error('A new AI proposal is waiting; Keep or Reject it before publishing');
						}
						let prompt = typeof Services !== 'undefined' && Services.prompt;
						if (!prompt) throw new Error('Human publication approval is unavailable');
						return prompt.confirm(
							view,
							'Add to Knowledge',
							`AI review completed without changing files.\n\nCopy ${draftPath} to ${knowledgePath}?\n\nThe Draft will be retained and existing Knowledge will never be overwritten.`
						);
					},
				});
				if (result.promoted) {
					setStatus(`Added to ${result.to} · original Draft retained`, 'saved');
				}
				else if (result.status === 'declined') {
					setStatus('Publication cancelled · Draft and Knowledge unchanged', 'saved');
				}
				else {
					setStatus('AI review stopped · Draft and Knowledge unchanged', 'saved');
				}
				return result;
			}
			catch (error) {
				setStatus(error && error.message || String(error), 'error');
				return null;
			}
			finally {
				if (button) button.disabled = false;
			}
		}

		async function runTodoCompletion() {
			let button = host.querySelector('[data-qlab-complete-todos]');
			try {
				if (!Zotero.QLab.qmdSessionAllows(activeSession, 'completeTodos')) return null;
				let todoSession = activeSession;
				if (!activePath) throw new Error('Open a Draft first');
				if (!await Zotero.QLab.flushQmdDraftBeforeTransition(activeSession, visualEditor)) {
					return null;
				}
				let todoPath = activePath;
				let todoGeneration = activeDocumentGeneration;
				if (button) button.disabled = true;
				setStatus('Completing TODOs in a private AI working copy…', 'saving');
				let result = await Zotero.QLab.runQmdTodoCompletion({
					host,
					window: view,
					root,
					originalPath: todoPath,
				});
				if (result.status === 'proposal-ready' && result.proposal
						&& todoSession === activeSession
						&& Zotero.QLab.qmdSessionAllows(activeSession, 'completeTodos')
						&& todoGeneration === activeDocumentGeneration && todoPath === activePath) {
					await workspace.attachProposal(
						result.proposal.state,
						result.proposal.proposedText,
						result.proposal.baseText
					);
					setStatus('TODO proposal ready · compare, then Keep or Reject', 'proposal');
				}
				else if (result.status === 'rejected') {
					setStatus('TODO completion stopped · the existing AI proposal was unchanged', 'error');
				}
				return result;
			}
			catch (error) {
				setStatus(error && error.message || String(error), 'error');
				return null;
			}
			finally {
				if (button) button.disabled = false;
			}
		}

		async function insertFormalBlock(kind) {
			try {
				if (!Zotero.QLab.qmdSessionAllows(activeSession, 'insertFormalBlock')) return false;
				if (controller.snapshot().surface !== 'visual') return false;
				await visualEditor.insertFormalBlock(kind);
				return true;
			}
			catch (error) {
				setStatus(error && error.message || String(error), 'error');
				return false;
			}
		}

		let unbindWorkspaceClick = () => {};
		let workspace = {
			controller,
			openDraft,
			prepareDraftRoute,
			commitPreparedDraftRoute,
			rollbackPreparedDraftRoute,
			openWorkspaceDocument,
			prepareWorkspaceDocument,
			document() {
				return sessionDocument(activeSession);
			},
			documentSnapshot() {
				let descriptor = sessionDocument(activeSession);
				let snapshot = descriptor && activeSession
					&& typeof activeSession.snapshot === 'function'
					? activeSession.snapshot()
					: null;
				if (!descriptor || !snapshot || snapshot.disposed) return null;
				return Object.freeze({
					document: descriptor,
					path: descriptor.relativePath,
					text: String(snapshot.text ?? ''),
					revision: String(snapshot.revision ?? ''),
					disposed: false,
				});
			},
			reloadActiveDocument() {
				let descriptor = sessionDocument(activeSession);
				return descriptor && descriptor.readOnly
					? documentManager.reloadActive()
					: watcher.poll();
			},
			refreshExplorer: () => watcher.poll(),
			checkCompliance: runComplianceAction,
			reviewForKnowledge: runDraftReview,
			completeTodos: runTodoCompletion,
			insertFormalBlock,
			openExternalEditor,
			refreshActiveSurface,
			saveNow: () => Zotero.QLab.runQmdWorkspaceCapability(
				activeSession,
				'save',
				() => activeSession.saveNow(),
				Promise.resolve(null)
			),
			setBuffer(text, { human = true } = {}) {
				if (!Zotero.QLab.qmdSessionAllows(activeSession, 'sharedBufferWrite')) return false;
				if (human) activeSession.applyHumanEdit(text);
				monacoBridge.showNormal();
				return true;
			},
			async attachProposal(state, proposedText, baseText = '') {
				if (!Zotero.QLab.qmdSessionAllows(activeSession, 'proposal')
						|| !Zotero.QLab.qmdProposalBelongsToDraft(state, activePath)) {
					return false;
				}
				proposal = { state, proposed: proposedText, base: baseText || activeSession.snapshot().savedText };
				activeSession.attachProposal(state);
				host._qlabDraftState = { ...host._qlabDraftState, ...state, viewingWorking: false };
				updateProposalControls();
				monacoBridge.showDiff({ original: activeSession.snapshot().text, proposed: proposedText });
				await showPreview('proposed');
				return true;
			},
			async showProposalDiff() {
				if (!Zotero.QLab.qmdSessionAllows(activeSession, 'proposal') || !proposal) return false;
				if (!await queueSurfaceTransition('source')) return false;
				controller.showVersionTarget('proposed');
				monacoBridge.showDiff({ original: activeSession.snapshot().text, proposed: proposal.proposed });
				return true;
			},
			async showSource() {
				if (!await queueSurfaceTransition('source')) return false;
				monacoBridge.showNormal();
				return true;
			},
			async revealReadonlySelection(request = {}) {
				let descriptor = sessionDocument(activeSession);
				let snapshot = descriptor && activeSession && activeSession.snapshot();
				let start = request.start;
				let end = request.end;
				if (!descriptor || descriptor.readOnly !== true
						|| descriptor.capabilities.chatSelection !== true
						|| descriptor.relativePath !== String(request.relativePath || '')
						|| !snapshot || snapshot.disposed
						|| String(snapshot.revision || '') !== String(request.revision || '')
						|| !Number.isInteger(start) || !Number.isInteger(end)
						|| start < 0 || end <= start || end > snapshot.text.length
						|| snapshot.text.slice(start, end) !== String(request.text || '')) {
					return false;
				}
				if (!await queueSurfaceTransition('source')) return false;
				// Revalidate after the asynchronous surface flush/transition.
				let currentDescriptor = sessionDocument(activeSession);
				let current = currentDescriptor && activeSession.snapshot();
				if (!currentDescriptor || currentDescriptor.relativePath !== descriptor.relativePath
						|| !current || current.disposed
						|| String(current.revision || '') !== String(request.revision || '')
						|| current.text.slice(start, end) !== String(request.text || '')) {
					return false;
				}
				monacoBridge.showNormal();
				monacoBridge.revealRange({ start, end });
				host._qlabMonacoSelection = {
					start,
					end,
					text: String(request.text || ''),
				};
				return true;
			},
			showPreview,
			async keepProposal() {
				if (!Zotero.QLab.qmdSessionAllows(activeSession, 'keepReject')) {
					return { kept: false, readOnly: true };
				}
				if (!proposal) throw new Error('No AI proposal to Keep');
				if (!await Zotero.QLab.flushQmdDraftBeforeTransition(activeSession, visualEditor)) {
					return { kept: false, blocked: true };
				}
				let keepGeneration = activeDocumentGeneration;
				let keepSession = activeSession;
				let keepProposal = proposal;
				let result = await Zotero.QLab.QmdDraftIO.keepChange(root, keepProposal.state, ioHost);
				if (keepSession !== activeSession
						|| !Zotero.QLab.qmdSessionAllows(activeSession, 'keepReject')) return result;
				if (!result.kept) {
					if (keepGeneration !== activeDocumentGeneration) return result;
					setStatus('AI proposal conflicts with human edits · review the diff', 'conflict');
					monacoBridge.showDiff({ original: result.review.current, proposed: result.review.proposed });
					return result;
				}
				if (keepGeneration === activeDocumentGeneration) {
					activePath = '';
					await openDraft(result.path);
				}
				return result;
			},
			async rejectProposal() {
				if (!Zotero.QLab.qmdSessionAllows(activeSession, 'keepReject')) {
					return { rejected: false, readOnly: true };
				}
				if (!proposal) return { rejected: false };
				let captured = {
					proposal,
					path: activePath,
					generation: activeDocumentGeneration,
				};
				let result = await Zotero.QLab.QmdDraftIO.rejectChange(
					root,
					captured.proposal.state,
					ioHost
				);
				if (!Zotero.QLab.qmdSessionAllows(activeSession, 'keepReject')) return result;
				if (!Zotero.QLab.qmdProposalActionStillCurrent(captured, {
					proposal,
					path: activePath,
					generation: activeDocumentGeneration,
				})) {
					return result;
				}
				proposal = null;
				activeSession.clearProposal();
				host._qlabDraftState.workingPath = null;
				updateProposalControls();
				monacoBridge.showNormal();
				await showPreview('original');
				setStatus('AI proposal rejected · Draft unchanged', 'saved');
				return result;
			},
			toggleExplorer(value) {
				controller.toggleExplorer(value);
			},
			async showSurface(value) {
				return queueSurfaceTransition(value);
			},
			async toggleSurface() {
				return queueSurfaceTransition();
			},
			dispose() {
				if (disposing) return;
				disposing = true;
				for (let record of pendingPreparedDraftRoutes) {
					try { record.prepared.rollback(); }
					catch (error) { Zotero.logError && Zotero.logError(error); }
					record.state = 'rolled-back';
				}
				pendingPreparedDraftRoutes.clear();
				unbindWorkspaceClick();
				openGate.dispose();
				documentManager?.invalidate();
				activeDocumentGeneration += 1;
				if (complianceTimer !== null) {
					view.clearTimeout(complianceTimer);
					complianceTimer = null;
				}
				controller.quiesce();
				detachMonacoInteraction && detachMonacoInteraction();
				detachMonacoInteraction = null;
				previewSurface.dispose();
				let finish = async () => {
					let timeoutID = null;
					try {
						await Promise.race([
							Zotero.QLab.flushQmdDraftBeforeTransition(activeSession, visualEditor),
							new Promise(resolve => {
								timeoutID = view.setTimeout(() => resolve(false), 1500);
							}),
						]);
					}
					catch (error) {
						Zotero.logError && Zotero.logError(error);
					}
					finally {
						if (timeoutID !== null) view.clearTimeout(timeoutID);
						documentManager?.dispose();
						controller.dispose();
					}
				};
				void finish();
				host._qlabQmdWorkspace = null;
			},
		};
		host._qlabQmdWorkspace = workspace;
		host._qlabSurfaceMode = controller.snapshot().surface;
		let explorerDocumentDelegate = Zotero.QLab.createQmdExplorerDocumentDelegate({
			root,
			route: input => {
				let windowController = view.Zotero_Tabs && view.Zotero_Tabs._qlab;
				if (!windowController || typeof windowController.openWorkspaceDocument !== 'function') {
					return Promise.resolve(Object.freeze({
						action: 'refuse', reason: 'workspace-document-router-unavailable',
					}));
				}
				return windowController.openWorkspaceDocument(input);
			},
			onResult: result => {
				if (result && result.action === 'refuse') {
					setPersistenceStatus('error', `Document could not be opened · ${result.reason}`);
				}
			},
			onError: error => setPersistenceStatus(
				'error', error && error.message || String(error)
			),
		});

		function onWorkspaceClick(event) {
			if (event.target.closest('[data-qlab-document-row]')) {
				void explorerDocumentDelegate(event);
				return;
			}
			let formalToggle = event.target.closest('[data-qlab-formal-toggle]');
			let formalMenu = host.querySelector('[data-qlab-formal-menu]');
			if (formalToggle && formalMenu
					&& Zotero.QLab.qmdSessionAllows(activeSession, 'insertFormalBlock')) {
				formalMenu.hidden = !formalMenu.hidden;
				formalToggle.setAttribute('aria-expanded', formalMenu.hidden ? 'false' : 'true');
				if (!formalMenu.hidden && typeof formalToggle.getBoundingClientRect === 'function') {
					let rect = formalToggle.getBoundingClientRect();
					formalMenu.style.left = `${Math.max(6, rect.right - 126)}px`;
					formalMenu.style.top = `${rect.bottom + 4}px`;
				}
			}
			let formalKind = event.target.closest('[data-qlab-formal-kind]');
			if (formalKind && Zotero.QLab.qmdSessionAllows(activeSession, 'insertFormalBlock')) {
				if (formalMenu) formalMenu.hidden = true;
				let toggle = host.querySelector('[data-qlab-formal-toggle]');
				if (toggle) toggle.setAttribute('aria-expanded', 'false');
				void workspace.insertFormalBlock(formalKind.dataset.qlabFormalKind);
			}
			else if (!event.target.closest('[data-qlab-visual-tools]') && formalMenu) {
				formalMenu.hidden = true;
				let toggle = host.querySelector('[data-qlab-formal-toggle]');
				if (toggle) toggle.setAttribute('aria-expanded', 'false');
			}
			let version = event.target.closest('[data-qlab-preview-version]');
			if (version && !version.disabled) void showPreview(version.dataset.qlabPreviewVersion);
			if (event.target.closest('[data-qlab-compliance]')
					&& Zotero.QLab.qmdSessionAllows(activeSession, 'edit')) void workspace.checkCompliance();
			if (event.target.closest('[data-qlab-add-to-knowledge]')
					&& Zotero.QLab.qmdSessionAllows(activeSession, 'promote')) void workspace.reviewForKnowledge();
			if (event.target.closest('[data-qlab-complete-todos]')
					&& Zotero.QLab.qmdSessionAllows(activeSession, 'completeTodos')) void workspace.completeTodos();
			if (event.target.closest('[data-qlab-external-editor]')
					&& Zotero.QLab.qmdSessionAllows(activeSession, 'externalEditor')) void workspace.openExternalEditor();
			if (event.target.closest('[data-qlab-refresh-surface]')) void workspace.refreshActiveSurface();
			if (event.target.closest('[data-qlab-bib-search]')) monacoBridge.showSearch();
			if (event.target.closest('[data-qlab-proposal-compare]')
					&& Zotero.QLab.qmdSessionAllows(activeSession, 'proposal')) void workspace.showProposalDiff();
			if (event.target.closest('[data-qlab-draft-reject]')
					&& Zotero.QLab.qmdSessionAllows(activeSession, 'keepReject')) void workspace.rejectProposal();
			if (event.target.closest('[data-qlab-preview-toggle]')
					&& Zotero.QLab.qmdSessionAllows(activeSession, 'surfaceNavigation')) void workspace.toggleSurface();
			if (event.target.closest('[data-qlab-preview-retry]')) void activePreview?.retry();
		}
		unbindWorkspaceClick = Zotero.QLab.bindDisposableQmdWorkspaceEvent(
			host,
			'click',
			onWorkspaceClick
		);

		applyLayout(controller.snapshot());
		if (!isCurrent()) {
			workspace.dispose();
			return null;
		}
		await watcher.start();
		if (!isCurrent()) {
			workspace.dispose();
			return null;
		}
		let firstPath = initialPath
			|| host.querySelector('[data-qlab-draft-row]')?.dataset.qlabDraftRow
			|| '';
		if (firstPath) await openDraft(firstPath);
		if (!isCurrent()) {
			workspace.dispose();
			return null;
		}
		return workspace;
	};
})();
