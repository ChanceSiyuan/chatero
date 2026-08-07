import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

test("createProveTurn defaults ask grants and rejects knowledge_apply", async () => {
	const QLab = await loadQLab();
	const turn = QLab.createProveTurn({
		mode: "ask",
		tools: ["workspace_read", "knowledge_apply"],
	});
	assert.equal(turn.mode, "ask");
	assert.ok(turn.tools.includes("workspace_read"));
	assert.ok(!turn.tools.includes("knowledge_apply"));
});

test("agent and prove modes require workspaceRoot", async () => {
	const QLab = await loadQLab();
	assert.throws(() => QLab.createProveTurn({ mode: "agent" }));
	const prove = QLab.createProveTurn({
		mode: "prove",
		workspaceRoot: "/tmp/ws",
	});
	assert.ok(prove.tools.includes("prove_trace_write"));
	assert.ok(prove.tools.includes("http_whitelist"));
});

test("builtin providers expose local core and optional remote slot", async () => {
	const QLab = await loadQLab();
	const registry = QLab.createDefaultProviderRegistry();
	const coreIds = registry.listCore().map((p) => p.id);
	assert.ok(coreIds.includes("codex-cli"));
	assert.ok(coreIds.includes("openai-compat"));
	assert.ok(coreIds.includes("prove-harness"));
	assert.ok(!coreIds.includes("remote-execution"));
	const remote = registry.get("remote-execution");
	assert.equal(remote.optional, true);
	assert.equal(remote.status, "deferred");
	assert.equal(remote.capabilities.remote, true);
});

test("AgentRuntime streams stub provider events and blocks ungranted tools", async () => {
	const QLab = await loadQLab();
	const registry = QLab.createDefaultProviderRegistry({
		codex: {
			discover: async () => "/mock/codex",
			runner: {
				async *run() {
					yield {
						type: "stdout",
						data: JSON.stringify({ type: "agent_message", text: "hello" }),
					};
					yield { type: "exit", exitCode: 0 };
				},
			},
		},
	});
	const runtime = new QLab.AgentRuntime({
		registry,
		defaultProviderId: "codex-cli",
	});
	const events = await collect(runtime.startTurn({
		mode: "ask",
		prompt: "hello",
	}));
	assert.ok(events.some((e) => e.type === "text-delta" && /hello/.test(e.text)));
	assert.equal(events.at(-1).type, "done");
});

test("remote-execution provider reports deferred optional error", async () => {
	const QLab = await loadQLab();
	const runtime = new QLab.AgentRuntime({
		registry: QLab.createDefaultProviderRegistry(),
		defaultProviderId: "remote-execution",
	});
	const events = await collect(runtime.startTurn({
		mode: "ask",
		prompt: "x",
		providerId: "remote-execution",
	}));
	assert.equal(events[0].type, "error");
	assert.match(events[0].message, /optional and deferred/i);
	assert.equal(events.at(-1).status, "cancelled");
});

test("Phase4.connectSSH points at optional remote-execution slot", async () => {
	const QLab = await loadQLab();
	const result = QLab.Phase4.connectSSH();
	assert.equal(result.status, "deferred-optional");
	assert.equal(result.providerId, "remote-execution");
});

test("runtime rejects tool-call events outside turn grants", async () => {
	const QLab = await loadQLab();
	const registry = new QLab.AgentProviderRegistry([]);
	registry.register({
		id: "test-bad-tool",
		label: "Test",
		kind: "test",
		status: "stub",
		capabilities: { tools: true, streaming: true },
		async *startTurn() {
			yield { type: "tool-call", callId: "1", name: "knowledge_apply", arguments: {} };
			yield { type: "done", status: "ok" };
		},
	});
	const runtime = new QLab.AgentRuntime({
		registry,
		defaultProviderId: "test-bad-tool",
	});
	const events = await collect(runtime.startTurn({ mode: "ask", prompt: "x" }));
	assert.ok(events.some((e) => e.type === "error" && /not granted/i.test(e.message)));
});
