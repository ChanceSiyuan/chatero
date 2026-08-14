/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Keyword workspace search for @ picker (Cursor @codebase parity, local-first).
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const PREFIXES = ['drafts/', 'literature/', 'knowledge/'];

	/**
	 * @param {string} lower Haystack, already lowercased by the caller.
	 * @param {string} q Needle, already lowercased and trimmed by the caller.
	 * @param {string[]} qParts `q` split on whitespace, precomputed by the caller.
	 */
	function scoreMatch(lower, q, qParts) {
		if (!q) {
			return 0;
		}
		if (lower.includes(q)) {
			return q.length + (lower.startsWith(q) ? 10 : 0);
		}
		let hits = qParts.filter(p => lower.includes(p)).length;
		return hits * 3;
	}

	Zotero.QLab.searchWorkspaceForComposer = async function (workspaceRoot, query, {
		maxResults = 8,
		host,
	} = {}) {
		if (!workspaceRoot || !query || !String(query).trim()) {
			return [];
		}
		let io = host || (Zotero.QLab.QmdDraftIO
			&& Zotero.QLab.QmdDraftIO.createGeckoHost
			? Zotero.QLab.QmdDraftIO.createGeckoHost()
			: null);
		if (!io) {
			return [];
		}
		// Normalize the needle once instead of per candidate and per haystack.
		let q = String(query).toLowerCase().trim();
		if (!q) {
			return [];
		}
		let qParts = q.split(/\s+/).filter(Boolean);
		let results = [];
		for (let prefix of PREFIXES) {
			let files = [];
			try {
				files = await Zotero.QLab.walkWorkspaceRelPaths(workspaceRoot, prefix, io, {
					extensions: ['.qmd', '.md', '.txt'],
					maxDepth: 6,
				});
			}
			catch (e) {}
			for (let rel of files) {
				if (prefix === 'knowledge/' && !rel.endsWith('.md')) {
					continue;
				}
				try {
					let text = await Zotero.QLab.readWorkspaceRel(workspaceRoot, rel, io, {
						maxChars: 256_000,
					});
					// One lowercase pass over the body, shared by scoring and the
					// snippet lookup below.
					let lowerText = text.toLowerCase();
					let score = scoreMatch(rel.toLowerCase(), q, qParts)
						+ scoreMatch(lowerText, q, qParts);
					if (score <= 0) {
						continue;
					}
					let idx = lowerText.indexOf(q);
					let snippet = idx >= 0
						? text.slice(Math.max(0, idx - 40), idx + 120).replace(/\s+/g, ' ').trim()
						: rel;
					results.push({
						id: `workspace:${rel}`,
						kind: 'workspace-file',
						label: `@${rel.replace(/^(drafts|literature|knowledge)\//, '')}`,
						relativePath: rel,
						snippet,
						score,
					});
				}
				catch (e) {}
			}
		}
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, maxResults);
	};
})();
