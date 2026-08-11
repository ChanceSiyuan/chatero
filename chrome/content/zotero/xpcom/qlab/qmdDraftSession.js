/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Authoritative state for one open QMD Draft.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const DRAFT_CAPABILITIES = Object.freeze({
		read: true,
		reload: true,
		surfaceNavigation: true,
		websiteNavigation: true,
		selection: true,
		chatSelection: true,
		edit: true,
		save: true,
		autosave: true,
		proposal: true,
		keepReject: true,
		completeTodos: true,
		promote: true,
		insertFormalBlock: true,
		externalEditor: true,
		pdfQuote: true,
		pendingReview: true,
		aiWrite: true,
		sharedBufferWrite: true,
	});

	function readonlyError() {
		throw new Error('This workspace document is read-only');
	}

	function draftDescriptor(path) {
		let document = Zotero.QLab.classifyWorkspaceDocument
			? Zotero.QLab.classifyWorkspaceDocument(path)
			: null;
		if (!document || document.authority !== 'draft'
				|| document.kind !== 'qmd' || document.writable !== true) {
			throw new Error('QMD Draft session requires a safe QMD path under drafts/');
		}
		return Object.freeze({
			relativePath: document.path,
			authority: 'draft',
			kind: 'qmd',
			format: 'qmd',
			readOnly: false,
			writable: true,
			badge: 'Draft',
			tooltip: 'Drafts are editable and autosave in Chatero.',
			modelLanguage: 'markdown',
			surfaces: Object.freeze(['visual', 'website', 'source']),
			capabilities: DRAFT_CAPABILITIES,
		});
	}

	Zotero.QLab.createQmdDraftDocumentDescriptor = function (input = {}) {
		return draftDescriptor(input.relativePath || input.path);
	};

	function copyState(state) {
		return {
			path: state.path,
			document: state.document || null,
			capabilities: state.capabilities || null,
			text: state.text,
			savedText: state.savedText,
			revision: state.revision,
			dirty: state.dirty,
			saving: state.saving,
			saveError: state.saveError,
			proposal: state.proposal ? { ...state.proposal } : null,
			disposed: state.disposed,
		};
	}
	
	Zotero.QLab.createQmdDraftSession = function ({
		path,
		text,
		revision,
		autoSaveDelay = 800,
		schedule = setTimeout,
		cancel = clearTimeout,
		onSave,
		onState = () => {},
		onSaved = () => {},
		onConflict = () => {},
	} = {}) {
		if (!path || typeof onSave !== 'function') {
			throw new Error('QMD Draft session requires a path and onSave callback');
		}
		let document = draftDescriptor(path);
		let state = {
			path: document.relativePath,
			document,
			capabilities: document.capabilities,
			text: String(text ?? ''),
			savedText: String(text ?? ''),
			revision: String(revision ?? ''),
			dirty: false,
			saving: false,
			saveError: '',
			proposal: null,
			disposed: false,
		};
		let timer = null;
		let generation = 0;
		let activeSave = null;
		let saveQueued = false;
		
		function emit() {
			onState(copyState(state));
		}
		
		async function save() {
			if (state.disposed || !state.dirty) {
				return copyState(state);
			}
			if (activeSave) {
				saveQueued = true;
				return activeSave;
			}
			if (timer !== null) {
				cancel(timer);
				timer = null;
			}
			let savingGeneration = generation;
			let request = {
				path: state.path,
				text: state.text,
				expectedRevision: state.revision,
			};
			state.saving = true;
			state.saveError = '';
			emit();
			activeSave = (async () => {
				let result = await onSave(request);
				state.revision = String(result && result.revision || state.revision);
				state.savedText = request.text;
				if (savingGeneration === generation) {
					state.dirty = false;
				}
				state.saving = false;
				onSaved(copyState(state));
				emit();
				return copyState(state);
			})();
			let result;
			try {
				result = await activeSave;
			}
			catch (e) {
				state.saving = false;
				state.dirty = true;
				state.saveError = e && e.message ? e.message : String(e);
				saveQueued = false;
				emit();
				throw e;
			}
			finally {
				activeSave = null;
			}
			if (saveQueued && state.dirty && !state.disposed) {
				saveQueued = false;
				return save();
			}
			saveQueued = false;
			return result;
		}
		
		return {
			document,
			capabilities: document.capabilities,
			applyHumanEdit(nextText) {
				if (state.disposed) {
					return;
				}
				let next = String(nextText ?? '');
				if (next === state.text) {
					return;
				}
				state.text = next;
				state.dirty = next !== state.savedText;
				state.saveError = '';
				generation += 1;
				if (timer !== null) {
					cancel(timer);
				}
				timer = state.dirty ? schedule(save, autoSaveDelay) : null;
				emit();
			},
			saveNow: save,
			observeDisk(file) {
				if (!file || state.disposed) {
					return;
				}
				let diskRevision = String(file.revision ?? '');
				if (diskRevision === state.revision) {
					return;
				}
				if (state.dirty) {
					onConflict({ disk: { ...file }, buffer: copyState(state) });
					return;
				}
				state.text = String(file.text ?? '');
				state.savedText = state.text;
				state.revision = diskRevision;
				emit();
			},
			attachProposal(proposal) {
				state.proposal = proposal ? { ...proposal } : null;
				emit();
			},
			clearProposal() {
				state.proposal = null;
				emit();
			},
			snapshot() {
				return copyState(state);
			},
			dispose() {
				if (state.disposed) return;
				if (timer !== null) {
					cancel(timer);
					timer = null;
				}
				state.disposed = true;
				emit();
			},
		};
	};

	Zotero.QLab.createQmdDocumentSession = function ({
		verifiedRead,
		onState = () => {},
	} = {}) {
		if (!verifiedRead || typeof verifiedRead !== 'object'
				|| !verifiedRead.document
				|| typeof Zotero.QLab.createWorkspaceDocumentDescriptor !== 'function'
				|| typeof Zotero.QLab.consumeVerifiedReadonlyDocumentRead !== 'function') {
			throw new Error('QMD read-only session requires freshly verified document bytes');
		}
		let normalized = Zotero.QLab.createWorkspaceDocumentDescriptor({
			relativePath: verifiedRead.document.relativePath,
		});
		let state = {
			path: normalized.relativePath,
			document: normalized,
			capabilities: normalized.capabilities,
			text: String(verifiedRead.text ?? ''),
			savedText: String(verifiedRead.text ?? ''),
			revision: String(verifiedRead.revision ?? ''),
			dirty: false,
			saving: false,
			saveError: '',
			proposal: null,
			disposed: false,
		};
		let session = {
			document: normalized,
			capabilities: normalized.capabilities,
			applyHumanEdit: readonlyError,
			saveNow: readonlyError,
			attachProposal: readonlyError,
			clearProposal: readonlyError,
			applyAIEdit: readonlyError,
			completeTodos: readonlyError,
			promoteToKnowledge: readonlyError,
			insertFormalBlock: readonlyError,
			openExternalEditor: readonlyError,
			insertPDFQuote: readonlyError,
			addPendingInsert: readonlyError,
			acceptPendingInsert: readonlyError,
			rejectPendingInsert: readonlyError,
			observeDisk(file) {
				if (state.disposed) return false;
				if (!Zotero.QLab.consumeVerifiedReadonlyDocumentRead
						|| !Zotero.QLab.consumeVerifiedReadonlyDocumentRead(file, normalized, session)) {
					throw new Error('Read-only reload requires freshly verified document bytes');
				}
				let diskRevision = String(file.revision || '');
				if (diskRevision === state.revision) return false;
				state.text = String(file.text ?? '');
				state.savedText = state.text;
				state.revision = diskRevision;
				onState(copyState(state));
				return true;
			},
			snapshot() {
				return copyState(state);
			},
			dispose() {
				if (state.disposed) return;
				state.disposed = true;
				onState(copyState(state));
			},
		};
		if (!Zotero.QLab.consumeVerifiedReadonlyDocumentRead(verifiedRead, normalized, session)) {
			throw new Error('QMD read-only session requires freshly verified document bytes');
		}
		return Object.freeze(session);
	};
})();
