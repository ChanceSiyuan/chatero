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
	let mainSiteControllers = [];

	function notReady(feature, message) {
		return {
			ok: false,
			feature,
			status: 'not-ready',
			message: message
				|| `${feature} lands after A–D daily-path parity.`,
		};
	}

	Zotero.QLab.registerMainSiteController = function (controller, options = {}) {
		if (!controller || typeof controller.openMainSite !== 'function') return () => {};
		let entry = {
			controller,
			isActive: typeof options.isActive === 'function' ? options.isActive : () => false,
		};
		mainSiteControllers.push(entry);
		return () => {
			mainSiteControllers = mainSiteControllers.filter(value => value !== entry);
		};
	};

	function mainSiteControllerFor(options) {
		let explicit = options && options.windowController;
		if (explicit && typeof explicit.openMainSite === 'function') return explicit;
		for (let index = mainSiteControllers.length - 1; index >= 0; index--) {
			let entry = mainSiteControllers[index];
			try {
				if (entry.isActive()) return entry.controller;
			}
			catch (error) {
				Zotero.logError && Zotero.logError(error);
			}
		}
		return mainSiteControllers.length
			? mainSiteControllers[mainSiteControllers.length - 1].controller
			: null;
	}
	
	Zotero.QLab.Phase4 = {
		proposeKnowledgePromotion() {
			return notReady('knowledge-promotion');
		},
		importLiterature() {
			return notReady('literature-import');
		},
		openMainSite(options = {}) {
			let controller = mainSiteControllerFor(options);
			if (!controller) return notReady('main-site', 'Open a Chatero library window first.');
			try {
				let tabID = controller.openMainSite(options);
				if (!tabID) return notReady('main-site', 'Choose a Research Loop repository first.');
				return { ok: true, feature: 'main-site', status: 'opened', tabID };
			}
			catch (error) {
				return {
					ok: false, feature: 'main-site', status: 'error',
					message: error && error.message || String(error),
				};
			}
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
