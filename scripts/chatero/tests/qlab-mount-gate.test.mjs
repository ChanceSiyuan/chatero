import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("QLab mount gate coalesces concurrent mounts for the same native tab", async () => {
	const QLab = await loadQLab();
	const container = {};
	let release;
	let calls = 0;
	const pending = new Promise(resolve => { release = resolve; });
	const operation = async () => {
		calls++;
		await pending;
		return "mounted";
	};
	const first = QLab.runQLabMountSingleton(container, "qlabqmd", operation);
	const second = QLab.runQLabMountSingleton(container, "qlabqmd", operation);
	await Promise.resolve();
	assert.equal(calls, 1);
	release();
	assert.deepEqual(await Promise.all([first, second]), ["mounted", "mounted"]);
	assert.equal(calls, 1);
});

test("QLab mount gate serializes a different replacement kind", async () => {
	const QLab = await loadQLab();
	const container = {};
	let release;
	const pending = new Promise(resolve => { release = resolve; });
	const order = [];
	const first = QLab.runQLabMountSingleton(container, "qlabqmd", async () => {
		order.push("qmd-start");
		await pending;
		order.push("qmd-end");
	});
	const second = QLab.runQLabMountSingleton(container, "qlabchat", async () => {
		order.push("chat");
	});
	await Promise.resolve();
	assert.deepEqual(order, ["qmd-start"]);
	release();
	await Promise.all([first, second]);
	assert.deepEqual(order, ["qmd-start", "qmd-end", "chat"]);
});

test("closing a native tab cancels an in-flight mount before it creates shell resources", async () => {
	const QLab = await loadQLab();
	let releaseDiscovery;
	const discovery = new Promise(resolve => { releaseDiscovery = resolve; });
	let touchedContainer = false;
	const container = {
		querySelector() {
			touchedContainer = true;
			return null;
		},
	};
	QLab.Settings.getRoot = () => "/tmp/qlab";
	QLab.createGeckoQLabPathHost = () => ({});
	QLab.qlabRepositoryState = async () => {
		await discovery;
		return "ready";
	};
	QLab.QmdDraftIO.listDrafts = async () => {
		throw new Error("a cancelled mount must not enumerate Drafts");
	};

	const mounting = QLab.mountShellTab(container, "qlabqmd");
	QLab.cancelShellTabMount(container);
	releaseDiscovery();
	assert.equal(await mounting, null);
	assert.equal(touchedContainer, false);
});
