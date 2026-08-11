import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

class TestClassList {
	constructor(element) {
		this.element = element;
	}
	values() {
		return String(this.element.className || "").split(/\s+/).filter(Boolean);
	}
	contains(name) {
		return this.values().includes(name);
	}
	add(...names) {
		this.element.className = [...new Set([...this.values(), ...names])].join(" ");
	}
	remove(...names) {
		this.element.className = this.values().filter(name => !names.includes(name)).join(" ");
	}
	toggle(name, force) {
		const add = force === undefined ? !this.contains(name) : Boolean(force);
		if (add) this.add(name);
		else this.remove(name);
		return add;
	}
}

function dataName(attribute) {
	return attribute.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function matchesSimpleSelector(element, selector) {
	let value = selector.trim();
	if (!value) return false;
	const attribute = /\[([^=\]]+)(?:="([^"]*)")?\]/.exec(value);
	if (attribute) {
		const actual = element.getAttribute(attribute[1]);
		if (actual === null || (attribute[2] !== undefined && actual !== attribute[2])) return false;
		value = value.replace(attribute[0], "");
	}
	const tag = /^[A-Za-z][\w-]*/.exec(value)?.[0];
	if (tag && element.tagName !== tag.toUpperCase()) return false;
	for (const className of [...value.matchAll(/\.([\w-]+)/g)].map(match => match[1])) {
		if (!element.classList.contains(className)) return false;
	}
	return Boolean(tag || attribute || value.includes("."));
}

class TestElement {
	constructor(tagName, ownerDocument) {
		this.tagName = String(tagName).toUpperCase();
		this.ownerDocument = ownerDocument;
		this.parentNode = null;
		this.children = [];
		this.attributes = new Map();
		this.dataset = {};
		this.className = "";
		this.classList = new TestClassList(this);
		this.listeners = new Map();
		this._textContent = "";
		this.value = "";
		this.hidden = false;
	}
	get textContent() {
		return this._textContent + this.children.map(child => child.textContent || "").join("");
	}
	set textContent(value) {
		this.children = [];
		this._textContent = String(value ?? "");
	}
	setAttribute(name, value) {
		const stringValue = String(value);
		this.attributes.set(name, stringValue);
		if (name === "class") this.className = stringValue;
		if (name.startsWith("data-")) this.dataset[dataName(name)] = stringValue;
	}
	getAttribute(name) {
		if (name === "class") return this.className || null;
		if (name.startsWith("data-")) {
			const value = this.dataset[dataName(name)];
			return value === undefined ? null : String(value);
		}
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}
	append(...nodes) {
		for (const node of nodes) this.appendChild(node);
	}
	appendChild(node) {
		if (node.isFragment) {
			for (const child of [...node.children]) this.appendChild(child);
			return node;
		}
		node.parentNode = this;
		this.children.push(node);
		return node;
	}
	replaceChildren(...nodes) {
		for (const child of this.children) child.parentNode = null;
		this.children = [];
		this._textContent = "";
		this.append(...nodes);
	}
	remove() {
		if (!this.parentNode) return;
		this.parentNode.children = this.parentNode.children.filter(child => child !== this);
		this.parentNode = null;
	}
	addEventListener(type, listener) {
		const listeners = this.listeners.get(type) || [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}
	dispatchEvent(event) {
		if (!event.target) event.target = this;
		event.currentTarget = this;
		for (const listener of this.listeners.get(event.type) || []) listener(event);
		if (event.bubbles !== false && !event._stopped && this.parentNode) {
			this.parentNode.dispatchEvent(event);
		}
		return true;
	}
	event(type, extra = {}) {
		const event = {
			type,
			bubbles: type === "click",
			_stopped: false,
			preventDefault() {},
			stopPropagation() { this._stopped = true; },
			...extra,
		};
		this.dispatchEvent(event);
		return event;
	}
	click() {
		this.event("click");
	}
	focus() {
		this.ownerDocument.activeElement = this;
		this.event("focus", { bubbles: false });
	}
	blur() {
		if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
		this.event("blur", { bubbles: false });
	}
	select() {}
	querySelectorAll(selector) {
		const selectors = selector.split(",").map(value => value.trim());
		const results = [];
		const visit = node => {
			for (const child of node.children) {
				if (selectors.some(value => matchesSimpleSelector(child, value))) results.push(child);
				visit(child);
			}
		};
		visit(this);
		return results;
	}
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] || null;
	}
	closest(selector) {
		let current = this;
		while (current) {
			if (matchesSimpleSelector(current, selector)) return current;
			current = current.parentNode;
		}
		return null;
	}
}

class TestDocument {
	constructor({ katexStyled = true } = {}) {
		this.activeElement = null;
		this.body = this.createElement("body");
		this.documentElement = this.body;
		this.defaultView = {
			getComputedStyle() {
				return { fontFamily: katexStyled ? '"KaTeX_Main", serif' : "serif" };
			},
		};
	}
	createElement(name) {
		return new TestElement(name, this);
	}
	createDocumentFragment() {
		const fragment = new TestElement("fragment", this);
		fragment.isFragment = true;
		return fragment;
	}
}

function decodeHTML(value) {
	return String(value)
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&");
}

function installTestHTML(QLab) {
	QLab.setHTML = (element, html) => {
		element.replaceChildren();
		element._textContent = decodeHTML(String(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
		for (const match of String(html).matchAll(/<span class="([^"]*qlab-qmd-math-(?:inline|display|error)[^"]*)" data-latex="([^"]*)"/g)) {
			const math = element.ownerDocument.createElement("span");
			math.className = match[1];
			// HTML input preprocessing normalizes CR and CRLF inside attribute
			// values to LF before dataset exposes them.
			math.dataset.latex = decodeHTML(match[2]).replace(/\r\n?/g, "\n");
			element.appendChild(math);
		}
	};
}

const VISUAL_SOURCE = `---
title: Visual Draft
description: "A visual editing fixture"
categories: theory
---

# Result

The gap is $\\Delta > 0$ in this regime.

::: {#thm-gap}
## Spectral gap

For every size $n$, suppose

$$
H_n \\succeq \\Delta I.
$$
:::
`;

async function createVisualEditor(options = {}) {
	const QLab = await loadQLab();
	installTestHTML(QLab);
	const document = new TestDocument({ katexStyled: options.katexStyled !== false });
	const saves = [];
	let source = options.source ?? VISUAL_SOURCE;
	let revision = "r1";
	const save = options.save || (async (next, expected, generation) => {
		saves.push({ next, expected, generation });
		assert.equal(expected, revision);
		source = next;
		revision = `r${Number(revision.slice(1)) + 1}`;
		return { source, revision };
	});
	const statuses = [];
	const editor = QLab.createQmdVisualEditor(document, {
		save,
		onStatus: (...args) => statuses.push(args),
	});
	document.body.appendChild(editor.root);
	const documentDescriptor = QLab.createQmdDraftDocumentDescriptor({
		relativePath: "drafts/visual.qmd",
	});
	editor.setDocument({ source, revision, document: documentDescriptor }, documentDescriptor, 1);
	return { QLab, document, documentDescriptor, editor, saves, statuses, source: () => source };
}

async function settle() {
	for (let index = 0; index < 5; index += 1) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, resolve, reject };
}

test("qmdMathSpans returns exact non-overlapping LaTeX ranges", async () => {
	const QLab = await loadQLab();
	const source = "Inline $x+y$.\n$$\nH_n \\succeq 0\n$$\nAnd \\(z^2\\).";
	const spans = QLab.qmdMathSpans(source);

	assert.deepEqual(JSON.parse(JSON.stringify(spans)), [
		{
			source: "$x+y$",
			latex: "x+y",
			start: source.indexOf("x+y"),
			end: source.indexOf("x+y") + 3,
			display: false,
			opening: "$",
		},
		{
			source: "$$\nH_n \\succeq 0\n$$",
			latex: "\nH_n \\succeq 0\n",
			start: source.indexOf("$$\n") + 2,
			end: source.indexOf("\n$$", source.indexOf("H_n")) + 1,
			display: true,
			opening: "$$",
		},
		{
			source: "\\(z^2\\)",
			latex: "z^2",
			start: source.indexOf("z^2"),
			end: source.indexOf("z^2") + 3,
			display: false,
			opening: "\\(",
		},
	]);
});

test("qmdMathSpans ignores escaped dollars and does not split display math", async () => {
	const QLab = await loadQLab();
	const source = "Price \\$5; inline $a$; display $$b+c$$.";
	assert.deepEqual(
		JSON.parse(JSON.stringify(
			QLab.qmdMathSpans(source).map(span => [span.source, span.latex, span.display]),
		)),
		[["$a$", "a", false], ["$$b+c$$", "b+c", true]],
	);
});

test("qmdMathSpans follows the rendered inline-dollar whitespace rule", async () => {
	const QLab = await loadQLab();
	const source = "literal $ not math $ and $x$";

	assert.deepEqual(
		JSON.parse(JSON.stringify(QLab.qmdMathSpans(source).map(span => [span.latex, span.start, span.end]))),
		[["x", source.lastIndexOf("x"), source.lastIndexOf("x") + 1]],
	);
});

test("qmdMathSpans excludes formulas inside fenced code", async () => {
	const QLab = await loadQLab();
	const source = [
		"```text",
		"$x$",
		"```",
		"Rendered $x$.",
	].join("\n");
	const spans = JSON.parse(JSON.stringify(QLab.qmdMathSpans(source)));

	assert.equal(spans.length, 1);
	assert.equal(spans[0].source, "$x$");
	assert.equal(spans[0].start, source.lastIndexOf("$x$") + 1);
});

test("qmdFormalBlockTemplate emits canonical definition lemma theorem and proof Divs", async () => {
	const QLab = await loadQLab();
	const expected = {
		def: ["def-new-definition", '::: {#def-new-definition .callout-note icon="false"}\n\n## New definition\n\nWrite the definition in English.\n\n:::'],
		lem: ["lem-new-lemma", '::: {#lem-new-lemma .callout-important icon="false"}\n\n## New lemma\n\nState the lemma in English.\n\n:::'],
		thm: ["thm-new-theorem", '::: {#thm-new-theorem .callout-important icon="false"}\n\n## New theorem\n\nState the theorem in English.\n\n:::'],
		proof: ["proof-new-proof", '::: {#proof-new-proof .callout-note collapse="true"}\n\nWrite the proof in English.\n\n:::'],
	};

	for (const [kind, [anchor, source]] of Object.entries(expected)) {
		assert.deepEqual(
			JSON.parse(JSON.stringify(QLab.qmdFormalBlockTemplate("", kind))),
			{ anchor, source },
		);
	}
});

test("qmdFormalBlockTemplate increments an existing formal anchor", async () => {
	const QLab = await loadQLab();
	const source = [
		"::: {#thm-new-theorem .callout-important}",
		"Old",
		":::",
		"::: {#thm-new-theorem-2 .callout-important}",
		"Older",
		":::",
	].join("\n");
	const result = QLab.qmdFormalBlockTemplate(source, "thm");
	assert.equal(result.anchor, "thm-new-theorem-3");
	assert.match(result.source, /#thm-new-theorem-3\b/);
});

test("insertQmdFormalBlockAt preserves surrounding source and paragraph spacing", async () => {
	const QLab = await loadQLab();
	const source = "# Result\n\nTail paragraph.\n";
	const result = QLab.insertQmdFormalBlockAt(source, "# Result".length, "lem");
	assert.equal(result.anchor, "lem-new-lemma");
	assert.equal(
		result.source,
		"# Result\n\n::: {#lem-new-lemma .callout-important icon=\"false\"}\n\n"
			+ "## New lemma\n\nState the lemma in English.\n\n:::\n\nTail paragraph.\n",
	);
});

test("visualQmdBlocks keeps every CRLF block in the original source coordinate space", async () => {
	const QLab = await loadQLab();
	const source = [
		"---",
		"title: CRLF",
		"---",
		"",
		"# Result",
		"",
		"Paragraph with $x$.",
		"",
		"::: {#thm-crlf}",
		"## CRLF theorem",
		"",
		"Body $x$.",
		":::",
		"",
	].join("\r\n");
	const blocks = QLab.visualQmdBlocks(source);

	for (const block of blocks) {
		assert.equal(block.source, source.slice(block.start, block.end), `${block.kind} range`);
	}
});

test("identical Visual blocks have position-stable identities for exact selection", async () => {
	const QLab = await loadQLab();
	const source = "Repeated paragraph.\n\nRepeated paragraph.\n";
	const repeated = QLab.visualQmdBlocks(source)
		.filter(block => block.source === "Repeated paragraph.\n");

	assert.equal(repeated.length, 2);
	assert.notEqual(repeated[0].id, repeated[1].id);
	assert.match(repeated[0].id, new RegExp(`-${repeated[0].start}-${repeated[0].end}$`));
	assert.match(repeated[1].id, new RegExp(`-${repeated[1].start}-${repeated[1].end}$`));
});

test("formal insertion follows the exact selected duplicate Visual block", async () => {
	const source = "Repeated paragraph.\n\nRepeated paragraph.\n";
	const mounted = await createVisualEditor({ source });
	const paragraphs = mounted.editor.root.querySelectorAll('[data-block-kind="paragraph"]');
	assert.equal(paragraphs.length, 2);
	paragraphs[1].focus();
	await mounted.editor.insertFormalBlock("lem");

	assert.equal(
		mounted.source().indexOf("#lem-new-lemma") > mounted.source().lastIndexOf("Repeated paragraph."),
		true,
	);
});

test("insertQmdFormalBlockAt preserves CRLF and inserts after the exact selected range", async () => {
	const QLab = await loadQLab();
	const source = "# Result\r\n\r\nTail paragraph.\r\n";
	const heading = QLab.visualQmdBlocks(source).find(block => block.kind === "heading");
	const result = QLab.insertQmdFormalBlockAt(source, heading.end, "def");
	const expected = "# Result\r\n\r\n"
		+ "::: {#def-new-definition .callout-note icon=\"false\"}\r\n\r\n"
		+ "## New definition\r\n\r\nWrite the definition in English.\r\n\r\n:::\r\n\r\n"
		+ "Tail paragraph.\r\n";

	assert.equal(result.source, expected);
});

test("createQmdVisualEditor renders semantic cards and nested formulas", async () => {
	const { editor } = await createVisualEditor();
	const card = editor.root.querySelector(".zc-qmd-visual-card.is-thm");
	assert.ok(card);
	assert.equal(card.querySelector("header").textContent, "Theorem 1: Spectral gap");
	assert.match(card.textContent, /For every size/);
	assert.ok(card.querySelector(".qlab-qmd-math-inline"));
	assert.ok(card.querySelector(".qlab-qmd-math-display"));
	assert.deepEqual(JSON.parse(JSON.stringify(editor.snapshot())), {
		source: VISUAL_SOURCE,
		revision: "r1",
	});
});

test("Visual Edit renders and maps formal-title and body formulas from exact block-local ranges", async () => {
	const source = `::: {#def-r-local-function .callout-note icon="false"}
## ($r$-local function)

A function $f(u,G,x)$ is $r$-local iff
$f(u,G,x)=F\\!\\left(\\mathcal V_r(u,G,x)\\right).$
:::`;
	const mounted = await createVisualEditor({ source });
	const card = mounted.editor.root.querySelector(".zc-qmd-visual-card.is-def");
	const title = card.querySelector(".zc-qmd-visual-card-title");
	const titleFormula = title.querySelector(".qlab-qmd-math-inline");
	const bodyFormulas = card.querySelector(".zc-qmd-visual-card-body")
		.querySelectorAll(".qlab-qmd-math-inline");

	assert.equal(card.querySelector(".zc-qmd-visual-card-label").textContent, "Definition 1");
	assert.equal(title.textContent.includes("$r$"), false);
	assert.ok(titleFormula);
	assert.equal(Number(titleFormula.dataset.qlabSourceStart), source.indexOf("$r$") + 1);
	assert.equal(Number(titleFormula.dataset.qlabSourceEnd), source.indexOf("$r$") + 2);
	assert.equal(bodyFormulas.length, 3);
	for (const formula of [titleFormula, ...bodyFormulas]) {
		const start = Number(formula.dataset.qlabSourceStart);
		const end = Number(formula.dataset.qlabSourceEnd);
		assert.equal(source.slice(start, end), formula.dataset.latex);
	}
});

test("Visual Edit edits only the title LaTeX body and leaves every other QMD byte intact", async () => {
	const source = [
		"::: {#def-title-math .callout-note}",
		"## The $r$-local condition",
		"",
		"Body $r$ remains unchanged.",
		":::",
		"",
	].join("\n");
	const mounted = await createVisualEditor({ source });
	const card = mounted.editor.root.querySelector(".zc-qmd-visual-card.is-def");
	const formulas = card.querySelectorAll(".qlab-qmd-math-inline");
	assert.equal(formulas.length, 2);

	formulas[0].click();
	const input = card.querySelector(".zc-qmd-visual-math-editor");
	assert.equal(input.value, "r");
	input.value = "R";
	input.event("input", { bubbles: false });
	input.blur();
	await settle();

	assert.equal(mounted.source(), source.replace("The $r$-local", "The $R$-local"));
});

test("clicking non-formula formal-title text opens the complete source card", async () => {
	const mounted = await createVisualEditor();
	const card = mounted.editor.root.querySelector(".zc-qmd-visual-card.is-thm");
	card.querySelector(".zc-qmd-visual-card-title").click();

	const textarea = card.querySelector(".zc-qmd-visual-source-editor");
	assert.ok(textarea);
	assert.equal(textarea.value, mounted.QLab.visualQmdBlocks(VISUAL_SOURCE)
		.find(block => block.semantic === "theorem").source);
});

test("Visual Edit replaces unstyled KaTeX with delimited source that remains editable", async () => {
	const source = "The value is $x+y$.\n";
	const mounted = await createVisualEditor({ source, katexStyled: false });
	const fallback = mounted.editor.root.querySelector(".qlab-qmd-math-style-error");

	assert.ok(fallback);
	assert.equal(fallback.textContent, "$x+y$");
	assert.equal(fallback.dataset.latex, "x+y");
	fallback.click();
	const input = mounted.editor.root.querySelector(".zc-qmd-visual-math-editor");
	assert.equal(input.value, "x+y");
	input.value = "z";
	input.event("input", { bubbles: false });
	input.blur();
	await settle();
	assert.equal(mounted.source(), "The value is $z$.\n");
});

test("Visual Edit lets an invalid source-visible formula be corrected in place", async () => {
	const source = "Broken $\\definitelynotacommand{x}$ here.\n";
	const mounted = await createVisualEditor({ source });
	const error = mounted.editor.root.querySelector(".qlab-qmd-math-error");

	assert.ok(error);
	error.click();
	const input = mounted.editor.root.querySelector(".zc-qmd-visual-math-editor");
	assert.equal(input.value, "\\definitelynotacommand{x}");
	input.value = "x";
	input.event("input", { bubbles: false });
	input.blur();
	await settle();
	assert.equal(mounted.source(), "Broken $x$ here.\n");
});

test("Visual Edit changes one theorem formula without flattening its card", async () => {
	const { editor, saves, source } = await createVisualEditor();
	const card = editor.root.querySelector(".zc-qmd-visual-card.is-thm");
	const formula = card.querySelector(".qlab-qmd-math-inline");
	formula.click();

	const input = card.querySelector(".zc-qmd-visual-math-editor");
	assert.ok(input);
	assert.equal(card.querySelector(".zc-qmd-visual-source-editor"), null);
	assert.equal(input.value, "n");
	input.value = "m";
	input.event("input", { bubbles: false });
	input.blur();
	await settle();

	assert.equal(saves.length, 1);
	assert.match(source(), /For every size \$m\$, suppose/);
	assert.match(source(), /H_n \\succeq \\Delta I/);
	assert.ok(editor.root.querySelector(".zc-qmd-visual-card.is-thm"));
	assert.equal(editor.isEditing(), false);
});

test("Visual Edit binds the only rendered inline formula after literal dollars to its exact source range", async () => {
	const source = "literal $ not math $ and $x$\n";
	const mounted = await createVisualEditor({ source });
	const formulas = mounted.editor.root.querySelectorAll(".qlab-qmd-math-inline");
	assert.equal(formulas.length, 1);
	const formula = formulas[0];
	assert.equal(Number(formula.dataset.qlabSourceStart), source.lastIndexOf("x"));
	assert.equal(Number(formula.dataset.qlabSourceEnd), source.lastIndexOf("x") + 1);

	formula.click();
	const input = mounted.editor.root.querySelector(".zc-qmd-visual-math-editor");
	input.value = "y";
	input.event("input", { bubbles: false });
	input.blur();
	await settle();

	assert.equal(mounted.source(), "literal $ not math $ and $y$\n");
});

test("a repeated formula in a theorem title and body edits both exact occurrences independently", async () => {
	const source = [
		"::: {#thm-repeat}",
		"## Equality $x$",
		"",
		"The body also uses $x$.",
		":::",
		"",
	].join("\n");
	const mounted = await createVisualEditor({ source });
	const card = mounted.editor.root.querySelector(".zc-qmd-visual-card.is-thm");
	const formulas = card.querySelectorAll(".qlab-qmd-math-inline");
	assert.equal(formulas.length, 2);
	assert.equal(Number(formulas[0].dataset.qlabSourceStart), source.indexOf("$x$") + 1);
	assert.equal(Number(formulas[0].dataset.qlabSourceEnd), source.indexOf("$x$") + 2);
	assert.equal(Number(formulas[1].dataset.qlabSourceStart), source.lastIndexOf("$x$") + 1);
	assert.equal(Number(formulas[1].dataset.qlabSourceEnd), source.lastIndexOf("$x$") + 2);
	formulas[0].click();
	let input = card.querySelector(".zc-qmd-visual-math-editor");
	input.value = "t";
	input.event("input", { bubbles: false });
	input.blur();
	await settle();

	assert.match(mounted.source(), /## Equality \$t\$/);
	assert.match(mounted.source(), /The body also uses \$x\$\./);
	const rerendered = mounted.editor.root.querySelector(".zc-qmd-visual-card.is-thm");
	const bodyFormula = rerendered.querySelectorAll(".qlab-qmd-math-inline")[1];
	bodyFormula.click();
	input = rerendered.querySelector(".zc-qmd-visual-math-editor");
	input.value = "b";
	input.event("input", { bubbles: false });
	input.blur();
	await settle();

	assert.match(mounted.source(), /## Equality \$t\$/);
	assert.match(mounted.source(), /The body also uses \$b\$\./);
});

test("CRLF formal title, repeated body, and multiline display formulas edit exact ranges only", async () => {
	const source = [
		"Before.",
		"",
		"::: {#def-crlf-ranges .callout-note}",
		"## The $x$ condition",
		"",
		"The body repeats $x$.",
		"",
		"$$",
		"a+b",
		"c+d",
		"$$",
		":::",
		"",
		"After.",
		"",
	].join("\r\n");
	const mounted = await createVisualEditor({ source });

	async function editExact(formulaIndex, editorValue, replacementBody) {
		const before = mounted.source();
		const block = mounted.QLab.visualQmdBlocks(before)
			.find(candidate => candidate.semantic === "definition");
		const card = mounted.editor.root.querySelector(".zc-qmd-visual-card.is-def");
		const formula = card.querySelectorAll(
			".qlab-qmd-math-inline,.qlab-qmd-math-display,.qlab-qmd-math-error",
		)[formulaIndex];
		const localStart = Number(formula.dataset.qlabSourceStart);
		const localEnd = Number(formula.dataset.qlabSourceEnd);
		const absoluteStart = block.start + localStart;
		const absoluteEnd = block.start + localEnd;
		assert.equal(before.slice(absoluteStart, absoluteEnd), replacementBody.before);

		formula.click();
		const input = card.querySelector(".zc-qmd-visual-math-editor");
		assert.ok(input);
		input.value = editorValue;
		input.event("input", { bubbles: false });
		input.blur();
		await settle();

		assert.equal(
			mounted.source(),
			`${before.slice(0, absoluteStart)}${replacementBody.after}${before.slice(absoluteEnd)}`,
		);
	}

	await editExact(0, "t", { before: "x", after: "t" });
	await editExact(1, "b", { before: "x", after: "b" });
	await editExact(2, "m+n\r\np+q", {
		before: "\r\na+b\r\nc+d\r\n",
		after: "\r\nm+n\r\np+q\r\n",
	});
	assert.ok(mounted.source().startsWith("Before.\r\n\r\n"));
	assert.ok(mounted.source().endsWith("\r\n\r\nAfter.\r\n"));
});

test("unstyled CRLF multiline display math falls back to exact delimited source and stays editable", async () => {
	const source = [
		"::: {#lem-crlf-unstyled}",
		"## Bound $x$",
		"",
		"Body $x$.",
		"",
		"$$",
		"a+b",
		"c+d",
		"$$",
		":::",
		"",
	].join("\r\n");
	const mounted = await createVisualEditor({ source, katexStyled: false });
	const card = mounted.editor.root.querySelector(".zc-qmd-visual-card.is-lem");
	const fallbacks = card.querySelectorAll(".qlab-qmd-math-style-error");

	assert.equal(fallbacks.length, 3);
	const display = fallbacks[2];
	assert.equal(display.textContent, "$$\r\na+b\r\nc+d\r\n$$");
	const block = mounted.QLab.visualQmdBlocks(source).find(candidate => candidate.semantic === "lemma");
	const start = Number(display.dataset.qlabSourceStart);
	const end = Number(display.dataset.qlabSourceEnd);
	assert.equal(source.slice(block.start + start, block.start + end), "\r\na+b\r\nc+d\r\n");

	display.click();
	const input = card.querySelector(".zc-qmd-visual-math-editor");
	assert.ok(input);
	input.value = "u+v\r\nw+z";
	input.event("input", { bubbles: false });
	input.blur();
	await settle();
	assert.equal(mounted.source(), source.replace("a+b\r\nc+d", "u+v\r\nw+z"));
});

test("invalid CRLF multiline display math keeps its exact editable source range", async () => {
	const source = [
		"::: {#thm-crlf-invalid}",
		"## Invalid",
		"",
		"$$",
		"\\definitelynotacommand{x}",
		"+y",
		"$$",
		":::",
		"",
	].join("\r\n");
	const mounted = await createVisualEditor({ source });
	const card = mounted.editor.root.querySelector(".zc-qmd-visual-card.is-thm");
	const error = card.querySelector(".qlab-qmd-math-error");
	const block = mounted.QLab.visualQmdBlocks(source).find(candidate => candidate.semantic === "theorem");

	assert.ok(error);
	const start = Number(error.dataset.qlabSourceStart);
	const end = Number(error.dataset.qlabSourceEnd);
	assert.equal(
		source.slice(block.start + start, block.start + end),
		"\r\n\\definitelynotacommand{x}\r\n+y\r\n",
	);
	error.click();
	const input = card.querySelector(".zc-qmd-visual-math-editor");
	assert.ok(input);
	input.value = "x+y";
	input.event("input", { bubbles: false });
	input.blur();
	await settle();
	assert.equal(
		mounted.source(),
		source.replace("\\definitelynotacommand{x}\r\n+y", "x+y"),
	);
});

test("a rendered theorem formula never binds to identical LaTeX inside a code fence", async () => {
	const source = [
		"::: {#lem-code-boundary}",
		"## Code boundary",
		"",
		"```text",
		"$x$",
		"```",
		"",
		"The rendered formula is $x$.",
		":::",
		"",
	].join("\n");
	const mounted = await createVisualEditor({ source });
	const card = mounted.editor.root.querySelector(".zc-qmd-visual-card.is-lem");
	const formula = card.querySelector(".qlab-qmd-math-inline");
	assert.equal(Number(formula.dataset.qlabSourceStart), source.lastIndexOf("$x$") + 1);
	formula.click();
	const input = card.querySelector(".zc-qmd-visual-math-editor");
	input.value = "z";
	input.event("input", { bubbles: false });
	input.blur();
	await settle();

	assert.match(mounted.source(), /```text\n\$x\$\n```/);
	assert.match(mounted.source(), /The rendered formula is \$z\$\./);
});

test("Visual Edit changes a CRLF theorem formula without changing line endings or other ranges", async () => {
	const source = [
		"# CRLF",
		"",
		"::: {#thm-crlf-formula}",
		"## Formula",
		"",
		"The body is $x$.",
		":::",
		"",
	].join("\r\n");
	const mounted = await createVisualEditor({ source });
	const card = mounted.editor.root.querySelector(".zc-qmd-visual-card.is-thm");
	const formula = card.querySelector(".qlab-qmd-math-inline");
	const theoremStart = source.indexOf("::: {#thm-crlf-formula}");
	assert.equal(Number(formula.dataset.qlabSourceStart), source.indexOf("$x$") + 1 - theoremStart);
	formula.click();
	const input = card.querySelector(".zc-qmd-visual-math-editor");
	input.value = "y";
	input.event("input", { bubbles: false });
	input.blur();
	await settle();

	assert.equal(mounted.source(), source.replace("The body is $x$.", "The body is $y$."));
});

test("Visual Edit saves a complete CRLF theorem card without normalizing the document", async () => {
	const source = [
		"Before.",
		"",
		"::: {#lem-crlf-card}",
		"## Card",
		"",
		"Body statement.",
		":::",
		"",
		"After.",
		"",
	].join("\r\n");
	const mounted = await createVisualEditor({ source });
	const card = mounted.editor.root.querySelector(".zc-qmd-visual-card.is-lem");
	card.querySelector("header").click();
	const textarea = card.querySelector(".zc-qmd-visual-source-editor");
	assert.ok(textarea.value.includes("\r\n"));
	textarea.value = textarea.value.replace("Body statement.", "Revised body.");
	textarea.event("input", { bubbles: false });
	textarea.blur();
	await settle();

	assert.equal(mounted.source(), source.replace("Body statement.", "Revised body."));
});

test("Visual Edit exposes the complete fenced QMD when a theorem card is clicked", async () => {
	const { editor } = await createVisualEditor();
	const card = editor.root.querySelector(".zc-qmd-visual-card.is-thm");
	card.querySelector("header").click();

	const textarea = card.querySelector(".zc-qmd-visual-source-editor");
	assert.ok(textarea);
	assert.match(textarea.value, /^::: \{#thm-gap\}/);
	assert.match(textarea.value, /H_n \\succeq \\Delta I/);
	assert.equal(card.querySelector(".qlab-qmd-math-inline"), null);
	assert.equal(editor.isEditing(), true);
});

test("Visual Edit autosaves a source block after a short idle period", async () => {
	const { editor, saves, source } = await createVisualEditor();
	const paragraph = editor.root.querySelector('[data-block-kind="paragraph"]');
	paragraph.click();
	const textarea = paragraph.querySelector(".zc-qmd-visual-source-editor");
	assert.ok(textarea);
	textarea.value = "The gap remains positive.";
	textarea.event("input", { bubbles: false });

	await new Promise(resolve => setTimeout(resolve, 450));
	await settle();

	assert.equal(saves.length, 1);
	assert.match(source(), /The gap remains positive\./);
	assert.ok(!source().includes("The gap is $\\Delta > 0$ in this regime."));
	assert.equal(editor.isEditing(), true);
});

test("finishActiveEdit flushes the current block before a surface switch", async () => {
	const { editor, saves, source } = await createVisualEditor();
	const paragraph = editor.root.querySelector('[data-block-kind="paragraph"]');
	paragraph.click();
	const textarea = paragraph.querySelector("textarea");
	textarea.value = "Saved before leaving Visual Edit.";
	textarea.event("input", { bubbles: false });

	await editor.finishActiveEdit();

	assert.equal(saves.length, 1);
	assert.match(source(), /Saved before leaving Visual Edit\./);
	assert.equal(editor.isEditing(), false);
});

test("Visual Edit inserts canonical formal cards through the guarded save path", async () => {
	const { editor, saves, source } = await createVisualEditor();
	const expectations = [
		["def", ".zc-qmd-visual-card.is-def", "Definition 1: New definition", "#def-new-definition"],
		["lem", ".zc-qmd-visual-card.is-lem", "Lemma 1: New lemma", "#lem-new-lemma"],
		["thm", ".zc-qmd-visual-card.is-thm", "Theorem 2: New theorem", "#thm-new-theorem"],
		["proof", ".zc-qmd-visual-card.is-proof", "Proof", "#proof-new-proof"],
	];

	for (const [kind, selector, label, anchor] of expectations) {
		await editor.insertFormalBlock(kind);
		const cards = editor.root.querySelectorAll(selector);
		const inserted = cards.at(-1);
		assert.ok(inserted);
		assert.equal(inserted.querySelector("header").textContent, label);
		assert.ok(source().includes(anchor));
	}

	assert.equal(saves.length, 4);
	assert.deepEqual(saves.map(save => [save.expected, save.generation]), [
		["r1", 1], ["r2", 1], ["r3", 1], ["r4", 1],
	]);
});

test("editable to readonly Visual reuse cancels stale saves and leaves theorem and formula interactions inert", async () => {
	const mounted = await createVisualEditor();
	const paragraph = mounted.editor.root.querySelector('[data-block-kind="paragraph"]');
	paragraph.click();
	const staleTextarea = paragraph.querySelector("textarea");
	staleTextarea.value = "stale Draft mutation";
	staleTextarea.event("input", { bubbles: false });

	const readonly = mounted.QLab.createWorkspaceDocumentDescriptor({
		relativePath: "knowledge/topic.qmd",
	});
	mounted.editor.setDocument({
		source: VISUAL_SOURCE,
		revision: "ro1",
		document: readonly,
	}, readonly, 2);
	assert.equal(mounted.editor.root.getAttribute("aria-label"), "Visual QMD view");
	assert.equal(mounted.editor.root.getAttribute("aria-readonly"), "true");
	mounted.statuses.length = 0;
	staleTextarea.blur();
	await new Promise(resolve => setTimeout(resolve, 450));
	await settle();

	for (const selector of [
		"header",
		".zc-qmd-visual-card-body",
		".qlab-qmd-math-inline",
		".qlab-qmd-math-display",
	]) {
		const card = mounted.editor.root.querySelector(".zc-qmd-visual-card.is-thm");
		card.querySelector(selector).click();
		assert.equal(mounted.editor.root.querySelector(".zc-qmd-visual-source-editor"), null, selector);
		assert.equal(mounted.editor.root.querySelector(".zc-qmd-visual-math-editor"), null, selector);
	}
	const card = mounted.editor.root.querySelector(".zc-qmd-visual-card.is-thm");
	card.focus();
	card.event("keydown", { key: "Enter", target: card, bubbles: false });
	assert.equal(mounted.editor.isEditing(), false);
	await assert.rejects(() => mounted.editor.insertFormalBlock("thm"), /read-only/i);
	assert.equal(mounted.saves.length, 0);
	assert.equal(mounted.statuses.some(([, state]) => ["editing", "saving"].includes(state)), false);
	assert.deepEqual(JSON.parse(JSON.stringify(mounted.editor.snapshot())), {
		source: VISUAL_SOURCE,
		revision: "ro1",
	});
	mounted.editor.setDocument({
		source: VISUAL_SOURCE,
		revision: "draft-again",
		document: mounted.documentDescriptor,
	}, mounted.documentDescriptor, 3);
	assert.equal(mounted.editor.root.getAttribute("aria-label"), "Visual QMD editor");
	assert.equal(mounted.editor.root.getAttribute("aria-readonly"), "false");
});

test("Visual Edit suppresses a failed save from an obsolete document generation", async () => {
	const oldSave = deferred();
	const calls = [];
	const { editor, statuses, documentDescriptor } = await createVisualEditor({
		save: (next, expected, generation) => {
			calls.push({ next, expected, generation });
			return oldSave.promise;
		},
	});
	const paragraph = editor.root.querySelector('[data-block-kind="paragraph"]');
	paragraph.click();
	const textarea = paragraph.querySelector("textarea");
	textarea.value = "Generation one edit.";
	textarea.event("input", { bubbles: false });
	textarea.blur();
	await Promise.resolve();
	assert.deepEqual(calls.map(call => [call.expected, call.generation]), [["r1", 1]]);

	const newerSource = `${VISUAL_SOURCE}\nGeneration two.\n`;
	editor.setDocument({
		source: newerSource,
		revision: "r2",
		document: documentDescriptor,
	}, documentDescriptor, 2);
	oldSave.reject(new Error("old conflict"));
	await settle();

	assert.deepEqual(JSON.parse(JSON.stringify(editor.snapshot())), {
		source: newerSource,
		revision: "r2",
	});
	assert.equal(statuses.some(([message]) => message === "old conflict"), false);
});

test("Visual Edit ignores a successful save result from an obsolete generation", async () => {
	const oldSave = deferred();
	const { editor, documentDescriptor } = await createVisualEditor({ save: () => oldSave.promise });
	const paragraph = editor.root.querySelector('[data-block-kind="paragraph"]');
	paragraph.click();
	const textarea = paragraph.querySelector("textarea");
	textarea.value = "Generation one edit.";
	textarea.event("input", { bubbles: false });
	textarea.blur();
	await Promise.resolve();

	const newerSource = `${VISUAL_SOURCE}\nGeneration two.\n`;
	editor.setDocument({
		source: newerSource,
		revision: "r2",
		document: documentDescriptor,
	}, documentDescriptor, 2);
	oldSave.resolve({ source: "stale generation one", revision: "r1-saved" });
	await settle();

	assert.deepEqual(JSON.parse(JSON.stringify(editor.snapshot())), {
		source: newerSource,
		revision: "r2",
	});
});
