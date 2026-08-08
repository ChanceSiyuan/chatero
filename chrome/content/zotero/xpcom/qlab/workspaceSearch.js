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

	function scoreMatch(text, query) {
		let lower = String(text || '').toLowerCase();
		let q = String(query || '').toLowerCase().trim();
		if (!q) {
			return 0;
		}
		if (lower.includes(q)) {
			return q.length + (lower.startsWith(q) ? 10 : 0);
		}
		let parts = q.split(/\s+/).filter(Boolean);
		let hits = parts.filter(p => lower.includes(p)).length;
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
					let score = scoreMatch(rel, query) + scoreMatch(text, query);
					if (score <= 0) {
						continue;
					}
					let q = String(query).toLowerCase().trim();
					let idx = text.toLowerCase().indexOf(q);
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
