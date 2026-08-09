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
	let waitIndex = 0;
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
			if (cancelled) return;
			cancelled = true;
			controls.cancelled = (controls.cancelled || 0) + 1;
			controls.release?.();
		},
		waitForExit(timeoutMs) {
			controls.waits = (controls.waits || 0) + 1;
			if (typeof controls.waitForExit === "function") {
				return controls.waitForExit(timeoutMs);
			}
			if (Array.isArray(controls.waitResults) && waitIndex < controls.waitResults.length) {
				let result = controls.waitResults[waitIndex++];
				return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
			}
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
	let serverStarts = 0;
	let serviceIdentity = options.identity || IDENTITY;
	let runtime = {
		spawnCalls,
		startupPollIntervalMs: 1,
		startupPollAttempts: options.startupPollAttempts ?? 4,
		shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5,
		maxDiagnosticChars: options.maxDiagnosticChars ?? 240,
		canonicalizeRoot: async root => root,
		fetchHealth: async url => {
			if (options.fetchHealth) return options.fetchHealth(url, { started, serverStarts });
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
				serverStarts++;
				let controls = typeof options.startControlsFactory === "function"
					? options.startControlsFactory(serverStarts)
					: startControls;
				return eventStream(options.startEvents || [
					{ type: "stdout", data: "server starting" },
				], controls);
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

test("stop during rebuild retains and confirms exit of the old owned server", async () => {
	const QLab = await loadQLab();
	let serverControls = { hold: true, exitOnRelease: true };
	let buildControls = { hold: true, exitOnRelease: true };
	const { runtime } = runtimeFixture({ startControls: serverControls });
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());
	const originalRun = runtime.processRunner.run;
	runtime.processRunner.run = (command, args, options) => args.join(" ") === "ci"
		? eventStream([{ type: "stdout", data: "installing" }], buildControls)
		: originalRun(command, args, options);

	const rebuilding = service.rebuild(target());
	while (!buildControls.release) await new Promise(resolve => setTimeout(resolve, 0));
	const stopping = service.stop(IDENTITY);

	await assert.rejects(rebuilding, /cancelled/i);
	await stopping;
	assert.equal(buildControls.cancelled, 1);
	assert.equal(serverControls.cancelled, 1);
	assert.equal(serverControls.waits, 1);
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

test("a successful rebuild keeps a healthy owned site live through build then replaces it", async () => {
	const QLab = await loadQLab();
	const firstControls = { hold: true, exitOnRelease: true };
	const secondControls = { hold: true, exitOnRelease: true };
	const { runtime } = runtimeFixture({
		startControlsFactory: generation => generation === 1 ? firstControls : secondControls,
	});
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());

	const rebuilt = await service.rebuild(target());

	assert.equal(runtime.spawnCalls.filter(call => call.args.includes("start")).length, 2);
	assert.equal(firstControls.cancelled, 1);
	assert.equal(firstControls.waits, 1);
	assert.equal(secondControls.cancelled || 0, 0);
	assert.equal(rebuilt.state, "ready");
	assert.equal(rebuilt.ownership, "owned");
});

test("a failed rebuild leaves the healthy owned site tracked and does not restart it", async () => {
	const QLab = await loadQLab();
	const oldControls = { hold: true, exitOnRelease: true };
	let failBuild = false;
	const { runtime } = runtimeFixture({ startControls: oldControls });
	const originalRun = runtime.processRunner.run;
	runtime.processRunner.run = (command, args, options) => {
		if (failBuild && args.join(" ") === "run build") {
			return eventStream([
				{ type: "stderr", data: "rebuild compile failed" },
				{ type: "exit", exitCode: 2 },
			]);
		}
		return originalRun(command, args, options);
	};
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());
	failBuild = true;

	await assert.rejects(service.rebuild(target()), /rebuild compile failed|code 2/i);

	assert.equal(runtime.spawnCalls.filter(call => call.args.includes("start")).length, 1);
	assert.equal(oldControls.cancelled || 0, 0);
	assert.equal(oldControls.waits || 0, 0);
	assert.equal(service.snapshot(IDENTITY).ownership, "owned");
	assert.equal(service.snapshot(IDENTITY).lastGoodURL, "http://127.0.0.1:4180/");
});

test("a post-build retirement timeout retains the old owned process and blocks restart", async () => {
	const QLab = await loadQLab();
	const oldControls = {
		hold: true,
		exitOnRelease: true,
		waitResults: [new Error("Process exit timed out after 5ms"), 0],
	};
	const { runtime } = runtimeFixture({ startControls: oldControls });
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());

	await assert.rejects(service.rebuild(target()), /timed out/i);

	assert.equal(runtime.spawnCalls.filter(call => call.args.includes("ci")).length, 2);
	assert.equal(runtime.spawnCalls.filter(call => call.args.includes("build")).length, 2);
	assert.equal(runtime.spawnCalls.filter(call => call.args.includes("start")).length, 1);
	assert.equal(oldControls.cancelled, 1);
	assert.equal(oldControls.waits, 1);
	assert.equal(service.snapshot(IDENTITY).ownership, "owned");
	await service.stop(IDENTITY);
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
	assert.equal(service.snapshot(IDENTITY).state, "error");
	assert.equal(service.snapshot(IDENTITY).ownership, "owned");
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

test("start retires an unhealthy owned server before launching its replacement", async () => {
	const QLab = await loadQLab();
	let firstHealthy = true;
	let firstControls = { hold: true, exitOnRelease: true };
	let secondControls = { hold: true, exitOnRelease: true };
	const { runtime } = runtimeFixture({
		startControlsFactory: generation => generation === 1 ? firstControls : secondControls,
		fetchHealth: async (_url, { serverStarts }) => {
			if (serverStarts === 1 && firstHealthy) return { ok: true, repositoryIdentity: IDENTITY };
			if (serverStarts >= 2) return { ok: true, repositoryIdentity: IDENTITY };
			return null;
		},
	});
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());
	firstHealthy = false;

	await service.start(target());

	assert.equal(firstControls.cancelled, 1);
	assert.equal(firstControls.waits, 1);
	assert.equal(runtime.spawnCalls.filter(call => call.args.includes("start")).length, 2);
	assert.equal(service.snapshot(IDENTITY).ownership, "owned");
});

test("rebuild retires an unhealthy owned server before launching its replacement", async () => {
	const QLab = await loadQLab();
	let firstHealthy = true;
	let firstControls = { hold: true, exitOnRelease: true };
	let secondControls = { hold: true, exitOnRelease: true };
	const { runtime } = runtimeFixture({
		startControlsFactory: generation => generation === 1 ? firstControls : secondControls,
		fetchHealth: async (_url, { serverStarts }) => {
			if (serverStarts === 1 && firstHealthy) return { ok: true, repositoryIdentity: IDENTITY };
			if (serverStarts >= 2) return { ok: true, repositoryIdentity: IDENTITY };
			return null;
		},
	});
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());
	firstHealthy = false;

	await service.rebuild(target());

	assert.equal(firstControls.cancelled, 1);
	assert.equal(firstControls.waits, 1);
	assert.equal(runtime.spawnCalls.filter(call => call.args.includes("start")).length, 2);
	assert.equal(service.snapshot(IDENTITY).ownership, "owned");
});

test("owned-process retirement timeout retains ownership and blocks a replacement launch", async () => {
	const QLab = await loadQLab();
	let healthy = true;
	let oldControls = {
		hold: true,
		exitOnRelease: true,
		waitResults: [new Error("Process exit timed out after 5ms"), 0],
	};
	const { runtime } = runtimeFixture({
		startControls: oldControls,
		fetchHealth: async (_url, { serverStarts }) => healthy && serverStarts === 1
			? { ok: true, repositoryIdentity: IDENTITY }
			: null,
	});
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());
	healthy = false;
	const before = runtime.spawnCalls.length;

	await assert.rejects(service.start(target()), /timed out/i);

	assert.equal(runtime.spawnCalls.length, before, "no install, build, or replacement start may run");
	assert.equal(service.snapshot(IDENTITY).ownership, "owned");
	await service.stop(IDENTITY);
	assert.equal(oldControls.waits, 2);
	assert.equal(service.snapshot(IDENTITY).state, "idle");
});

test("a direct stop timeout retains the owned handle for a later successful stop", async () => {
	const QLab = await loadQLab();
	let controls = {
		hold: true,
		exitOnRelease: true,
		waitResults: [new Error("Process exit timed out after 5ms"), 0],
	};
	const { runtime } = runtimeFixture({ startControls: controls });
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());
	const before = runtime.spawnCalls.length;

	await assert.rejects(service.stop(IDENTITY), /timed out/i);
	assert.equal(service.snapshot(IDENTITY).ownership, "owned");
	assert.equal(runtime.spawnCalls.length, before);

	await service.stop(IDENTITY);
	assert.equal(controls.waits, 2);
	assert.equal(service.snapshot(IDENTITY).state, "idle");
});

test("stop while retiring an old owned server prevents every replacement stage", async () => {
	const QLab = await loadQLab();
	let healthy = true;
	let releaseExit;
	let oldControls = {
		hold: true,
		exitOnRelease: true,
		waitForExit: () => new Promise(resolve => { releaseExit = resolve; }),
	};
	const { runtime } = runtimeFixture({
		startControls: oldControls,
		fetchHealth: async (_url, { serverStarts }) => healthy && serverStarts === 1
			? { ok: true, repositoryIdentity: IDENTITY }
			: null,
	});
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());
	healthy = false;
	const before = runtime.spawnCalls.length;
	const restarting = service.start(target());
	while (!releaseExit) await new Promise(resolve => setTimeout(resolve, 0));
	const stopping = service.stop(IDENTITY);
	releaseExit(0);

	await assert.rejects(restarting, /cancelled/i);
	await stopping;
	assert.equal(runtime.spawnCalls.length, before);
	assert.equal(service.snapshot(IDENTITY).state, "idle");
});

test("an unhealthy external server is not killed and forces bounded fallback allocation", async () => {
	const QLab = await loadQLab();
	let externalHealthy = true;
	let replacementControls = { hold: true, exitOnRelease: true };
	const { runtime } = runtimeFixture({
		availablePorts: [4181],
		startControls: replacementControls,
		fetchHealth: async (url, { serverStarts }) => {
			if (url.endsWith(":4180/") && externalHealthy) {
				return { ok: true, repositoryIdentity: IDENTITY };
			}
			if (url.endsWith(":4181/") && serverStarts === 1) {
				return { ok: true, repositoryIdentity: IDENTITY };
			}
			return null;
		},
	});
	runtime.isPortAvailable = async port => port === 4181;
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());
	externalHealthy = false;

	const restarted = await service.start(target());

	assert.equal(restarted.url, "http://127.0.0.1:4181/");
	assert.equal(replacementControls.cancelled || 0, 0);
	assert.deepEqual(runtime.spawnCalls.at(-1).args.slice(-2), ["--port", "4181"]);
});

test("rebuild also allocates a fallback instead of overwriting an unhealthy external port", async () => {
	const QLab = await loadQLab();
	let externalHealthy = true;
	let replacementControls = { hold: true, exitOnRelease: true };
	const { runtime } = runtimeFixture({
		availablePorts: [4181],
		startControls: replacementControls,
		fetchHealth: async (url, { serverStarts }) => {
			if (url.endsWith(":4180/") && externalHealthy) {
				return { ok: true, repositoryIdentity: IDENTITY };
			}
			if (url.endsWith(":4181/") && serverStarts === 1) {
				return { ok: true, repositoryIdentity: IDENTITY };
			}
			return null;
		},
	});
	runtime.isPortAvailable = async port => port === 4181;
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());
	externalHealthy = false;

	const rebuilt = await service.rebuild(target());

	assert.equal(rebuilt.url, "http://127.0.0.1:4181/");
	assert.equal(replacementControls.cancelled || 0, 0);
	assert.deepEqual(runtime.spawnCalls.at(-1).args.slice(-2), ["--port", "4181"]);
});

test("check rejects a different canonical root during an in-flight identity operation", async () => {
	const QLab = await loadQLab();
	let releaseDependencies;
	const { runtime } = runtimeFixture();
	runtime.resolveDependencies = () => new Promise(resolve => { releaseDependencies = resolve; });
	const service = QLab.createMainSiteService(runtime);
	const starting = service.start(target());
	while (!releaseDependencies) await new Promise(resolve => setTimeout(resolve, 0));

	await assert.rejects(service.check(target(IDENTITY, "/tmp/other-repository")), /different.*root|identity.*root/i);
	assert.equal(service.snapshot(IDENTITY).root, ROOT);

	releaseDependencies({
		node: { command: "/opt/chatero/bin/node", version: "22.13.0" },
		npm: { command: "/opt/chatero/bin/npm" },
		quarto: { command: "/opt/chatero/bin/quarto" },
	});
	await starting;
	assert.ok(runtime.spawnCalls.every(call => call.options.cwd === ROOT));
});

test("start and rebuild cannot coalesce a different root under the same identity", async () => {
	const QLab = await loadQLab();
	let releaseDependencies;
	const { runtime } = runtimeFixture();
	runtime.resolveDependencies = () => new Promise(resolve => { releaseDependencies = resolve; });
	const service = QLab.createMainSiteService(runtime);
	const starting = service.start(target());
	while (!releaseDependencies) await new Promise(resolve => setTimeout(resolve, 0));

	const conflictingStart = service.start(target(IDENTITY, "/tmp/other-repository"));
	const conflictingRebuild = service.rebuild(target(IDENTITY, "/tmp/other-repository"));

	releaseDependencies({
		node: { command: "/opt/chatero/bin/node", version: "22.13.0" },
		npm: { command: "/opt/chatero/bin/npm" },
		quarto: { command: "/opt/chatero/bin/quarto" },
	});
	await starting;
	await assert.rejects(conflictingStart, /different.*root|identity.*root/i);
	await assert.rejects(conflictingRebuild, /different.*root|identity.*root/i);
	assert.equal(service.snapshot(IDENTITY).root, ROOT);
	assert.ok(runtime.spawnCalls.every(call => call.options.cwd === ROOT));
});

test("a completed identity binding rejects rebuild from another root before mutation", async () => {
	const QLab = await loadQLab();
	const { runtime } = runtimeFixture({
		fetchHealth: async () => ({ ok: true, repositoryIdentity: IDENTITY }),
	});
	const service = QLab.createMainSiteService(runtime);
	await service.start(target());
	const before = runtime.spawnCalls.length;
	const beforeSnapshot = service.snapshot(IDENTITY);

	await assert.rejects(service.rebuild(target(IDENTITY, "/tmp/other-repository")), /different.*root|identity.*root/i);

	const afterSnapshot = service.snapshot(IDENTITY);
	assert.equal(afterSnapshot.root, ROOT);
	assert.equal(afterSnapshot.state, beforeSnapshot.state);
	assert.equal(afterSnapshot.url, beforeSnapshot.url);
	assert.equal(afterSnapshot.ownership, beforeSnapshot.ownership);
	assert.equal(afterSnapshot.updatedAt, beforeSnapshot.updatedAt);
	assert.equal(runtime.spawnCalls.length, before);
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
