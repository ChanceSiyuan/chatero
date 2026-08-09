import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

class FakeEventTarget {
	constructor() {
		this.listeners = new Map();
	}

	addEventListener(type, listener) {
		let listeners = this.listeners.get(type) || [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type, listener) {
		let listeners = this.listeners.get(type) || [];
		this.listeners.set(type, listeners.filter(candidate => candidate !== listener));
	}

	dispatch(type, event = {}) {
		event.type = type;
		event.target = event.target || this;
		for (let listener of this.listeners.get(type) || []) {
			listener(event);
		}
	}
}

class FakeElement extends FakeEventTarget {
	constructor() {
		super();
		this.hidden = true;
		this.attributes = new Map();
		this.styleValues = new Map();
		this.style = {
			setProperty: (name, value) => this.styleValues.set(name, String(value)),
			removeProperty: name => this.styleValues.delete(name),
		};
		this.focusCount = 0;
		this.capture = [];
		this._queries = new Map();
	}

	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}

	removeAttribute(name) {
		this.attributes.delete(name);
	}

	toggleAttribute(name, force) {
		if (force) this.attributes.set(name, "");
		else this.attributes.delete(name);
	}

	getAttribute(name) {
		return this.attributes.get(name) ?? null;
	}

	querySelector(selector) {
		return this._queries.get(selector) || null;
	}

	register(selector, element) {
		this._queries.set(selector, element);
	}

	contains(target) {
		return target === this;
	}

	focus() {
		this.focusCount++;
	}

	setPointerCapture(pointerId) {
		this.capture.push(pointerId);
	}
}

function utilityElements() {
	let elements = {
		layer: new FakeElement(),
		dialog: new FakeElement(),
		content: new FakeElement(),
		header: new FakeElement(),
		pinButton: new FakeElement(),
		hideButton: new FakeElement(),
		resizeHandle: new FakeElement(),
	};
	elements.layer.hidden = true;
	return elements;
}

test("Chat utility reuses one resident shell while hidden, closed, reopened, and streaming", async () => {
	const QLab = await loadQLab();
	const elements = utilityElements();
	let mounts = 0;
	let disposals = 0;
	let cancellations = 0;
	let runtime;
	const residentHost = {
		_qlabTurnHandle: { cancel: () => cancellations++ },
	};
	const utility = new QLab.ChatUtilityHost({
		elements,
		viewport: () => ({ width: 1440, height: 900 }),
		mountChat: async (container) => {
			mounts++;
			runtime ||= { chunks: [], running: true };
			container.runtime = runtime;
			container.register(".qlab-shell-host", residentHost);
			return runtime;
		},
		cancelTurn: host => host._qlabTurnHandle.cancel(),
		disposeChat: () => disposals++,
	});

	await utility.show({ invocation: "reader-action" });
	runtime.chunks.push("first");
	utility.hide();
	utility.closeLauncher();
	assert.equal(disposals, 0, "launcher close must not dispose the Agent stream");

	await utility.show({ invocation: "native-tab" });
	runtime.chunks.push("second");
	assert.equal(mounts, 1, "the full Chat shell mounts once per window");
	assert.deepEqual(runtime.chunks, ["first", "second"]);
	assert.equal(elements.content.runtime, runtime);
	assert.equal(elements.layer.hidden, false);

	utility.destroy();
	utility.destroy();
	assert.equal(cancellations, 1, "window shutdown cancels a resident turn once");
	assert.equal(disposals, 1, "window shutdown owns final disposal");
});

test("workspace refresh preserves lazy Chat mounting when no resident shell exists", async () => {
	const QLab = await loadQLab();
	const elements = utilityElements();
	let mounts = 0;
	const utility = new QLab.ChatUtilityHost({
		elements,
		viewport: () => ({ width: 1200, height: 800 }),
		mountChat: async () => {
			mounts++;
			return {};
		},
	});

	await utility.refreshWorkspace();
	assert.equal(mounts, 0, "choosing a workspace must not open Chat implicitly");
	assert.equal(utility.snapshot().mounted, false);
	utility.destroy();
});

test("Chat launcher routing preserves selected content identity and cycles only content tabs", async () => {
	const QLab = await loadQLab();
	const calls = [];
	const tabsAPI = {
		_selectedID: "reader-42",
		_qlab: {
			toggleUtility: (kind, options) => calls.push({ kind, options }),
		},
		_update() {
			calls.push({ updated: true });
		},
	};
	const selectedType = "reader";
	const reader = { tabID: "reader-42" };
	const closeTarget = tabsAPI._selectedID;
	const undoDepth = 3;

	assert.equal(
		QLab.routeUtilityLauncherSelection(
			tabsAPI,
			{ id: "qlabchat", type: "qlabchat" },
			{ focusReturn: "reader-focus" },
		),
		true,
	);
	assert.equal(tabsAPI._selectedID, "reader-42");
	assert.equal(selectedType, "reader");
	assert.equal(reader.tabID, "reader-42");
	assert.equal(closeTarget, "reader-42");
	assert.equal(undoDepth, 3);
	assert.deepEqual(calls[0], {
		kind: "qlabchat",
		options: { focusReturn: "reader-focus" },
	});

	const tabs = [
		{ id: "zotero-pane", type: "library" },
		{ id: "reader-42", type: "reader" },
		{ id: "qlabchat", type: "qlabchat" },
		{ id: "qlabqmd", type: "qlabqmd" },
	];
	assert.equal(QLab.nextContentTabID(tabs, "reader-42", 1), "qlabqmd");
	assert.equal(QLab.nextContentTabID(tabs, "qlabqmd", 1), "zotero-pane");
	assert.equal(QLab.nextContentTabID(tabs, "zotero-pane", -1), "qlabqmd");
	assert.equal(
		QLab.contentTabAfterClose(
			[
				{ id: "zotero-pane", type: "library" },
				{ id: "reader-42", type: "reader" },
				{ id: "qlabchat", type: "qlabchat" },
			],
			"reader-42",
			["reader-42"],
			null,
		),
		"zotero-pane",
		"closing content must never choose the Chat launcher as replacement content",
	);
});

test("Pin, hide, drag, and resize update presentation without persisting pointer previews", async () => {
	const QLab = await loadQLab();
	const elements = utilityElements();
	const fakeWindow = new FakeEventTarget();
	let persisted = [];
	const utility = new QLab.ChatUtilityHost({
		elements,
		window: fakeWindow,
		viewport: () => ({ width: 1440, height: 900 }),
		mountChat: async () => ({}),
		persist: state => persisted.push(state),
	});
	await utility.show();

	elements.pinButton.dispatch("click");
	assert.equal(utility.snapshot().pinned, true);
	assert.equal(elements.pinButton.getAttribute("aria-pressed"), "true");
	assert.equal(persisted.length, 1);
	const pinIcon = {};
	elements.pinButton.contains = target => target === pinIcon;
	elements.header.dispatch("pointerdown", {
		target: pinIcon,
		button: 0,
		pointerId: 6,
		clientX: 90,
		clientY: 90,
		preventDefault() {},
	});
	fakeWindow.dispatch("pointermove", { pointerId: 6, clientX: 200, clientY: 200 });
	fakeWindow.dispatch("pointerup", { pointerId: 6, clientX: 200, clientY: 200 });
	assert.equal(persisted.length, 1, "pressing the Pin icon must not start a drag");

	elements.header.dispatch("pointerdown", {
		button: 0,
		pointerId: 7,
		clientX: 100,
		clientY: 100,
		preventDefault() {},
	});
	fakeWindow.dispatch("pointermove", { pointerId: 7, clientX: 180, clientY: 140 });
	assert.equal(persisted.length, 1, "drag previews must not persist per pointer move");
	fakeWindow.dispatch("pointerup", { pointerId: 7, clientX: 180, clientY: 140 });
	assert.equal(persisted.length, 2, "drag persists once after pointer release");

	elements.resizeHandle.dispatch("pointerdown", {
		button: 0,
		pointerId: 8,
		clientX: 820,
		clientY: 780,
		preventDefault() {},
	});
	fakeWindow.dispatch("pointermove", { pointerId: 8, clientX: 900, clientY: 840 });
	assert.equal(persisted.length, 2);
	fakeWindow.dispatch("pointerup", { pointerId: 8, clientX: 900, clientY: 840 });
	assert.equal(persisted.length, 3, "resize persists once after pointer release");

	elements.hideButton.dispatch("click");
	assert.equal(utility.snapshot().visibility, "hidden");
	assert.equal(elements.layer.hidden, true);
	utility.destroy();
});

test("cancelled drag and lost resize capture roll preview bounds back without persisting", async () => {
	const QLab = await loadQLab();
	const elements = utilityElements();
	const fakeWindow = new FakeEventTarget();
	let persists = 0;
	const utility = new QLab.ChatUtilityHost({
		elements,
		window: fakeWindow,
		viewport: () => ({ width: 1440, height: 900 }),
		mountChat: async () => ({}),
		persist: () => persists++,
	});
	await utility.show();
	const original = utility.snapshot().bounds;

	elements.header.dispatch("pointerdown", {
		button: 0,
		pointerId: 31,
		clientX: 100,
		clientY: 100,
		preventDefault() {},
	});
	fakeWindow.dispatch("pointermove", { pointerId: 31, clientX: 250, clientY: 220 });
	assert.notEqual(elements.dialog.styleValues.get("--qlab-chat-left"), `${original.left}px`);
	fakeWindow.dispatch("pointercancel", { pointerId: 31 });
	assert.equal(elements.dialog.styleValues.get("--qlab-chat-left"), `${original.left}px`);
	fakeWindow.dispatch("pointerup", { pointerId: 31, clientX: 250, clientY: 220 });
	assert.equal(persists, 0);

	elements.resizeHandle.dispatch("pointerdown", {
		button: 0,
		pointerId: 32,
		clientX: 800,
		clientY: 700,
		preventDefault() {},
	});
	fakeWindow.dispatch("pointermove", { pointerId: 32, clientX: 900, clientY: 800 });
	assert.notEqual(elements.dialog.styleValues.get("--qlab-chat-width"), `${original.width}px`);
	elements.resizeHandle.dispatch("lostpointercapture", { pointerId: 32 });
	assert.equal(elements.dialog.styleValues.get("--qlab-chat-width"), `${original.width}px`);
	fakeWindow.dispatch("pointerup", { pointerId: 32, clientX: 900, clientY: 800 });
	assert.equal(persists, 0);
	utility.destroy();
});

test("each public show captures the current active element unless explicitly overridden", async () => {
	const QLab = await loadQLab();
	const elements = utilityElements();
	const first = new FakeElement();
	const second = new FakeElement();
	const explicit = new FakeElement();
	const doc = { activeElement: first };
	const utility = new QLab.ChatUtilityHost({
		document: doc,
		elements,
		viewport: () => ({ width: 1200, height: 800 }),
		mountChat: async () => ({}),
	});

	await utility.show({ invocation: "arrangement" });
	doc.activeElement = second;
	utility.hide();
	assert.equal(first.focusCount, 1);
	await utility.show({ invocation: "legacy-dock" });
	doc.activeElement = first;
	utility.hide();
	assert.equal(second.focusCount, 1, "a new show cannot reuse stale focus return");
	await utility.show({ focusReturn: explicit });
	utility.hide();
	assert.equal(explicit.focusCount, 1);
	utility.destroy();
});

test("Chat launcher exposes running, completed, and error status without remounting", async () => {
	const QLab = await loadQLab();
	const elements = utilityElements();
	const statuses = [];
	let mounts = 0;
	const utility = new QLab.ChatUtilityHost({
		elements,
		viewport: () => ({ width: 1200, height: 800 }),
		mountChat: async () => {
			mounts++;
			return {};
		},
		onLauncherChange: state => statuses.push(state),
	});
	await utility.ensureMounted();
	for (let status of ["running", "completed", "error"]) {
		utility.setActivityStatus(status);
	}
	assert.deepEqual(statuses.slice(-3).map(state => state.activityStatus), [
		"running",
		"completed",
		"error",
	]);
	assert.equal(mounts, 1);
	utility.destroy();
});

test("Chat launcher subscribers receive live state, late replay, read acknowledgement, and cleanup", async () => {
	const QLab = await loadQLab();
	const elements = utilityElements();
	const utility = new QLab.ChatUtilityHost({
		elements,
		viewport: () => ({ width: 1200, height: 800 }),
		mountChat: async () => ({}),
	});
	const first = [];
	const second = [];

	const unsubscribeFirst = utility.subscribeLauncher(state => first.push(state.activityStatus));
	assert.deepEqual(first, ["idle"], "an existing Reader launcher reads the current state immediately");
	utility.setActivityStatus("running");
	utility.setActivityStatus("completed");
	assert.deepEqual(first, ["idle", "running", "completed"]);

	const unsubscribeSecond = utility.subscribeLauncher(state => second.push(state.activityStatus));
	assert.deepEqual(second, ["completed"], "a newly rendered popup launcher replays unread state");
	await utility.show();
	assert.equal(utility.snapshot().activityStatus, "idle");
	assert.equal(first.at(-1), "idle", "viewing Chat clears completed for existing launchers");
	assert.equal(second.at(-1), "idle", "viewing Chat clears completed for new launchers");

	unsubscribeFirst();
	utility.setActivityStatus("error");
	assert.equal(first.at(-1), "idle", "a released Reader document no longer receives updates");
	assert.equal(second.at(-1), "error");
	unsubscribeSecond();
	utility.destroy();
});

test("completed Agent replies are unread only while Chat is hidden and clear on reveal", async () => {
	const QLab = await loadQLab();
	const elements = utilityElements();
	const utility = new QLab.ChatUtilityHost({
		elements,
		viewport: () => ({ width: 1200, height: 800 }),
		mountChat: async () => ({}),
	});

	await utility.ensureMounted();
	utility.setActivityStatus("completed");
	assert.equal(utility.snapshot().activityStatus, "completed");

	await utility.show();
	assert.equal(
		utility.snapshot().activityStatus,
		"idle",
		"revealing Chat marks the completed response as read",
	);

	utility.setActivityStatus("running");
	utility.setActivityStatus("completed");
	assert.equal(
		utility.snapshot().activityStatus,
		"idle",
		"a response completed while Chat is visible must not create unread state",
	);

	utility.hide();
	utility.setActivityStatus("completed");
	assert.equal(utility.snapshot().activityStatus, "completed");
	await utility.show();
	assert.equal(utility.snapshot().activityStatus, "idle");
	utility.destroy();
});

test("a failed Chat mount reports an error and can retry without rejecting window actions", async () => {
	const QLab = await loadQLab();
	const elements = utilityElements();
	let attempts = 0;
	const utility = new QLab.ChatUtilityHost({
		elements,
		viewport: () => ({ width: 1200, height: 800 }),
		mountChat: () => {
			attempts++;
			if (attempts === 1) throw new Error("mount failed");
			return { ready: true };
		},
	});

	await assert.doesNotReject(utility.show());
	assert.equal(utility.snapshot().activityStatus, "error");
	assert.equal(utility.snapshot().mounted, false);
	utility.hide();
	await assert.doesNotReject(utility.show());
	assert.equal(utility.snapshot().mounted, true);
	assert.equal(utility.snapshot().activityStatus, "idle");
	assert.equal(attempts, 2);
	utility.destroy();
});

test("successful retry does not clear a genuine turn error that replaced a mount error", async () => {
	const QLab = await loadQLab();
	const elements = utilityElements();
	let attempts = 0;
	const utility = new QLab.ChatUtilityHost({
		elements,
		viewport: () => ({ width: 1200, height: 800 }),
		mountChat: () => {
			attempts++;
			if (attempts === 1) throw new Error("mount failed");
			return {};
		},
	});
	await utility.show();
	utility.setActivityStatus("error");
	utility.hide();
	await utility.show();
	assert.equal(utility.snapshot().activityStatus, "error");
	utility.destroy();
});

test("destroy while mounting cancels the mount and disposes the late runtime exactly once", async () => {
	const QLab = await loadQLab();
	const elements = utilityElements();
	let resolveMount;
	let attempts = 0;
	let cancelledMounts = 0;
	const disposed = [];
	const runtime = { id: "late-runtime" };
	const utility = new QLab.ChatUtilityHost({
		elements,
		viewport: () => ({ width: 1200, height: 800 }),
		mountChat: () => {
			attempts++;
			return new Promise(resolve => (resolveMount = resolve));
		},
		cancelMount: () => cancelledMounts++,
		disposeChat: (_content, mountedRuntime) => disposed.push(mountedRuntime),
	});
	const showing = utility.show();
	utility.destroy();
	resolveMount(runtime);
	await showing;
	await utility.ensureMounted();
	assert.equal(cancelledMounts, 1);
	assert.deepEqual(disposed, [runtime]);
	assert.equal(attempts, 1, "destroyed hosts cannot start another mount");
});

test("window shutdown removes an in-flight drag before disposing the resident shell", async () => {
	const QLab = await loadQLab();
	const elements = utilityElements();
	const fakeWindow = new FakeEventTarget();
	let persists = 0;
	let disposals = 0;
	const utility = new QLab.ChatUtilityHost({
		elements,
		window: fakeWindow,
		viewport: () => ({ width: 1200, height: 800 }),
		mountChat: async () => ({}),
		persist: () => persists++,
		disposeChat: () => disposals++,
	});
	await utility.show();
	elements.header.dispatch("pointerdown", {
		button: 0,
		pointerId: 9,
		clientX: 100,
		clientY: 100,
		preventDefault() {},
	});
	utility.destroy();
	fakeWindow.dispatch("pointermove", { pointerId: 9, clientX: 200, clientY: 200 });
	fakeWindow.dispatch("pointerup", { pointerId: 9, clientX: 200, clientY: 200 });
	assert.equal(persists, 0);
	assert.equal(disposals, 1);
});
