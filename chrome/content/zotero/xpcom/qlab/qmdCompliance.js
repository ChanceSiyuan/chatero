/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Chance Siyuan / Chatero contributors

	This file is part of Chatero (a Zotero fork).

	***** END LICENSE BLOCK *****
*/

/**
 * Built-in, read-only Draft compliance checks.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const ALLOWED_FRONTMATTER_FIELDS = new Set([
		'title',
		'description',
		'categories',
		'aliases',
	]);
	const ALLOWED_CATEGORIES = new Set(['theory', 'experiment', 'codes']);

	function failed(message) {
		return {
			ok: false,
			diagnostics: [{
				code: 'DRAFT_CHECK_FAILED',
				message: String(message || 'Draft check failed'),
				line: 1,
			}],
		};
	}

	function diagnostic(code, message, line) {
		return { code, message, line };
	}

	function isSafeDraftPath(value) {
		if (typeof value !== 'string' || value !== value.trim()) return false;
		if (!value.startsWith('drafts/') || !value.endsWith('.qmd')) return false;
		if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return false;
		let parts = value.split('/');
		if (parts.length < 2 || parts.at(-1) === '.qmd') return false;
		return parts.every(part => part && part !== '.' && part !== '..');
	}

	function joinRoot(root, relativePath) {
		return `${String(root || '').replace(/[\\/]+$/, '')}/${relativePath}`;
	}

	function stripYamlComment(value) {
		let text = String(value || '');
		let quote = '';
		let escaped = false;
		for (let index = 0; index < text.length; index++) {
			let character = text[index];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (quote === '"' && character === '\\') {
				escaped = true;
				continue;
			}
			if (quote) {
				if (character === quote) quote = '';
				continue;
			}
			if (character === '"' || character === "'") {
				quote = character;
				continue;
			}
			if (character === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
				return text.slice(0, index).trimEnd();
			}
		}
		return text;
	}

	function yamlValues(value) {
		let text = stripYamlComment(value).trim();
		if (text.startsWith('[') && text.endsWith(']')) {
			text = text.slice(1, -1);
		}
		if (!text) return [];
		return text.split(',').map(item => item.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2'));
	}

	function parseFrontmatter(source) {
		let lines = String(source || '').split(/\r?\n/);
		let fields = new Map();
		if (lines[0] !== '---') {
			return { lines, fields, bodyStart: 0, opened: false, closed: false };
		}

		let activeField = null;
		let bodyStart = lines.length;
		let closed = false;
		for (let index = 1; index < lines.length; index++) {
			let line = lines[index];
			if (line === '---' || line === '...') {
				bodyStart = index + 1;
				closed = true;
				break;
			}
			let field = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
			if (field) {
				activeField = field[1];
				fields.set(activeField, {
					line: index + 1,
					values: yamlValues(field[2]),
				});
				continue;
			}
			let listItem = line.match(/^\s+-\s+(.+)$/);
			if (listItem && activeField && fields.has(activeField)) {
				fields.get(activeField).values.push(...yamlValues(listItem[1]));
			}
		}
		// Malformed frontmatter has no trustworthy body boundary. Scan everything
		// after the opening delimiter so unsafe markup and citations cannot hide in
		// what would otherwise be treated as metadata until end-of-file.
		if (!closed) bodyStart = 1;
		return { lines, fields, bodyStart, opened: true, closed };
	}

	function validateFrontmatter(parsed, diagnostics) {
		if (parsed.opened && !parsed.closed) {
			diagnostics.push(diagnostic(
				'DRAFT_FRONTMATTER_UNCLOSED',
				'Draft frontmatter must end with --- or ...',
				1
			));
		}
		for (let name of ['title', 'description']) {
			let field = parsed.fields.get(name);
			if (!field || !field.values.some(value => value)) {
				diagnostics.push(diagnostic(
					`DRAFT_${name.toUpperCase()}_REQUIRED`,
					`${name} is required`,
					field ? field.line : 1
				));
			}
		}
		let categories = parsed.fields.get('categories');
		if (!categories || !categories.values.some(value => value)) {
			diagnostics.push(diagnostic(
				'DRAFT_CATEGORIES_REQUIRED',
				'categories is required',
				categories ? categories.line : 1
			));
		}
		else if (categories.values.some(value => !ALLOWED_CATEGORIES.has(value))) {
			diagnostics.push(diagnostic(
				'DRAFT_CATEGORY_INVALID',
				'category must be theory, experiment, or codes',
				categories.line
			));
		}
		for (let [name, field] of parsed.fields) {
			if (!ALLOWED_FRONTMATTER_FIELDS.has(name)) {
				diagnostics.push(diagnostic(
					'DRAFT_FRONTMATTER_FIELD_UNSUPPORTED',
					`${name} is not allowed in Draft frontmatter`,
					field.line
				));
			}
		}
	}

	function bibliographyKeys(source) {
		let keys = new Set();
		let pattern = /@[A-Za-z]+\s*[({]\s*([^,\s}]+)/g;
		let match;
		while ((match = pattern.exec(String(source || '')))) {
			keys.add(match[1]);
		}
		return keys;
	}

	function validateBody(parsed, citekeys, diagnostics) {
		let fence = null;
		for (let index = parsed.bodyStart; index < parsed.lines.length; index++) {
			let line = parsed.lines[index];
			let number = index + 1;
			let fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
			if (fence) {
				if (fenceMatch && fenceMatch[1][0] === fence.character
						&& fenceMatch[1].length >= fence.length) fence = null;
				continue;
			}
			if (fenceMatch) {
				fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
				continue;
			}
			let activeLine = line.replace(/(`+)(.*?)\1/g, match => ' '.repeat(match.length));
			if (/<script\b/i.test(activeLine)) {
				diagnostics.push(diagnostic(
					'DRAFT_SCRIPT_FORBIDDEN',
					'script tags are not allowed in Drafts',
					number
				));
			}
			if (/<[A-Za-z][^>]*\son[a-z]{2,}[a-z0-9_-]*\s*=/i.test(activeLine)) {
				diagnostics.push(diagnostic(
					'DRAFT_INLINE_HANDLER_FORBIDDEN',
					'inline event handlers are not allowed in Drafts',
					number
				));
			}
			let citations = /(?:^|[\s[(;,])@([A-Za-z0-9][A-Za-z0-9_:+/-]*(?:\.[A-Za-z0-9_:+/-]+)*)/g;
			let citation;
			while ((citation = citations.exec(activeLine))) {
				let key = citation[1];
				if (!citekeys.has(key)) {
					diagnostics.push(diagnostic(
						'DRAFT_CITEKEY_MISSING',
						`citekey @${key} is not in literature/ref.bib`,
						number
					));
				}
			}
		}
	}

	/**
	 * Check one safe Draft using only the QLab workspace and bibliography.
	 * @param {string} root absolute QLab root
	 * @param {string} relativePath safe QMD path below drafts/
	 * @param {{host?: object}} options injectable read-only IO host
	 */
	Zotero.QLab.runQmdCompliance = async function (root, relativePath, options = {}) {
		if (!isSafeDraftPath(relativePath)) {
			return failed('Draft check requires a safe drafts/**/*.qmd path');
		}
		let hasSource = Object.prototype.hasOwnProperty.call(options, 'source');
		let hasBibliography = Object.prototype.hasOwnProperty.call(options, 'bibliographyText');
		let host = null;
		if (!hasSource || !hasBibliography) {
			host = options.host || (
				Zotero.QLab.QmdDraftIO && Zotero.QLab.QmdDraftIO.createGeckoHost
					? Zotero.QLab.QmdDraftIO.createGeckoHost()
					: null
			);
			if (!host || typeof host.read !== 'function') {
				return failed('Draft compliance requires a read-only QLab IO host');
			}
		}
		try {
			let source = hasSource
				? String(options.source ?? '')
				: (await Zotero.QLab.QmdDraftIO.readSource(root, relativePath, host)).text;
			let bibliography;
			if (hasBibliography) {
				bibliography = String(options.bibliographyText ?? '');
			}
			else {
				try {
					bibliography = await host.read(joinRoot(root, 'literature/ref.bib'));
				}
				catch (error) {
					return {
						ok: false,
						diagnostics: [diagnostic(
							'DRAFT_BIBLIOGRAPHY_REQUIRED',
							'literature/ref.bib is required for Draft compliance checks',
							1
						)],
					};
				}
			}
			let diagnostics = [];
			let parsed = parseFrontmatter(source);
			validateFrontmatter(parsed, diagnostics);
			validateBody(parsed, bibliographyKeys(bibliography), diagnostics);
			return { ok: diagnostics.length === 0, diagnostics };
		}
		catch (error) {
			return failed(error && error.message ? error.message : String(error));
		}
	};
})();
