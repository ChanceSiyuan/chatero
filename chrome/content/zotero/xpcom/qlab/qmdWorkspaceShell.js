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
		};
		return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.preview}</svg>`;
	}

	function iconButton(name, label, attribute, { disabled = false, l10nId = '', pressed = null } = {}) {
		return `<button type="button" class="qlab-qmd-workspace-action" ${attribute} `
			+ `${l10nId ? `data-l10n-id="${escapeHTML(l10nId)}" ` : ''}`
			+ `${pressed === null ? '' : `aria-pressed="${pressed ? 'true' : 'false'}" `}`
			+ `title="${escapeHTML(label)}" aria-label="${escapeHTML(label)}"${disabled ? ' disabled' : ''}>`
			+ `${icon(name)}<span class="sr-only">${escapeHTML(label)}</span></button>`;
	}

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
			showEmpty(message = 'Select a Draft to preview it.') {
				if (disposed) return;
				if (quick) quick.hidden = true;
				if (browser) browser.hidden = true;
				if (browserHost) browserHost.hidden = true;
				if (empty) {
					empty.textContent = message;
					empty.hidden = false;
				}
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
		return { mode: 'empty', status: 'Select a Draft', tone: 'idle' };
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
		let attribute = isDraft
			? `data-qlab-draft-row="${escapeHTML(node.path)}"`
			: `data-qlab-context-path="${escapeHTML(node.path)}"`;
		let readonly = isDraft ? '' : ' aria-readonly="true"';
		return `<button type="button" class="qlab-qmd-explorer-file is-${escapeHTML(node.kind)}" `
			+ `${attribute}${readonly} title="${escapeHTML(node.path)}">`
			+ `<span class="qlab-qmd-file-icon" aria-hidden="true">${node.kind === 'qmd' ? 'Q' : node.kind === 'bib' ? '@' : '•'}</span>`
			+ `<span>${escapeHTML(node.name)}</span></button>`;
	}

	Zotero.QLab.renderQmdExplorerHTML = function (explorer = []) {
		let roots = explorer.length ? explorer : rootFromDrafts([]);
		return roots.map(root => treeNodeHTML(root)).join('');
	};

	Zotero.QLab.renderQmdWorkspaceHTML = function ({
		path = '',
		explorer = [],
		drafts = [],
		status = 'ready',
		proposal = false,
	} = {}) {
		let tree = explorer.length ? explorer : rootFromDrafts(drafts);
		let label = path || 'No Draft selected';
		let initialSurface = 'visual';
		let accessibility = Zotero.QLab.qmdWorkspaceAccessibilityModel({ proposal, surface: initialSurface });
		let actions = accessibility.actions;
		let options = drafts.map(draft => (
			`<option value="${escapeHTML(draft)}">${escapeHTML(draft)}</option>`
		)).join('');
		return [
			`<div class="qlab-shell qlab-shell-qmd qlab-qmd-workspace" data-qlab-kind="qlabqmd" data-status="${escapeHTML(status)}">`,
			`<header class="qlab-qmd-toolbar">`,
			iconButton('folder', actions.explorer.label, 'data-qlab-files-toggle', {
				l10nId: actions.explorer.l10nId,
			}),
			iconButton('preview', actions.preview.label,
				`data-qlab-preview-toggle data-qlab-current-surface="${initialSurface}"`, {
				l10nId: actions.preview.l10nId,
			}),
			`<div class="qlab-qmd-path-wrap"><span class="qlab-qmd-tree-badge">Draft</span>`,
			`<strong class="qlab-qmd-path" data-qlab-draft-path>${escapeHTML(label)}</strong></div>`,
			`<div class="qlab-qmd-toolbar-actions" role="toolbar" aria-label="QMD actions">`,
			iconButton('compliance', actions.compliance.label,
				'data-qlab-compliance data-qlab-qmd-action="check-compliance"'),
			iconButton('promote', actions.promote.label,
				'data-qlab-add-to-knowledge data-qlab-qmd-action="add-to-knowledge"'),
			iconButton('todos', actions.todos.label,
				'data-qlab-complete-todos data-qlab-qmd-action="complete-todos"'),
			iconButton('save', actions.save.label, 'data-qlab-draft-save', { l10nId: actions.save.l10nId }),
			iconButton('ai', actions.ai.label, 'data-qlab-draft-ai', { l10nId: actions.ai.l10nId }),
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
			+ `data-qlab-formal-menu hidden role="group" `
			+ `aria-label="Formal QMD block">`,
			`<button type="button" data-qlab-formal-kind="def">Definition</button>`,
			`<button type="button" data-qlab-formal-kind="lem">Lemma</button>`,
			`<button type="button" data-qlab-formal-kind="thm">Theorem</button>`,
			`<button type="button" data-qlab-formal-kind="proof">Proof</button>`,
			`</div></div>`,
			iconButton('cursor', actions.external.label,
				'data-qlab-external-editor data-qlab-qmd-action="open-external-editor"'),
			iconButton('reload', actions.refresh.label,
				'data-qlab-refresh-surface data-qlab-qmd-action="refresh-surface"'),
			`</div></header>`,
			`<output class="qlab-qmd-compliance-details" data-qlab-compliance-details hidden `
			+ `aria-live="polite"></output>`,
			`<div class="qlab-qmd-inline" data-qlab-inline hidden>`,
			`<input type="text" data-qlab-inline-prompt placeholder="Describe a focused QMD edit…"/>`,
			`<button type="button" data-qlab-inline-run>Write</button>`,
			`<button type="button" data-qlab-inline-stop hidden>Stop</button>`,
			`<button type="button" data-qlab-inline-cancel>Cancel</button></div>`,
			`<div class="qlab-qmd-workspace-main">`,
			`<aside class="qlab-qmd-explorer" data-qlab-file-column aria-label="QLab Explorer">`,
			`<div class="qlab-qmd-pane-title"><span data-l10n-id="qlab-qmd-explorer">QLAB EXPLORER</span></div>`,
			`<div class="qlab-qmd-explorer-tree" data-qlab-qmd-explorer>${Zotero.QLab.renderQmdExplorerHTML(tree)}</div>`,
			`<label class="qlab-qmd-select-fallback">Draft<select data-qlab-draft>`
			+ `<option value="">Select…</option>${options}</select></label></aside>`,
			`<main class="qlab-qmd-primary-surface" data-qlab-primary-surface data-surface="visual">`,
			`<section class="qlab-qmd-visual-pane is-active" data-qlab-visual-surface data-qlab-surface="visual" `
			+ `aria-label="Visual QMD editor">`,
			`<div class="qlab-qmd-pane-title"><span>VISUAL EDIT</span></div>`,
			`<div class="qlab-qmd-visual-editor" data-qlab-visual-editor-root `
			+ `aria-label="Visual QMD editor"></div></section>`,
			`<section class="qlab-qmd-editor-pane" data-qlab-source-surface data-qlab-surface="source" `
			+ `aria-label="Monaco QMD source editor" hidden>`,
			`<div class="qlab-qmd-pane-title qlab-qmd-editor-tab"><span class="qlab-qmd-tab-q">Q</span>`
			+ `<span data-qlab-editor-tab>${escapeHTML(label)}</span><i data-qlab-dirty-dot hidden></i></div>`,
			`<iframe class="qlab-qmd-monaco-frame" data-qlab-qmd-monaco `
			+ `src="chrome://zotero/content/qlab/qmdMonaco.html" title="QMD source editor"></iframe>`,
			`<textarea data-qlab-editor hidden aria-hidden="true"></textarea></section>`,
			`<section class="qlab-qmd-preview-pane" data-qlab-qmd-preview data-qlab-preview-surface `
			+ `data-qlab-surface="website" `
			+ `aria-label="Quarto Preview" hidden>`,
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
			`<div class="qlab-qmd-preview-empty" data-qlab-preview-empty>Select a Draft to preview it.</div>`,
			`</div>`,
			`</section></main></div>`,
			`<footer class="qlab-qmd-workspace-status">`,
			`<span class="qlab-shell-status" data-qlab-qmd-status role="status" aria-live="polite">${escapeHTML(status)}</span>`,
			`<span class="qlab-qmd-authority">Human edits autosave · AI changes require Keep</span>`,
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
		function disposeResource(name) {
			if (resources[name] && typeof resources[name].dispose === 'function') {
				resources[name].dispose();
			}
			resources[name] = null;
		}
		return {
			setResources(next = {}) {
				if (!canMutate()) return false;
				for (let name of ['visual', 'preview', 'session']) {
					if (Object.prototype.hasOwnProperty.call(next, name) && resources[name] !== next[name]) {
						disposeResource(name);
						resources[name] = next[name];
					}
				}
				return true;
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
				for (let name of ['watcher', 'monaco', 'visual', 'preview', 'session']) disposeResource(name);
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
			if (!session) return { source: '', revision: '' };
			let snapshot = session.snapshot();
			return {
				source: String(snapshot && snapshot.text || ''),
				revision: String(snapshot && snapshot.revision || ''),
			};
		}

		return {
			setSession(nextSession) {
				session = nextSession || null;
				generation += 1;
				visual.setDocument(currentDocument(), !!session, generation);
				return generation;
			},
			sync({ force = false } = {}) {
				if (!session || (!force && visual.isEditing && visual.isEditing())) return false;
				visual.setDocument(currentDocument(), true, generation);
				return true;
			},
			async save(nextSource, expectedRevision, saveGeneration) {
				if (!session || saveGeneration !== generation) {
					throw new Error('The Visual Edit document changed before save');
				}
				let saveSession = session;
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
				let saved = await saveSession.saveNow();
				if (saveGeneration !== generation) {
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

	function joinRoot(root, relativePath) {
		return `${String(root || '').replace(/[\\/]+$/, '')}/${String(relativePath || '').replace(/^[\\/]+/, '')}`;
	}

	function findNode(nodes, path) {
		for (let node of nodes || []) {
			if (node.path === path) return node;
			let found = findNode(node.children, path);
			if (found) return found;
		}
		return null;
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
		isCurrent = () => true,
	} = {}) {
		if (!host || !root || !isCurrent()) return null;
		if (host._qlabQmdWorkspace) return host._qlabQmdWorkspace;
		let document = host.ownerDocument;
		let view = document.defaultView;
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
		let openGate = Zotero.QLab.createQmdLatestRequestGate();
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

		try {
			let bibPath = joinRoot(root, 'literature/ref.bib');
			if (await ioHost.exists(bibPath)) bibliographyText = await ioHost.read(bibPath);
		}
		catch (error) {
			Zotero.logError && Zotero.logError(error);
		}
		if (!isCurrent()) {
			previewSurface.dispose();
			visualEditor.dispose?.();
			return null;
		}

		let sessionProxy = {
			applyHumanEdit(text) {
				if (activeSession) activeSession.applyHumanEdit(text);
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
				if (command === 'save') void workspace.saveNow();
				if (command === 'ai') {
					host._qlabMonacoSelection = {
						start: Number(event.start) || 0,
						end: Number(event.end) || 0,
						text: String(event.selection || ''),
					};
					Zotero.QLab.toggleQmdInlineBar(host, true);
				}
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
			if (!activePath || typeof Zotero.QLab.runQmdCompliance !== 'function') return null;
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
				for (let row of host.querySelectorAll('[data-qlab-draft-row]')) {
					row.classList.toggle('is-active', row.dataset.qlabDraftRow === activePath);
				}
				if (activeSession && findNode(snapshot, activePath)) {
					try {
						let observedSession = activeSession;
						let observedPath = activePath;
						let disk = await Zotero.QLab.QmdDraftIO.readSource(root, observedPath, ioHost);
						if (activeSession === observedSession && activePath === observedPath) {
							observedSession.observeDisk(disk);
						}
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
			onLayout: applyLayout,
			explorerVisible: !layout || layout.explorerVisible !== false,
			surface: layout && layout.surface,
			previewVisible: layout && layout.previewVisible,
			versionTarget: layout && layout.versionTarget,
		});

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

		function queueSurfaceTransition(value) {
			let run = () => Zotero.QLab.transitionQmdWorkspaceSurface(
				controller, visualEditor, value
			);
			let operation = surfaceTransition.catch(() => false).then(run);
			surfaceTransition = operation;
			return operation;
		}

		async function openDraft(relativePath) {
			if (!Zotero.QLab.isSafeWorkspaceRelativePath(relativePath, { under: 'drafts' })) return;
			let request = openGate.begin();
			try {
				if (!await Zotero.QLab.flushQmdDraftBeforeTransition(activeSession, visualEditor)) {
					return false;
				}
			}
			catch (error) {
				setPersistenceStatus('error', error && error.message || String(error));
				return false;
			}
			if (!request.isCurrent()) return false;
			if (activeSession && activePath === relativePath) return true;
			let doc = await Zotero.QLab.QmdDraftIO.readSource(root, relativePath, ioHost);
			if (!request.isCurrent()) return false;
			let nextProposal = null;
			let found = await Zotero.QLab.QmdDraftIO.findProposal(root, relativePath, ioHost);
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
			visualBridge.setSession(session);
			if (proposal) session.attachProposal(proposal.state);
			activePreview = preview;
			controller.setResources({ preview, session });
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
				tabs.setTabData(host._qlabMountTabID, { draftPath: relativePath });
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
			previewVersion = 'original';
			controller.showVersionTarget('original');
			monacoBridge.showNormal();
			setPersistenceStatus(proposal ? 'proposal' : 'saved');
			void preview.start();
			scheduleCompliance(0);
			return true;
		}

		async function runComplianceAction() {
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
			if (!await Zotero.QLab.flushQmdDraftBeforeTransition(activeSession, visualEditor)) {
				return false;
			}
			let surface = controller.snapshot().surface;
			if (surface === 'website') {
				await activePreview?.retry();
			}
			else if (surface === 'source') {
				monacoBridge.showNormal();
			}
			else {
				visualBridge.sync({ force: true });
			}
			setPersistenceStatus(proposal ? 'proposal' : 'saved');
			return true;
		}

		async function openExternalEditor() {
			try {
				if (!activePath) throw new Error('Open a Draft first');
				if (!await Zotero.QLab.flushQmdDraftBeforeTransition(activeSession, visualEditor)) {
					return false;
				}
				let runtime = Zotero.QLab.createQmdExternalEditorRuntime();
				if (!externalEditorsPromise) {
					externalEditorsPromise = Zotero.QLab.installedQmdEditors(runtime);
				}
				let installed = await externalEditorsPromise;
				let remembered = '';
				try {
					remembered = String(Zotero.Prefs.get('qlab.qmdExternalEditor') || 'cursor');
				}
				catch (e) {}
				let editor = Zotero.QLab.preferredQmdEditor(installed, remembered);
				if (!editor) throw new Error('Install Cursor or another supported editor first');
				await Zotero.QLab.openQmdInExternalEditor(runtime, editor, root, activePath);
				try {
					Zotero.Prefs.set('qlab.qmdExternalEditor', editor.id);
				}
				catch (e) {}
				setStatus(`Opened ${activePath} in ${editor.label}`, 'saved');
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
			refreshExplorer: () => watcher.poll(),
			checkCompliance: runComplianceAction,
			reviewForKnowledge: runDraftReview,
			completeTodos: runTodoCompletion,
			insertFormalBlock,
			openExternalEditor,
			refreshActiveSurface,
			saveNow: () => activeSession ? activeSession.saveNow() : Promise.resolve(null),
			setBuffer(text, { human = true } = {}) {
				if (!activeSession) return;
				if (human) activeSession.applyHumanEdit(text);
				monacoBridge.showNormal();
			},
			async attachProposal(state, proposedText, baseText = '') {
				if (!activeSession || !Zotero.QLab.qmdProposalBelongsToDraft(state, activePath)) {
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
				if (!proposal || !activeSession) return;
				if (!await queueSurfaceTransition('source')) return;
				controller.showVersionTarget('proposed');
				monacoBridge.showDiff({ original: activeSession.snapshot().text, proposed: proposal.proposed });
			},
			async showSource() {
				if (!await queueSurfaceTransition('source')) return false;
				monacoBridge.showNormal();
				return true;
			},
			showPreview,
			async keepProposal() {
				if (!proposal) throw new Error('No AI proposal to Keep');
				if (!await Zotero.QLab.flushQmdDraftBeforeTransition(activeSession, visualEditor)) {
					return { kept: false, blocked: true };
				}
				let keepGeneration = activeDocumentGeneration;
				let keepProposal = proposal;
				let result = await Zotero.QLab.QmdDraftIO.keepChange(root, keepProposal.state, ioHost);
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
				unbindWorkspaceClick();
				openGate.dispose();
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
						controller.dispose();
					}
				};
				void finish();
				host._qlabQmdWorkspace = null;
			},
		};
		host._qlabQmdWorkspace = workspace;
		host._qlabSurfaceMode = controller.snapshot().surface;

		function onWorkspaceClick(event) {
			let formalToggle = event.target.closest('[data-qlab-formal-toggle]');
			let formalMenu = host.querySelector('[data-qlab-formal-menu]');
			if (formalToggle && formalMenu) {
				formalMenu.hidden = !formalMenu.hidden;
				formalToggle.setAttribute('aria-expanded', formalMenu.hidden ? 'false' : 'true');
				if (!formalMenu.hidden && typeof formalToggle.getBoundingClientRect === 'function') {
					let rect = formalToggle.getBoundingClientRect();
					formalMenu.style.left = `${Math.max(6, rect.right - 126)}px`;
					formalMenu.style.top = `${rect.bottom + 4}px`;
				}
			}
			let formalKind = event.target.closest('[data-qlab-formal-kind]');
			if (formalKind) {
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
			if (event.target.closest('[data-qlab-compliance]')) void workspace.checkCompliance();
			if (event.target.closest('[data-qlab-add-to-knowledge]')) void workspace.reviewForKnowledge();
			if (event.target.closest('[data-qlab-complete-todos]')) void workspace.completeTodos();
			if (event.target.closest('[data-qlab-external-editor]')) void workspace.openExternalEditor();
			if (event.target.closest('[data-qlab-refresh-surface]')) void workspace.refreshActiveSurface();
			if (event.target.closest('[data-qlab-proposal-compare]')) void workspace.showProposalDiff();
			if (event.target.closest('[data-qlab-draft-reject]')) void workspace.rejectProposal();
			if (event.target.closest('[data-qlab-preview-toggle]')) void workspace.toggleSurface();
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
