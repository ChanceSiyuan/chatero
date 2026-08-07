import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

test("buildCodexExecArgv uses read-only sandbox for ask turns", async () => {
	const QLab = await loadQLab();
	const turn = QLab.createProveTurn({ mode: "ask" });
	const built = QLab.buildCodexExecArgv(turn, "summarize", { executable: "/bin/codex" });
	assert.equal(built.command, "/bin/codex");
	assert.equal(built.sandbox, "read-only");
	assert.ok(built.args.includes("exec"));
	assert.ok(built.args.includes("--json"));
	assert.ok(built.args.includes("read-only"));
	assert.ok(!built.args.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("buildCodexExecArgv uses workspace-write for agent turns with root", async () => {
	const QLab = await loadQLab();
	const turn = QLab.createProveTurn({
		mode: "agent",
		workspaceRoot: "/tmp/ws",
	});
	const built = QLab.buildCodexExecArgv(turn, "write", { executable: "codex" });
	assert.equal(built.sandbox, "workspace-write");
	assert.ok(built.args.includes("-C"));
	assert.ok(built.args.includes("/tmp/ws"));
	assert.ok(built.args.includes("--add-dir"));
	assert.ok(built.args.includes("/tmp/ws/work"));
});

test("mapCodexExecJsonLine maps text, error, approval, and plain lines", async () => {
	const QLab = await loadQLab();
	assert.equal(
		JSON.stringify(QLab.mapCodexExecJsonLine('{"type":"agent_message","text":"hi"}')),
		JSON.stringify([{ type: "text-delta", text: "hi" }]),
	);
	assert.equal(
		QLab.mapCodexExecJsonLine('{"type":"error","message":"boom"}')[0].type,
		"error",
	);
	assert.equal(
		QLab.mapCodexExecJsonLine('{"type":"approval_requested","reason":"run"}')[0].type,
		"approval-needed",
	);
	assert.equal(
		QLab.mapCodexExecJsonLine("not-json")[0].text,
		"not-json\n",
	);
});

test("CodexCliProvider streams runner output and finishes", async () => {
	const QLab = await loadQLab();
	const runner = {
		async *run(command, args) {
			assert.equal(command, "/fake/codex");
			assert.ok(args.includes("exec"));
			yield {
				type: "stdout",
				data: JSON.stringify({ type: "agent_message", text: "hello from codex" }),
			};
			yield { type: "exit", exitCode: 0 };
		},
	};
	const provider = QLab.createCodexCliProvider({
		discover: async () => "/fake/codex",
		runner,
	});
	await provider.refreshStatus();
	assert.equal(provider.status, "ready");
	const turn = QLab.createProveTurn({ mode: "ask" });
	const events = await collect(provider.startTurn(turn, "hi"));
	assert.ok(events.some((e) => e.type === "text-delta" && /hello from codex/.test(e.text)));
	assert.equal(events.at(-1).type, "done");
});

test("CodexCliProvider reports missing CLI cleanly", async () => {
	const QLab = await loadQLab();
	const provider = QLab.createCodexCliProvider({
		discover: async () => null,
	});
	const events = await collect(provider.startTurn(
		QLab.createProveTurn({ mode: "ask" }),
		"x",
	));
	assert.equal(events[0].type, "error");
	assert.match(events[0].message, /not found/i);
	assert.equal(events.at(-1).status, "cancelled");
});

test("default registry uses live codex-cli provider id", async () => {
	const QLab = await loadQLab();
	const registry = QLab.createDefaultProviderRegistry({
		codex: {
			discover: async () => "/opt/codex",
			runner: {
				async *run() {
					yield { type: "exit", exitCode: 0 };
				},
			},
		},
	});
	const codex = registry.get("codex-cli");
	assert.ok(codex);
	await codex.refreshStatus();
	assert.equal(codex.status, "ready");
	assert.ok(registry.listCore().some((p) => p.id === "codex-cli"));
});

test("discoverCodexExecutable finds PATH candidate via host.exists", async () => {
	const QLab = await loadQLab();
	const found = await QLab.discoverCodexExecutable({
		envPath: "/opt/bin:/usr/bin",
		homeDir: "/home/me",
		exists: async (path) => path === "/opt/bin/codex",
	});
	assert.equal(found, "/opt/bin/codex");
});
