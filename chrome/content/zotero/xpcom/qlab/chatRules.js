/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Inject qlab/rules/*.md into Chat prompts (Cursor .cursor/rules parity).
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const RULES_DIR = 'qlab/rules';
	const MAX_RULE_CHARS = 12_000;

	Zotero.QLab.loadChatRulesPreamble = async function (workspaceRoot, host) {
		if (!workspaceRoot) {
			return '';
		}
		let io = host || (Zotero.QLab.QmdDraftIO
			&& Zotero.QLab.QmdDraftIO.createGeckoHost
			? Zotero.QLab.QmdDraftIO.createGeckoHost()
			: null);
		if (!io) {
			return '';
		}
		let files = [];
		try {
			files = await Zotero.QLab.walkWorkspaceRelPaths(workspaceRoot, RULES_DIR, io, {
				extensions: ['.md'],
				maxDepth: 2,
			});
		}
		catch (e) {
			return '';
		}
		let parts = [];
		let total = 0;
		for (let rel of files.sort()) {
			try {
				let text = await Zotero.QLab.readWorkspaceRel(workspaceRoot, rel, io, {
					maxChars: 8000,
				});
				let chunk = String(text || '').trim();
				if (!chunk) {
					continue;
				}
				if (total + chunk.length > MAX_RULE_CHARS) {
					break;
				}
				parts.push(`<!-- ${rel} -->\n${chunk}`);
				total += chunk.length;
			}
			catch (e) {}
		}
		if (!parts.length) {
			return '';
		}
		return `<workspace_rules>\n${parts.join('\n\n')}\n</workspace_rules>`;
	};
})();
