import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const qlabRoot = join(root, "chrome/content/zotero/xpcom/qlab");

test("reader toolbar uses icon-only buttons aligned with the XPI", async () => {
	const hooks = await readFile(join(qlabRoot, "readerHooks.js"), "utf8");
	const icons = await readFile(join(qlabRoot, "readerIcons.js"), "utf8");

	assert.match(hooks, /makeIconButton/);
	assert.match(hooks, /ReaderIcons/);
	assert.match(hooks, /createElement\('img'\)/);
	assert.doesNotMatch(hooks, /label:\s*['"]Chat['"]/);
	assert.doesNotMatch(hooks, /label:\s*['"]QMD['"]/);
	assert.doesNotMatch(hooks, /label:\s*['"]Desk['"]/);
	assert.doesNotMatch(hooks, /label:\s*['"]⌘L['"]/);
	assert.doesNotMatch(hooks, /label:\s*['"]Quote/);

	assert.match(icons, /ReaderIcons/);
	assert.match(icons, /chat:/);
	assert.match(icons, /editorSplit:/);
	assert.match(icons, /desk:/);
	assert.match(icons, /quote:/);
});

test("reader icons are inlined SVG data URLs", async () => {
	const icons = await readFile(join(qlabRoot, "readerIcons.js"), "utf8");
	assert.match(icons, /svgDataUrl/);
	assert.match(icons, /encodeURIComponent/);
	assert.match(icons, /return 'data:image\/svg\+xml,'/);
});
