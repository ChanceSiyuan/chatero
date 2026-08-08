/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Reader toolbar + shortcuts (XPI Button A / C / Ask selection), optimized for
 * native Chatero tabs instead of nested Workbench.
 *
 * Cursor-compatible:
 *   ⌘L     — pin PDF/QMD context into Chat as a composer tag
 *   ⌘⇧L    — pin without forcing a new arrangement (same attach)
 *   ⌘⇧K    — quote the PDF selection into the live QMD draft
 *   ⌘I     — arrange PDF | Chat
 *   ⌘⇧E    — arrange PDF | QMD Editor
 *   ⌘⇧D    — arrange the research desk (PDF | QMD | Chat)
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const PLUGIN_ID = 'chatero-qlab@local';
	let _registered = false;
	let _handlers = [];

	function iconButtonCSS(size = 32) {
		return `display:grid;place-items:center;width:${size}px;height:${size}px;border:0;`
			+ 'border-radius:8px;background:transparent;cursor:pointer;padding:5px;'
			+ 'color:var(--fill-secondary, #555);';
	}

	function makeIconButton(doc, { title, iconSrc, onClick, size = 32, iconSize = 22 }) {
		let button = doc.createElement('button');
		button.type = 'button';
		button.title = title;
		button.setAttribute('aria-label', title);
		button.style.cssText = iconButtonCSS(size);
		let icon = doc.createElement('img');
		icon.src = iconSrc;
		icon.alt = '';
		icon.style.cssText = `width:${iconSize}px;height:${iconSize}px;`
			+ (iconSrc.includes('9b8cff') ? 'border-radius:6px;' : '');
		button.append(icon);
		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			void onClick();
		});
		return button;
	}

	async function arrangeFromReader(event, which) {
		try {
			if (Zotero.QLab.ReaderContextStore) {
				await Zotero.QLab.ReaderContextStore.captureFromEvent(event);
			}
			let reader = event.reader;
			let itemID = reader && reader.itemID;
			if (!itemID) {
				throw new Error('Open a PDF Reader tab first');
			}
			let win = reader._window || Zotero.getMainWindow();
			if (!win || !win.Zotero_Tabs) {
				throw new Error('Main window tabs are unavailable');
			}
			if (which === 'pdf-editor') {
				await win.Zotero_Tabs.arrangePDFEditor(itemID);
			}
			else if (which === 'desk') {
				await win.Zotero_Tabs.arrangeResearchDesk(itemID);
			}
			else {
				await win.Zotero_Tabs.arrangePDFChat(itemID);
			}
		}
		catch (e) {
			Zotero.logError(e);
			try {
				Zotero.alert(null, 'QLab', e.message || String(e));
			}
			catch (_) {}
		}
	}

	async function askSelection(event) {
		try {
			if (Zotero.QLab.ReaderContextStore) {
				await Zotero.QLab.ReaderContextStore.captureFromEvent(event);
			}
			let win = (event.reader && event.reader._window) || Zotero.getMainWindow();
			if (Zotero.QLab.addCurrentContextToChat) {
				await Zotero.QLab.addCurrentContextToChat(win, {
					params: event.params || {},
					preference: 'selection',
				});
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	/**
	 * PDF selection -> blockquote in the live QMD buffer, with a deep link back
	 * to the page it came from.
	 */
	async function quoteSelectionIntoQmd(event) {
		try {
			if (Zotero.QLab.ReaderContextStore) {
				await Zotero.QLab.ReaderContextStore.captureFromEvent(event);
			}
			let ctx = Zotero.QLab.ReaderContextStore && Zotero.QLab.ReaderContextStore.get();
			let text = ctx && ctx.selection && ctx.selection.text;
			if (!text) {
				throw new Error('Select text in the PDF first');
			}
			let win = (event.reader && event.reader._window) || Zotero.getMainWindow();
			await Zotero.QLab.ensureQmdPaneVisible(win, {
				itemID: ctx.attachment && ctx.attachment.id,
			});
			let groupID;
			try {
				let library = Zotero.Libraries.get(ctx.attachment.libraryID);
				groupID = library && library.groupID;
			}
			catch (e) {}
			let snippet = Zotero.QLab.buildQuoteSnippet({
				text,
				title: (ctx.parent && ctx.parent.title) || ctx.attachment.filename,
				origin: {
					type: 'pdf',
					key: ctx.attachment.key,
					libraryID: ctx.attachment.libraryID,
					groupID,
					pageNumber: ctx.selection.pageNumber,
				},
			});
			Zotero.QLab.insertIntoQmd(win, snippet, { label: 'PDF quote' });
		}
		catch (e) {
			Zotero.logError(e);
			try {
				Zotero.alert(null, 'QLab', e.message || String(e));
			}
			catch (_) {}
		}
	}

	function isEditableTarget(target) {
		return !!(target && (target.isContentEditable
			|| /^(INPUT|TEXTAREA|SELECT)$/i.test(target.tagName)));
	}

	function installShortcuts(win) {
		if (!win || win._qlabShortcutsBound) {
			return;
		}
		win._qlabShortcutsBound = true;
		win.addEventListener('keydown', (event) => {
			let meta = event.metaKey || event.ctrlKey;
			if (!meta || event.altKey || event.isComposing) {
				return;
			}
			let key = String(event.key || '').toLowerCase();

			// ⌘L / ⌘⇧L pin context. Shift = never steal focus; plain ⌘L also
			// skips focus when Chat is already visible (Research Desk).
			if (key === 'l') {
				event.preventDefault();
				event.stopPropagation();
				let opts = { preference: 'auto' };
				if (event.shiftKey) {
					opts.focus = false;
				}
				void Zotero.QLab.addCurrentContextToChat(win, opts).catch((e) => {
					Zotero.logError(e);
					try {
						Zotero.alert(null, 'QLab', e.message || String(e));
					}
					catch (_) {}
				});
				return;
			}

			// ⌘⇧K quotes the current PDF selection straight into the draft.
			if (key === 'k' && event.shiftKey) {
				event.preventDefault();
				event.stopPropagation();
				let reader = Zotero.Reader.getByTabID
					&& win.Zotero_Tabs
					&& Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
				void quoteSelectionIntoQmd({ reader, params: {} });
				return;
			}

			if (isEditableTarget(event.target)) {
				return;
			}
			if (key === 'i' && !event.shiftKey) {
				event.preventDefault();
				let reader = Zotero.Reader.getByTabID
					&& win.Zotero_Tabs
					&& Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
				if (!reader) {
					reader = (Zotero.Reader._readers || []).find(r => r._window === win);
				}
				void arrangeFromReader({ reader, params: {} }, 'pdf-chat');
			}
			else if (key === 'e' && event.shiftKey) {
				event.preventDefault();
				let reader = Zotero.Reader.getByTabID
					&& win.Zotero_Tabs
					&& Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
				void arrangeFromReader({ reader, params: {} }, 'pdf-editor');
			}
			else if (key === 'd' && event.shiftKey) {
				event.preventDefault();
				let reader = Zotero.Reader.getByTabID
					&& win.Zotero_Tabs
					&& Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
				if (!reader) {
					reader = (Zotero.Reader._readers || []).find(r => r._window === win);
				}
				void arrangeFromReader({ reader, params: {} }, 'desk');
			}
		}, true);
	}

	/**
	 * Also bind ⌘L on the main Zotero window (QMD shell / library focus).
	 */
	Zotero.QLab.installMainWindowShortcuts = function (win) {
		installShortcuts(win || Zotero.getMainWindow());
	};

	Zotero.QLab.registerReaderHooks = function () {
		if (_registered || !Zotero.Reader || !Zotero.Reader.registerEventListener) {
			return;
		}
		_registered = true;

		try {
			Zotero.QLab.installMainWindowShortcuts(Zotero.getMainWindow());
		}
		catch (e) {}

		let icons = Zotero.QLab.ReaderIcons || {};

		let toolbarHandler = (event) => {
			try {
				let { doc, append } = event;
				installShortcuts(doc.defaultView);
				append(makeIconButton(doc, {
					title: 'Add to Chat (⌘L)',
					iconSrc: icons.chat,
					onClick: () => askSelection(event),
				}));
				append(makeIconButton(doc, {
					title: 'Arrange PDF | Chat (⌘I)',
					iconSrc: icons.chatLayout,
					onClick: () => arrangeFromReader(event, 'pdf-chat'),
				}));
				append(makeIconButton(doc, {
					title: 'Arrange PDF | QMD Editor (⌘⇧E)',
					iconSrc: icons.editorSplit,
					onClick: () => arrangeFromReader(event, 'pdf-editor'),
				}));
				append(makeIconButton(doc, {
					title: 'Research Desk: PDF | QMD | Chat (⌘⇧D)',
					iconSrc: icons.desk,
					onClick: () => arrangeFromReader(event, 'desk'),
				}));
			}
			catch (e) {
				Zotero.logError(e);
			}
		};

		let selectionHandler = (event) => {
			try {
				let { doc, append } = event;
				installShortcuts(doc.defaultView);
				void Zotero.QLab.ReaderContextStore
					&& Zotero.QLab.ReaderContextStore.captureFromEvent(event).catch(() => {});
				let group = doc.createElement('div');
				group.style.cssText = 'display:flex;gap:4px;padding:2px 4px 0;margin-top:6px;';
				group.append(makeIconButton(doc, {
					title: 'Add selection to Chat (⌘L)',
					iconSrc: icons.chat,
					size: 28,
					iconSize: 20,
					onClick: () => askSelection(event),
				}));
				group.append(makeIconButton(doc, {
					title: 'Insert selection into QMD as quote (⌘⇧K)',
					iconSrc: icons.quote,
					size: 28,
					iconSize: 20,
					onClick: () => quoteSelectionIntoQmd(event),
				}));
				append(group);
			}
			catch (e) {
				Zotero.logError(e);
			}
		};

		Zotero.Reader.registerEventListener('renderToolbar', toolbarHandler, PLUGIN_ID);
		Zotero.Reader.registerEventListener('renderTextSelectionPopup', selectionHandler, PLUGIN_ID);
		_handlers.push(
			['renderToolbar', toolbarHandler],
			['renderTextSelectionPopup', selectionHandler],
		);
	};

	Zotero.QLab.unregisterReaderHooks = function () {
		if (!_registered || !Zotero.Reader) {
			return;
		}
		for (let [type, handler] of _handlers) {
			try {
				Zotero.Reader.unregisterEventListener(type, handler);
			}
			catch (e) {}
		}
		_handlers = [];
		_registered = false;
	};
})();
