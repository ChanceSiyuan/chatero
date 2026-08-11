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
	const DRAFT_MONACO_CAPABILITIES = Object.freeze({
		selection: true,
		chatSelection: true,
		edit: true,
		save: true,
		aiWrite: true,
		proposal: true,
		keepReject: true,
	});

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

	function documentView(snapshot) {
		let relativePath = String(snapshot && snapshot.path || '');
		let document = Zotero.QLab.classifyWorkspaceDocument
			? Zotero.QLab.classifyWorkspaceDocument(relativePath)
			: null;
		if (!document) {
			throw new Error('Unsupported or unsafe Monaco workspace document');
		}
		if (document.authority === 'draft' && document.kind === 'qmd' && document.writable) {
			let descriptor = Zotero.QLab.createQmdDraftDocumentDescriptor({
				relativePath: document.path,
			});
			return Object.freeze({
				relativePath: descriptor.relativePath,
				authority: descriptor.authority,
				format: descriptor.format,
				modelLanguage: descriptor.modelLanguage,
				readOnly: descriptor.readOnly,
				capabilities: descriptor.capabilities || DRAFT_MONACO_CAPABILITIES,
			});
		}
		let descriptor = Zotero.QLab.createWorkspaceDocumentDescriptor({
			relativePath: document.path,
		});
		return Object.freeze({
			relativePath: descriptor.relativePath,
			authority: descriptor.authority,
			format: descriptor.format,
			modelLanguage: descriptor.modelLanguage,
			readOnly: true,
			capabilities: descriptor.capabilities,
		});
	}
	
	Zotero.QLab.qmdMonacoModelURI = function (_root, relativePath) {
		return `inmemory://qlab/${encodeURI(draftPath(relativePath))}`;
	};

	Zotero.QLab.qmdDocumentModelURI = function (_root, relativePath) {
		let document = Zotero.QLab.classifyWorkspaceDocument
			? Zotero.QLab.classifyWorkspaceDocument(relativePath)
			: null;
		if (!document || !['qmd', 'markdown', 'bib'].includes(document.kind)) {
			throw new Error('Unsupported or unsafe Monaco workspace document');
		}
		return `inmemory://qlab/${encodeURI(document.path)}`;
	};
	
	Zotero.QLab.qmdMonacoOptions = function ({
		theme = 'light',
		wordWrap = 'on',
		readOnly = false,
		language = 'markdown',
		ariaLabel = 'QMD source editor',
	} = {}) {
		return {
			theme: theme === 'light' ? 'vs' : 'vs-dark',
			language,
			readOnly: readOnly === true,
			domReadOnly: readOnly === true,
			wordWrap,
			minimap: { enabled: false },
			tabSize: 2,
			insertSpaces: true,
			detectIndentation: true,
			automaticLayout: true,
			scrollBeyondLastLine: false,
			renderWhitespace: 'selection',
			links: true,
			accessibilitySupport: 'auto',
			ariaLabel,
			padding: { top: 12, bottom: 28 },
		};
	};
	
	Zotero.QLab.createQmdMonacoBridge = function ({
		adapter,
		session,
		language = text => Zotero.QLab.qmdLanguageSnapshot(text, ''),
		bibliographyText = '',
		onCommand = () => {},
		onCursor = () => {},
	} = {}) {
		if (!adapter || !session || typeof adapter.onEvent !== 'function') {
			throw new Error('QMD Monaco bridge requires adapter and Draft session');
		}
		let disposed = false;
		let mode = 'normal';
		let lastURI = '';
		let modelGeneration = 0;
		
		function normalPayload(generation) {
			let snapshot = session.snapshot();
			let document = documentView(snapshot);
			let isBibTeX = document.format === 'bibtex';
			let languageSnapshot = isBibTeX
				? { decorations: [], diagnostics: [] }
				: language(snapshot.text);
			return {
				uri: Zotero.QLab.qmdDocumentModelURI('', document.relativePath),
				generation,
				text: snapshot.text,
				language: document.modelLanguage,
				options: Zotero.QLab.qmdMonacoOptions({
					readOnly: document.readOnly,
					language: document.modelLanguage,
					ariaLabel: isBibTeX
						? 'BibTeX source viewer'
						: `QMD source ${document.readOnly ? 'viewer' : 'editor'}`,
				}),
				completions: !document.readOnly && !isBibTeX && Zotero.QLab.qmdCompletionItems
					? Zotero.QLab.qmdCompletionItems({
						source: snapshot.text,
						offset: 0,
						bibliographyText,
					})
					: [],
				decorations: languageSnapshot.decorations || [],
				diagnostics: languageSnapshot.diagnostics || [],
			};
		}
		
		function showNormal() {
			if (disposed) return false;
			mode = 'normal';
			let payload = normalPayload(++modelGeneration);
			adapter.setNormalModel(payload);
			if (lastURI && lastURI !== payload.uri && adapter.clearSelection) {
				adapter.clearSelection();
			}
			lastURI = payload.uri;
			if (adapter.setDiagnostics) {
				adapter.setDiagnostics(payload.diagnostics);
			}
			return true;
		}

		function activeDocument() {
			return documentView(session.snapshot());
		}

		function activeEventContext(event) {
			if (mode !== 'normal') return null;
			let snapshot = session.snapshot();
			let document = documentView(snapshot);
			let uri = Zotero.QLab.qmdDocumentModelURI('', document.relativePath);
			if (String(event.modelURI || '') !== uri
					|| Number(event.modelGeneration) !== modelGeneration
					|| lastURI !== uri) return null;
			return { snapshot, document, uri };
		}

		let unsubscribe = adapter.onEvent((event) => {
			if (disposed || !event || !event.type) return;
			if (event.type === 'ready') {
				showNormal();
			}
			else if (event.type === 'change') {
				let context = activeEventContext(event);
				if (!context) return;
				let document = context.document;
				if (!document.capabilities.edit) return;
				session.applyHumanEdit(String(event.text ?? ''));
				let snapshot = language(String(event.text ?? ''));
				if (adapter.setDiagnostics) {
					adapter.setDiagnostics(snapshot.diagnostics || []);
				}
			}
			else if (event.type === 'command') {
				let context = activeEventContext(event);
				if (!context) return;
				let capabilities = context.document.capabilities;
				if (event.command === 'save' && capabilities.save) {
					onCommand(event.command, event);
				}
				else if (event.command === 'ai' && capabilities.aiWrite) {
					onCommand(event.command, event);
				}
				else if (event.command === 'chat-selection'
						&& capabilities.chatSelection
						&& String(event.selection || '').length
						&& Number.isInteger(event.start) && Number.isInteger(event.end)
						&& event.start >= 0 && event.end > event.start
						&& event.end <= String(context.snapshot.text || '').length
						&& String(context.snapshot.text || '').slice(event.start, event.end)
							=== String(event.selection)) {
					onCommand(event.command, event);
				}
			}
			else if (event.type === 'cursor') {
				let context = activeEventContext(event);
				let offset = Number(event.offset);
				if (context && context.document.capabilities.selection
						&& Number.isInteger(offset) && offset >= 0
						&& offset <= String(context.snapshot.text || '').length) {
					onCursor(event);
				}
			}
		});
		
		return {
			showNormal,
			clear() {
				if (disposed) return false;
				mode = 'empty';
				let payload = {
					uri: 'inmemory://qlab/no-document',
					generation: ++modelGeneration,
					text: '',
					language: 'markdown',
					options: Zotero.QLab.qmdMonacoOptions({
						readOnly: true,
						language: 'markdown',
						ariaLabel: 'No workspace document',
					}),
					completions: [],
					decorations: [],
					diagnostics: [],
				};
				adapter.setNormalModel(payload);
				lastURI = payload.uri;
				if (adapter.setDiagnostics) adapter.setDiagnostics([]);
				if (adapter.clearSelection) adapter.clearSelection();
				return true;
			},
			showDiff({ original = '', proposed = '' } = {}) {
				if (disposed || !activeDocument().capabilities.proposal) return false;
				mode = 'diff';
				let snapshot = session.snapshot();
				let baseURI = Zotero.QLab.qmdMonacoModelURI('', snapshot.path);
				adapter.setDiffModel({
					original: { uri: baseURI.replace(/\.qmd$/, '.original.qmd'), text: String(original) },
					modified: { uri: proposalURI(snapshot.path), text: String(proposed) },
					options: Zotero.QLab.qmdMonacoOptions({ readOnly: true }),
				});
				return true;
			},
			showSearch() {
				if (disposed || activeDocument().format !== 'bibtex' || !adapter.showSearch) {
					return false;
				}
				adapter.showSearch();
				return true;
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
			clearSelection: () => call('clearQmdSelection'),
			showSearch: () => call('showQmdSearch'),
			dispose() {
				if (unsubscribe) unsubscribe();
				listeners.clear();
				call('disposeQmdMonaco');
			},
		};
	};
})();
