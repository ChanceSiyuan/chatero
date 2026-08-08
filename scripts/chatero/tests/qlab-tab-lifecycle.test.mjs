import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const tabsSource = await readFile("chrome/content/zotero/tabs.js", "utf8");
const moduleSource = await readFile("chrome/content/zotero/xpcom/qlab/qlabModule.js", "utf8");

test("every native QLab tab receives container-scoped workspace disposal", () => {
	assert.match(
		tabsSource,
		/!tab\.onClose[\s\S]*SHELL_TAB_TYPES\.includes\(type\)[\s\S]*cancelShellTabMount\(container\)[\s\S]*container\.querySelector\('\.qlab-shell-host'\)[\s\S]*_qlabQmdWorkspace\?\.dispose\(\)/,
	);
});

test("new QLab tab close handlers capture their container instead of global document", () => {
	const ensureShellTab = moduleSource.slice(
		moduleSource.indexOf("ensureShellTab(kind, payload)"),
		moduleSource.indexOf("dockShellTab(kind, role, payload)"),
	);
	assert.match(ensureShellTab, /cancelShellTabMount\(shellContainer\)/);
	assert.match(ensureShellTab, /shellContainer\?\.querySelector\('\.qlab-shell-host'\)/);
	assert.doesNotMatch(ensureShellTab, /typeof document|document\.getElementById/);
});
