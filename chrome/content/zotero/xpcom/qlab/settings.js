/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

Zotero.QLab = Zotero.QLab || {};

(function () {
	const PREF_ROOT = 'qlab.root';
	const PREF_ENABLED = 'qlab.enabled';
	const PREF_PROVIDER = 'qlab.agentProvider';
	
	Zotero.QLab.Settings = {
		isEnabled() {
			try {
				if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
					let value = Zotero.Prefs.get(PREF_ENABLED);
					return value !== false;
				}
			}
			catch (e) {
				// Prefs unavailable during early/unit load -- default enabled.
			}
			return true;
		},
		
		setEnabled(enabled) {
			if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
				Zotero.Prefs.set(PREF_ENABLED, !!enabled);
			}
		},
		
		getRoot() {
			try {
				if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
					return String(Zotero.Prefs.get(PREF_ROOT) || '');
				}
			}
			catch (e) {}
			return '';
		},
		
		getAgentProviderId() {
			try {
				if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
					return String(Zotero.Prefs.get(PREF_PROVIDER) || 'codex-cli');
				}
			}
			catch (e) {}
			return 'codex-cli';
		},
		
		setAgentProviderId(id) {
			if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
				Zotero.Prefs.set(PREF_PROVIDER, String(id || 'codex-cli'));
			}
		},
		
		async setRoot(root, host) {
			let normalized = '';
			if (root && String(root).trim()) {
				normalized = await Zotero.QLab.normalizeQLabRoot(root, host);
				let state = await Zotero.QLab.qlabRepositoryState(normalized, host);
				if (state === 'incompatible') {
					throw new Error(
						'Selected directory is not an empty, partial, or ready QLab workspace'
					);
				}
			}
			if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
				Zotero.Prefs.set(PREF_ROOT, normalized);
			}
			return normalized;
		},
	};
})();
