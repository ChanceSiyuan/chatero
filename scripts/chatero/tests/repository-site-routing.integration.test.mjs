import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const ROOT = "/tmp/synthetic-research-loop";

function capability(request) {
	return Object.freeze({
		root: request.root,
		relativePath: request.relativePath,
		canonicalPath: `${request.root}/${request.relativePath}`,
		authority: request.authority,
		kind: request.kind,
		writable: request.writable,
		access: Object.freeze({ path: request.relativePath }),
	});
}

function rowEvent(relativePath = "") {
	const row = relativePath ? {
		dataset: { qlabDocumentRow: relativePath, qlabDraftRow: relativePath },
		disabled: false,
	} : null;
	return {
		row,
		stopped: 0,
		target: {
			closest(selector) {
				if (selector === "[data-qlab-document-row]") return row;
				if (selector === "[data-qlab-draft-row]") return row;
				return null;
			},
		},
		preventDefault() {},
		stopImmediatePropagation() { this.stopped++; },
	};
}

function installWindowFixture(QLab, actionBridges, order, {
	qmdWorkspace = null,
	brokerAvailable = true,
	qmdMountEpoch = 3,
} = {}) {
	const qmdHost = qmdWorkspace ? {
		_qlabQmdWorkspace: qmdWorkspace,
		_qlabMountRoot: ROOT,
		_qlabMountEpoch: qmdMountEpoch,
	} : null;
	const qmdContainer = qmdHost ? {
		querySelector: selector => selector === ".qlab-shell-host" ? qmdHost : null,
	} : null;
	const document = {
		defaultView: {},
		querySelectorAll: () => [],
		getElementById: id => id === "qlabqmd" ? qmdContainer : null,
	};
	QLab.ChatUtilityHost = class {
		snapshot() { return { pinned: false, bounds: {} }; }
		destroy() {}
		refreshWorkspace() { return Promise.resolve(); }
	};
	QLab.ChatOutsideInteractionBridge = class { dispose() {} };
	QLab.createQLabWorkspaceSetupCoordinator = () => ({
		targetEpoch: 3,
		workspaceSwitchBlocker: () => null, get: () => null, restore: () => null,
		replaceRoot: () => null, select: () => null, open: () => null,
		activateInitializedWorkspace: () => null, dispose() {},
	});
	QLab.Settings.getRoot = () => ROOT;
	QLab.createGeckoQLabPathHost = () => ({ realPath: async value => value });
	QLab.registerMainSiteController = null;
	QLab.createGeckoWorkspaceDocumentLeaseHost = () => {
		if (!brokerAvailable) throw new Error("native broker unavailable");
		return { marker: "lease-host" };
	};
	QLab.createWindowWorkspaceDocumentAccess = () => ({
		async acquireVerifiedDocument(request) {
			order.push(`acquire:${request.relativePath}`);
			return capability({ ...request, root: ROOT });
		},
		async releaseVerifiedDocument(value) {
			order.push(`release:${value.relativePath}`);
			return true;
		},
		async readVerifiedDraft(value) {
			return Object.freeze({
				relativePath: value.relativePath,
				text: "fixture Draft\n",
				revision: "fixture-r1",
			});
		},
		async readonlyDocumentIOForRoot() { return null; },
		async destroy() { return true; },
	});
	const tabsAPI = {
		deck: { ownerDocument: document },
		_tabs: qmdWorkspace ? [{ id: "qlabqmd", type: "qlabqmd" }] : [],
		_onChatUtilityChanged() {},
	};
	const controller = QLab.createWindowController(
		tabsAPI,
		actionBridges ? { workspaceDocumentBridges: actionBridges } : {},
	);
	tabsAPI._qlab = controller;
	document.defaultView.Zotero_Tabs = tabsAPI;
	return controller;
}

test("broker-unavailable fallback opens only an exact mounted Draft row", async () => {
	const QLab = await loadQLab();
	const order = [];
	let draftOpens = 0;
	const preparedDraft = Object.freeze(Object.create(null));
	const qmdWorkspace = {
		async prepareDraftRoute(relativePath) {
			draftOpens++;
			order.push(`draft:${relativePath}`);
			return preparedDraft;
		},
		commitPreparedDraftRoute(token) { return token === preparedDraft; },
		rollbackPreparedDraftRoute(token) { return token === preparedDraft; },
	};
	const controller = installWindowFixture(QLab, null, order, {
		qmdWorkspace,
		brokerAvailable: false,
	});
	const delegate = QLab.createQmdExplorerDocumentDelegate({
		root: ROOT,
		route: input => controller.openWorkspaceDocument(input),
	});
	const opened = await delegate(rowEvent("drafts/a.qmd"));
	assert.equal(opened.action, "open-draft");
	assert.equal(draftOpens, 1);

	for (const relativePath of [
		"knowledge/topic.qmd",
		"literature/paper.md",
		"literature/ref.bib",
		"literature/paper.pdf",
	]) {
		const result = await controller.openWorkspaceDocument({
			root: ROOT, relativePath, source: "explorer", placement: "current",
		});
		assert.equal(result.action, "refuse", relativePath);
	}
	assert.equal((await controller.openWorkspaceDocument({
		root: "/tmp/foreign",
		relativePath: "drafts/a.qmd",
		source: "explorer",
		placement: "current",
	})).action, "refuse");
	assert.equal(draftOpens, 1);
	controller.destroy();

	const stale = installWindowFixture(QLab, null, [], {
		qmdWorkspace,
		brokerAvailable: false,
		qmdMountEpoch: 2,
	});
	assert.equal((await stale.openWorkspaceDocument({
		root: ROOT,
		relativePath: "drafts/a.qmd",
		source: "explorer",
		placement: "current",
	})).action, "refuse");
	assert.equal(draftOpens, 1);
	stale.destroy();
});

test("broker-unavailable Draft fallback cannot publish after the repository epoch changes", async () => {
	const QLab = await loadQLab();
	const order = [];
	let continuePreparation;
	let preparationStarted;
	const prepared = new Promise(resolve => { continuePreparation = resolve; });
	const started = new Promise(resolve => { preparationStarted = resolve; });
	const token = Object.freeze(Object.create(null));
	let directPublishes = 0;
	let commits = 0;
	let rollbacks = 0;
	const qmdWorkspace = {
		async openDraft() {
			preparationStarted();
			await prepared;
			directPublishes++;
			return true;
		},
		async prepareDraftRoute() {
			preparationStarted();
			await prepared;
			return token;
		},
		commitPreparedDraftRoute(value) {
			assert.equal(value, token);
			commits++;
			return true;
		},
		rollbackPreparedDraftRoute(value) {
			assert.equal(value, token);
			rollbacks++;
			return true;
		},
	};
	const controller = installWindowFixture(QLab, null, order, {
		qmdWorkspace,
		brokerAvailable: false,
	});

	const opening = controller.openWorkspaceDocument({
		root: ROOT,
		relativePath: "drafts/a.qmd",
		source: "explorer",
		placement: "current",
	});
	await started;
	controller._workspaceTargetEpoch = 4;
	continuePreparation();

	assert.equal((await opening).action, "refuse");
	assert.equal(directPublishes, 0, "the fallback cannot call a directly publishing Draft API");
	assert.equal(commits, 0);
	assert.equal(rollbacks, 1);
	controller.destroy();
});

test("a mounted Explorer Draft click dispatches exactly once through the production controller", async t => {
	const QLab = await loadQLab();
	const order = [];
	let preparations = 0;
	let commits = 0;
	let legacyLoads = 0;
	const oldLoad = QLab.loadDraftIntoShell;
	QLab.loadDraftIntoShell = async () => { legacyLoads++; return true; };
	t.after(() => { QLab.loadDraftIntoShell = oldLoad; });
	const qmdWorkspace = {
		prepareWorkspaceDocument(decision) {
			preparations++;
			order.push(`prepare:${decision.action}`);
			return QLab.createWorkspaceDocumentRouteStage({
				commit() { commits++; order.push("commit"); return true; },
				rollback() { order.push("rollback"); return true; },
			});
		},
	};
	const controller = installWindowFixture(QLab, null, order, { qmdWorkspace });
	const delegate = QLab.createQmdExplorerDocumentDelegate({
		root: ROOT,
		route: input => controller.openWorkspaceDocument(input),
	});
	const event = rowEvent("drafts/a.qmd");
	const result = await delegate(event);
	assert.equal(result.action, "open-draft");
	const legacyHandled = QLab.runLegacyDraftRowRoute({
		host: { _qlabQmdWorkspace: qmdWorkspace },
		root: ROOT,
		row: event.row,
	});

	assert.equal(event.stopped, 1, "the delegated handler stops the later legacy host handler");
	assert.equal(legacyHandled, false, "mounted workspace rows cannot use the legacy path");
	assert.equal(preparations, 1);
	assert.equal(commits, 1);
	assert.equal(legacyLoads, 0);
	assert.deepEqual(order, [
		"acquire:drafts/a.qmd", "prepare:open-draft", "release:drafts/a.qmd", "commit",
	]);
	controller.destroy();
});

test("delegated Explorer rows route through the window controller and commit only staged native actions", async () => {
	const QLab = await loadQLab();
	const order = [];
	const committed = [];
	const stage = action => QLab.createWorkspaceDocumentRouteStage({
		commit() { order.push(`commit:${action}`); committed.push(action); return true; },
		rollback() { order.push(`rollback:${action}`); return true; },
	});
	const controller = installWindowFixture(QLab, {
		openDraft: decision => { order.push(`prepare:${decision.action}`); return stage(decision.action); },
		openKnowledgeSite: decision => { order.push(`prepare:${decision.action}`); return stage(decision.action); },
		openReadonlyQmd: decision => { order.push(`prepare:${decision.action}`); return stage(decision.action); },
		openReadonlyBib: decision => { order.push(`prepare:${decision.action}`); return stage(decision.action); },
	}, order);
	let routeCalls = 0;
	const delegate = QLab.createQmdExplorerDocumentDelegate({
		root: ROOT,
		route: input => {
			routeCalls++;
			return controller.openWorkspaceDocument(input);
		},
	});

	assert.equal(await delegate(rowEvent()), false, "folder/summary clicks do not route");
	for (const relativePath of [
		"drafts/a.qmd",
		"knowledge/topic.qmd",
		"literature/paper.md",
		"literature/ref.bib",
	]) {
		const result = await delegate(rowEvent(relativePath));
		assert.notEqual(result.action, "refuse", relativePath);
	}
	assert.equal(routeCalls, 4);
	assert.deepEqual(committed, [
		"open-draft", "open-knowledge-site", "open-readonly-qmd", "open-readonly-bib",
	]);
	for (let index = 0; index < order.length; index += 4) {
		assert.match(order[index], /^acquire:/);
		assert.match(order[index + 1], /^prepare:/);
		assert.match(order[index + 2], /^release:/);
		assert.match(order[index + 3], /^commit:/);
	}
	for (const action of committed) {
		const release = order.findIndex(value => value.startsWith("release:"), order.indexOf(`prepare:${action}`));
		assert.ok(release < order.indexOf(`commit:${action}`), action);
	}
	controller.destroy();
});

test("Explorer HTML marks only files as delegated document rows", async () => {
	const QLab = await loadQLab();
	const html = QLab.renderQmdExplorerHTML([{
		path: "knowledge", name: "knowledge", kind: "root", children: [{
			path: "knowledge/section", name: "section", kind: "directory", children: [{
				path: "knowledge/section/topic.qmd", name: "topic.qmd", kind: "qmd",
				writable: false, children: [],
			}],
		}],
	}]);
	assert.match(html, /data-qlab-document-row="knowledge\/section\/topic\.qmd"/);
	assert.doesNotMatch(html, /<summary[^>]*data-qlab-document-row/);
});

test("external Explorer refresh preserves present documents and fails closed when active readonly disappears", async () => {
	const QLab = await loadQLab();
	const readonly = Object.freeze({ relativePath: "knowledge/topic.qmd", readOnly: true });
	const draft = Object.freeze({ relativePath: "drafts/a.qmd", readOnly: false });
	const snapshot = [{
		path: "knowledge", children: [{ path: readonly.relativePath, children: [] }],
	}];
	let reloads = 0;
	let closed = 0;
	let observedDrafts = 0;
	assert.equal(await QLab.reconcileQmdExplorerActiveDocument({
		snapshot,
		activeDocument: readonly,
		reloadReadonly: async () => { reloads++; },
		failClosedReadonly: () => { closed++; },
		observeDraft: async () => { observedDrafts++; },
	}), "reloaded-readonly");
	assert.equal(reloads, 1);
	assert.equal(closed, 0);

	assert.equal(await QLab.reconcileQmdExplorerActiveDocument({
		snapshot: [], activeDocument: readonly,
		reloadReadonly: async () => { reloads++; },
		failClosedReadonly: () => { closed++; },
		observeDraft: async () => { observedDrafts++; },
	}), "closed-missing-readonly");
	assert.equal(closed, 1);

	assert.equal(await QLab.reconcileQmdExplorerActiveDocument({
		snapshot: [], activeDocument: draft,
		reloadReadonly: async () => { reloads++; },
		failClosedReadonly: () => { closed++; },
		observeDraft: async () => { observedDrafts++; },
	}), "preserved-missing-draft");
	assert.equal(observedDrafts, 0);
});
