/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Monaco-neutral QMD language data. The iframe translates these plain objects
 * into Monaco completion, decoration, and marker types.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const BLOCK_SNIPPETS = [
		{
			label: 'Theorem block',
			insertText: ':::{#thm-${1:id}}\n${2:Statement.}\n:::',
			detail: 'Quarto theorem block',
		},
		{
			label: 'Lemma block',
			insertText: ':::{#lem-${1:id}}\n${2:Statement.}\n:::',
			detail: 'Quarto lemma block',
		},
		{
			label: 'Definition block',
			insertText: ':::{#def-${1:id}}\n${2:Definition.}\n:::',
			detail: 'Quarto definition block',
		},
		{
			label: 'Proof block',
			insertText: ':::{#prf-${1:id}}\n${2:Proof.}\n:::',
			detail: 'Quarto proof block',
		},
	];
	
	function bibliographyKeys(text) {
		let keys = [];
		let seen = new Set();
		let re = /@[A-Za-z]+\s*\{\s*([^,\s}]+)/g;
		let match;
		while ((match = re.exec(String(text || '')))) {
			let key = match[1];
			if (!seen.has(key)) {
				seen.add(key);
				keys.push(key);
			}
		}
		return keys.sort();
	}
	
	function headingSlug(source) {
		return String(source || '')
			.replace(/^#{1,6}\s+/, '')
			.replace(/\s+\{[^}]*\}\s*$/, '')
			.trim()
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, '-')
			.replace(/^-+|-+$/g, '');
	}
	
	function blockKey(block, counters) {
		let explicit = /^\s*:{3,}\s*\{[^}]*#([A-Za-z][\w:.-]*)/m.exec(block.source || '');
		if (explicit) {
			return `div:${explicit[1]}`;
		}
		if (block.kind === 'heading') {
			let slug = headingSlug(block.source);
			return `heading:${slug || ++counters.heading}`;
		}
		let kind = block.semantic || block.kind || 'block';
		counters[kind] = (counters[kind] || 0) + 1;
		return `${kind}:${counters[kind]}`;
	}
	
	function divDiagnostics(source) {
		let diagnostics = [];
		let stack = [];
		let text = String(source || '');
		let offset = 0;
		for (let line of text.split('\n')) {
			let opening = /^\s*(:{3,})\s*\{[^}]*\}\s*$/.exec(line);
			let closing = /^\s*(:{3,})\s*$/.exec(line);
			if (opening) {
				stack.push({ start: offset, end: offset + line.length });
			}
			else if (closing && stack.length) {
				stack.pop();
			}
			offset += line.length + 1;
		}
		for (let open of stack) {
			diagnostics.push({
				code: 'qmd-unclosed-div',
				severity: 'error',
				message: 'This Quarto fenced Div is not closed.',
				start: open.start,
				end: open.end,
			});
		}
		return diagnostics;
	}
	
	Zotero.QLab.qmdCompletionItems = function ({
		source = '',
		offset = 0,
		bibliographyText = '',
	} = {}) {
		let before = String(source).slice(0, Math.max(0, Number(offset) || 0));
		let cite = /@([A-Za-z0-9_:.+-]*)$/.exec(before);
		let prefix = cite ? cite[1].toLowerCase() : '';
		let citations = bibliographyKeys(bibliographyText)
			.filter(key => !cite || key.toLowerCase().startsWith(prefix))
			.map(key => ({
				label: `@${key}`,
				insertText: cite ? key : `@${key}`,
				kind: 'reference',
				detail: 'literature/ref.bib',
			}));
		return [
			...BLOCK_SNIPPETS.map(item => ({ ...item, kind: 'snippet' })),
			...citations,
		];
	};
	
	Zotero.QLab.qmdLanguageSnapshot = function (source, bibliographyText = '') {
		let text = String(source || '').replace(/\r\n?/g, '\n');
		let counters = { heading: 0 };
		let blocks = (Zotero.QLab.visualQmdBlocks
			? Zotero.QLab.visualQmdBlocks(text)
			: []).map(block => ({
				...block,
				key: blockKey(block, counters),
			}));
		let decorations = [];
		for (let block of blocks) {
			if (['frontmatter', 'code', 'display-math', 'theorem', 'callout'].includes(block.kind)) {
				decorations.push({
					kind: block.kind === 'display-math' ? 'math' : (block.semantic || block.kind),
					start: block.start,
					end: block.end,
				});
			}
		}
		let math = /\$(?!\$)([^$\n]+)\$/g;
		let match;
		while ((match = math.exec(text))) {
			decorations.push({ kind: 'math', start: match.index, end: match.index + match[0].length });
		}
		return {
			blocks,
			decorations,
			diagnostics: divDiagnostics(text),
			citations: bibliographyKeys(bibliographyText),
		};
	};
})();
