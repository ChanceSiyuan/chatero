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

function fixtureElement(document, { id = "", className = "" } = {}) {
	const element = {
		id,
		className,
		ownerDocument: document,
		parentNode: null,
		children: [],
		style: {},
		attributes: new Map(),
		get childNodes() { return this.children; },
		setAttribute(name, value) { this.attributes.set(name, String(value)); },
		appendChild(child) {
			child.remove?.();
			this.children.push(child);
			child.parentNode = this;
			return child;
		},
		replaceChildren(...children) {
			for (const child of this.children) child.parentNode = null;
			this.children = [];
			for (const child of children) this.appendChild(child);
		},
		remove() {
			if (!this.parentNode) return;
			const index = this.parentNode.children.indexOf(this);
			if (index >= 0) this.parentNode.children.splice(index, 1);
			this.parentNode = null;
		},
		querySelector(selector) {
			if (selector === ".qlab-shell-host") {
				return this.children.find(child => child.className === "qlab-shell-host") || null;
			}
			return null;
		},
	};
	return element;
}

function installDetachedReadonlyMountFixture(QLab, t, order, {
	mountFailure = null,
} = {}) {
	const originals = {
		qlabRepositoryState: QLab.qlabRepositoryState,
		setHTML: QLab.setHTML,
		ensureKatexStyles: QLab.ensureKatexStyles,
		mountQmdWorkspace: QLab.mountQmdWorkspace,
	};
	const workspaces = [];
	QLab.qlabRepositoryState = async () => "ready";
	QLab.setHTML = () => {};
	QLab.ensureKatexStyles = () => true;
	QLab.mountQmdWorkspace = async (host, options) => {
		order.push("mount-private:qlabqmd");
		if (mountFailure) throw mountFailure;
		const prepared = options.preparedReadonlyMount;
		const claimed = QLab.consumePreparedReadonlyDocumentMount(
			prepared.token, options.readonlyDocumentIO, prepared.relativePath,
		);
		assert.ok(claimed, "private mount consumes the one-shot verified read");
		const session = QLab.createQmdDocumentSession({ verifiedRead: claimed.read });
		let disposed = false;
		const workspace = {
			document: () => disposed ? null : session.document,
			dispose() {
				if (disposed) return;
				disposed = true;
				session.dispose();
				order.push(`dispose:${claimed.descriptor.relativePath}`);
			},
		};
		host._qlabQmdWorkspace = workspace;
		workspaces.push(workspace);
		order.push(`activate:${claimed.descriptor.relativePath}`);
		return workspace;
	};
	t.after(() => Object.assign(QLab, originals));
	return { workspaces };
}

function installWindowFixture(QLab, actionBridges, order, {
	qmdWorkspace = null,
	brokerAvailable = true,
	qmdMountEpoch = 3,
	nativeTabHarness = null,
	siteView = null,
	readonlyDocumentIO = null,
	releaseResult = true,
} = {}) {
	const qmdHost = qmdWorkspace ? {
		className: "qlab-shell-host",
		_qlabQmdWorkspace: qmdWorkspace,
		_qlabMountRoot: ROOT,
		_qlabMountEpoch: qmdMountEpoch,
	} : null;
	let document;
	const qmdContainer = qmdHost ? fixtureElement(null, { id: "qlabqmd" }) : null;
	const siteHost = siteView ? {
		className: "qlab-shell-host",
		_qlabMainSiteView: siteView,
		_qlabMountRoot: ROOT,
		_qlabMountEpoch: 3,
		_qlabRepositoryIdentity: "12345678-1234-4123-8123-123456789abc",
	} : null;
	const siteContainer = siteHost ? fixtureElement(null, { id: "qlabsite" }) : null;
	const elements = new Map([
		...(qmdContainer ? [["qlabqmd", qmdContainer]] : []),
		...(siteContainer ? [["qlabsite", siteContainer]] : []),
	]);
	document = {
		defaultView: {},
		querySelectorAll: () => [],
		getElementById: id => elements.get(id) || null,
		createElementNS: (_namespace, _name) => fixtureElement(document),
	};
	document.documentElement = fixtureElement(document, { className: "document-root" });
	if (qmdContainer) {
		qmdContainer.ownerDocument = document;
		qmdHost.ownerDocument = document;
		qmdContainer.appendChild(qmdHost);
	}
	if (siteContainer) {
		siteContainer.ownerDocument = document;
		siteHost.ownerDocument = document;
		siteContainer.appendChild(siteHost);
	}
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
			return typeof releaseResult === "function"
				? releaseResult(value)
				: releaseResult;
		},
		async readVerifiedDraft(value) {
			return Object.freeze({
				relativePath: value.relativePath,
				text: "fixture Draft\n",
				revision: "fixture-r1",
			});
		},
		async readonlyDocumentIOForRoot() { return readonlyDocumentIO; },
		async destroy() { return true; },
	});
	const tabsAPI = {
		deck: { ownerDocument: document },
		_tabs: [
			...(qmdWorkspace ? [{ id: "qlabqmd", type: "qlabqmd", data: {} }] : []),
			...(siteView ? [{
				id: "qlabsite", type: "qlabsite", data: {
					setupRoot: ROOT,
					repositoryIdentity: "12345678-1234-4123-8123-123456789abc",
					targetEpoch: 3,
					sitePath: "/knowledge/nested/topic.html",
				},
			}] : []),
		],
		_onChatUtilityChanged() {},
	};
	if (nativeTabHarness) {
		tabsAPI.add = input => {
			const id = input.id;
			const container = fixtureElement(document, { id });
			elements.set(id, container);
			tabsAPI._tabs.push({
				id, type: input.type, title: input.title, data: { ...(input.data || {}) },
				onClose: input.onClose,
			});
			nativeTabHarness.events.push(`add:${id}`);
			return { id, container };
		};
		tabsAPI.close = id => {
			const index = tabsAPI._tabs.findIndex(item => item.id === id);
			if (index < 0) return;
			const [tab] = tabsAPI._tabs.splice(index, 1);
			try { tab.onClose?.(); }
			finally {
				elements.delete(id);
				nativeTabHarness.events.push(`close:${id}`);
			}
		};
		tabsAPI.setTabData = (id, update) => {
			const tab = tabsAPI._tabs.find(item => item.id === id);
			if (!tab) return;
			const safeUpdate = tab.type === "qlabsite"
				? QLab.mainSiteTabDataForUpdate(tab.data || {}, update || {})
				: update;
			if (tab.type === "qlabsite") tab.data = { ...safeUpdate };
			else Object.assign(tab.data, safeUpdate);
			nativeTabHarness.events.push(`data:${id}`);
		};
		tabsAPI.select = id => {
			tabsAPI._selectedID = id;
			nativeTabHarness.events.push(`select:${id}`);
		};
		tabsAPI._applySplitVisibility = () => { nativeTabHarness.events.push("layout"); };
		nativeTabHarness.tabs = tabsAPI;
		nativeTabHarness.document = document;
		nativeTabHarness.elements = elements;
	}
	const controller = QLab.createWindowController(
		tabsAPI,
		actionBridges ? { workspaceDocumentBridges: actionBridges } : {},
	);
	tabsAPI._qlab = controller;
	document.defaultView.Zotero_Tabs = tabsAPI;
	return controller;
}

test("production Knowledge Explorer route publishes an exact safe Site path only after release", async t => {
	const QLab = await loadQLab();
	const order = [];
	const native = { events: order };
	const oldMount = QLab.mountShellTab;
	const oldIdentity = QLab.authoritativeMainSiteIdentity;
	QLab.mountShellTab = () => { order.push("mount:qlabsite"); return Promise.resolve(); };
	QLab.authoritativeMainSiteIdentity = async ({ root }) => {
		assert.equal(root, ROOT);
		order.push("identity");
		return Object.freeze({
			identity: "12345678-1234-4123-8123-123456789abc", mismatch: false, ok: true,
		});
	};
	t.after(() => {
		QLab.mountShellTab = oldMount;
		QLab.authoritativeMainSiteIdentity = oldIdentity;
	});
	const controller = installWindowFixture(QLab, null, order, { nativeTabHarness: native });
	const result = await controller.openWorkspaceDocument({
		root: ROOT,
		relativePath: "knowledge/nested/topic.qmd",
		source: "explorer",
		placement: "current",
	});

	assert.equal(result.action, "open-knowledge-site");
	const site = native.tabs._tabs.find(tab => tab.type === "qlabsite");
	assert.deepEqual(JSON.parse(JSON.stringify(site.data)), {
		setupRoot: ROOT,
		repositoryIdentity: "12345678-1234-4123-8123-123456789abc",
		targetEpoch: 3,
		sitePath: "/knowledge/nested/topic.html",
	});
	assert.equal(Object.hasOwn(site.data, "siteURL"), false);
	assert.ok(order.indexOf("release:knowledge/nested/topic.qmd") < order.indexOf("add:qlabsite"));
	assert.equal(order.filter(value => value === "add:qlabsite").length, 1);
	assert.equal(order.filter(value => value === "layout").length, 1);
	controller.destroy();
});

test("production Site Source opens a verified nested QMD beside Site even when QMD tab is absent", async t => {
	const QLab = await loadQLab();
	const order = [];
	const native = { events: order };
	const oldSnapshot = QLab.buildQmdExplorerSnapshot;
	const host = {
		verifyAccess: async () => true,
		realPath: async value => value,
		readVerified: async () => {
			order.push("read:knowledge/nested/topic.qmd");
			return Object.freeze({ text: "# Trusted topic\n", size: 16, lastModified: 7 });
		},
	};
	const readonlyDocumentIO = QLab.createReadonlyDocumentIO({ root: ROOT, host });
	const siteView = {
		snapshot: () => Object.freeze({
			currentOrigin: "http://127.0.0.1:4180",
			lastEmbeddedURL: "http://127.0.0.1:4180/knowledge/nested/topic.html?view=1#proof",
			target: Object.freeze({
				root: ROOT,
				identity: "12345678-1234-4123-8123-123456789abc",
				epoch: 3,
			}),
		}),
	};
	QLab.buildQmdExplorerSnapshot = async root => {
		assert.equal(root, ROOT);
		return [{
			path: "knowledge", kind: "root", children: [{
				path: "knowledge/nested", kind: "directory", children: [{
					path: "knowledge/nested/topic.qmd", kind: "qmd", children: [],
				}],
			}],
		}];
	};
	installDetachedReadonlyMountFixture(QLab, t, order);
	t.after(() => {
		QLab.buildQmdExplorerSnapshot = oldSnapshot;
	});
	const controller = installWindowFixture(QLab, null, order, {
		nativeTabHarness: native,
		siteView,
		readonlyDocumentIO,
	});
	controller.groups.openTab({ kind: "qlabsite", id: "qlabsite", payload: {} }, "left");
	const requestedURL = "http://127.0.0.1:4180/knowledge/nested/topic.html?view=1#proof";
	const result = await controller.openWorkspaceDocument({
		requestedURL,
		source: "site",
		placement: "beside",
	});

	assert.equal(result.action, "open-readonly-qmd", JSON.stringify({ result, order }));
	const qmd = native.tabs._tabs.find(tab => tab.type === "qlabqmd");
	assert.deepEqual(JSON.parse(JSON.stringify(qmd.data)), {
		draftPath: null,
		workspaceDocument: {
			path: "knowledge/nested/topic.qmd",
			authority: "knowledge",
			format: "qmd",
			readOnly: true,
		},
		targetEpoch: 3,
	});
	assert.equal(controller.groups.groupOf("qlabsite"), "left");
	assert.equal(controller.groups.groupOf("qlabqmd"), "right");
	const mountedHost = native.document.getElementById("qlabqmd")
		.querySelector(".qlab-shell-host");
	assert.equal(mountedHost._qlabQmdWorkspace.document().relativePath,
		"knowledge/nested/topic.qmd");
	assert.equal(mountedHost._qlabQmdWorkspace.document().readOnly, true);
	assert.ok(order.indexOf("read:knowledge/nested/topic.qmd")
		< order.indexOf("release:knowledge/nested/topic.qmd"));
	assert.ok(order.indexOf("activate:knowledge/nested/topic.qmd")
		< order.indexOf("release:knowledge/nested/topic.qmd"));
	assert.ok(order.indexOf("release:knowledge/nested/topic.qmd") < order.indexOf("add:qlabqmd"));
	assert.equal(order.filter(value => value === "add:qlabqmd").length, 1);
	assert.equal(order.filter(value => value === "layout").length, 1);
	native.tabs.close("qlabqmd");
	assert.equal(order.filter(value => value === "dispose:knowledge/nested/topic.qmd").length, 1,
		"closing the published native tab disposes its formerly-private workspace");
	controller.destroy();
});

test("Site Source mount rejection disposes its verified read and never publishes a QMD tab", async t => {
	const QLab = await loadQLab();
	const order = [];
	const native = { events: order };
	const oldSnapshot = QLab.buildQmdExplorerSnapshot;
	const oldDispose = QLab.disposePreparedReadonlyDocumentMount;
	let disposedTokens = 0;
	QLab.buildQmdExplorerSnapshot = async () => [{
		path: "knowledge", kind: "root", children: [{
			path: "knowledge/topic.qmd", kind: "qmd", children: [],
		}],
	}];
	QLab.disposePreparedReadonlyDocumentMount = token => {
		const disposed = oldDispose(token);
		if (disposed) disposedTokens++;
		return disposed;
	};
	installDetachedReadonlyMountFixture(QLab, t, order, {
		mountFailure: new Error("fixture mount refused"),
	});
	t.after(() => {
		QLab.buildQmdExplorerSnapshot = oldSnapshot;
		QLab.disposePreparedReadonlyDocumentMount = oldDispose;
	});
	const readonlyDocumentIO = QLab.createReadonlyDocumentIO({
		root: ROOT,
		host: {
			verifyAccess: async () => true,
			realPath: async value => value,
			readVerified: async () => Object.freeze({ text: "# Topic\n", size: 8, lastModified: 1 }),
		},
	});
	const siteView = {
		snapshot: () => Object.freeze({
			currentOrigin: "http://127.0.0.1:4180",
			lastEmbeddedURL: "http://127.0.0.1:4180/knowledge/topic.html",
			target: Object.freeze({
				root: ROOT,
				identity: "12345678-1234-4123-8123-123456789abc",
				epoch: 3,
			}),
		}),
	};
	const controller = installWindowFixture(QLab, null, order, {
		nativeTabHarness: native, siteView, readonlyDocumentIO,
	});
	controller.groups.openTab({ kind: "qlabsite", id: "qlabsite", payload: {} }, "left");
	const result = await controller.openWorkspaceDocument({
		requestedURL: "http://127.0.0.1:4180/knowledge/topic.html",
		source: "site",
		placement: "beside",
	});

	assert.equal(result.action, "refuse");
	assert.equal(disposedTokens, 1);
	assert.equal(native.tabs._tabs.some(tab => tab.type === "qlabqmd"), false);
	assert.equal(order.some(value => value === "layout"), false);
	assert.equal(native.document.documentElement.children.length, 0);
	controller.destroy();
});

test("Site Source epoch change after private mount disposes it before native publication", async t => {
	const QLab = await loadQLab();
	const order = [];
	const native = { events: order };
	const oldSnapshot = QLab.buildQmdExplorerSnapshot;
	QLab.buildQmdExplorerSnapshot = async () => [{
		path: "knowledge", kind: "root", children: [{
			path: "knowledge/topic.qmd", kind: "qmd", children: [],
		}],
	}];
	installDetachedReadonlyMountFixture(QLab, t, order);
	t.after(() => { QLab.buildQmdExplorerSnapshot = oldSnapshot; });
	const readonlyDocumentIO = QLab.createReadonlyDocumentIO({
		root: ROOT,
		host: {
			verifyAccess: async () => true,
			realPath: async value => value,
			readVerified: async () => Object.freeze({ text: "# Topic\n", size: 8, lastModified: 1 }),
		},
	});
	const siteView = {
		snapshot: () => Object.freeze({
			currentOrigin: "http://127.0.0.1:4180",
			lastEmbeddedURL: "http://127.0.0.1:4180/knowledge/topic.html",
			target: Object.freeze({
				root: ROOT,
				identity: "12345678-1234-4123-8123-123456789abc",
				epoch: 3,
			}),
		}),
	};
	let controller;
	controller = installWindowFixture(QLab, null, order, {
		nativeTabHarness: native,
		siteView,
		readonlyDocumentIO,
		releaseResult: () => {
			controller._workspaceTargetEpoch = 4;
			return true;
		},
	});
	controller.groups.openTab({ kind: "qlabsite", id: "qlabsite", payload: {} }, "left");
	const result = await controller.openWorkspaceDocument({
		requestedURL: "http://127.0.0.1:4180/knowledge/topic.html",
		source: "site",
		placement: "beside",
	});

	assert.equal(result.reason, "selected-repository-changed");
	assert.equal(order.filter(value => value === "dispose:knowledge/topic.qmd").length, 1);
	assert.equal(native.tabs._tabs.some(tab => tab.type === "qlabqmd"), false);
	assert.equal(order.some(value => value === "layout"), false);
	controller.destroy();
});

test("Site Source page change after private mount invalidates the route without publication", async t => {
	const QLab = await loadQLab();
	const order = [];
	const native = { events: order };
	const oldSnapshot = QLab.buildQmdExplorerSnapshot;
	QLab.buildQmdExplorerSnapshot = async () => [{
		path: "knowledge", kind: "root", children: [{
			path: "knowledge/topic.qmd", kind: "qmd", children: [],
		}],
	}];
	installDetachedReadonlyMountFixture(QLab, t, order);
	t.after(() => { QLab.buildQmdExplorerSnapshot = oldSnapshot; });
	const readonlyDocumentIO = QLab.createReadonlyDocumentIO({
		root: ROOT,
		host: {
			verifyAccess: async () => true,
			realPath: async value => value,
			readVerified: async () => Object.freeze({ text: "# Topic\n", size: 8, lastModified: 1 }),
		},
	});
	let currentURL = "http://127.0.0.1:4180/knowledge/topic.html";
	const siteView = {
		snapshot: () => Object.freeze({
			currentOrigin: "http://127.0.0.1:4180",
			lastEmbeddedURL: currentURL,
			target: Object.freeze({
				root: ROOT,
				identity: "12345678-1234-4123-8123-123456789abc",
				epoch: 3,
			}),
		}),
	};
	const controller = installWindowFixture(QLab, null, order, {
		nativeTabHarness: native,
		siteView,
		readonlyDocumentIO,
		releaseResult: () => {
			currentURL = "http://127.0.0.1:4180/knowledge/other.html";
			return true;
		},
	});
	controller.groups.openTab({ kind: "qlabsite", id: "qlabsite", payload: {} }, "left");
	const result = await controller.openWorkspaceDocument({
		requestedURL: "http://127.0.0.1:4180/knowledge/topic.html",
		source: "site",
		placement: "beside",
	});

	assert.equal(result.reason, "routing-context-changed");
	assert.equal(order.filter(value => value === "dispose:knowledge/topic.qmd").length, 1);
	assert.equal(native.tabs._tabs.some(tab => tab.type === "qlabqmd"), false);
	assert.equal(order.some(value => value === "layout"), false);
	controller.destroy();
});

test("Site Source missing Explorer metadata is rejected before lease acquisition or document read", async t => {
	const QLab = await loadQLab();
	const order = [];
	const native = { events: order };
	const oldSnapshot = QLab.buildQmdExplorerSnapshot;
	QLab.buildQmdExplorerSnapshot = async () => [{
		path: "knowledge", kind: "root", children: [{
			path: "knowledge/other.qmd", kind: "qmd", children: [],
		}],
	}];
	t.after(() => { QLab.buildQmdExplorerSnapshot = oldSnapshot; });
	const siteView = {
		snapshot: () => Object.freeze({
			currentOrigin: "http://127.0.0.1:4180",
			lastEmbeddedURL: "http://127.0.0.1:4180/knowledge/missing.html",
			target: Object.freeze({
				root: ROOT,
				identity: "12345678-1234-4123-8123-123456789abc",
				epoch: 3,
			}),
		}),
	};
	const controller = installWindowFixture(QLab, null, order, {
		nativeTabHarness: native, siteView,
	});
	controller.groups.openTab({ kind: "qlabsite", id: "qlabsite", payload: {} }, "left");
	const result = await controller.openWorkspaceDocument({
		requestedURL: "http://127.0.0.1:4180/knowledge/missing.html",
		source: "site",
		placement: "beside",
	});

	assert.equal(result.reason, "unsafe-or-missing-knowledge-route");
	assert.equal(order.some(value => value.startsWith("acquire:")), false);
	assert.equal(native.tabs._tabs.some(tab => tab.type === "qlabqmd"), false);
	assert.equal(order.some(value => value === "layout"), false);
	controller.destroy();
});

test("an orphaned closing QMD container blocks singleton reuse without verified reads", async t => {
	const QLab = await loadQLab();
	const order = [];
	const native = { events: order };
	const oldSnapshot = QLab.buildQmdExplorerSnapshot;
	QLab.buildQmdExplorerSnapshot = async () => [{
		path: "knowledge", kind: "root", children: [{
			path: "knowledge/topic.qmd", kind: "qmd", children: [],
		}],
	}];
	t.after(() => { QLab.buildQmdExplorerSnapshot = oldSnapshot; });
	let reads = 0;
	const readonlyDocumentIO = QLab.createReadonlyDocumentIO({
		root: ROOT,
		host: {
			verifyAccess: async () => true,
			realPath: async value => value,
			readVerified: async () => {
				reads++;
				return Object.freeze({ text: "# Topic\n", size: 8, lastModified: 1 });
			},
		},
	});
	const siteView = {
		snapshot: () => Object.freeze({
			currentOrigin: "http://127.0.0.1:4180",
			lastEmbeddedURL: "http://127.0.0.1:4180/knowledge/topic.html",
			target: Object.freeze({
				root: ROOT,
				identity: "12345678-1234-4123-8123-123456789abc",
				epoch: 3,
			}),
		}),
	};
	const controller = installWindowFixture(QLab, null, order, {
		nativeTabHarness: native, siteView, readonlyDocumentIO,
	});
	controller.groups.openTab({ kind: "qlabsite", id: "qlabsite", payload: {} }, "left");
	native.elements.set("qlabqmd", fixtureElement(native.document, { id: "qlabqmd" }));
	const result = await controller.openWorkspaceDocument({
		requestedURL: "http://127.0.0.1:4180/knowledge/topic.html",
		source: "site",
		placement: "beside",
	});

	assert.equal(result.reason, "routing-stage-required");
	assert.equal(reads, 0);
	assert.equal(order.some(value => value === "add:qlabqmd"), false);
	assert.equal(order.some(value => value === "layout"), false);
	controller.destroy();
});

test("failed production Site commit restores tab payload, page, selection, and split layout", async t => {
	const QLab = await loadQLab();
	const order = [];
	const native = { events: order };
	const oldMount = QLab.mountShellTab;
	const oldIdentity = QLab.authoritativeMainSiteIdentity;
	let navigations = 0;
	const siteView = {
		snapshot: () => Object.freeze({
			currentOrigin: "http://127.0.0.1:4180",
			lastEmbeddedURL: "http://127.0.0.1:4180/knowledge/nested/topic.html",
			target: Object.freeze({
				root: ROOT,
				identity: "12345678-1234-4123-8123-123456789abc",
				epoch: 3,
			}),
		}),
		navigatePath() { navigations++; return "refuse"; },
	};
	QLab.mountShellTab = () => Promise.resolve();
	QLab.authoritativeMainSiteIdentity = async () => Object.freeze({
		identity: "12345678-1234-4123-8123-123456789abc", mismatch: false, ok: true,
	});
	t.after(() => {
		QLab.mountShellTab = oldMount;
		QLab.authoritativeMainSiteIdentity = oldIdentity;
	});
	const controller = installWindowFixture(QLab, null, order, {
		nativeTabHarness: native,
		siteView,
	});
	controller.groups.openTab({ kind: "qlabsite", id: "qlabsite", payload: {} }, "left");
	native.tabs._selectedID = "qlabsite";
	const beforeData = structuredClone(native.tabs._tabs.find(tab => tab.id === "qlabsite").data);
	const beforeGroups = structuredClone(controller.groups.serialize());
	const result = await controller.openWorkspaceDocument({
		root: ROOT,
		relativePath: "knowledge/other.qmd",
		source: "explorer",
		placement: "current",
	});

	assert.equal(result.action, "refuse");
	assert.equal(result.reason, "routing-stage-commit-failed");
	assert.equal(navigations, 1);
	assert.deepEqual(
		JSON.parse(JSON.stringify(native.tabs._tabs.find(tab => tab.id === "qlabsite").data)),
		beforeData,
	);
	assert.deepEqual(JSON.parse(JSON.stringify(controller.groups.serialize())), beforeGroups);
	assert.equal(native.tabs._selectedID, "qlabsite");
	assert.equal(siteView.snapshot().lastEmbeddedURL,
		"http://127.0.0.1:4180/knowledge/nested/topic.html");
	controller.destroy();
});

test("Knowledge Site layout failure occurs before navigation and leaves the previous page untouched", async t => {
	const QLab = await loadQLab();
	const order = [];
	const native = { events: order };
	const oldMount = QLab.mountShellTab;
	const oldIdentity = QLab.authoritativeMainSiteIdentity;
	let navigations = 0;
	const siteView = {
		snapshot: () => Object.freeze({
			currentOrigin: "http://127.0.0.1:4180",
			lastEmbeddedURL: "http://127.0.0.1:4180/knowledge/original.html",
			target: Object.freeze({
				root: ROOT,
				identity: "12345678-1234-4123-8123-123456789abc",
				epoch: 3,
			}),
		}),
		navigatePath() { navigations++; return "embed"; },
	};
	QLab.mountShellTab = () => Promise.resolve();
	QLab.authoritativeMainSiteIdentity = async () => Object.freeze({
		identity: "12345678-1234-4123-8123-123456789abc", mismatch: false, ok: true,
	});
	t.after(() => {
		QLab.mountShellTab = oldMount;
		QLab.authoritativeMainSiteIdentity = oldIdentity;
	});
	const controller = installWindowFixture(QLab, null, order, {
		nativeTabHarness: native, siteView,
	});
	controller.groups.openTab({ kind: "qlabsite", id: "qlabsite", payload: {} }, "left");
	controller.groups.openTab({
		kind: "reader", id: "reader:12", payload: { itemID: 12 },
	}, "left");
	controller.groups.activateTab("reader:12");
	const beforeGroups = JSON.parse(JSON.stringify(controller.groups.serialize()));
	native.tabs._applySplitVisibility = () => { throw new Error("fixture layout failure"); };
	const result = await controller.openWorkspaceDocument({
		root: ROOT,
		relativePath: "knowledge/other.qmd",
		source: "explorer",
		placement: "current",
	});

	assert.equal(result.reason, "routing-stage-commit-failed");
	assert.equal(navigations, 0);
	assert.deepEqual(JSON.parse(JSON.stringify(controller.groups.serialize())), beforeGroups);
	assert.equal(siteView.snapshot().lastEmbeddedURL,
		"http://127.0.0.1:4180/knowledge/original.html");
	controller.destroy();
});

test("production Site Source reuses a mounted QMD workspace beside a center Site in three panes", async t => {
	const QLab = await loadQLab();
	const order = [];
	const native = { events: order };
	const oldSnapshot = QLab.buildQmdExplorerSnapshot;
	QLab.buildQmdExplorerSnapshot = async () => [{
		path: "knowledge", kind: "root", children: [{
			path: "knowledge/index.qmd", kind: "qmd", children: [],
		}],
	}];
	t.after(() => { QLab.buildQmdExplorerSnapshot = oldSnapshot; });
	let commits = 0;
	const qmdWorkspace = {
		prepareWorkspaceDocument(decision) {
			assert.equal(decision.relativePath, "knowledge/index.qmd");
			return QLab.createWorkspaceDocumentRouteStage({
				commit() { commits++; order.push("document-commit"); return true; },
				rollback() { order.push("document-rollback"); return true; },
			});
		},
	};
	const siteView = {
		snapshot: () => Object.freeze({
			currentOrigin: "http://127.0.0.1:4180",
			lastEmbeddedURL: "http://127.0.0.1:4180/knowledge/",
			target: Object.freeze({
				root: ROOT,
				identity: "12345678-1234-4123-8123-123456789abc",
				epoch: 3,
			}),
		}),
	};
	const controller = installWindowFixture(QLab, null, order, {
		qmdWorkspace,
		nativeTabHarness: native,
		siteView,
	});
	controller.groups.openTab({ kind: "qlabsite", id: "qlabsite", payload: {} }, "left");
	controller.groups.openTab({ kind: "qlabqmd", id: "qlabqmd", payload: {} }, "left");
	controller.groups.openTab({
		kind: "reader", id: "reader:9", payload: { itemID: 9 },
	}, "right");
	controller.groups.moveTab("qlabsite", "center");
	controller.groups.activateTab("qlabsite");
	const result = await controller.openWorkspaceDocument({
		requestedURL: "http://127.0.0.1:4180/knowledge/",
		source: "site",
		placement: "beside",
	});

	assert.equal(result.action, "open-readonly-qmd");
	assert.equal(commits, 1);
	assert.equal(controller.groups.snapshot().paneCount, 3);
	assert.equal(controller.groups.groupOf("qlabsite"), "center");
	assert.equal(controller.groups.groupOf("qlabqmd"), "right");
	assert.ok(order.indexOf("release:knowledge/index.qmd") < order.indexOf("document-commit"));
	assert.equal(order.filter(value => value === "layout").length, 1);
	controller.destroy();
});

test("mounted Site Source preflight rolls back the document when its Site group disappears", async t => {
	const QLab = await loadQLab();
	const order = [];
	const native = { events: order };
	const oldSnapshot = QLab.buildQmdExplorerSnapshot;
	QLab.buildQmdExplorerSnapshot = async () => [{
		path: "knowledge", kind: "root", children: [{
			path: "knowledge/index.qmd", kind: "qmd", children: [],
		}],
	}];
	t.after(() => { QLab.buildQmdExplorerSnapshot = oldSnapshot; });
	let commits = 0;
	let rollbacks = 0;
	const qmdWorkspace = {
		prepareWorkspaceDocument() {
			return QLab.createWorkspaceDocumentRouteStage({
				commit() { commits++; return true; },
				rollback() { rollbacks++; return true; },
			});
		},
	};
	const siteView = {
		snapshot: () => Object.freeze({
			currentOrigin: "http://127.0.0.1:4180",
			lastEmbeddedURL: "http://127.0.0.1:4180/knowledge/",
			target: Object.freeze({
				root: ROOT,
				identity: "12345678-1234-4123-8123-123456789abc",
				epoch: 3,
			}),
		}),
	};
	let controller;
	controller = installWindowFixture(QLab, null, order, {
		qmdWorkspace,
		nativeTabHarness: native,
		siteView,
		releaseResult: () => {
			controller.groups.closeTab("qlabsite");
			return true;
		},
	});
	controller.groups.openTab({ kind: "qlabsite", id: "qlabsite", payload: {} }, "left");
	controller.groups.openTab({ kind: "qlabqmd", id: "qlabqmd", payload: {} }, "left");
	const result = await controller.openWorkspaceDocument({
		requestedURL: "http://127.0.0.1:4180/knowledge/",
		source: "site",
		placement: "beside",
	});

	assert.equal(result.reason, "routing-stage-commit-failed");
	assert.equal(commits, 0);
	assert.equal(rollbacks, 1);
	assert.equal(order.some(value => value === "layout"), false);
	controller.destroy();
});

test("mounted Site Source placement failure restores panes before rolling back the document", async t => {
	const QLab = await loadQLab();
	const order = [];
	const native = { events: order };
	const oldSnapshot = QLab.buildQmdExplorerSnapshot;
	QLab.buildQmdExplorerSnapshot = async () => [{
		path: "knowledge", kind: "root", children: [{
			path: "knowledge/index.qmd", kind: "qmd", children: [],
		}],
	}];
	t.after(() => { QLab.buildQmdExplorerSnapshot = oldSnapshot; });
	let commits = 0;
	let rollbacks = 0;
	const qmdWorkspace = {
		prepareWorkspaceDocument() {
			return QLab.createWorkspaceDocumentRouteStage({
				commit() { commits++; return true; },
				rollback() { rollbacks++; return true; },
			});
		},
	};
	const siteView = {
		snapshot: () => Object.freeze({
			currentOrigin: "http://127.0.0.1:4180",
			lastEmbeddedURL: "http://127.0.0.1:4180/knowledge/",
			target: Object.freeze({
				root: ROOT,
				identity: "12345678-1234-4123-8123-123456789abc",
				epoch: 3,
			}),
		}),
	};
	const controller = installWindowFixture(QLab, null, order, {
		qmdWorkspace, nativeTabHarness: native, siteView,
	});
	controller.groups.openTab({ kind: "qlabsite", id: "qlabsite", payload: {} }, "left");
	controller.groups.openTab({ kind: "qlabqmd", id: "qlabqmd", payload: {} }, "left");
	controller.groups.openTab({
		kind: "reader", id: "reader:10", payload: { itemID: 10 },
	}, "right");
	controller.groups.moveTab("qlabsite", "center");
	const beforeGroups = JSON.parse(JSON.stringify(controller.groups.serialize()));
	native.tabs._applySplitVisibility = () => { throw new Error("fixture placement failure"); };
	const result = await controller.openWorkspaceDocument({
		requestedURL: "http://127.0.0.1:4180/knowledge/",
		source: "site",
		placement: "beside",
	});

	assert.equal(result.reason, "routing-stage-commit-failed");
	assert.equal(commits, 0);
	assert.equal(rollbacks, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(controller.groups.serialize())), beforeGroups);
	controller.destroy();
});

test("Site Source release failure destroys the prepared read and publishes no QMD or layout", async t => {
	const QLab = await loadQLab();
	const order = [];
	const native = { events: order };
	const oldSnapshot = QLab.buildQmdExplorerSnapshot;
	QLab.buildQmdExplorerSnapshot = async () => [{
		path: "knowledge", kind: "root", children: [{
			path: "knowledge/topic.qmd", kind: "qmd", children: [],
		}],
	}];
	installDetachedReadonlyMountFixture(QLab, t, order);
	t.after(() => {
		QLab.buildQmdExplorerSnapshot = oldSnapshot;
	});
	const readonlyDocumentIO = QLab.createReadonlyDocumentIO({
		root: ROOT,
		host: {
			verifyAccess: async () => true,
			realPath: async value => value,
			readVerified: async () => Object.freeze({ text: "# Topic\n", size: 8, lastModified: 1 }),
		},
	});
	const siteView = {
		snapshot: () => Object.freeze({
			currentOrigin: "http://127.0.0.1:4180",
			lastEmbeddedURL: "http://127.0.0.1:4180/knowledge/topic.html",
			target: Object.freeze({
				root: ROOT,
				identity: "12345678-1234-4123-8123-123456789abc",
				epoch: 3,
			}),
		}),
	};
	const controller = installWindowFixture(QLab, null, order, {
		nativeTabHarness: native,
		siteView,
		readonlyDocumentIO,
		releaseResult: false,
	});
	controller.groups.openTab({ kind: "qlabsite", id: "qlabsite", payload: {} }, "left");
	const before = JSON.parse(JSON.stringify(controller.groups.serialize()));
	const result = await controller.openWorkspaceDocument({
		requestedURL: "http://127.0.0.1:4180/knowledge/topic.html",
		source: "site",
		placement: "beside",
	});

	assert.equal(result.reason, "document-lease-release-failed");
	assert.equal(order.filter(value => value === "dispose:knowledge/topic.qmd").length, 1);
	assert.equal(native.tabs._tabs.some(tab => tab.type === "qlabqmd"), false);
	assert.equal(native.document.documentElement.children.length, 0,
		"the connected private mount stage is removed");
	assert.equal(order.some(value => value === "add:qlabqmd"), false);
	assert.equal(order.some(value => value === "layout"), false);
	assert.deepEqual(JSON.parse(JSON.stringify(controller.groups.serialize())), before);
	controller.destroy();
});

test("an existing QMD tab without a mount container cannot consume or publish a Site Source route", async t => {
	const QLab = await loadQLab();
	const order = [];
	const native = { events: order };
	const oldSnapshot = QLab.buildQmdExplorerSnapshot;
	QLab.buildQmdExplorerSnapshot = async () => [{
		path: "knowledge", kind: "root", children: [{
			path: "knowledge/topic.qmd", kind: "qmd", children: [],
		}],
	}];
	t.after(() => {
		QLab.buildQmdExplorerSnapshot = oldSnapshot;
	});
	let reads = 0;
	const readonlyDocumentIO = QLab.createReadonlyDocumentIO({
		root: ROOT,
		host: {
			verifyAccess: async () => true,
			realPath: async value => value,
			readVerified: async () => {
				reads++;
				return Object.freeze({ text: "# Topic\n", size: 8, lastModified: 1 });
			},
		},
	});
	const siteView = {
		snapshot: () => Object.freeze({
			currentOrigin: "http://127.0.0.1:4180",
			lastEmbeddedURL: "http://127.0.0.1:4180/knowledge/topic.html",
			target: Object.freeze({
				root: ROOT,
				identity: "12345678-1234-4123-8123-123456789abc",
				epoch: 3,
			}),
		}),
	};
	const controller = installWindowFixture(QLab, null, order, {
		nativeTabHarness: native,
		siteView,
		readonlyDocumentIO,
	});
	controller.groups.openTab({ kind: "qlabsite", id: "qlabsite", payload: {} }, "left");
	const oldData = { draftPath: "drafts/old.qmd", targetEpoch: 3 };
	native.tabs._tabs.push({ id: "qlabqmd", type: "qlabqmd", data: { ...oldData } });
	controller.groups.openTab({ kind: "qlabqmd", id: "qlabqmd", payload: oldData }, "left");
	controller.groups.activateTab("qlabsite");
	const beforeGroups = JSON.parse(JSON.stringify(controller.groups.serialize()));
	const result = await controller.openWorkspaceDocument({
		requestedURL: "http://127.0.0.1:4180/knowledge/topic.html",
		source: "site",
		placement: "beside",
	});

	assert.equal(result.reason, "routing-stage-required");
	assert.equal(reads, 0, "container refusal happens before verified bytes are read");
	assert.deepEqual(native.tabs._tabs.find(tab => tab.id === "qlabqmd").data, oldData);
	assert.equal(order.some(value => value === "layout"), false);
	assert.deepEqual(JSON.parse(JSON.stringify(controller.groups.serialize())), beforeGroups);
	controller.destroy();
});

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
