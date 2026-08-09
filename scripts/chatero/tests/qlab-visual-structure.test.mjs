import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

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
	assert.match(xul, /data-qlab-chat-pin[^>]*aria-label="Pin Chat"/);
	assert.match(xul, /data-qlab-chat-hide[^>]*aria-label="Hide Chat"/);
	assert.match(xul, /data-qlab-chat-resize[^>]*aria-label="Resize Chat"/);

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
