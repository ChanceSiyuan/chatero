/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

Zotero.QLab = Zotero.QLab || {};

(function () {
	const SHELL_TYPES = ['qlabchat', 'qlabqmd', 'qlabsite'];
	
	function escapeHTML(value) {
		return String(value || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}
	
	function shellCopy(kind, workspaceState, root) {
		let providerId = 'codex-cli';
		try {
			if (Zotero.QLab.Settings && Zotero.QLab.Settings.getAgentProviderId) {
				providerId = Zotero.QLab.Settings.getAgentProviderId();
			}
		}
		catch (e) {}
		if (kind === 'qlabchat') {
			return {
				title: 'Chat',
				body: workspaceState === 'ready'
					? `Workspace ready. Provider: ${providerId}.`
					: 'Select a QLab workspace to chat about the open paper.',
			};
		}
		if (kind === 'qlabqmd') {
			return {
				title: 'QMD Editor',
				body: workspaceState === 'ready'
					? `Edit drafts under ${root}/drafts. Keep promotes the AI working copy.`
					: 'Select a QLab workspace to edit reading-note drafts.',
			};
		}
		return {
			title: 'Knowledge Site',
			body: 'Main Site preview lands in Phase 4.',
		};
	}
	
	function providerOptionsHTML(selected) {
		let providers = [];
		try {
			let runtime = Zotero.QLab.getAgentRuntime && Zotero.QLab.getAgentRuntime();
			providers = runtime ? runtime.listProviders() : [];
		}
		catch (e) {}
		if (!providers.length) {
			providers = [
				{ id: 'codex-cli', label: 'Local Codex CLI' },
				{ id: 'openai-compat', label: 'OpenAI-compatible API' },
				{ id: 'prove-harness', label: 'Prove harness' },
			];
		}
		return providers
			.filter(p => !p.optional)
			.map(p => `<option value="${escapeHTML(p.id)}"${p.id === selected ? ' selected' : ''}>`
				+ `${escapeHTML(p.label || p.id)}</option>`)
			.join('');
	}
	
	Zotero.QLab.renderShellHTML = function ({
		kind,
		workspaceState = 'missing',
		root = '',
		drafts = [],
		contextSummary = '',
	} = {}) {
		let copy = shellCopy(kind, workspaceState, root);
		let providerId = 'codex-cli';
		try {
			providerId = Zotero.QLab.Settings.getAgentProviderId();
		}
		catch (e) {}
		
		if (kind === 'qlabchat') {
			let actions = Zotero.QLab.researchActionsForObject
				? Zotero.QLab.researchActionsForObject('pdf')
				: [];
			let actionButtons = actions.map(action => (
				`<button type="button" data-qlab-action="${escapeHTML(action.id)}" `
				+ `title="${escapeHTML(action.description)}">${escapeHTML(action.label)}</button>`
			)).join('');
			let tagsHTML = Zotero.QLab.renderComposerTagsHTML
				? Zotero.QLab.renderComposerTagsHTML()
				: `<div class="qlab-composer-tags" data-qlab-context-tags></div>`;
			return [
				`<div class="qlab-shell" data-qlab-kind="qlabchat">`,
				`<header class="qlab-shell-header"><h1>${escapeHTML(copy.title)}</h1></header>`,
				`<p class="qlab-shell-status">${escapeHTML(copy.body)}</p>`,
				`<label class="qlab-shell-field">Provider `
				+ `<select data-qlab-provider>${providerOptionsHTML(providerId)}</select></label>`,
				`<div class="qlab-shell-actions">${actionButtons}</div>`,
				`<div class="qlab-shell-composer">`,
				tagsHTML,
				`<textarea data-qlab-prompt rows="3" `
				+ `placeholder="Ask…  ⌘L pins PDF / QMD context as tags"></textarea>`,
				`<div class="qlab-shell-composer-row">`,
				`<button type="button" data-qlab-send>Send</button>`,
				`</div>`,
				`</div>`,
				`<div class="qlab-shell-output" data-qlab-output role="log"></div>`,
				`</div>`,
			].join('');
		}
		
		if (kind === 'qlabqmd') {
			let options = drafts.map(path => (
				`<option value="${escapeHTML(path)}">${escapeHTML(path)}</option>`
			)).join('');
			let surfaceMode = 'visual';
			let modeToggle = Zotero.QLab.renderQmdModeToggleHTML
				? Zotero.QLab.renderQmdModeToggleHTML(surfaceMode)
				: '';
			return [
				`<div class="qlab-shell qlab-shell-qmd" data-qlab-kind="qlabqmd">`,
				`<header class="qlab-shell-header"><h1>${escapeHTML(copy.title)}</h1></header>`,
				`<p class="qlab-shell-status">${escapeHTML(copy.body)}</p>`,
				`<label class="qlab-shell-field">Draft `
				+ `<select data-qlab-draft><option value="">Select…</option>${options}</select></label>`,
				modeToggle,
				`<div class="qlab-shell-actions">`,
				`<button type="button" data-qlab-draft-reload>Reload</button>`,
				`<button type="button" data-qlab-draft-save>Save</button>`,
				`<button type="button" data-qlab-draft-ai>Edit with AI</button>`,
				`<button type="button" data-qlab-draft-keep>Keep</button>`,
				`<button type="button" data-qlab-website-quarto title="Start Quarto live website">Quarto</button>`,
				`<button type="button" data-qlab-inline-toggle title="Write at the anchor (⌘K)">⌘K Write</button>`,
				`</div>`,
				`<div class="qlab-qmd-inline" data-qlab-inline hidden>`,
				`<input type="text" data-qlab-inline-prompt `
				+ `placeholder="Write a paragraph about…  (inserts at the anchor)"/>`,
				`<button type="button" data-qlab-inline-run>Write</button>`,
				`<button type="button" data-qlab-inline-cancel>Cancel</button>`,
				`</div>`,
				`<div class="qlab-qmd-pending" data-qlab-pending hidden></div>`,
				`<div class="qlab-qmd-surfaces">`,
				`<div class="qlab-qmd-surface" data-qlab-surface="visual" role="tabpanel"></div>`,
				`<div class="qlab-qmd-surface" data-qlab-surface="website" role="tabpanel" hidden>`,
				`<p class="qlab-shell-note" data-qlab-website-meta>Website preview</p>`,
				`<iframe class="qlab-qmd-website-frame" data-qlab-website-frame `
				+ `title="QMD website preview" sandbox="allow-same-origin allow-scripts"></iframe>`,
				`</div>`,
				`<div class="qlab-qmd-surface" data-qlab-surface="source" role="tabpanel" hidden>`,
				`<textarea class="qlab-shell-editor" data-qlab-editor rows="18" `
				+ `placeholder="QMD source…"></textarea>`,
				`</div>`,
				`</div>`,
				`<p class="qlab-shell-note">Preview · Website · Source share one buffer. `
				+ `Save writes the Draft; Edit with AI uses a private working copy; Keep is the only promotion.</p>`,
				`</div>`,
			].join('');
		}
		
		return [
			`<div class="qlab-shell" data-qlab-kind="${escapeHTML(kind)}">`,
			`<header class="qlab-shell-header"><h1>${escapeHTML(copy.title)}</h1></header>`,
			`<p class="qlab-shell-status">${escapeHTML(copy.body)}</p>`,
			`</div>`,
		].join('');
	};
	
	/**
	 * Mount shell UI into a tab-content host. Safe to call repeatedly.
	 */
	Zotero.QLab.mountShellTab = async function (container, kind) {
		if (!container) {
			return;
		}
		let root = '';
		let workspaceState = 'missing';
		let drafts = [];
		try {
			if (Zotero.QLab.Settings) {
				root = Zotero.QLab.Settings.getRoot();
			}
			if (root && Zotero.QLab.qlabRepositoryState && Zotero.QLab.createGeckoQLabPathHost) {
				let pathHost = Zotero.QLab.createGeckoQLabPathHost();
				workspaceState = await Zotero.QLab.qlabRepositoryState(root, pathHost);
				if (kind === 'qlabqmd' && workspaceState === 'ready' && Zotero.QLab.QmdDraftIO) {
					drafts = await Zotero.QLab.QmdDraftIO.listDrafts(
						root,
						Zotero.QLab.QmdDraftIO.createGeckoHost()
					);
				}
			}
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
			workspaceState = 'missing';
		}
		
		let contextSummary = '';
		try {
			if (Zotero.QLab.ReaderContextStore) {
				contextSummary = Zotero.QLab.ReaderContextStore.formatForPrompt();
			}
		}
		catch (e) {}
		
		let host = container.querySelector('.qlab-shell-host');
		if (!host) {
			host = container.ownerDocument.createElementNS(
				'http://www.w3.org/1999/xhtml',
				'div'
			);
			host.className = 'qlab-shell-host';
			container.appendChild(host);
		}
		host.innerHTML = Zotero.QLab.renderShellHTML({
			kind,
			workspaceState,
			root,
			drafts,
			contextSummary,
		});
		host._qlabDraftState = null;
		host._qlabBuffer = '';
		host._qlabDirty = false;
		host._qlabSurfaceMode = 'visual';
		host._qlabWebsiteUrl = '';
		host._qlabMessages = [];
		host._qlabPendingInserts = [];
		host._qlabActiveBlockIndex = null;
		if (kind === 'qlabqmd' && Zotero.QLab.applyQmdSurfaceMode) {
			Zotero.QLab.applyQmdSurfaceMode(host, 'visual', { silent: true, root });
		}
		
		host.onchange = (event) => {
			let provider = event.target.closest('[data-qlab-provider]');
			if (provider && Zotero.QLab.Settings) {
				Zotero.QLab.Settings.setAgentProviderId(provider.value);
				try {
					let runtime = Zotero.QLab.getAgentRuntime();
					if (runtime) {
						runtime.setActiveProviderId(provider.value);
					}
				}
				catch (e) {
					Zotero.logError && Zotero.logError(e);
				}
			}
			let chip = event.target.closest('[data-qlab-chip]');
			if (chip && Zotero.QLab.ReaderContextStore) {
				Zotero.QLab.ReaderContextStore.setChip(chip.dataset.qlabChip, chip.checked);
			}
			let draftSelect = event.target.closest('[data-qlab-draft]');
			if (draftSelect && draftSelect.value) {
				void Zotero.QLab.loadDraftIntoShell(host, root, draftSelect.value);
			}
		};
		
		host.onclick = (event) => {
			let removeTag = event.target.closest('[data-qlab-tag-remove]');
			if (removeTag) {
				let chip = removeTag.closest('[data-qlab-tag-id]');
				if (chip && Zotero.QLab.ChatComposerContext) {
					Zotero.QLab.ChatComposerContext.remove(chip.dataset.qlabTagId);
					Zotero.QLab.refreshComposerTags(host);
				}
				return;
			}
			let revealTag = event.target.closest('[data-qlab-tag-reveal]');
			if (revealTag) {
				let chip = revealTag.closest('[data-qlab-tag-id]');
				let tag = chip && Zotero.QLab.ChatComposerContext
					&& Zotero.QLab.ChatComposerContext.get(chip.dataset.qlabTagId);
				if (tag) {
					void Zotero.QLab.revealComposerTag(tag, host.ownerDocument.defaultView);
				}
				return;
			}
			let messageEl = event.target.closest('[data-qlab-message-id]');
			if (messageEl) {
				let messageID = messageEl.dataset.qlabMessageId;
				if (event.target.closest('[data-qlab-msg-insert]')) {
					Zotero.QLab.applyChatMessageToQmd(host, messageID);
					return;
				}
				if (event.target.closest('[data-qlab-msg-quote]')) {
					Zotero.QLab.applyChatMessageToQmd(host, messageID, { asQuote: true });
					return;
				}
				if (event.target.closest('[data-qlab-msg-copy]')) {
					let message = Zotero.QLab.getChatMessage(host, messageID);
					let clipboard = Zotero.Utilities && Zotero.Utilities.Internal
						&& Zotero.Utilities.Internal.copyTextToClipboard;
					if (message && clipboard) {
						clipboard(message.text);
					}
					return;
				}
			}
			let pendingRow = event.target.closest('[data-qlab-pending-id]');
			if (pendingRow) {
				let regionID = pendingRow.dataset.qlabPendingId;
				if (event.target.closest('[data-qlab-pending-accept]')) {
					Zotero.QLab.acceptPendingQmdInsert(host, regionID);
					return;
				}
				if (event.target.closest('[data-qlab-pending-reject]')) {
					runPendingReview(host, () => (
						Zotero.QLab.rejectPendingQmdInsert(host, regionID)
					));
					return;
				}
				if (event.target.closest('[data-qlab-pending-reveal]')) {
					Zotero.QLab.revealQmdPendingRegion(host, regionID);
					return;
				}
			}
			if (event.target.closest('[data-qlab-pending-accept-all]')) {
				Zotero.QLab.acceptPendingQmdInsert(host);
				return;
			}
			if (event.target.closest('[data-qlab-pending-reject-all]')) {
				runPendingReview(host, () => Zotero.QLab.rejectAllPendingQmdInserts(host));
				return;
			}
			let modeBtn = event.target.closest('[data-qlab-mode]');
			if (modeBtn && Zotero.QLab.applyQmdSurfaceMode) {
				Zotero.QLab.applyQmdSurfaceMode(host, modeBtn.dataset.qlabMode, { root });
				return;
			}
			let visualBlock = event.target.closest('[data-qlab-block-index]');
			if (visualBlock
					&& !event.target.closest('textarea')
					&& Zotero.QLab.beginQmdVisualBlockEdit) {
				Zotero.QLab.beginQmdVisualBlockEdit(
					host,
					Number(visualBlock.dataset.qlabBlockIndex)
				);
				return;
			}
			let action = event.target.closest('[data-qlab-action]');
			if (action) {
				void Zotero.QLab.runShellResearchAction({
					host,
					actionID: action.dataset.qlabAction,
					root,
					workspaceState,
				});
				return;
			}
			if (event.target.closest('[data-qlab-send]')) {
				void Zotero.QLab.runShellFreeform(host, root, workspaceState);
				return;
			}
			if (event.target.closest('[data-qlab-draft-reload]')) {
				let sel = host.querySelector('[data-qlab-draft]');
				if (sel && sel.value) {
					void Zotero.QLab.loadDraftIntoShell(host, root, sel.value);
				}
				return;
			}
			if (event.target.closest('[data-qlab-draft-save]')) {
				void Zotero.QLab.saveDraftFromShell(host, root);
				return;
			}
			if (event.target.closest('[data-qlab-draft-ai]')) {
				void Zotero.QLab.editDraftWithAI(host, root, workspaceState);
				return;
			}
			if (event.target.closest('[data-qlab-draft-keep]')) {
				void Zotero.QLab.keepDraftFromShell(host, root);
				return;
			}
			if (event.target.closest('[data-qlab-inline-toggle]')) {
				Zotero.QLab.toggleQmdInlineBar(host);
				return;
			}
			if (event.target.closest('[data-qlab-inline-cancel]')) {
				Zotero.QLab.toggleQmdInlineBar(host, false);
				return;
			}
			if (event.target.closest('[data-qlab-inline-run]')) {
				let input = host.querySelector('[data-qlab-inline-prompt]');
				void Zotero.QLab.requestQmdInlineWrite({
					host,
					instruction: input ? input.value : '',
					root,
					workspaceState,
				});
				return;
			}
			if (event.target.closest('[data-qlab-website-quarto]')) {
				void Zotero.QLab.refreshQmdWebsitePane(host, {
					root,
					forceQuarto: true,
				});
				if (host._qlabSurfaceMode !== 'website' && Zotero.QLab.applyQmdSurfaceMode) {
					Zotero.QLab.applyQmdSurfaceMode(host, 'website', { root, silent: true });
				}
			}
		};
		
		let editor = host.querySelector('[data-qlab-editor]');
		if (editor) {
			editor.addEventListener('input', () => {
				Zotero.QLab.setQmdShellBuffer(host, editor.value, { dirty: true });
			});
		}
		
		let inlinePrompt = host.querySelector('[data-qlab-inline-prompt]');
		if (inlinePrompt) {
			inlinePrompt.addEventListener('keydown', (event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					void Zotero.QLab.requestQmdInlineWrite({
						host,
						instruction: inlinePrompt.value,
						root,
						workspaceState,
					});
				}
				else if (event.key === 'Escape') {
					event.preventDefault();
					Zotero.QLab.toggleQmdInlineBar(host, false);
				}
			});
		}
		
		// ⌘K only claims the key while focus is inside a QMD shell. The host
		// element outlives re-mounts, so this binds exactly once.
		if (kind === 'qlabqmd' && !host._qlabInlineKeyBound) {
			host._qlabInlineKeyBound = true;
			host.addEventListener('keydown', (event) => {
				if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey
						&& String(event.key || '').toLowerCase() === 'k') {
					event.preventDefault();
					event.stopPropagation();
					Zotero.QLab.toggleQmdInlineBar(host, true);
				}
			}, true);
		}
	};
	
	Zotero.QLab.loadDraftIntoShell = async function (host, root, relativePath) {
		let status = host.querySelector('.qlab-shell-status');
		try {
			let ioHost = Zotero.QLab.QmdDraftIO.createGeckoHost();
			let doc = await Zotero.QLab.QmdDraftIO.readSource(root, relativePath, ioHost);
			host._qlabDraftState = {
				originalPath: relativePath,
				workingPath: null,
				revision: doc.revision,
				viewingWorking: false,
			};
			host._qlabLastSaved = doc.text;
			host._qlabWebsiteUrl = '';
			host._qlabActiveBlockIndex = null;
			// Pending regions belong to the buffer we are replacing.
			host._qlabPendingInserts = [];
			Zotero.QLab.renderQmdPendingBar && Zotero.QLab.renderQmdPendingBar(host);
			Zotero.QLab.setQmdShellBuffer(host, doc.text, { dirty: false });
			let mode = host._qlabSurfaceMode || 'visual';
			if (Zotero.QLab.applyQmdSurfaceMode) {
				Zotero.QLab.applyQmdSurfaceMode(host, mode, { silent: true, root });
			}
			if (status) {
				status.textContent = `Loaded ${relativePath} (rev ${doc.revision})`;
			}
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
			if (status) {
				status.textContent = e.message || String(e);
			}
		}
	};
	
	Zotero.QLab.saveDraftFromShell = async function (host, root) {
		let status = host.querySelector('.qlab-shell-status');
		let state = host._qlabDraftState;
		try {
			if (!state) {
				throw new Error('Open a Draft first');
			}
			let editor = host.querySelector('[data-qlab-editor]');
			if (editor && host._qlabSurfaceMode === 'source') {
				Zotero.QLab.setQmdShellBuffer(host, editor.value, { dirty: true });
			}
			let text = Zotero.QLab.getQmdShellBuffer(host);
			let path = state.viewingWorking && state.workingPath
				? state.workingPath
				: state.originalPath;
			let ioHost = Zotero.QLab.QmdDraftIO.createGeckoHost();
			let saved = await Zotero.QLab.QmdDraftIO.writeSource(
				root,
				path,
				text,
				state.viewingWorking ? null : state.revision,
				ioHost
			);
			if (!state.viewingWorking) {
				state.revision = saved.revision;
			}
			host._qlabLastSaved = text;
			host._qlabDirty = false;
			host._qlabWebsiteUrl = '';
			// Review markers describe unsaved text; the write settled that.
			host._qlabPendingInserts = [];
			Zotero.QLab.renderQmdPendingBar && Zotero.QLab.renderQmdPendingBar(host);
			if (status) {
				status.textContent = `Saved ${path}`;
			}
			if (host._qlabSurfaceMode === 'website' && Zotero.QLab.refreshQmdWebsitePane) {
				void Zotero.QLab.refreshQmdWebsitePane(host, { root });
			}
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
			if (status) {
				status.textContent = e.message || String(e);
			}
		}
	};
	
	Zotero.QLab.editDraftWithAI = async function (host, root, workspaceState) {
		let status = host.querySelector('.qlab-shell-status');
		let state = host._qlabDraftState;
		try {
			if (!state) {
				throw new Error('Open a Draft first');
			}
			if (workspaceState !== 'ready') {
				throw new Error('Workspace is not ready');
			}
			let ioHost = Zotero.QLab.QmdDraftIO.createGeckoHost();
			let prepared = await Zotero.QLab.QmdDraftIO.prepareChange(
				root,
				state.originalPath,
				ioHost
			);
			host._qlabDraftState = {
				originalPath: prepared.originalPath,
				workingPath: prepared.workingPath,
				revision: prepared.revision,
				viewingWorking: true,
			};
			Zotero.QLab.setQmdShellBuffer(host, prepared.text, { dirty: false });
			if (Zotero.QLab.applyQmdSurfaceMode) {
				Zotero.QLab.applyQmdSurfaceMode(
					host,
					host._qlabSurfaceMode || 'visual',
					{ silent: true, root }
				);
			}
			
			let runtime = Zotero.QLab.getAgentRuntime();
			let providerId = Zotero.QLab.Settings.getAgentProviderId();
			let prompt = [
				'Edit the QMD working copy only.',
				`Working copy: ${prepared.workingPath}`,
				`Original Draft: ${prepared.originalPath}`,
				'Do not write knowledge/. Keep authority remains with the user.',
				`Current source:\n${prepared.text.slice(0, 8000)}`,
			].join('\n');
			if (status) {
				status.textContent = 'Agent editing private working copy…';
			}
			let chunks = [];
			for await (let event of runtime.startTurn({
				mode: 'agent',
				workspaceRoot: root,
				prompt,
				providerId,
			})) {
				if (event.type === 'text-delta') {
					chunks.push(event.text || '');
				}
				else if (event.type === 'error') {
					chunks.push(`[error] ${event.message}`);
				}
			}
			// Reload working copy if the agent wrote it; otherwise leave editor as-is.
			try {
				let working = await Zotero.QLab.QmdDraftIO.readSource(
					root,
					prepared.workingPath,
					ioHost
				);
				Zotero.QLab.setQmdShellBuffer(host, working.text, { dirty: false });
				if (Zotero.QLab.applyQmdSurfaceMode) {
					Zotero.QLab.applyQmdSurfaceMode(
						host,
						host._qlabSurfaceMode || 'visual',
						{ silent: true, root }
					);
				}
			}
			catch (e) {}
			if (status) {
				status.textContent = `Working copy ready. Review, then Keep. ${chunks.join('').slice(0, 200)}`;
			}
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
			if (status) {
				status.textContent = e.message || String(e);
			}
		}
	};
	
	Zotero.QLab.keepDraftFromShell = async function (host, root) {
		let status = host.querySelector('.qlab-shell-status');
		let state = host._qlabDraftState;
		try {
			if (!state || !state.workingPath) {
				throw new Error('No AI working copy to Keep');
			}
			let ioHost = Zotero.QLab.QmdDraftIO.createGeckoHost();
			// Persist shared buffer into working copy first.
			let editor = host.querySelector('[data-qlab-editor]');
			if (editor && host._qlabSurfaceMode === 'source') {
				Zotero.QLab.setQmdShellBuffer(host, editor.value, { dirty: true });
			}
			await Zotero.QLab.QmdDraftIO.writeSource(
				root,
				state.workingPath,
				Zotero.QLab.getQmdShellBuffer(host),
				null,
				ioHost
			);
			let result = await Zotero.QLab.QmdDraftIO.keepChange(root, state, ioHost);
			host._qlabDraftState = {
				originalPath: result.path,
				workingPath: null,
				revision: result.revision,
				viewingWorking: false,
			};
			await Zotero.QLab.loadDraftIntoShell(host, root, result.path);
			if (status) {
				status.textContent = `Kept → ${result.path}`;
			}
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
			if (status) {
				status.textContent = e.message || String(e);
			}
		}
	};
	
	/**
	 * Rejecting a region can fail when the user edited over it; surface that in
	 * the status line instead of silently leaving the buffer half-reverted.
	 */
	function runPendingReview(host, apply) {
		let status = host && host.querySelector('.qlab-shell-status');
		try {
			apply();
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
			if (status) {
				status.textContent = e.message || String(e);
			}
		}
	}
	
	/**
	 * Chat transcript model. Messages are addressable so each assistant reply can
	 * carry its own Apply actions, the way a Cursor chat turn does.
	 */
	Zotero.QLab.appendChatMessage = function (host, { role = 'assistant', text = '' } = {}) {
		if (!host) {
			return null;
		}
		let message = {
			id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
			role,
			text: String(text || ''),
		};
		host._qlabMessages = (host._qlabMessages || []).concat(message);
		Zotero.QLab.renderChatMessages(host);
		return message;
	};
	
	Zotero.QLab.updateChatMessage = function (host, id, text) {
		if (!host || !host._qlabMessages) {
			return;
		}
		let message = host._qlabMessages.find(m => m.id === id);
		if (!message) {
			return;
		}
		message.text = String(text || '');
		let body = host.querySelector(`[data-qlab-message-id="${id}"] .qlab-chat-message-body`);
		if (body) {
			body.textContent = message.text;
		}
		else {
			Zotero.QLab.renderChatMessages(host);
		}
	};
	
	Zotero.QLab.getChatMessage = function (host, id) {
		return (host && host._qlabMessages || []).find(m => m.id === id) || null;
	};
	
	Zotero.QLab.renderChatMessages = function (host) {
		let output = host && host.querySelector('[data-qlab-output]');
		if (!output) {
			return;
		}
		let messages = host._qlabMessages || [];
		output.innerHTML = messages.map((message) => {
			let actions = message.role === 'assistant'
				? `<div class="qlab-chat-message-actions">`
					+ `<button type="button" data-qlab-msg-insert>Insert into notes</button>`
					+ `<button type="button" data-qlab-msg-quote>Insert as quote</button>`
					+ `<button type="button" data-qlab-msg-copy>Copy</button>`
					+ `</div>`
				: '';
			return `<article class="qlab-chat-message is-${escapeHTML(message.role)}" `
				+ `data-qlab-message-id="${escapeHTML(message.id)}">`
				+ `<header class="qlab-chat-message-role">${escapeHTML(message.role)}</header>`
				+ `<pre class="qlab-chat-message-body">${escapeHTML(message.text)}</pre>`
				+ actions
				+ `</article>`;
		}).join('');
		output.scrollTop = output.scrollHeight;
	};
	
	/**
	 * Apply a chat reply into the live QMD buffer. User-initiated only: this is a
	 * human edit that still has to go through Save, never an agent write.
	 */
	Zotero.QLab.applyChatMessageToQmd = function (host, messageID, { asQuote = false } = {}) {
		let status = host && host.querySelector('.qlab-shell-status');
		try {
			let message = Zotero.QLab.getChatMessage(host, messageID);
			if (!message || !message.text.trim()) {
				throw new Error('Nothing to insert');
			}
			let snippet = asQuote
				? Zotero.QLab.buildQuoteSnippet({ text: message.text, title: 'Chat' })
				: Zotero.QLab.buildChatSnippet({ text: message.text });
			let win = host.ownerDocument.defaultView;
			let result = Zotero.QLab.insertIntoQmd(win, snippet, {
				label: asQuote ? 'Chat quote' : 'Chat reply',
			});
			if (status) {
				status.textContent = result
					? 'Inserted into the QMD buffer (unsaved — Save to write the Draft)'
					: 'Nothing to insert';
			}
			return result;
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
			if (status) {
				status.textContent = e.message || String(e);
			}
			return null;
		}
	};
	
	/**
	 * ⌘K: write a passage at the current anchor. Runs in `ask` mode and lands as
	 * a pending region, so it never touches the Draft file or the Keep contract.
	 */
	Zotero.QLab.requestQmdInlineWrite = async function ({
		host,
		instruction,
		root = '',
		workspaceState = 'missing',
	} = {}) {
		let status = host && host.querySelector('.qlab-shell-status');
		let bar = host && host.querySelector('[data-qlab-inline]');
		let submit = bar && bar.querySelector('[data-qlab-inline-run]');
		try {
			if (workspaceState !== 'ready') {
				throw new Error('Choose a ready QLab workspace first');
			}
			let task = String(instruction || '').trim();
			if (!task) {
				throw new Error('Describe what to write');
			}
			let anchor = Zotero.QLab.resolveQmdAnchor(host);
			let buffer = Zotero.QLab.getQmdShellBuffer(host);
			let context = Zotero.QLab.qmdAnchorContext(buffer, anchor);
			let state = host._qlabDraftState;
			let prompt = Zotero.QLab.buildQmdInlineWritePrompt({
				instruction: task,
				composerContext: composerContextBlock(),
				before: context.before,
				after: context.after,
				draftPath: state ? state.originalPath : '',
			});
			
			let providerId = Zotero.QLab.Settings.getAgentProviderId();
			let runtime = Zotero.QLab.getAgentRuntime();
			if (!runtime) {
				throw new Error('AgentRuntime is unavailable');
			}
			if (submit) {
				submit.disabled = true;
			}
			if (status) {
				status.textContent = `Writing at the anchor via ${providerId}…`;
			}
			
			let chunks = [];
			for await (let event of runtime.startTurn({
				mode: 'ask',
				workspaceRoot: root,
				prompt,
				providerId,
				attachments: [{ kind: 'policy', readOnly: true }],
			})) {
				if (event.type === 'text-delta' && event.text) {
					chunks.push(event.text);
				}
				else if (event.type === 'error') {
					throw new Error(event.message);
				}
			}
			
			let written = Zotero.QLab.stripQmdAnswerFence(chunks.join(''));
			if (!written.trim()) {
				throw new Error('The provider returned nothing to insert');
			}
			Zotero.QLab.insertIntoQmd(host.ownerDocument.defaultView, written, {
				anchor,
				label: `⌘K ${task.slice(0, 32)}`,
			});
			if (bar) {
				bar.hidden = true;
				let input = bar.querySelector('[data-qlab-inline-prompt]');
				if (input) {
					input.value = '';
				}
			}
			if (status) {
				status.textContent = 'Written into the buffer — review, then Save';
			}
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
			if (status) {
				status.textContent = e.message || String(e);
			}
		}
		finally {
			if (submit) {
				submit.disabled = false;
			}
		}
	};
	
	/**
	 * Show or hide the ⌘K prompt bar.
	 */
	Zotero.QLab.toggleQmdInlineBar = function (host, show) {
		let bar = host && host.querySelector('[data-qlab-inline]');
		if (!bar) {
			return;
		}
		let next = show === undefined ? bar.hidden : !!show;
		bar.hidden = !next;
		let input = bar.querySelector('[data-qlab-inline-prompt]');
		if (next && input) {
			input.focus();
			input.select();
		}
	};
	
	function composerContextBlock() {
		if (Zotero.QLab.ChatComposerContext
				&& Zotero.QLab.ChatComposerContext.list().length) {
			return Zotero.QLab.ChatComposerContext.formatForPrompt();
		}
		return Zotero.QLab.ReaderContextStore
			? Zotero.QLab.ReaderContextStore.formatForPrompt()
			: '';
	}
	
	Zotero.QLab.runShellFreeform = async function (host, root, workspaceState) {
		let textarea = host.querySelector('[data-qlab-prompt]');
		let status = host.querySelector('.qlab-shell-status');
		try {
			if (workspaceState !== 'ready') {
				throw new Error('Choose a ready QLab workspace first');
			}
			let userText = textarea ? textarea.value.trim() : '';
			if (!userText) {
				throw new Error('Enter a prompt');
			}
			let providerId = Zotero.QLab.Settings.getAgentProviderId();
			let context = composerContextBlock();
			let prompt = [context, userText].filter(Boolean).join('\n\n');
			let runtime = Zotero.QLab.getAgentRuntime();
			let chunks = [];
			Zotero.QLab.appendChatMessage(host, { role: 'user', text: userText });
			if (textarea) {
				textarea.value = '';
			}
			let reply = Zotero.QLab.appendChatMessage(host, { role: 'assistant', text: '' });
			if (status) {
				status.textContent = `Sending via ${providerId}…`;
			}
			for await (let event of runtime.startTurn({
				mode: 'ask',
				workspaceRoot: root,
				prompt,
				providerId,
				attachments: [{ kind: 'policy', readOnly: true }],
			})) {
				if (event.type === 'text-delta') {
					chunks.push(event.text || '');
					Zotero.QLab.updateChatMessage(host, reply.id, chunks.join(''));
				}
				else if (event.type === 'error') {
					chunks.push(`\n[error] ${event.message}`);
				}
			}
			Zotero.QLab.updateChatMessage(host, reply.id, chunks.join('') || '(empty response)');
			if (status) {
				status.textContent = 'Done';
			}
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
			if (status) {
				status.textContent = e.message || String(e);
			}
		}
	};
	
	/**
	 * Chat-shell Research Action → AgentRuntime.startTurn.
	 */
	Zotero.QLab.runShellResearchAction = async function ({
		host,
		actionID,
		root = '',
		workspaceState = 'missing',
	} = {}) {
		let status = host && host.querySelector('.qlab-shell-status');
		try {
			if (!root || workspaceState === 'missing' || workspaceState === 'incompatible') {
				if (status) {
					status.textContent = 'Choose a ready QLab workspace before running Actions.';
				}
				return;
			}
			let readOnly = Zotero.QLab.isReadOnlyResearchAction
				&& Zotero.QLab.isReadOnlyResearchAction(actionID);
			let ctx = Zotero.QLab.ReaderContextStore && Zotero.QLab.ReaderContextStore.get();
			let prompt = Zotero.QLab.buildResearchActionPrompt(actionID, {
				qlabRoot: root,
				object: {
					kind: 'pdf',
					title: (ctx && ctx.parent && ctx.parent.title) || 'Current PDF',
					libraryID: ctx && ctx.attachment && ctx.attachment.libraryID,
					itemKey: ctx && ctx.parent && ctx.parent.key,
					attachmentKey: ctx && ctx.attachment && ctx.attachment.key,
				},
			});
			let readerBlock = composerContextBlock();
			if (readerBlock) {
				prompt = `${readerBlock}\n\n${prompt}`;
			}
			let providerId = Zotero.QLab.Settings.getAgentProviderId();
			if (status) {
				status.textContent = `Running ${actionID} via ${providerId}…`;
			}
			
			Zotero.QLab.startup && Zotero.QLab.startup();
			let runtime = Zotero.QLab.getAgentRuntime && Zotero.QLab.getAgentRuntime();
			if (!runtime) {
				throw new Error('AgentRuntime is unavailable');
			}
			
			let chunks = [];
			Zotero.QLab.appendChatMessage(host, { role: 'user', text: `/${actionID}` });
			let reply = Zotero.QLab.appendChatMessage(host, { role: 'assistant', text: '' });
			for await (let event of runtime.startTurn({
				mode: readOnly ? 'ask' : 'agent',
				workspaceRoot: root,
				prompt,
				providerId,
				attachments: readOnly ? [{ kind: 'policy', readOnly: true }] : [],
			})) {
				if (event.type === 'text-delta' && event.text) {
					chunks.push(event.text);
					Zotero.QLab.updateChatMessage(host, reply.id, chunks.join(''));
				}
				else if (event.type === 'error') {
					chunks.push(`\n[error] ${event.message}`);
				}
				else if (event.type === 'approval-needed') {
					chunks.push(`\n[approval] ${event.reason}`);
				}
				else if (event.type === 'done' && status) {
					status.textContent = `Done (${event.status})`;
				}
			}
			Zotero.QLab.updateChatMessage(host, reply.id, chunks.join('') || '(empty)');
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
			if (status) {
				status.textContent = e.message || String(e);
			}
		}
	};
	
	Zotero.QLab.SHELL_TAB_TYPES = SHELL_TYPES.slice();
	
	/**
	 * Window-scoped controller. Created from Zotero_Tabs.init when available.
	 */
	Zotero.QLab.createWindowController = function (tabsAPI) {
		let groups = new Zotero.QLab.TabGroups(() => {
			try {
				if (tabsAPI && typeof tabsAPI._onQLabGroupsChanged === 'function') {
					tabsAPI._onQLabGroupsChanged(groups.snapshot());
				}
			}
			catch (e) {
				Zotero.logError && Zotero.logError(e);
			}
		});
		
		return {
			groups,
			
			isEnabled() {
				return !Zotero.QLab.Settings || Zotero.QLab.Settings.isEnabled();
			},
			
			ensureShellTab(kind, payload) {
				if (!this.isEnabled() || !tabsAPI) {
					return null;
				}
				let existing = tabsAPI._tabs.find(tab => tab.type === kind);
				if (existing) {
					if (payload && tabsAPI.setTabData) {
						tabsAPI.setTabData(existing.id, payload);
					}
					try {
						let container = typeof document !== 'undefined'
							? document.getElementById(existing.id)
							: null;
						if (container) {
							void Zotero.QLab.mountShellTab(container, kind);
						}
					}
					catch (e) {
						Zotero.logError && Zotero.logError(e);
					}
					return existing.id;
				}
				let titles = {
					'qlabchat': 'Chat',
					'qlabqmd': 'QMD Editor',
					'qlabsite': 'Knowledge Site',
				};
				let { id, container } = tabsAPI.add({
					id: kind,
					type: kind,
					title: titles[kind] || kind,
					data: payload || {},
					select: false,
				});
				Zotero.QLab.mountShellTab(container, kind);
				return id;
			},
			
			/**
			 * Open a shell tab and park it in a specific pane without disturbing
			 * the other panes (⌘L must not steal the pane the user is reading in).
			 */
			dockShellTab(kind, role, payload) {
				let id = this.ensureShellTab(kind, payload);
				if (!id) {
					return null;
				}
				try {
					if (groups.tab(id)) {
						groups.moveTab(id, role);
					}
					else {
						groups.openTab({ kind, id, payload: payload || null }, role);
					}
				}
				catch (e) {
					Zotero.logError && Zotero.logError(e);
				}
				try {
					tabsAPI._applySplitVisibility && tabsAPI._applySplitVisibility();
				}
				catch (e) {
					Zotero.logError && Zotero.logError(e);
				}
				return id;
			},
			
			async applyArrangement(arrangement) {
				let snapshot = await Zotero.QLab.applyArrangement(groups, arrangement, {
					ensureReader: async (id) => {
						let tabID = tabsAPI.getTabIDByItemID && tabsAPI.getTabIDByItemID(id);
						if (tabID) {
							return tabID;
						}
						if (Zotero.Reader && Zotero.Reader.open) {
							let reader = await Zotero.Reader.open(id);
							return reader && reader.tabID;
						}
						return null;
					},
					ensureShellTab: (kind, payload) => this.ensureShellTab(kind, payload),
					select: id => tabsAPI.select(id),
				});
				try {
					tabsAPI._applySplitVisibility && tabsAPI._applySplitVisibility();
				}
				catch (e) {
					Zotero.logError && Zotero.logError(e);
				}
				return snapshot;
			},
			
			async arrangePDFChat(itemID, title) {
				return this.applyArrangement(
					Zotero.QLab.buildPDFChatArrangement({ itemID, title })
				);
			},
			
			async arrangePDFEditor(itemID, title) {
				return this.applyArrangement(
					Zotero.QLab.buildPDFEditorArrangement({ itemID, title })
				);
			},
			
			async arrangeResearchDesk(itemID, title) {
				return this.applyArrangement(
					Zotero.QLab.buildResearchDeskArrangement({ itemID, title })
				);
			},
			
			getGroupsState() {
				return groups.serialize();
			},
			
			restoreGroupsState(data) {
				groups.restore(data);
			},
		};
	};
	
	/**
	 * Module bootstrap. Must never throw into Zotero startup.
	 */
	Zotero.QLab.startup = function () {
		try {
			if (!Zotero.QLab.Settings) {
				return;
			}
			if (!Zotero.QLab.Settings.isEnabled()) {
				Zotero.debug && Zotero.debug('QLab module disabled by preference');
				try {
					Zotero.QLab.unregisterReaderHooks && Zotero.QLab.unregisterReaderHooks();
				}
				catch (_) {}
				return;
			}
			if (!Zotero.QLab._agentRuntime
					&& Zotero.QLab.createDefaultProviderRegistry
					&& Zotero.QLab.AgentRuntime) {
				let registry = Zotero.QLab.createDefaultProviderRegistry();
				let preferred = Zotero.QLab.Settings.getAgentProviderId();
				Zotero.QLab._providerRegistry = registry;
				Zotero.QLab._agentRuntime = new Zotero.QLab.AgentRuntime({
					registry,
					defaultProviderId: registry.get(preferred)
						? preferred
						: 'codex-cli',
				});
			}
			try {
				Zotero.QLab.registerReaderHooks && Zotero.QLab.registerReaderHooks();
				Zotero.QLab.installMainWindowShortcuts
					&& Zotero.QLab.installMainWindowShortcuts();
			}
			catch (e) {
				Zotero.logError && Zotero.logError(e);
			}
		}
		catch (e) {
			try {
				Zotero.logError(e);
			}
			catch (_) {}
		}
	};
	
	Zotero.QLab.getAgentRuntime = function () {
		if (!Zotero.QLab._agentRuntime) {
			Zotero.QLab.startup();
		}
		return Zotero.QLab._agentRuntime || null;
	};
})();
