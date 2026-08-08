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

test("QMD shell exposes file column, toolbar, and three native modes", async () => {
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
	assert.match(html, /data-qlab-mode="visual"/);
	assert.match(html, /data-qlab-mode="website"/);
	assert.match(html, /data-qlab-mode="source"/);
	assert.match(html, /Human: Save · AI: Keep/);
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
});
