import assert from "node:assert/strict";
import test from "node:test";
import { TextDecoder, TextEncoder } from "node:util";
import { loadQLab } from "../lib/load-qlab.mjs";

const encoder = new TextEncoder();

function parentPath(value) {
	if (value === "/") return "/";
	const index = value.lastIndexOf("/");
	return index <= 0 ? "/" : value.slice(0, index);
}

function childPath(parent, name) {
	return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function nativeFixture({ maxTextBytes = 1024, root = "/repo", epoch = 7 } = {}) {
	let state = { root, epoch };
	let nextHandle = 0;
	let nextInode = 100;
	let beforeRead = null;
	let beforeOpenAt = null;
	let beforeStat = null;
	let beforeCanonicalPath = null;
	let beforeClose = null;
	let canonicalPathOverride = null;
	const nodes = new Map();
	const opens = [];
	const readLimits = [];
	const closes = new Map();
	const live = new Set();

	function directory(path) {
		nodes.set(path, {
			type: "directory", bytes: new Uint8Array(), device: "1", inode: String(++nextInode),
			mtimeNs: "1000", ctimeNs: "1000", lastModified: 1,
		});
	}

	function file(path, value, type = "file") {
		const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
		nodes.set(path, {
			type, bytes, device: "1", inode: String(++nextInode),
			mtimeNs: "2000", ctimeNs: "2000", lastModified: 2,
		});
	}

	for (const path of ["/", root]) directory(path);
	let cursor = "/";
	for (const segment of root.split("/").filter(Boolean)) {
		cursor = childPath(cursor, segment);
		if (!nodes.has(cursor)) directory(cursor);
	}
	for (const path of [`${root}/drafts`, `${root}/knowledge`, `${root}/literature`]) directory(path);
	file(`${root}/drafts/note.qmd`, "# Draft\n");
	file(`${root}/knowledge/topic.qmd`, "# Trusted\n");
	file(`${root}/literature/paper.md`, "# Evidence\n");
	file(`${root}/literature/refs.bib`, "@book{safe}\n");
	file(`${root}/literature/paper.pdf`, Uint8Array.from([0x25, 0x50, 0x44, 0x46]));

	function open(path, options, operation, segment = "") {
		const node = nodes.get(path);
		opens.push({ operation, path, segment, options: { ...options } });
		if (!node) throw new Error(`ENOENT: ${path}`);
		if (options.noFollow && node.type === "symlink") throw new Error(`ELOOP: ${path}`);
		if (options.directory && node.type !== "directory") throw new Error(`ENOTDIR: ${path}`);
		const handle = { id: ++nextHandle, path, node, closed: false };
		live.add(handle);
		return handle;
	}

	const ops = {
		maxTextBytes,
		TextDecoder,
		currentRepositoryState: async () => ({ ...state }),
		openRoot: async options => open("/", options, "open-root"),
		openAt: async (parent, segment, options) => {
			if (!parent || parent.closed || !live.has(parent)) throw new Error("closed parent handle");
			if (!segment || segment.includes("/")) throw new Error("invalid native path segment");
			if (beforeOpenAt) await beforeOpenAt(parent, segment, options);
			return open(childPath(parent.path, segment), options, "open-at", segment);
		},
		stat: async handle => {
			if (!handle || handle.closed || !live.has(handle)) throw new Error("closed handle");
			if (beforeStat) await beforeStat(handle);
			return {
				type: handle.node.type,
				size: handle.node.bytes.length,
				device: handle.node.device,
				inode: handle.node.inode,
				mtimeNs: handle.node.mtimeNs,
				ctimeNs: handle.node.ctimeNs,
				lastModified: handle.node.lastModified,
			};
		},
		canonicalPath: async handle => {
			if (!handle || handle.closed || !live.has(handle)) throw new Error("closed handle");
			if (beforeCanonicalPath) await beforeCanonicalPath(handle);
			return canonicalPathOverride ? canonicalPathOverride(handle) : handle.path;
		},
		read: async (handle, limit) => {
			if (!handle || handle.closed || !live.has(handle)) throw new Error("closed handle");
			if (handle.node.type !== "file") throw new Error("not a regular file");
			readLimits.push(Number(limit));
			if (beforeRead) await beforeRead(handle);
			return handle.node.bytes.slice(0, Number(limit));
		},
		close: async handle => {
			if (!handle || handle.closed || !live.has(handle)) throw new Error("double close");
			if (beforeClose) await beforeClose(handle);
			handle.closed = true;
			live.delete(handle);
			closes.set(handle.id, (closes.get(handle.id) || 0) + 1);
		},
	};

	return {
		ops,
		opens,
		readLimits,
		closes,
		live,
		setState(next) { state = { ...next }; },
		setBeforeRead(callback) { beforeRead = callback; },
		setBeforeOpenAt(callback) { beforeOpenAt = callback; },
		setBeforeStat(callback) { beforeStat = callback; },
		setBeforeCanonicalPath(callback) { beforeCanonicalPath = callback; },
		setBeforeClose(callback) { beforeClose = callback; },
		setCanonicalPathOverride(callback) { canonicalPathOverride = callback; },
		setPathIdentity(path, identity) {
			const node = nodes.get(path);
			if (!node) throw new Error(`missing fixture node: ${path}`);
			Object.assign(node, identity);
		},
		setLiveIdentity(path, identity) {
			for (const handle of live) {
				if (handle.path === path) Object.assign(handle.node, identity);
			}
		},
		growLiveLeaf(path, value) {
			const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
			for (const handle of live) {
				if (handle.path === path) {
					handle.node.bytes = bytes;
					handle.node.ctimeNs = String(BigInt(handle.node.ctimeNs) + 1n);
				}
			}
		},
		replace(path, value, type = "file") { file(path, value, type); },
		remove(path) { nodes.delete(path); },
		add(path, value, type = "file") {
			let parent = parentPath(path);
			if (!nodes.has(parent)) directory(parent);
			file(path, value, type);
		},
	};
}

function request(QLab, relativePath, { root = "/repo", epoch = 7, ...overrides } = {}) {
	const document = QLab.classifyWorkspaceDocument(relativePath);
	return Object.freeze({
		root,
		epoch,
		relativePath,
		authority: document?.authority,
		kind: document?.kind,
		writable: document?.writable,
		...overrides,
	});
}

function darwinStatBytes({
	type = "file",
	device = 7,
	inode = 9007199254740993n,
	size = 12n,
	mtimeSeconds = 3n,
	mtimeNanoseconds = 5n,
	ctimeSeconds = 4n,
	ctimeNanoseconds = 6n,
} = {}) {
	const bytes = new Uint8Array(144);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, device, true);
	view.setUint16(4, type === "directory" ? 0x4000 : 0x8000, true);
	view.setBigUint64(8, inode, true);
	view.setBigInt64(48, mtimeSeconds, true);
	view.setBigInt64(56, mtimeNanoseconds, true);
	view.setBigInt64(64, ctimeSeconds, true);
	view.setBigInt64(72, ctimeNanoseconds, true);
	view.setBigInt64(96, size, true);
	return bytes;
}

function writeCString(buffer, text) {
	const bytes = encoder.encode(text);
	buffer.set(bytes.slice(0, buffer.length - 1), 0);
	buffer[Math.min(bytes.length, buffer.length - 1)] = 0;
}

function fakeCtypesLibrary({ missing = "" } = {}) {
	const declared = [];
	let closes = 0;
	const library = {
		declare(name) {
			declared.push(name);
			if (name === missing) throw new Error(`missing symbol: ${name}`);
			return () => 0;
		},
		close() { closes++; },
	};
	const scalar = {};
	const ctypes = {
		default_abi: {}, int: scalar, long: scalar, int64_t: scalar,
		size_t: scalar, ssize_t: scalar, voidptr_t: scalar, uint8_t: scalar,
		char: { ptr: scalar },
		ArrayType() { return function () {}; },
	};
	return { ctypes, library, declared, closeCount: () => closes };
}

test("the native broker opens the absolute root and every descendant with no-follow handles", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const capability = await host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));

	assert.deepEqual(fixture.opens.map(entry => entry.path), [
		"/", "/repo", "/repo/knowledge", "/repo/knowledge/topic.qmd",
	]);
	assert.equal(fixture.opens.every(entry => entry.options.noFollow === true), true);
	assert.equal(fixture.opens.every(entry => entry.options.closeOnExec === true), true);
	assert.equal(fixture.opens.slice(0, -1).every(entry => entry.options.directory === true), true);
	assert.equal(fixture.opens.at(-1).options.directory, false);
	assert.equal(await host.releaseVerifiedDocument(capability), true);
});

test("multi-component roots are pinned one component at a time", async () => {
	const QLab = await loadQLab();
	const root = "/Users/research/workspace";
	const fixture = nativeFixture({ root });
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const capability = await host.acquireVerifiedDocument(request(
		QLab, "literature/paper.pdf", { root },
	));

	assert.deepEqual(fixture.opens.map(entry => entry.path), [
		"/", "/Users", "/Users/research", "/Users/research/workspace",
		"/Users/research/workspace/literature",
		"/Users/research/workspace/literature/paper.pdf",
	]);
	assert.equal(await host.releaseVerifiedDocument(capability), true);
});

test("canonical-path mismatches and linked ancestors or leaves fail closed", async () => {
	const QLab = await loadQLab();
	for (const mode of ["canonical", "ancestor-link", "leaf-link"]) {
		const fixture = nativeFixture();
		if (mode === "canonical") {
			fixture.setCanonicalPathOverride(handle => (
				handle.path === "/repo/knowledge" ? "/outside/knowledge" : handle.path
			));
		}
		else if (mode === "ancestor-link") {
			fixture.replace("/repo/knowledge", new Uint8Array(), "symlink");
		}
		else {
			fixture.replace("/repo/knowledge/topic.qmd", new Uint8Array(), "symlink");
		}
		const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
		await assert.rejects(
			() => host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd")),
			/canonical|link|ELOOP|directory/i,
			mode,
		);
		assert.equal(fixture.live.size, 0, mode);
	}
});

test("descriptor inspection is sequential so rejection cannot close a sibling operation's handle", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	let releaseStat;
	let statEntered;
	const statGate = new Promise(resolve => { releaseStat = resolve; });
	const entered = new Promise(resolve => { statEntered = resolve; });
	let canonicalCalls = 0;
	let first = true;
	fixture.setBeforeStat(async () => {
		if (!first) return;
		first = false;
		statEntered();
		await statGate;
	});
	fixture.setBeforeCanonicalPath(() => { canonicalCalls++; });
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const acquiring = host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));
	await entered;
	const canonicalCallsWhileStatBlocked = canonicalCalls;
	releaseStat();
	const capability = await acquiring;
	assert.equal(canonicalCallsWhileStatBlocked, 0);
	assert.equal(canonicalCalls, 4);
	assert.equal(await host.releaseVerifiedDocument(capability), true);
});

test("verified text bytes come from the retained leaf handle after the pathname is swapped", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const capability = await host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));
	fixture.replace("/repo/knowledge/topic.qmd", "SECRET\n");

	const read = await host.readVerified(capability.access, capability);
	assert.equal(read.text, "# Trusted\n");
	assert.equal(await host.releaseVerifiedDocument(capability), true);
});

test("the native broker refuses unsafe paths, forged route metadata, and non-regular leaves", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	fixture.add("/repo/literature/socket.md", new Uint8Array(), "socket");
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);

	for (const candidate of [
		{ ...request(QLab, "knowledge/topic.qmd"), relativePath: "knowledge/../secret.qmd" },
		{ ...request(QLab, "knowledge/topic.qmd"), authority: "literature" },
		{ ...request(QLab, "knowledge/topic.qmd"), kind: "pdf" },
		{ ...request(QLab, "knowledge/topic.qmd"), writable: true },
		{ ...request(QLab, "knowledge/topic.qmd"), relativePath: "notes/topic.qmd" },
	]) {
		await assert.rejects(() => host.acquireVerifiedDocument(candidate), /unsafe|unsupported|match|route/i);
	}
	await assert.rejects(
		() => host.acquireVerifiedDocument(request(QLab, "literature/socket.md")),
		/regular file/i,
	);
	assert.equal(fixture.live.size, 0);
});

test("a failed partial open closes every retained ancestor in reverse without leaks", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	fixture.remove("/repo/knowledge/topic.qmd");
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);

	await assert.rejects(
		() => host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd")),
		/ENOENT|open|document/i,
	);
	assert.equal(fixture.live.size, 0);
	assert.equal(fixture.closes.size, 3);
	assert.equal([...fixture.closes.values()].every(count => count === 1), true);
});

test("release continues closing every handle when one native close reports an error", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	const nativeClose = fixture.ops.close;
	let failOnce = true;
	fixture.ops.close = async handle => {
		await nativeClose(handle);
		if (failOnce) {
			failOnce = false;
			throw new Error("close failed");
		}
	};
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const capability = await host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));

	assert.equal(await host.releaseVerifiedDocument(capability), false);
	assert.equal(fixture.live.size, 0);
	assert.equal(fixture.closes.size, 4);
	assert.equal([...fixture.closes.values()].every(count => count === 1), true);
});

test("verified text decoding is fatal and bounded for readonly text and routed Draft source", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture({ maxTextBytes: 8 });
	fixture.add("/repo/literature/invalid.md", Uint8Array.from([0xc3, 0x28]));
	fixture.add("/repo/literature/large.md", "123456789");
	fixture.add("/repo/literature/exact.md", "12345678");
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const exact = await host.acquireVerifiedDocument(request(QLab, "literature/exact.md"));
	assert.equal((await host.readVerified(exact.access, exact)).text, "12345678");
	assert.equal(fixture.readLimits.at(-1), 9);
	assert.equal(await host.releaseVerifiedDocument(exact), true);

	const invalid = await host.acquireVerifiedDocument(request(QLab, "literature/invalid.md"));
	await assert.rejects(() => host.readVerified(invalid.access, invalid), /UTF-8|encoding/i);
	assert.equal(await host.releaseVerifiedDocument(invalid), true);
	await assert.rejects(
		() => host.acquireVerifiedDocument(request(QLab, "literature/large.md")),
		/size|large|limit/i,
	);

	const draft = await host.acquireVerifiedDocument(request(QLab, "drafts/note.qmd"));
	fixture.replace("/repo/drafts/note.qmd", "# Path-swapped Draft\n");
	assert.equal(
		(await host.readVerified(draft.access, draft)).text,
		"# Draft\n",
		"the routed Draft is read from its retained leaf, not the replaced path",
	);
	assert.equal(await host.releaseVerifiedDocument(draft), true);

	const pdf = await host.acquireVerifiedDocument(request(QLab, "literature/paper.pdf"));
	await assert.rejects(
		() => host.readVerified(pdf.access, pdf),
		/readable|text/i,
	);
	assert.equal(await host.releaseVerifiedDocument(pdf), true);
	assert.equal(fixture.live.size, 0);
});

test("a readable leaf that grows beyond the bound while held is refused without truncation", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture({ maxTextBytes: 16 });
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const capability = await host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));
	fixture.setBeforeRead(handle => {
		handle.node.bytes = encoder.encode("12345678901234567");
	});

	await assert.rejects(
		() => host.readVerified(capability.access, capability),
		/changed|size|large|limit/i,
	);
	assert.equal(await host.releaseVerifiedDocument(capability), true);
	assert.equal(fixture.live.size, 0);
});

test("same-size in-place mutation with restored mtime is rejected by stable file identity", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const capability = await host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));
	fixture.growLiveLeaf("/repo/knowledge/topic.qmd", "# Mutated\n");

	await assert.rejects(
		() => host.readVerified(capability.access, capability),
		/changed|identity|ctime|stable/i,
	);
	assert.equal(fixture.readLimits.length, 0);
	assert.equal(await host.releaseVerifiedDocument(capability), true);
});

test("64-bit file identities reject lossy numbers and compare canonical decimal strings exactly", async () => {
	const QLab = await loadQLab();
	const lossy = nativeFixture();
	lossy.setPathIdentity("/repo/knowledge/topic.qmd", {
		inode: Number.MAX_SAFE_INTEGER + 1,
	});
	const lossyHost = QLab.createHandleBoundWorkspaceDocumentLeaseHost(lossy.ops);
	await assert.rejects(
		() => lossyHost.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd")),
		/identity|inode|stat/i,
	);
	assert.equal(lossy.live.size, 0);

	const exact = nativeFixture();
	exact.setPathIdentity("/repo/knowledge/topic.qmd", {
		inode: "9007199254740992",
	});
	const exactHost = QLab.createHandleBoundWorkspaceDocumentLeaseHost(exact.ops);
	const capability = await exactHost.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));
	exact.setLiveIdentity("/repo/knowledge/topic.qmd", {
		inode: "9007199254740993",
	});
	await assert.rejects(
		() => exactHost.readVerified(capability.access, capability),
		/identity|changed/i,
	);
	assert.equal(await exactHost.releaseVerifiedDocument(capability), true);
});

test("malformed and ambiguous native identity components fail closed", async () => {
	const QLab = await loadQLab();
	const invalid = [
		-1,
		-1n,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
		"-1",
		"+1",
		"01",
		"1.0",
		" 1",
		"1 ",
		"0x10",
		"Infinity",
	];
	for (const field of ["device", "inode", "mtimeNs", "ctimeNs"]) {
		for (const value of invalid) {
			const fixture = nativeFixture();
			fixture.setPathIdentity("/repo/knowledge/topic.qmd", { [field]: value });
			const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
			await assert.rejects(
				() => host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd")),
				/identity|regular file|stat/i,
				`${field}=${String(value)}`,
			);
			assert.equal(fixture.live.size, 0, `${field}=${String(value)}`);
		}
	}
});

test("root and epoch changes revoke access while release closes every retained handle once", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);

	await assert.rejects(
		() => host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd", { root: "/other" })),
		/root|repository/i,
	);
	await assert.rejects(
		() => host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd", { epoch: 6 })),
		/epoch|stale/i,
	);

	const capability = await host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));
	fixture.setState({ root: "/repo", epoch: 8 });
	assert.equal(await host.verifyAccess(capability.access, capability), false);
	await assert.rejects(
		() => host.readVerified(capability.access, capability),
		/stale|revoked|epoch|repository/i,
	);
	assert.equal(await host.releaseVerifiedDocument(capability), true);
	assert.equal(await host.releaseVerifiedDocument(capability), false);
	assert.equal(fixture.closes.size, 4);
	assert.equal([...fixture.closes.values()].every(count => count === 1), true);
	assert.equal(fixture.live.size, 0);
});

test("an epoch change after all path handles open prevents lease publication", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	let releaseLeafStat;
	let leafStatEntered;
	const gate = new Promise(resolve => { releaseLeafStat = resolve; });
	const entered = new Promise(resolve => { leafStatEntered = resolve; });
	let gated = false;
	fixture.setBeforeStat(async handle => {
		if (gated || handle.path !== "/repo/knowledge/topic.qmd") return;
		gated = true;
		leafStatEntered();
		await gate;
	});
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const acquiring = host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));
	await entered;
	fixture.setState({ root: "/repo", epoch: 8 });
	releaseLeafStat();
	await assert.rejects(() => acquiring, /stale|epoch|repository/i);
	assert.equal(fixture.live.size, 0);
});

test("destroy waits for a gated acquire and the acquire cannot publish afterward", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	let nativeDestroyCalls = 0;
	fixture.ops.destroy = async () => { nativeDestroyCalls++; };
	let releaseOpen;
	let openEntered;
	const gate = new Promise(resolve => { releaseOpen = resolve; });
	const entered = new Promise(resolve => { openEntered = resolve; });
	fixture.setBeforeOpenAt(async (_parent, segment) => {
		if (segment !== "topic.qmd") return;
		openEntered();
		await gate;
	});
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const acquiring = host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));
	await entered;
	const destroying = host.destroy();
	await Promise.resolve();
	const destroyedBeforeAcquireSettled = nativeDestroyCalls;
	releaseOpen();
	await assert.rejects(() => acquiring, /destroy|revoked|stale/i);
	assert.equal(await destroying, true);
	assert.equal(destroyedBeforeAcquireSettled, 0);
	assert.equal(nativeDestroyCalls, 1);
	assert.equal(fixture.live.size, 0);
});

test("destroy waits for a gated read before closing handles or native symbols", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	let nativeDestroyCalls = 0;
	fixture.ops.destroy = async () => { nativeDestroyCalls++; };
	let releaseRead;
	let readEntered;
	const gate = new Promise(resolve => { releaseRead = resolve; });
	const entered = new Promise(resolve => { readEntered = resolve; });
	fixture.setBeforeRead(async () => {
		readEntered();
		await gate;
	});
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const capability = await host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));
	const reading = host.readVerified(capability.access, capability);
	await entered;
	const destroying = host.destroy();
	await Promise.resolve();
	const destroyedBeforeReadSettled = nativeDestroyCalls;
	const closedBeforeReadSettled = fixture.closes.size;
	releaseRead();
	await assert.rejects(() => reading, /destroy|revoked|binding|changed/i);
	assert.equal(await destroying, true);
	assert.equal(destroyedBeforeReadSettled, 0);
	assert.equal(closedBeforeReadSettled, 0);
	assert.equal(nativeDestroyCalls, 1);
	assert.equal(fixture.live.size, 0);
});

test("destroy waits for a gated release to finish closing every handle", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	let nativeDestroyCalls = 0;
	fixture.ops.destroy = async () => { nativeDestroyCalls++; };
	let releaseClose;
	let closeEntered;
	const gate = new Promise(resolve => { releaseClose = resolve; });
	const entered = new Promise(resolve => { closeEntered = resolve; });
	let gated = false;
	fixture.setBeforeClose(async () => {
		if (gated) return;
		gated = true;
		closeEntered();
		await gate;
	});
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const capability = await host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));
	const releasing = host.releaseVerifiedDocument(capability);
	await entered;
	const destroying = host.destroy();
	await Promise.resolve();
	const destroyedBeforeReleaseSettled = nativeDestroyCalls;
	releaseClose();
	assert.equal(await releasing, true);
	assert.equal(await destroying, true);
	assert.equal(destroyedBeforeReleaseSettled, 0);
	assert.equal(nativeDestroyCalls, 1);
	assert.equal(fixture.live.size, 0);
});

test("a lease and its access identity cannot be read twice or reused through a copied capability", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const capability = await host.acquireVerifiedDocument(request(QLab, "literature/refs.bib"));
	const copied = Object.freeze({ ...capability });

	assert.equal((await host.readVerified(capability.access, capability)).text, "@book{safe}\n");
	await assert.rejects(() => host.readVerified(capability.access, capability), /consumed|single|used/i);
	await assert.rejects(() => host.readVerified(copied.access, copied), /access|lease|capability/i);
	assert.equal(await host.releaseVerifiedDocument(copied), false);
	assert.equal(await host.releaseVerifiedDocument(capability), true);
	assert.equal(fixture.live.size, 0);
});

test("concurrent reads synchronously claim one access identity before native I/O", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	let releaseRead;
	const readGate = new Promise(resolve => { releaseRead = resolve; });
	let nativeReads = 0;
	fixture.setBeforeRead(async () => {
		nativeReads++;
		await readGate;
	});
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const capability = await host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));

	const first = host.readVerified(capability.access, capability);
	const second = host.readVerified(capability.access, capability);
	await Promise.resolve();
	releaseRead();
	const settled = await Promise.allSettled([first, second]);
	assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
	assert.equal(settled.filter(result => result.status === "rejected").length, 1);
	assert.equal(nativeReads, 1);
	assert.equal(await host.releaseVerifiedDocument(capability), true);
});

test("readonly IO verifies the private live capability without a pathname realPath fallback", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	assert.equal(Object.hasOwn(host, "realPath"), false);
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/topic.qmd" });
	const capability = await host.acquireVerifiedDocument(request(QLab, descriptor.relativePath));
	const io = QLab.createReadonlyDocumentIO({ root: "/repo", host });

	const read = await io.read(capability, descriptor);
	assert.equal(read.text, "# Trusted\n");
	assert.equal(await host.releaseVerifiedDocument(capability), true);
});

test("destroy revokes every outstanding lease and closes the native library exactly once", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	let nativeDestroyCalls = 0;
	fixture.ops.destroy = async () => { nativeDestroyCalls++; };
	const host = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const first = await host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));
	const second = await host.acquireVerifiedDocument(request(QLab, "literature/paper.pdf"));

	assert.equal(await host.destroy(), true);
	assert.equal(await host.destroy(), false);
	assert.equal(nativeDestroyCalls, 1);
	assert.equal(fixture.closes.size, 8);
	assert.equal(fixture.live.size, 0);
	assert.equal(await host.verifyAccess(first.access, first), false);
	assert.equal(await host.releaseVerifiedDocument(second), false);
});

test("Darwin ctypes bindings select the ABI-specific fstat symbol and own library cleanup", async () => {
	const QLab = await loadQLab();
	for (const [architecture, expected] of [
		["arm64", "fstat"],
		["x86_64", "fstat$INODE64"],
	]) {
		const fake = fakeCtypesLibrary();
		const bindings = QLab.createDarwinWorkspaceDocumentCtypesBindings({
			ctypes: fake.ctypes,
			library: fake.library,
			architecture,
		});
		assert.equal(fake.declared.includes(expected), true, architecture);
		assert.equal(
			fake.declared.includes(architecture === "arm64" ? "fstat$INODE64" : "fstat"),
			false,
			architecture,
		);
		assert.equal(await bindings.destroy(), true);
		assert.equal(await bindings.destroy(), false);
		assert.equal(fake.closeCount(), 1);
	}
});

test("Darwin ctypes binding creation closes the library and fails when any symbol is missing", async () => {
	const QLab = await loadQLab();
	for (const missing of ["open", "openat", "fstat", "read", "close", "fcntl"]) {
		const fake = fakeCtypesLibrary({ missing });
		assert.throws(() => QLab.createDarwinWorkspaceDocumentCtypesBindings({
			ctypes: fake.ctypes,
			library: fake.library,
			architecture: "arm64",
		}), /symbol|missing|ctypes|Darwin/i, missing);
		assert.equal(fake.closeCount(), 1, missing);
	}
	const unsupported = fakeCtypesLibrary();
	assert.throws(() => QLab.createDarwinWorkspaceDocumentCtypesBindings({
		ctypes: unsupported.ctypes,
		library: unsupported.library,
		architecture: "i386",
	}), /architecture|unsupported/i);
	assert.equal(unsupported.closeCount(), 1);
});

test("Darwin native operations map segment flags and decode the 144-byte stat ABI exactly", async () => {
	const QLab = await loadQLab();
	const calls = { open: [], openat: [], fcntl: [] };
	const stats = new Map([
		[10, darwinStatBytes({ type: "directory", inode: 2n, size: 0n })],
		[11, darwinStatBytes()],
	]);
	const paths = new Map([[10, "/"], [11, "/repo/topic.qmd"]]);
	const bindings = {
		open(path, flags) { calls.open.push({ path, flags }); return 10; },
		openat(parentFD, segment, flags) {
			calls.openat.push({ parentFD, segment, flags });
			return 11;
		},
		fstat(fd, buffer) { buffer.set(stats.get(fd)); return 0; },
		fcntl(fd, command, buffer) {
			calls.fcntl.push({ fd, command, size: buffer.length });
			writeCString(buffer, paths.get(fd));
			return 0;
		},
		read() { return 0; },
		close() { return 0; },
		createBuffer: size => new Uint8Array(size),
		bytes: (buffer, length) => buffer.slice(0, length),
		errno: () => 0,
		async destroy() { return true; },
	};
	const ops = QLab.createDarwinWorkspaceDocumentNativeOps({
		bindings,
		currentRepositoryState: async () => ({ root: "/repo", epoch: 7 }),
		TextDecoder,
	});
	const rootHandle = await ops.openRoot({
		readOnly: true, noFollow: true, closeOnExec: true,
		directory: true, nonBlocking: false,
	});
	const leafHandle = await ops.openAt(rootHandle, "topic.qmd", {
		readOnly: true, noFollow: true, closeOnExec: true,
		directory: false, nonBlocking: true,
	});
	assert.deepEqual(calls.open, [{ path: "/", flags: 0x01100100 }]);
	assert.deepEqual(calls.openat, [{
		parentFD: 10, segment: "topic.qmd", flags: 0x01000104,
	}]);
	await assert.rejects(
		() => ops.openAt(rootHandle, "nested/topic.qmd", {
			readOnly: true, noFollow: true, closeOnExec: true,
			directory: false, nonBlocking: true,
		}),
		/segment|unsafe/i,
	);
	assert.deepEqual({ ...await ops.stat(leafHandle) }, {
		type: "file",
		size: 12,
		device: "7",
		inode: "9007199254740993",
		mtimeNs: "3000000005",
		ctimeNs: "4000000006",
		lastModified: 3000.000005,
	});
	assert.equal(await ops.canonicalPath(leafHandle), "/repo/topic.qmd");
	assert.deepEqual(calls.fcntl, [{ fd: 11, command: 50, size: 1024 }]);
});

test("Darwin native reads continue across short reads until EOF and close errors fail closed", async () => {
	const QLab = await loadQLab();
	const source = encoder.encode("ABCDE");
	const readCalls = [];
	let cursor = 0;
	let closeResult = 0;
	const bindings = {
		open: () => 21,
		openat: () => 22,
		fstat(_fd, buffer) { buffer.set(darwinStatBytes({ size: 5n })); return 0; },
		fcntl(_fd, _command, buffer) { writeCString(buffer, "/repo/file.qmd"); return 0; },
		read(fd, buffer, offset, length) {
			readCalls.push({ fd, offset, length });
			if (cursor >= source.length) return 0;
			const count = Math.min(2, length, source.length - cursor);
			buffer.set(source.slice(cursor, cursor + count), offset);
			cursor += count;
			return count;
		},
		close: () => closeResult,
		createBuffer: size => new Uint8Array(size),
		bytes: (buffer, length) => buffer.slice(0, length),
		errno: () => 9,
		async destroy() { return true; },
	};
	const ops = QLab.createDarwinWorkspaceDocumentNativeOps({
		bindings,
		currentRepositoryState: async () => ({ root: "/repo", epoch: 7 }),
		TextDecoder,
	});
	const handle = await ops.openRoot({
		readOnly: true, noFollow: true, closeOnExec: true,
		directory: false, nonBlocking: true,
	});
	assert.deepEqual([...await ops.read(handle, 6)], [...source]);
	assert.deepEqual(readCalls, [
		{ fd: 21, offset: 0, length: 6 },
		{ fd: 21, offset: 2, length: 4 },
		{ fd: 21, offset: 4, length: 2 },
		{ fd: 21, offset: 5, length: 1 },
	]);
	closeResult = -1;
	await assert.rejects(() => ops.close(handle), /close|errno|descriptor/i);
});

test("the Gecko factory fails closed off Darwin and never accepts a pathname UTF-8 fallback", async () => {
	const QLab = await loadQLab();
	let fallbackReads = 0;
	assert.throws(() => QLab.createGeckoWorkspaceDocumentLeaseHost({
		platform: "Linux",
		IOUtils: { readUTF8() { fallbackReads++; return "SECRET"; } },
	}), /unsupported|Darwin|macOS/i);
	assert.equal(fallbackReads, 0);

	const fixture = nativeFixture();
	const host = QLab.createGeckoWorkspaceDocumentLeaseHost({
		platform: "Darwin",
		nativeOps: fixture.ops,
		IOUtils: { readUTF8() { fallbackReads++; return "SECRET"; } },
	});
	const capability = await host.acquireVerifiedDocument(request(QLab, "knowledge/topic.qmd"));
	assert.equal((await host.readVerified(capability.access, capability)).text, "# Trusted\n");
	assert.equal(fallbackReads, 0);
	assert.equal(await host.releaseVerifiedDocument(capability), true);
});

test("window document access binds readonly IO to one repository epoch and owns broker disposal", async () => {
	const QLab = await loadQLab();
	const fixture = nativeFixture();
	const leaseHost = QLab.createHandleBoundWorkspaceDocumentLeaseHost(fixture.ops);
	const access = QLab.createWindowWorkspaceDocumentAccess({
		leaseHost,
		getSelectedRepositoryState: fixture.ops.currentRepositoryState,
	});
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/topic.qmd" });
	const firstIO = await access.readonlyDocumentIOForRoot("/repo");
	assert.equal((await firstIO.reload(descriptor)).text, "# Trusted\n");

	fixture.setState({ root: "/repo", epoch: 8 });
	await assert.rejects(() => firstIO.reload(descriptor), /stale|epoch|repository/i);
	const secondIO = await access.readonlyDocumentIOForRoot("/repo");
	assert.notEqual(secondIO, firstIO);
	assert.equal((await secondIO.reload(descriptor)).text, "# Trusted\n");
	assert.equal(await access.destroy(), true);
	assert.equal(await access.destroy(), false);
	assert.equal(await access.readonlyDocumentIOForRoot("/repo"), null);
});

test("a production QMD mount receives the window-owned readonly document IO", async () => {
	const QLab = await loadQLab();
	const readonlyDocumentIO = Object.freeze({ marker: "window-owned-readonly-io" });
	let mountedOptions = null;
	QLab.Settings.getRoot = () => "/repo";
	QLab.createGeckoQLabPathHost = () => ({});
	QLab.qlabRepositoryState = async () => "ready";
	QLab.QmdDraftIO.listDrafts = async () => [];
	QLab.setHTML = () => {};
	QLab.ensureKatexStyles = () => {};
	QLab.mountQmdWorkspace = async (_host, options) => {
		mountedOptions = options;
		return Object.freeze({ dispose() {} });
	};

	const windowController = {
		readonlyDocumentIOForRoot: async root => root === "/repo" ? readonlyDocumentIO : null,
	};
	const tab = { id: "qmd-tab", data: { draftPath: "drafts/note.qmd", qmdWorkspace: {} } };
	const ownerDocument = {
		defaultView: { Zotero_Tabs: { _tabs: [tab], _qlab: windowController } },
	};
	const host = {
		ownerDocument,
		querySelector: () => null,
		addEventListener() {},
	};
	const container = {
		id: "qmd-tab",
		ownerDocument,
		querySelector: selector => selector === ".qlab-shell-host" ? host : null,
	};

	await QLab._mountShellTabImpl(container, "qlabqmd");
	assert.equal(mountedOptions?.readonlyDocumentIO, readonlyDocumentIO);
});

test("a same-root QMD mount is reused only while its private repository epoch is unchanged", async () => {
	const QLab = await loadQLab();
	let disposals = 0;
	let mounts = 0;
	let refreshes = 0;
	QLab.Settings.getRoot = () => "/repo";
	QLab.createGeckoQLabPathHost = () => ({});
	QLab.qlabRepositoryState = async () => "ready";
	QLab.QmdDraftIO.listDrafts = async () => [];
	QLab.refreshShellWorkspaceChrome = () => { refreshes++; };
	QLab.setHTML = () => {};
	QLab.ensureKatexStyles = () => {};
	QLab.mountQmdWorkspace = async host => {
		mounts++;
		host._qlabQmdWorkspace = { dispose() { disposals++; } };
		return host._qlabQmdWorkspace;
	};
	const tab = { id: "qmd-tab", data: { draftPath: "drafts/note.qmd" } };
	const host = {
		_qlabMountedKind: "qlabqmd",
		_qlabMountRoot: "/repo",
		_qlabMountEpoch: 4,
		_qlabQmdWorkspace: { dispose() { disposals++; } },
		querySelector(selector) {
			return selector === '[data-qlab-kind="qlabqmd"]' ? {} : null;
		},
		addEventListener() {},
	};
	const ownerDocument = {
		defaultView: { Zotero_Tabs: { _tabs: [tab], _qlab: {} } },
	};
	host.ownerDocument = ownerDocument;
	const container = {
		id: "qmd-tab",
		ownerDocument,
		_qlabTargetEpoch: 4,
		querySelector: selector => selector === ".qlab-shell-host" ? host : null,
	};

	await QLab._mountShellTabImpl(container, "qlabqmd");
	assert.equal(refreshes, 1);
	assert.equal(mounts, 0);
	assert.equal(disposals, 0);

	container._qlabTargetEpoch = 5;
	await QLab._mountShellTabImpl(container, "qlabqmd");
	assert.equal(mounts, 1, "an epoch transition must not reuse the old workspace");
	assert.equal(disposals, 1, "the old workspace is disposed before replacement");
	assert.equal(host._qlabMountEpoch, 5);
});

test("window destruction disposes QMD workspaces before destroying the native lease broker", async () => {
	const QLab = await loadQLab();
	const order = [];
	let accessOptions = null;
	const qmdHost = {
		_qlabQmdWorkspace: { dispose() { order.push("workspace-dispose"); } },
	};
	const document = {
		defaultView: {},
		querySelectorAll: selector => selector === ".qlab-shell-host" ? [qmdHost] : [],
		getElementById: () => null,
	};
	QLab.ChatUtilityHost = class {
		snapshot() { return { pinned: false, bounds: {} }; }
		destroy() { order.push("chat-destroy"); }
		refreshWorkspace() { return Promise.resolve(); }
	};
	QLab.ChatOutsideInteractionBridge = class {
		dispose() { order.push("outside-dispose"); }
	};
	QLab.createQLabWorkspaceSetupCoordinator = () => ({
		targetEpoch: 12,
		workspaceSwitchBlocker: () => null,
		get: () => null,
		restore: () => null,
		replaceRoot: () => null,
		select: () => null,
		open: () => null,
		activateInitializedWorkspace: () => null,
		dispose() { order.push("setup-dispose"); },
	});
	QLab.Settings.getRoot = () => "/repo";
	QLab.registerMainSiteController = null;
	QLab.cancelShellTabMount = () => { order.push("mount-cancel"); };
	QLab.createGeckoWorkspaceDocumentLeaseHost = () => ({ marker: "lease-host" });
	QLab.createWindowWorkspaceDocumentAccess = options => {
		accessOptions = options;
		return {
			readonlyDocumentIOForRoot: async () => null,
			acquireVerifiedDocument: async () => null,
			releaseVerifiedDocument: async () => false,
			async destroy() { order.push("broker-destroy"); return true; },
		};
	};
	const tabsAPI = {
		deck: { ownerDocument: document },
		_tabs: [],
		_onChatUtilityChanged() {},
	};
	const controller = QLab.createWindowController(tabsAPI);
	assert.equal(typeof controller.readonlyDocumentIOForRoot, "function");
	assert.deepEqual({ ...await accessOptions.getSelectedRepositoryState() }, {
		root: "/repo", epoch: 12,
	});

	controller.destroy();
	await Promise.resolve();
	assert.equal(order.indexOf("mount-cancel") < order.indexOf("broker-destroy"), true);
	assert.equal(order.indexOf("workspace-dispose") < order.indexOf("broker-destroy"), true);
});

test("native broker construction failure leaves the core window controller usable", async () => {
	const QLab = await loadQLab();
	let orphanedHostDestroyCalls = 0;
	const document = {
		defaultView: {}, querySelectorAll: () => [], getElementById: () => null,
	};
	QLab.ChatUtilityHost = class {
		snapshot() { return { pinned: false, bounds: {} }; }
		destroy() {}
		refreshWorkspace() { return Promise.resolve(); }
	};
	QLab.ChatOutsideInteractionBridge = class { dispose() {} };
	QLab.createQLabWorkspaceSetupCoordinator = () => ({
		targetEpoch: 1,
		workspaceSwitchBlocker: () => null, get: () => null, restore: () => null,
		replaceRoot: () => null, select: () => null, open: () => null,
		activateInitializedWorkspace: () => null, dispose() {},
	});
	QLab.Settings.getRoot = () => "/repo";
	QLab.registerMainSiteController = null;
	QLab.createGeckoWorkspaceDocumentLeaseHost = () => ({
		async destroy() { orphanedHostDestroyCalls++; return true; },
	});
	QLab.createWindowWorkspaceDocumentAccess = () => {
		throw new Error("window access unavailable");
	};
	const controller = QLab.createWindowController({
		deck: { ownerDocument: document }, _tabs: [], _onChatUtilityChanged() {},
	});
	assert.equal(await controller.readonlyDocumentIOForRoot("/repo"), null);
	await Promise.resolve();
	assert.equal(orphanedHostDestroyCalls, 1, "a host orphaned during construction is destroyed");
	controller.destroy();
});

test("window destroy cancels a QMD mount waiting for readonly IO before it can publish a workspace", async () => {
	const QLab = await loadQLab();
	let releaseReadonly;
	let readonlyEntered;
	const readonlyGate = new Promise(resolve => { releaseReadonly = resolve; });
	const entered = new Promise(resolve => { readonlyEntered = resolve; });
	let mountCalls = 0;
	let brokerDestroyCalls = 0;
	const host = {
		querySelector: () => null,
		addEventListener() {},
	};
	let container = null;
	const document = {
		defaultView: {},
		querySelectorAll: selector => selector === ".qlab-shell-host" ? [host] : [],
		getElementById: id => id === "qmd-tab" ? container : null,
	};
	host.ownerDocument = document;
	container = {
		id: "qmd-tab",
		ownerDocument: document,
		querySelector: selector => selector === ".qlab-shell-host" ? host : null,
	};
	QLab.ChatUtilityHost = class {
		snapshot() { return { pinned: false, bounds: {} }; }
		destroy() {}
		refreshWorkspace() { return Promise.resolve(); }
	};
	QLab.ChatOutsideInteractionBridge = class { dispose() {} };
	QLab.createQLabWorkspaceSetupCoordinator = () => ({
		targetEpoch: 19,
		workspaceSwitchBlocker: () => null, get: () => null, restore: () => null,
		replaceRoot: () => null, select: () => null, open: () => null,
		activateInitializedWorkspace: () => null, dispose() {},
	});
	QLab.Settings.getRoot = () => "/repo";
	QLab.createGeckoQLabPathHost = () => ({});
	QLab.qlabRepositoryState = async () => "ready";
	QLab.QmdDraftIO.listDrafts = async () => [];
	QLab.setHTML = () => {};
	QLab.ensureKatexStyles = () => {};
	QLab.registerMainSiteController = null;
	QLab.createGeckoWorkspaceDocumentLeaseHost = () => ({ marker: "lease" });
	QLab.createWindowWorkspaceDocumentAccess = () => ({
		async readonlyDocumentIOForRoot() {
			readonlyEntered();
			await readonlyGate;
			return Object.freeze({ marker: "late-readonly-io" });
		},
		async acquireVerifiedDocument() { return null; },
		async releaseVerifiedDocument() { return false; },
		async destroy() { brokerDestroyCalls++; return true; },
	});
	QLab.mountQmdWorkspace = async target => {
		mountCalls++;
		target._qlabQmdWorkspace = { dispose() {} };
		return target._qlabQmdWorkspace;
	};
	const tab = { id: "qmd-tab", type: "qlabqmd", data: { targetEpoch: 19 } };
	const tabsAPI = {
		deck: { ownerDocument: document },
		_tabs: [tab],
		_onChatUtilityChanged() {},
	};
	const controller = QLab.createWindowController(tabsAPI);
	tabsAPI._qlab = controller;
	document.defaultView.Zotero_Tabs = tabsAPI;
	const mounting = QLab.mountShellTab(container, "qlabqmd");
	await entered;

	controller.destroy();
	releaseReadonly();
	const mountResult = await mounting;
	await Promise.resolve();
	assert.equal(mountCalls, 0, "destroyed windows cannot publish a late QMD workspace");
	assert.equal(host._qlabQmdWorkspace || null, null);
	assert.equal(mountResult, null);
	assert.equal(brokerDestroyCalls, 1);
});
