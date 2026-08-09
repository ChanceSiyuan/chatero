import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

test("Chat presentation starts hidden and records invocation and focus intent without owning conversation state", async () => {
	const QLab = await loadQLab();
	const controller = new QLab.ChatPresentationController({
		viewport: { width: 1200, height: 800 },
	});

	assert.deepEqual(plain(controller.snapshot()), {
		visibility: "hidden",
		pinned: false,
		bounds: { left: 240, top: 60, width: 720, height: 680 },
		invocation: null,
		focusComposer: false,
		focusReturn: null,
	});

	controller.show({
		invocation: "pdf-selection",
		focusComposer: true,
		focusReturn: "reader-selection",
	});
	assert.deepEqual(plain(controller.snapshot()), {
		visibility: "visible",
		pinned: false,
		bounds: { left: 240, top: 60, width: 720, height: 680 },
		invocation: "pdf-selection",
		focusComposer: true,
		focusReturn: "reader-selection",
	});

	const hidden = controller.hide({ restoreFocus: true });
	assert.equal(hidden.focusReturn, "reader-selection");
	assert.equal(hidden.state.visibility, "hidden");
	assert.equal(controller.snapshot().focusComposer, false);
	assert.equal(controller.snapshot().invocation, "pdf-selection");
});

test("toggle alternates visibility and returns focus only when requested", async () => {
	const QLab = await loadQLab();
	const controller = new QLab.ChatPresentationController({
		viewport: { width: 1200, height: 800 },
	});

	controller.toggle({ invocation: "shortcut", focusReturn: "qmd-editor" });
	assert.equal(controller.snapshot().visibility, "visible");
	assert.equal(controller.snapshot().invocation, "shortcut");

	const hidden = controller.toggle({ restoreFocus: false });
	assert.equal(hidden.state.visibility, "hidden");
	assert.equal(hidden.focusReturn, null);
	controller.toggle({ invocation: "tab", focusComposer: true });
	assert.equal(controller.snapshot().visibility, "visible");
	assert.equal(controller.snapshot().focusComposer, true);
});

test("persistence callbacks contain only Pin and bounds while show and hide remain transient", async () => {
	const QLab = await loadQLab();
	const persisted = [];
	const controller = new QLab.ChatPresentationController({
		viewport: { width: 1400, height: 1000 },
		onPersist: value => persisted.push(plain(value)),
	});

	controller.show({ invocation: "toolbar", focusComposer: true, focusReturn: "reader" });
	controller.hide({ restoreFocus: true });
	assert.equal(persisted.length, 0);

	controller.setPinned(true);
	controller.setBounds({ left: 90, top: 80, width: 700, height: 600 });
	assert.deepEqual(persisted, [
		{
			pinned: true,
			bounds: { left: 340, top: 160, width: 720, height: 680 },
		},
		{
			pinned: true,
			bounds: { left: 90, top: 80, width: 700, height: 600 },
		},
	]);
	for (const value of persisted) {
		assert.deepEqual(Object.keys(value).sort(), ["bounds", "pinned"]);
	}
});

test("restore accepts only persisted Pin and bounds and always restarts hidden", async () => {
	const QLab = await loadQLab();
	const controller = new QLab.ChatPresentationController({
		viewport: { width: 1400, height: 1000 },
	});

	controller.restore({
		visibility: "visible",
		pinned: true,
		bounds: { left: 75, top: 65, width: 800, height: 700 },
		invocation: "pdf-selection",
		focusComposer: true,
		focusReturn: "reader",
	});
	assert.deepEqual(plain(controller.snapshot()), {
		visibility: "hidden",
		pinned: true,
		bounds: { left: 75, top: 65, width: 800, height: 700 },
		invocation: null,
		focusComposer: false,
		focusReturn: null,
	});
});

test("bounds use preferred, minimum, maximum, and normal deck-margin constraints", async () => {
	const QLab = await loadQLab();
	const controller = new QLab.ChatPresentationController({
		viewport: { width: 1400, height: 1000 },
	});

	assert.deepEqual(plain(controller.snapshot().bounds), {
		left: 340,
		top: 160,
		width: 720,
		height: 680,
	});

	controller.setBounds({ left: -100, top: -50, width: 100, height: 100 });
	assert.deepEqual(plain(controller.snapshot().bounds), {
		left: 24,
		top: 24,
		width: 480,
		height: 420,
	});

	controller.setBounds({ left: 2000, top: 2000, width: 2000, height: 2000 });
	assert.deepEqual(plain(controller.snapshot().bounds), {
		left: 516,
		top: 24,
		width: 860,
		height: 952,
	});
});

test("a deck below the minimum fits Chat with a sixteen-pixel margin", async () => {
	const QLab = await loadQLab();
	const controller = new QLab.ChatPresentationController({
		viewport: { width: 460, height: 400 },
	});

	assert.deepEqual(plain(controller.snapshot().bounds), {
		left: 16,
		top: 16,
		width: 428,
		height: 368,
	});
	controller.setBounds({ left: 300, top: 300, width: 50, height: 50 });
	assert.deepEqual(plain(controller.snapshot().bounds), {
		left: 16,
		top: 16,
		width: 428,
		height: 368,
	});
});

test("display resizing reclamps the last user bounds without persisting transient reflow", async () => {
	const QLab = await loadQLab();
	const persisted = [];
	const controller = new QLab.ChatPresentationController({
		viewport: { width: 1400, height: 1000 },
		onPersist: value => persisted.push(plain(value)),
	});
	controller.setBounds({ left: 1000, top: 1000, width: 800, height: 650 });
	assert.equal(persisted.length, 1);

	controller.setViewport({ width: 900, height: 700 });
	assert.deepEqual(plain(controller.snapshot().bounds), {
		left: 76,
		top: 26,
		width: 800,
		height: 650,
	});
	controller.setViewport({ width: 600, height: 500 });
	assert.deepEqual(plain(controller.snapshot().bounds), {
		left: 24,
		top: 24,
		width: 552,
		height: 452,
	});
	assert.equal(persisted.length, 1);
});

test("invalid persisted geometry is discarded and recentered", async () => {
	const QLab = await loadQLab();
	const controller = new QLab.ChatPresentationController({
		viewport: { width: 1200, height: 800 },
	});
	controller.restore({
		pinned: true,
		bounds: { left: "not-a-number", top: 20, width: 700, height: 600 },
	});
	assert.deepEqual(plain(controller.snapshot().bounds), {
		left: 240,
		top: 60,
		width: 720,
		height: 680,
	});
	assert.equal(controller.snapshot().pinned, true);
});

test("interaction classification distinguishes Chat-owned paths from PDF and QMD activity", async () => {
	const QLab = await loadQLab();
	assert.equal(QLab.classifyChatInteraction({ source: "chat" }), "inside-chat");
	assert.equal(QLab.classifyChatInteraction({
		source: "qmd",
		path: ["qmd-surface", "chat-owned"],
	}), "inside-chat");
	assert.equal(QLab.classifyChatInteraction({ source: "pdf" }), "workspace");
	assert.equal(QLab.classifyChatInteraction({ source: "qmd" }), "workspace");
	assert.equal(QLab.classifyChatInteraction({ source: "window-chrome" }), "other");
});

test("unpinned outside PDF or QMD activity hides Chat while Chat-owned activity does not", async () => {
	const QLab = await loadQLab();
	const controller = new QLab.ChatPresentationController({
		viewport: { width: 1200, height: 800 },
	});
	controller.show({ invocation: "tab", focusReturn: "reader" });
	let result = controller.handleInteraction({ source: "qmd", path: ["chat-owned"] });
	assert.equal(result.dismissed, false);
	assert.equal(controller.snapshot().visibility, "visible");

	result = controller.handleInteraction({ source: "pdf" });
	assert.equal(result.dismissed, true);
	assert.equal(result.focusReturn, "reader");
	assert.equal(result.consumed, false);
	assert.equal(controller.snapshot().visibility, "hidden");

	controller.show({ invocation: "tab" });
	result = controller.handleInteraction({ source: "qmd" });
	assert.equal(result.dismissed, true);
	assert.equal(controller.snapshot().visibility, "hidden");
});

test("pinned Chat stays visible on outside workspace activity", async () => {
	const QLab = await loadQLab();
	const controller = new QLab.ChatPresentationController({
		viewport: { width: 1200, height: 800 },
	});
	controller.setPinned(true);
	controller.show({ invocation: "tab" });
	const result = controller.handleInteraction({ source: "pdf" });
	assert.equal(result.dismissed, false);
	assert.equal(result.consumed, false);
	assert.equal(controller.snapshot().visibility, "visible");
});

test("the opening pointer token is ignored exactly once and no interaction method is consumed", async () => {
	const QLab = await loadQLab();
	let prevented = 0;
	let stopped = 0;
	const pointer = {
		source: "pdf",
		invocationToken: "reader-pointer-42",
		preventDefault: () => prevented++,
		stopPropagation: () => stopped++,
	};
	const controller = new QLab.ChatPresentationController({
		viewport: { width: 1200, height: 800 },
	});
	controller.show({
		invocation: "pdf-selection",
		openingToken: "reader-pointer-42",
		focusReturn: "reader-selection",
	});

	let result = controller.handleInteraction(pointer);
	assert.equal(result.ignoredOpening, true);
	assert.equal(result.dismissed, false);
	assert.equal(result.consumed, false);
	assert.equal(controller.snapshot().visibility, "visible");

	result = controller.handleInteraction(pointer);
	assert.equal(result.ignoredOpening, false);
	assert.equal(result.dismissed, true);
	assert.equal(result.consumed, false);
	assert.equal(controller.snapshot().visibility, "hidden");
	assert.equal(prevented, 0);
	assert.equal(stopped, 0);
});
