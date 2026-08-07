/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Lightweight Markdown → HTML for Visual Preview cards and soft Website fallback.
 * Not Quarto; unknown constructs stay escaped as preformatted text.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	function escapeHTML(value) {
		return String(value || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}
	
	function inlineFormat(text) {
		let escaped = escapeHTML(text);
		escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
		escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
		escaped = escaped.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
		escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
		return escaped;
	}
	
	/**
	 * Convert a single visual block's source into safe HTML.
	 */
	Zotero.QLab.renderQmdBlockHTML = function (block) {
		if (!block) {
			return '';
		}
		let kind = block.kind;
		let source = String(block.source || '');
		
		if (kind === 'frontmatter') {
			return `<pre class="qlab-qmd-frontmatter">${escapeHTML(source)}</pre>`;
		}
		if (kind === 'code') {
			return `<pre class="qlab-qmd-code"><code>${escapeHTML(source)}</code></pre>`;
		}
		if (kind === 'display-math') {
			return `<pre class="qlab-qmd-math">${escapeHTML(source)}</pre>`;
		}
		if (kind === 'raw' || kind === 'callout' || kind === 'theorem') {
			let title = block.title || block.semantic || kind;
			return `<div class="qlab-qmd-card is-${escapeHTML(kind)}">`
				+ `<div class="qlab-qmd-card-label">${escapeHTML(title)}</div>`
				+ `<pre>${escapeHTML(source)}</pre></div>`;
		}
		if (kind === 'heading') {
			let level = Math.min(6, Math.max(1, block.level || 1));
			let text = source.replace(/^#{1,6}\s+/, '').replace(/\s+\{[^}]*\}\s*$/, '');
			return `<h${level} class="qlab-qmd-heading">${inlineFormat(text)}</h${level}>`;
		}
		if (kind === 'list') {
			let items = source.split(/\n/).map(line => {
				let m = /^\s*(?:[-+*]|\d+[.)])\s+(.*)$/.exec(line);
				return m ? `<li>${inlineFormat(m[1])}</li>` : '';
			}).filter(Boolean).join('');
			return `<ul class="qlab-qmd-list">${items}</ul>`;
		}
		if (kind === 'blockquote') {
			let body = source.replace(/^\s*>\s?/gm, '');
			return `<blockquote class="qlab-qmd-quote">${inlineFormat(body)}</blockquote>`;
		}
		return `<p class="qlab-qmd-paragraph">${inlineFormat(source)}</p>`;
	};
	
	/**
	 * Soft full-document HTML (Website fallback when Quarto is unavailable).
	 */
	Zotero.QLab.renderQmdDocumentHTML = function (source, { title = 'Draft preview' } = {}) {
		let blocks = Zotero.QLab.visualQmdBlocks
			? Zotero.QLab.visualQmdBlocks(source)
			: [];
		let body = blocks.map(b => Zotero.QLab.renderQmdBlockHTML(b)).join('\n');
		if (!body) {
			body = `<pre>${escapeHTML(source)}</pre>`;
		}
		return `<!DOCTYPE html><html><head><meta charset="utf-8"/>`
			+ `<title>${escapeHTML(title)}</title>`
			+ `<style>
body{font:16px/1.55 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1.25rem;color:#1a1a1a}
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.9em}
pre{background:#f4f4f5;padding:0.85rem 1rem;border-radius:6px;overflow:auto}
.qlab-qmd-card{border:1px solid #ddd;border-radius:8px;padding:0.75rem 1rem;margin:1rem 0}
.qlab-qmd-card-label{font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;color:#666;margin-bottom:0.4rem}
blockquote{border-left:3px solid #ccc;margin:1rem 0;padding-left:1rem;color:#444}
h1,h2,h3{line-height:1.25}
a{color:#0b57d0}
</style></head><body>${body}</body></html>`;
	};
})();
