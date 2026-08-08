/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Apply: Chat / PDF -> the live QMD buffer.
 *
 * Authority contract (do not weaken):
 *   - Everything here is a *human* edit. It lands in the shell buffer, stays
 *     dirty, and still goes through QmdDraftIO.writeSource revision checks.
 *   - Agents never call into this module. Agent output reaches a Draft only
 *     through a working copy plus QmdDraftIO.keepChange.
 *
 * Insertions snap to visual block boundaries so a stray cursor offset can never
 * split a fence, a math block, or the YAML frontmatter.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const PROTECTED_HEAD = new Set(['frontmatter']);
	
	function normalize(text) {
		return String(text ?? '').replace(/\r\n?/g, '\n');
	}
	
	function clamp(value, min, max) {
		if (!Number.isFinite(value)) {
			return max;
		}
		return Math.min(max, Math.max(min, Math.round(value)));
	}
	
	function blocksOf(source) {
		return Zotero.QLab.visualQmdBlocks
			? Zotero.QLab.visualQmdBlocks(source)
			: [];
	}
	
	/**
	 * Move an arbitrary offset onto the nearest safe block boundary.
	 */
	Zotero.QLab.snapQmdOffset = function (source, offset) {
		let text = normalize(source);
		let blocks = blocksOf(text);
		let want = clamp(offset, 0, text.length);
		if (!blocks.length) {
			return text.length;
		}
		// Nothing may be inserted above the frontmatter.
		let floor = PROTECTED_HEAD.has(blocks[0].kind) ? blocks[0].end : 0;
		if (want <= floor) {
			return floor;
		}
		for (let block of blocks) {
			if (want <= block.start) {
				return block.start;
			}
			if (want < block.end) {
				return want - block.start <= block.end - want ? block.start : block.end;
			}
		}
		return text.length;
	};
	
	/**
	 * Resolve an anchor to a concrete insertion offset.
	 */
	Zotero.QLab.qmdAnchorOffset = function (source, anchor) {
		let text = normalize(source);
		let mode = (anchor && anchor.mode) || 'end';
		let blocks = blocksOf(text);
		let block = anchor && Number.isInteger(anchor.blockIndex)
			? blocks[anchor.blockIndex]
			: null;
		let offset;
		if ((mode === 'after-block' || mode === 'replace-block') && block) {
			offset = mode === 'replace-block' ? block.start : block.end;
		}
		else if (mode === 'before-block' && block) {
			offset = block.start;
		}
		else if (mode === 'replace-range'
				&& Number.isInteger(anchor.start)
				&& Number.isInteger(anchor.end)) {
			offset = clamp(anchor.start, 0, text.length);
		}
		else if (mode === 'cursor') {
			offset = Zotero.QLab.snapQmdOffset(text, anchor && anchor.offset);
		}
		else {
			offset = text.length;
		}
		return clamp(offset, 0, text.length);
	};
	
	/**
	 * Blocks surrounding an anchor, so an inline write can match the local voice
	 * and structure without shipping the whole draft to the model.
	 */
	Zotero.QLab.qmdAnchorContext = function (source, anchor, { before = 2, after = 1 } = {}) {
		let text = normalize(source);
		let offset = Zotero.QLab.qmdAnchorOffset(text, anchor);
		let blocks = blocksOf(text);
		let leading = blocks.filter(block => block.end <= offset).slice(-before);
		let trailing = blocks.filter(block => block.start >= offset).slice(0, after);
		return {
			offset,
			before: leading.map(block => block.source).join('\n\n').trim(),
			after: trailing.map(block => block.source).join('\n\n').trim(),
		};
	};
	
	/**
	 * Prompt for ⌘K paragraph writing / rewriting. The model returns document
	 * text only, so whatever comes back can land as a pending region.
	 */
	Zotero.QLab.buildQmdInlineWritePrompt = function ({
		instruction = '',
		composerContext = '',
		before = '',
		after = '',
		draftPath = '',
		replace = false,
		selectedText = '',
	} = {}) {
		let task = String(instruction || '').trim();
		if (!task) {
			throw new Error('Describe what to write');
		}
		let parts = [];
		if (composerContext) {
			parts.push(composerContext);
		}
		parts.push(replace ? '<qmd_inline_rewrite>' : '<qmd_inline_write>');
		if (draftPath) {
			parts.push(`draft: ${draftPath}`);
		}
		parts.push(`instruction: ${task}`);
		parts.push(replace ? '</qmd_inline_rewrite>' : '</qmd_inline_write>');
		if (replace && selectedText) {
			parts.push(`<qmd_text_selected>\n${normalize(selectedText).trim()}\n</qmd_text_selected>`);
		}
		if (before) {
			parts.push(`<qmd_text_before>\n${before}\n</qmd_text_before>`);
		}
		if (after) {
			parts.push(`<qmd_text_after>\n${after}\n</qmd_text_after>`);
		}
		if (replace) {
			parts.push(
				'Return only the replacement Quarto Markdown for the selected region. '
				+ 'No preamble, no explanation, no surrounding code fence, '
				+ 'and do not repeat the surrounding text.'
			);
		}
		else {
			parts.push(
				'Return only the Quarto Markdown to insert at that point. '
				+ 'No preamble, no explanation, no surrounding code fence, '
				+ 'and do not repeat the surrounding text.'
			);
		}
		return parts.join('\n\n');
	};
	
	/**
	 * Models often wrap a whole answer in a fence despite being told not to.
	 */
	Zotero.QLab.stripQmdAnswerFence = function (text) {
		let body = normalize(text).trim();
		let fenced = /^(`{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(body);
		return fenced ? fenced[2] : body;
	};
	
	/**
	 * Prefer the first fenced code block from a chat reply when inserting into
	 * notes; otherwise null so callers keep the full reply text.
	 */
	Zotero.QLab.extractFirstFencedMarkdown = function (text) {
		let body = normalize(text);
		let match = /```[^\n]*\n([\s\S]*?)\n```/.exec(body);
		if (!match) {
			return null;
		}
		let inner = match[1].replace(/\s+$/, '');
		return inner || null;
	};
	
	/**
	 * @param {string} source
	 * @param {{ mode: string, offset?: number, blockIndex?: number }} anchor
	 * @param {string} snippet
	 */
	Zotero.QLab.composeQmdInsertion = function (source, anchor, snippet) {
		let text = normalize(source);
		// Leading indentation on the first line is kept; blank padding is not.
		let body = normalize(snippet).replace(/^\n+/, '').replace(/\s+$/, '');
		if (!body) {
			return {
				source: text,
				insertedStart: -1,
				insertedEnd: -1,
				outerStart: -1,
				outerEnd: -1,
				outerText: '',
				previousOuterText: '',
				changed: false,
			};
		}
		let mode = (anchor && anchor.mode) || 'end';
		let blocks = blocksOf(text);
		let block = anchor && Number.isInteger(anchor.blockIndex)
			? blocks[anchor.blockIndex]
			: null;
		
		if (mode === 'replace-block' && block) {
			let outerText = `${body}\n`;
			return {
				source: `${text.slice(0, block.start)}${outerText}${text.slice(block.end)}`,
				insertedStart: block.start,
				insertedEnd: block.start + body.length,
				outerStart: block.start,
				outerEnd: block.start + outerText.length,
				outerText,
				previousOuterText: text.slice(block.start, block.end),
				changed: true,
			};
		}
		
		if (mode === 'replace-range'
				&& Number.isInteger(anchor.start)
				&& Number.isInteger(anchor.end)) {
			let start = clamp(anchor.start, 0, text.length);
			let end = clamp(anchor.end, start, text.length);
			return {
				source: `${text.slice(0, start)}${body}${text.slice(end)}`,
				insertedStart: start,
				insertedEnd: start + body.length,
				outerStart: start,
				outerEnd: start + body.length,
				outerText: body,
				previousOuterText: text.slice(start, end),
				changed: true,
			};
		}
		
		let offset = Zotero.QLab.qmdAnchorOffset(text, anchor);
		
		let before = text.slice(0, offset);
		let after = text.slice(offset);
		let lead = before.length
			? '\n'.repeat(Math.max(0, 2 - /\n*$/.exec(before)[0].length))
			: '';
		let trail = after.trim().length
			? '\n'.repeat(Math.max(0, 2 - /^\n*/.exec(after)[0].length))
			: '\n';
		let insertedStart = before.length + lead.length;
		let outerText = `${lead}${body}${trail}`;
		
		return {
			source: `${before}${outerText}${after}`,
			insertedStart,
			insertedEnd: insertedStart + body.length,
			// The outer range covers the padding too, so rejecting removes exactly
			// what was added and leaves no stray blank lines behind.
			outerStart: before.length,
			outerEnd: before.length + outerText.length,
			outerText,
			previousOuterText: '',
			changed: true,
		};
	};
	
	/**
	 * Undo one recorded region. Offsets are re-derived when the surrounding text
	 * moved, and an ambiguous match is refused rather than guessed.
	 *
	 * @returns {{ source: string, delta: number, at: number }}
	 */
	Zotero.QLab.revertQmdRegion = function (source, region) {
		let text = normalize(source);
		let outerText = String(region && region.outerText || '');
		let previous = String(region && region.previousOuterText || '');
		if (!outerText) {
			throw new Error('This change cannot be undone automatically');
		}
		let start = region.outerStart;
		if (text.slice(start, start + outerText.length) !== outerText) {
			start = text.indexOf(outerText);
			if (start < 0) {
				throw new Error('This change is no longer present in the draft');
			}
			if (text.indexOf(outerText, start + outerText.length) >= 0) {
				throw new Error('This change appears more than once; undo it by hand');
			}
		}
		let end = start + outerText.length;
		return {
			source: `${text.slice(0, start)}${previous}${text.slice(end)}`,
			delta: previous.length - outerText.length,
			at: start,
		};
	};
	
	/**
	 * Shift regions that sit after an edit so their offsets stay valid.
	 */
	Zotero.QLab.shiftQmdRegions = function (regions, at, delta) {
		return (regions || []).map((region) => {
			if (region.outerStart < at) {
				return region;
			}
			return {
				...region,
				outerStart: region.outerStart + delta,
				outerEnd: region.outerEnd + delta,
				insertedStart: region.insertedStart + delta,
				insertedEnd: region.insertedEnd + delta,
			};
		});
	};
	
	/**
	 * Public deep link back to the exact PDF page, so a quote stays traceable
	 * from inside the rendered document and not just from the composer.
	 */
	Zotero.QLab.qmdSourceLink = function (origin) {
		if (!origin || origin.type !== 'pdf' || !origin.key) {
			return '';
		}
		let path = Number.isFinite(origin.groupID)
			? `groups/${origin.groupID}/items/${origin.key}`
			: `library/items/${origin.key}`;
		let uri = `zotero://open-pdf/${path}`;
		if (Number.isInteger(origin.pageNumber)) {
			uri += `?page=${origin.pageNumber}`;
		}
		try {
			return Zotero.toExternalURI ? Zotero.toExternalURI(uri) : uri;
		}
		catch (e) {
			return uri;
		}
	};
	
	function attribution({ origin, title, citeKey }) {
		let page = origin && Number.isInteger(origin.pageNumber)
			? origin.pageNumber
			: null;
		if (citeKey) {
			return page ? `[@${citeKey}, p. ${page}]` : `[@${citeKey}]`;
		}
		let label = String(title || '').trim();
		if (page) {
			label = label ? `${label}, p. ${page}` : `p. ${page}`;
		}
		if (!label) {
			return '';
		}
		let link = Zotero.QLab.qmdSourceLink(origin);
		return link ? `[${label}](${link})` : label;
	}
	
	/**
	 * PDF selection -> Quarto blockquote with a traceable attribution line.
	 */
	Zotero.QLab.buildQuoteSnippet = function ({ text, origin, title, citeKey } = {}) {
		let body = normalize(text).trim();
		if (!body) {
			throw new Error('Nothing to quote');
		}
		let quoted = body
			.split('\n')
			.map(line => (line.trim() ? `> ${line.trim()}` : '>'))
			.join('\n');
		let credit = attribution({ origin, title, citeKey });
		return credit ? `${quoted}\n>\n> — ${credit}` : quoted;
	};
	
	/**
	 * Chat reply -> plain prose. Assistant text is inserted as authored prose
	 * rather than a quote, because the user is adopting it as their own.
	 */
	Zotero.QLab.buildChatSnippet = function ({ text } = {}) {
		let body = normalize(text).trim();
		if (!body) {
			throw new Error('Nothing to insert');
		}
		return body;
	};
	
	/**
	 * Make the QMD pane visible without collapsing the pane the user is reading
	 * in. Mirrors ensureChatPaneVisible, but docks into the center pane.
	 */
	Zotero.QLab.ensureQmdPaneVisible = async function (win, { itemID } = {}) {
		let tabs = win && win.Zotero_Tabs;
		if (!tabs) {
			return null;
		}
		let qmd = tabs._tabs.find(t => t.type === 'qlabqmd' || t.id === 'qlabqmd');
		if (qmd && tabs.isTabVisible && tabs.isTabVisible(qmd.id)) {
			return qmd.id;
		}
		let hasChat = tabs._tabs.some(t => t.type === 'qlabchat');
		if (Number.isFinite(itemID) && hasChat && tabs.arrangeResearchDesk) {
			await tabs.arrangeResearchDesk(itemID);
		}
		else if (Number.isFinite(itemID) && tabs.arrangePDFEditor) {
			await tabs.arrangePDFEditor(itemID);
		}
		else if (tabs._qlab && tabs._qlab.dockShellTab) {
			return tabs._qlab.dockShellTab('qlabqmd', 'center', {});
		}
		qmd = tabs._tabs.find(t => t.type === 'qlabqmd' || t.id === 'qlabqmd');
		return qmd ? qmd.id : null;
	};
	
	/**
	 * Locate the QMD shell that an insert should land in.
	 */
	Zotero.QLab.getActiveQmdTarget = function (win) {
		let windowRef = win || (Zotero.getMainWindow && Zotero.getMainWindow());
		let tabs = windowRef && windowRef.Zotero_Tabs;
		if (!tabs) {
			return null;
		}
		let tab = tabs._tabs.find(t => t.type === 'qlabqmd' || t.id === 'qlabqmd');
		if (!tab) {
			return null;
		}
		let container = windowRef.document.getElementById(tab.id);
		let host = container && container.querySelector('.qlab-shell-host');
		if (!host) {
			return null;
		}
		let state = host._qlabDraftState;
		return {
			win: windowRef,
			tabID: tab.id,
			host,
			state: state || null,
			draftPath: state
				? (state.viewingWorking && state.workingPath
					? state.workingPath
					: state.originalPath)
				: '',
			surfaceMode: host._qlabSurfaceMode || 'visual',
			buffer: Zotero.QLab.getQmdShellBuffer
				? Zotero.QLab.getQmdShellBuffer(host)
				: '',
		};
	};
	
	/**
	 * Where the next insert goes, based on what the user last touched.
	 * Pass `{ forInlineWrite: true }` for ⌘K so a Source selection or active
	 * Preview block becomes a replace rather than an insert-after.
	 */
	Zotero.QLab.resolveQmdAnchor = function (host, { forInlineWrite = false } = {}) {
		if (!host) {
			return { mode: 'end' };
		}
		let mode = host._qlabSurfaceMode || 'visual';
		if (mode === 'source') {
			let editor = host.querySelector('[data-qlab-editor]');
			if (editor && typeof editor.selectionStart === 'number') {
				if (forInlineWrite
						&& typeof editor.selectionEnd === 'number'
						&& editor.selectionEnd > editor.selectionStart) {
					return {
						mode: 'replace-range',
						start: editor.selectionStart,
						end: editor.selectionEnd,
					};
				}
				return { mode: 'cursor', offset: editor.selectionStart };
			}
			return { mode: 'end' };
		}
		if (mode === 'visual' && Number.isInteger(host._qlabActiveBlockIndex)) {
			if (forInlineWrite) {
				return {
					mode: 'replace-block',
					blockIndex: host._qlabActiveBlockIndex,
				};
			}
			return { mode: 'after-block', blockIndex: host._qlabActiveBlockIndex };
		}
		return { mode: 'end' };
	};
	
	/**
	 * Selected / active-block text for a rewrite prompt, if any.
	 */
	Zotero.QLab.qmdAnchorSelectedText = function (host, anchor) {
		if (!host || !anchor) {
			return '';
		}
		let buffer = Zotero.QLab.getQmdShellBuffer
			? Zotero.QLab.getQmdShellBuffer(host)
			: '';
		if (anchor.mode === 'replace-range'
				&& Number.isInteger(anchor.start)
				&& Number.isInteger(anchor.end)) {
			return buffer.slice(anchor.start, anchor.end);
		}
		if (anchor.mode === 'replace-block' && Number.isInteger(anchor.blockIndex)) {
			let blocks = blocksOf(buffer);
			let block = blocks[anchor.blockIndex];
			return block ? block.source : '';
		}
		return '';
	};
	
	/**
	 * Insert a snippet into the live buffer as a pending region.
	 *
	 * @param {Window} win
	 * @param {string} snippet
	 * @param {{ anchor?: object, label?: string, reveal?: boolean }} [options]
	 */
	Zotero.QLab.insertIntoQmd = function (win, snippet, options = {}) {
		let target = Zotero.QLab.getActiveQmdTarget(win);
		if (!target) {
			throw new Error('Open the QMD Editor first (⌘⇧E or ⌘⇧D)');
		}
		let anchor = options.anchor || Zotero.QLab.resolveQmdAnchor(target.host);
		let result = Zotero.QLab.composeQmdInsertion(target.buffer, anchor, snippet);
		if (!result.changed) {
			return null;
		}
		
		// Earlier regions keep their offsets; later ones move by what we just added.
		let grew = result.outerText.length - result.previousOuterText.length;
		let existing = Zotero.QLab.shiftQmdRegions(
			target.host._qlabPendingInserts,
			result.outerStart,
			grew
		);
		target.host._qlabPendingInserts = existing.concat({
			id: `apply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
			label: options.label || 'Inserted',
			at: new Date().toISOString(),
			insertedStart: result.insertedStart,
			insertedEnd: result.insertedEnd,
			outerStart: result.outerStart,
			outerEnd: result.outerEnd,
			outerText: result.outerText,
			previousOuterText: result.previousOuterText,
		});
		if (Zotero.QLab.setQmdShellBuffer) {
			Zotero.QLab.setQmdShellBuffer(target.host, result.source, {
				dirty: true,
				render: true,
			});
		}
		Zotero.QLab.renderQmdPendingBar && Zotero.QLab.renderQmdPendingBar(target.host);
		
		if (options.reveal !== false && target.surfaceMode === 'source') {
			let editor = target.host.querySelector('[data-qlab-editor]');
			if (editor) {
				editor.focus();
				editor.setSelectionRange(result.insertedStart, result.insertedEnd);
			}
		}
		return { ...result, target };
	};
	
	Zotero.QLab.pendingQmdInserts = function (host) {
		return (host && host._qlabPendingInserts) || [];
	};
	
	/**
	 * Keep one region and drop its undo checkpoint. The text stays; only the
	 * review marker goes away.
	 */
	Zotero.QLab.acceptPendingQmdInsert = function (host, id) {
		let pending = Zotero.QLab.pendingQmdInserts(host);
		if (!pending.length) {
			return false;
		}
		host._qlabPendingInserts = id
			? pending.filter(region => region.id !== id)
			: [];
		Zotero.QLab.renderQmdPendingBar && Zotero.QLab.renderQmdPendingBar(host);
		return true;
	};
	
	/**
	 * Remove one region's text from the buffer and re-anchor the rest.
	 */
	Zotero.QLab.rejectPendingQmdInsert = function (host, id) {
		let pending = Zotero.QLab.pendingQmdInserts(host);
		let region = id
			? pending.find(r => r.id === id)
			: pending[pending.length - 1];
		if (!region) {
			return false;
		}
		let buffer = Zotero.QLab.getQmdShellBuffer
			? Zotero.QLab.getQmdShellBuffer(host)
			: '';
		let reverted = Zotero.QLab.revertQmdRegion(buffer, region);
		host._qlabPendingInserts = Zotero.QLab.shiftQmdRegions(
			pending.filter(r => r.id !== region.id),
			reverted.at,
			reverted.delta
		);
		if (Zotero.QLab.setQmdShellBuffer) {
			Zotero.QLab.setQmdShellBuffer(host, reverted.source, {
				dirty: true,
				render: true,
			});
		}
		Zotero.QLab.renderQmdPendingBar && Zotero.QLab.renderQmdPendingBar(host);
		return true;
	};
	
	/**
	 * Reject newest first, so each removal keeps the older offsets valid.
	 */
	Zotero.QLab.rejectAllPendingQmdInserts = function (host) {
		let pending = Zotero.QLab.pendingQmdInserts(host).slice().reverse();
		for (let region of pending) {
			Zotero.QLab.rejectPendingQmdInsert(host, region.id);
		}
		return true;
	};
})();
