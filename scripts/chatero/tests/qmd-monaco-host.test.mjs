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
		"snapshotQmdView",
		"disposeQmdMonaco",
	]) {
		assert.match(html, new RegExp(`(?:function|window\\.)\\s*${method}`));
	}
});

test("QMD Monaco host provides save and AI keyboard commands", async () => {
	let html = await readFile(hostPath, "utf8");
	assert.match(html, /KeyMod\.CtrlCmd\s*\|\s*monaco\.KeyCode\.KeyS/);
	assert.match(html, /KeyMod\.CtrlCmd\s*\|\s*monaco\.KeyCode\.KeyK/);
	assert.match(html, /command:\s*'save'/);
	assert.match(html, /command:\s*'ai'/);
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

async function executeMonacoHost() {
	const html = await readFile(hostPath, "utf8");
	const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
	const source = scripts.at(-1)[1]
		+ "\n;globalThis.__qmdHost = { loadQmdMonaco, setQmdModel, disposeQmdMonaco };";
	let amdReady;
	let editors = 0;
	let revoked = [];
	let listeners = new Map();
	let nextWorker = 0;
	const models = [];
	const editor = {
		dispose() {},
		onDidChangeModelContent: () => ({ dispose() {} }),
		onDidChangeCursorPosition: () => ({ dispose() {} }),
		addCommand() {},
	};
	const monaco = {
		KeyMod: { CtrlCmd: 1 },
		KeyCode: { KeyS: 1, KeyK: 2 },
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
			getModels: () => models,
		},
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
		editors: () => editors,
		revoked,
		listeners,
	};
}

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
