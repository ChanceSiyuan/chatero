import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const ROOT = "/tmp/chatero-main-site-repository";
const IDENTITY = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_IDENTITY = "223e4567-e89b-42d3-a456-426614174001";

function target(identity = IDENTITY, root = ROOT) {
	return { identity, root };
}

function eventStream(events, controls = {}) {
	let exitResolve;
	let exited = new Promise(resolve => { exitResolve = resolve; });
	let cancelled = false;
	return {
		async *[Symbol.asyncIterator]() {
			for (let event of events) {
				if (cancelled) break;
				yield event;
				if (event.type === "exit") exitResolve(event.exitCode);
			}
			if (controls.hold && !cancelled) {
				await new Promise(resolve => { controls.release = resolve; });
			}
			if (cancelled || controls.exitOnRelease) {
				exitResolve(controls.exitCode ?? 0);
				yield { type: "exit", exitCode: controls.exitCode ?? 0 };
			}
		},
		cancel() {
			cancelled = true;
			controls.cancelled = (controls.cancelled || 0) + 1;
			controls.release?.();
		},
		waitForExit(timeoutMs) {
			if (controls.neverExits) {
				return Promise.reject(new Error(`Process exit timed out after ${timeoutMs}ms`));
			}
			return exited;
		},
	};
}

function runtimeFixture(options = {}) {
	let spawnCalls = [];
	let startControls = options.startControls || { hold: true, exitOnRelease: true };
	let started = false;
	let serviceIdentity = options.identity || IDENTITY;
	let runtime = {
		spawnCalls,
		startupPollIntervalMs: 1,
		startupPollAttempts: options.startupPollAttempts ?? 4,
		shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5,
		maxDiagnosticChars: options.maxDiagnosticChars ?? 240,
		canonicalizeRoot: async root => root,
		fetchHealth: async url => {
			if (options.fetchHealth) return options.fetchHealth(url, { started });
			if (started) return { ok: true, repositoryIdentity: serviceIdentity };
			return null;
		},
		isPortAvailable: async port => options.availablePorts
			? options.availablePorts.includes(port)
			: port === 4180,
		resolveDependencies: async () => options.dependencies === undefined
			? {
				node: { command: "/opt/chatero/bin/node", version: "22.13.0" },
				npm: { command: "/opt/chatero/bin/npm" },
				quarto: { command: "/opt/chatero/bin/quarto", version: "1.7.0" },
			}
			: options.dependencies,
		sleep: async () => {},
		now: (() => {
			let value = 100;
			return () => ++value;
		})(),
		processRunner: {
			run(command, args, runOptions) {
				let call = { command, args: [...args], options: { ...runOptions } };
				spawnCalls.push(call);
				let stage = args.join(" ");
				if (stage === "ci") {
					return eventStream(options.installEvents || [
						{ type: "stdout", data: "dependencies installed" },
						{ type: "exit", exitCode: 0 },
					]);
				}
				if (stage === "run build") {
					return eventStream(options.buildEvents || [
						{ type: "stderr", data: "build warning" },
						{ type: "exit", exitCode: 0 },
					]);
				}
				started = true;
				return eventStream(options.startEvents || [
					{ type: "stdout", data: "server starting" },
				], startControls);
			},
		},
	};
	return { runtime, startControls };
}

test("check is health-only and never installs, builds, or starts", async () => {
	const QLab = await loadQLab();
	const { runtime } = runtimeFixture();
	const service = QLab.createMainSiteService(runtime);

	const checked = await service.check(target());

	assert.equal(checked.state, "idle");
	assert.equal(runtime.spawnCalls.length, 0);
	assert.equal(service.snapshot(IDENTITY).state, "idle");
});

test("start uses preferred loopback port and exact fixed process stages", async () => {
	const QLab = await loadQLab();
	const { runtime } = runtimeFixture();
	const service = QLab.createMainSiteService(runtime);

	const result = await service.start(target());

	assert.equal(result.state, "ready");
	assert.equal(result.url, "http://127.0.0.1:4180/");
	assert.equal(result.ownership, "owned");
	assert.deepEqual(JSON.parse(JSON.stringify(runtime.spawnCalls.map(({ command, args, options }) => ({
		command,
		args,
		cwd: options.cwd,
		env: options.env,
	})))), JSON.parse(JSON.stringify([
		{ command: "/opt/chatero/bin/npm", args: ["ci"], cwd: ROOT, env: undefined },
		{ command: "/opt/chatero/bin/npm", args: ["run", "build"], cwd: ROOT, env: undefined },
		{
			command: "/opt/chatero/bin/npm",
			args: ["run", "start", "--", "--hostname", "127.0.0.1", "--port", "4180"],
			cwd: ROOT,
			env: { QLAB_REPOSITORY_ID: IDENTITY },
		},
	])));
});

test("unrelated preferred-port health allocates the first free bounded fallback", async () => {
	const QLab = await loadQLab();
	const { runtime, startControls } = runtimeFixture({
		availablePorts: [4182],
		fetchHealth: async (url, { started }) => {
			if (url.endsWith(":4180/")) return { ok: true, repositoryIdentity: OTHER_IDENTITY };
			if (started && url.endsWith(":4182/")) return { ok: true, repositoryIdentity: IDENTITY };
			return null;
		},
	});
	const service = QLab.createMainSiteService(runtime);

	const result = await service.start(target());

	assert.equal(result.url, "http://127.0.0.1:4182/");
	assert.deepEqual(runtime.spawnCalls.at(-1).args.slice(-2), ["--port", "4182"]);
	assert.equal(startControls.cancelled || 0, 0, "the unrelated port owner must never be stopped");
});

test("matching health reuses an external site without dependency or process work", async () => {
	const QLab = await loadQLab();
	let dependencyCalls = 0;
	const { runtime } = runtimeFixture({
		fetchHealth: async () => ({ ok: true, repositoryIdentity: IDENTITY }),
	});
	runtime.resolveDependencies = async () => {
		dependencyCalls++;
		throw new Error("must not resolve dependencies");
	};
	const service = QLab.createMainSiteService(runtime);

	const result = await service.start(target());

	assert.equal(result.state, "ready");
	assert.equal(result.ownership, "external");
	assert.equal(dependencyCalls, 0);
	assert.equal(runtime.spawnCalls.length, 0);
});

test("concurrent starts for one identity return the same promise and one pipeline", async () => {
	const QLab = await loadQLab();
	let releaseDependencies;
	const { runtime } = runtimeFixture();
	runtime.resolveDependencies = () => new Promise(resolve => { releaseDependencies = resolve; });
	const service = QLab.createMainSiteService(runtime);

	const first = service.start(target());
	const second = service.start(target());
	assert.equal(first, second);
	while (!releaseDependencies) await new Promise(resolve => setTimeout(resolve, 0));
	releaseDependencies({
		node: { command: "/opt/chatero/bin/node", version: "22.13.0" },
		npm: { command: "/opt/chatero/bin/npm" },
		quarto: { command: "/opt/chatero/bin/quarto" },
	});
	await first;
	assert.equal(runtime.spawnCalls.length, 3);
});

test("a health-only check does not overwrite an in-flight start state", async () => {
	const QLab = await loadQLab();
	let releaseDependencies;
	const { runtime } = runtimeFixture();
	runtime.resolveDependencies = () => new Promise(resolve => { releaseDependencies = resolve; });
	const service = QLab.createMainSiteService(runtime);
	const starting = service.start(target());
	while (!releaseDependencies) await new Promise(resolve => setTimeout(resolve, 0));

	const checked = await service.check(target());

	assert.equal(checked.state, "checking");
	releaseDependencies({
		node: { command: "/opt/chatero/bin/node", version: "22.13.0" },
		npm: { command: "/opt/chatero/bin/npm" },
		quarto: { command: "/opt/chatero/bin/quarto" },
	});
	await starting;
	assert.equal(runtime.spawnCalls.length, 3);
});

test("a later start and health check reuse an owned fallback site", async () => {
	const QLab = await loadQLab();
	const { runtime } = runtimeFixture({
		availablePorts: [4182],
		fetchHealth: async (url, { started }) => {
			if (url.endsWith(":4180/")) return { ok: true, repositoryIdentity: OTHER_IDENTITY };
			if (started && url.endsWith(":4182/")) return { ok: true, repositoryIdentity: IDENTITY };
			return null;
		},
	});
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());
	const callsAfterFirstStart = runtime.spawnCalls.length;

	const restarted = await service.start(target());
	const checked = await service.check(target());

	assert.equal(restarted.state, "ready");
	assert.equal(checked.state, "ready");
	assert.equal(checked.url, "http://127.0.0.1:4182/");
	assert.equal(checked.ownership, "owned");
	assert.equal(runtime.spawnCalls.length, callsAfterFirstStart);
});

test("stop during target resolution cancels the pending start before any process", async () => {
	const QLab = await loadQLab();
	let releaseCanonical;
	const controls = { hold: true, neverExits: true };
	const { runtime } = runtimeFixture({ startControls: controls });
	runtime.canonicalizeRoot = () => new Promise(resolve => { releaseCanonical = resolve; });
	const service = QLab.createMainSiteService(runtime);

	const starting = service.start(target());
	while (!releaseCanonical) await new Promise(resolve => setTimeout(resolve, 0));
	const stopping = service.stop(IDENTITY);
	releaseCanonical(ROOT);

	await assert.rejects(starting, /cancelled/i);
	await stopping;
	assert.equal(runtime.spawnCalls.length, 0);
	assert.equal(service.snapshot(IDENTITY).state, "idle");
});

test("dependency validation rejects old Node and unavailable Quarto before spawning", async () => {
	const QLab = await loadQLab();
	for (let dependencies of [
		{
			node: { command: "/opt/node", version: "22.12.9" },
			npm: { command: "/opt/npm" },
			quarto: { command: "/opt/quarto" },
		},
		{
			node: { command: "/opt/node", version: "22.13.0" },
			npm: { command: "/opt/npm" },
			quarto: null,
		},
	]) {
		const { runtime } = runtimeFixture({ dependencies });
		const service = QLab.createMainSiteService(runtime);
		await assert.rejects(service.start(target()), /Node\.js 22\.13\.0|Quarto/);
		assert.equal(runtime.spawnCalls.length, 0);
		assert.equal(service.snapshot(IDENTITY).state, "error");
	}
});

test("service streams both output channels and keeps a bounded diagnostic tail", async () => {
	const QLab = await loadQLab();
	const { runtime } = runtimeFixture({
		maxDiagnosticChars: 72,
		installEvents: [
			{ type: "stdout", data: "old line that must leave the tail" },
			{ type: "stderr", data: "install stderr" },
			{ type: "stdout", data: "install stdout" },
			{ type: "exit", exitCode: 0 },
		],
	});
	const service = QLab.createMainSiteService(runtime);
	let states = [];
	service.observe(IDENTITY, state => states.push(state));

	await service.start(target());

	const snapshot = service.snapshot(IDENTITY);
	assert.ok(snapshot.diagnosticTail.length <= 72);
	assert.match(snapshot.diagnosticTail, /install stdout/);
	assert.ok(states.some(({ diagnosticTail }) => /install stderr/.test(diagnosticTail)));
	assert.ok(states.some(({ state }) => state === "installing"));
	assert.ok(states.some(({ state }) => state === "building"));
	assert.ok(states.some(({ state }) => state === "starting"));
});

test("an early start-process exit fails with its bounded stderr detail", async () => {
	const QLab = await loadQLab();
	const { runtime } = runtimeFixture({
		startEvents: [
			{ type: "stderr", data: "address already unavailable" },
			{ type: "exit", exitCode: 19 },
		],
		startControls: {},
		fetchHealth: async () => null,
	});
	const service = QLab.createMainSiteService(runtime);

	await assert.rejects(service.start(target()), /address already unavailable|code 19/);
	assert.equal(service.snapshot(IDENTITY).state, "error");
});

test("a failed rebuild preserves the last-good URL", async () => {
	const QLab = await loadQLab();
	let failBuild = false;
	const { runtime } = runtimeFixture({
		fetchHealth: async () => ({ ok: true, repositoryIdentity: IDENTITY }),
	});
	const originalRun = runtime.processRunner.run;
	runtime.processRunner.run = (command, args, options) => {
		if (failBuild && args.join(" ") === "run build") {
			return eventStream([
				{ type: "stderr", data: "compile failed" },
				{ type: "exit", exitCode: 2 },
			]);
		}
		return originalRun(command, args, options);
	};
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());
	failBuild = true;

	await assert.rejects(service.rebuild(target()), /compile failed|code 2/);

	const snapshot = service.snapshot(IDENTITY);
	assert.equal(snapshot.state, "error");
	assert.equal(snapshot.lastGoodURL, "http://127.0.0.1:4180/");
	assert.equal(snapshot.url, "http://127.0.0.1:4180/");
});

test("stop cancels and waits for an owned process, but never stops an external one", async () => {
	const QLab = await loadQLab();
	const owned = runtimeFixture();
	const service = QLab.createMainSiteService(owned.runtime);
	await service.start(target());
	await service.stop(IDENTITY);
	assert.equal(owned.startControls.cancelled, 1);
	assert.equal(service.snapshot(IDENTITY).state, "idle");

	const external = runtimeFixture({
		identity: OTHER_IDENTITY,
		fetchHealth: async () => ({ ok: true, repositoryIdentity: OTHER_IDENTITY }),
	});
	const externalService = QLab.createMainSiteService(external.runtime);
	await externalService.start(target(OTHER_IDENTITY));
	await externalService.stop(OTHER_IDENTITY);
	assert.equal(external.startControls.cancelled || 0, 0);
	assert.equal(externalService.snapshot(OTHER_IDENTITY).state, "ready");
});

test("shutdown cancels only owned processes and bounds exit waiting", async () => {
	const QLab = await loadQLab();
	const controls = { hold: true, neverExits: true };
	const { runtime } = runtimeFixture({ startControls: controls });
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());

	await service.shutdown();

	assert.equal(controls.cancelled, 1);
	assert.equal(service.snapshot(IDENTITY).state, "idle");
	assert.match(service.snapshot(IDENTITY).diagnosticTail, /timed out/i);
});

test("a failed health check never loses ownership of a live Chatero process", async () => {
	const QLab = await loadQLab();
	let healthy = true;
	const { runtime, startControls } = runtimeFixture({
		fetchHealth: async (_url, { started }) => started && healthy
			? { ok: true, repositoryIdentity: IDENTITY }
			: null,
	});
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());
	healthy = false;

	const checked = await service.check(target());
	assert.equal(checked.state, "stale");
	assert.equal(checked.ownership, "owned");
	await service.shutdown();
	assert.equal(startControls.cancelled, 1);
});

test("no free port in 4180 through 4199 fails without guessing or spawning", async () => {
	const QLab = await loadQLab();
	let inspected = [];
	const { runtime } = runtimeFixture({
		fetchHealth: async () => ({ ok: true, repositoryIdentity: OTHER_IDENTITY }),
		availablePorts: [],
	});
	runtime.isPortAvailable = async port => {
		inspected.push(port);
		return false;
	};
	const service = QLab.createMainSiteService(runtime);

	await assert.rejects(service.start(target()), /4181.*4199|available loopback port/i);
	assert.deepEqual(inspected, Array.from({ length: 19 }, (_, index) => 4181 + index));
	assert.equal(runtime.spawnCalls.length, 0);
});
