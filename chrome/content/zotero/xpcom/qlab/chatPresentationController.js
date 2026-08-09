/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Pure window-presentation state for the resident Chat utility.
 *
 * This module deliberately has no DOM, transcript, or Agent dependency. The
 * window host translates state into UI and owns focus/drag pointer mechanics;
 * the existing Chat runtime continues to own messages and running work.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const PREFERRED_WIDTH = 720;
	const PREFERRED_HEIGHT = 680;
	const MIN_WIDTH = 480;
	const MIN_HEIGHT = 420;
	const MAX_WIDTH = 860;
	const NORMAL_MARGIN = 24;
	const COMPACT_MARGIN = 16;
	const DEFAULT_VIEWPORT = { width: 1200, height: 800 };
	const WORKSPACE_SOURCES = new Set([
		'pdf',
		'reader',
		'qmd',
		'visual-edit',
		'monaco',
		'quick-preview',
		'website-preview',
	]);

	function finiteNumber(value) {
		return typeof value === 'number' && Number.isFinite(value);
	}

	function normalizeViewport(viewport) {
		let width = finiteNumber(viewport && viewport.width) && viewport.width > 0
			? viewport.width
			: DEFAULT_VIEWPORT.width;
		let height = finiteNumber(viewport && viewport.height) && viewport.height > 0
			? viewport.height
			: DEFAULT_VIEWPORT.height;
		return { width, height };
	}

	function marginFor(viewport) {
		return viewport.width >= MIN_WIDTH + NORMAL_MARGIN * 2
			&& viewport.height >= MIN_HEIGHT + NORMAL_MARGIN * 2
			? NORMAL_MARGIN
			: COMPACT_MARGIN;
	}

	function validBounds(bounds) {
		return finiteNumber(bounds && bounds.left)
			&& finiteNumber(bounds.top)
			&& finiteNumber(bounds.width)
			&& finiteNumber(bounds.height)
			&& bounds.width > 0
			&& bounds.height > 0;
	}

	function clamp(value, minimum, maximum) {
		return Math.min(maximum, Math.max(minimum, value));
	}

	function centeredBounds(viewport) {
		return constrainBounds({
			left: (viewport.width - PREFERRED_WIDTH) / 2,
			top: (viewport.height - PREFERRED_HEIGHT) / 2,
			width: PREFERRED_WIDTH,
			height: PREFERRED_HEIGHT,
		}, viewport, true);
	}

	function constrainBounds(bounds, viewport, knownValid = false) {
		viewport = normalizeViewport(viewport);
		if (!knownValid && !validBounds(bounds)) {
			return centeredBounds(viewport);
		}
		let margin = marginFor(viewport);
		let availableWidth = Math.max(1, viewport.width - margin * 2);
		let availableHeight = Math.max(1, viewport.height - margin * 2);
		let minimumWidth = Math.min(MIN_WIDTH, availableWidth);
		let minimumHeight = Math.min(MIN_HEIGHT, availableHeight);
		let maximumWidth = Math.max(minimumWidth, Math.min(MAX_WIDTH, availableWidth));
		let maximumHeight = Math.max(minimumHeight, availableHeight);
		let width = clamp(bounds.width, minimumWidth, maximumWidth);
		let height = clamp(bounds.height, minimumHeight, maximumHeight);
		let maxLeft = Math.max(margin, viewport.width - margin - width);
		let maxTop = Math.max(margin, viewport.height - margin - height);
		return {
			left: clamp(bounds.left, margin, maxLeft),
			top: clamp(bounds.top, margin, maxTop),
			width,
			height,
		};
	}

	function cloneBounds(bounds) {
		return {
			left: bounds.left,
			top: bounds.top,
			width: bounds.width,
			height: bounds.height,
		};
	}

	function pathIsChatOwned(path) {
		if (!Array.isArray(path)) {
			return false;
		}
		return path.some(entry => {
			if (entry === 'chat' || entry === 'chat-owned' || entry === 'qlab-chat-utility') {
				return true;
			}
			return Boolean(entry && typeof entry === 'object'
				&& (entry.insideChat === true || entry.owner === 'chat'));
		});
	}

	/**
	 * Classify adapter output without inspecting or mutating the source event.
	 * Embedded documents normalize their local event paths before calling this.
	 */
	Zotero.QLab.classifyChatInteraction = function (interaction) {
		interaction = interaction && typeof interaction === 'object' ? interaction : {};
		if (interaction.insideChat === true
			|| interaction.source === 'chat'
			|| pathIsChatOwned(interaction.path)) {
			return 'inside-chat';
		}
		if (interaction.workspace === true || WORKSPACE_SOURCES.has(interaction.source)) {
			return 'workspace';
		}
		return 'other';
	};

	/**
	 * @param {{
	 *   viewport?: { width: number, height: number },
	 *   onChange?: Function,
	 *   onPersist?: Function,
	 * }} [options]
	 */
	Zotero.QLab.ChatPresentationController = function (options = {}) {
		this._viewport = normalizeViewport(options.viewport);
		this._onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
		this._onPersist = typeof options.onPersist === 'function' ? options.onPersist : () => {};
		this._openingToken = null;
		this._state = {
			visibility: 'hidden',
			pinned: false,
			bounds: centeredBounds(this._viewport),
			invocation: null,
			focusComposer: false,
			focusReturn: null,
		};
	};

	Zotero.QLab.ChatPresentationController.prototype = {
		snapshot() {
			return {
				visibility: this._state.visibility,
				pinned: this._state.pinned,
				bounds: cloneBounds(this._state.bounds),
				invocation: this._state.invocation,
				focusComposer: this._state.focusComposer,
				focusReturn: this._state.focusReturn,
			};
		},

		show(options = {}) {
			if (options.viewport) {
				this._viewport = normalizeViewport(options.viewport);
				this._state.bounds = constrainBounds(this._state.bounds, this._viewport);
			}
			this._state.visibility = 'visible';
			if (Object.prototype.hasOwnProperty.call(options, 'invocation')) {
				this._state.invocation = options.invocation;
			}
			this._state.focusComposer = options.focusComposer === true;
			if (Object.prototype.hasOwnProperty.call(options, 'focusReturn')) {
				this._state.focusReturn = options.focusReturn;
			}
			this._openingToken = Object.prototype.hasOwnProperty.call(options, 'openingToken')
					&& options.openingToken !== undefined
					&& options.openingToken !== null
				? options.openingToken
				: null;
			return this._emit({ focusComposer: this._state.focusComposer });
		},

		hide(options = {}) {
			let restoreFocus = options.restoreFocus !== false;
			let focusReturn = restoreFocus ? this._state.focusReturn : null;
			this._state.visibility = 'hidden';
			this._state.focusComposer = false;
			this._openingToken = null;
			return this._emit({ focusReturn });
		},

		toggle(options = {}) {
			return this._state.visibility === 'visible'
				? this.hide({ restoreFocus: options.restoreFocus })
				: this.show(options);
		},

		setPinned(value) {
			let pinned = value === true;
			if (this._state.pinned === pinned) {
				return { state: this.snapshot() };
			}
			this._state.pinned = pinned;
			return this._emit({}, true);
		},

		setBounds(bounds) {
			let next = constrainBounds(bounds, this._viewport);
			if (sameBounds(next, this._state.bounds)) {
				return { state: this.snapshot() };
			}
			this._state.bounds = next;
			return this._emit({}, true);
		},

		setViewport(viewport) {
			this._viewport = normalizeViewport(viewport);
			let next = constrainBounds(this._state.bounds, this._viewport);
			if (sameBounds(next, this._state.bounds)) {
				return { state: this.snapshot() };
			}
			this._state.bounds = next;
			return this._emit();
		},

		restore(persisted = {}) {
			this._state = {
				visibility: 'hidden',
				pinned: persisted.pinned === true,
				bounds: validBounds(persisted.bounds)
					? constrainBounds(persisted.bounds, this._viewport)
					: centeredBounds(this._viewport),
				invocation: null,
				focusComposer: false,
				focusReturn: null,
			};
			this._openingToken = null;
			return this._emit();
		},

		handleInteraction(interaction) {
			let classification = Zotero.QLab.classifyChatInteraction(interaction);
			let invocationToken = interaction && interaction.invocationToken;
			if (this._openingToken !== null && invocationToken === this._openingToken) {
				this._openingToken = null;
				return {
					state: this.snapshot(),
					classification,
					ignoredOpening: true,
					dismissed: false,
					consumed: false,
					focusReturn: null,
				};
			}
			if (this._state.visibility === 'visible'
				&& !this._state.pinned
				&& classification === 'workspace') {
				let hidden = this.hide({ restoreFocus: true });
				return {
					...hidden,
					classification,
					ignoredOpening: false,
					dismissed: true,
					consumed: false,
				};
			}
			return {
				state: this.snapshot(),
				classification,
				ignoredOpening: false,
				dismissed: false,
				consumed: false,
				focusReturn: null,
			};
		},

		_emit(extra = {}, persist = false) {
			let state = this.snapshot();
			this._onChange(state);
			if (persist) {
				this._onPersist({
					pinned: state.pinned,
					bounds: cloneBounds(state.bounds),
				});
			}
			return { state, ...extra };
		},
	};

	function sameBounds(left, right) {
		return left.left === right.left
			&& left.top === right.top
			&& left.width === right.width
			&& left.height === right.height;
	}
})();
