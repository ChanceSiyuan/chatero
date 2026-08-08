import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const qlabRoot = new URL("../../../chrome/content/zotero/xpcom/qlab/", import.meta.url);

test("QLab shell parses fragments as HTML before importing into XUL", async () => {
	let moduleSource = await readFile(new URL("qlabModule.js", qlabRoot), "utf8");
	assert.match(moduleSource, /parseFromString\(String\(html \|\| ''\), 'text\/html'\)/);
	assert.match(moduleSource, /doc\.importNode\(child, true\)/);
});

test("QLab renderers never assign HTML strings directly in the XUL document", async () => {
	for (let file of [
		"chatComposerContext.js",
		"qlabModule.js",
		"qmdSurface.js",
	]) {
		let source = await readFile(new URL(file, qlabRoot), "utf8");
		assert.doesNotMatch(source, /\.innerHTML\s*=/, file);
	}
});
