/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Parent-window bridge for the dedicated QLab Monaco iframe.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	function draftPath(relativePath) {
		let path = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
		if (!Zotero.QLab.isSafeWorkspaceRelativePath(path, { under: 'drafts' })
				|| !path.toLowerCase().endsWith('.qmd')) {
			throw new Error('Monaco can edit only QMD files under drafts/');
		}
		return path;
	}
	
	function proposalURI(relativePath) {
		return Zotero.QLab.qmdMonacoModelURI('', relativePath).replace(/\.qmd$/, '.proposed.qmd');
	}
	
	Zotero.QLab.qmdMonacoModelURI = function (_root, relativePath) {
		return `inmemory://qlab/${encodeURI(draftPath(relativePath))}`;
	};
	
	Zotero.QLab.qmdMonacoOptions = function ({ theme = 'dark', wordWrap = 'on' } = {}) {
		return {
			theme: theme === 'light' ? 'vs' : 'vs-dark',
			language: 'markdown',
			wordWrap,
			minimap: { enabled: false },
			tabSize: 2,
			insertSpaces: true,
			detectIndentation: true,
			automaticLayout: true,
			scrollBeyondLastLine: false,
			renderWhitespace: 'selection',
			links: true,
			padding: { top: 12, bottom: 28 },
		};
	};
	
	Zotero.QLab.createQmdMonacoBridge = function ({
		adapter,
		session,
		language = text => Zotero.QLab.qmdLanguageSnapshot(text, ''),
		onCommand = () => {},
		onCursor = () => {},
	} = {}) {
		if (!adapter || !session || typeof adapter.onEvent !== 'function') {
			throw new Error('QMD Monaco bridge requires adapter and Draft session');
		}
		let disposed = false;
		let mode = 'normal';
		
		function normalPayload() {
			let snapshot = session.snapshot();
			let languageSnapshot = language(snapshot.text);
			return {
				uri: Zotero.QLab.qmdMonacoModelURI('', snapshot.path),
				text: snapshot.text,
				options: Zotero.QLab.qmdMonacoOptions(),
				completions: Zotero.QLab.qmdCompletionItems
					? Zotero.QLab.qmdCompletionItems({ source: snapshot.text, offset: 0 })
					: [],
				decorations: languageSnapshot.decorations || [],
				diagnostics: languageSnapshot.diagnostics || [],
			};
		}
		
		function showNormal() {
			if (disposed) return;
			mode = 'normal';
			let payload = normalPayload();
			adapter.setNormalModel(payload);
			if (adapter.setDiagnostics) {
				adapter.setDiagnostics(payload.diagnostics);
			}
		}
		
		let unsubscribe = adapter.onEvent((event) => {
			if (disposed || !event || !event.type) return;
			if (event.type === 'ready') {
				showNormal();
			}
			else if (event.type === 'change') {
				session.applyHumanEdit(String(event.text ?? ''));
				let snapshot = language(String(event.text ?? ''));
				if (adapter.setDiagnostics) {
					adapter.setDiagnostics(snapshot.diagnostics || []);
				}
			}
			else if (event.type === 'command') {
				onCommand(event.command, event);
			}
			else if (event.type === 'cursor') {
				onCursor(event);
			}
		});
		
		return {
			showNormal,
			showDiff({ original = '', proposed = '' } = {}) {
				if (disposed) return;
				mode = 'diff';
				let snapshot = session.snapshot();
				let baseURI = Zotero.QLab.qmdMonacoModelURI('', snapshot.path);
				adapter.setDiffModel({
					original: { uri: baseURI.replace(/\.qmd$/, '.original.qmd'), text: String(original) },
					modified: { uri: proposalURI(snapshot.path), text: String(proposed) },
					options: Zotero.QLab.qmdMonacoOptions(),
				});
			},
			setDiagnostics(diagnostics) {
				if (!disposed && adapter.setDiagnostics) {
					adapter.setDiagnostics(diagnostics || []);
				}
			},
			revealRange(range) {
				if (!disposed && adapter.revealRange) {
					adapter.revealRange(range);
				}
			},
			snapshot() {
				return { mode, disposed };
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				if (typeof unsubscribe === 'function') unsubscribe();
				if (adapter.dispose) adapter.dispose();
			},
		};
	};
	
	Zotero.QLab.createQmdMonacoFrameAdapter = function (frame) {
		let listeners = new Set();
		let queue = [];
		let bound = false;
		let unsubscribe = null;
		function windowAPI() {
			return frame && frame.contentWindow;
		}
		function call(name, payload) {
			let win = windowAPI();
			if (win && typeof win[name] === 'function') {
				return win[name](payload);
			}
			queue.push({ name, payload });
		}
		function bind() {
			if (bound) return;
			let win = windowAPI();
			if (!win || typeof win.subscribeQmdMonaco !== 'function') return;
			bound = true;
			unsubscribe = win.subscribeQmdMonaco(event => {
				for (let listener of listeners) listener(event);
			});
			if (typeof win.loadQmdMonaco === 'function') {
				void win.loadQmdMonaco().then(() => {
					let pending = queue.splice(0);
					for (let item of pending) call(item.name, item.payload);
				});
			}
		}
		if (frame && frame.addEventListener) {
			frame.addEventListener('load', bind, { once: true });
		}
		return {
			onEvent(listener) {
				listeners.add(listener);
				bind();
				return () => listeners.delete(listener);
			},
			setNormalModel: payload => call('setQmdModel', payload),
			setDiffModel: payload => call('setQmdDiff', payload),
			setDiagnostics: payload => call('setQmdDiagnostics', payload),
			revealRange: payload => call('revealQmdRange', payload),
			dispose() {
				if (unsubscribe) unsubscribe();
				listeners.clear();
				call('disposeQmdMonaco');
			},
		};
	};
})();
