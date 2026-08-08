import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("buildChatTranscriptPrompt frames bounded turns and drops trailing assistant", async () => {
	const QLab = await loadQLab();
	const prompt = QLab.buildChatTranscriptPrompt([
		{ role: "user", text: "one" },
		{ role: "assistant", text: "a1" },
		{ role: "user", text: "two" },
		{ role: "assistant", text: "" },
	], { maxTurns: 8, excludeTrailingAssistant: true });
	assert.match(prompt, /<chat_transcript>/);
	assert.match(prompt, /user: one/);
	assert.match(prompt, /assistant: a1/);
	assert.match(prompt, /user: two/);
	assert.ok(!prompt.includes("assistant: \n") && !/assistant:\s*$/m.test(prompt.split("</chat_transcript>")[0]));
});

test("buildChatTranscriptPrompt respects maxTurns window", async () => {
	const QLab = await loadQLab();
	const messages = [];
	for (let i = 0; i < 6; i++) {
		messages.push({ role: "user", text: `u${i}` });
		messages.push({ role: "assistant", text: `a${i}` });
	}
	const prompt = QLab.buildChatTranscriptPrompt(messages, {
		maxTurns: 2,
		excludeTrailingAssistant: false,
	});
	assert.ok(!prompt.includes("user: u0"));
	assert.ok(prompt.includes("user: u4"));
	assert.ok(prompt.includes("user: u5"));
	assert.ok(prompt.includes("assistant: a5"));
});

test("createCancelToken fires hooks once and marks cancelled", async () => {
	const QLab = await loadQLab();
	const token = QLab.createCancelToken();
	let hits = 0;
	token.onCancel(() => {
		hits += 1;
	});
	assert.equal(token.cancelled, false);
	token.cancel();
	token.cancel();
	assert.equal(token.cancelled, true);
	assert.equal(hits, 1);
	let late = 0;
	token.onCancel(() => {
		late += 1;
	});
	assert.equal(late, 1);
});

test("AgentRuntime.startTurn exposes cancel that yields cancelled done", async () => {
	const QLab = await loadQLab();
	const registry = new QLab.AgentProviderRegistry([]);
	registry.register({
		id: "slow",
		label: "Slow",
		kind: "test",
		status: "ready",
		capabilities: { streaming: true },
		async *startTurn(_turn, _prompt, { cancelToken } = {}) {
			yield { type: "text-delta", text: "partial" };
			await new Promise((resolve) => {
				cancelToken.onCancel(resolve);
				setTimeout(resolve, 200);
			});
			if (cancelToken.cancelled) {
				yield { type: "done", status: "cancelled" };
				return;
			}
			yield { type: "text-delta", text: " more" };
			yield { type: "done", status: "ok" };
		},
	});
	const runtime = new QLab.AgentRuntime({
		registry,
		defaultProviderId: "slow",
	});
	const turn = runtime.startTurn({ mode: "ask", prompt: "x" });
	const events = [];
	const consume = (async () => {
		for await (const event of turn) {
			events.push(event);
			if (event.type === "text-delta") {
				turn.cancel();
			}
		}
	})();
	await consume;
	assert.ok(events.some((e) => e.type === "text-delta" && e.text === "partial"));
	assert.equal(events.at(-1).type, "done");
	assert.equal(events.at(-1).status, "cancelled");
});

test("chat shell HTML exposes new chat, stop, model, and mode controls", async () => {
	const QLab = await loadQLab();
	const html = QLab.renderShellHTML({
		kind: "qlabchat",
		workspaceState: "ready",
		root: "/tmp/ws",
	});
	assert.match(html, /data-qlab-new-chat/);
	assert.match(html, /data-qlab-regenerate/);
	assert.match(html, /data-qlab-stop/);
	assert.match(html, /data-qlab-model/);
	assert.match(html, /data-qlab-chat-mode/);
	assert.match(html, /data-qlab-at-picker/);
});
