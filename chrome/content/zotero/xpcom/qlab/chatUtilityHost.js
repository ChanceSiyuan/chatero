/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

Zotero.QLab = Zotero.QLab || {};

(function () {
	const CHAT_KIND = 'qlabchat';
	const ACTIVITY_STATES = new Set(['idle', 'running', 'completed', 'error']);

	Zotero.QLab.isChatUtilityTab = function (tab) {
		return Boolean(tab && (tab.type === CHAT_KIND || tab.id === CHAT_KIND));
	};

	/**
	 * Route a native Chat launcher activation without changing content selection.
	 * Returning true tells Zotero_Tabs.select() that the request was handled.
	 */
	Zotero.QLab.routeUtilityLauncherSelection = function (tabsAPI, tab, options = {}) {
		if (!Zotero.QLab.isChatUtilityTab(tab)) {
			return false;
		}
		try {
			tabsAPI && tabsAPI._qlab && tabsAPI._qlab.toggleUtility
				&& tabsAPI._qlab.toggleUtility(CHAT_KIND, options);
			tabsAPI && tabsAPI._update && tabsAPI._update();
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
		}
		return true;
	};

	/**
	 * Resolve ordinary previous/next tab navigation while excluding utilities.
	 */
	Zotero.QLab.nextContentTabID = function (tabs, selectedID, direction) {
		let content = (Array.isArray(tabs) ? tabs : [])
			.filter(tab => !Zotero.QLab.isChatUtilityTab(tab));
		if (!content.length) {
			return null;
		}
		let index = content.findIndex(tab => tab.id === selectedID);
		if (index < 0) {
			index = 0;
		}
		let delta = direction < 0 ? -1 : 1;
		return content[(index + delta + content.length) % content.length].id;
	};

	Zotero.QLab.contentTabAfterClose = function (
		tabs,
		closingID,
		closingIDs,
		previousSelectedID
	) {
		tabs = Array.isArray(tabs) ? tabs : [];
		closingIDs = Array.isArray(closingIDs) ? closingIDs : [closingID];
		let available = tab => tab
			&& !closingIDs.includes(tab.id)
			&& !Zotero.QLab.isChatUtilityTab(tab);
		let previous = tabs.find(tab => tab.id === previousSelectedID);
		if (available(previous)) {
			return previous.id;
		}
		let index = tabs.findIndex(tab => tab.id === closingID);
		let candidate = tabs
			.slice(index + 1)
			.concat(tabs.slice(0, Math.max(0, index)).reverse())
			.find(available);
		return candidate ? candidate.id : null;
	};

	function resolveElements(doc) {
		if (!doc) {
			return {};
		}
		return {
			layer: doc.getElementById('qlab-chat-utility-layer'),
			dialog: doc.getElementById('qlab-chat-utility-dialog'),
			content: doc.getElementById('qlab-chat-utility-content'),
			header: doc.querySelector('[data-qlab-chat-drag-handle]'),
			pinButton: doc.querySelector('[data-qlab-chat-pin]'),
			hideButton: doc.querySelector('[data-qlab-chat-hide]'),
			resizeHandle: doc.querySelector('[data-qlab-chat-resize]'),
		};
	}

	function viewportFrom(win, layer) {
		if (layer && typeof layer.getBoundingClientRect === 'function') {
			let rect = layer.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				return { width: rect.width, height: rect.height };
			}
		}
		return {
			width: win && win.innerWidth || 1200,
			height: win && win.innerHeight || 800,
		};
	}

	function focusElement(element) {
		try {
			element && typeof element.focus === 'function' && element.focus();
		}
		catch (e) {}
	}

	/**
	 * Window-owned adapter around the pure ChatPresentationController.
	 * The full Chat shell is mounted lazily once, then remains resident until
	 * destroy() is called by Zotero_Tabs window shutdown.
	 */
	Zotero.QLab.ChatUtilityHost = function (options = {}) {
		this._document = options.document || null;
		this._window = options.window
			|| this._document && this._document.defaultView
			|| null;
		this._elements = options.elements || resolveElements(this._document);
		this._viewport = typeof options.viewport === 'function'
			? options.viewport
			: () => viewportFrom(this._window, this._elements.layer);
		this._mountChat = typeof options.mountChat === 'function'
			? options.mountChat
			: () => Promise.resolve(null);
		this._disposeChat = typeof options.disposeChat === 'function'
			? options.disposeChat
			: () => {};
		this._persist = typeof options.persist === 'function' ? options.persist : () => {};
		this._onLauncherChange = typeof options.onLauncherChange === 'function'
			? options.onLauncherChange
			: () => {};
		this._mountPromise = null;
		this._mounted = false;
		this._runtime = null;
		this._destroyed = false;
		this._activityStatus = 'idle';
		this._bindings = [];
		this._activeGestureCleanup = null;

		this._controller = new Zotero.QLab.ChatPresentationController({
			viewport: this._viewport(),
			onChange: state => this._render(state),
			onPersist: state => this._persist(state),
		});
		this._bindControls();
		this._controller.restore(options.restore || {});
	};

	Zotero.QLab.ChatUtilityHost.prototype = {
		snapshot() {
			return {
				...this._controller.snapshot(),
				activityStatus: this._activityStatus,
				mounted: this._mounted,
			};
		},

		ensureMounted() {
			if (this._mounted) {
				return Promise.resolve(this._runtime);
			}
			if (this._mountPromise) {
				return this._mountPromise;
			}
			let content = this._elements.content;
			this._mountPromise = Promise.resolve(this._mountChat(content))
				.then(runtime => {
					if (this._destroyed) {
						return runtime;
					}
					this._runtime = runtime;
					this._mounted = true;
					this._notifyLauncher();
					return runtime;
				})
				.catch(error => {
					this._mountPromise = null;
					this.setActivityStatus('error');
					Zotero.logError && Zotero.logError(error);
					return null;
				});
			return this._mountPromise;
		},

		show(options = {}) {
			let ready = this.ensureMounted();
			let result = this._controller.show({
				...options,
				viewport: this._viewport(),
			});
			if (result.focusComposer) {
				void ready.then(() => {
					focusElement(this._elements.content
						&& this._elements.content.querySelector('[data-qlab-prompt]'));
				});
			}
			return ready.then(() => result);
		},

		hide(options = {}) {
			let result = this._controller.hide(options);
			focusElement(result.focusReturn);
			return result;
		},

		toggle(options = {}) {
			return this.snapshot().visibility === 'visible'
				? this.hide(options)
				: this.show(options);
		},

		closeLauncher() {
			// Launcher lifetime is deliberately independent from the resident shell.
			return this.hide({ restoreFocus: true });
		},

		setPinned(pinned) {
			return this._controller.setPinned(pinned);
		},

		setActivityStatus(status) {
			this._activityStatus = ACTIVITY_STATES.has(status) ? status : 'idle';
			this._render(this._controller.snapshot());
			return this._activityStatus;
		},

		handleInteraction(interaction) {
			let result = this._controller.handleInteraction(interaction);
			if (result.focusReturn) {
				focusElement(result.focusReturn);
			}
			return result;
		},

		destroy() {
			if (this._destroyed) {
				return;
			}
			this._destroyed = true;
			this._activeGestureCleanup && this._activeGestureCleanup();
			for (let binding of this._bindings.splice(0)) {
				binding.target.removeEventListener(binding.type, binding.listener, binding.options);
			}
			this._disposeChat(this._elements.content, this._runtime);
		},

		_bind(target, type, listener, options) {
			if (!target || typeof target.addEventListener !== 'function') {
				return;
			}
			target.addEventListener(type, listener, options);
			this._bindings.push({ target, type, listener, options });
		},

		_bindControls() {
			let { header, pinButton, hideButton, resizeHandle } = this._elements;
			this._bind(pinButton, 'click', () => {
				this.setPinned(!this.snapshot().pinned);
			});
			this._bind(hideButton, 'click', () => this.hide({ restoreFocus: true }));
			this._bind(header, 'pointerdown', event => {
				if (pinButton && pinButton.contains && pinButton.contains(event.target)
						|| hideButton && hideButton.contains && hideButton.contains(event.target)) {
					return;
				}
				this._beginPointerGesture('drag', event);
			});
			this._bind(resizeHandle, 'pointerdown', event => {
				this._beginPointerGesture('resize', event);
			});
			this._bind(this._window, 'resize', () => {
				this._controller.setViewport(this._viewport());
			});
		},

		_beginPointerGesture(kind, event) {
			if (!event || event.button !== 0 || !this._window) {
				return;
			}
			event.preventDefault && event.preventDefault();
			event.target && event.target.setPointerCapture
				&& event.target.setPointerCapture(event.pointerId);
			let startX = event.clientX;
			let startY = event.clientY;
			let start = this._controller.snapshot().bounds;
			let preview = { ...start };
			let pointerId = event.pointerId;
			this._activeGestureCleanup && this._activeGestureCleanup();
			let onMove = moveEvent => {
				if (pointerId !== undefined && moveEvent.pointerId !== pointerId) {
					return;
				}
				let dx = moveEvent.clientX - startX;
				let dy = moveEvent.clientY - startY;
				preview = kind === 'drag'
					? { ...start, left: start.left + dx, top: start.top + dy }
					: { ...start, width: start.width + dx, height: start.height + dy };
				this._paintBounds(preview);
			};
			let cleanup = () => {
				this._window.removeEventListener('pointermove', onMove, true);
				this._window.removeEventListener('pointerup', onUp, true);
				if (this._activeGestureCleanup === cleanup) {
					this._activeGestureCleanup = null;
				}
			};
			let onUp = upEvent => {
				if (pointerId !== undefined && upEvent.pointerId !== pointerId) {
					return;
				}
				cleanup();
				this._controller.setBounds(preview);
			};
			this._activeGestureCleanup = cleanup;
			this._window.addEventListener('pointermove', onMove, true);
			this._window.addEventListener('pointerup', onUp, true);
		},

		_paintBounds(bounds) {
			let dialog = this._elements.dialog;
			if (!dialog || !dialog.style) {
				return;
			}
			dialog.style.setProperty('--qlab-chat-left', `${bounds.left}px`);
			dialog.style.setProperty('--qlab-chat-top', `${bounds.top}px`);
			dialog.style.setProperty('--qlab-chat-width', `${bounds.width}px`);
			dialog.style.setProperty('--qlab-chat-height', `${bounds.height}px`);
		},

		_render(state) {
			let { layer, dialog, pinButton } = this._elements;
			if (layer) {
				layer.hidden = state.visibility !== 'visible';
				layer.setAttribute && layer.setAttribute(
					'aria-hidden',
					state.visibility === 'visible' ? 'false' : 'true'
				);
				layer.setAttribute && layer.setAttribute('data-activity-status', this._activityStatus);
				layer.toggleAttribute && layer.toggleAttribute('data-pinned', state.pinned);
			}
			if (dialog) {
				dialog.setAttribute && dialog.setAttribute('data-pinned', state.pinned ? 'true' : 'false');
			}
			if (pinButton) {
				pinButton.setAttribute && pinButton.setAttribute(
					'aria-pressed',
					state.pinned ? 'true' : 'false'
				);
				pinButton.setAttribute && pinButton.setAttribute(
					'title',
					state.pinned ? 'Unpin Chat' : 'Pin Chat'
				);
			}
			this._paintBounds(state.bounds);
			this._notifyLauncher();
		},

		_notifyLauncher() {
			this._onLauncherChange({
				pressed: this._controller.snapshot().visibility === 'visible',
				activityStatus: this._activityStatus,
				mounted: this._mounted,
			});
		},
	};
})();
