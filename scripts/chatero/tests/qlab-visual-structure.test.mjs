import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as sass from "sass";
import { loadQLab } from "../lib/load-qlab.mjs";

let mainWindowStyles;
function compiledMainWindowStyles() {
	mainWindowStyles ||= sass.compile(
		fileURLToPath(new URL("../../../scss/zotero-mac.scss", import.meta.url)),
		{ style: "expanded" },
	).css;
	return mainWindowStyles;
}

test("chat shell exposes XPI-style topbar and composer footer", async () => {
	const QLab = await loadQLab();
	const html = QLab.renderShellHTML({
		kind: "qlabchat",
		workspaceState: "ready",
		root: "/tmp/ws",
	});
	assert.match(html, /qlab-chat-topbar/);
	assert.match(html, /qlab-shell-identity/);
	assert.match(html, /qlab-workspace-strip/);
	assert.match(html, /qlab-shell-composer-footer/);
	assert.match(html, /qlab-send-button/);
	assert.match(html, /qlab-control-icon/);
});

test("QMD shell exposes Explorer, Monaco, Quarto Preview, and Draft authority", async () => {
	const QLab = await loadQLab();
	const html = QLab.renderShellHTML({
		kind: "qlabqmd",
		workspaceState: "ready",
		root: "/tmp/ws",
		drafts: ["drafts/alpha.qmd", "drafts/beta.qmd"],
	});
	assert.match(html, /qlab-qmd-toolbar/);
	assert.match(html, /data-qlab-file-column/);
	assert.match(html, /data-qlab-draft-row="drafts\/alpha\.qmd"/);
	assert.match(html, /data-qlab-draft-path/);
	assert.match(html, /data-qlab-qmd-explorer/);
	assert.match(html, /data-qlab-qmd-monaco/);
	assert.match(html, /data-qlab-qmd-preview/);
	assert.match(html, /Human edits autosave · AI changes require Keep/);
});

test("QLab visual tokens include light and dark XPI palette", async () => {
	const source = await readFile(
		new URL("../../../scss/components/_qlabShell.scss", import.meta.url),
		"utf8",
	);
	for (const token of [
		"--zc-accent",
		"--zc-bg-raised",
		"--zc-bg-subtle",
		"--zc-border",
		"--zc-text",
		"--zc-muted",
		"--zc-danger",
		"--zc-warning",
		"--zc-success",
		"--zc-shadow",
	]) {
		assert.match(source, new RegExp(token));
	}
	assert.match(source, /prefers-color-scheme:\s*dark/);
	assert.match(source, /\.qlab-qmd-file-column/);
	assert.match(source, /\.qlab-shell-composer-footer/);
	const workspaceSource = await readFile(
		new URL("../../../scss/components/_qlabQmdWorkspace.scss", import.meta.url),
		"utf8",
	);
	assert.match(workspaceSource, /\.qlab-qmd-workspace-main/);
	assert.match(workspaceSource, /\.qlab-qmd-monaco-frame/);
	assert.match(workspaceSource, /\.qlab-qmd-preview-stage/);
	assert.match(workspaceSource, /\.qlab-qmd-preview-quick/);
	assert.match(workspaceSource, /\.qlab-qmd-preview-browser-host/);
});

test("the main XUL window loads KaTeX styling before Visual Edit mounts", async () => {
	const source = await readFile(
		new URL("../../../chrome/content/zotero/zoteroPane.xhtml", import.meta.url),
		"utf8",
	);
	assert.match(
		source,
		/<\?xml-stylesheet href="resource:\/\/zotero\/katex\.min\.css" type="text\/css"\?>/,
	);
});

test("the main window owns one accessible non-modal Chat utility surface", async () => {
	const xul = await readFile(
		new URL("../../../chrome/content/zotero/zoteroPane.xhtml", import.meta.url),
		"utf8",
	);
	assert.match(xul, /id="qlab-chat-utility-layer"/);
	assert.match(xul, /data-qlab-chat-utility/);
	assert.match(xul, /role="dialog"/);
	assert.match(xul, /aria-modal="false"/);
	assert.match(xul, /data-qlab-chat-drag-handle/);
	assert.match(xul, /data-l10n-id="qlab-chat-title"/);
	assert.match(xul, /data-l10n-id="qlab-chat-window-controls"/);
	assert.match(xul, /data-qlab-chat-pin[^>]*data-l10n-id="qlab-chat-pin"/);
	assert.match(xul, /data-qlab-chat-hide[^>]*data-l10n-id="qlab-chat-hide"/);
	assert.match(xul, /data-qlab-chat-resize[^>]*data-l10n-id="qlab-chat-resize"/);
	assert.doesNotMatch(xul, /aria-label="(?:Pin|Hide|Resize) Chat"/);
	const tabBar = await readFile(
		new URL("../../../chrome/content/zotero/components/tabBar.jsx", import.meta.url),
		"utf8",
	);
	assert.match(tabBar, /data-l10n-id=\{utility \? `qlab-chat-launcher-\$\{activityStatus \|\| 'idle'\}`/);
	assert.doesNotMatch(tabBar, /aria-label=\{utility \? `\$\{title\}/);

	const fluent = await readFile(
		new URL("../../../chrome/locale/en-US/zotero/zotero.ftl", import.meta.url),
		"utf8",
	);
	for (const id of [
		"qlab-chat-title",
		"qlab-chat-window-controls",
		"qlab-chat-pin",
		"qlab-chat-unpin",
		"qlab-chat-hide",
		"qlab-chat-resize",
		"qlab-chat-launcher-idle",
		"qlab-chat-launcher-running",
		"qlab-chat-launcher-completed",
		"qlab-chat-launcher-error",
	]) {
		assert.match(fluent, new RegExp(`^${id}\\s*=`, "m"));
	}

	const styles = await readFile(
		new URL("../../../scss/components/_qlabChatUtility.scss", import.meta.url),
		"utf8",
	);
	assert.match(styles, /\.qlab-chat-utility-layer/);
	assert.match(styles, /\.qlab-chat-utility-dialog/);
	assert.match(styles, /color-scheme:\s*light/);
	assert.match(styles, /prefers-reduced-motion:\s*reduce/);
	assert.match(styles, /data-activity-status="running"/);
	assert.match(styles, /data-activity-status="completed"/);
	assert.match(styles, /data-activity-status="error"/);
});

test("the visible Chat utility layer is exempt from the inactive tab subtree cascade", () => {
	const styles = compiledMainWindowStyles();
	assert.match(
		styles,
		/#tabs-deck\s*>\s*\.qlab-chat-utility-layer\s*\{[^}]*-moz-subtree-hidden-only-visually:\s*0\s*!important;/s,
		"the window-owned Chat layer must remain paintable when its hidden attribute is removed",
	);
});

test("the completed-response unread indicator is blue", () => {
	const styles = compiledMainWindowStyles();
	assert.match(
		styles,
		/\.tab\.qlab-utility-launcher\[data-activity-status=completed\]\s+\.qlab-tab-activity\s*\{[^}]*background:\s*#007aff;/s,
	);
});
