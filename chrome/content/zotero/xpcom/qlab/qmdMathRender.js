/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * KaTeX rendering for QMD Visual Preview and soft Website HTML.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const UNSAFE_KATEX_ELEMENTS = [
		'a',
		'audio',
		'base',
		'button',
		'embed',
		'form',
		'foreignObject',
		'iframe',
		'img',
		'input',
		'link',
		'meta',
		'object',
		'option',
		'script',
		'select',
		'source',
		'style',
		'textarea',
		'track',
		'video',
	].join(',');
	const UNSAFE_URL_ATTRIBUTES = new Set(['href', 'src', 'srcset', 'xlink:href']);
	
	function getKatex() {
		if (Zotero.QLab._katexCache) {
			return Zotero.QLab._katexCache;
		}
		try {
			if (typeof require === 'function') {
				Zotero.QLab._katexCache = require('katex');
				return Zotero.QLab._katexCache;
			}
		}
		catch (e) {
			Zotero.logError && Zotero.logError(e);
		}
		return null;
	}
	
	function isEscaped(text, index) {
		let slashes = 0;
		for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
			slashes += 1;
		}
		return slashes % 2 === 1;
	}
	
	function findUnescaped(text, delimiter, start) {
		let index = start;
		while (index < text.length) {
			let found = text.indexOf(delimiter, index);
			if (found === -1) {
				return -1;
			}
			if (!isEscaped(text, found)) {
				return found;
			}
			index = found + delimiter.length;
		}
		return -1;
	}
	
	function findClosingDollar(text, start) {
		for (let index = start; index < text.length; index++) {
			if (text[index] !== '$' || isEscaped(text, index) || text[index + 1] === '$') {
				continue;
			}
			if (/\s/.test(text[index - 1] || '')) {
				continue;
			}
			let after = text[index + 1] || '';
			if (/\d/.test(after)) {
				continue;
			}
			return index;
		}
		return -1;
	}
	
	function escapeHTML(value) {
		return String(value || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	const SAFE_LINK_SCHEMES = new Set([
		'http',
		'https',
		'zotero',
		'chatero',
		'mailto',
	]);

	Zotero.QLab.isSafeQmdLinkHref = function (value) {
		let href = String(value || '').trim();
		if (!href || /[\u0000-\u0020\u007f]/.test(href) || href.includes('\\')) {
			return false;
		}
		// A scheme-relative URL silently leaves the trusted local workspace and
		// therefore is not a relative QMD link.
		if (href.startsWith('//')) {
			return false;
		}
		let scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(href);
		if (scheme) {
			return SAFE_LINK_SCHEMES.has(scheme[1].toLowerCase());
		}
		return true;
	};

	function safeLinkHTML(label, href) {
		return Zotero.QLab.isSafeQmdLinkHref(href)
			? `<a href="${href}">${label}</a>`
			: label;
	}
	
	function hardenKatexHTML(html) {
		// KaTeX output is trusted math markup; strip only active content hooks.
		let template = `<div>${html}</div>`;
		if (typeof DOMParser !== 'undefined') {
			let doc = new DOMParser().parseFromString(template, 'text/html');
			let root = doc.body.firstChild;
			if (!root) {
				return html;
			}
			for (let unsafe of root.querySelectorAll(UNSAFE_KATEX_ELEMENTS)) {
				unsafe.remove();
			}
			for (let element of root.querySelectorAll('*')) {
				for (let attribute of [...element.attributes]) {
					let name = attribute.name.toLowerCase();
					if (name.startsWith('on') || UNSAFE_URL_ATTRIBUTES.has(name)) {
						element.removeAttribute(attribute.name);
					}
				}
			}
			return root.innerHTML;
		}
		return html;
	}
	
	function renderMathHTML(expression, displayMode, opening = '$') {
		let katex = getKatex();
		let closing = opening === '\\[' ? '\\]' : opening === '\\(' ? '\\)' : opening;
		if (!katex) {
			return `<span class="qlab-qmd-math-error">${escapeHTML(`${opening}${expression}${closing}`)}</span>`;
		}
		try {
			let html = katex.renderToString(expression, {
				displayMode,
				throwOnError: true,
				strict: 'error',
				trust: false,
				maxExpand: 1000,
				maxSize: 20,
				output: 'html',
			});
			html = hardenKatexHTML(html);
			let className = displayMode ? 'qlab-qmd-math-display' : 'qlab-qmd-math-inline';
			return `<span class="${className}" data-latex="${escapeHTML(expression)}">${html}</span>`;
		}
		catch (e) {
			return `<span class="qlab-qmd-math-error">${escapeHTML(`${opening}${expression}${closing}`)}</span>`;
		}
	}
	
	/**
	 * Extract the LaTeX body from a display-math block source ($$ or \[ delimiters).
	 */
	Zotero.QLab.extractDisplayMathExpression = function (source) {
		let trimmed = String(source || '').trim();
		let opening = trimmed.startsWith('$$') ? '$$'
			: trimmed.startsWith('\\[') ? '\\['
				: null;
		if (!opening) {
			return trimmed;
		}
		let closing = opening === '$$' ? '$$' : '\\]';
		let inner = trimmed.slice(opening.length);
		if (inner.endsWith(closing)) {
			inner = inner.slice(0, -closing.length);
		}
		return inner.trim();
	};
	
	/**
	 * Inline markdown + math → safe HTML string.
	 */
	Zotero.QLab.inlineQmdFormatHTML = function (text) {
		let value = String(text || '');
		let parts = [];
		let index = 0;
		let plain = '';
		
		function flushPlain() {
			if (!plain) {
				return;
			}
			let escaped = escapeHTML(plain);
			escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
			escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
			escaped = escaped.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
			escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
				(_match, label, href) => safeLinkHTML(label, href));
			parts.push(escaped);
			plain = '';
		}
		
		while (index < value.length) {
			if (value.startsWith('\\(', index)) {
				let end = findUnescaped(value, '\\)', index + 2);
				if (end !== -1) {
					flushPlain();
					parts.push(renderMathHTML(value.slice(index + 2, end), false, '\\('));
					index = end + 2;
					continue;
				}
			}
			
			if (value[index] === '$' && value[index + 1] !== '$' && !/\s/.test(value[index + 1] || '')) {
				let end = findClosingDollar(value, index + 1);
				if (end !== -1) {
					flushPlain();
					parts.push(renderMathHTML(value.slice(index + 1, end), false, '$'));
					index = end + 1;
					continue;
				}
			}
			
			plain += value[index] || '';
			index += 1;
		}
		flushPlain();
		return parts.join('');
	};
	
	Zotero.QLab.renderDisplayMathHTML = function (source) {
		let expression = Zotero.QLab.extractDisplayMathExpression(source);
		let opening = String(source || '').trim().startsWith('\\[') ? '\\[' : '$$';
		let html = renderMathHTML(expression, true, opening);
		if (opening === '\\[') {
			return `<div class="qlab-qmd-math-block">${html}</div>`;
		}
		return `<div class="qlab-qmd-math-block">${html}</div>`;
	};
	
	Zotero.QLab.katexStylesheetHref = function () {
		return 'resource://zotero/katex.min.css';
	};
})();
