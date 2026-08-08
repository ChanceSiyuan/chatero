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
		let paths = {
			folder: '<path d="M3 6.5h6l1.6 2H21v9.5H3z"/><path d="M3 6.5V5h6l1.6 2"/>',
			reload: '<path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-1.8 6.7"/>',
			save: '<path d="M5 3h12l3 3v15H4V3z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
			ai: '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
			diff: '<path d="M7 3v18M17 3v18M4 7h6M14 17h6"/>',
			keep: '<path d="M5 12l4 4L19 6"/>',
			reject: '<path d="M6 6l12 12M18 6L6 18"/>',
			preview: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/>',
		};
		return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.preview}</svg>`;
	}

	function iconButton(name, label, attribute, { disabled = false, l10nId = '' } = {}) {
		return `<button type="button" class="qlab-qmd-workspace-action" ${attribute} `
			+ `${l10nId ? `data-l10n-id="${escapeHTML(l10nId)}" ` : ''}`
			+ `title="${escapeHTML(label)}" aria-label="${escapeHTML(label)}"${disabled ? ' disabled' : ''}>`
			+ `${icon(name)}<span class="sr-only">${escapeHTML(label)}</span></button>`;
	}

	Zotero.QLab.qmdWorkspaceAccessibilityModel = function ({
		proposal = false,
		previewStatus = 'ready',
		conflict = false,
	} = {}) {
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
				ai: { label: 'Edit with AI', l10nId: 'qlab-qmd-edit-ai' },
				compare: { label: 'Compare AI changes', l10nId: 'qlab-qmd-compare' },
				keep: { label: 'Keep AI changes', l10nId: 'qlab-qmd-keep' },
				reject: { label: 'Reject AI changes', l10nId: 'qlab-qmd-reject' },
			},
			splitter: {
				role: 'separator',
				label: 'Resize source editor and Preview',
				l10nId: 'qlab-qmd-resize',
			},
			status,
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
		let accessibility = Zotero.QLab.qmdWorkspaceAccessibilityModel({ proposal });
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
			`<div class="qlab-qmd-path-wrap"><span class="qlab-qmd-tree-badge">Draft</span>`,
			`<strong class="qlab-qmd-path" data-qlab-draft-path>${escapeHTML(label)}</strong></div>`,
			`<div class="qlab-qmd-toolbar-actions" role="toolbar" aria-label="QMD actions">`,
			iconButton('reload', actions.reload.label, 'data-qlab-draft-reload', { l10nId: actions.reload.l10nId }),
			iconButton('save', actions.save.label, 'data-qlab-draft-save', { l10nId: actions.save.l10nId }),
			iconButton('ai', actions.ai.label, 'data-qlab-draft-ai', { l10nId: actions.ai.l10nId }),
			iconButton('diff', actions.compare.label, 'data-qlab-proposal-compare', {
				disabled: !proposal,
				l10nId: actions.compare.l10nId,
			}),
			iconButton('keep', actions.keep.label, 'data-qlab-draft-keep', {
				disabled: !proposal,
				l10nId: actions.keep.l10nId,
			}),
			iconButton('reject', actions.reject.label, 'data-qlab-draft-reject', {
				disabled: !proposal,
				l10nId: actions.reject.l10nId,
			}),
			`</div></header>`,
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
			`<section class="qlab-qmd-editor-pane" aria-label="QMD source editor">`,
			`<div class="qlab-qmd-pane-title qlab-qmd-editor-tab"><span class="qlab-qmd-tab-q">Q</span>`
			+ `<span data-qlab-editor-tab>${escapeHTML(label)}</span><i data-qlab-dirty-dot hidden></i></div>`,
			`<iframe class="qlab-qmd-monaco-frame" data-qlab-qmd-monaco `
			+ `src="chrome://zotero/content/qlab/qmdMonaco.html" title="QMD source editor"></iframe>`,
			`<textarea data-qlab-editor hidden aria-hidden="true"></textarea></section>`,
			`<div class="qlab-qmd-splitter" data-qlab-qmd-splitter role="${accessibility.splitter.role}" tabindex="0" `
			+ `data-l10n-id="${accessibility.splitter.l10nId}" aria-label="${accessibility.splitter.label}" `
			+ `aria-orientation="vertical" aria-valuemin="20" aria-valuemax="80" aria-valuenow="50"></div>`,
			`<section class="qlab-qmd-preview-pane" data-qlab-qmd-preview aria-label="Quarto Preview">`,
			`<div class="qlab-qmd-pane-title"><span data-l10n-id="qlab-qmd-preview">QUARTO PREVIEW</span>`,
			`<div class="qlab-qmd-preview-versions" role="group" aria-label="Preview version">`,
			`<button type="button" class="is-active" data-qlab-preview-version="original">Original</button>`,
			`<button type="button" data-qlab-preview-version="proposed"${proposal ? '' : ' disabled'}>Proposed</button>`,
			`</div></div>`,
			`<iframe class="qlab-qmd-preview-frame" data-qlab-preview-frame title="Rendered QMD Preview" `
			+ `sandbox="allow-same-origin allow-scripts allow-popups"></iframe>`,
			`<div class="qlab-qmd-preview-empty" data-qlab-preview-empty>Select a Draft to preview it.</div>`,
			`</section></div>`,
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
		preview = null,
		session = null,
		onLayout = () => {},
		splitRatio = 0.5,
		explorerVisible = true,
		previewVisible = true,
	} = {}) {
		let resources = { watcher, monaco, preview, session };
		let state = {
			splitRatio: Math.min(0.8, Math.max(0.2, Number(splitRatio) || 0.5)),
			explorerVisible: !!explorerVisible,
			previewVisible: !!previewVisible,
			disposed: false,
		};
		function layout() {
			onLayout({ ...state });
		}
		function disposeResource(name) {
			if (resources[name] && typeof resources[name].dispose === 'function') {
				resources[name].dispose();
			}
			resources[name] = null;
		}
		return {
			setResources(next = {}) {
				for (let name of ['preview', 'session']) {
					if (Object.prototype.hasOwnProperty.call(next, name) && resources[name] !== next[name]) {
						disposeResource(name);
						resources[name] = next[name];
					}
				}
			},
			setSplitRatio(value) {
				state.splitRatio = Math.min(0.8, Math.max(0.2, Number(value) || 0.5));
				layout();
			},
			toggleExplorer(value = !state.explorerVisible) {
				state.explorerVisible = !!value;
				layout();
			},
			togglePreview(value = !state.previewVisible) {
				state.previewVisible = !!value;
				layout();
			},
			snapshot() {
				return { ...state };
			},
			dispose() {
				if (state.disposed) return;
				state.disposed = true;
				for (let name of ['watcher', 'monaco', 'preview', 'session']) disposeResource(name);
			},
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
			let start = (starts[Math.max(0, item.line - 1)] || 0) + Math.max(0, item.column - 1);
			return { ...item, start, end: start + 1 };
		});
	}

	Zotero.QLab.mountQmdWorkspace = async function (host, {
		root,
		initialPath = '',
		layout = {},
	} = {}) {
		if (!host || !root) return null;
		if (host._qlabQmdWorkspace) return host._qlabQmdWorkspace;
		let document = host.ownerDocument;
		let view = document.defaultView;
		let ioHost = Zotero.QLab.QmdDraftIO.createGeckoHost();
		let explorerHost = Zotero.QLab.createGeckoQmdExplorerHost();
		let frame = host.querySelector('[data-qlab-qmd-monaco]');
		let previewFrame = host.querySelector('[data-qlab-preview-frame]');
		let activeSession = null;
		let activePreview = null;
		let activePath = '';
		let proposal = null;
		let bibliographyText = '';
		let previewVersion = 'original';

		try {
			let bibPath = joinRoot(root, 'literature/ref.bib');
			if (await ioHost.exists(bibPath)) bibliographyText = await ioHost.read(bibPath);
		}
		catch (error) {
			Zotero.logError && Zotero.logError(error);
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
		let monacoBridge = Zotero.QLab.createQmdMonacoBridge({
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

		function updateProposalControls() {
			let hasProposal = !!proposal;
			for (let control of host.querySelectorAll(
				'[data-qlab-proposal-compare], [data-qlab-draft-keep], [data-qlab-draft-reject], [data-qlab-preview-version="proposed"]'
			)) {
				control.disabled = !hasProposal;
			}
			let shell = host.querySelector('.qlab-qmd-workspace');
			if (shell) shell.classList.toggle('is-working-copy', hasProposal);
		}

		function applyLayout(state) {
			let shell = host.querySelector('.qlab-qmd-workspace');
			if (!shell) return;
			shell.style.setProperty('--qlab-qmd-editor-ratio', String(state.splitRatio));
			shell.classList.toggle('is-files-collapsed', !state.explorerVisible);
			shell.classList.toggle('is-preview-collapsed', !state.previewVisible);
			let splitter = host.querySelector('[data-qlab-qmd-splitter]');
			if (splitter) splitter.setAttribute('aria-valuenow', String(Math.round(state.splitRatio * 100)));
			activePreview?.setVisible(state.previewVisible);
			let tabs = view.Zotero_Tabs;
			if (tabs && tabs.setTabData && host._qlabMountTabID) {
				tabs.setTabData(host._qlabMountTabID, {
					qmdWorkspace: {
						splitRatio: state.splitRatio,
						explorerVisible: state.explorerVisible,
						previewVisible: state.previewVisible,
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
						let disk = await Zotero.QLab.QmdDraftIO.readSource(root, activePath, ioHost);
						activeSession.observeDisk(disk);
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
			onLayout: applyLayout,
			splitRatio: layout && layout.splitRatio,
			explorerVisible: !layout || layout.explorerVisible !== false,
			previewVisible: !layout || layout.previewVisible !== false,
		});

		function showPreviewState(state) {
			if (!previewFrame || previewVersion !== 'original') return;
			let empty = host.querySelector('[data-qlab-preview-empty]');
			if (state.url) {
				previewFrame.removeAttribute('srcdoc');
				if (previewFrame.getAttribute('src') !== state.url) previewFrame.setAttribute('src', state.url);
				if (empty) empty.hidden = true;
			}
			else if (state.fallback) {
				previewFrame.removeAttribute('src');
				previewFrame.srcdoc = state.fallback;
				if (empty) empty.hidden = true;
			}
			if (state.diagnostics && state.diagnostics.length && activeSession) {
				monacoBridge.setDiagnostics(diagnosticOffsets(activeSession.snapshot().text, state.diagnostics));
			}
			if (state.status === 'error') setStatus(`Preview error · ${state.error}`, 'error');
		}

		async function showPreview(version) {
			previewVersion = version === 'proposed' && proposal ? 'proposed' : 'original';
			for (let button of host.querySelectorAll('[data-qlab-preview-version]')) {
				button.classList.toggle('is-active', button.dataset.qlabPreviewVersion === previewVersion);
			}
			if (previewVersion === 'proposed') {
				previewFrame.removeAttribute('src');
				previewFrame.srcdoc = Zotero.QLab.renderQmdDocumentHTML(proposal.proposed, {
					title: `${activePath} · Proposed`,
				});
				return;
			}
			showPreviewState(activePreview ? activePreview.snapshot() : {});
		}

		async function openDraft(relativePath) {
			if (!Zotero.QLab.isSafeWorkspaceRelativePath(relativePath, { under: 'drafts' })) return;
			let doc = await Zotero.QLab.QmdDraftIO.readSource(root, relativePath, ioHost);
			activePath = relativePath;
			proposal = null;
			let found = await Zotero.QLab.QmdDraftIO.findProposal(root, relativePath, ioHost);
			if (found) {
				try {
					proposal = {
						state: found,
						base: await ioHost.read(joinRoot(root, found.basePath)),
						proposed: await ioHost.read(joinRoot(root, found.workingPath)),
					};
				}
				catch (error) {
					Zotero.logError && Zotero.logError(error);
				}
			}
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
					let textChanged = host._qlabBuffer !== snapshot.text;
					host._qlabBuffer = snapshot.text;
					host._qlabDirty = snapshot.dirty;
					let legacy = host.querySelector('[data-qlab-editor]');
					if (legacy) legacy.value = snapshot.text;
					let dot = host.querySelector('[data-qlab-dirty-dot]');
					if (dot) dot.hidden = !snapshot.dirty;
					if (snapshot.saveError) setStatus(snapshot.saveError, 'error');
					else if (snapshot.saving) setStatus('Saving…', 'saving');
					else if (snapshot.dirty) setStatus('Unsaved changes', 'dirty');
					else if (textChanged) monacoBridge.showNormal();
				},
				onSaved: snapshot => {
					host._qlabLastSaved = snapshot.text;
					if (host._qlabDraftState) host._qlabDraftState.revision = snapshot.revision;
					setStatus('Saved', 'saved');
					void activePreview?.refresh(snapshot.revision);
				},
				onConflict: ({ disk, buffer }) => {
					setStatus('Draft changed on disk · compare before saving', 'conflict');
					monacoBridge.showDiff({ original: disk.text, proposed: buffer.text });
				},
			});
			activeSession = session;
			if (proposal) session.attachProposal(proposal.state);
			let preview = Zotero.QLab.createQmdPreviewController({
				root,
				path: relativePath,
				fallback: () => Zotero.QLab.renderQmdDocumentHTML(activeSession.snapshot().text, {
					title: relativePath,
				}),
				onState: showPreviewState,
			});
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
			monacoBridge.showNormal();
			void preview.start();
			setStatus(proposal ? 'AI proposal ready for review' : 'Saved', proposal ? 'proposal' : 'saved');
		}

		let workspace = {
			controller,
			openDraft,
			refreshExplorer: () => watcher.poll(),
			saveNow: () => activeSession ? activeSession.saveNow() : Promise.resolve(null),
			setBuffer(text, { human = true } = {}) {
				if (!activeSession) return;
				if (human) activeSession.applyHumanEdit(text);
				monacoBridge.showNormal();
			},
			async attachProposal(state, proposedText, baseText = '') {
				proposal = { state, proposed: proposedText, base: baseText || activeSession.snapshot().savedText };
				activeSession.attachProposal(state);
				host._qlabDraftState = { ...host._qlabDraftState, ...state, viewingWorking: false };
				updateProposalControls();
				monacoBridge.showDiff({ original: activeSession.snapshot().text, proposed: proposedText });
				await showPreview('proposed');
			},
			showProposalDiff() {
				if (!proposal || !activeSession) return;
				monacoBridge.showDiff({ original: activeSession.snapshot().text, proposed: proposal.proposed });
			},
			showSource() {
				monacoBridge.showNormal();
			},
			showPreview,
			async keepProposal() {
				if (!proposal) throw new Error('No AI proposal to Keep');
				let result = await Zotero.QLab.QmdDraftIO.keepChange(root, proposal.state, ioHost);
				if (!result.kept) {
					setStatus('AI proposal conflicts with human edits · review the diff', 'conflict');
					monacoBridge.showDiff({ original: result.review.current, proposed: result.review.proposed });
					return result;
				}
				await openDraft(result.path);
				return result;
			},
			async rejectProposal() {
				if (!proposal) return { rejected: false };
				let result = await Zotero.QLab.QmdDraftIO.rejectChange(root, proposal.state, ioHost);
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
			togglePreview(value) {
				controller.togglePreview(value);
			},
			dispose() {
				controller.dispose();
				host._qlabQmdWorkspace = null;
			},
		};
		host._qlabQmdWorkspace = workspace;
		host._qlabSurfaceMode = 'source';

		host.addEventListener('click', event => {
			let version = event.target.closest('[data-qlab-preview-version]');
			if (version && !version.disabled) void showPreview(version.dataset.qlabPreviewVersion);
			if (event.target.closest('[data-qlab-proposal-compare]')) workspace.showProposalDiff();
			if (event.target.closest('[data-qlab-draft-reject]')) void workspace.rejectProposal();
		});

		let splitter = host.querySelector('[data-qlab-qmd-splitter]');
		if (splitter) {
			splitter.addEventListener('keydown', event => {
				if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
				event.preventDefault();
				let direction = event.key === 'ArrowLeft' ? -0.05 : 0.05;
				controller.setSplitRatio(controller.snapshot().splitRatio + direction);
			});
			splitter.addEventListener('pointerdown', event => {
				event.preventDefault();
				let main = host.querySelector('.qlab-qmd-workspace-main');
				let move = moveEvent => {
					let rect = main.getBoundingClientRect();
					let explorerWidth = host.querySelector('[data-qlab-file-column]')?.getBoundingClientRect().width || 0;
					let available = Math.max(520, rect.width - explorerWidth);
					controller.setSplitRatio((moveEvent.clientX - rect.left - explorerWidth) / available);
				};
				let up = () => {
					document.removeEventListener('pointermove', move);
					document.removeEventListener('pointerup', up);
				};
				document.addEventListener('pointermove', move);
				document.addEventListener('pointerup', up);
			});
		}

		applyLayout(controller.snapshot());
		await watcher.start();
		let firstPath = initialPath
			|| host.querySelector('[data-qlab-draft-row]')?.dataset.qlabDraftRow
			|| '';
		if (firstPath) await openDraft(firstPath);
		return workspace;
	};
})();
