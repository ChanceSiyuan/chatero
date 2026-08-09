import assert from "node:assert/strict";
import test from "node:test";

import { loadQLab } from "../lib/load-qlab.mjs";

const ROOT = "/tmp/qlab-setup";

function plan(root = ROOT) {
	return Object.freeze({
		root,
		create: Object.freeze([{ path: "qlab", kind: "file" }]),
		preserve: Object.freeze([{ path: "drafts", kind: "directory" }]),
		conflicts: Object.freeze([]),
	});
}

test("workspace setup presents safe actions for every repository state", async () => {
	const QLab = await loadQLab();
	const cases = [
		["missing", ["choose"]],
		["empty", ["review", "choose"]],
		["partial", ["review", "choose"]],
		["incompatible", ["choose", "reveal"]],
		["ready", ["open", "choose", "reveal"]],
		["initializing", ["reveal"]],
		["failed", ["review", "choose", "reveal"]],
	];
	for (const [state, expected] of cases) {
		const presentation = QLab.workspaceSetupPresentation({
			state,
			repositoryState: state,
			root: ROOT,
			plan: state === "failed" ? plan() : null,
			error: state === "failed" ? "Folder changed" : null,
		});
		assert.deepEqual(Array.from(presentation.actions, action => action.id), expected, state);
		assert.equal(Object.isFrozen(presentation), true, state);
	}
	const incompatible = QLab.workspaceSetupPresentation({
		state: "incompatible",
		repositoryState: "incompatible",
		root: ROOT,
		plan: null,
		error: null,
	});
	assert.equal(incompatible.actions.some(action => action.id === "initialize"), false);

	const review = QLab.workspaceSetupPresentation({
		state: "review",
		repositoryState: "partial",
		root: ROOT,
		plan: plan(),
		error: null,
	});
	assert.deepEqual(Array.from(review.sections, section => section.title), [
		"Will add",
		"Will preserve",
		"Needs attention",
	]);
});

test("setup controller requires a reviewed plan and never auto-resumes writes", async () => {
	const QLab = await loadQLab();
	let executeCalls = 0;
	let resumeCalls = 0;
	let activations = [];
	let controller = QLab.createQLabWorkspaceSetupController({
		inspect: async root => Object.freeze({
			root,
			state: "partial",
			fingerprint: "current",
			preserved: Object.freeze(["drafts"]),
			conflicts: Object.freeze([]),
		}),
		plan: async ({ root }) => plan(root),
		readManifest: async () => ({ schemaVersion: 1 }),
		initializer: {
			execute: async (nextPlan, onProgress) => {
				executeCalls++;
				onProgress({ step: "verify-folder" });
				return { state: "ready", root: nextPlan.root, repositoryIdentity: "repo-id" };
			},
			resume: async () => { resumeCalls++; },
		},
		onActivate: async result => activations.push(result.repositoryIdentity),
	});
	assert.equal(controller.snapshot().state, "missing");
	await controller.choose(ROOT);
	assert.equal(controller.snapshot().state, "review");
	assert.equal(executeCalls, 0);
	controller.dispose();
	assert.equal(executeCalls, 0, "hiding a setup tab cannot start initialization");

	controller = QLab.createQLabWorkspaceSetupController({
		inspect: async root => Object.freeze({
			root,
			state: "partial",
			fingerprint: "current",
			preserved: Object.freeze(["drafts"]),
			conflicts: Object.freeze([]),
		}),
		plan: async ({ root }) => plan(root),
		readManifest: async () => ({ schemaVersion: 1 }),
		initializer: {
			execute: async (nextPlan, onProgress) => {
				executeCalls++;
				onProgress({ step: "verify-folder" });
				return { state: "ready", root: nextPlan.root, repositoryIdentity: "repo-id" };
			},
			resume: async () => { resumeCalls++; },
		},
		onActivate: async result => activations.push(result.repositoryIdentity),
	});
	await controller.resume(ROOT);
	assert.equal(controller.snapshot().state, "review");
	assert.equal(resumeCalls, 0, "interrupted receipts require a fresh review, not automatic writes");
	await controller.initialize();
	assert.equal(executeCalls, 1);
	assert.deepEqual(activations, ["repo-id"]);
	assert.equal(controller.snapshot().state, "ready");
});

test("setup controller leaves an unsafe target untouched", async () => {
	const QLab = await loadQLab();
	let executeCalls = 0;
	const controller = QLab.createQLabWorkspaceSetupController({
		inspect: async root => Object.freeze({
			root,
			state: "partial",
			fingerprint: "current",
			preserved: Object.freeze([]),
			conflicts: Object.freeze([]),
		}),
		plan: async ({ root }) => plan(root),
		readManifest: async () => ({ schemaVersion: 1 }),
		initializer: { execute: async () => { executeCalls++; } },
		canActivate: () => ({ ok: false, reason: "An AI turn is still running" }),
	});
	await controller.choose(ROOT);
	await controller.initialize();
	assert.equal(executeCalls, 0);
	assert.equal(controller.snapshot().state, "failed");
	assert.match(controller.snapshot().error, /AI turn is still running/);
});

test("closing a setup view does not cancel an already-started initializer", async () => {
	const QLab = await loadQLab();
	let resolveExecute;
	let activated = 0;
	const controller = QLab.createQLabWorkspaceSetupController({
		inspect: async root => Object.freeze({ root, state: "empty", fingerprint: "current", preserved: Object.freeze([]), conflicts: Object.freeze([]) }),
		plan: async ({ root }) => plan(root),
		readManifest: async () => ({ schemaVersion: 1 }),
		initializer: {
			execute: () => new Promise(resolve => { resolveExecute = resolve; }),
		},
		onActivate: async () => { activated++; },
	});
	await controller.choose(ROOT);
	const starting = controller.initialize();
	await Promise.resolve();
	controller.dispose();
	resolveExecute({ state: "ready", root: ROOT, repositoryIdentity: "repo-id" });
	await starting;
	assert.equal(activated, 1);
	assert.equal(controller.snapshot().state, "ready");
});
