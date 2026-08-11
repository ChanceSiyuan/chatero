import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";
import { createVerifiedReadonlySession } from "../lib/verified-readonly-session.mjs";

function fakeAdapter() {
	let receive;
	let calls = [];
	let installed = null;
	return {
		calls,
		onEvent(fn) {
			receive = fn;
			return () => { receive = null; };
		},
		emit(event) {
			let value = event && event.type !== "ready" && installed
				? {
					...event,
					modelURI: event.modelURI ?? installed.uri,
					modelGeneration: event.modelGeneration ?? installed.generation,
				}
				: event;
			receive(value);
		},
		setNormalModel(payload) { installed = payload; calls.push({ method: "normal", payload }); },
		setDiffModel(payload) { calls.push({ method: "diff", payload }); },
		setDiagnostics(payload) { calls.push({ method: "diagnostics", payload }); },
		revealRange(payload) { calls.push({ method: "reveal", payload }); },
		clearSelection() { calls.push({ method: "clear-selection" }); },
		showSearch() { calls.push({ method: "search" }); },
		dispose() { calls.push({ method: "dispose" }); },
	};
}

test("model URI is stable and contains no absolute workspace path", async () => {
	const QLab = await loadQLab();
	let uri = QLab.qmdMonacoModelURI("/Users/me/private", "drafts/a.qmd");
	assert.equal(uri, "inmemory://qlab/drafts/a.qmd");
	assert.equal(uri.includes("/Users/me/private"), false);
	assert.throws(
		() => QLab.qmdMonacoModelURI("/Users/me/private", "knowledge/a.qmd"),
		/drafts/i
	);
});

test("bridge converts editor changes into human Draft edits", async () => {
	const QLab = await loadQLab();
	let edits = [];
	let commands = [];
	let adapter = fakeAdapter();
	let session = {
		applyHumanEdit: text => edits.push(text),
		snapshot: () => ({ path: "drafts/a.qmd", text: "a", revision: "r1" }),
	};
	let bridge = QLab.createQmdMonacoBridge({
		adapter,
		session,
		language: text => ({ blocks: [], decorations: [{ kind: "math", start: 0, end: text.length }], diagnostics: [] }),
		onCommand: command => commands.push(command),
	});

	adapter.emit({ type: "ready" });
	adapter.emit({ type: "change", text: "b" });
	adapter.emit({ type: "command", command: "save" });
	assert.deepEqual(edits, ["b"]);
	assert.deepEqual(commands, ["save"]);
	assert.equal(adapter.calls[0].method, "normal");
	assert.equal(adapter.calls[0].payload.uri, "inmemory://qlab/drafts/a.qmd");
	bridge.dispose();
	assert.equal(adapter.calls.at(-1).method, "dispose");
});

test("bridge exposes proposed changes through a Monaco diff model", async () => {
	const QLab = await loadQLab();
	let adapter = fakeAdapter();
	let bridge = QLab.createQmdMonacoBridge({
		adapter,
		session: { snapshot: () => ({ path: "drafts/a.qmd", text: "original" }) },
		language: () => ({ blocks: [], decorations: [], diagnostics: [] }),
	});
	bridge.showDiff({ original: "original", proposed: "proposed" });
	let call = adapter.calls.find(item => item.method === "diff");
	assert.equal(call.payload.original.text, "original");
	assert.equal(call.payload.modified.text, "proposed");
	assert.match(call.payload.modified.uri, /\.proposed\.qmd$/);
});

test("Monaco options use QMD writing defaults", async () => {
	const QLab = await loadQLab();
	let options = QLab.qmdMonacoOptions();
	assert.equal(options.theme, "vs");
	assert.equal(options.wordWrap, "on");
	assert.equal(options.minimap.enabled, false);
	assert.equal(options.tabSize, 2);
	assert.equal(options.insertSpaces, true);
	assert.equal(options.accessibilitySupport, "auto");
	assert.equal(options.ariaLabel, "QMD source editor");
	assert.equal(options.readOnly, false);
	assert.equal(options.domReadOnly, false);
});

test("workspace document model URIs support classified readonly paths without leaking roots", async () => {
	const QLab = await loadQLab();
	for (const relativePath of [
		"knowledge/topic.qmd",
		"literature/paper.qmd",
		"literature/notes.md",
		"literature/references.bib",
	]) {
		const uri = QLab.qmdDocumentModelURI("/Users/me/private", relativePath);
		assert.equal(uri, `inmemory://qlab/${relativePath}`);
		assert.equal(uri.includes("/Users/me/private"), false);
	}
	assert.throws(() => QLab.qmdDocumentModelURI("", "literature/paper.pdf"), /unsupported/i);
	assert.throws(() => QLab.qmdDocumentModelURI("", "knowledge/../drafts/a.qmd"), /unsafe|unsupported/i);
});

test("readonly Monaco bridge suppresses edits, Save, diff, and selectionless AI but preserves cursor and Chat selection", async () => {
	const QLab = await loadQLab();
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/topic.qmd" });
	const session = await createVerifiedReadonlySession(QLab, {
		descriptor,
		text: "# Trusted\n",
	});
	const adapter = fakeAdapter();
	const commands = [];
	const cursors = [];
	const bridge = QLab.createQmdMonacoBridge({
		adapter,
		session,
		language: text => ({ decorations: [{ kind: "heading", start: 0, end: text.length }], diagnostics: [] }),
		onCommand: (command, event) => commands.push([command, event]),
		onCursor: event => cursors.push(event),
	});

	adapter.emit({ type: "ready" });
	const normal = adapter.calls.find(call => call.method === "normal").payload;
	assert.equal(normal.uri, "inmemory://qlab/knowledge/topic.qmd");
	assert.equal(normal.language, "markdown");
	assert.equal(normal.options.readOnly, true);
	assert.equal(normal.options.domReadOnly, true);
	assert.equal(normal.options.ariaLabel, "QMD source viewer");
	assert.deepEqual(Array.from(normal.completions), []);

	adapter.emit({ type: "change", text: "malicious edit" });
	adapter.emit({ type: "command", command: "save" });
	adapter.emit({ type: "command", command: "ai", selection: "", start: 2, end: 2 });
	adapter.emit({
		type: "command",
		command: "chat-selection",
		selection: "Trusted",
		start: 2,
		end: 9,
	});
	adapter.emit({ type: "cursor", offset: 7 });
	assert.equal(session.snapshot().text, "# Trusted\n");
	assert.deepEqual(commands.map(([command]) => command), ["chat-selection"]);
	assert.deepEqual(cursors, [{
		type: "cursor",
		offset: 7,
		modelURI: normal.uri,
		modelGeneration: normal.generation,
	}]);
	assert.equal(bridge.showDiff({ original: "old", proposed: "new" }), false);
	assert.equal(adapter.calls.some(call => call.method === "diff"), false);
});

test("BibTeX Monaco payload is source-only with a true bibtex language and citekey search", async () => {
	const QLab = await loadQLab();
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "literature/references.bib" });
	const adapter = fakeAdapter();
	const session = await createVerifiedReadonlySession(QLab, {
		descriptor,
		text: "@book{safe}\n",
	});
	const bridge = QLab.createQmdMonacoBridge({
		adapter,
		session,
		language: () => { throw new Error("BibTeX must not run QMD language analysis"); },
	});
	bridge.showNormal();
	const payload = adapter.calls.find(call => call.method === "normal").payload;
	assert.equal(payload.language, "bibtex");
	assert.equal(payload.options.readOnly, true);
	assert.equal(payload.options.ariaLabel, "BibTeX source viewer");
	assert.deepEqual(Array.from(payload.completions), []);
	assert.deepEqual(Array.from(payload.decorations), []);
	assert.deepEqual(Array.from(payload.diagnostics), []);
	assert.equal(bridge.showSearch(), true);
	assert.equal(adapter.calls.at(-1).method, "search");
});

test("reused Monaco bridge explicitly resets sticky readonly options and selection across document identities", async () => {
	const QLab = await loadQLab();
	const draft = QLab.createQmdDraftSession({
		path: "drafts/a.qmd",
		text: "draft",
		revision: "d1",
		onSave: async () => ({ revision: "d2" }),
	});
	const readonly = await createVerifiedReadonlySession(QLab, {
		descriptor: QLab.createWorkspaceDocumentDescriptor({ relativePath: "literature/paper.md" }),
		text: "evidence",
	});
	let current = draft;
	const proxy = {
		snapshot: () => current.snapshot(),
		applyHumanEdit: text => current.applyHumanEdit(text),
	};
	const adapter = fakeAdapter();
	const bridge = QLab.createQmdMonacoBridge({
		adapter,
		session: proxy,
		language: () => ({ decorations: [], diagnostics: [] }),
	});

	bridge.showNormal();
	current = readonly;
	bridge.showNormal();
	current = draft;
	bridge.showNormal();
	const normal = adapter.calls.filter(call => call.method === "normal");
	assert.deepEqual(normal.map(call => [
		call.payload.options.readOnly,
		call.payload.options.domReadOnly,
	]), [[false, false], [true, true], [false, false]]);
	assert.deepEqual(normal.map(call => call.payload.language), ["markdown", "markdown", "markdown"]);
	assert.deepEqual(normal.map(call => call.payload.options.ariaLabel), [
		"QMD source editor", "QMD source viewer", "QMD source editor",
	]);
	assert.equal(adapter.calls.filter(call => call.method === "clear-selection").length, 2);
});

test("stale Monaco model events cannot edit or label the newly active document", async () => {
	const QLab = await loadQLab();
	const draftA = QLab.createQmdDraftSession({
		path: "drafts/a.qmd",
		text: "alpha selection",
		revision: "a1",
		onSave: async () => ({ revision: "a2" }),
	});
	const draftB = QLab.createQmdDraftSession({
		path: "drafts/b.qmd",
		text: "beta selection",
		revision: "b1",
		onSave: async () => ({ revision: "b2" }),
	});
	let current = draftA;
	const adapter = fakeAdapter();
	const commands = [];
	const cursors = [];
	const bridge = QLab.createQmdMonacoBridge({
		adapter,
		session: {
			snapshot: () => current.snapshot(),
			applyHumanEdit: text => current.applyHumanEdit(text),
		},
		language: () => ({ decorations: [], diagnostics: [] }),
		onCommand: (command, event) => commands.push([command, event]),
		onCursor: event => cursors.push(event),
	});
	bridge.showNormal();
	const identityA = adapter.calls.find(call => call.method === "normal").payload;
	current = draftB;
	bridge.showNormal();
	const identityB = adapter.calls.filter(call => call.method === "normal").at(-1).payload;
	assert.notEqual(identityA.uri, identityB.uri);
	assert.notEqual(identityA.generation, identityB.generation);

	adapter.emit({
		type: "change",
		text: "stale A bytes",
		modelURI: identityA.uri,
		modelGeneration: identityA.generation,
	});
	adapter.emit({
		type: "command",
		command: "chat-selection",
		selection: "alpha",
		start: 0,
		end: 5,
		modelURI: identityA.uri,
		modelGeneration: identityA.generation,
	});
	adapter.emit({
		type: "cursor",
		offset: 3,
		modelURI: identityA.uri,
		modelGeneration: identityA.generation,
	});
	assert.equal(draftB.snapshot().text, "beta selection");
	assert.deepEqual(commands, []);
	assert.deepEqual(cursors, []);

	adapter.emit({
		type: "command",
		command: "chat-selection",
		selection: "beta",
		start: 0,
		end: 4,
		modelURI: identityB.uri,
		modelGeneration: identityB.generation,
	});
	assert.deepEqual(commands.map(([command]) => command), ["chat-selection"]);
});

test("clearing Monaco installs an inert read-only no-document model", async () => {
	const QLab = await loadQLab();
	const adapter = fakeAdapter();
	const edits = [];
	const commands = [];
	const bridge = QLab.createQmdMonacoBridge({
		adapter,
		session: {
			snapshot: () => ({ path: "drafts/a.qmd", text: "draft", revision: "r1" }),
			applyHumanEdit: text => edits.push(text),
		},
		language: () => ({ decorations: [], diagnostics: [] }),
		onCommand: command => commands.push(command),
	});
	bridge.showNormal();

	assert.equal(bridge.clear(), true);
	const empty = adapter.calls.filter(call => call.method === "normal").at(-1).payload;
	assert.equal(empty.uri, "inmemory://qlab/no-document");
	assert.equal(empty.text, "");
	assert.equal(empty.options.readOnly, true);
	assert.equal(empty.options.domReadOnly, true);
	assert.equal(empty.options.ariaLabel, "No workspace document");
	assert.equal(adapter.calls.at(-1).method, "clear-selection");

	adapter.emit({ type: "change", text: "stale edit" });
	adapter.emit({ type: "command", command: "save" });
	assert.deepEqual(edits, []);
	assert.deepEqual(commands, []);
});
