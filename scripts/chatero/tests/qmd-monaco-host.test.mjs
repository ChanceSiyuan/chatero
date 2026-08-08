import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

test("QMD Monaco host boots in an always-light editing surface", async () => {
	let html = await readFile(hostPath, "utf8");
	assert.match(html, /color-scheme:\s*light/);
	assert.match(html, /theme:\s*'vs'/);
	assert.doesNotMatch(html, /theme:\s*'vs-dark'/);
});
