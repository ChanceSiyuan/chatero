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
	
	function ensureKatexStyles(doc) {
		if (!doc || !Zotero.QLab.katexStylesheetHref) {
			return;
		}
		let head = doc.head || doc.querySelector('head');
		if (!head || head.querySelector('[data-qlab-katex-css]')) {
			// #region agent log
			fetch('http://127.0.0.1:7350/ingest/ba635be9-3f49-40ce-9509-feafde36c36e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'be0fa9'},body:JSON.stringify({sessionId:'be0fa9',location:'qlabModule.js:ensureKatexStyles',message:'katex css skip',data:{hasHead:!!head,alreadyLinked:!!(head&&head.querySelector('[data-qlab-katex-css]'))},timestamp:Date.now(),hypothesisId:'E'})}).catch(()=>{});
			// #endregion
			return;
		}
		let link = doc.createElementNS('http://www.w3.org/1999/xhtml', 'link');
		link.rel = 'stylesheet';
		link.href = Zotero.QLab.katexStylesheetHref();
		link.setAttribute('data-qlab-katex-css', 'true');
		head.appendChild(link);
		// #region agent log
		fetch('http://127.0.0.1:7350/ingest/ba635be9-3f49-40ce-9509-feafde36c36e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'be0fa9'},body:JSON.stringify({sessionId:'be0fa9',location:'qlabModule.js:ensureKatexStyles',message:'katex css linked',data:{href:link.href},timestamp:Date.now(),hypothesisId:'E'})}).catch(()=>{});
		// #endregion
	}
	
	/**
	 * XUL windows are XML documents, so assigning ordinary HTML containing
	 * boolean attributes or void elements to innerHTML throws. Parse as HTML
	 * first, then import the resulting nodes into the chrome document.
	 */
	Zotero.QLab.setHTML = function (element, html) {
		if (!element) {
			return;
		}
		let doc = element.ownerDocument;
		let Parser = doc.defaultView && doc.defaultView.DOMParser
			? doc.defaultView.DOMParser
			: DOMParser;
		let parsed = new Parser().parseFromString(String(html || ''), 'text/html');
		let fragment = doc.createDocumentFragment();
		for (let child of Array.from(parsed.body.childNodes)) {
			fragment.appendChild(doc.importNode(child, true));
		}
		element.replaceChildren(fragment);
	};
	
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
	
	function shellIcon(name) {
		let paths = {
			'new': ['M12 5v14', 'M5 12h14'],
			'regenerate': ['M20 6v5h-5', 'M4 18v-5h5', 'M18.2 9a7 7 0 0 0-11.7-2.5L4 11', 'M5.8 15a7 7 0 0 0 11.7 2.5L20 13'],
			'send': ['M12 19V5', 'M6 11l6-6 6 6'],
			'stop': ['M8 8h8v8H8z'],
			'folder': ['M3.5 7.5h6l2-2h9v13h-17z'],
			'reload': ['M20 6v5h-5', 'M18.2 9a7 7 0 1 0 .2 5.7'],
			'save': ['M5 4h12l2 2v14H5z', 'M8 4v6h8V4', 'M8 16h8'],
			'edit': ['M4 20l4.5-1 10-10-3.5-3.5-10 10z', 'M13.5 7l3.5 3.5'],
			'keep': ['M12 4v12', 'M7 11l5 5 5-5', 'M5 20h14'],
			'website': ['M4 5h16v14H4z', 'M4 9h16', 'M8 7h.01'],
			'write': ['M4 18h16', 'M7 15 16 6l2 2-9 9H7z'],
		};
		let body = (paths[name] || []).map(path => `<path d="${path}"></path>`).join('');
		return `<svg class="qlab-control-icon" viewBox="0 0 24 24" aria-hidden="true" `
			+ `fill="none" stroke="currentColor" stroke-width="1.8" `
			+ `stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
	}
	
	function iconButtonHTML({ name, label, attribute, className = '' }) {
		return `<button type="button" class="qlab-icon-button ${escapeHTML(className)}" `
			+ `${attribute} title="${escapeHTML(label)}" aria-label="${escapeHTML(label)}">`
			+ `${shellIcon(name)}</button>`;
	}
	
	function draftRowsHTML(drafts, selected = '') {
		if (!drafts.length) {
			return `<div class="qlab-qmd-files-empty">No Drafts found</div>`;
		}
		return drafts.map((path) => {
			let label = path.replace(/^drafts\//, '');
			return `<button type="button" class="qlab-qmd-file-row${path === selected ? ' is-active' : ''}" `
				+ `data-qlab-draft-row="${escapeHTML(path)}" title="${escapeHTML(path)}">`
				+ `${shellIcon('edit')}<span>${escapeHTML(label)}</span></button>`;
		}).join('');
	}
	
	const MODEL_CHOICES = [
		{ id: '', label: 'Default model' },
		{ id: 'gpt-5', label: 'gpt-5' },
		{ id: 'gpt-5-mini', label: 'gpt-5-mini' },
		{ id: 'o3', label: 'o3' },
		{ id: 'o4-mini', label: 'o4-mini' },
	];
	
	function modelOptionsHTML(selected) {
		let value = String(selected || '');
		return MODEL_CHOICES.map(opt => (
			`<option value="${escapeHTML(opt.id)}"${opt.id === value ? ' selected' : ''}>`
			+ `${escapeHTML(opt.label)}</option>`
		)).join('');
	}
	
	function newThreadId() {
		return `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}
	
	/**
	 * Frame a bounded recent transcript for multi-turn chat.
	 * Excludes a trailing empty / in-flight assistant reply by default.
	 */
	Zotero.QLab.buildChatTranscriptPrompt = function (messages, {
		maxTurns = 8,
		maxChars = 24_000,
		excludeTrailingAssistant = true,
	} = {}) {
		let list = Array.isArray(messages) ? messages.slice() : [];
		if (excludeTrailingAssistant) {
			while (list.length && list[list.length - 1].role === 'assistant') {
				list.pop();
			}
		}
		let maxMessages = Math.max(1, maxTurns) * 2;
		if (list.length > maxMessages) {
			list = list.slice(-maxMessages);
		}
		if (!list.length) {
			return '';
		}
		let budget = Number(maxChars);
		if (!Number.isFinite(budget) || budget <= 0) {
			budget = 24_000;
		}
		budget = Math.max(500, Math.min(budget, 120_000));
		let selected = [];
		let used = 0;
		for (let i = list.length - 1; i >= 0; i--) {
			let message = list[i];
			let role = message.role === 'assistant' ? 'assistant' : 'user';
			let body = String(message.text || '').trim();
			if (body.length > 1200) {
				body = `${body.slice(0, 1199)}…`;
			}
			let line = `${role}: ${body}`;
			if (selected.length && used + line.length > budget) {
				break;
			}
			if (!selected.length && line.length > budget) {
				body = body.slice(0, Math.max(0, budget - role.length - 4)) + '…';
				line = `${role}: ${body}`;
			}
			selected.unshift(message);
			used += line.length + 1;
		}
		if (!selected.length) {
			selected = list.slice(-1);
		}
		let parts = ['<chat_transcript>'];
		for (let message of selected) {
			let role = message.role === 'assistant' ? 'assistant' : 'user';
			let body = String(message.text || '').trim();
			if (body.length > 1200) {
				body = `${body.slice(0, 1199)}…`;
			}
			parts.push(`${role}: ${body}`);
		}
		parts.push('</chat_transcript>');
		return parts.join('\n');
	};
	
	Zotero.QLab.renderShellHTML = function ({
		kind,
		workspaceState = 'missing',
		root = '',
		drafts = [],
		contextSummary: _contextSummary = '',
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
			let atPickerHTML = Zotero.QLab.renderComposerAtPickerHTML
				? Zotero.QLab.renderComposerAtPickerHTML([])
				: `<div class="qlab-at-picker" data-qlab-at-picker hidden></div>`;
			let modelId = '';
			let chatMode = 'ask';
			try {
				modelId = Zotero.QLab.Settings.getAgentModel
					? Zotero.QLab.Settings.getAgentModel()
					: '';
				chatMode = Zotero.QLab.Settings.getChatMode
					? Zotero.QLab.Settings.getChatMode()
					: 'ask';
			}
			catch (e) {}
			return [
				`<div class="qlab-shell" data-qlab-kind="qlabchat">`,
				`<header class="qlab-shell-header qlab-chat-topbar">`,
				`<div class="qlab-shell-identity">`,
				`<span class="qlab-identity-mark" aria-hidden="true">C</span>`,
				`<div><h1>Chatero</h1><span>Research assistant</span></div>`,
				`</div>`,
				`<div class="qlab-shell-header-actions" role="toolbar" aria-label="Chat actions">`,
				iconButtonHTML({
					name: 'new',
					label: 'New chat',
					attribute: 'data-qlab-new-chat',
				}),
				iconButtonHTML({
					name: 'regenerate',
					label: 'Regenerate',
					attribute: 'data-qlab-regenerate',
				}),
				`</div>`,
				`</header>`,
				`<div class="qlab-workspace-strip">`,
				`<span class="qlab-workspace-dot" data-state="${escapeHTML(workspaceState)}"></span>`,
				`<span class="qlab-shell-status">${escapeHTML(copy.body)}</span>`,
				`</div>`,
				`<div class="qlab-shell-output" data-qlab-output role="log"></div>`,
				`<div class="qlab-agent-draft-banner" data-qlab-agent-banner hidden></div>`,
				`<div class="qlab-shell-composer">`,
				`<div class="qlab-shell-actions" aria-label="Research suggestions">${actionButtons}</div>`,
				tagsHTML,
				`<div class="qlab-composer-at-wrap">`,
				`<textarea data-qlab-prompt rows="2" `
				+ `placeholder="Ask…  @ for context · ⌘L pins PDF / QMD · ⌘↵ send"></textarea>`,
				atPickerHTML,
				`</div>`,
				`<div class="qlab-shell-composer-footer">`,
				`<div class="qlab-shell-toolbar">`,
				`<label class="qlab-shell-field"><span>Provider</span>`
				+ `<select data-qlab-provider aria-label="Provider">${providerOptionsHTML(providerId)}</select></label>`,
				`<label class="qlab-shell-field"><span>Model</span>`
				+ `<select data-qlab-model aria-label="Model">${modelOptionsHTML(modelId)}</select></label>`,
				`<label class="qlab-shell-field"><span>Mode</span>`
				+ `<select data-qlab-chat-mode aria-label="Mode">`
				+ `<option value="ask"${chatMode === 'ask' ? ' selected' : ''}>Ask</option>`
				+ `<option value="agent"${chatMode === 'agent' ? ' selected' : ''}>Agent</option>`
				+ `</select></label>`,
				`<span class="qlab-context-meter" data-qlab-context-meter></span>`,
				`</div>`,
				`<div class="qlab-shell-composer-row">`,
				iconButtonHTML({
					name: 'stop',
					label: 'Stop',
					attribute: 'data-qlab-stop hidden',
					className: 'qlab-stop-button',
				}),
				iconButtonHTML({
					name: 'send',
					label: 'Send',
					attribute: 'data-qlab-send',
					className: 'qlab-send-button',
				}),
				`</div>`,
				`</div>`,
				`</div>`,
				`</div>`,
			].join('');
		}
		
		if (kind === 'qlabqmd' && Zotero.QLab.renderQmdWorkspaceHTML) {
			return Zotero.QLab.renderQmdWorkspaceHTML({
				drafts,
				status: workspaceState === 'ready' ? 'Ready' : copy.body,
			});
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
				`<header class="qlab-qmd-toolbar">`,
				`<button type="button" class="qlab-qmd-files-toggle" data-qlab-files-toggle `
				+ `title="Toggle Draft files" aria-label="Toggle Draft files">${shellIcon('folder')}</button>`,
				`<div class="qlab-qmd-path-wrap">`,
				`<span class="qlab-qmd-tree-badge">Draft</span>`,
				`<strong class="qlab-qmd-path" data-qlab-draft-path>No Draft selected</strong>`,
				`</div>`,
				modeToggle,
				`<div class="qlab-qmd-toolbar-actions" role="toolbar" aria-label="QMD actions">`,
				iconButtonHTML({ name: 'reload', label: 'Reload', attribute: 'data-qlab-draft-reload' }),
				iconButtonHTML({ name: 'save', label: 'Save', attribute: 'data-qlab-draft-save' }),
				iconButtonHTML({ name: 'edit', label: 'Edit with AI', attribute: 'data-qlab-draft-ai' }),
				iconButtonHTML({ name: 'keep', label: 'Keep', attribute: 'data-qlab-draft-keep' }),
				iconButtonHTML({ name: 'write', label: '⌘K', attribute: 'data-qlab-inline-toggle' }),
				`</div>`,
				`</header>`,
				`<div class="qlab-qmd-statusbar">`,
				`<span class="qlab-shell-status">${escapeHTML(copy.body)}</span>`,
				`<span class="qlab-qmd-authority">Human: Save · AI: Keep</span>`,
				`</div>`,
				`<div class="qlab-qmd-inline" data-qlab-inline hidden>`,
				`<input type="text" data-qlab-inline-prompt `
				+ `placeholder="Write or rewrite at the anchor…  (selection → replace)"/>`,
				`<button type="button" data-qlab-inline-run>Write</button>`,
				`<button type="button" data-qlab-inline-stop hidden>Stop</button>`,
				`<button type="button" data-qlab-inline-cancel>Cancel</button>`,
				`</div>`,
				`<div class="qlab-qmd-pending" data-qlab-pending hidden></div>`,
				`<div class="qlab-qmd-body">`,
				`<aside class="qlab-qmd-file-column" data-qlab-file-column aria-label="Draft files">`,
				`<div class="qlab-qmd-file-heading">Drafts</div>`,
				`<div class="qlab-qmd-file-list" data-qlab-draft-list>${draftRowsHTML(drafts)}</div>`,
				`<label class="qlab-qmd-select-fallback">Draft `
				+ `<select data-qlab-draft><option value="">Select…</option>${options}</select></label>`,
				`</aside>`,
				`<div class="qlab-qmd-surfaces">`,
				`<div class="qlab-qmd-surface" data-qlab-surface="visual" role="tabpanel"></div>`,
				`<div class="qlab-qmd-surface" data-qlab-surface="website" role="tabpanel" hidden>`,
				`<p class="qlab-shell-note" data-qlab-website-meta>Website preview</p>`,
				`<iframe class="qlab-qmd-website-frame" data-qlab-website-frame `
				+ `title="QMD website preview" sandbox="allow-same-origin allow-scripts allow-popups"></iframe>`,
				`</div>`,
				`<div class="qlab-qmd-surface" data-qlab-surface="source" role="tabpanel" hidden>`,
				`<textarea class="qlab-shell-editor" data-qlab-editor rows="18" `
				+ `placeholder="QMD source…"></textarea>`,
				`</div>`,
				`</div>`,
				`</div>`,
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
	 * Refresh workspace chrome on an already-mounted shell without wiping
	 * transcript / buffer / pending state.
	 */
	Zotero.QLab.refreshShellWorkspaceChrome = function (host, {
		kind,
		workspaceState = 'missing',
		root = '',
		drafts = [],
	} = {}) {
		if (!host) {
			return;
		}
		let copy = shellCopy(kind, workspaceState, root);
		let status = host.querySelector('.qlab-shell-status');
		if (status && !host._qlabTurnHandle) {
			status.textContent = copy.body;
		}
		let draftSelect = host.querySelector('[data-qlab-draft]');
		if (draftSelect && Array.isArray(drafts)) {
			let current = draftSelect.value;
			let options = ['<option value="">Select…</option>'].concat(
				drafts.map(path => (
					`<option value="${escapeHTML(path)}"${path === current ? ' selected' : ''}>`
					+ `${escapeHTML(path)}</option>`
				))
			);
			Zotero.QLab.setHTML(draftSelect, options.join(''));
			let fileList = host.querySelector('[data-qlab-draft-list]');
			if (fileList) {
				Zotero.QLab.setHTML(fileList, draftRowsHTML(drafts, current));
			}
		}
		if (kind === 'qlabchat') {
			Zotero.QLab.refreshComposerTags && Zotero.QLab.refreshComposerTags(host);
			Zotero.QLab.renderChatMessages(host);
			void Zotero.QLab.refreshChatProviderAvailability(host);
		}
		if (kind === 'qlabqmd') {
			Zotero.QLab.renderQmdPendingBar && Zotero.QLab.renderQmdPendingBar(host);
			let mode = host._qlabSurfaceMode || 'visual';
			if (Zotero.QLab.applyQmdSurfaceMode) {
				Zotero.QLab.applyQmdSurfaceMode(host, mode, { silent: true, root });
			}
		}
	};
	
	/**
	 * Disable Send when the active local provider is unavailable.
	 */
	Zotero.QLab.refreshChatProviderAvailability = async function (host) {
		if (!host) {
			return;
		}
		let send = host.querySelector('[data-qlab-send]');
		let status = host.querySelector('.qlab-shell-status');
		try {
			let providerId = Zotero.QLab.Settings
				? Zotero.QLab.Settings.getAgentProviderId()
				: 'codex-cli';
			let runtime = Zotero.QLab.getAgentRuntime && Zotero.QLab.getAgentRuntime();
			let provider = runtime && runtime._registry && runtime._registry.get(providerId);
			if (provider && typeof provider.refreshStatus === 'function') {
				await provider.refreshStatus();
			}
			let unavailable = provider && provider.status === 'unavailable';
			if (send) {
				send.disabled = !!unavailable || !!host._qlabTurnHandle;
			}
			if (unavailable && status && !host._qlabTurnHandle) {
				status.textContent = providerId === 'codex-cli'
					? 'Codex CLI unavailable — install Codex or switch provider.'
					: `Provider ${providerId} is unavailable.`;
			}
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
		}
	};
	
	function setChatTurnRunning(host, running) {
		let send = host && host.querySelector('[data-qlab-send]');
		let stop = host && host.querySelector('[data-qlab-stop]');
		if (send && !running) {
			// Availability refresh may re-disable; optimistic enable here.
			send.disabled = false;
		}
		else if (send && running) {
			send.disabled = true;
		}
		if (stop) {
			stop.hidden = !running;
		}
	}
	
	/**
	 * Mount shell UI into a tab-content host. Safe to call repeatedly.
	 * Same-kind remounts hydrate chrome only -- transcript, buffer, pending
	 * inserts, draft state, and surface mode are preserved.
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
		
		let sameRoot = host._qlabMountRoot === root;
		let sameKindMounted = host._qlabMountedKind === kind
			&& (kind !== 'qlabqmd' || sameRoot)
			&& host.querySelector(`[data-qlab-kind="${kind}"]`);
		if (sameKindMounted) {
			Zotero.QLab.refreshShellWorkspaceChrome(host, {
				kind,
				workspaceState,
				root,
				drafts,
			});
			host._qlabMountRoot = root;
			host._qlabMountWorkspaceState = workspaceState;
			return;
		}
		
		if (host._qlabQmdWorkspace && !sameKindMounted) {
			host._qlabQmdWorkspace.dispose();
		}
		let preserve = host._qlabMountedKind === kind
			&& (kind !== 'qlabqmd' || sameRoot);
		let preserved = preserve
			? {
				draftState: host._qlabDraftState,
				buffer: host._qlabBuffer,
				dirty: host._qlabDirty,
				surfaceMode: host._qlabSurfaceMode,
				websiteUrl: host._qlabWebsiteUrl,
				messages: host._qlabMessages,
				pending: host._qlabPendingInserts,
				activeBlock: host._qlabActiveBlockIndex,
				threadId: host._qlabThreadId,
				lastSaved: host._qlabLastSaved,
			}
			: null;
		
		Zotero.QLab.setHTML(host, Zotero.QLab.renderShellHTML({
			kind,
			workspaceState,
			root,
			drafts,
			contextSummary,
		}));
		ensureKatexStyles(host.ownerDocument);
		host._qlabMountedKind = kind;
		host._qlabMountRoot = root;
		host._qlabMountWorkspaceState = workspaceState;
		
		if (preserve && preserved) {
			host._qlabDraftState = preserved.draftState || null;
			host._qlabBuffer = typeof preserved.buffer === 'string' ? preserved.buffer : '';
			host._qlabDirty = !!preserved.dirty;
			host._qlabSurfaceMode = preserved.surfaceMode || 'visual';
			host._qlabWebsiteUrl = preserved.websiteUrl || '';
			host._qlabMessages = Array.isArray(preserved.messages) ? preserved.messages : [];
			host._qlabPendingInserts = Array.isArray(preserved.pending) ? preserved.pending : [];
			host._qlabActiveBlockIndex = Number.isInteger(preserved.activeBlock)
				? preserved.activeBlock
				: null;
			host._qlabThreadId = preserved.threadId || newThreadId();
			host._qlabLastSaved = preserved.lastSaved;
		}
		else {
			host._qlabDraftState = null;
			host._qlabBuffer = '';
			host._qlabDirty = false;
			host._qlabSurfaceMode = 'visual';
			host._qlabWebsiteUrl = '';
			host._qlabMessages = [];
			host._qlabPendingInserts = [];
			host._qlabActiveBlockIndex = null;
			host._qlabThreadId = newThreadId();
			host._qlabTurnHandle = null;
		}
		
		if (kind === 'qlabqmd' && Zotero.QLab.mountQmdWorkspace && root && workspaceState === 'ready') {
			await Zotero.QLab.mountQmdWorkspace(host, { root });
		}
		else if (kind === 'qlabqmd' && Zotero.QLab.applyQmdSurfaceMode) {
			let mode = host._qlabSurfaceMode || 'visual';
			if (host._qlabBuffer && Zotero.QLab.setQmdShellBuffer) {
				Zotero.QLab.setQmdShellBuffer(host, host._qlabBuffer, {
					dirty: host._qlabDirty,
					render: false,
				});
			}
			Zotero.QLab.applyQmdSurfaceMode(host, mode, { silent: true, root });
			Zotero.QLab.renderQmdPendingBar && Zotero.QLab.renderQmdPendingBar(host);
		}
		if (kind === 'qlabchat') {
			if (!preserve && root && workspaceState === 'ready' && Zotero.QLab.loadLatestChatThread) {
				void Zotero.QLab.loadLatestChatThread(host, root).then(() => {
					Zotero.QLab.renderChatMessages(host);
					Zotero.QLab.refreshComposerTags(host);
					Zotero.QLab.updateChatContextMeter(host);
				});
			}
			if (root && Zotero.QLab.loadApprovalPolicy) {
				void Zotero.QLab.loadApprovalPolicy(root).then((policy) => {
					host._qlabApprovalPolicy = policy;
				});
			}
			Zotero.QLab.renderChatMessages(host);
			Zotero.QLab.updateChatContextMeter(host);
			void Zotero.QLab.refreshChatProviderAvailability(host);
		}
		
		host.onchange = (event) => {
			let mountRoot = host._qlabMountRoot || root;
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
				void Zotero.QLab.refreshChatProviderAvailability(host);
			}
			let model = event.target.closest('[data-qlab-model]');
			if (model && Zotero.QLab.Settings && Zotero.QLab.Settings.setAgentModel) {
				Zotero.QLab.Settings.setAgentModel(model.value);
			}
			let chatMode = event.target.closest('[data-qlab-chat-mode]');
			if (chatMode && Zotero.QLab.Settings && Zotero.QLab.Settings.setChatMode) {
				Zotero.QLab.Settings.setChatMode(chatMode.value);
			}
			let chip = event.target.closest('[data-qlab-chip]');
			if (chip && Zotero.QLab.ReaderContextStore) {
				Zotero.QLab.ReaderContextStore.setChip(chip.dataset.qlabChip, chip.checked);
			}
			let draftSelect = event.target.closest('[data-qlab-draft]');
			if (draftSelect && draftSelect.value) {
				void Zotero.QLab.loadDraftIntoShell(host, mountRoot, draftSelect.value);
			}
		};
		
		host.onclick = (event) => {
			let mountRoot = host._qlabMountRoot || root;
			let mountState = host._qlabMountWorkspaceState || workspaceState;
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
				if (event.target.closest('[data-qlab-msg-apply]')) {
					Zotero.QLab.applyChatMessageToQmd(host, messageID);
					return;
				}
				if (event.target.closest('[data-qlab-msg-quote]')) {
					Zotero.QLab.applyChatMessageToQmd(host, messageID, { asQuote: true });
					return;
				}
				if (event.target.closest('[data-qlab-msg-regenerate]')) {
					void Zotero.QLab.regenerateChatMessage(host, messageID, mountRoot, mountState);
					return;
				}
				if (event.target.closest('[data-qlab-msg-edit]')) {
					Zotero.QLab.editChatMessage(host, messageID);
					return;
				}
				if (event.target.closest('[data-qlab-msg-fork]')) {
					Zotero.QLab.forkChatThread(host);
					Zotero.QLab.editChatMessage(host, messageID);
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
				Zotero.QLab.applyQmdSurfaceMode(host, modeBtn.dataset.qlabMode, {
					root: mountRoot,
				});
				return;
			}
			let visualBlock = event.target.closest('[data-qlab-block-index]');
			if (visualBlock
					&& !event.target.closest('textarea')
					&& !event.target.closest('[data-qlab-pending-id]')
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
					root: mountRoot,
					workspaceState: mountState,
				});
				return;
			}
			if (event.target.closest('[data-qlab-send]')) {
				void Zotero.QLab.runShellFreeform(host, mountRoot, mountState);
				return;
			}
			if (event.target.closest('[data-qlab-stop]')) {
				Zotero.QLab.cancelShellTurn(host);
				return;
			}
			if (event.target.closest('[data-qlab-new-chat]')) {
				Zotero.QLab.resetChatThread(host);
				return;
			}
			if (event.target.closest('[data-qlab-regenerate]')) {
				void Zotero.QLab.regenerateLastChatTurn(host, mountRoot, mountState);
				return;
			}
			if (event.target.closest('[data-qlab-approval-allow]')) {
				Zotero.QLab.resolveChatApproval(host, true);
				return;
			}
			if (event.target.closest('[data-qlab-approval-deny]')) {
				Zotero.QLab.resolveChatApproval(host, false);
				return;
			}
			if (event.target.closest('[data-qlab-agent-keep]')) {
				void Zotero.QLab.keepAgentDraftFromChat(host, mountRoot);
				return;
			}
			if (event.target.closest('[data-qlab-agent-discard]')) {
				Zotero.QLab.hideAgentDraftBanner(host);
				return;
			}
			if (event.target.closest('[data-qlab-files-toggle]')) {
				let shell = host.querySelector('.qlab-shell-qmd');
				if (shell) {
					shell.classList.toggle('is-files-collapsed');
				}
				return;
			}
			let draftRow = event.target.closest('[data-qlab-draft-row]');
			if (draftRow) {
				let path = draftRow.dataset.qlabDraftRow;
				let select = host.querySelector('[data-qlab-draft]');
				if (select) {
					select.value = path;
				}
				for (let row of host.querySelectorAll('[data-qlab-draft-row]')) {
					row.classList.toggle('is-active', row === draftRow);
				}
				void Zotero.QLab.loadDraftIntoShell(host, mountRoot, path);
				return;
			}
			let atPick = event.target.closest('[data-qlab-at-pick]');
			if (atPick) {
				void Zotero.QLab.handleComposerAtPick(host, atPick.dataset.qlabAtPick);
				return;
			}
			if (event.target.closest('[data-qlab-draft-reload]')) {
				let sel = host.querySelector('[data-qlab-draft]');
				if (sel && sel.value) {
					void Zotero.QLab.loadDraftIntoShell(host, mountRoot, sel.value);
				}
				return;
			}
			if (event.target.closest('[data-qlab-draft-save]')) {
				void Zotero.QLab.saveDraftFromShell(host, mountRoot);
				return;
			}
			if (event.target.closest('[data-qlab-draft-ai]')) {
				void Zotero.QLab.editDraftWithAI(host, mountRoot, mountState);
				return;
			}
			if (event.target.closest('[data-qlab-draft-keep]')) {
				void Zotero.QLab.keepDraftFromShell(host, mountRoot);
				return;
			}
			if (event.target.closest('[data-qlab-inline-toggle]')) {
				Zotero.QLab.toggleQmdInlineBar(host);
				return;
			}
			if (event.target.closest('[data-qlab-inline-cancel]')) {
				if (host._qlabTurnHandle) {
					Zotero.QLab.cancelShellTurn(host);
				}
				Zotero.QLab.toggleQmdInlineBar(host, false);
				return;
			}
			if (event.target.closest('[data-qlab-inline-stop]')) {
				Zotero.QLab.cancelShellTurn(host);
				return;
			}
			if (event.target.closest('[data-qlab-inline-run]')) {
				let input = host.querySelector('[data-qlab-inline-prompt]');
				void Zotero.QLab.requestQmdInlineWrite({
					host,
					instruction: input ? input.value : '',
					root: mountRoot,
					workspaceState: mountState,
				});
				return;
			}
		};
		
		let editor = host.querySelector('[data-qlab-editor]');
		if (editor) {
			editor.addEventListener('input', () => {
				Zotero.QLab.setQmdShellBuffer(host, editor.value, { dirty: true });
			});
			editor.addEventListener('keydown', (event) => {
				if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey) {
					return;
				}
				if (!Zotero.QLab.suggestQmdCompletion) {
					return;
				}
				let suggestion = Zotero.QLab.suggestQmdCompletion(
					editor.value,
					editor.selectionStart
				);
				if (!suggestion) {
					return;
				}
				event.preventDefault();
				let start = editor.selectionStart;
				let end = editor.selectionEnd;
				editor.value = editor.value.slice(0, start) + suggestion + editor.value.slice(end);
				editor.selectionStart = editor.selectionEnd = start + suggestion.length;
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
						root: host._qlabMountRoot || root,
						workspaceState: host._qlabMountWorkspaceState || workspaceState,
					});
				}
				else if (event.key === 'Escape') {
					event.preventDefault();
					if (host._qlabTurnHandle) {
						Zotero.QLab.cancelShellTurn(host);
					}
					else {
						Zotero.QLab.toggleQmdInlineBar(host, false);
					}
				}
			});
		}
		
		let prompt = host.querySelector('[data-qlab-prompt]');
		if (prompt) {
			prompt.addEventListener('keydown', (event) => {
				let meta = event.metaKey || event.ctrlKey;
				if (meta && event.key === 'Enter' && !event.shiftKey) {
					event.preventDefault();
					void Zotero.QLab.runShellFreeform(
						host,
						host._qlabMountRoot || root,
						host._qlabMountWorkspaceState || workspaceState
					);
					return;
				}
				if (event.key === 'Escape') {
					event.preventDefault();
					if (host._qlabTurnHandle) {
						Zotero.QLab.cancelShellTurn(host);
					}
					else {
						Zotero.QLab.hideComposerAtPicker(host);
					}
					return;
				}
				if (event.key === '@' || (event.key === '2' && event.shiftKey)) {
					// Defer until the character is in the textarea.
					host.ownerDocument.defaultView.setTimeout(() => {
						Zotero.QLab.maybeShowComposerAtPicker(host);
					}, 0);
				}
			});
			prompt.addEventListener('input', () => {
				Zotero.QLab.maybeShowComposerAtPicker(host);
			});
		}
		
		// Shell keyboard shortcuts bind once per host element.
		if (!host._qlabShellKeyBound) {
			host._qlabShellKeyBound = true;
			host.addEventListener('keydown', (event) => {
				let meta = event.metaKey || event.ctrlKey;
				let key = String(event.key || '').toLowerCase();
				if (host._qlabMountedKind === 'qlabqmd') {
					if (meta && !event.shiftKey && !event.altKey && key === 'k') {
						event.preventDefault();
						event.stopPropagation();
						Zotero.QLab.toggleQmdInlineBar(host, true);
						return;
					}
				}
				if (meta && event.shiftKey && !event.altKey && key === 'enter') {
					let pending = Zotero.QLab.pendingQmdInserts
						? Zotero.QLab.pendingQmdInserts(host)
						: [];
					if (pending.length) {
						event.preventDefault();
						Zotero.QLab.acceptPendingQmdInsert(host, pending[pending.length - 1].id);
					}
					return;
				}
				if (meta && event.shiftKey && !event.altKey
						&& (key === 'backspace' || event.key === 'Backspace')) {
					let pending = Zotero.QLab.pendingQmdInserts
						? Zotero.QLab.pendingQmdInserts(host)
						: [];
					if (pending.length) {
						event.preventDefault();
						runPendingReview(host, () => (
							Zotero.QLab.rejectPendingQmdInsert(
								host,
								pending[pending.length - 1].id
							)
						));
					}
				}
			}, true);
		}
	};
	
	Zotero.QLab.loadDraftIntoShell = async function (host, root, relativePath) {
		if (host && host._qlabQmdWorkspace) {
			return host._qlabQmdWorkspace.openDraft(relativePath);
		}
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
			let select = host.querySelector('[data-qlab-draft]');
			if (select) {
				select.value = relativePath;
			}
			let pathLabel = host.querySelector('[data-qlab-draft-path]');
			if (pathLabel) {
				pathLabel.textContent = relativePath;
				pathLabel.title = relativePath;
			}
			let shell = host.querySelector('.qlab-shell-qmd');
			if (shell) {
				shell.classList.remove('is-working-copy');
			}
			for (let row of host.querySelectorAll('[data-qlab-draft-row]')) {
				row.classList.toggle('is-active', row.dataset.qlabDraftRow === relativePath);
			}
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
		if (host && host._qlabQmdWorkspace) {
			return host._qlabQmdWorkspace.saveNow();
		}
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
			let modernWorkspace = host._qlabQmdWorkspace;
			host._qlabDraftState = {
				originalPath: prepared.originalPath,
				workingPath: prepared.workingPath,
				basePath: prepared.basePath,
				revision: prepared.revision,
				viewingWorking: !modernWorkspace,
			};
			let shell = host.querySelector('.qlab-shell-qmd');
			if (shell) {
				shell.classList.add('is-working-copy');
			}
			let pathLabel = host.querySelector('[data-qlab-draft-path]');
			if (pathLabel) {
				pathLabel.textContent = `${prepared.originalPath} · AI working copy`;
				pathLabel.title = prepared.workingPath;
			}
			if (!modernWorkspace) {
				Zotero.QLab.setQmdShellBuffer(host, prepared.text, { dirty: false });
			}
			if (!modernWorkspace && Zotero.QLab.applyQmdSurfaceMode) {
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
				if (modernWorkspace) {
					await modernWorkspace.attachProposal(prepared, working.text, prepared.text);
				}
				else {
					Zotero.QLab.setQmdShellBuffer(host, working.text, { dirty: false });
				}
				if (!modernWorkspace && Zotero.QLab.applyQmdSurfaceMode) {
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
		if (host && host._qlabQmdWorkspace) {
			return host._qlabQmdWorkspace.keepProposal();
		}
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
	Zotero.QLab.appendChatMessage = function (host, {
		role = 'assistant',
		text = '',
		status = '',
	} = {}) {
		if (!host) {
			return null;
		}
		let message = {
			id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
			role,
			text: String(text || ''),
			status: status || '',
		};
		host._qlabMessages = (host._qlabMessages || []).concat(message);
		Zotero.QLab.renderChatMessages(host);
		Zotero.QLab.updateChatContextMeter(host);
		void Zotero.QLab.persistChatHost(host, host._qlabMountRoot);
		return message;
	};
	
	Zotero.QLab.updateChatMessage = function (host, id, text, { status } = {}) {
		if (!host || !host._qlabMessages) {
			return;
		}
		let message = host._qlabMessages.find(m => m.id === id);
		if (!message) {
			return;
		}
		if (text !== undefined) {
			message.text = String(text || '');
		}
		if (status !== undefined) {
			message.status = status || '';
		}
		let article = host.querySelector(`[data-qlab-message-id="${id}"]`);
		let body = article && article.querySelector('.qlab-chat-message-body');
		if (body) {
			body.textContent = message.text;
			if (article) {
				article.classList.toggle('is-cancelled', message.status === 'cancelled');
				let role = article.querySelector('.qlab-chat-message-role');
				if (role) {
					role.textContent = message.status === 'cancelled'
						? `${message.role} · cancelled`
						: message.role;
				}
			}
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
		if (!messages.length) {
			let actions = Zotero.QLab.researchActionsForObject
				? Zotero.QLab.researchActionsForObject('pdf').slice(0, 4)
				: [];
			let suggestions = actions.map(action => (
				`<button type="button" data-qlab-action="${escapeHTML(action.id)}" `
				+ `title="${escapeHTML(action.description)}">${escapeHTML(action.label)}</button>`
			)).join('');
			Zotero.QLab.setHTML(output,
				`<section class="qlab-chat-empty">`
				+ `<span class="qlab-chat-empty-mark" aria-hidden="true">C</span>`
				+ `<h2>What would you like to research?</h2>`
				+ `<p>Ask about the open paper, synthesize evidence, or shape a Draft with your pinned context.</p>`
				+ `<div class="qlab-chat-empty-suggestions">${suggestions}</div>`
				+ `</section>`
			);
			return;
		}
		Zotero.QLab.setHTML(output, messages.map((message) => {
			let actions = message.role === 'assistant' && message.text.trim()
				? `<div class="qlab-chat-message-actions">`
					+ `<button type="button" class="is-primary" data-qlab-msg-apply>Apply to QMD</button>`
					+ `<button type="button" data-qlab-msg-quote>Quote</button>`
					+ `<button type="button" data-qlab-msg-regenerate>Regenerate</button>`
					+ `<button type="button" data-qlab-msg-copy>Copy</button>`
					+ `</div>`
				: message.role === 'user' && message.text.trim()
					? `<div class="qlab-chat-message-actions">`
						+ `<button type="button" data-qlab-msg-edit>Edit</button>`
						+ `<button type="button" data-qlab-msg-fork>Fork</button>`
						+ `</div>`
					: '';
			let roleLabel = message.status === 'cancelled'
				? `${message.role} · cancelled`
				: message.role;
			let cancelled = message.status === 'cancelled' ? ' is-cancelled' : '';
			let avatar = message.role === 'assistant'
				? `<span class="qlab-chat-avatar" aria-hidden="true">C</span>`
				: '';
			return `<article class="qlab-chat-message is-${escapeHTML(message.role)}${cancelled}" `
				+ `data-qlab-message-id="${escapeHTML(message.id)}">`
				+ avatar
				+ `<div class="qlab-chat-message-content">`
				+ `<header class="qlab-chat-message-role">${escapeHTML(roleLabel)}</header>`
				+ `<pre class="qlab-chat-message-body">${escapeHTML(message.text)}</pre>`
				+ actions
				+ `</div>`
				+ `</article>`;
		}).join(''));
		output.scrollTop = output.scrollHeight;
	};
	
	Zotero.QLab.resetChatThread = function (host) {
		if (!host) {
			return;
		}
		Zotero.QLab.cancelShellTurn(host);
		host._qlabMessages = [];
		host._qlabThreadId = newThreadId();
		host._qlabParentThreadId = null;
		if (Zotero.QLab.ChatComposerContext) {
			Zotero.QLab.ChatComposerContext.clear();
		}
		Zotero.QLab.renderChatMessages(host);
		Zotero.QLab.refreshComposerTags(host);
		Zotero.QLab.updateChatContextMeter(host);
		void Zotero.QLab.persistChatHost(host, host._qlabMountRoot);
		let status = host.querySelector('.qlab-shell-status');
		if (status) {
			status.textContent = 'New chat';
		}
	};
	
	Zotero.QLab.cancelShellTurn = function (host) {
		let handle = host && host._qlabTurnHandle;
		if (handle && typeof handle.cancel === 'function') {
			handle.cancel();
		}
	};
	
	Zotero.QLab.hideComposerAtPicker = function (host) {
		let picker = host && host.querySelector('[data-qlab-at-picker]');
		if (picker) {
			picker.hidden = true;
		}
	};
	
	Zotero.QLab.maybeShowComposerAtPicker = async function (host) {
		let textarea = host && host.querySelector('[data-qlab-prompt]');
		let picker = host && host.querySelector('[data-qlab-at-picker]');
		if (!textarea || !picker) {
			return;
		}
		let value = textarea.value || '';
		let pos = typeof textarea.selectionStart === 'number'
			? textarea.selectionStart
			: value.length;
		let before = value.slice(0, pos);
		let tokenMatch = /(?:^|[\s([{])@(\w*)$/.exec(before);
		let at = tokenMatch || /(?:^|[\s([{])@$/.test(before);
		if (!at) {
			picker.hidden = true;
			return;
		}
		let query = tokenMatch ? tokenMatch[1] : '';
		let win = host.ownerDocument.defaultView;
		let items = Zotero.QLab.listComposerAtPickerItems
			? Zotero.QLab.listComposerAtPickerItems(win, { query })
			: [];
		if (query.length >= 2 && host._qlabMountRoot && Zotero.QLab.searchWorkspaceForComposer) {
			try {
				let hits = await Zotero.QLab.searchWorkspaceForComposer(
					host._qlabMountRoot,
					query,
					{ maxResults: 6 }
				);
				items = items.concat(hits);
			}
			catch (e) {}
		}
		host._qlabAtPickerItems = items;
		let wrap = host.ownerDocument.createElement('div');
		Zotero.QLab.setHTML(wrap, Zotero.QLab.renderComposerAtPickerHTML(items));
		let next = wrap.firstElementChild;
		if (next) {
			next.hidden = !items.length;
			picker.replaceWith(next);
		}
	};
	
	Zotero.QLab.handleComposerAtPick = async function (host, itemId) {
		let items = host._qlabAtPickerItems || [];
		let item = items.find(entry => entry.id === itemId);
		let status = host.querySelector('.qlab-shell-status');
		try {
			if (!item) {
				return;
			}
			await Zotero.QLab.applyComposerAtPickerItem(
				host.ownerDocument.defaultView,
				item
			);
			let textarea = host.querySelector('[data-qlab-prompt]');
			if (textarea) {
				let value = textarea.value || '';
				let pos = typeof textarea.selectionStart === 'number'
					? textarea.selectionStart
					: value.length;
				// Remove the trailing @token before the caret.
				let stripped = value.slice(0, pos).replace(/@\w*$/, '');
				textarea.value = stripped + value.slice(pos);
				textarea.setSelectionRange(stripped.length, stripped.length);
			}
			Zotero.QLab.hideComposerAtPicker(host);
			Zotero.QLab.refreshComposerTags(host);
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
			if (status) {
				status.textContent = e.message || String(e);
			}
		}
	};
	
	/**
	 * Apply a chat reply into the live QMD buffer. User-initiated only: this is a
	 * human edit that still has to go through Save, never an agent write.
	 * Prefers the first fenced code block when present.
	 */
	Zotero.QLab.applyChatMessageToQmd = function (host, messageID, { asQuote = false } = {}) {
		let status = host && host.querySelector('.qlab-shell-status');
		try {
			let message = Zotero.QLab.getChatMessage(host, messageID);
			if (!message || !message.text.trim()) {
				throw new Error('Nothing to insert');
			}
			let text = message.text;
			if (!asQuote && Zotero.QLab.extractFirstFencedMarkdown) {
				let fenced = Zotero.QLab.extractFirstFencedMarkdown(text);
				if (fenced) {
					text = fenced;
				}
			}
			let snippet = asQuote
				? Zotero.QLab.buildQuoteSnippet({ text, title: 'Chat' })
				: Zotero.QLab.buildChatSnippet({ text });
			let win = host.ownerDocument.defaultView;
			let result = Zotero.QLab.insertIntoQmd(win, snippet, {
				label: asQuote ? 'Chat quote' : 'Chat reply',
			});
			if (status) {
				status.textContent = result
					? 'Applied to QMD as pending — review, then Save'
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
	 * ⌘K: write or rewrite at the current anchor. Runs in `ask` mode and lands
	 * as a pending region, so it never touches the Draft file or Keep.
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
		let stop = bar && bar.querySelector('[data-qlab-inline-stop]');
		try {
			if (workspaceState !== 'ready') {
				throw new Error('Choose a ready QLab workspace first');
			}
			let task = String(instruction || '').trim();
			if (!task) {
				throw new Error('Describe what to write');
			}
			let anchor = Zotero.QLab.resolveQmdAnchor(host, { forInlineWrite: true });
			let replace = anchor.mode === 'replace-block' || anchor.mode === 'replace-range';
			let selectedText = replace
				? Zotero.QLab.qmdAnchorSelectedText(host, anchor)
				: '';
			let buffer = Zotero.QLab.getQmdShellBuffer(host);
			let context = Zotero.QLab.qmdAnchorContext(buffer, anchor);
			let state = host._qlabDraftState;
			let prompt = Zotero.QLab.buildQmdInlineWritePrompt({
				instruction: task,
				composerContext: composerContextBlock(),
				before: context.before,
				after: context.after,
				draftPath: state ? state.originalPath : '',
				replace,
				selectedText,
			});
			
			let providerId = Zotero.QLab.Settings.getAgentProviderId();
			let model = Zotero.QLab.Settings.getAgentModel
				? Zotero.QLab.Settings.getAgentModel()
				: '';
			let runtime = Zotero.QLab.getAgentRuntime();
			if (!runtime) {
				throw new Error('AgentRuntime is unavailable');
			}
			if (submit) {
				submit.disabled = true;
			}
			if (stop) {
				stop.hidden = false;
			}
			if (status) {
				status.textContent = replace
					? `Rewriting selection via ${providerId}…`
					: `Writing at the anchor via ${providerId}…`;
			}
			
			let chunks = [];
			let cancelled = false;
			let turn = runtime.startTurn({
				mode: 'ask',
				workspaceRoot: root,
				prompt,
				providerId,
				model: model || undefined,
				attachments: [{ kind: 'policy', readOnly: true }],
			});
			host._qlabTurnHandle = turn;
			for await (let event of turn) {
				if (event.type === 'text-delta' && event.text) {
					chunks.push(event.text);
				}
				else if (event.type === 'done' && event.status === 'cancelled') {
					cancelled = true;
				}
				else if (event.type === 'error') {
					throw new Error(event.message);
				}
			}
			
			let written = Zotero.QLab.stripQmdAnswerFence(chunks.join(''));
			if (!written.trim()) {
				if (cancelled) {
					if (status) {
						status.textContent = 'Write cancelled';
					}
					return;
				}
				throw new Error('The provider returned nothing to insert');
			}
			if (host._qlabQmdWorkspace && state && state.originalPath) {
				await host._qlabQmdWorkspace.saveNow();
				let composed = Zotero.QLab.composeQmdInsertion(buffer, anchor, written);
				if (!composed.changed) throw new Error('Nothing changed');
				let ioHost = Zotero.QLab.QmdDraftIO.createGeckoHost();
				let prepared = await Zotero.QLab.QmdDraftIO.prepareChange(
					root,
					state.originalPath,
					ioHost
				);
				await Zotero.QLab.QmdDraftIO.writeSource(
					root,
					prepared.workingPath,
					composed.source,
					null,
					ioHost
				);
				await host._qlabQmdWorkspace.attachProposal(
					prepared,
					composed.source,
					prepared.text
				);
			}
			else {
				Zotero.QLab.insertIntoQmd(host.ownerDocument.defaultView, written, {
					anchor,
					label: `⌘K ${task.slice(0, 32)}`,
				});
			}
			if (bar) {
				bar.hidden = true;
				let input = bar.querySelector('[data-qlab-inline-prompt]');
				if (input) {
					input.value = '';
				}
			}
			if (status) {
				status.textContent = host._qlabQmdWorkspace
					? 'AI proposal ready — compare, then Keep or Reject'
					: (cancelled
						? 'Partial write kept in the buffer — review, then Save'
						: 'Written into the buffer — review, then Save');
			}
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
			if (status) {
				status.textContent = e.message || String(e);
			}
		}
		finally {
			host._qlabTurnHandle = null;
			if (submit) {
				submit.disabled = false;
			}
			if (stop) {
				stop.hidden = true;
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
	
	function composerContextBlock(host, { chatMode } = {}) {
		if (Zotero.QLab.ChatComposerContext
				&& Zotero.QLab.ChatComposerContext.list().length) {
			return Zotero.QLab.ChatComposerContext.formatForPrompt();
		}
		if (chatMode === 'ask') {
			return '<composer_context>\n(no pinned context — use ⌘L or @)\n</composer_context>';
		}
		return '';
	}

	Zotero.QLab.updateChatContextMeter = function (host) {
		let meter = host && host.querySelector('[data-qlab-context-meter]');
		if (!meter) {
			return;
		}
		let tags = Zotero.QLab.ChatComposerContext
			? Zotero.QLab.ChatComposerContext.list()
			: [];
		let tagChars = tags.reduce((n, t) => n + String(t.text || '').length, 0);
		let transcript = Zotero.QLab.buildChatTranscriptPrompt(host._qlabMessages || [], {
			maxTurns: 8,
			maxChars: 1_000_000,
		});
		let maxChars = Zotero.QLab.Settings && Zotero.QLab.Settings.getChatTranscriptMaxChars
			? Zotero.QLab.Settings.getChatTranscriptMaxChars()
			: 24_000;
		let total = tagChars + transcript.length;
		meter.textContent = `${Math.min(total, maxChars).toLocaleString()} / ${maxChars.toLocaleString()} ctx`;
	};

	Zotero.QLab.renderChatApprovalCard = function (host, event) {
		let output = host && host.querySelector('[data-qlab-output]');
		if (!output) {
			return;
		}
		let card = host.ownerDocument.createElement('article');
		card.className = 'qlab-chat-approval';
		card.dataset.qlabApprovalId = event.approvalId || '';
		Zotero.QLab.setHTML(card,
			`<header>Approval required</header>`
			+ `<p>${escapeHTML(event.reason || 'Agent requests permission')}</p>`
			+ (event.tool ? `<p class="qlab-chat-approval-tool">${escapeHTML(event.tool)}</p>` : '')
			+ `<div class="qlab-chat-message-actions">`
			+ `<button type="button" class="is-primary" data-qlab-approval-allow>Allow once</button>`
			+ `<button type="button" data-qlab-approval-deny>Deny</button>`
			+ `</div>`
		);
		output.appendChild(card);
		output.scrollTop = output.scrollHeight;
	};

	Zotero.QLab.waitForChatApproval = function (host, event) {
		return new Promise((resolve) => {
			host._qlabApprovalResolver = resolve;
			host._qlabPendingApproval = event;
			Zotero.QLab.renderChatApprovalCard(host, event);
		});
	};

	Zotero.QLab.resolveChatApproval = function (host, allowed) {
		let resolver = host && host._qlabApprovalResolver;
		host._qlabApprovalResolver = null;
		host._qlabPendingApproval = null;
		if (resolver) {
			resolver(!!allowed);
		}
	};

	async function processAgentStream(host, turn, reply, chunks, status) {
		let cancelled = false;
		for await (let event of turn) {
			if (event.type === 'text-delta') {
				chunks.push(event.text || '');
				Zotero.QLab.updateChatMessage(host, reply.id, chunks.join(''));
			}
			else if (event.type === 'error') {
				chunks.push(`\n[error] ${event.message}`);
				Zotero.QLab.updateChatMessage(host, reply.id, chunks.join(''));
			}
			else if (event.type === 'approval-needed') {
				let policy = host._qlabApprovalPolicy;
				if (!policy && host._qlabMountRoot && Zotero.QLab.loadApprovalPolicy) {
					policy = await Zotero.QLab.loadApprovalPolicy(host._qlabMountRoot);
					host._qlabApprovalPolicy = policy;
				}
				let decision = Zotero.QLab.evaluateApproval(policy, event);
				if (decision === 'allow') {
					chunks.push(`\n[approved] ${event.reason}\n`);
					continue;
				}
				if (decision === 'deny') {
					chunks.push(`\n[denied] ${event.reason}\n`);
					if (turn.cancel) {
						turn.cancel();
					}
					break;
				}
				let approved = await Zotero.QLab.waitForChatApproval(host, event);
				if (!approved) {
					chunks.push(`\n[denied] ${event.reason}\n`);
					if (turn.cancel) {
						turn.cancel();
					}
					break;
				}
				chunks.push(`\n[approved] ${event.reason}\n`);
			}
			else if (event.type === 'done' && event.status === 'cancelled') {
				cancelled = true;
			}
		}
		return cancelled;
	}

	Zotero.QLab.editChatMessage = function (host, messageID) {
		let message = Zotero.QLab.getChatMessage(host, messageID);
		let textarea = host && host.querySelector('[data-qlab-prompt]');
		if (!message || !textarea || message.role !== 'user') {
			return;
		}
		textarea.value = message.text;
		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
	};

	Zotero.QLab.regenerateChatMessage = async function (host, messageID, root, workspaceState) {
		if (!host) {
			return;
		}
		let idx = (host._qlabMessages || []).findIndex(m => m.id === messageID);
		if (idx < 0) {
			return;
		}
		let message = host._qlabMessages[idx];
		if (message.role !== 'assistant') {
			return;
		}
		let userIdx = idx - 1;
		while (userIdx >= 0 && host._qlabMessages[userIdx].role !== 'user') {
			userIdx--;
		}
		if (userIdx < 0) {
			return;
		}
		let userText = host._qlabMessages[userIdx].text;
		host._qlabMessages = host._qlabMessages.slice(0, userIdx);
		Zotero.QLab.renderChatMessages(host);
		let textarea = host.querySelector('[data-qlab-prompt]');
		if (textarea) {
			textarea.value = userText;
		}
		await Zotero.QLab.runShellFreeform(host, root, workspaceState);
	};

	Zotero.QLab.hideAgentDraftBanner = function (host) {
		let banner = host && host.querySelector('[data-qlab-agent-banner]');
		if (banner) {
			banner.hidden = true;
			banner.replaceChildren();
		}
	};

	Zotero.QLab.maybeShowAgentDraftBanner = async function (host, root) {
		if (!host || !root) {
			return;
		}
		let qmd = host.ownerDocument.defaultView.Zotero_Tabs
			&& host.ownerDocument.defaultView.Zotero_Tabs._tabs
			&& host.ownerDocument.defaultView.Zotero_Tabs._tabs.find(
				t => t.type === 'qlabqmd' || t.id === 'qlabqmd'
			);
		let qmdHost = null;
		if (qmd) {
			let container = host.ownerDocument.getElementById(qmd.id);
			qmdHost = container && container.querySelector('.qlab-shell-host');
		}
		let state = qmdHost && qmdHost._qlabDraftState;
		if (!state || !state.workingPath) {
			Zotero.QLab.hideAgentDraftBanner(host);
			return;
		}
		let banner = host.querySelector('[data-qlab-agent-banner]');
		if (!banner) {
			return;
		}
		banner.hidden = false;
		Zotero.QLab.setHTML(banner,
			`<span>AI modified <strong>${escapeHTML(state.originalPath || 'Draft')}</strong> in the working copy.</span>`
			+ `<div class="qlab-chat-message-actions">`
			+ `<button type="button" class="is-primary" data-qlab-agent-keep>Keep</button>`
			+ `<button type="button" data-qlab-agent-discard>Discard banner</button>`
			+ `</div>`
		);
	};

	Zotero.QLab.keepAgentDraftFromChat = async function (host, root) {
		let win = host.ownerDocument.defaultView;
		let qmd = win.Zotero_Tabs && win.Zotero_Tabs._tabs.find(
			t => t.type === 'qlabqmd' || t.id === 'qlabqmd'
		);
		if (!qmd) {
			return;
		}
		win.Zotero_Tabs.select(qmd.id);
		let container = win.document.getElementById(qmd.id);
		let qmdHost = container && container.querySelector('.qlab-shell-host');
		if (qmdHost) {
			await Zotero.QLab.keepDraftFromShell(qmdHost, root);
		}
		Zotero.QLab.hideAgentDraftBanner(host);
	};
	
	Zotero.QLab.runShellFreeform = async function (host, root, workspaceState) {
		let textarea = host.querySelector('[data-qlab-prompt]');
		let status = host.querySelector('.qlab-shell-status');
		try {
			if (host._qlabTurnHandle) {
				throw new Error('A turn is already running — Stop it first');
			}
			if (workspaceState !== 'ready') {
				throw new Error('Choose a ready QLab workspace first');
			}
			let userText = textarea ? textarea.value.trim() : '';
			if (!userText) {
				throw new Error('Enter a prompt');
			}
			let providerId = Zotero.QLab.Settings.getAgentProviderId();
			let model = Zotero.QLab.Settings.getAgentModel
				? Zotero.QLab.Settings.getAgentModel()
				: '';
			let chatMode = Zotero.QLab.Settings.getChatMode
				? Zotero.QLab.Settings.getChatMode()
				: 'ask';
			let runtime = Zotero.QLab.getAgentRuntime();
			if (!runtime) {
				throw new Error('AgentRuntime is unavailable');
			}
			
			// Fail closed when the local CLI is missing -- never silent-fail.
			try {
				let provider = runtime._registry && runtime._registry.get(providerId);
				if (provider && typeof provider.refreshStatus === 'function') {
					await provider.refreshStatus();
				}
				if (provider && provider.status === 'unavailable') {
					throw new Error(
						providerId === 'codex-cli'
							? 'Codex CLI unavailable — install Codex or switch provider.'
							: `Provider ${providerId} is unavailable.`
					);
				}
			}
			catch (e) {
				if (/unavailable/i.test(e.message || '')) {
					throw e;
				}
			}
			
			Zotero.QLab.appendChatMessage(host, { role: 'user', text: userText });
			if (textarea) {
				textarea.value = '';
			}
			Zotero.QLab.hideComposerAtPicker(host);
			
			if (!host._qlabThreadId) {
				host._qlabThreadId = newThreadId();
			}
			let context = composerContextBlock(host, { chatMode });
			let rules = Zotero.QLab.loadChatRulesPreamble
				? await Zotero.QLab.loadChatRulesPreamble(root)
				: '';
			let maxChars = Zotero.QLab.Settings && Zotero.QLab.Settings.getChatTranscriptMaxChars
				? Zotero.QLab.Settings.getChatTranscriptMaxChars()
				: 24_000;
			let transcript = Zotero.QLab.buildChatTranscriptPrompt(host._qlabMessages, {
				maxTurns: 8,
				maxChars,
				excludeTrailingAssistant: true,
			});
			let prompt = [rules, context, transcript].filter(Boolean).join('\n\n');
			Zotero.QLab.updateChatContextMeter(host);
			
			let reply = Zotero.QLab.appendChatMessage(host, { role: 'assistant', text: '' });
			let chunks = [];
			let cancelled = false;
			if (status) {
				status.textContent = `Sending via ${providerId}…`;
			}
			setChatTurnRunning(host, true);
			
			let turn = runtime.startTurn({
				mode: chatMode === 'agent' ? 'agent' : 'ask',
				workspaceRoot: root,
				prompt,
				providerId,
				model: model || undefined,
				threadId: host._qlabThreadId,
				attachments: chatMode === 'agent'
					? []
					: [{ kind: 'policy', readOnly: true }],
			});
			host._qlabTurnHandle = turn;
			
			cancelled = await processAgentStream(host, turn, reply, chunks, status);
			
			let finalText = chunks.join('');
			if (!finalText.trim()) {
				finalText = cancelled ? '(cancelled)' : '(empty response)';
			}
			Zotero.QLab.updateChatMessage(host, reply.id, finalText, {
				status: cancelled ? 'cancelled' : '',
			});
			if (status) {
				status.textContent = cancelled ? 'Cancelled' : 'Done';
			}
			if (!cancelled && chatMode === 'agent') {
				await Zotero.QLab.maybeShowAgentDraftBanner(host, root);
			}
			void Zotero.QLab.persistChatHost(host, root);
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
			if (status) {
				status.textContent = e.message || String(e);
			}
		}
		finally {
			host._qlabTurnHandle = null;
			setChatTurnRunning(host, false);
			void Zotero.QLab.refreshChatProviderAvailability(host);
		}
	};
	
	Zotero.QLab.regenerateLastChatTurn = async function (host, root, workspaceState) {
		if (!host) {
			return;
		}
		if (host._qlabTurnHandle) {
			Zotero.QLab.cancelShellTurn(host);
		}
		let messages = host._qlabMessages || [];
		let lastUserIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'user') {
				lastUserIdx = i;
				break;
			}
		}
		if (lastUserIdx < 0) {
			let status = host.querySelector('.qlab-shell-status');
			if (status) {
				status.textContent = 'Nothing to regenerate';
			}
			return;
		}
		let userText = messages[lastUserIdx].text;
		host._qlabMessages = messages.slice(0, lastUserIdx);
		Zotero.QLab.renderChatMessages(host);
		let textarea = host.querySelector('[data-qlab-prompt]');
		if (textarea) {
			textarea.value = userText;
		}
		await Zotero.QLab.runShellFreeform(host, root, workspaceState);
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
			let readerBlock = composerContextBlock(host, { chatMode: readOnly ? 'ask' : 'agent' });
			if (readerBlock) {
				prompt = `${readerBlock}\n\n${prompt}`;
			}
			let rules = Zotero.QLab.loadChatRulesPreamble
				? await Zotero.QLab.loadChatRulesPreamble(root)
				: '';
			if (rules) {
				prompt = `${rules}\n\n${prompt}`;
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
			let cancelled = false;
			Zotero.QLab.appendChatMessage(host, { role: 'user', text: `/${actionID}` });
			let reply = Zotero.QLab.appendChatMessage(host, { role: 'assistant', text: '' });
			if (!host._qlabThreadId) {
				host._qlabThreadId = newThreadId();
			}
			let model = Zotero.QLab.Settings.getAgentModel
				? Zotero.QLab.Settings.getAgentModel()
				: '';
			setChatTurnRunning(host, true);
			let turn = runtime.startTurn({
				mode: readOnly ? 'ask' : 'agent',
				workspaceRoot: root,
				prompt,
				providerId,
				model: model || undefined,
				threadId: host._qlabThreadId,
				attachments: readOnly ? [{ kind: 'policy', readOnly: true }] : [],
			});
			host._qlabTurnHandle = turn;
			cancelled = await processAgentStream(host, turn, reply, chunks, status);
			Zotero.QLab.updateChatMessage(host, reply.id, chunks.join('') || '(empty)', {
				status: cancelled ? 'cancelled' : '',
			});
			if (!cancelled && !readOnly) {
				await Zotero.QLab.maybeShowAgentDraftBanner(host, root);
			}
			void Zotero.QLab.persistChatHost(host, root);
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
			if (status) {
				status.textContent = e.message || String(e);
			}
		}
		finally {
			host._qlabTurnHandle = null;
			setChatTurnRunning(host, false);
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
					// Heal TabGroups if it still keys the singleton by kind name
					// while the live tab kept a restored random id.
					if (existing.id !== kind && groups.tab(kind) && !groups.tab(existing.id)) {
						try {
							groups.rekeyTab(kind, existing.id);
						}
						catch (e) {
							Zotero.logError && Zotero.logError(e);
						}
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
				let shellTabID = '';
				let { id, container } = tabsAPI.add({
					id: kind,
					type: kind,
					title: titles[kind] || kind,
					data: payload || {},
					select: false,
					onClose: () => {
						try {
							let shell = typeof document !== 'undefined'
								? document.getElementById(shellTabID)
								: null;
							shell?.querySelector('.qlab-shell-host')?._qlabQmdWorkspace?.dispose();
						}
						catch (e) {
							Zotero.logError && Zotero.logError(e);
						}
					},
				});
				shellTabID = id;
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
