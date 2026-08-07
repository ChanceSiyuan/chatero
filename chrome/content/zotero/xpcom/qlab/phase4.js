/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Phase 4 surfaces. Remote execution (SSH) is optional and deferred -- not a
 * daily-path dependency. Prefer local providers + optional prove-harness.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	function notReady(feature, message) {
		return {
			ok: false,
			feature,
			status: 'not-ready',
			message: message
				|| `${feature} lands after A–D daily-path parity.`,
		};
	}
	
	Zotero.QLab.Phase4 = {
		proposeKnowledgePromotion() {
			return notReady('knowledge-promotion');
		},
		importLiterature() {
			return notReady('literature-import');
		},
		openMainSite() {
			return notReady('main-site');
		},
		openTerminal() {
			return notReady('terminal');
		},
		/**
		 * @deprecated Use AgentProviderRegistry provider id `remote-execution`.
		 * SSH is one possible backend for that optional slot.
		 */
		connectSSH() {
			return {
				ok: false,
				feature: 'remote-execution',
				status: 'deferred-optional',
				message: 'SSH/remote Codex is optional. Use local providers '
					+ '(codex-cli, openai-compat, prove-harness) for the daily path. '
					+ 'Remote execution remains a provider slot, not a core requirement.',
				providerId: 'remote-execution',
			};
		},
	};
})();
