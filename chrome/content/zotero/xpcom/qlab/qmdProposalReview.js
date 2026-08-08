/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Three-way, line-oriented replay for private AI Draft proposals.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	function lines(text) {
		return String(text || '').match(/[^\n]*\n|[^\n]+$/g) || [];
	}

	function proposalHunks(baseText, proposedText) {
		let base = lines(baseText);
		let proposed = lines(proposedText);
		let rows = base.length + 1;
		let columns = proposed.length + 1;
		let lcs = Array.from({ length: rows }, () => new Uint32Array(columns));
		for (let i = base.length - 1; i >= 0; i--) {
			for (let j = proposed.length - 1; j >= 0; j--) {
				lcs[i][j] = base[i] === proposed[j]
					? lcs[i + 1][j + 1] + 1
					: Math.max(lcs[i + 1][j], lcs[i][j + 1]);
			}
		}
		let hunks = [];
		let active = null;
		let i = 0;
		let j = 0;
		function begin() {
			if (!active) active = { baseStart: i, baseEnd: i, replacement: [] };
		}
		function finish() {
			if (!active) return;
			active.baseEnd = i;
			active.baseText = base.slice(active.baseStart, active.baseEnd).join('');
			active.replacementText = active.replacement.join('');
			hunks.push(active);
			active = null;
		}
		while (i < base.length || j < proposed.length) {
			if (i < base.length && j < proposed.length && base[i] === proposed[j]) {
				finish();
				i++;
				j++;
			}
			else if (j < proposed.length
					&& (i === base.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
				begin();
				active.replacement.push(proposed[j++]);
			}
			else {
				begin();
				i++;
				active.baseEnd = i;
			}
		}
		finish();
		return { base, hunks };
	}

	function sameAt(haystack, needle, index) {
		if (index < 0 || index + needle.length > haystack.length) return false;
		for (let i = 0; i < needle.length; i++) {
			if (haystack[index + i] !== needle[i]) return false;
		}
		return true;
	}

	function locateHunk(base, current, hunk) {
		let needle = base.slice(hunk.baseStart, hunk.baseEnd);
		let candidates = [];
		if (needle.length) {
			for (let i = 0; i <= current.length - needle.length; i++) {
				if (sameAt(current, needle, i)) candidates.push(i);
			}
		}
		else {
			let left = hunk.baseStart > 0 ? base[hunk.baseStart - 1] : null;
			let right = hunk.baseStart < base.length ? base[hunk.baseStart] : null;
			for (let i = 0; i <= current.length; i++) {
				let leftMatches = left === null ? i === 0 : current[i - 1] === left;
				let rightMatches = right === null ? i === current.length : current[i] === right;
				if (leftMatches && rightMatches) candidates.push(i);
			}
		}
		return candidates.length === 1 ? candidates[0] : -1;
	}

	Zotero.QLab.reviewQmdProposal = function ({ base = '', current = '', proposed = '' } = {}) {
		let patch = proposalHunks(base, proposed);
		if (!patch.hunks.length) {
			return { status: 'clean', text: String(current || ''), hunks: [] };
		}
		let currentLines = lines(current);
		let located = patch.hunks.map(hunk => ({
			...hunk,
			currentStart: locateHunk(patch.base, currentLines, hunk),
		}));
		let conflicts = located.filter(hunk => hunk.currentStart < 0);
		let destinations = located.filter(hunk => hunk.currentStart >= 0)
			.map(hunk => `${hunk.currentStart}:${hunk.baseEnd - hunk.baseStart}`);
		if (new Set(destinations).size !== destinations.length) {
			conflicts = located;
		}
		if (conflicts.length) {
			return {
				status: 'conflict',
				base: String(base || ''),
				current: String(current || ''),
				proposed: String(proposed || ''),
				conflicts,
				hunks: located,
			};
		}
		for (let hunk of located.sort((a, b) => b.currentStart - a.currentStart)) {
			currentLines.splice(
				hunk.currentStart,
				hunk.baseEnd - hunk.baseStart,
				...hunk.replacement
			);
		}
		return { status: 'clean', text: currentLines.join(''), hunks: located };
	};
})();
