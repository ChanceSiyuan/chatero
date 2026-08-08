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
	function copyState(state) {
		return {
			path: state.path,
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
		let state = {
			path: String(path),
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
				if (timer !== null) {
					cancel(timer);
					timer = null;
				}
				state.disposed = true;
				emit();
			},
		};
	};
})();
