/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Lossless QMD visual regions (ported from XPI qmd-source-model, trimmed).
 * Unknown syntax stays as raw blocks so edits never invent structure.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	function sourceLines(source) {
		let lines = [];
		let start = 0;
		let text = String(source ?? '');
		while (start < text.length) {
			let newline = text.indexOf('\n', start);
			let end = newline < 0 ? text.length : newline;
			lines.push({
				text: text.slice(start, end).replace(/\r$/, ''),
				start,
				end: newline < 0 ? text.length : newline + 1,
			});
			if (newline < 0) {
				break;
			}
			start = newline + 1;
		}
		return lines;
	}
	
	function blockId(kind, source, start, end) {
		let h = 2166136261;
		let value = `${kind}\0${source}`;
		for (let i = 0; i < value.length; i++) {
			h ^= value.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return `${(h >>> 0).toString(16)}-${start}-${end}`;
	}
	
	function visualBlock(kind, source, start, end, extra = {}) {
		return {
			id: blockId(kind, source, start, end),
			kind,
			source,
			start,
			end,
			...extra,
		};
	}
	
	function visualFenceEnd(lines, openingIndex) {
		let open = /^\s*(:{3,})/.exec(lines[openingIndex].text);
		if (!open) {
			return -1;
		}
		let fence = open[1];
		for (let i = openingIndex + 1; i < lines.length; i++) {
			if (new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[i].text)) {
				return i;
			}
		}
		return -1;
	}
	
	function semanticFence(attributes) {
		let attrs = String(attributes || '');
		let idKind = /#(thm|lem|def|prf|proof)-[\w:.-]+/.exec(attrs);
		if (idKind) {
			return {
				thm: 'theorem',
				lem: 'lemma',
				def: 'definition',
				prf: 'proof',
				proof: 'proof',
			}[idKind[1]];
		}
		if (/\btheorem\b/.test(attrs)) {
			return 'theorem';
		}
		if (/\blemma\b/.test(attrs)) {
			return 'lemma';
		}
		if (/\bdefinition\b/.test(attrs)) {
			return 'definition';
		}
		if (/\bcorollary\b/.test(attrs)) {
			return 'corollary';
		}
		if (/\bproof\b/.test(attrs)) {
			return 'proof';
		}
		return '';
	}
	
	function fenceTitle(source) {
		let body = String(source).split(/\r?\n/).slice(1, -1);
		for (let line of body) {
			let heading = /^#{1,6}\s+(.+?)(?:\s+\{[^}]*\})?\s*$/.exec(line.trim());
			if (heading && heading[1]) {
				return heading[1].trim();
			}
			if (line.trim()) {
				break;
			}
		}
		return undefined;
	}
	
	/**
	 * Split QMD into non-overlapping visual regions.
	 */
	Zotero.QLab.visualQmdBlocks = function (source) {
		let text = String(source ?? '');
		let lines = sourceLines(text);
		let result = [];
		let index = 0;
		
		if (lines[0] && lines[0].text.trim() === '---') {
			let endIndex = 0;
			for (let cursor = 1; cursor < lines.length; cursor++) {
				if (/^(?:---|\.\.\.)\s*$/.test(lines[cursor].text)) {
					endIndex = cursor;
					break;
				}
			}
			if (endIndex > 0) {
				let start = lines[0].start;
				let end = lines[endIndex].end;
				result.push(visualBlock('frontmatter', text.slice(start, end), start, end));
				index = endIndex + 1;
			}
		}
		
		while (index < lines.length) {
			let line = lines[index];
			let trimmed = line.text.trim();
			if (!trimmed) {
				index += 1;
				continue;
			}
			
			let div = /^\s*:{3,}\s*\{([^}]*)\}\s*$/.exec(line.text);
			if (div) {
				let closing = visualFenceEnd(lines, index);
				if (closing > index) {
					let start = line.start;
					let end = lines[closing].end;
					let raw = text.slice(start, end);
					let semantic = semanticFence(div[1] || '');
					result.push(visualBlock(semantic ? 'theorem' : 'callout', raw, start, end, {
						semantic: semantic || undefined,
						title: fenceTitle(raw),
					}));
					index = closing + 1;
					continue;
				}
			}
			
			let codeOpening = /^\s*(`{3,}|~{3,})/.exec(line.text);
			if (codeOpening) {
				let fence = codeOpening[1];
				let closing = index + 1;
				let re = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`);
				while (closing < lines.length && !re.test(lines[closing].text)) {
					closing += 1;
				}
				if (closing >= lines.length) {
					closing = lines.length - 1;
				}
				result.push(visualBlock(
					'code',
					text.slice(line.start, lines[closing].end),
					line.start,
					lines[closing].end
				));
				index = closing + 1;
				continue;
			}
			
			if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
				let closingToken = trimmed.startsWith('$$') ? '$$' : '\\]';
				let closing = index;
				let remainder = trimmed.slice(2);
				if (!remainder.endsWith(closingToken) || remainder.length <= closingToken.length) {
					closing += 1;
					while (closing < lines.length
							&& !lines[closing].text.trimEnd().endsWith(closingToken)) {
						closing += 1;
					}
					if (closing >= lines.length) {
						closing = lines.length - 1;
					}
				}
				result.push(visualBlock(
					'display-math',
					text.slice(line.start, lines[closing].end),
					line.start,
					lines[closing].end
				));
				index = closing + 1;
				continue;
			}
			
			let heading = /^(#{1,6})\s+/.exec(trimmed);
			if (heading) {
				result.push(visualBlock('heading', text.slice(line.start, line.end), line.start, line.end, {
					level: heading[1].length,
				}));
				index += 1;
				continue;
			}
			
			if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line.text)) {
				let closing = index;
				while (closing + 1 < lines.length
						&& (/^\s*(?:[-+*]|\d+[.)])\s+/.test(lines[closing + 1].text)
							|| /^\s{2,}\S/.test(lines[closing + 1].text))) {
					closing += 1;
				}
				result.push(visualBlock(
					'list',
					text.slice(line.start, lines[closing].end),
					line.start,
					lines[closing].end
				));
				index = closing + 1;
				continue;
			}
			
			if (/^\s*>/.test(line.text)) {
				let closing = index;
				while (closing + 1 < lines.length && /^\s*>/.test(lines[closing + 1].text)) {
					closing += 1;
				}
				result.push(visualBlock(
					'blockquote',
					text.slice(line.start, lines[closing].end),
					line.start,
					lines[closing].end
				));
				index = closing + 1;
				continue;
			}
			
			if (/^(?:<|\||:::+|\{[^}]*\}\s*$)/.test(trimmed)) {
				result.push(visualBlock('raw', text.slice(line.start, line.end), line.start, line.end));
				index += 1;
				continue;
			}
			
			let closing = index;
			while (closing + 1 < lines.length) {
				let next = lines[closing + 1].text;
				let nextTrimmed = next.trim();
				if (!nextTrimmed
						|| /^\s*:{3,}\s*\{|^\s*(?:`{3,}|~{3,})|^#{1,6}\s+|^\s*(?:[-+*]|\d+[.)])\s+|^\s*>|^(?:\$\$|\\\[)/.test(next)) {
					break;
				}
				closing += 1;
			}
			result.push(visualBlock(
				'paragraph',
				text.slice(line.start, lines[closing].end),
				line.start,
				lines[closing].end
			));
			index = closing + 1;
		}
		
		return result;
	};
	
	/**
	 * Apply one visual block edit with optimistic conflict detection.
	 */
	Zotero.QLab.applyQmdVisualBlock = function (source, selected, replacement) {
		let text = String(source ?? '');
		let start = selected.start;
		let end = selected.end;
		if (text.slice(start, end) !== selected.source) {
			start = text.indexOf(selected.source);
			if (start < 0
					|| text.indexOf(selected.source, start + selected.source.length) >= 0) {
				throw new Error('This QMD block changed before this edit could be saved');
			}
			end = start + selected.source.length;
		}
		let reference = String(selected.source ?? '');
		let eol = reference.includes('\r\n') || (!reference.includes('\n') && text.includes('\r\n'))
			? '\r\n'
			: reference.includes('\r') || (!reference.includes('\n') && text.includes('\r')) ? '\r' : '\n';
		let next = String(replacement ?? '').replace(/\r\n|\r|\n/g, '\n');
		if (eol !== '\n') {
			next = next.replace(/\n/g, eol);
		}
		if (/(?:\r\n|\r|\n)$/.test(reference) && !/(?:\r\n|\r|\n)$/.test(next)) {
			next += eol;
		}
		if (next === selected.source) {
			return { source: text, changed: false };
		}
		return {
			source: `${text.slice(0, start)}${next}${text.slice(end)}`,
			changed: true,
		};
	};

	/**
	 * Find the exact LaTeX bodies inside one source-backed visual block.
	 * Ranges address the body only, so Visual Edit can preserve delimiters and
	 * every byte outside the selected formula.
	 */
	Zotero.QLab.qmdMathSpans = function (source) {
		let text = String(source ?? '');
		let spans = [];
		let protectedRanges = [];
		let lines = sourceLines(text);
		let activeFence = null;
		for (let line of lines) {
			if (!activeFence) {
				let opening = /^\s*(`{3,}|~{3,})/.exec(line.text);
				if (opening) {
					activeFence = {
						character: opening[1][0],
						length: opening[1].length,
						start: line.start,
					};
				}
				continue;
			}
			let closing = new RegExp(
				`^\\s*${activeFence.character}{${activeFence.length},}\\s*$`);
			if (closing.test(line.text)) {
				protectedRanges.push([activeFence.start, line.end]);
				activeFence = null;
			}
		}
		if (activeFence) {
			protectedRanges.push([activeFence.start, text.length]);
		}
		function isEscaped(index) {
			let slashes = 0;
			for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
				slashes += 1;
			}
			return slashes % 2 === 1;
		}

		function addSpan(start, end, latexStart, latexEnd, display, opening) {
			if (protectedRanges.some(([left, right]) => start < right && end > left)) {
				return false;
			}
			if (occupied.some(([left, right]) => start < right && end > left)) {
				return false;
			}
			occupied.push([start, end]);
			spans.push({
				source: text.slice(start, end),
				latex: text.slice(latexStart, latexEnd),
				start: latexStart,
				end: latexEnd,
				display,
				opening,
			});
			return true;
		}

		let patterns = [
			{ re: /\$\$([\s\S]+?)\$\$/g, display: true, opening: '$$', trim: 2 },
			{ re: /\\\[([\s\S]+?)\\\]/g, display: true, opening: '\\[', trim: 2 },
		];
		let occupied = [];
		for (let pattern of patterns) {
			for (let match of text.matchAll(pattern.re)) {
				let start = match.index ?? -1;
				if (start < 0) {
					continue;
				}
				let end = start + match[0].length;
				let latexStart = start + pattern.trim;
				addSpan(start, end, latexStart, latexStart + (match[1] || '').length,
					pattern.display, pattern.opening);
			}
		}
		for (let index = 0; index < text.length; index++) {
			if (text.startsWith('\\(', index) && !isEscaped(index)) {
				for (let end = index + 2; end < text.length - 1; end++) {
					if (text[end] !== '\\' || text[end + 1] !== ')' || isEscaped(end)) continue;
					addSpan(index, end + 2, index + 2, end, false, '\\(');
					index = end + 1;
					break;
				}
				continue;
			}
			if (text[index] !== '$' || isEscaped(index) || text[index + 1] === '$'
					|| /\s/.test(text[index + 1] || '')) {
				continue;
			}
			for (let end = index + 1; end < text.length; end++) {
				if (text[end] !== '$' || isEscaped(end) || text[end + 1] === '$') continue;
				if (/\s/.test(text[end - 1] || '') || /\d/.test(text[end + 1] || '')) continue;
				addSpan(index, end + 1, index + 1, end, false, '$');
				index = end;
				break;
			}
		}
		return spans.sort((left, right) => left.start - right.start);
	};
})();
