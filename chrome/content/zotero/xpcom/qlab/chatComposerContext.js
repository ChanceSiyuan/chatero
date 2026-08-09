/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Cursor-like Chat composer context tags (⌘L).
 * Tags sit in the composer like @-mentions: removable, clickable to reveal source.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const MAX_TEXT = 8000;
	const MAX_TAGS = 12;
	
	function escapeHTML(value) {
		return String(value || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}
	
	function truncate(text, n) {
		let value = String(text || '').replace(/\s+/g, ' ').trim();
		if (value.length <= n) {
			return value;
		}
		return `${value.slice(0, n - 1)}…`;
	}
	
	function nextId(prefix) {
		return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	}
	
	Zotero.QLab.ChatComposerContext = {
		_tags: [],
		
		list() {
			return this._tags.slice();
		},
		
		clear() {
			this._tags = [];
		},
		
		get(id) {
			return this._tags.find(t => t.id === id) || null;
		},
		
		remove(id) {
			this._tags = this._tags.filter(t => t.id !== id);
			return this.list();
		},
		
		/**
		 * Upsert by stableKey when provided (e.g. one selection chip at a time).
		 */
		add(tag) {
			if (!tag || !tag.kind) {
				throw new Error('Context tag requires kind');
			}
			let entry = {
				id: tag.id || nextId(tag.kind),
				stableKey: tag.stableKey || null,
				kind: tag.kind,
				label: String(tag.label || tag.kind),
				detail: String(tag.detail || ''),
				text: String(tag.text || '').slice(0, MAX_TEXT),
				origin: tag.origin ? Object.freeze({ ...tag.origin }) : null,
				removable: tag.removable !== false,
				addedAt: tag.addedAt || new Date().toISOString(),
			};
			if (entry.stableKey) {
				this._tags = this._tags.filter(t => t.stableKey !== entry.stableKey);
			}
			this._tags.push(Object.freeze(entry));
			if (this._tags.length > MAX_TAGS) {
				this._tags = this._tags.slice(-MAX_TAGS);
			}
			return entry;
		},
		
		/**
		 * Build prompt block for AgentRuntime (user-authored attachments).
		 */
		formatForPrompt(tags) {
			let list = tags || this._tags;
			if (!list.length) {
				return '';
			}
			let parts = ['<composer_context>'];
			for (let tag of list) {
				parts.push(`[@${tag.kind} ${tag.label}]`);
				if (tag.detail) {
					parts.push(`detail: ${tag.detail}`);
				}
				if (tag.origin) {
					parts.push(`origin: ${JSON.stringify(tag.origin)}`);
				}
				if (tag.text) {
					parts.push(tag.text);
				}
				parts.push('');
			}
			parts.push('</composer_context>');
			return parts.join('\n').trim();
		},
	};
	
	/**
	 * Create a PDF context tag from ReaderContextStore snapshot / event capture.
	 */
	Zotero.QLab.createPdfComposerTag = function (context, preference = 'auto') {
		if (!context || !context.attachment) {
			throw new Error('No PDF context to attach');
		}
		let title = (context.parent && context.parent.title)
			|| context.attachment.filename
			|| 'PDF';
		let shortTitle = truncate(title, 28);
		let prefer = preference;
		if (prefer === 'auto') {
			if (context.selection && context.selection.text) {
				prefer = 'selection';
			}
			else if (context.page) {
				prefer = 'page';
			}
			else {
				prefer = 'paper';
			}
		}
		
		if (prefer === 'selection' && context.selection && context.selection.text) {
			let text = context.selection.text;
			return {
				stableKey: `pdf-selection:${context.attachment.id}`,
				kind: 'pdf-selection',
				label: `${shortTitle} · sel`,
				detail: `p.${context.selection.pageNumber} · ${text.length} chars`,
				text,
				origin: {
					type: 'pdf',
					itemID: context.attachment.id,
					libraryID: context.attachment.libraryID,
					key: context.attachment.key,
					pageIndex: context.selection.pageIndex,
					pageNumber: context.selection.pageNumber,
					selectionText: text.slice(0, 200),
				},
			};
		}
		
		if (prefer === 'page' && context.page) {
			return {
				stableKey: `pdf-page:${context.attachment.id}:${context.page.pageIndex}`,
				kind: 'pdf-page',
				label: `${shortTitle} · p.${context.page.pageNumber}`,
				detail: context.page.text
					? `Page text · ${context.page.text.length} chars`
					: `Page ${context.page.pageNumber}`,
				text: context.page.text || `Page ${context.page.pageNumber} of ${title}`,
				origin: {
					type: 'pdf',
					itemID: context.attachment.id,
					libraryID: context.attachment.libraryID,
					key: context.attachment.key,
					pageIndex: context.page.pageIndex,
					pageNumber: context.page.pageNumber,
				},
			};
		}
		
		return {
			stableKey: `pdf-paper:${context.attachment.id}`,
			kind: 'pdf-paper',
			label: shortTitle,
			detail: title,
			text: `Paper: ${title}\nAttachmentID: ${context.attachment.id}`,
			origin: {
				type: 'pdf',
				itemID: context.attachment.id,
				libraryID: context.attachment.libraryID,
				key: context.attachment.key,
			},
		};
	};
	
	/**
	 * Create a QMD context tag from the live editor shell.
	 */
	Zotero.QLab.createQmdComposerTag = function ({
		relativePath = '',
		source = '',
		selection = '',
		blockIndex = null,
		surfaceMode = 'source',
	} = {}) {
		if (!relativePath && !source && !selection) {
			throw new Error('No QMD context to attach');
		}
		let path = relativePath || 'draft.qmd';
		let short = truncate(path.replace(/^drafts\//, ''), 32);
		if (selection && selection.trim()) {
			let text = selection.trim().slice(0, MAX_TEXT);
			return {
				stableKey: `qmd-selection:${path}`,
				kind: 'qmd-selection',
				label: `${short} · sel`,
				detail: `${text.length} chars · ${surfaceMode}`,
				text,
				origin: {
					type: 'qmd',
					relativePath: path,
					surfaceMode,
					hasSelection: true,
				},
			};
		}
		if (Number.isInteger(blockIndex) && source) {
			let blocks = Zotero.QLab.visualQmdBlocks
				? Zotero.QLab.visualQmdBlocks(source)
				: [];
			let block = blocks[blockIndex];
			if (block) {
				return {
					stableKey: `qmd-block:${path}:${blockIndex}`,
					kind: 'qmd-block',
					label: `${short} · ${block.kind}`,
					detail: truncate(block.source, 80),
					text: block.source.slice(0, MAX_TEXT),
					origin: {
						type: 'qmd',
						relativePath: path,
						surfaceMode: 'visual',
						blockIndex,
						start: block.start,
						end: block.end,
					},
				};
			}
		}
		let body = String(source || '').slice(0, MAX_TEXT);
		return {
			stableKey: `qmd-file:${path}`,
			kind: 'qmd-file',
			label: short,
			detail: `Live QMD · ${body.length} chars`,
			text: body || path,
			origin: {
				type: 'qmd',
				relativePath: path,
				surfaceMode,
			},
		};
	};
	
	Zotero.QLab.renderComposerTagsHTML = function (tags) {
		let list = tags || Zotero.QLab.ChatComposerContext.list();
		if (!list.length) {
			return `<div class="qlab-composer-tags" data-qlab-context-tags>`
				+ `<span class="qlab-composer-tags-empty">⌘L to pin PDF / QMD context</span></div>`;
		}
		let chips = list.map(tag => (
			`<span class="qlab-context-tag is-${escapeHTML(tag.kind)}" data-qlab-tag-id="${escapeHTML(tag.id)}">`
			+ `<button type="button" class="qlab-context-tag-body" data-qlab-tag-reveal `
			+ `title="${escapeHTML(tag.detail || 'Reveal source')}">${escapeHTML(tag.label)}</button>`
			+ (tag.removable
				? `<button type="button" class="qlab-context-tag-remove" data-qlab-tag-remove `
					+ `aria-label="Remove ${escapeHTML(tag.label)}" title="Remove">×</button>`
				: '')
			+ `</span>`
		)).join('');
		return `<div class="qlab-composer-tags" data-qlab-context-tags>${chips}</div>`;
	};
	
	/**
	 * Refresh tag row inside an already-mounted chat host.
	 */
	Zotero.QLab.refreshComposerTags = function (host) {
		if (!host) {
			return;
		}
		let row = host.querySelector('[data-qlab-context-tags]');
		if (!row) {
			return;
		}
		let wrap = host.ownerDocument.createElement('div');
		Zotero.QLab.setHTML(wrap, Zotero.QLab.renderComposerTagsHTML());
		let next = wrap.firstElementChild;
		if (next) {
			row.replaceWith(next);
		}
	};
	
	/**
	 * Reveal the window-owned Chat utility without rearranging the PDF/QMD panes.
	 * The historical name remains for action-call compatibility.
	 */
	Zotero.QLab.ensureChatPaneVisible = async function (win, { itemID } = {}) {
		let tabs = win && win.Zotero_Tabs;
		if (!tabs) {
			return null;
		}
		let chat = tabs._tabs.find(t => t.type === 'qlabchat' || t.id === 'qlabchat');
		if (chat && tabs.isTabVisible && tabs.isTabVisible(chat.id)) {
			return chat.id;
		}
		if (tabs._qlab && tabs._qlab.showUtility) {
			await tabs._qlab.showUtility(
				'qlabchat',
				Number.isFinite(itemID) ? { primaryItemID: itemID } : null,
				{ invocation: 'chat-context', focusComposer: false }
			);
			chat = tabs._tabs.find(t => t.type === 'qlabchat' || t.id === 'qlabchat');
			return chat ? chat.id : 'qlabchat';
		}
		return chat ? chat.id : null;
	};
	
	/**
	 * Focus chat composer after adding a tag (Cursor ⌘L).
	 * When Chat is already visible, default is no focus steal; ⌘⇧L always
	 * passes focus:false. Selection stays in Reader / QMD unless focus is set.
	 */
	Zotero.QLab.focusChatComposer = function (win, options = {}) {
		let windowRef = win || (typeof Zotero !== 'undefined' && Zotero.getMainWindow && Zotero.getMainWindow());
		if (!windowRef || !windowRef.Zotero_Tabs) {
			return;
		}
		let chat = windowRef.Zotero_Tabs._tabs.find(t => t.type === 'qlabchat' || t.id === 'qlabchat');
		if (!chat) {
			return;
		}
		let visible = windowRef.Zotero_Tabs.isTabVisible
			&& windowRef.Zotero_Tabs.isTabVisible(chat.id);
		if (!visible && options.select !== false
				&& windowRef.Zotero_Tabs._qlab?.showUtility) {
			void windowRef.Zotero_Tabs._qlab.showUtility('qlabchat', null, {
				invocation: 'composer-focus',
				focusComposer: options.focus === true,
			});
		}
		let container = windowRef.document.getElementById('qlab-chat-utility-content');
		let host = container && container.querySelector('.qlab-shell-host');
		if (host) {
			Zotero.QLab.refreshComposerTags(host);
			let textarea = host.querySelector('[data-qlab-prompt]');
			if (textarea && options.focus) {
				textarea.focus();
			}
		}
	};
	
	/**
	 * Candidates for the composer `@` picker (Current PDF / Draft / Readers).
	 */
	Zotero.QLab.listComposerAtPickerItems = function (win, { query = '' } = {}) {
		let windowRef = win || (typeof Zotero !== 'undefined' && Zotero.getMainWindow && Zotero.getMainWindow());
		let items = [];
		let q = String(query || '').trim();
		try {
			let ctx = Zotero.QLab.ReaderContextStore && Zotero.QLab.ReaderContextStore.get();
			if (ctx && ctx.attachment) {
				let title = (ctx.parent && ctx.parent.title)
					|| ctx.attachment.filename
					|| 'Current PDF';
				items.push({
					id: 'current-pdf',
					kind: 'pdf',
					label: `PDF · ${truncate(title, 36)}`,
					preference: 'auto',
				});
				if (ctx.page && ctx.page.pageNumber) {
					items.push({
						id: 'current-pdf-page',
						kind: 'pdf',
						label: `PDF · p.${ctx.page.pageNumber}`,
						preference: 'page',
					});
				}
				if (ctx.selection && ctx.selection.text) {
					items.push({
						id: 'current-pdf-selection',
						kind: 'pdf',
						label: `PDF · selection (${ctx.selection.text.length} chars)`,
						preference: 'selection',
					});
				}
			}
		}
		catch (e) {}
		
		try {
			let tabs = windowRef && windowRef.Zotero_Tabs;
			let qmd = tabs && tabs._tabs.find(t => t.type === 'qlabqmd' || t.id === 'qlabqmd');
			if (qmd) {
				let container = windowRef.document.getElementById(qmd.id);
				let host = container && container.querySelector('.qlab-shell-host');
				let state = host && host._qlabDraftState;
				let path = state
					? (state.viewingWorking && state.workingPath
						? state.workingPath
						: state.originalPath)
					: '';
				if (path || (host && Zotero.QLab.getQmdShellBuffer
						&& Zotero.QLab.getQmdShellBuffer(host))) {
					items.push({
						id: 'current-draft',
						kind: 'qmd',
						label: path
							? `Draft · ${truncate(path.replace(/^drafts\//, ''), 36)}`
							: 'Current Draft',
						relativePath: path,
					});
					if (host && Number.isInteger(host._qlabActiveBlockIndex)) {
						items.push({
							id: 'current-draft-block',
							kind: 'qmd-block',
							label: `Draft · block ${host._qlabActiveBlockIndex + 1}`,
							relativePath: path,
							blockIndex: host._qlabActiveBlockIndex,
						});
					}
				}
			}
		}
		catch (e) {}
		
		try {
			let readers = (Zotero.Reader && Zotero.Reader._readers) || [];
			for (let reader of readers) {
				if (!reader || !reader.itemID) {
					continue;
				}
				let item = Zotero.Items && Zotero.Items.get && Zotero.Items.get(reader.itemID);
				let label = (item && (item.attachmentFilename || item.getField && item.getField('title')))
					|| `Reader ${reader.itemID}`;
				items.push({
					id: `reader-${reader.itemID}`,
					kind: 'reader',
					label: `Reader · ${truncate(label, 36)}`,
					itemID: reader.itemID,
					reader,
				});
			}
		}
		catch (e) {}

		if (q) {
			let lower = q.toLowerCase();
			items = items.filter(item => item.label.toLowerCase().includes(lower));
		}

		return items;
	};
	
	Zotero.QLab.renderComposerAtPickerHTML = function (items) {
		let list = items || [];
		if (!list.length) {
			return `<div class="qlab-at-picker" data-qlab-at-picker hidden>`
				+ `<div class="qlab-at-picker-empty">No PDF or Draft context</div></div>`;
		}
		let rows = list.map(item => (
			`<button type="button" class="qlab-at-picker-item" data-qlab-at-pick="${escapeHTML(item.id)}">`
			+ `${escapeHTML(item.label)}</button>`
		)).join('');
		return `<div class="qlab-at-picker" data-qlab-at-picker hidden>${rows}</div>`;
	};
	
	/**
	 * Apply one `@` picker choice into ChatComposerContext via existing add().
	 */
	Zotero.QLab.applyComposerAtPickerItem = async function (win, item) {
		if (!item) {
			return null;
		}
		let windowRef = win || Zotero.getMainWindow();
		if (item.kind === 'pdf' || item.kind === 'reader') {
			if (item.reader && Zotero.QLab.ReaderContextStore) {
				await Zotero.QLab.ReaderContextStore.captureFromEvent({
					reader: item.reader,
					params: {},
				});
			}
			let ctx = Zotero.QLab.ReaderContextStore && Zotero.QLab.ReaderContextStore.get();
			if (!ctx) {
				throw new Error('No PDF context to attach');
			}
			let tag = Zotero.QLab.createPdfComposerTag(ctx, item.preference || 'auto');
			return Zotero.QLab.ChatComposerContext.add(tag);
		}
		if (item.kind === 'qmd' || item.kind === 'qmd-block') {
			let tabs = windowRef && windowRef.Zotero_Tabs;
			let qmd = tabs && tabs._tabs.find(t => t.type === 'qlabqmd' || t.id === 'qlabqmd');
			let container = qmd && windowRef.document.getElementById(qmd.id);
			let host = container && container.querySelector('.qlab-shell-host');
			let state = host && host._qlabDraftState;
			let path = item.relativePath || (state
				? (state.viewingWorking && state.workingPath
					? state.workingPath
					: state.originalPath)
				: '');
			let source = host && Zotero.QLab.getQmdShellBuffer
				? Zotero.QLab.getQmdShellBuffer(host)
				: '';
			let blockIndex = item.kind === 'qmd-block' ? item.blockIndex : null;
			let tag = Zotero.QLab.createQmdComposerTag({
				relativePath: path,
				source,
				blockIndex,
				surfaceMode: (host && host._qlabSurfaceMode) || 'source',
			});
			return Zotero.QLab.ChatComposerContext.add(tag);
		}
		if (item.kind === 'workspace-file' && item.relativePath) {
			let root = Zotero.QLab.Settings && Zotero.QLab.Settings.getRoot();
			let io = Zotero.QLab.QmdDraftIO && Zotero.QLab.QmdDraftIO.createGeckoHost
				? Zotero.QLab.QmdDraftIO.createGeckoHost()
				: null;
			let text = root && io
				? await Zotero.QLab.readWorkspaceRel(root, item.relativePath, io, {
					maxChars: MAX_TEXT,
				})
				: '';
			let tag = Zotero.QLab.createQmdComposerTag({
				relativePath: item.relativePath,
				source: text,
				surfaceMode: 'source',
			});
			return Zotero.QLab.ChatComposerContext.add(tag);
		}
		return null;
	};
	
	/**
	 * Reveal source for a composer tag (Cursor click-to-navigate).
	 */
	Zotero.QLab.revealComposerTag = async function (tag, win) {
		if (!tag || !tag.origin) {
			return;
		}
		let windowRef = win || Zotero.getMainWindow();
		if (!windowRef || !windowRef.Zotero_Tabs) {
			return;
		}
		
		if (tag.origin.type === 'pdf' && tag.origin.itemID) {
			let itemID = tag.origin.itemID;
			let tabID = windowRef.Zotero_Tabs.getTabIDByItemID
				&& windowRef.Zotero_Tabs.getTabIDByItemID(itemID);
			if (!tabID && Zotero.Reader && Zotero.Reader.open) {
				let location = {};
				if (Number.isInteger(tag.origin.pageIndex)) {
					location.pageIndex = tag.origin.pageIndex;
				}
				let reader = await Zotero.Reader.open(itemID, location);
				tabID = reader && reader.tabID;
			}
			else if (tabID) {
				windowRef.Zotero_Tabs.select(tabID);
				try {
					let reader = Zotero.Reader.getByTabID && Zotero.Reader.getByTabID(tabID);
					if (reader && Number.isInteger(tag.origin.pageIndex)
							&& reader.navigate) {
						await reader.navigate({ pageIndex: tag.origin.pageIndex });
					}
				}
				catch (e) {
					Zotero.logError && Zotero.logError(e);
				}
			}
			return;
		}
		
		if (tag.origin.type === 'qmd' && tag.origin.relativePath) {
			let root = Zotero.QLab.Settings && Zotero.QLab.Settings.getRoot();
			let qmd = windowRef.Zotero_Tabs._tabs.find(t => t.type === 'qlabqmd' || t.id === 'qlabqmd');
			if (!qmd && windowRef.Zotero_Tabs._qlab) {
				windowRef.Zotero_Tabs._qlab.ensureShellTab('qlabqmd', {});
				qmd = windowRef.Zotero_Tabs._tabs.find(t => t.type === 'qlabqmd');
			}
			if (!qmd) {
				return;
			}
			windowRef.Zotero_Tabs.select(qmd.id);
			let container = windowRef.document.getElementById(qmd.id);
			let host = container && container.querySelector('.qlab-shell-host');
			if (host && root) {
				await Zotero.QLab.loadDraftIntoShell(host, root, tag.origin.relativePath);
				let mode = tag.origin.surfaceMode || 'source';
				if (Zotero.QLab.applyQmdSurfaceMode) {
					Zotero.QLab.applyQmdSurfaceMode(host, mode, { root, silent: true });
				}
				if (mode === 'source') {
					let editor = host.querySelector('[data-qlab-editor]');
					if (editor && Number.isInteger(tag.origin.start) && Number.isInteger(tag.origin.end)) {
						editor.focus();
						editor.setSelectionRange(tag.origin.start, tag.origin.end);
					}
					else if (editor && tag.text) {
						let idx = editor.value.indexOf(tag.text.slice(0, 80));
						if (idx >= 0) {
							editor.focus();
							editor.setSelectionRange(idx, idx + Math.min(tag.text.length, 200));
						}
					}
				}
				else if (mode === 'visual' && Number.isInteger(tag.origin.blockIndex)
						&& Zotero.QLab.beginQmdVisualBlockEdit) {
					Zotero.QLab.beginQmdVisualBlockEdit(host, tag.origin.blockIndex);
				}
			}
		}
	};
	
	/**
	 * ⌘L entry: attach current PDF or QMD context into Chat as a tag.
	 */
	Zotero.QLab.addCurrentContextToChat = async function (win, options = {}) {
		let windowRef = win || Zotero.getMainWindow();
		if (!windowRef || !windowRef.Zotero_Tabs) {
			throw new Error('Main window unavailable');
		}
		
		let tabs = windowRef.Zotero_Tabs;
		let selected = tabs._tabs.find(t => t.id === tabs.selectedID);
		let tag = null;
		let anchorItemID = null;
		
		// Prefer QMD shell when it is the selected tab (live Quarto draft).
		if (selected && selected.type === 'qlabqmd') {
			let container = windowRef.document.getElementById(selected.id);
			let host = container && container.querySelector('.qlab-shell-host');
			let state = host && host._qlabDraftState;
			let path = state
				? (state.viewingWorking && state.workingPath
					? state.workingPath
					: state.originalPath)
				: '';
			let source = Zotero.QLab.getQmdShellBuffer
				? Zotero.QLab.getQmdShellBuffer(host)
				: '';
			let selection = '';
			let active = host.ownerDocument.activeElement;
			let editor = (active && active.matches
					&& active.matches('[data-qlab-editor], .qlab-qmd-visual-source-editor'))
				? active
				: host.querySelector('[data-qlab-editor]');
			if (editor && typeof editor.selectionStart === 'number'
					&& editor.selectionEnd > editor.selectionStart) {
				selection = editor.value.slice(editor.selectionStart, editor.selectionEnd);
			}
			else {
				try {
					let sel = host.ownerDocument.getSelection && host.ownerDocument.getSelection();
					if (sel && String(sel).trim()) {
						selection = String(sel);
					}
				}
				catch (e) {}
			}
			tag = Zotero.QLab.createQmdComposerTag({
				relativePath: path,
				source,
				selection,
				surfaceMode: (host && host._qlabSurfaceMode) || 'source',
			});
			let primary = selected.data && selected.data.primaryItemID;
			anchorItemID = Number.isFinite(primary) ? primary : null;
		}
		else {
			// PDF Reader tab or ambient Reader context.
			let reader = Zotero.Reader.getByTabID
				&& tabs.selectedID
				&& Zotero.Reader.getByTabID(tabs.selectedID);
			if (reader && Zotero.QLab.ReaderContextStore) {
				await Zotero.QLab.ReaderContextStore.captureFromEvent({
					reader,
					params: options.params || {},
				});
			}
			let ctx = Zotero.QLab.ReaderContextStore && Zotero.QLab.ReaderContextStore.get();
			if (!ctx) {
				throw new Error('Select a PDF or open a QMD Draft first (⌘L)');
			}
			tag = Zotero.QLab.createPdfComposerTag(ctx, options.preference || 'auto');
			anchorItemID = ctx.attachment && ctx.attachment.id;
		}
		
		Zotero.QLab.ChatComposerContext.add(tag);
		
		let chat = tabs._tabs.find(t => t.type === 'qlabchat' || t.id === 'qlabchat');
		let chatAlreadyVisible = !!(chat
			&& tabs.isTabVisible
			&& tabs.isTabVisible(chat.id));
		
		await Zotero.QLab.ensureChatPaneVisible(windowRef, { itemID: anchorItemID });
		if (tabs._qlab && tabs._qlab.ensureShellTab) {
			tabs._qlab.ensureShellTab('qlabchat', {
				primaryItemID: tag.origin && tag.origin.itemID,
			});
		}
		
		// Default: do not steal focus when Chat / Research Desk is already up.
		let focusPref = Zotero.QLab.Settings && Zotero.QLab.Settings.getChatFocusOnPin
			? Zotero.QLab.Settings.getChatFocusOnPin()
			: 'whenChatVisible';
		let shouldFocus;
		if (options.focus !== undefined) {
			shouldFocus = !!options.focus;
		}
		else if (focusPref === 'always') {
			shouldFocus = true;
		}
		else if (focusPref === 'never') {
			shouldFocus = false;
		}
		else {
			shouldFocus = !chatAlreadyVisible;
		}
		Zotero.QLab.focusChatComposer(windowRef, { focus: shouldFocus });
		return tag;
	};
})();
