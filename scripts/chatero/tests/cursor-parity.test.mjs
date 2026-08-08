import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadQLab } from "../lib/load-qlab.mjs";

test("buildChatTranscriptPrompt respects char budget", async () => {
	const QLab = await loadQLab();
	let messages = [];
	for (let i = 0; i < 20; i++) {
		messages.push({ role: "user", text: `question ${i} ${"x".repeat(200)}` });
		messages.push({ role: "assistant", text: `answer ${i} ${"y".repeat(200)}` });
	}
	let prompt = QLab.buildChatTranscriptPrompt(messages, {
		maxTurns: 20,
		maxChars: 500,
	});
	assert.match(prompt, /<chat_transcript>/);
	assert.ok(prompt.length <= 600);
});

test("evaluateApproval policy allow and deny", async () => {
	const QLab = await loadQLab();
	let policy = {
		defaultAction: "ask",
		allow: ["workspace_read"],
		deny: ["rm -rf"],
	};
	assert.equal(QLab.evaluateApproval(policy, { tool: "workspace_read" }), "allow");
	assert.equal(QLab.evaluateApproval(policy, { reason: "rm -rf home" }), "deny");
	assert.equal(QLab.evaluateApproval(policy, { tool: "shell" }), "ask");
});

test("chat thread snapshot round-trip", async () => {
	const QLab = await loadQLab();
	let host = {
		_qlabThreadId: "thread-a",
		_qlabMessages: [{ id: "1", role: "user", text: "hi", status: "" }],
	};
	QLab.ChatComposerContext.add({
		kind: "pdf-paper",
		label: "Paper",
		text: "body",
	});
	let snap = QLab.snapshotChatHost(host);
	assert.equal(snap.threadId, "thread-a");
	assert.equal(snap.messages.length, 1);
	assert.equal(snap.tags.length, 1);
	let host2 = { _qlabMessages: [] };
	QLab.hydrateChatHost(host2, snap);
	assert.equal(host2._qlabThreadId, "thread-a");
	assert.equal(host2._qlabMessages[0].text, "hi");
	assert.equal(QLab.ChatComposerContext.list().length, 1);
	QLab.ChatComposerContext.clear();
});

test("workspace search finds draft content", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-ws-"));
	await mkdir(join(root, "drafts"), { recursive: true });
	await writeFile(
		join(root, "drafts", "note.qmd"),
		"# UniqueTheorem\n\nLet MWIS be hard.\n"
	);
	const fs = await import("node:fs/promises");
	const path = await import("node:path");
	const host = QLab.QmdDraftIO.createNodeHost(fs, path);
	let hits = await QLab.searchWorkspaceForComposer(root, "UniqueTheorem", {
		host,
		maxResults: 4,
	});
	assert.ok(hits.length >= 1);
	assert.match(hits[0].relativePath, /drafts\/note\.qmd/);
});

test("formatQmdPendingDiffHTML shows before and after", async () => {
	const QLab = await loadQLab();
	let html = QLab.formatQmdPendingDiffHTML({
		previousOuterText: "old text",
		outerText: "new text",
	});
	assert.match(html, /Before/);
	assert.match(html, /After/);
	assert.match(html, /old text/);
	assert.match(html, /new text/);
});

test("suggestQmdCompletion returns snippet on empty line", async () => {
	const QLab = await loadQLab();
	let suggestion = QLab.suggestQmdCompletion("line one\n\n", 10);
	assert.ok(suggestion.length > 0);
});
