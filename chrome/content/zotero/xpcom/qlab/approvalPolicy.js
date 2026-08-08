/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Workspace approval policy (Cursor-style autonomy slider).
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const DEFAULT_POLICY = {
		defaultAction: 'ask',
		allow: [
			'workspace_read',
			'zotero_get_reader_context',
		],
		deny: [
			'rm -rf',
			'sudo ',
			'.env',
		],
	};

	function normalizeList(list) {
		return Array.isArray(list) ? list.map(String) : [];
	}

	Zotero.QLab.loadApprovalPolicy = async function (workspaceRoot, host) {
		if (!workspaceRoot) {
			return { ...DEFAULT_POLICY };
		}
		let io = host || (Zotero.QLab.QmdDraftIO
			&& Zotero.QLab.QmdDraftIO.createGeckoHost
			? Zotero.QLab.QmdDraftIO.createGeckoHost()
			: null);
		if (!io) {
			return { ...DEFAULT_POLICY };
		}
		try {
			let text = await Zotero.QLab.readWorkspaceRel(
				workspaceRoot,
				'qlab/approval-policy.json',
				io
			);
			let parsed = JSON.parse(text);
			return {
				defaultAction: parsed.defaultAction === 'allow'
					|| parsed.defaultAction === 'deny'
					? parsed.defaultAction
					: DEFAULT_POLICY.defaultAction,
				allow: normalizeList(parsed.allow),
				deny: normalizeList(parsed.deny),
			};
		}
		catch (e) {
			return { ...DEFAULT_POLICY };
		}
	};

	Zotero.QLab.evaluateApproval = function (policy, { tool, reason, cwd } = {}) {
		let pol = policy || DEFAULT_POLICY;
		let haystack = [
			tool || '',
			reason || '',
			cwd || '',
		].join(' ').toLowerCase();
		for (let needle of pol.deny) {
			if (needle && haystack.includes(String(needle).toLowerCase())) {
				return 'deny';
			}
		}
		if (tool && pol.allow.some(entry => haystack.includes(String(entry).toLowerCase())
				|| String(entry).toLowerCase() === String(tool).toLowerCase())) {
			return 'allow';
		}
		return pol.defaultAction === 'allow' ? 'allow' : 'ask';
	};
})();
