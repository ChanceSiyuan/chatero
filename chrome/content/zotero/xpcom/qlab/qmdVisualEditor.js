/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Chance Siyuan / Chatero contributors

	This file is part of Chatero (a Zotero fork).

	***** END LICENSE BLOCK *****
*/

/**
 * Source-driven Visual Edit for trusted QMD Draft buffers.
 * Compiled HTML is presentation only; every edit maps back to exact QMD.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const SAVE_DELAY_MS = 420;

	const SEMANTIC_LABELS = Object.freeze({
		thm: 'Theorem',
		lem: 'Lemma',
		def: 'Definition',
		prp: 'Proposition',
		cor: 'Corollary',
		exm: 'Example',
		proof: 'Proof',
	});

	const FORMAL_BLOCKS = Object.freeze({
		def: Object.freeze({
			anchor: 'new-definition',
			title: 'New definition',
			body: 'Write the definition in English.',
			attributes: '.callout-note icon="false"',
		}),
		lem: Object.freeze({
			anchor: 'new-lemma',
			title: 'New lemma',
			body: 'State the lemma in English.',
			attributes: '.callout-important icon="false"',
		}),
		thm: Object.freeze({
			anchor: 'new-theorem',
			title: 'New theorem',
			body: 'State the theorem in English.',
			attributes: '.callout-important icon="false"',
		}),
		proof: Object.freeze({
			anchor: 'new-proof',
			title: '',
			body: 'Write the proof in English.',
			attributes: '.callout-note collapse="true"',
		}),
	});

	Zotero.QLab.qmdFormalBlockTemplate = function (source, kind) {
		let definition = FORMAL_BLOCKS[kind];
		if (!definition) {
			throw new Error(`Unsupported formal QMD block: ${kind}`);
		}
		let suffix = 1;
		let anchor = `${kind}-${definition.anchor}`;
		while (String(source ?? '').includes(`#${anchor}`)) {
			suffix += 1;
			anchor = `${kind}-${definition.anchor}-${suffix}`;
		}
		return {
			anchor,
			source: `::: {#${anchor} ${definition.attributes}}\n\n`
				+ `${definition.title ? `## ${definition.title}\n\n` : ''}`
				+ `${definition.body}\n\n:::`,
		};
	};

	Zotero.QLab.insertQmdFormalBlockAt = function (source, offset, kind) {
		let text = String(source ?? '');
		let insertionOffset = Math.max(0, Math.min(text.length, Number(offset) || 0));
		let template = Zotero.QLab.qmdFormalBlockTemplate(text, kind);
		let before = text.slice(0, insertionOffset);
		let after = text.slice(insertionOffset);
		let eol = text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n';
		let templateSource = template.source.replace(/\r\n|\r|\n/g, eol);
		let leading = !before || before.endsWith(`${eol}${eol}`)
			? ''
			: before.endsWith(eol) ? eol : `${eol}${eol}`;
		let trailing = !after
			? eol
			: after.startsWith(`${eol}${eol}`) ? '' : after.startsWith(eol) ? eol : `${eol}${eol}`;
		return {
			anchor: template.anchor,
			source: `${before}${leading}${templateSource}${trailing}${after}`,
		};
	};

	function semanticKey(value) {
		return {
			theorem: 'thm',
			lemma: 'lem',
			definition: 'def',
			proposition: 'prp',
			corollary: 'cor',
			example: 'exm',
			prf: 'proof',
		}[value] || value || 'callout';
	}

	function sourceLineRegions(source) {
		let text = String(source ?? '');
		let lines = [];
		let start = 0;
		let newline = /\r\n|\r|\n/g;
		for (let match of text.matchAll(newline)) {
			lines.push({
				text: text.slice(start, match.index),
				start,
				end: match.index + match[0].length,
			});
			start = match.index + match[0].length;
		}
		if (start < text.length) {
			lines.push({ text: text.slice(start), start, end: text.length });
		}
		return lines;
	}

	function theoremBodyRegion(source) {
		let text = String(source ?? '');
		let lines = sourceLineRegions(text);
		let closing = Math.max(1, lines.length - 1);
		let body = 1;
		while (body < closing && !lines[body].text.trim()) {
			body += 1;
		}
		if (body < closing && /^#{1,6}\s+/.test(lines[body].text)) {
			body += 1;
		}
		while (body < closing && !lines[body].text.trim()) {
			body += 1;
		}
		let start = lines[body] ? lines[body].start : (lines[closing] ? lines[closing].start : text.length);
		let end = lines[closing] ? lines[closing].start : text.length;
		return { source: text.slice(start, end), start };
	}

	function setSafeHTML(element, html) {
		if (Zotero.QLab.setHTML) {
			Zotero.QLab.setHTML(element, html);
			return;
		}
		element.textContent = String(html || '').replace(/<[^>]*>/g, ' ');
	}

	function renderBodyHTML(source) {
		let blocks = Zotero.QLab.visualQmdBlocks(source);
		return blocks.map(block => Zotero.QLab.renderQmdBlockHTML(block)).join('');
	}

	function frontmatterSummary(doc, source) {
		let fragment = doc.createDocumentFragment();
		let values = new Map();
		for (let line of String(source ?? '').split(/\r?\n/).slice(1, -1)) {
			let match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
			if (match) {
				values.set(match[1], match[2].replace(/^['"]|['"]$/g, ''));
			}
		}
		let title = doc.createElement('strong');
		title.textContent = values.get('title') || 'Document metadata';
		let description = doc.createElement('span');
		description.textContent = values.get('description') || 'Click to edit YAML frontmatter';
		fragment.append(title, description);
		return fragment;
	}

	/**
	 * Create a resident source-driven Visual Editor. The shared Draft session
	 * supplies the only persistence callback; compiled Website HTML is never
	 * edited or treated as source authority.
	 */
	Zotero.QLab.createQmdVisualEditor = function (doc, options = {}) {
		let root = doc.createElement('article');
		root.className = 'zc-qmd-visual-editor';
		root.setAttribute('aria-label', 'Visual QMD editor');
		let source = '';
		let revision = '';
		let generation = 0;
		let editable = false;
		let disposed = false;
		let active = null;
		let selectedBlockId = null;
		let inserting = false;

		function reportStatus(edit, message, state) {
			if (disposed || active !== edit || edit.generation !== generation) {
				return;
			}
			if (typeof options.onStatus === 'function') {
				options.onStatus(message, state, edit.generation);
			}
		}

		function cancelActive() {
			if (!active) {
				return;
			}
			if (active.timer) {
				clearTimeout(active.timer);
			}
			active = null;
		}

		async function flushActive() {
			let edit = active;
			if (!edit) {
				return;
			}
			if (edit.timer) {
				clearTimeout(edit.timer);
				edit.timer = null;
			}
			if (edit.saving) {
				await edit.saving;
				if (active === edit && edit.text !== edit.savedText) {
					return flushActive();
				}
				return;
			}
			if (edit.text === edit.savedText) {
				if (edit.closeAfterSave) {
					active = null;
					render();
				}
				return;
			}

			let textAtStart = edit.text;
			let failed = false;
			let task = (async () => {
				reportStatus(edit, 'Saving Draft…', 'saving');
				let result = Zotero.QLab.applyQmdVisualBlock(source, edit.block, textAtStart);
				if (!result.changed) {
					edit.savedText = textAtStart;
					return;
				}
				if (typeof options.save !== 'function') {
					throw new Error('Visual Edit requires a Draft save callback');
				}
				let snapshot = await options.save(result.source, revision, edit.generation);
				if (disposed || active !== edit || edit.generation !== generation) {
					return;
				}
				source = String(snapshot && snapshot.source || result.source);
				revision = String(snapshot && snapshot.revision || revision);
				edit.savedText = textAtStart;
				let blocks = Zotero.QLab.visualQmdBlocks(source);
				let next = blocks.find(candidate => candidate.start === edit.block.start)
					|| blocks.find(candidate => candidate.source === textAtStart);
				if (next) {
					edit.block = next;
					selectedBlockId = next.id;
				}
				reportStatus(edit, 'Draft saved · website preview is rebuilding', 'saved');
			})().catch(error => {
				failed = true;
				if (active !== edit || edit.generation !== generation || disposed) {
					return;
				}
				let message = error && error.message || String(error);
				reportStatus(edit, message,
					/changed|conflict|revision/i.test(message) ? 'conflict' : 'error');
				edit.closeAfterSave = false;
			}).finally(() => {
				if (active === edit) {
					edit.saving = null;
				}
			});
			edit.saving = task;
			await task;
			if (active !== edit || failed) {
				return;
			}
			if (edit.text !== edit.savedText) {
				return flushActive();
			}
			if (edit.closeAfterSave) {
				active = null;
				render();
			}
		}

		function scheduleSave() {
			let edit = active;
			if (!edit) {
				return;
			}
			if (edit.timer) {
				clearTimeout(edit.timer);
			}
			edit.timer = setTimeout(() => {
				if (active !== edit) {
					return;
				}
				edit.timer = null;
				void flushActive();
			}, SAVE_DELAY_MS);
		}

		function beginEdit(block, element, replacement) {
			let initial = replacement(element.value);
			active = {
				block,
				element,
				text: initial,
				savedText: block.source,
				replacement,
				timer: null,
				saving: null,
				closeAfterSave: false,
				generation,
			};
			element.addEventListener('input', () => {
				if (!active || active.element !== element) {
					return;
				}
				active.text = active.replacement(element.value);
				reportStatus(active, 'Editing Draft…', 'editing');
				scheduleSave();
			});
			element.addEventListener('keydown', event => {
				if (event.key === 'Escape') {
					event.preventDefault();
					cancelActive();
					render();
				}
				else if (event.key === 'Enter' && element.tagName === 'INPUT') {
					event.preventDefault();
					element.blur();
				}
			});
			element.addEventListener('blur', () => {
				if (!active || active.element !== element) {
					return;
				}
				active.text = active.replacement(element.value);
				active.closeAfterSave = true;
				void flushActive();
			});
			element.focus();
			element.select();
		}

		function openFormulaEditor(block, math, element) {
			if (!editable || active) {
				return;
			}
			let editor = doc.createElement(math.display ? 'textarea' : 'input');
			if (!math.display) {
				editor.type = 'text';
			}
			editor.className = 'zc-qmd-visual-math-editor';
			editor.value = math.latex.trim();
			editor.setAttribute('aria-label', math.display ? 'Edit display LaTeX' : 'Edit inline LaTeX');
			element.replaceChildren(editor);
			beginEdit(block, editor, value => {
				let leading = /^\s*/.exec(math.latex)[0] || '';
				let trailing = /\s*$/.exec(math.latex)[0] || '';
				let latex = math.display ? value.trim() : value.replace(/\s+/g, ' ').trim();
				return `${block.source.slice(0, math.start)}${leading}${latex}${trailing}`
					+ block.source.slice(math.end);
			});
		}

		function openBlockEditor(block, element) {
			if (!editable || active) {
				return;
			}
			let textarea = doc.createElement('textarea');
			textarea.className = 'zc-qmd-visual-source-editor';
			textarea.value = block.source;
			textarea.rows = Math.max(3, Math.min(28,
				String(block.source || '').split(/\r?\n/).length + 1));
			textarea.setAttribute('aria-label', block.kind === 'theorem'
				? 'Edit theorem, lemma, definition, or proof QMD source'
				: 'Edit QMD source block');
			element.replaceChildren(textarea);
			beginEdit(block, textarea, value => value);
		}

		function bindFormulaEditors(container, block, region = { source: block.source, start: 0 }) {
			if (!editable) {
				return;
			}
			let spans = Zotero.QLab.qmdMathSpans(region.source).map(span => ({
				...span,
				start: span.start + region.start,
				end: span.end + region.start,
			}));
			let rendered = Array.from(container.querySelectorAll(
				'.zc-math-inline,.zc-math-display,.zc-math-error,'
				+ '.qlab-qmd-math-inline,.qlab-qmd-math-display,.qlab-qmd-math-error'));
			let used = new Set();
			for (let element of rendered) {
				let latex = element.dataset && typeof element.dataset.latex === 'string'
					? element.dataset.latex.trim()
					: '';
				let display = element.classList.contains('zc-math-display')
					|| element.classList.contains('qlab-qmd-math-display');
				let spanIndex = spans.findIndex((candidate, index) => !used.has(index)
					&& candidate.display === display && candidate.latex.trim() === latex);
				if (spanIndex < 0) continue;
				used.add(spanIndex);
				let span = spans[spanIndex];
				if (!span) {
					continue;
				}
				element.dataset.qlabSourceStart = String(span.start);
				element.dataset.qlabSourceEnd = String(span.end);
				element.title = 'Edit LaTeX';
				element.addEventListener('click', event => {
					event.preventDefault();
					event.stopPropagation();
					selectedBlockId = block.id;
					openFormulaEditor(block, span, element);
				});
			}
		}

		function renderBlock(block, counters) {
			if (block.kind === 'frontmatter') {
				let card = doc.createElement('section');
				card.className = 'zc-qmd-visual-block zc-qmd-visual-frontmatter';
				card.appendChild(frontmatterSummary(doc, block.source));
				return card;
			}

			if (block.kind === 'theorem' || block.kind === 'callout') {
				let key = semanticKey(block.semantic);
				let card = doc.createElement('section');
				card.className = `zc-qmd-visual-block zc-qmd-visual-card is-${key}`;
				let header = doc.createElement('header');
				let next = (counters.get(key) || 0) + 1;
				counters.set(key, next);
				let label = SEMANTIC_LABELS[key] || 'Callout';
				header.textContent = `${label}${key === 'proof' ? '' : ` ${next}`}`
					+ `${block.title ? `: ${block.title}` : ''}`;
				let body = doc.createElement('div');
				body.className = 'zc-qmd-visual-card-body';
				let bodyRegion = theoremBodyRegion(block.source);
				setSafeHTML(body, renderBodyHTML(bodyRegion.source));
				card.append(header, body);
				bindFormulaEditors(card, block, bodyRegion);
				return card;
			}

			let wrapper = doc.createElement('section');
			wrapper.className = `zc-qmd-visual-block is-${block.kind}`;
			if (block.kind === 'raw' || block.kind === 'code') {
				let pre = doc.createElement('pre');
				pre.textContent = block.source;
				wrapper.appendChild(pre);
			}
			else {
				setSafeHTML(wrapper, Zotero.QLab.renderQmdBlockHTML(block));
				bindFormulaEditors(wrapper, block);
			}
			return wrapper;
		}

		function render() {
			if (disposed) {
				return;
			}
			root.replaceChildren();
			let counters = new Map();
			for (let block of Zotero.QLab.visualQmdBlocks(source)) {
				let element = renderBlock(block, counters);
				element.dataset.blockId = block.id;
				element.dataset.blockKind = block.kind;
				if (editable) {
					element.tabIndex = 0;
					element.title = block.kind === 'theorem'
						? 'Click text to edit the whole QMD block; click a formula to edit only its LaTeX'
						: 'Click to edit this QMD block';
					element.addEventListener('click', event => {
						if (event.target && event.target.closest
								&& event.target.closest('.zc-qmd-visual-math-editor')) {
							return;
						}
						selectedBlockId = block.id;
						openBlockEditor(block, element);
					});
					element.addEventListener('focus', () => {
						selectedBlockId = block.id;
					});
					element.addEventListener('keydown', event => {
						if (event.key === 'Enter' && event.target === element) {
							event.preventDefault();
							openBlockEditor(block, element);
						}
					});
				}
				root.appendChild(element);
			}
		}

		return {
			root,
			setDocument(snapshot, canEdit, nextGeneration = 0) {
				cancelActive();
				source = String(snapshot && snapshot.source || '');
				revision = String(snapshot && snapshot.revision || '');
				generation = nextGeneration;
				editable = !!canEdit;
				selectedBlockId = null;
				render();
			},
			snapshot() {
				return { source, revision };
			},
			isEditing() {
				return active !== null;
			},
			async finishActiveEdit() {
				let edit = active;
				if (!edit) {
					return;
				}
				edit.text = edit.replacement(edit.element.value);
				edit.closeAfterSave = true;
				await flushActive();
			},
			async insertFormalBlock(kind) {
				if (!editable || disposed) {
					throw new Error('Visual Edit is not ready for insertion');
				}
				if (inserting) {
					return;
				}
				inserting = true;
				let insertionGeneration = generation;
				try {
					await this.finishActiveEdit();
					if (active) {
						throw new Error('Finish the active QMD edit before inserting a formal block');
					}
					let blocks = Zotero.QLab.visualQmdBlocks(source);
					let selected = blocks.find(candidate => candidate.id === selectedBlockId);
					let insertion = Zotero.QLab.insertQmdFormalBlockAt(
						source, selected ? selected.end : source.length, kind);
					if (typeof options.onStatus === 'function') {
						options.onStatus('Inserting formal block…', 'saving', insertionGeneration);
					}
					if (typeof options.save !== 'function') {
						throw new Error('Visual Edit requires a Draft save callback');
					}
					let snapshot = await options.save(insertion.source, revision, insertionGeneration);
					if (disposed || insertionGeneration !== generation) {
						return;
					}
					source = String(snapshot && snapshot.source || insertion.source);
					revision = String(snapshot && snapshot.revision || revision);
					let inserted = Zotero.QLab.visualQmdBlocks(source).find(candidate =>
						candidate.source.includes(`#${insertion.anchor}`));
					selectedBlockId = inserted ? inserted.id : null;
					render();
					if (inserted) {
						let element = Array.from(root.querySelectorAll('[data-block-id]'))
							.find(candidate => candidate.dataset.blockId === inserted.id);
						if (element) {
							element.focus();
						}
					}
					if (typeof options.onStatus === 'function') {
						options.onStatus('Formal block inserted · click the card to write',
							'saved', insertionGeneration);
					}
				}
				finally {
					inserting = false;
				}
			},
			dispose() {
				disposed = true;
				cancelActive();
				root.remove();
			},
		};
	};
})();
