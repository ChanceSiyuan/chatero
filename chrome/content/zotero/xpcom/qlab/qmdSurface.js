/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * QMD Editor surface modes — Cursor-like three-way switch:
 *   visual  = Preview edit (source-driven live blocks)
 *   website = HTML site / Quarto preview
 *   source  = raw QMD markdown
 *
 * One shared buffer; mode switch never drops unsaved text.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const MODES = ['visual', 'website', 'source'];
	
	Zotero.QLab.QMD_SURFACE_MODES = MODES;
	
	Zotero.QLab.normalizeQmdSurfaceMode = function (mode) {
		let value = String(mode || '').toLowerCase();
		return MODES.includes(value) ? value : 'visual';
	};
	
	Zotero.QLab.qmdSurfaceModeLabel = function (mode) {
		switch (Zotero.QLab.normalizeQmdSurfaceMode(mode)) {
			case 'website':
				return 'Website';
			case 'source':
				return 'Source';
			default:
				return 'Preview';
		}
	};
	
	function escapeHTML(value) {
		return String(value || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}
	
	/**
	 * Read the active shared QMD buffer from the shell host.
	 */
	Zotero.QLab.getQmdShellBuffer = function (host) {
		if (!host) {
			return '';
		}
		if (typeof host._qlabBuffer === 'string') {
			return host._qlabBuffer;
		}
		let editor = host.querySelector('[data-qlab-editor]');
		return editor ? editor.value : '';
	};
	
	/**
	 * Write shared buffer and sync visible source textarea.
	 *
	 * @param {boolean} [options.render] Also repaint the active surface, so a
	 *   programmatic insert shows up without a mode switch.
	 */
	Zotero.QLab.setQmdShellBuffer = function (host, text, { dirty = true, render = false } = {}) {
		if (!host) {
			return;
		}
		host._qlabBuffer = String(text ?? '');
		host._qlabDirty = !!dirty;
		let editor = host.querySelector('[data-qlab-editor]');
		if (editor && editor.value !== host._qlabBuffer) {
			editor.value = host._qlabBuffer;
		}
		if (!render) {
			return;
		}
		let mode = Zotero.QLab.normalizeQmdSurfaceMode(host._qlabSurfaceMode);
		if (mode === 'visual') {
			Zotero.QLab.renderQmdVisualPane(host);
		}
		else if (mode === 'website') {
			void Zotero.QLab.refreshQmdWebsitePane(host);
		}
	};
	
	/**
	 * Remember which Preview block the user last touched, so Apply knows where
	 * an insert should land.
	 */
	Zotero.QLab.setQmdActiveBlock = function (host, blockIndex) {
		if (!host) {
			return;
		}
		host._qlabActiveBlockIndex = Number.isInteger(blockIndex) ? blockIndex : null;
		let pane = host.querySelector('[data-qlab-surface="visual"]');
		if (!pane) {
			return;
		}
		for (let card of pane.querySelectorAll('[data-qlab-block-index]')) {
			card.classList.toggle(
				'is-active',
				Number(card.dataset.qlabBlockIndex) === host._qlabActiveBlockIndex
			);
		}
	};
	
	function truncateDiff(text, n = 120) {
		let value = String(text || '').replace(/\s+/g, ' ').trim();
		if (value.length <= n) {
			return value;
		}
		return `${value.slice(0, n - 1)}…`;
	}

	Zotero.QLab.formatQmdPendingDiffHTML = function (region) {
		if (!region) {
			return '';
		}
		let before = String(region.previousOuterText || '').trim();
		let after = String(region.outerText || '').trim();
		if (!before && !after) {
			return '';
		}
		if (before && after) {
			return `<div class="qlab-qmd-pending-diff">`
				+ `<div class="qlab-qmd-pending-diff-before">`
				+ `<span class="qlab-qmd-pending-diff-label">Before</span>`
				+ `<pre>${escapeHTML(truncateDiff(before, 240))}</pre></div>`
				+ `<div class="qlab-qmd-pending-diff-after">`
				+ `<span class="qlab-qmd-pending-diff-label">After</span>`
				+ `<pre>${escapeHTML(truncateDiff(after, 240))}</pre></div>`
				+ `</div>`;
		}
		if (after) {
			return `<div class="qlab-qmd-pending-diff is-insert-only">`
				+ `<span class="qlab-qmd-pending-diff-label">Insert</span>`
				+ `<pre>${escapeHTML(truncateDiff(after, 240))}</pre></div>`;
		}
		return `<div class="qlab-qmd-pending-diff is-remove-only">`
			+ `<span class="qlab-qmd-pending-diff-label">Remove</span>`
			+ `<pre>${escapeHTML(truncateDiff(before, 240))}</pre></div>`;
	};
	
	/**
	 * Per-region review bar for Apply inserts (Cursor-style hunk review).
	 */
	Zotero.QLab.renderQmdPendingBar = function (host) {
		let bar = host && host.querySelector('[data-qlab-pending]');
		if (!bar) {
			return;
		}
		let pending = Zotero.QLab.pendingQmdInserts
			? Zotero.QLab.pendingQmdInserts(host)
			: [];
		if (!pending.length) {
			bar.hidden = true;
			bar.replaceChildren();
			return;
		}
		let rows = pending.map((region) => {
			let length = Math.max(0, region.insertedEnd - region.insertedStart);
			let diff = Zotero.QLab.formatQmdPendingDiffHTML(region);
			return `<div class="qlab-qmd-pending-row" data-qlab-pending-id="${escapeHTML(region.id)}">`
				+ `<button type="button" class="qlab-qmd-pending-label" data-qlab-pending-reveal>`
				+ `${escapeHTML(region.label)} · ${length} chars</button>`
				+ diff
				+ `<div class="qlab-qmd-pending-actions">`
				+ `<button type="button" data-qlab-pending-accept>Accept</button>`
				+ `<button type="button" data-qlab-pending-reject>Reject</button>`
				+ `</div></div>`;
		}).join('');
		let bulk = pending.length > 1
			? `<div class="qlab-qmd-pending-row is-bulk">`
				+ `<span class="qlab-qmd-pending-label">${pending.length} pending changes (unsaved)</span>`
				+ `<button type="button" data-qlab-pending-accept-all>Accept all</button>`
				+ `<button type="button" data-qlab-pending-reject-all>Reject all</button>`
				+ `</div>`
			: '';
		bar.hidden = false;
		Zotero.QLab.setHTML(bar, rows + bulk);
	};
	
	/**
	 * Scroll to a pending region and select it in Source view.
	 */
	Zotero.QLab.revealQmdPendingRegion = function (host, id) {
		let region = (Zotero.QLab.pendingQmdInserts(host) || []).find(r => r.id === id);
		if (!region) {
			return;
		}
		if (host._qlabSurfaceMode !== 'source') {
			Zotero.QLab.applyQmdSurfaceMode(host, 'source', { silent: true });
		}
		let editor = host.querySelector('[data-qlab-editor]');
		if (editor) {
			editor.focus();
			editor.setSelectionRange(region.insertedStart, region.insertedEnd);
		}
	};
	
	Zotero.QLab.renderQmdModeToggleHTML = function (activeMode) {
		let mode = Zotero.QLab.normalizeQmdSurfaceMode(activeMode);
		return [
			`<div class="qlab-qmd-modes" role="tablist" aria-label="QMD editor mode">`,
			...MODES.map(id => {
				let pressed = id === mode ? 'true' : 'false';
				let selected = id === mode ? ' aria-selected="true"' : ' aria-selected="false"';
				return `<button type="button" role="tab" class="qlab-qmd-mode"`
					+ ` data-qlab-mode="${id}" aria-pressed="${pressed}"${selected}>`
					+ `${escapeHTML(Zotero.QLab.qmdSurfaceModeLabel(id))}</button>`;
			}),
			`</div>`,
		].join('');
	};
	
	/**
	 * Apply surface visibility + refresh visual/website panes from buffer.
	 */
	Zotero.QLab.applyQmdSurfaceMode = function (host, mode, options = {}) {
		if (!host) {
			return;
		}
		let next = Zotero.QLab.normalizeQmdSurfaceMode(mode);
		// Flush source textarea into buffer before leaving Source.
		let editor = host.querySelector('[data-qlab-editor]');
		if (editor) {
			Zotero.QLab.setQmdShellBuffer(host, editor.value, {
				dirty: host._qlabDirty || editor.value !== (host._qlabLastSaved || editor.value),
			});
		}
		host._qlabSurfaceMode = next;
		
		for (let button of host.querySelectorAll('[data-qlab-mode]')) {
			let on = button.dataset.qlabMode === next;
			button.setAttribute('aria-pressed', on ? 'true' : 'false');
			button.setAttribute('aria-selected', on ? 'true' : 'false');
			button.classList.toggle('is-active', on);
		}
		
		for (let pane of host.querySelectorAll('[data-qlab-surface]')) {
			pane.hidden = pane.dataset.qlabSurface !== next;
		}
		
		let status = host.querySelector('.qlab-shell-status');
		if (next === 'visual') {
			Zotero.QLab.renderQmdVisualPane(host);
			if (status && !options.silent) {
				status.textContent = 'Preview · click a block to edit; saves back to QMD source';
			}
		}
		else if (next === 'website') {
			void Zotero.QLab.refreshQmdWebsitePane(host, { ...options, tryQuarto: true });
			if (status && !options.silent) {
				status.textContent = 'Website · Quarto HTML when available, else soft HTML preview';
			}
		}
		else if (status && !options.silent) {
			status.textContent = 'Source · edit QMD markdown directly';
		}
	};
	
	/**
	 * Pending regions that overlap a visual block's source range.
	 */
	Zotero.QLab.pendingRegionsForQmdBlock = function (host, block) {
		if (!block) {
			return [];
		}
		let pending = Zotero.QLab.pendingQmdInserts
			? Zotero.QLab.pendingQmdInserts(host)
			: [];
		return pending.filter(region => (
			region.insertedStart < block.end && region.insertedEnd > block.start
		));
	};
	
	/**
	 * Render source-driven Visual Preview cards into the visual pane.
	 */
	Zotero.QLab.renderQmdVisualPane = function (host) {
		let pane = host && host.querySelector('[data-qlab-surface="visual"]');
		if (!pane) {
			return;
		}
		let source = Zotero.QLab.getQmdShellBuffer(host);
		let blocks = Zotero.QLab.visualQmdBlocks(source);
		pane.replaceChildren();
		pane._qlabBlocks = blocks;
		
		if (!source.trim()) {
			let empty = pane.ownerDocument.createElement('p');
			empty.className = 'qlab-shell-note';
			empty.textContent = 'Open a Draft to begin Preview editing.';
			pane.appendChild(empty);
			return;
		}
		
		for (let i = 0; i < blocks.length; i++) {
			let block = blocks[i];
			let card = pane.ownerDocument.createElement('div');
			card.className = `qlab-qmd-visual-block is-${block.kind}`;
			card.dataset.qlabBlockIndex = String(i);
			card.setAttribute('tabindex', '0');
			card.setAttribute('role', 'button');
			card.title = 'Click to edit this QMD block';
			
			let overlapping = Zotero.QLab.pendingRegionsForQmdBlock(host, block);
			if (overlapping.length) {
				card.classList.add('is-pending');
			}
			
			let badge = pane.ownerDocument.createElement('div');
			badge.className = 'qlab-qmd-visual-badge';
			badge.textContent = block.semantic || block.kind;
			card.appendChild(badge);
			
			let body = pane.ownerDocument.createElement('div');
			body.className = 'qlab-qmd-visual-body';
			Zotero.QLab.setHTML(body, Zotero.QLab.renderQmdBlockHTML(block));
			card.appendChild(body);
			
			if (overlapping.length) {
				let review = pane.ownerDocument.createElement('div');
				review.className = 'qlab-qmd-visual-pending-actions';
				for (let region of overlapping) {
					let row = pane.ownerDocument.createElement('div');
					row.className = 'qlab-qmd-visual-pending-row';
					row.dataset.qlabPendingId = region.id;
					let label = pane.ownerDocument.createElement('span');
					label.className = 'qlab-qmd-pending-label';
					label.textContent = region.label || 'Pending';
					row.appendChild(label);
					let diffWrap = pane.ownerDocument.createElement('div');
					Zotero.QLab.setHTML(
						diffWrap,
						Zotero.QLab.formatQmdPendingDiffHTML(region)
					);
					if (diffWrap.firstElementChild) {
						row.appendChild(diffWrap.firstElementChild);
					}
					let actions = pane.ownerDocument.createElement('div');
					actions.className = 'qlab-qmd-pending-actions';
					let accept = pane.ownerDocument.createElement('button');
					accept.type = 'button';
					accept.dataset.qlabPendingAccept = '';
					accept.textContent = 'Accept';
					actions.appendChild(accept);
					let reject = pane.ownerDocument.createElement('button');
					reject.type = 'button';
					reject.dataset.qlabPendingReject = '';
					reject.textContent = 'Reject';
					actions.appendChild(reject);
					row.appendChild(actions);
					review.appendChild(row);
				}
				card.appendChild(review);
			}
			
			if (i === host._qlabActiveBlockIndex) {
				card.classList.add('is-active');
			}
			pane.appendChild(card);
		}
	};
	
	/**
	 * Open one visual block as an inline source editor (Cursor-like live edit).
	 */
	Zotero.QLab.beginQmdVisualBlockEdit = function (host, blockIndex) {
		let pane = host.querySelector('[data-qlab-surface="visual"]');
		if (!pane || !pane._qlabBlocks) {
			return;
		}
		let block = pane._qlabBlocks[blockIndex];
		let card = pane.querySelector(`[data-qlab-block-index="${blockIndex}"]`);
		if (!block || !card || card.querySelector('textarea')) {
			return;
		}
		// Pending Accept/Reject buttons own their clicks; don't open the editor.
		if (card.classList.contains('is-pending')
				&& host.ownerDocument.activeElement
				&& host.ownerDocument.activeElement.closest
				&& host.ownerDocument.activeElement.closest('[data-qlab-pending-id]')) {
			return;
		}
		Zotero.QLab.setQmdActiveBlock(host, blockIndex);
		card.replaceChildren();
		let badge = pane.ownerDocument.createElement('div');
		badge.className = 'qlab-qmd-visual-badge';
		badge.textContent = `${block.semantic || block.kind} · editing`;
		card.appendChild(badge);
		
		let textarea = pane.ownerDocument.createElement('textarea');
		textarea.className = 'qlab-qmd-visual-source-editor';
		textarea.value = block.source;
		textarea.rows = Math.max(3, Math.min(28, block.source.split(/\n/).length + 1));
		card.appendChild(textarea);
		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		
		let commit = () => {
			try {
				let source = Zotero.QLab.getQmdShellBuffer(host);
				let result = Zotero.QLab.applyQmdVisualBlock(source, block, textarea.value);
				if (result.changed) {
					Zotero.QLab.setQmdShellBuffer(host, result.source, { dirty: true });
					let status = host.querySelector('.qlab-shell-status');
					if (status) {
						status.textContent = 'Preview · block updated in buffer (Save to disk)';
					}
				}
			}
			catch (e) {
				Zotero.logError && Zotero.logError(e);
				let status = host.querySelector('.qlab-shell-status');
				if (status) {
					status.textContent = e.message || String(e);
				}
			}
			Zotero.QLab.renderQmdVisualPane(host);
		};
		
		textarea.addEventListener('blur', commit);
		textarea.addEventListener('keydown', (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
				event.preventDefault();
				textarea.blur();
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				Zotero.QLab.renderQmdVisualPane(host);
			}
		});
	};
	
	/**
	 * Refresh Website pane: Quarto URL if live, else soft HTML srcdoc.
	 */
	Zotero.QLab.refreshQmdWebsitePane = async function (host, options = {}) {
		let pane = host && host.querySelector('[data-qlab-surface="website"]');
		if (!pane) {
			return;
		}
		let frame = pane.querySelector('[data-qlab-website-frame]');
		let meta = pane.querySelector('[data-qlab-website-meta]');
		let source = Zotero.QLab.getQmdShellBuffer(host);
		let state = host._qlabDraftState;
		let title = (state && state.originalPath) || 'Draft';
		
		let liveUrl = host._qlabWebsiteUrl || '';
		let shouldTryQuarto = options.forceQuarto || options.tryQuarto;
		if (shouldTryQuarto && Zotero.QLab.startQmdQuartoPreview && state) {
			try {
				let root = options.root || (Zotero.QLab.Settings && Zotero.QLab.Settings.getRoot()) || '';
				let path = state.viewingWorking && state.workingPath
					? state.workingPath
					: state.originalPath;
				liveUrl = await Zotero.QLab.startQmdQuartoPreview(root, path);
				host._qlabWebsiteUrl = liveUrl;
			}
			catch (e) {
				Zotero.logError && Zotero.logError(e);
				host._qlabWebsiteUrl = '';
				if (meta && options.forceQuarto) {
					meta.textContent = e.message || String(e);
				}
				liveUrl = '';
			}
		}
		
		if (liveUrl && frame) {
			frame.removeAttribute('srcdoc');
			frame.setAttribute('src', liveUrl);
			if (meta) {
				meta.textContent = `Quarto website · ${liveUrl}`;
			}
			return;
		}
		
		let html = Zotero.QLab.renderQmdDocumentHTML(source, { title });
		if (frame) {
			frame.removeAttribute('src');
			frame.setAttribute('srcdoc', html);
		}
		if (meta) {
			meta.textContent = 'Soft HTML preview · click “Quarto” to start a live website when Quarto is installed';
		}
	};
})();
