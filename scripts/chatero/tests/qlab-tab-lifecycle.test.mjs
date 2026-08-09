import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const tabsSource = await readFile("chrome/content/zotero/tabs.js", "utf8");
const moduleSource = await readFile("chrome/content/zotero/xpcom/qlab/qlabModule.js", "utf8");
const paneSource = await readFile("chrome/content/zotero/zoteroPane.js", "utf8");

async function exercisePaneStartupRestore({ qlab, state }) {
	const start = paneSource.indexOf("\t\t// Restore pane state");
	const end = paneSource.indexOf("\t\taddFocusHandlers();", start);
	assert.notEqual(start, -1, "zoteroPane restore block must remain discoverable");
	assert.notEqual(end, -1, "zoteroPane restore block must remain bounded");
	const restoreBlock = paneSource.slice(start, end);
	const restored = [];
	const errors = [];
	const stateTabs = state.tabs;
	const context = {
		Zotero: {
			QLab: qlab,
			Session: { state: { windows: [state] } },
			logError: error => errors.push(error),
		},
		Zotero_Tabs: {
			restoreState: async tabs => restored.push(tabs),
		},
	};
	runInNewContext(
		`globalThis.__restorePaneTabs = async function () {${restoreBlock}\n};`,
		context,
	);
	await context.__restorePaneTabs();
	return { errors, restored, stateTabs };
}

function loadNativeTabsWithoutQLab() {
	const assignments = [
		tabsSource.slice(
			tabsSource.indexOf("this.close = function"),
			tabsSource.indexOf("this.closeAll = function"),
		),
		tabsSource.slice(
			tabsSource.indexOf("this.selectPrev = function"),
			tabsSource.indexOf("this.selectNext = function"),
		),
		tabsSource.slice(
			tabsSource.indexOf("this.selectNext = function"),
			tabsSource.indexOf("this.selectLast = function"),
		),
	].join("\n");
	const context = {
		document: { getElementById: () => null },
		setTimeout() {},
		Zotero: {
			QLab: null,
			Notifier: { trigger() {} },
		},
	};
	runInNewContext(
		`globalThis.__tabs = {}; (function () { ${assignments} }).call(globalThis.__tabs);`,
		context,
	);
	const tabs = context.__tabs;
	tabs._getTab = function (id) {
		const tabIndex = this._tabs.findIndex(tab => tab.id === id);
		return { tab: this._tabs[tabIndex], tabIndex };
	};
	tabs._history = [];
	tabs.tabsMenuPanel = { visible: false };
	tabs._update = () => {};
	tabs._applySplitVisibility = () => {};
	return tabs;
}

test("every docked QLab tab receives container-scoped workspace disposal", () => {
	assert.match(
		tabsSource,
		/!tab\.onClose[\s\S]*type !== 'qlabchat'[\s\S]*SHELL_TAB_TYPES\.includes\(type\)[\s\S]*cancelShellTabMount\(container\)[\s\S]*container\.querySelector\('\.qlab-shell-host'\)[\s\S]*_qlabQmdWorkspace\?\.dispose\(\)/,
	);
});

test("new docked QLab tab close handlers capture their container instead of global document", () => {
	const ensureShellTab = moduleSource.slice(
		moduleSource.indexOf("ensureShellTab(kind, payload)"),
		moduleSource.indexOf("dockShellTab(kind, role, payload)"),
	);
	assert.match(ensureShellTab, /cancelShellTabMount\(shellContainer\)/);
	assert.match(ensureShellTab, /shellContainer\?\.querySelector\('\.qlab-shell-host'\)/);
	assert.doesNotMatch(ensureShellTab, /typeof document|document\.getElementById/);
});

test("Chat launcher close never cancels or removes the window-owned shell", () => {
	const closeSource = tabsSource.slice(
		tabsSource.indexOf("this.close = function"),
		tabsSource.indexOf("this.closeAll = function"),
	);
	assert.match(closeSource, /isChatUtilityTab\(tab\)/);
	assert.match(closeSource, /closeUtilityLauncher/);
	assert.doesNotMatch(closeSource, /cancelShellTabMount/);
});

test("native close and adjacent-tab algorithms remain available without QLab helpers", () => {
	const closeSource = tabsSource.slice(
		tabsSource.indexOf("this.close = function"),
		tabsSource.indexOf("this.closeAll = function"),
	);
	assert.match(
		closeSource,
		/contentTabAfterClose[\s\S]*else[\s\S]*_prevSelectedID[\s\S]*slice\(tabIndex \+ 1\)[\s\S]*slice\(0, tabIndex\)\.reverse\(\)/,
	);
	const previousSource = tabsSource.slice(
		tabsSource.indexOf("this.selectPrev = function"),
		tabsSource.indexOf("this.selectNext = function"),
	);
	assert.match(previousSource, /nextContentTabID[\s\S]*else[\s\S]*this\._tabs\[tabIndex - 1\]/);
	const nextSource = tabsSource.slice(
		tabsSource.indexOf("this.selectNext = function"),
		tabsSource.indexOf("this.selectLast = function"),
	);
	assert.match(nextSource, /nextContentTabID[\s\S]*else[\s\S]*this\._tabs\[tabIndex \+ 1\]/);

	const tabs = loadNativeTabsWithoutQLab();
	tabs._tabs = [
		{ id: "zotero-pane", type: "library", data: {} },
		{ id: "reader-a", type: "reader", data: {} },
		{ id: "reader-b", type: "reader", data: {} },
	];
	const selected = [];
	tabs.select = id => {
		tabs._selectedID = id;
		selected.push(id);
	};
	tabs._selectedID = "reader-a";
	tabs._prevSelectedID = null;
	tabs.close("reader-a");
	assert.equal(selected.at(-1), "reader-b");
	assert.deepEqual(tabs._tabs.map(tab => tab.id), ["zotero-pane", "reader-b"]);

	tabs._tabs = [
		{ id: "zotero-pane", type: "library", data: {} },
		{ id: "reader-a", type: "reader", data: {} },
		{ id: "reader-b", type: "reader", data: {} },
	];
	tabs._selectedID = "reader-a";
	tabs.selectPrev();
	assert.equal(selected.at(-1), "zotero-pane");
	tabs._selectedID = "reader-a";
	tabs.selectNext();
	assert.equal(selected.at(-1), "reader-b");
});

test("arrangement and legacy dock entry points defer focus capture to the utility host", () => {
	const controller = moduleSource.slice(
		moduleSource.indexOf("dockShellTab(kind, role, payload)"),
		moduleSource.indexOf("async arrangePDFChat"),
	);
	assert.match(controller, /dock-shell-tab[\s\S]*focusComposer:\s*true/);
	assert.doesNotMatch(controller, /dock-shell-tab[^}]*focusReturn/);
	const showUtility = controller.slice(controller.indexOf("showUtility(kind"));
	assert.doesNotMatch(showUtility, /focusReturn:\s*options\.focusReturn \|\| null/);
});

test("window session state owns Chat Pin and bounds alongside QLab groups", () => {
	const getState = paneSource.slice(
		paneSource.indexOf("this.getState = function"),
		paneSource.indexOf("this._qlabActiveAttachmentID = function"),
	);
	assert.match(getState, /getQLabChatPresentationState/);
	assert.match(getState, /state\.qlabChatPresentation = chatPresentation/);
	assert.doesNotMatch(moduleSource, /qlab\.chatUtilityPresentation/);
});

test("pane startup restores native tabs when the QLab restore helper is unavailable", async () => {
	const result = await exercisePaneStartupRestore({
		qlab: {},
		state: {
			type: "pane",
			tabs: [{ type: "reader", data: { itemID: 42 } }],
		},
	});
	assert.equal(result.restored.length, 1);
	assert.equal(result.restored[0], result.stateTabs);
});

test("pane startup falls back to native restore when the QLab helper throws before restore", async () => {
	const failure = new Error("QLab restore unavailable during startup");
	const result = await exercisePaneStartupRestore({
		qlab: {
			restoreNativeAndQLabTabState: async () => {
				throw failure;
			},
		},
		state: {
			type: "pane",
			tabs: [{ type: "reader", data: { itemID: 7 } }],
		},
	});
	assert.equal(result.restored.length, 1);
	assert.equal(result.restored[0], result.stateTabs);
	assert.equal(result.errors.includes(failure), true);
});

test("pane startup does not repeat native restore after the QLab helper takes ownership", async () => {
	const failure = new Error("QLab group restore failed after native tabs were restored");
	let receivedOwnershipContract = false;
	const result = await exercisePaneStartupRestore({
		qlab: {
			restoreNativeAndQLabTabState: async (tabsAPI, state, progress) => {
				if (typeof progress?.claimNativeRestore === "function") {
					receivedOwnershipContract = true;
					progress.claimNativeRestore();
				}
				await tabsAPI.restoreState(state.tabs);
				throw failure;
			},
		},
		state: {
			type: "pane",
			tabs: [{ type: "reader", data: { itemID: 9 } }],
		},
	});
	assert.equal(receivedOwnershipContract, true);
	assert.equal(result.restored.length, 1, "native Reader restore must not be retried");
	assert.equal(result.restored[0], result.stateTabs);
	assert.equal(result.errors.includes(failure), true);
});
