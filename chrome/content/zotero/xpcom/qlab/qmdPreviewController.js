/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Resilient lifecycle for a single Draft's live Quarto preview.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	/**
	 * Parent half of the remote Website Preview pointer bridge. Rebinding on
	 * browser load covers remoteness changes without inspecting the web page.
	 */
	Zotero.QLab.bindQmdPreviewPointerBridge = function (browser, onPointer) {
		if (!browser || typeof onPointer !== 'function') return () => {};
		let messageName = Zotero.QLab.QMD_PREVIEW_POINTER_MESSAGE
			|| 'QLab:QmdPreviewPointerActivity';
		let manager = null;
		let listener = message => onPointer(message && message.data || {});
		let disposed = false;
		let bind = () => {
			if (disposed) return;
			let next = null;
			try {
				next = browser.messageManager || null;
			}
			catch (e) {}
			if (!next || next === manager) return;
			if (manager && typeof manager.removeMessageListener === 'function') {
				manager.removeMessageListener(messageName, listener);
			}
			manager = next;
			manager.addMessageListener(messageName, listener);
			if (typeof manager.loadFrameScript === 'function'
					&& typeof Zotero.QLab.qmdPreviewPointerFrameScript === 'function') {
				manager.loadFrameScript(Zotero.QLab.qmdPreviewPointerFrameScript(), true);
			}
		};
		browser.addEventListener && browser.addEventListener('load', bind, true);
		bind();
		return () => {
			if (disposed) return;
			disposed = true;
			browser.removeEventListener && browser.removeEventListener('load', bind, true);
			if (manager && typeof manager.removeMessageListener === 'function') {
				manager.removeMessageListener(messageName, listener);
			}
			manager = null;
		};
	};

	function clone(value) {
		return JSON.parse(JSON.stringify(value));
	}

	function normalizedPath(value) {
		return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
	}

	Zotero.QLab.parseQmdQuartoDiagnostics = function (output, relativePath) {
		let expected = normalizedPath(relativePath);
		let seen = new Set();
		let diagnostics = [];
		let pattern = /^(?:ERROR:\s*)?(.+?\.qmd):(\d+):(\d+)\s+(.+)$/gm;
		let match;
		while ((match = pattern.exec(String(output || '')))) {
			let file = normalizedPath(match[1].trim());
			if (file !== expected && !file.endsWith(`/${expected}`)) continue;
			let diagnostic = {
				code: 'quarto',
				severity: 'error',
				message: match[4].trim(),
				line: Number(match[2]),
				column: Number(match[3]),
			};
			let key = JSON.stringify(diagnostic);
			if (!seen.has(key)) {
				seen.add(key);
				diagnostics.push(diagnostic);
			}
		}
		return diagnostics;
	};

	Zotero.QLab.createQmdPreviewController = function ({
		root,
		path,
		startPreview = Zotero.QLab.startQmdQuartoPreview,
		stopPreview = Zotero.QLab.stopQmdQuartoPreview,
		fallback = null,
		reveal = null,
		onState = () => {},
		visible = true,
	} = {}) {
		if (!root || !path || typeof startPreview !== 'function') {
			throw new Error('QMD Preview controller requires a root, Draft path, and preview starter');
		}
		let state = {
			root,
			path,
			status: 'idle',
			url: '',
			fallback: '',
			error: '',
			diagnostics: [],
			revision: '',
			visible: visible !== false,
			pendingRefresh: false,
			crashCount: 0,
			canAutoRestart: true,
			disposed: false,
		};
		let ownsSession = false;
		let generation = 0;
		let sessionOwner = { released: false };

		function snapshot() {
			return clone(state);
		}

		function publish() {
			onState(snapshot());
		}

		async function launch({ manual = false } = {}) {
			if (state.disposed) return snapshot();
			if (!state.visible) {
				state.status = 'stale';
				state.pendingRefresh = true;
				publish();
				return snapshot();
			}
			if (!manual && !state.canAutoRestart) return snapshot();
			let currentGeneration = ++generation;
			if (typeof fallback === 'function') {
				try {
					let quick = fallback({ root, path, phase: 'rendering' });
					if (quick && typeof quick.then === 'function') quick = await quick;
					if (state.disposed || currentGeneration !== generation) return snapshot();
					state.fallback = String(quick || state.fallback || '');
				}
				catch (fallbackError) {
					Zotero.logError && Zotero.logError(fallbackError);
				}
			}
			state.status = 'rendering';
			state.error = '';
			state.pendingRefresh = false;
			publish();
			try {
				let pendingPreview = startPreview(root, path, { owner: sessionOwner });
				ownsSession = true;
				let url = await pendingPreview;
				if (state.disposed || currentGeneration !== generation) return snapshot();
				state.url = String(url || '');
				state.status = 'ready';
				state.diagnostics = [];
				state.crashCount = 0;
				state.canAutoRestart = true;
				ownsSession = true;
			}
			catch (error) {
				if (state.disposed || currentGeneration !== generation) return snapshot();
				state.crashCount++;
				state.canAutoRestart = state.crashCount < 3;
				state.status = 'error';
				state.error = error && error.message ? error.message : String(error);
				let output = error && (error.stderr || error.output || error.message);
				state.diagnostics = Zotero.QLab.parseQmdQuartoDiagnostics(output, path);
			}
			publish();
			return snapshot();
		}

		return {
			start() {
				return launch();
			},
			refresh(savedRevision = '') {
				state.revision = String(savedRevision || '');
				return launch();
			},
			retry() {
				return launch({ manual: true });
			},
			revealBlock(key) {
				if (typeof reveal === 'function') {
					return reveal(key, snapshot());
				}
				return false;
			},
			setVisible(visible) {
				state.visible = !!visible;
				if (!state.visible) {
					publish();
					return Promise.resolve(snapshot());
				}
				if (state.pendingRefresh || state.status === 'idle' || state.status === 'stale') {
					return launch();
				}
				publish();
				return Promise.resolve(snapshot());
			},
			snapshot,
			dispose() {
				if (state.disposed) return;
				state.disposed = true;
				generation++;
				sessionOwner.released = true;
				if (ownsSession && typeof stopPreview === 'function') {
					stopPreview(root, path, { owner: sessionOwner });
				}
				ownsSession = false;
				publish();
			},
		};
	};
})();
