import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

function fakeAdapter() {
	let receive;
	let calls = [];
	return {
		calls,
		onEvent(fn) {
			receive = fn;
			return () => { receive = null; };
		},
		emit(event) {
			receive(event);
		},
		setNormalModel(payload) { calls.push({ method: "normal", payload }); },
		setDiffModel(payload) { calls.push({ method: "diff", payload }); },
		setDiagnostics(payload) { calls.push({ method: "diagnostics", payload }); },
		revealRange(payload) { calls.push({ method: "reveal", payload }); },
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
});
