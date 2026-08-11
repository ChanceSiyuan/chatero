import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runInNewContext } from "node:vm";

const hostPath = new URL("../../../chrome/content/zotero/qlab/qmdMonaco.html", import.meta.url);

test("dedicated QMD Monaco host exposes the parent bridge contract", async () => {
	let html = await readFile(hostPath, "utf8");
	assert.match(html, /resource:\/\/zotero\/vs\/loader\.js/);
	for (let method of [
		"loadQmdMonaco",
		"subscribeQmdMonaco",
		"setQmdModel",
		"setQmdDiff",
		"setQmdDiagnostics",
		"revealQmdRange",
		"clearQmdSelection",
		"showQmdSearch",
		"snapshotQmdView",
		"disposeQmdMonaco",
	]) {
		assert.match(html, new RegExp(`(?:function|window\\.)\\s*${method}`));
	}
});

test("QMD Monaco host provides save and context-sensitive Command-K bindings", async () => {
	let html = await readFile(hostPath, "utf8");
	assert.match(html, /KeyMod\.CtrlCmd\s*\|\s*monaco\.KeyCode\.KeyS/);
	assert.match(html, /KeyMod\.CtrlCmd\s*\|\s*monaco\.KeyCode\.KeyK/);
	assert.match(html, /command:\s*'save'/);
	assert.match(html, /'chat-selection'/);
	assert.match(html, /:\s*'ai'/);
});

test("QMD Monaco host publishes pointer activity without consuming editor input", async () => {
	let html = await readFile(hostPath, "utf8");
	assert.match(html, /type:\s*['"]pointer-activity['"]/);
	assert.match(html, /document\.addEventListener\(['"]pointerdown['"]/);
	assert.match(html, /document\.removeEventListener\(['"]pointerdown['"]/);
	assert.doesNotMatch(html, /qmdPointerActivity[\s\S]{0,300}preventDefault/);
	assert.doesNotMatch(html, /qmdPointerActivity[\s\S]{0,300}stopPropagation/);
});

test("QMD Monaco host boots in an always-light editing surface", async () => {
	let html = await readFile(hostPath, "utf8");
	assert.match(html, /color-scheme:\s*light/);
	assert.match(html, /theme:\s*'vs'/);
	assert.doesNotMatch(html, /theme:\s*'vs-dark'/);
});

test("QMD Monaco preserves the selected Draft's existing line-ending style", async () => {
	let html = await readFile(hostPath, "utf8");
	assert.match(html, /text\.includes\('\\r\\n'\)/);
	assert.match(html, /EndOfLineSequence\.CRLF/);
	assert.doesNotMatch(html, /model\.setEOL\(qmdMonaco\.editor\.EndOfLineSequence\.LF\);/);
});

async function executeMonacoHost({ selectionText = "", selectionStart = 0 } = {}) {
	const html = await readFile(hostPath, "utf8");
	const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
	const source = scripts.at(-1)[1]
		+ "\n;globalThis.__qmdHost = { loadQmdMonaco, subscribeQmdMonaco, setQmdModel, "
		+ "clearQmdSelection: typeof clearQmdSelection === 'function' ? clearQmdSelection : undefined, "
		+ "showQmdSearch: typeof showQmdSearch === 'function' ? showQmdSearch : undefined, disposeQmdMonaco };";
	let amdReady;
	let editors = 0;
	let revoked = [];
	let listeners = new Map();
	let commands = new Map();
	let changeListener;
	let cursorListener;
	let nextWorker = 0;
	const models = [];
	const optionUpdates = [];
	const languageUpdates = [];
	const selections = [];
	let searches = 0;
	let currentModel = null;
	let currentPosition = { lineNumber: 1, column: 1 };
	let currentSelectionText = selectionText;
	let currentSelectionStart = selectionStart;
	const selection = {
		getStartPosition: () => ({ offset: currentSelectionStart }),
		getEndPosition: () => ({ offset: currentSelectionStart + currentSelectionText.length }),
	};
	const activeModel = {
		getValueInRange: () => currentSelectionText,
		getOffsetAt: position => position.offset,
	};
	const editor = {
		dispose() {},
		onDidChangeModelContent(listener) { changeListener = listener; return { dispose() {} }; },
		onDidChangeCursorPosition(listener) { cursorListener = listener; return { dispose() {} }; },
		addCommand(keybinding, listener) { commands.set(keybinding, listener); },
		getModel: () => currentModel || activeModel,
		getSelection: () => selection,
		getValue: () => currentModel ? currentModel.getValue() : "",
		getPosition: () => currentPosition,
		setModel(model) { currentModel = model; },
		updateOptions(options) { optionUpdates.push({ ...options }); },
		deltaDecorations: () => [],
		setSelection(value) { selections.push(value); },
		setPosition(value) { currentPosition = value; },
		focus() {},
		layout() {},
		getAction(id) {
			return { run: async () => { if (id === "actions.find") searches++; } };
		},
	};
	function uri(value) {
		return { toString: () => value };
	}
	function createModel(text, language, modelURI) {
		let value = String(text);
		const model = {
			uri: modelURI,
			language,
			getValue: () => value,
			setValue(next) { value = String(next); },
			setEOL() {},
			getOffsetAt(position) { return Number(position.offset) || 0; },
			getPositionAt(offset) { return { lineNumber: 1, column: Number(offset) + 1 }; },
			getValueInRange: () => currentSelectionText,
			dispose() {},
		};
		models.push(model);
		return model;
	}
	const monaco = {
		KeyMod: { CtrlCmd: 1 },
		KeyCode: { KeyS: 1, KeyK: 2 },
		Range: class {
			constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
				Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
			}
		},
		languages: {
			CompletionItemInsertTextRule: { InsertAsSnippet: 1 },
			CompletionItemKind: { Reference: 1, Snippet: 2 },
			registerCompletionItemProvider: () => ({ dispose() {} }),
		},
		editor: {
			create() {
				editors++;
				return editor;
			},
			createModel,
			getModel(modelURI) {
				return models.find(model => model.uri.toString() === modelURI.toString()) || null;
			},
			setModelLanguage(model, language) {
				model.language = language;
				languageUpdates.push([model.uri.toString(), language]);
			},
			setModelMarkers() {},
			EndOfLineSequence: { CRLF: 1, LF: 2 },
			getModels: () => models,
		},
		Uri: { parse: uri },
		MarkerSeverity: { Warning: 1, Error: 2 },
	};
	const require = (_dependencies, ready) => { amdReady = ready; };
	require.config = () => {};
	const elements = new Map([
		["qmd-normal", { style: {} }],
		["qmd-diff", { style: {} }],
	]);
	const context = {
		Blob: class {},
		URL: {
			createObjectURL: () => `blob:qmd-worker-${++nextWorker}`,
			revokeObjectURL: value => revoked.push(value),
		},
		console,
		document: { getElementById: id => elements.get(id) },
		monaco,
		require,
		window: {
			addEventListener(type, listener) { listeners.set(type, listener); },
			removeEventListener(type, listener) {
				if (listeners.get(type) === listener) listeners.delete(type);
			},
		},
	};
	context.globalThis = context;
	runInNewContext(source, context, { filename: "qmdMonaco.inline.js" });
	return {
		api: context.__qmdHost,
		completeAMD: () => amdReady(),
		triggerCommand: keybinding => commands.get(keybinding)?.(),
		triggerChange: () => changeListener?.(),
		triggerCursor: position => cursorListener?.({ position }),
		setSelection(text, start = 0) {
			currentSelectionText = text;
			currentSelectionStart = start;
		},
		editors: () => editors,
		optionUpdates,
		languageUpdates,
		models,
		selections,
		searches: () => searches,
		revoked,
		listeners,
	};
}

test("one Monaco iframe explicitly resets readonly options in both directions", async () => {
	const host = await executeMonacoHost();
	const loading = host.api.loadQmdMonaco();
	host.completeAMD();
	await loading;

	await host.api.setQmdModel({
		uri: "inmemory://qlab/drafts/a.qmd",
		text: "draft",
		language: "markdown",
		options: { readOnly: false, domReadOnly: false },
	});
	await host.api.setQmdModel({
		uri: "inmemory://qlab/literature/paper.md",
		text: "evidence",
		language: "markdown",
		options: { readOnly: true, domReadOnly: true },
	});
	await host.api.setQmdModel({
		uri: "inmemory://qlab/drafts/a.qmd",
		text: "draft again",
		language: "markdown",
		options: { readOnly: false, domReadOnly: false },
	});

	assert.deepEqual(host.optionUpdates.map(options => [options.readOnly, options.domReadOnly]), [
		[false, false], [true, true], [false, false],
	]);
});

test("Monaco emits no write events before the first trusted document payload", async () => {
	const host = await executeMonacoHost();
	const events = [];
	host.api.subscribeQmdMonaco(event => events.push(JSON.parse(JSON.stringify(event))));
	const loading = host.api.loadQmdMonaco();
	host.completeAMD();
	await loading;
	events.length = 0;

	host.triggerChange();
	host.triggerCommand(1);
	host.setSelection("", 4);
	host.triggerCommand(3);
	assert.deepEqual(events, []);
});

test("readonly iframe suppresses change Save and empty Command-K but keeps cursor and selected Chat context", async () => {
	const host = await executeMonacoHost();
	const events = [];
	host.api.subscribeQmdMonaco(event => events.push(JSON.parse(JSON.stringify(event))));
	const loading = host.api.loadQmdMonaco();
	host.completeAMD();
	await loading;
	await host.api.setQmdModel({
		uri: "inmemory://qlab/literature/paper.md",
		generation: 17,
		text: "external evidence",
		language: "markdown",
		options: { readOnly: true, domReadOnly: true },
	});
	events.length = 0;

	host.triggerChange();
	host.triggerCommand(1);
	host.setSelection("", 4);
	host.triggerCommand(3);
	host.triggerCursor({ lineNumber: 1, column: 6, offset: 5 });
	assert.deepEqual(events.map(event => event.type), ["cursor"]);

	host.setSelection("exact evidence", 9);
	host.triggerCommand(3);
	assert.deepEqual(events.at(-1), {
		type: "command",
		command: "chat-selection",
		selection: "exact evidence",
		start: 9,
		end: 23,
		modelURI: "inmemory://qlab/literature/paper.md",
		modelGeneration: 17,
	});
});

test("Monaco stamps cursor and command events with the installed model URI and generation", async () => {
	const host = await executeMonacoHost();
	const events = [];
	host.api.subscribeQmdMonaco(event => events.push(JSON.parse(JSON.stringify(event))));
	const loading = host.api.loadQmdMonaco();
	host.completeAMD();
	await loading;
	await host.api.setQmdModel({
		uri: "inmemory://qlab/knowledge/topic.qmd",
		generation: 23,
		text: "exact knowledge",
		language: "markdown",
		options: { readOnly: true, domReadOnly: true },
	});
	events.length = 0;
	host.triggerCursor({ lineNumber: 1, column: 6, offset: 5 });
	host.setSelection("exact", 0);
	host.triggerCommand(3);
	assert.deepEqual(events.map(event => ({
		type: event.type,
		modelURI: event.modelURI,
		modelGeneration: event.modelGeneration,
	})), [
		{ type: "cursor", modelURI: "inmemory://qlab/knowledge/topic.qmd", modelGeneration: 23 },
		{ type: "command", modelURI: "inmemory://qlab/knowledge/topic.qmd", modelGeneration: 23 },
	]);
});

test("Monaco creates a real bibtex model, changes reused languages, clears selection, and opens citekey search", async () => {
	const host = await executeMonacoHost();
	const loading = host.api.loadQmdMonaco();
	host.completeAMD();
	await loading;
	const uri = "inmemory://qlab/literature/references.bib";
	await host.api.setQmdModel({
		uri,
		text: "@book{safe}",
		language: "bibtex",
		options: { readOnly: true, domReadOnly: true },
	});
	assert.equal(host.models.find(model => model.uri.toString() === uri).language, "bibtex");

	await host.api.setQmdModel({
		uri,
		text: "@book{safe2}",
		language: "markdown",
		options: { readOnly: true, domReadOnly: true },
	});
	assert.equal(host.models.find(model => model.uri.toString() === uri).language, "markdown");
	assert.deepEqual(host.languageUpdates.at(-1), [uri, "markdown"]);

	await host.api.clearQmdSelection();
	assert.ok(host.selections.length > 0);
	await host.api.showQmdSearch();
	assert.equal(host.searches(), 1);
});

test("Command-K routes an exact non-empty Monaco selection to Chat context", async () => {
	const exact = "  f(u,G,x) = F(V_r)\nwith preserved whitespace  ";
	const host = await executeMonacoHost({ selectionText: exact, selectionStart: 17 });
	const events = [];
	host.api.subscribeQmdMonaco(event => events.push(JSON.parse(JSON.stringify(event))));
	const loading = host.api.loadQmdMonaco();
	host.completeAMD();
	await loading;
	await host.api.setQmdModel({
		uri: "inmemory://qlab/knowledge/exact.qmd",
		generation: 31,
		text: exact,
		language: "markdown",
		options: { readOnly: true, domReadOnly: true },
	});
	events.length = 0;

	host.triggerCommand(3);

	assert.deepEqual(events.at(-1), {
		type: "command",
		command: "chat-selection",
		selection: exact,
		start: 17,
		end: 17 + exact.length,
		modelURI: "inmemory://qlab/knowledge/exact.qmd",
		modelGeneration: 31,
	});
});

test("Command-K retains inline AI writing when Monaco has no selection", async () => {
	const host = await executeMonacoHost({ selectionText: "", selectionStart: 29 });
	const events = [];
	host.api.subscribeQmdMonaco(event => events.push(JSON.parse(JSON.stringify(event))));
	const loading = host.api.loadQmdMonaco();
	host.completeAMD();
	await loading;
	await host.api.setQmdModel({
		uri: "inmemory://qlab/drafts/a.qmd",
		generation: 32,
		text: "editable Draft",
		language: "markdown",
		options: { readOnly: false, domReadOnly: false },
	});
	events.length = 0;

	host.triggerCommand(3);

	assert.deepEqual(events.at(-1), {
		type: "command",
		command: "ai",
		selection: "",
		start: 29,
		end: 29,
		modelURI: "inmemory://qlab/drafts/a.qmd",
		modelGeneration: 32,
	});
});

test("disposing during Monaco AMD initialization prevents a late editor and releases its worker URL", async () => {
	const host = await executeMonacoHost();
	const loading = host.api.loadQmdMonaco();
	host.api.disposeQmdMonaco();
	host.completeAMD();

	const result = await loading;
	assert.equal(result.disposed, true);
	assert.equal(await host.api.setQmdModel({
		uri: "inmemory://qlab/drafts/a.qmd",
		text: "late",
	}), false);
	assert.equal(host.editors(), 0);
	assert.deepEqual(host.revoked, ["blob:qmd-worker-1"]);
	assert.equal(host.listeners.has("resize"), false);
});

test("disposing a ready Monaco host removes resize ownership and revokes the worker URL once", async () => {
	const host = await executeMonacoHost();
	const loading = host.api.loadQmdMonaco();
	host.completeAMD();
	await loading;
	assert.equal(host.listeners.has("resize"), true);

	host.api.disposeQmdMonaco();
	host.api.disposeQmdMonaco();
	assert.equal(host.listeners.has("resize"), false);
	assert.deepEqual(host.revoked, ["blob:qmd-worker-1"]);
});
