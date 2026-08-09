/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Chance Siyuan / Chatero contributors

	This file is part of Chatero (a Zotero fork).

	***** END LICENSE BLOCK *****
*/

/**
 * Window-scoped pointer bridge for documents that do not bubble into the main
 * Zotero chrome document. Adapters report activity only; the resident
 * ChatUtilityHost and its pure controller remain the sole dismissal authority.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const CAPTURE = true;
	const CHAT_OWNED_SELECTORS = [
		'#qlab-chat-utility-dialog',
		'#qlab-chat-utility-content',
		'[data-qlab-chat-portal]',
		'[data-qlab-chat-popover]',
		'[data-qlab-chat-context]',
		'[data-qlab-context-tags]',
		'[data-qlab-at-picker]',
		'[data-qlab-chat-drag-handle]',
		'[data-qlab-chat-resize]',
	];

	function closestAny(target, selectors) {
		if (!target || typeof target.closest !== 'function') {
			return null;
		}
		for (let selector of selectors) {
			try {
				let match = target.closest(selector);
				if (match) return match;
			}
			catch (e) {}
		}
		return null;
	}

	function eventPath(event) {
		try {
			if (event && typeof event.composedPath === 'function') {
				return event.composedPath();
			}
		}
		catch (e) {}
		return event && event.target ? [event.target] : [];
	}

	function isChatOwnedEvent(event) {
		return eventPath(event).some(node => closestAny(node, CHAT_OWNED_SELECTORS));
	}

	function defaultMainSource(event) {
		if (isChatOwnedEvent(event)) return 'chat';
		let target = event && event.target;
		if (Zotero.QLab.qmdSurfaceInteractionSource) {
			let source = Zotero.QLab.qmdSurfaceInteractionSource(target);
			if (source) return source;
		}
		if (closestAny(target, ['[data-qlab-visual-surface]', '[data-qlab-visual-editor-root]'])) {
			return 'visual-edit';
		}
		if (closestAny(target, [
			'[data-qlab-source-surface]',
			'[data-qlab-primary-surface]',
			'.qlab-qmd-workspace',
		])) {
			return 'qmd';
		}
		return null;
	}

	function safeDispose(dispose) {
		try {
			dispose && dispose();
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
		}
	}

	Zotero.QLab.ChatOutsideInteractionBridge = function (options = {}) {
		this._host = options.host || null;
		this._disposers = new Set();
		this._documentAdapters = new WeakMap();
		this._eventTokens = new WeakMap();
		this._tokenSequence = 0;
		this._disposed = false;
		if (options.document) {
			this.attachMainDocument(options.document);
		}
	};

	Zotero.QLab.ChatOutsideInteractionBridge.prototype = {
		interactionToken(event) {
			if (!event || (typeof event !== 'object' && typeof event !== 'function')) {
				return `qlab-pointer-${++this._tokenSequence}`;
			}
			let existing = this._eventTokens.get(event);
			if (existing) return existing;
			let token = `qlab-pointer-${++this._tokenSequence}`;
			this._eventTokens.set(event, token);
			return token;
		},

		notify(source, event = null, extra = {}) {
			if (this._disposed || !this._host
					|| typeof this._host.handleInteraction !== 'function') {
				return {
					dismissed: false,
					ignoredOpening: false,
					consumed: false,
				};
			}
			let insideChat = extra.insideChat === true || isChatOwnedEvent(event);
			let path = insideChat ? ['chat-owned'] : [];
			let interaction = {
				source: insideChat ? 'chat' : source,
				workspace: !insideChat,
				insideChat,
				path,
				pointerId: extra.pointerId ?? (event && event.pointerId),
				button: extra.button ?? (event && event.button),
			};
			if (Object.prototype.hasOwnProperty.call(extra, 'invocationToken')
					&& extra.invocationToken !== undefined
					&& extra.invocationToken !== null) {
				interaction.invocationToken = extra.invocationToken;
			}
			return this._host.handleInteraction(interaction);
		},

		attachMainDocument(document) {
			return this._attachDocument(document, event => defaultMainSource(event));
		},

		attachReaderDocument(document) {
			return this._attachDocument(document, event => (
				closestAny(event && event.target, ['[data-qlab-chat-opening]'])
					? null
					: 'reader'
			));
		},

		_attachDocument(document, sourceForEvent) {
			if (this._disposed || !document || typeof document.addEventListener !== 'function') {
				return () => {};
			}
			let existing = this._documentAdapters.get(document);
			if (existing) return existing;
			let listener = event => {
				let source = sourceForEvent(event);
				if (!source) return;
				this.notify(source, event, { insideChat: source === 'chat' });
			};
			document.addEventListener('pointerdown', listener, CAPTURE);
			let disposed = false;
			let detach = () => {
				if (disposed) return;
				disposed = true;
				document.removeEventListener
					&& document.removeEventListener('pointerdown', listener, CAPTURE);
				this._documentAdapters.delete(document);
				this._disposers.delete(detach);
			};
			this._documentAdapters.set(document, detach);
			this._disposers.add(detach);
			return detach;
		},

		attachMonaco(adapter) {
			if (this._disposed || !adapter || typeof adapter.onEvent !== 'function') {
				return () => {};
			}
			let unsubscribe = adapter.onEvent(event => {
				if (!event || event.type !== 'pointer-activity') return;
				this.notify('monaco', null, event);
			});
			return this._track(() => safeDispose(unsubscribe));
		},

		attachQuickPreview(frame) {
			if (this._disposed || !frame || typeof frame.addEventListener !== 'function') {
				return () => {};
			}
			let detachDocument = null;
			let bindDocument = () => {
				safeDispose(detachDocument);
				detachDocument = null;
				try {
					let document = frame.contentDocument;
					if (document) {
						detachDocument = this._attachDocument(document, () => 'quick-preview');
					}
				}
				catch (e) {
					// A Quick Preview that navigated away from srcdoc is handled by
					// the remote Website Preview adapter instead.
				}
			};
			frame.addEventListener('load', bindDocument, CAPTURE);
			bindDocument();
			return this._track(() => {
				frame.removeEventListener
					&& frame.removeEventListener('load', bindDocument, CAPTURE);
				safeDispose(detachDocument);
				detachDocument = null;
			});
		},

		attachWebsitePreview(browser) {
			if (this._disposed || !browser
					|| typeof Zotero.QLab.bindQmdPreviewPointerBridge !== 'function') {
				return () => {};
			}
			let dispose = Zotero.QLab.bindQmdPreviewPointerBridge(browser, data => {
				this.notify('website-preview', null, data || {});
			});
			return this._track(dispose);
		},

		_track(dispose) {
			if (typeof dispose !== 'function') return () => {};
			let disposed = false;
			let tracked = () => {
				if (disposed) return;
				disposed = true;
				this._disposers.delete(tracked);
				safeDispose(dispose);
			};
			this._disposers.add(tracked);
			return tracked;
		},

		dispose() {
			if (this._disposed) return;
			this._disposed = true;
			for (let dispose of [...this._disposers]) safeDispose(dispose);
			this._disposers.clear();
			this._host = null;
		},
	};
})();
