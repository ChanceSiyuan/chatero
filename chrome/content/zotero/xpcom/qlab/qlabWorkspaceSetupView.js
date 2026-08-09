/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Chance Siyuan / Chatero contributors

	This file is part of Chatero (a Zotero fork).

	***** END LICENSE BLOCK *****
*/

/**
 * Native, non-modal setup state for a Research Loop workspace.  This module
 * intentionally knows nothing about Zotero tabs: it owns presentation and the
 * initialization controller, while qlabModule only supplies a host/tab mount.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const SETUP_STEPS = Object.freeze([
		['verify-folder', 'Verify Folder'],
		['verify-starter', 'Verify Starter'],
		['add-missing-files', 'Add Missing Files'],
		['initialize-git', 'Initialize Git if Absent'],
		['verify-repository', 'Verify Repository'],
		['ready', 'Ready'],
	]);

	function escapeHTML(value) {
		return String(value || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function freezeArray(items) {
		return Object.freeze(items.map(item => Object.freeze({ ...item })));
	}

	function immutableSnapshot(value = {}) {
		let plan = value.plan && typeof value.plan === 'object'
			? Object.freeze({
				...value.plan,
				create: freezeArray(value.plan.create || []),
				preserve: freezeArray(value.plan.preserve || []),
				conflicts: freezeArray(value.plan.conflicts || []),
			})
			: null;
		let progress = value.progress && typeof value.progress === 'object'
			? Object.freeze({ ...value.progress })
			: null;
		return Object.freeze({
			state: String(value.state || 'missing'),
			repositoryState: String(value.repositoryState || value.state || 'missing'),
			root: String(value.root || ''),
			plan,
			progress,
			error: value.error ? String(value.error) : null,
		});
	}

	function action(id, label, tone = 'secondary') {
		return Object.freeze({ id, label, tone });
	}

	function planSections(plan) {
		let section = (title, records, empty) => Object.freeze({
			title,
			items: Object.freeze((records || []).map(record => Object.freeze({
				path: String(record.path || record || ''),
				kind: record.kind ? String(record.kind) : '',
				reason: record.reason ? String(record.reason) : '',
			}))),
			empty,
		});
		return Object.freeze([
			section('Will add', plan && plan.create, 'Nothing new'),
			section('Will preserve', plan && plan.preserve, 'Existing files stay unchanged'),
			section('Needs attention', plan && plan.conflicts, 'No conflicts found'),
		]);
	}

	/**
	 * Convert a controller snapshot into a presentation-only model.  In
	 * particular, incompatible roots never receive an Initialize action.
	 */
	Zotero.QLab.workspaceSetupPresentation = function (input = {}) {
		let snapshot = immutableSnapshot(input);
		let state = snapshot.state;
		let repositoryState = snapshot.repositoryState;
		let title = 'Research Loop workspace';
		let message = '';
		let actions = [];
		if (state === 'review') {
			title = repositoryState === 'partial'
				? 'Complete this Research Loop workspace'
				: 'Create a Research Loop workspace';
			message = 'Review exactly what Chatero will add. Existing files will not be changed.';
			actions = [action('initialize', 'Initialize', 'primary'), action('choose', 'Choose Another Folder'), action('reveal', 'Reveal in Finder')];
		}
		else if (state === 'initializing') {
			title = 'Setting up Research Loop';
			message = 'Setup continues safely in the background if you close this tab.';
			actions = [action('reveal', 'Reveal in Finder')];
		}
		else if (state === 'incompatible' || repositoryState === 'incompatible') {
			title = 'This folder cannot be initialized';
			message = 'It contains files or links that are not a safe partial Research Loop workspace.';
			actions = [action('choose', 'Choose Another Folder', 'primary'), action('reveal', 'Reveal in Finder')];
		}
		else if (state === 'ready' || repositoryState === 'ready') {
			title = 'Research Loop workspace ready';
			message = 'This repository is ready to use. Open the QMD Editor to start with the example draft.';
			actions = [action('open', 'Open QMD Editor', 'primary'), action('choose', 'Choose Another Folder'), action('reveal', 'Reveal in Finder')];
		}
		else if (state === 'failed') {
			title = 'Setup needs attention';
			message = snapshot.error || 'The folder changed or setup could not finish.';
			actions = [action('review', 'Review Setup', 'primary'), action('choose', 'Choose Another Folder'), action('reveal', 'Reveal in Finder')];
		}
		else if (state === 'empty' || repositoryState === 'empty') {
			title = 'Create a Research Loop workspace';
			message = 'This empty folder can receive the public Research Loop starter.';
			actions = [action('review', 'Review Setup', 'primary'), action('choose', 'Choose Another Folder')];
		}
		else if (state === 'partial' || repositoryState === 'partial') {
			title = 'Complete this Research Loop workspace';
			message = 'Your existing Knowledge, Drafts, and Literature files will be preserved.';
			actions = [action('review', 'Review Setup', 'primary'), action('choose', 'Choose Another Folder')];
		}
		else {
			title = 'Choose a Research Loop folder';
			message = 'Choose an empty folder or a folder containing only Knowledge, Drafts, or Literature.';
			actions = [action('choose', 'Choose Workspace', 'primary')];
		}
		return Object.freeze({
			state,
			repositoryState,
			root: snapshot.root,
			title,
			message,
			actions: Object.freeze(actions),
			sections: state === 'review' ? planSections(snapshot.plan) : Object.freeze([]),
			steps: Object.freeze(SETUP_STEPS.map(([id, label]) => Object.freeze({
				id,
				label,
				active: snapshot.progress && snapshot.progress.step === id,
			}))),
			diagnostics: Object.freeze({
				root: snapshot.root,
				state,
				repositoryState,
				error: snapshot.error,
				progress: snapshot.progress && snapshot.progress.step || null,
			}),
		});
	};

	function defaultSetupOptions(options) {
		let host = options.host || (Zotero.QLab.createGeckoQLabInitializerHost
			&& Zotero.QLab.createGeckoQLabInitializerHost());
		let reader = options.assetReader || (Zotero.QLab.createGeckoQLabStarterAssetReader
			&& Zotero.QLab.createGeckoQLabStarterAssetReader({
				manifestURI: 'resource://zotero/chatero/qlab-starter/manifest.json',
				archiveURI: 'resource://zotero/chatero/qlab-starter/research-loop-starter.zip',
			}));
		return {
			host,
			inspect: options.inspect || ((root) => Zotero.QLab.inspectQLabRepository(root, host)),
			readManifest: options.readManifest || (() => reader.readManifest()),
			plan: options.plan || ((value) => Zotero.QLab.planQLabStarterInstall({ ...value, host })),
			initializer: options.initializer || (Zotero.QLab.createGeckoQLabRepositoryInitializer
				&& Zotero.QLab.createGeckoQLabRepositoryInitializer({ host, assetReader: reader })),
			canActivate: options.canActivate || (() => ({ ok: true })),
			onActivate: options.onActivate || (async () => {}),
			onChange: options.onChange || (() => {}),
			reveal: options.reveal || (async () => false),
		};
	}

	/**
	 * State machine for a single selected root. It has no cancel operation by
	 * design: disposing a view only stops its listener, never setup writes.
	 */
	Zotero.QLab.createQLabWorkspaceSetupController = function (options = {}) {
		let deps = defaultSetupOptions(options);
		let snapshot = immutableSnapshot({});
		let disposed = false;
		let listeners = new Set();
		let initialization = null;

		function notify() {
			if (disposed) return;
			for (let listener of listeners) {
				try { listener(snapshot); }
				catch (error) { Zotero.logError && Zotero.logError(error); }
			}
			try { deps.onChange(snapshot); }
			catch (error) { Zotero.logError && Zotero.logError(error); }
		}

		function update(next) {
			snapshot = immutableSnapshot({ ...snapshot, ...next });
			notify();
			return snapshot;
		}

		async function review(root = snapshot.root) {
			if (!root) return update({ state: 'missing', repositoryState: 'missing', plan: null, error: null });
			try {
				let inspection = await deps.inspect(root);
				if (!inspection || !inspection.root) throw new Error('Unable to inspect the selected folder');
				let repositoryState = inspection.state;
				if (repositoryState === 'incompatible' || repositoryState === 'missing' || repositoryState === 'ready') {
					return update({ state: repositoryState, repositoryState, root: inspection.root, plan: null, progress: null, error: null });
				}
				if (repositoryState !== 'empty' && repositoryState !== 'partial') {
					throw new Error('The selected folder is not available for safe setup');
				}
				let manifest = await deps.readManifest();
				let plan = await deps.plan({ root: inspection.root, inspection, manifest });
				if (!plan || plan.conflicts && plan.conflicts.length) {
					return update({ state: 'incompatible', repositoryState: 'incompatible', root: inspection.root, plan: null, progress: null, error: null });
				}
				return update({ state: 'review', repositoryState, root: inspection.root, plan, progress: null, error: null });
			}
			catch (error) {
				return update({ state: 'failed', root, plan: null, progress: null, error: error && error.message || String(error) });
			}
		}

		return Object.freeze({
			snapshot: () => snapshot,
			presentation: () => Zotero.QLab.workspaceSetupPresentation(snapshot),
			subscribe(listener) {
				if (typeof listener !== 'function') return () => {};
				listeners.add(listener);
				listener(snapshot);
				return () => listeners.delete(listener);
			},
			choose(root) { return review(root); },
			review() { return review(snapshot.root); },
			reportError(error) {
				return update({ state: 'failed', error: error && error.message || String(error || 'Setup needs attention') });
			},
			// Resumption must be confirmed through a new review; no write is made here.
			resume(root) { return review(root || snapshot.root); },
			async initialize() {
				if (initialization) return initialization;
				if (snapshot.state !== 'review' || !snapshot.plan) return snapshot;
				let allowed = await deps.canActivate(snapshot);
				if (!allowed || allowed.ok === false) {
					return update({ state: 'failed', error: allowed && allowed.reason || 'Finish current work before switching workspace' });
				}
				if (!deps.initializer || typeof deps.initializer.execute !== 'function') {
					return update({ state: 'failed', error: 'Workspace initialization is unavailable' });
				}
				let plan = snapshot.plan;
				update({ state: 'initializing', progress: null, error: null });
				initialization = Promise.resolve(deps.initializer.execute(plan, progress => {
					update({ state: 'initializing', progress: progress || null });
				}))
					.then(async result => {
						if (!result || result.state !== 'ready') throw new Error('Workspace setup did not complete');
						await deps.onActivate(result, snapshot);
						return update({ state: 'ready', repositoryState: 'ready', root: result.root || plan.root, plan: null, progress: { step: 'ready' }, error: null });
					})
					.catch(error => update({ state: 'failed', progress: null, error: error && error.message || String(error) }))
					.finally(() => { initialization = null; });
				return initialization;
			},
			async reveal() { return deps.reveal(snapshot.root); },
			copyDiagnostics() { return JSON.stringify(Zotero.QLab.workspaceSetupPresentation(snapshot).diagnostics, null, 2); },
			dispose() { disposed = true; listeners.clear(); },
		});
	};

	/**
	 * Window-independent setup coordination. Native tabs supply a few small
	 * callbacks; this module owns switching guards, controller reuse, epochs,
	 * and the post-initialization sequence.
	 */
	Zotero.QLab.createQLabWorkspaceSetupCoordinator = function (options = {}) {
		let controllers = new Map();
		let targetEpoch = 0;
		let activeRepositoryIdentity = null;
		let hosts = typeof options.hosts === 'function' ? options.hosts : () => [];
		let showSetupTab = typeof options.showSetupTab === 'function' ? options.showSetupTab : () => null;
		let activateRepository = typeof options.activateRepository === 'function'
			? options.activateRepository
			: async result => result.root;
		let refreshTargets = typeof options.refreshTargets === 'function' ? options.refreshTargets : async () => {};
		let openReadyTabs = typeof options.openReadyTabs === 'function' ? options.openReadyTabs : () => {};
		let reveal = typeof options.reveal === 'function' ? options.reveal : async () => false;

		function workspaceSwitchBlocker() {
			for (let host of hosts() || []) {
				if (host._qlabTurnHandle) {
					return { ok: false, reason: 'An AI turn is still running. Finish or stop it before switching workspace.' };
				}
				if (host._qlabDirty && host._qlabSurfaceMode === 'visual') {
					return { ok: false, reason: 'A Visual Edit buffer has unsaved changes. Save it before switching workspace.' };
				}
				if (host._qlabDraftState?.workingPath) {
					return { ok: false, reason: 'An AI proposal is waiting for Keep or Reject. Resolve it before switching workspace.' };
				}
			}
			return { ok: true };
		}

		async function activateInitializedWorkspace(result) {
			let blocker = workspaceSwitchBlocker();
			if (!blocker.ok) throw new Error(blocker.reason);
			if (!result || !result.root) throw new Error('Initialized workspace is missing its root');
			let root = await activateRepository(result);
			activeRepositoryIdentity = result.repositoryIdentity || null;
			targetEpoch += 1;
			await refreshTargets(targetEpoch);
			await openReadyTabs({ root, repositoryIdentity: activeRepositoryIdentity, targetEpoch });
			return Object.freeze({ root, repositoryIdentity: activeRepositoryIdentity, targetEpoch });
		}

		function get(root) {
			let key = String(root || '');
			let existing = controllers.get(key);
			if (existing) return existing;
			let controller = Zotero.QLab.createQLabWorkspaceSetupController({
				canActivate: workspaceSwitchBlocker,
				onActivate: activateInitializedWorkspace,
				reveal,
			});
			controllers.set(key, controller);
			return controller;
		}

		return Object.freeze({
			get,
			workspaceSwitchBlocker,
			get targetEpoch() { return targetEpoch; },
			get activeRepositoryIdentity() { return activeRepositoryIdentity; },
			async open(root, inspection = null) {
				let controller = get(root);
				if (!inspection || controller.snapshot().root !== root) await controller.choose(root);
				return showSetupTab(root);
			},
			activateInitializedWorkspace,
			dispose() {
				for (let controller of controllers.values()) controller.dispose();
				controllers.clear();
			},
		});
	};

	function setHTML(element, html) {
		if (!element) return;
		let doc = element.ownerDocument;
		let Parser = doc.defaultView && doc.defaultView.DOMParser;
		if (!Parser) return;
		let parsed = new Parser().parseFromString(html, 'text/html');
		let fragment = doc.createDocumentFragment();
		for (let child of Array.from(parsed.body.childNodes)) fragment.appendChild(doc.importNode(child, true));
		element.replaceChildren(fragment);
	}

	function icon(name) {
		let paths = name === 'folder'
			? '<path d="M3 7h7l2-2h9v13H3z"/><path d="M3 7V5h7l2 2"/>'
			: name === 'reveal'
				? '<path d="M14 3h7v7M21 3l-9 9"/><path d="M19 13v6H5V5h6"/>'
				: '<path d="M5 12l4 4L19 6"/>';
		return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8">${paths}</svg>`;
	}

	Zotero.QLab.renderQLabWorkspaceSetupHTML = function (presentation) {
		let actions = presentation.actions.map(item => `<button type="button" data-qlab-setup-action="${escapeHTML(item.id)}" class="qlab-setup-action is-${escapeHTML(item.tone)}">${item.id === 'choose' ? icon('folder') : item.id === 'reveal' ? icon('reveal') : icon('ready')}<span>${escapeHTML(item.label)}</span></button>`).join('');
		let root = presentation.root ? `<code class="qlab-setup-root">${escapeHTML(presentation.root)}</code>` : '';
		let sections = presentation.sections.map(section => `<section class="qlab-setup-plan-section"><h2>${escapeHTML(section.title)}</h2>${section.items.length ? `<ul>${section.items.map(item => `<li><code>${escapeHTML(item.path)}</code>${item.reason ? ` <span>${escapeHTML(item.reason)}</span>` : ''}</li>`).join('')}</ul>` : `<p>${escapeHTML(section.empty)}</p>`}</section>`).join('');
		let steps = presentation.state === 'initializing'
			? `<ol class="qlab-setup-steps">${presentation.steps.map(step => `<li class="${step.active ? 'is-active' : ''}">${escapeHTML(step.label)}</li>`).join('')}</ol>`
			: '';
		return `<main class="qlab-setup" data-qlab-setup-state="${escapeHTML(presentation.state)}"><div class="qlab-setup-card"><div class="qlab-setup-mark">R</div><p class="qlab-setup-kicker">Research Loop</p><h1>${escapeHTML(presentation.title)}</h1><p class="qlab-setup-message">${escapeHTML(presentation.message)}</p>${root}${sections}${steps}<p class="qlab-setup-error" ${presentation.state === 'failed' ? '' : 'hidden'}>${escapeHTML(presentation.diagnostics.error || '')}</p><div class="qlab-setup-actions">${actions}</div><div class="qlab-setup-links"><button type="button" data-qlab-setup-copy>Copy Diagnostics</button></div></div></main>`;
	};

	Zotero.QLab.mountQLabWorkspaceSetupView = function (container, { controller, choose, openEditor, clipboard } = {}) {
		if (!container || !controller) return null;
		let host = container.querySelector('.qlab-workspace-setup-host');
		if (!host) {
			host = container.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml', 'div');
			host.className = 'qlab-workspace-setup-host';
			container.replaceChildren(host);
		}
		let render = () => {
			let presentation = controller.presentation();
			setHTML(host, Zotero.QLab.renderQLabWorkspaceSetupHTML(presentation));
			let announcer = container.ownerDocument.getElementById('qlab-workspace-setup-announcer');
			if (announcer) announcer.textContent = `${presentation.title}. ${presentation.message}`;
		};
		let unsubscribe = controller.subscribe(render);
		let onClick = async event => {
			let action = event.target.closest('[data-qlab-setup-action]');
			if (action) {
				let id = action.dataset.qlabSetupAction;
				if (id === 'choose' && typeof choose === 'function') {
					let root = await choose();
					if (root) await controller.choose(root);
				}
				else if (id === 'review') await controller.review();
				else if (id === 'initialize') await controller.initialize();
				else if (id === 'reveal') await controller.reveal();
				else if (id === 'open' && typeof openEditor === 'function') openEditor();
				return;
			}
			if (event.target.closest('[data-qlab-setup-copy]')) {
				let text = controller.copyDiagnostics();
				try { await (clipboard || container.ownerDocument.defaultView.navigator.clipboard).writeText(text); }
				catch (error) { Zotero.logError && Zotero.logError(error); }
			}
		};
		host.addEventListener('click', onClick);
		return Object.freeze({
			dispose() { host.removeEventListener('click', onClick); unsubscribe(); },
			controller,
		});
	};
})();
