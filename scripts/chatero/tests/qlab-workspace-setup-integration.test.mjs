import assert from "node:assert/strict";
import test from "node:test";

import { loadQLab } from "../lib/load-qlab.mjs";

const OLD_ROOT = "/tmp/old-qlab";
const NEW_ROOT = "/tmp/new-qlab";

function inspection(root, state = "ready") {
	return Object.freeze({
		root,
		state,
		fingerprint: `${root}:fingerprint`,
		preserved: Object.freeze([]),
		conflicts: Object.freeze([]),
	});
}

function setupDeps({ state = "partial" } = {}) {
	return {
		inspect: async root => inspection(root, state),
		readManifest: async () => ({ schemaVersion: 1 }),
		plan: async ({ root }) => Object.freeze({
			root,
			create: Object.freeze([{ path: "qlab", kind: "file" }]),
			preserve: Object.freeze([]),
			conflicts: Object.freeze([]),
		}),
		initializer: {
			execute: async plan => ({ state: "ready", root: plan.root, repositoryIdentity: "initialized-id" }),
		},
	};
}

test("coordinator restores saved setupRoot by inspection without resuming writes", async () => {
	const QLab = await loadQLab();
	let executeCalls = 0;
	let resumeCalls = 0;
	const coordinator = QLab.createQLabWorkspaceSetupCoordinator({
		controllerOptions: {
			...setupDeps(),
			initializer: {
				execute: async () => { executeCalls++; },
				resume: async () => { resumeCalls++; },
			},
		},
	});
	const controller = await coordinator.restore(OLD_ROOT);
	assert.equal(controller.snapshot().root, OLD_ROOT);
	assert.equal(controller.snapshot().state, "review");
	assert.equal(executeCalls, 0);
	assert.equal(resumeCalls, 0);
});

test("Choose Another Folder replaces tab payload and controller ownership together", async () => {
	const QLab = await loadQLab();
	const tab = { data: { setupRoot: OLD_ROOT } };
	const coordinator = QLab.createQLabWorkspaceSetupCoordinator({
		controllerOptions: setupDeps(),
		replaceSetupTabRoot: async root => { tab.data.setupRoot = root; },
	});
	const oldController = await coordinator.restore(OLD_ROOT);
	const replacement = await coordinator.replaceRoot(oldController, NEW_ROOT);
	assert.equal(tab.data.setupRoot, NEW_ROOT);
	assert.equal(replacement.snapshot().root, NEW_ROOT);
	assert.equal(replacement.snapshot().state, "review");
	assert.equal(coordinator.get(NEW_ROOT), replacement);
	assert.notEqual(coordinator.get(OLD_ROOT), oldController,
		"the old map key must not retain the view-owned controller");
});

test("Choose Another Folder rebinds the mounted setup view to the replacement controller", async () => {
	const QLab = await loadQLab();
	let click = null;
	const ownerDocument = {
		defaultView: {},
		getElementById: () => null,
	};
	const host = {
		ownerDocument,
		addEventListener(type, listener) { if (type === "click") click = listener; },
		removeEventListener() {},
	};
	const container = {
		ownerDocument,
		querySelector: selector => selector === ".qlab-workspace-setup-host" ? host : null,
	};
	function fakeController(root) {
		const calls = { review: 0, subscribe: 0, unsubscribe: 0 };
		return {
			calls,
			presentation: () => QLab.workspaceSetupPresentation({
				state: "ready",
				repositoryState: "ready",
				root,
			}),
			subscribe(listener) {
				calls.subscribe++;
				listener();
				return () => { calls.unsubscribe++; };
			},
			review: async () => { calls.review++; },
			initialize: async () => {},
			reveal: async () => {},
			copyDiagnostics: () => "{}",
		};
	}
	const original = fakeController(OLD_ROOT);
	const replacement = fakeController(NEW_ROOT);
	let replaced = null;
	const view = QLab.mountQLabWorkspaceSetupView(container, {
		controller: original,
		choose: async () => NEW_ROOT,
		replaceRoot: async (current, root) => {
			replaced = { current, root };
			return replacement;
		},
	});
	assert.equal(typeof click, "function");
	await click({
		target: {
			closest: selector => selector === "[data-qlab-setup-action]"
				? { dataset: { qlabSetupAction: "choose" } }
				: null,
		},
	});
	assert.deepEqual(replaced, { current: original, root: NEW_ROOT });
	assert.equal(view.controller, replacement);
	assert.equal(original.calls.unsubscribe, 1);
	assert.equal(replacement.calls.subscribe, 1);

	await click({
		target: {
			closest: selector => selector === "[data-qlab-setup-action]"
				? { dataset: { qlabSetupAction: "review" } }
				: null,
		},
	});
	assert.equal(original.calls.review, 0);
	assert.equal(replacement.calls.review, 1);
	view.dispose();
	assert.equal(replacement.calls.unsubscribe, 1);
});

test("ready repository selection resolves identity and uses guarded activation", async () => {
	const QLab = await loadQLab();
	let activeRoot = OLD_ROOT;
	let identityWrites = 0;
	let refreshes = [];
	let opened = [];
	let activeHosts = [];
	const coordinator = QLab.createQLabWorkspaceSetupCoordinator({
		hosts: () => activeHosts,
		resolveReadyRepository: async root => {
			identityWrites++;
			return { state: "ready", root, repositoryIdentity: "ready-id" };
		},
		activateRepository: async result => { activeRoot = result.root; return result.root; },
		refreshTargets: async epoch => refreshes.push(epoch),
		openReadyTabs: value => opened.push(value),
	});

	for (const host of [
		{ _qlabTurnHandle: {} },
		{ _qlabDirty: true, _qlabSurfaceMode: "visual" },
		{ _qlabDraftState: { workingPath: "drafts/.ai/proposed.qmd" } },
	]) {
		activeHosts = [host];
		const result = await coordinator.select(NEW_ROOT, inspection(NEW_ROOT));
		assert.equal(result.state, "blocked");
		assert.equal(activeRoot, OLD_ROOT);
		assert.equal(identityWrites, 0);
		assert.deepEqual(refreshes, []);
		assert.deepEqual(opened, []);
	}

	activeHosts = [];
	const result = await coordinator.select(NEW_ROOT, inspection(NEW_ROOT));
	assert.equal(result.root, NEW_ROOT);
	assert.equal(activeRoot, NEW_ROOT);
	assert.equal(identityWrites, 1);
	assert.deepEqual(refreshes, [1]);
	assert.equal(opened.length, 1);
	assert.equal(opened[0].openExample, false);
});

test("blocked ready selection keeps the active repository and presents only safe recovery actions", async () => {
	const QLab = await loadQLab();
	let activeRoot = null;
	let activeHosts = [];
	let identityWrites = 0;
	const refreshes = [];
	const opened = [];
	QLab.normalizeQLabRoot = async path => path;
	QLab.inspectQLabRepository = async root => inspection(root, "ready");
	const coordinator = QLab.createQLabWorkspaceSetupCoordinator({
		hosts: () => activeHosts,
		controllerOptions: {
			inspect: async root => inspection(root, "ready"),
		},
		resolveReadyRepository: async root => {
			identityWrites++;
			return { state: "ready", root, repositoryIdentity: `${root}:identity` };
		},
		activateRepository: async result => {
			activeRoot = result.root;
			return result.root;
		},
		refreshTargets: async epoch => refreshes.push(epoch),
		openReadyTabs: value => opened.push(value),
	});

	await QLab.selectQLabWorkspace({ path: OLD_ROOT, host: {}, coordinator });
	const before = {
		activeRoot,
		identity: coordinator.activeRepositoryIdentity,
		epoch: coordinator.targetEpoch,
		identityWrites,
		refreshCount: refreshes.length,
		openCount: opened.length,
	};
	activeHosts = [{ _qlabTurnHandle: { cancel() {} } }];
	const blocked = await QLab.selectQLabWorkspace({ path: NEW_ROOT, host: {}, coordinator });
	assert.equal(blocked.state, "blocked");

	// Mirrors ZoteroPane's non-modal blocked-selection route into Setup Center.
	await coordinator.open(blocked.root);
	const setupController = coordinator.get(blocked.root);
	setupController.reportError(blocked.reason);
	const snapshot = setupController.snapshot();
	const presentation = setupController.presentation();

	assert.equal(snapshot.root, NEW_ROOT);
	assert.equal(snapshot.repositoryState, "ready");
	assert.equal(snapshot.state, "failed");
	assert.equal(activeRoot, before.activeRoot);
	assert.equal(coordinator.activeRepositoryIdentity, before.identity);
	assert.equal(coordinator.targetEpoch, before.epoch);
	assert.equal(identityWrites, before.identityWrites);
	assert.equal(refreshes.length, before.refreshCount);
	assert.equal(opened.length, before.openCount);
	assert.equal(presentation.title, "Setup needs attention");
	assert.equal(presentation.message, blocked.reason);
	assert.equal(presentation.diagnostics.error, blocked.reason);
	assert.equal(presentation.actions.some(action => action.id === "open"), false);
	assert.equal(presentation.actions.some(action => action.id === "initialize"), false);

	const explicitBlocked = QLab.workspaceSetupPresentation({
		state: "blocked",
		repositoryState: "ready",
		root: NEW_ROOT,
		error: blocked.reason,
	});
	assert.equal(explicitBlocked.title, "Setup needs attention");
	assert.equal(explicitBlocked.message, blocked.reason);
	assert.equal(explicitBlocked.actions.some(action => action.id === "open"), false);
	assert.equal(explicitBlocked.actions.some(action => action.id === "initialize"), false);
});

test("native window activation registers Site and theorem Draft before arranging left and right", async () => {
	const QLab = await loadQLab();
	class Target {
		constructor() { this.listeners = new Map(); }
		addEventListener(type, listener) { this.listeners.set(type, listener); }
		removeEventListener(type) { this.listeners.delete(type); }
	}
	const doc = new Target();
	doc.defaultView = new Target();
	doc.defaultView.innerWidth = 1200;
	doc.defaultView.innerHeight = 800;
	doc.activeElement = null;
	doc.querySelectorAll = () => [];
	const elements = new Map();
	function element() {
		const value = new Target();
		value.hidden = true;
		value.attributes = new Map();
		value.style = { setProperty() {} };
		value.setAttribute = (key, next) => value.attributes.set(key, String(next));
		value.toggleAttribute = () => {};
		value.querySelector = () => null;
		value.contains = target => target === value;
		value.getBoundingClientRect = () => ({ width: 1200, height: 800 });
		return value;
	}
	for (const id of ["qlab-chat-utility-layer", "qlab-chat-utility-dialog", "qlab-chat-utility-content"]) elements.set(id, element());
	const chatShell = {};
	elements.get("qlab-chat-utility-content").querySelector = selector => (
		selector === ".qlab-shell-host" ? chatShell : null
	);
	doc.getElementById = id => elements.get(id) || null;
	doc.querySelector = () => element();
	const tabs = {
		deck: { ownerDocument: doc },
		_tabs: [{ id: "zotero-pane", type: "library", data: {} }],
		selected: null,
		add(spec) {
			const container = element();
			container.id = spec.id;
			container.ownerDocument = doc;
			elements.set(spec.id, container);
			this._tabs.push({ id: spec.id, type: spec.type, data: spec.data || {} });
			return { id: spec.id, container };
		},
		setTabData(id, data) { Object.assign(this._tabs.find(tab => tab.id === id).data, data); },
		select(id) { this.selected = id; },
		_applySplitVisibility() {},
	};
	QLab.mountShellTab = async () => null;
	QLab.cancelShellTabMount = () => {};
	QLab.Settings.setRoot = async root => root;
	QLab.createGeckoQLabPathHost = () => ({});
	const controller = QLab.createWindowController(tabs);
	tabs._qlab = controller;
	await controller.activateInitializedWorkspace({
		state: "ready",
		root: NEW_ROOT,
		repositoryIdentity: "initialized-id",
	});
	const snapshot = controller.groups.snapshot();
	assert.equal(snapshot.paneCount, 2);
	assert.equal(snapshot.groups.left.activeTabID, "qlabsite");
	assert.equal(snapshot.groups.right.activeTabID, "qlabqmd");
	assert.equal(tabs._tabs.find(tab => tab.id === "qlabqmd").data.draftPath,
		"drafts/examples/theorem-blocks.qmd");
	assert.equal(tabs.selected, "qlabqmd");
	assert.equal(elements.get("qlabsite")._qlabTargetEpoch, 1);
	assert.equal(elements.get("qlabqmd")._qlabTargetEpoch, 1);
	assert.equal(chatShell._qlabTargetEpoch, 1);
	controller.destroy();
});

test("ZoteroPane folder selection routes normalized inspection through one coordinator", async () => {
	const QLab = await loadQLab();
	let selected = null;
	QLab.normalizeQLabRoot = async value => `${value}/canonical`;
	QLab.inspectQLabRepository = async root => inspection(root, "ready");
	const coordinator = {
		async selectWorkspace(root, value) {
			selected = { root, value };
			return { state: "ready", root };
		},
	};
	const result = await QLab.selectQLabWorkspace({
		path: "/tmp/chosen",
		host: {},
		coordinator,
	});
	assert.equal(result.root, "/tmp/chosen/canonical");
	assert.equal(selected.root, "/tmp/chosen/canonical");
	assert.equal(selected.value.state, "ready");
});

test("ready repository resolution initializes absent Git before creating private identity", async () => {
	const QLab = await loadQLab();
	let repository = false;
	let initialized = null;
	let identityAfterGit = false;
	QLab.inspectQLabRepository = async root => inspection(root, "ready");
	QLab.createQLabRepositoryIdentity = async ({ root }) => {
		identityAfterGit = repository;
		return { identity: "private-id", root };
	};
	const host = {
		realPath: async root => root,
		normalize: root => root,
		join: (...parts) => parts.join("/"),
		kind: async () => "missing",
	};
	const git = {
		isRepository: async () => repository,
		initialize: async request => {
			initialized = request;
			repository = true;
		},
	};
	const result = await QLab.resolveReadyQLabRepository(NEW_ROOT, {
		host,
		git,
		uuid: () => "unused",
	});
	assert.equal(initialized.executable, "/usr/bin/git");
	assert.deepEqual(Array.from(initialized.argv), ["init"]);
	assert.equal(initialized.cwd, NEW_ROOT);
	assert.equal(identityAfterGit, true);
	assert.equal(result.repositoryIdentity, "private-id");
});
