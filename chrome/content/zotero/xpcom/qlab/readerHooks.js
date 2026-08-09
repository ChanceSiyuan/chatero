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
	let _readerDocumentAdapters = new Map();

	function iconButtonCSS(size = 32) {
		return `display:grid;place-items:center;width:${size}px;height:${size}px;border:0;`
			+ 'border-radius:8px;background:transparent;cursor:pointer;padding:5px;'
			+ 'color:var(--fill-secondary, #555);';
	}

	function makeIconButton(doc, {
		title,
		iconSrc,
		onClick,
		size = 32,
		iconSize = 22,
		opensChat = false,
	}) {
		let button = doc.createElement('button');
		button.type = 'button';
		button.title = title;
		button.setAttribute('aria-label', title);
		if (opensChat) button.setAttribute('data-qlab-chat-opening', 'true');
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
			void onClick(event);
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

	async function askSelection(event, activationEvent = null) {
		try {
			let win = (event.reader && event.reader._window) || Zotero.getMainWindow();
			let interactionBridge = win && win.Zotero_Tabs && win.Zotero_Tabs._qlab
				&& win.Zotero_Tabs._qlab.chatOutsideInteraction;
			if (interactionBridge && activationEvent) {
				let openingToken = interactionBridge.interactionToken(activationEvent);
				win.Zotero_Tabs._qlab.showUtility('qlabchat', null, {
					invocation: 'reader-selection',
					openingToken,
				});
				interactionBridge.notify('reader', activationEvent, { invocationToken: openingToken });
			}
			if (Zotero.QLab.ReaderContextStore) {
				await Zotero.QLab.ReaderContextStore.captureFromEvent(event);
			}
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

	function shortcutReader(win) {
		let shortcutContext = win && win._qlabReaderShortcutContext;
		if (shortcutContext && shortcutContext.reader) return shortcutContext.reader;
		return Zotero.Reader.getByTabID
			&& win && win.Zotero_Tabs
			&& Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
	}

	function shortcutMainWindow(win, reader) {
		return (reader && reader._window) || (win && win.Zotero_Tabs ? win : Zotero.getMainWindow());
	}

	function hasCapturedReaderSelection(win, reader) {
		let params = win && win._qlabReaderShortcutContext
			&& win._qlabReaderShortcutContext.params;
		let annotationText = params && params.annotation && params.annotation.text;
		if (String(annotationText || '').length > 0) return true;
		try {
			let context = Zotero.QLab.ReaderContextStore && Zotero.QLab.ReaderContextStore.get();
			return !!(context && context.attachment && reader
				&& context.attachment.id === reader.itemID
				&& context.selection
				&& String(context.selection.text || '').length > 0);
		}
		catch (e) {
			return false;
		}
	}

	function installShortcuts(win, readerEvent = null) {
		if (!win) {
			return;
		}
		if (readerEvent && readerEvent.reader) {
			win._qlabReaderShortcutContext = {
				reader: readerEvent.reader,
				params: readerEvent.params || {},
			};
		}
		if (win._qlabShortcutsBound) return;
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
				let reader = shortcutReader(win);
				if (reader) {
					opts.reader = reader;
					opts.params = (win._qlabReaderShortcutContext
						&& win._qlabReaderShortcutContext.params) || {};
				}
				if (event.shiftKey) {
					opts.focus = false;
				}
				void Zotero.QLab.addCurrentContextToChat(
					shortcutMainWindow(win, reader), opts
				).catch((e) => {
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
				let reader = shortcutReader(win);
				let params = (win._qlabReaderShortcutContext
					&& win._qlabReaderShortcutContext.params) || {};
				void quoteSelectionIntoQmd({ reader, params });
				return;
			}

			// With a PDF selection, ⌘K opens the resident Chat utility with the
			// exact captured selection as composer context. Unlike ⌘⇧K, it never
			// writes into the QMD Draft.
			if (key === 'k' && !event.shiftKey && !isEditableTarget(event.target)) {
				let shortcutContext = win._qlabReaderShortcutContext || {};
				let reader = shortcutReader(win);
				if (!reader || !hasCapturedReaderSelection(win, reader)) return;
				event.preventDefault();
				event.stopPropagation();
				let mainWindow = shortcutMainWindow(win, reader);
				void Zotero.QLab.addCurrentContextToChat(mainWindow, {
					reader,
					params: shortcutContext.params || {},
					preference: 'selection',
					focus: true,
				}).catch((e) => Zotero.logError(e));
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

	function interactionBridgeFor(event) {
		let win = event && event.reader && event.reader._window;
		if (!win) {
			try {
				win = Zotero.getMainWindow();
			}
			catch (e) {}
		}
		return win && win.Zotero_Tabs && win.Zotero_Tabs._qlab
			&& win.Zotero_Tabs._qlab.chatOutsideInteraction;
	}

	function attachReaderDocument(event, doc) {
		let bridge = interactionBridgeFor(event);
		if (!doc || !bridge || !bridge.attachReaderDocument) return;
		let existing = _readerDocumentAdapters.get(doc);
		if (existing && existing.bridge === bridge) return;
		existing && existing.release();
		let detach = bridge.attachReaderDocument(doc);
		let lifecycleTarget = doc.defaultView || doc;
		let released = false;
		let release = () => {
			if (released) return;
			released = true;
			if (lifecycleTarget && lifecycleTarget.removeEventListener) {
				lifecycleTarget.removeEventListener('pagehide', release, true);
				lifecycleTarget.removeEventListener('unload', release, true);
			}
			try {
				detach && detach();
			}
			catch (e) {
				Zotero.logError && Zotero.logError(e);
			}
			if (_readerDocumentAdapters.get(doc)?.release === release) {
				_readerDocumentAdapters.delete(doc);
			}
		};
		_readerDocumentAdapters.set(doc, { bridge, release });
		if (lifecycleTarget && lifecycleTarget.addEventListener) {
			lifecycleTarget.addEventListener('pagehide', release, true);
			lifecycleTarget.addEventListener('unload', release, true);
		}
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
				attachReaderDocument(event, doc);
				installShortcuts(doc.defaultView, event);
				append(makeIconButton(doc, {
					title: 'Add to Chat (⌘L)',
					iconSrc: icons.chat,
					opensChat: true,
					onClick: activationEvent => askSelection(event, activationEvent),
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
				attachReaderDocument(event, doc);
				installShortcuts(doc.defaultView, event);
				void Zotero.QLab.ReaderContextStore
					&& Zotero.QLab.ReaderContextStore.captureFromEvent(event).catch(() => {});
				let group = doc.createElement('div');
				group.style.cssText = 'display:flex;gap:4px;padding:2px 4px 0;margin-top:6px;';
				group.append(makeIconButton(doc, {
					title: 'Add selection to Chat (⌘L)',
					iconSrc: icons.chat,
					size: 28,
					iconSize: 20,
					opensChat: true,
					onClick: activationEvent => askSelection(event, activationEvent),
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
		for (let adapter of [..._readerDocumentAdapters.values()]) {
			adapter.release();
		}
		_readerDocumentAdapters.clear();
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
