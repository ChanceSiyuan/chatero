import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

async function collect(iterable) {
	let events = [];
	for await (let event of iterable) events.push(event);
	return events;
}

test("ProcessRunner preserves separate stdout and stderr events", async () => {
	const QLab = await loadQLab();
	const runner = QLab.createProcessRunner({
		async *spawn() {
			yield { type: "stdout", data: "normal output" };
			yield { type: "stderr", data: "diagnostic output" };
			yield { type: "exit", exitCode: 0 };
		},
	});

	assert.deepEqual(await collect(runner.run("/bin/example", [])), [
		{ type: "stdout", data: "normal output" },
		{ type: "stderr", data: "diagnostic output" },
		{ type: "exit", exitCode: 0 },
	]);
});

test("ProcessRunner stream exposes cooperative cancel without changing registerKill", async () => {
	const QLab = await loadQLab();
	let kills = 0;
	let registered;
	const runner = QLab.createProcessRunner({
		async *spawn({ registerKill }) {
			registerKill(() => kills++);
			yield { type: "stdout", data: "started" };
			await new Promise(resolve => { registered = resolve; });
			yield { type: "exit", exitCode: 0 };
		},
	});
	let legacyKill;
	let stream = runner.run("/bin/example", [], { registerKill: kill => { legacyKill = kill; } });
	let consuming = collect(stream);
	await new Promise(resolve => setTimeout(resolve, 0));

	stream.cancel();
	legacyKill();
	registered();
	await consuming;

	assert.equal(kills, 1, "cancellation must be idempotent across both controls");
});

test("ProcessRunner waitForExit resolves exit code and rejects after a bounded timeout", async () => {
	const QLab = await loadQLab();
	const exiting = QLab.createProcessRunner({
		async *spawn() {
			yield { type: "exit", exitCode: 7 };
		},
	}).run("/bin/example", []);
	let consumed = collect(exiting);
	assert.equal(await exiting.waitForExit(100), 7);
	await consumed;

	const hanging = QLab.createProcessRunner({
		async *spawn() {
			await new Promise(() => {});
		},
	}).run("/bin/example", []);
	collect(hanging);
	await assert.rejects(hanging.waitForExit(5), /timed out/i);
});
