/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Lightweight QMD source completions (Cursor Tab parity, local heuristics).
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const SNIPPETS = [
		'::: {.callout-note}\n\n:::\n',
		'$$\n\n$$',
		'[@',
		'[^',
		'<!-- ',
		'## ',
		'### ',
	];

	Zotero.QLab.suggestQmdCompletion = function (source, offset, { citeKeys = [] } = {}) {
		let text = String(source || '');
		let pos = Number.isFinite(offset) ? offset : text.length;
		let before = text.slice(0, pos);
		let lineStart = before.lastIndexOf('\n') + 1;
		let line = before.slice(lineStart);

		if (/@\w*$/.test(line)) {
			let prefix = line.match(/@(\w*)$/)[1].toLowerCase();
			let keys = (citeKeys || []).filter(k => k.toLowerCase().startsWith(prefix));
			if (keys.length) {
				return `@${keys[0]}`;
			}
		}

		if (line.trim() === '') {
			for (let snippet of SNIPPETS) {
				return snippet;
			}
		}

		if (line.endsWith('$$') && !line.endsWith('$$$')) {
			return '\n\n';
		}

		return '';
	};
})();
