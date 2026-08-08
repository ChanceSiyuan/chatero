/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Narrow Reader context for Chat turns (XPI-compatible shape, smaller surface).
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const MAX_PAGE = 12000;
	const MAX_SELECTION = 8000;
	
	/**
	 * Bound page text for prompts / composer tags.
	 */
	Zotero.QLab.truncateReaderPageText = function (text, max = MAX_PAGE) {
		let value = String(text || '').replace(/\s+/g, ' ').trim();
		let limit = Number.isFinite(max) && max > 0 ? max : MAX_PAGE;
		if (value.length <= limit) {
			return value;
		}
		return `${value.slice(0, Math.max(0, limit - 1))}…`;
	};
	
	/**
	 * Best-effort current-page text from a Reader instance.
	 * Prefers the rendered textLayer; falls back to getPageData chars.
	 */
	Zotero.QLab.extractReaderPageText = async function (reader, pageIndex) {
		if (!reader || !Number.isInteger(pageIndex) || pageIndex < 0) {
			return '';
		}
		try {
			let primaryView = reader._internalReader && reader._internalReader._primaryView;
			let iframe = primaryView && primaryView._iframeWindow;
			if (iframe && iframe.document) {
				let layer = iframe.document.querySelector(
					`[data-page-number="${pageIndex + 1}"] .textLayer`
				);
				if (layer && layer.textContent) {
					return Zotero.QLab.truncateReaderPageText(layer.textContent, MAX_PAGE);
				}
			}
		}
		catch (_) {}
		
		try {
			let primaryView = reader._internalReader && reader._internalReader._primaryView;
			let iframe = primaryView && primaryView._iframeWindow;
			let pdfDocument = iframe
				&& iframe.PDFViewerApplication
				&& iframe.PDFViewerApplication.pdfDocument;
			if (pdfDocument && typeof pdfDocument.getPageData === 'function') {
				let pageData = await pdfDocument.getPageData({ pageIndex });
				if (pageData && Array.isArray(pageData.chars)) {
					let parts = [];
					for (let ch of pageData.chars) {
						if (ch && ch.u) {
							parts.push(ch.u);
						}
						if (ch && (ch.spaceAfter || ch.lineBreakAfter || ch.paragraphBreakAfter)) {
							parts.push(' ');
						}
					}
					return Zotero.QLab.truncateReaderPageText(parts.join(''), MAX_PAGE);
				}
			}
		}
		catch (_) {}
		
		return '';
	};
	
	Zotero.QLab.ReaderContextStore = {
		_context: null,
		_chips: { paper: true, page: true, selection: true },
		
		get() {
			return this._context;
		},
		
		getChips() {
			return { ...this._chips };
		},
		
		setChip(name, enabled) {
			if (Object.prototype.hasOwnProperty.call(this._chips, name)) {
				this._chips[name] = !!enabled;
			}
		},
		
		clear() {
			this._context = null;
		},
		
		/**
		 * Build context from a Reader renderToolbar / selection popup event.
		 */
		async captureFromEvent(event) {
			let reader = event && event.reader;
			let item = event && (event.item || (reader && Zotero.Items.get(reader.itemID)));
			if (!item) {
				throw new Error('No PDF attachment for Reader context');
			}
			let parent = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
			let pageIndex = 0;
			try {
				let state = reader && reader._internalReader && reader._internalReader._state;
				let stats = state && state.primaryViewStats;
				if (stats && Number.isInteger(stats.pageIndex)) {
					pageIndex = Math.max(0, stats.pageIndex);
				}
				else if (item.getAttachmentLastPageIndex) {
					let last = item.getAttachmentLastPageIndex();
					if (Number.isInteger(last)) {
						pageIndex = Math.max(0, last);
					}
				}
			}
			catch (e) {}
			
			let selectionText = '';
			let annotation = event && event.params && event.params.annotation;
			if (annotation && annotation.text) {
				selectionText = String(annotation.text);
			}
			else if (this._context
					&& this._context.attachment
					&& this._context.attachment.id === item.id
					&& this._context.selection) {
				selectionText = this._context.selection.text || '';
			}
			
			let pageText = '';
			try {
				pageText = await Zotero.QLab.extractReaderPageText(reader, pageIndex);
			}
			catch (e) {}
			
			let title = parent
				? (await parent.getDisplayTitle())
				: (item.attachmentFilename || item.getField('title') || 'PDF');
			
			this._context = Object.freeze({
				schemaVersion: 1,
				capturedAt: new Date().toISOString(),
				attachment: Object.freeze({
					id: item.id,
					key: item.key,
					libraryID: item.libraryID,
					filename: item.attachmentFilename || '',
				}),
				parent: parent
					? Object.freeze({
						id: parent.id,
						key: parent.key,
						title: String(title),
					})
					: null,
				page: Object.freeze({
					pageIndex,
					pageNumber: pageIndex + 1,
					text: pageText,
				}),
				selection: selectionText
					? Object.freeze({
						text: selectionText.slice(0, MAX_SELECTION),
						pageIndex,
						pageNumber: pageIndex + 1,
					})
					: null,
				warnings: Object.freeze([]),
			});
			return this._context;
		},
		
		/**
		 * Format context for AgentRuntime prompts (parity with XPI additionalContext).
		 */
		formatForPrompt(context, chips) {
			let ctx = context || this._context;
			let flags = chips || this._chips;
			if (!ctx) {
				return '';
			}
			let parts = ['<reader_context>'];
			if (flags.paper) {
				parts.push(`Paper: ${ctx.parent?.title || ctx.attachment.filename || 'Untitled'}`);
				parts.push(`AttachmentID: ${ctx.attachment.id}`);
				parts.push(`LibraryID: ${ctx.attachment.libraryID}`);
			}
			if (flags.page && ctx.page) {
				parts.push(`Page: ${ctx.page.pageNumber}`);
				if (ctx.page.text) {
					parts.push('PageText:');
					parts.push(String(ctx.page.text).slice(0, MAX_PAGE));
				}
			}
			if (flags.selection && ctx.selection && ctx.selection.text) {
				parts.push('Selection:');
				parts.push(String(ctx.selection.text).slice(0, MAX_SELECTION));
			}
			parts.push('</reader_context>');
			return parts.join('\n');
		},
	};
})();
