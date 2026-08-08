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
	const PREF_MODEL = 'qlab.agentModel';
	const PREF_CHAT_MODE = 'qlab.chatMode';
	const PREF_CHAT_FOCUS = 'qlab.chatFocusOnPin';
	const PREF_TRANSCRIPT_CHARS = 'qlab.chatTranscriptMaxChars';
	
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
		
		getAgentModel() {
			try {
				if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
					return String(Zotero.Prefs.get(PREF_MODEL) || '');
				}
			}
			catch (e) {}
			return '';
		},
		
		setAgentModel(model) {
			if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
				Zotero.Prefs.set(PREF_MODEL, String(model || ''));
			}
		},
		
		getChatMode() {
			try {
				if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
					let mode = String(Zotero.Prefs.get(PREF_CHAT_MODE) || 'ask');
					return mode === 'agent' ? 'agent' : 'ask';
				}
			}
			catch (e) {}
			return 'ask';
		},
		
		setChatMode(mode) {
			if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
				Zotero.Prefs.set(PREF_CHAT_MODE, mode === 'agent' ? 'agent' : 'ask');
			}
		},

		getChatFocusOnPin() {
			try {
				if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
					let v = String(Zotero.Prefs.get(PREF_CHAT_FOCUS) || 'whenChatVisible');
					if (v === 'always' || v === 'never') {
						return v;
					}
				}
			}
			catch (e) {}
			return 'whenChatVisible';
		},

		setChatFocusOnPin(mode) {
			let v = mode === 'always' || mode === 'never' ? mode : 'whenChatVisible';
			if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
				Zotero.Prefs.set(PREF_CHAT_FOCUS, v);
			}
		},

		getChatTranscriptMaxChars() {
			try {
				if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
					let n = Number(Zotero.Prefs.get(PREF_TRANSCRIPT_CHARS));
					if (Number.isFinite(n) && n >= 4000) {
						return Math.min(n, 120_000);
					}
				}
			}
			catch (e) {}
			return 24_000;
		},

		setChatTranscriptMaxChars(chars) {
			let n = Number(chars);
			if (!Number.isFinite(n)) {
				return;
			}
			n = Math.max(4000, Math.min(120_000, Math.round(n)));
			if (typeof Zotero !== 'undefined' && Zotero.Prefs) {
				Zotero.Prefs.set(PREF_TRANSCRIPT_CHARS, n);
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
