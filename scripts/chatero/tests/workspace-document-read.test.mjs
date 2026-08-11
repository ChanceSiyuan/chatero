import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

function nodeHost(active) {
	return {
		verifyAccess: access => active.has(access),
		realPath: value => fs.realpath(value),
		readVerified: async (_access, capability) => {
			const text = await fs.readFile(capability.canonicalPath, "utf8");
			const stat = await fs.stat(capability.canonicalPath);
			return { text, size: stat.size, lastModified: stat.mtimeMs };
		},
	};
}

function lease(root, relativePath, classification, access, overrides = {}) {
	return Object.freeze({
		root,
		relativePath,
		canonicalPath: path.join(root, relativePath),
		authority: classification.authority,
		kind: classification.kind,
		writable: false,
		access,
		...overrides,
	});
}

async function fixture() {
	const created = await fs.mkdtemp(path.join(os.tmpdir(), "chatero-readonly-"));
	const root = await fs.realpath(created);
	await fs.mkdir(path.join(root, "knowledge"));
	await fs.mkdir(path.join(root, "literature"));
	await fs.writeFile(path.join(root, "knowledge", "topic.qmd"), "# Trusted\n");
	await fs.writeFile(path.join(root, "literature", "paper.md"), "# Evidence\n");
	await fs.writeFile(path.join(root, "literature", "refs.bib"), "@book{safe}\n");
	return root;
}

test("verified readonly IO reads each supported format only through a live exact lease", async t => {
	const QLab = await loadQLab();
	const root = await fixture();
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const active = new WeakSet();
	const io = QLab.createReadonlyDocumentIO({ root, host: nodeHost(active) });

	for (const [relativePath, expected, expectedFormat] of [
		["knowledge/topic.qmd", "# Trusted\n", "qmd"],
		["literature/paper.md", "# Evidence\n", "markdown"],
		["literature/refs.bib", "@book{safe}\n", "bibtex"],
	]) {
		const descriptor = QLab.createWorkspaceDocumentDescriptor({
			relativePath,
			authority: "draft",
			format: "qmd",
			readOnly: false,
		});
		const access = Object.freeze({ relativePath });
		active.add(access);
		const capability = lease(root, relativePath, QLab.classifyWorkspaceDocument(relativePath), access);
		const read = await io.read(capability, descriptor);
		assert.equal(read.text, expected);
		assert.notEqual(read.document, descriptor);
		assert.deepEqual(
			JSON.parse(JSON.stringify(read.document)),
			JSON.parse(JSON.stringify(descriptor)),
		);
		assert.equal(read.document.format, expectedFormat);
		assert.equal(QLab.isVerifiedReadonlyDocumentRead(read, descriptor), true);

		active.delete(access);
		await assert.rejects(() => io.read(capability, descriptor), /access|lease|verified|revoked/i);
	}

	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/topic.qmd" });
	for (const overrides of [
		{ authority: "literature" },
		{ kind: "bib" },
		{ writable: true },
		{ canonicalPath: path.join(root, "literature", "paper.md") },
		{ root: `${root}-other` },
	]) {
		const access = Object.freeze({ mismatch: overrides });
		active.add(access);
		const capability = lease(
			root,
			"knowledge/topic.qmd",
			QLab.classifyWorkspaceDocument("knowledge/topic.qmd"),
			access,
			overrides,
		);
		await assert.rejects(() => io.read(capability, descriptor), /capability|canonical|root|verified/i);
	}
});

test("verified readonly IO never exposes caller-forged descriptor fields", async t => {
	const QLab = await loadQLab();
	const root = await fixture();
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const active = new WeakSet();
	const io = QLab.createReadonlyDocumentIO({ root, host: nodeHost(active) });
	const normalized = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/topic.qmd" });
	const variants = [];
	for (const [name, value] of Object.entries(normalized.capabilities)) {
		variants.push([
			`capabilities.${name}`,
			Object.freeze({
				...normalized,
				capabilities: Object.freeze({ ...normalized.capabilities, [name]: !value }),
			}),
		]);
	}
	variants.push(
		["surfaces", Object.freeze({ ...normalized, surfaces: Object.freeze(["source"]) })],
		["badge", Object.freeze({ ...normalized, badge: "Forged Draft" })],
		["tooltip", Object.freeze({ ...normalized, tooltip: "Writable" })],
		["modelLanguage", Object.freeze({ ...normalized, modelLanguage: "javascript" })],
		["authority", Object.freeze({ ...normalized, authority: "draft" })],
		["format", Object.freeze({ ...normalized, format: "bibtex" })],
		["readOnly", Object.freeze({ ...normalized, readOnly: false })],
		["writable", Object.freeze({ ...normalized, writable: true })],
	);

	for (const [field, forged] of variants) {
		const access = Object.freeze({ field });
		active.add(access);
		const capability = lease(
			root,
			normalized.relativePath,
			QLab.classifyWorkspaceDocument(normalized.relativePath),
			access,
		);
		const read = await io.read(capability, forged);
		assert.notEqual(read.document, forged, field);
		assert.deepEqual(JSON.parse(JSON.stringify(read.document)), JSON.parse(JSON.stringify(normalized)), field);
		assert.equal(read.document.capabilities.save, false, field);
		assert.equal(read.document.capabilities.aiWrite, false, field);
		assert.equal(read.document.badge, "Trusted Knowledge", field);
		assert.deepEqual(JSON.parse(JSON.stringify(read.document.surfaces)), ["visual", "website", "source"], field);
	}
});

test("readonly IO refuses a generic path read host at the atomic-read boundary", async () => {
	const QLab = await loadQLab();
	assert.throws(() => QLab.createReadonlyDocumentIO({
		root: "/verified/repository",
		host: {
			verifyAccess: () => true,
			realPath: async value => value,
			read: async () => "SECRET",
		},
	}), /readVerified|atomic|handle|verified read/i);
});

test("a verified capability is synchronously claimed before concurrent access verification", async () => {
	const QLab = await loadQLab();
	const root = "/verified/repository";
	const relativePath = "knowledge/topic.qmd";
	const access = Object.freeze({ concurrent: true });
	const capability = lease(
		root,
		relativePath,
		QLab.classifyWorkspaceDocument(relativePath),
		access,
	);
	let releaseVerify;
	const verifying = new Promise(resolve => { releaseVerify = resolve; });
	let readCalls = 0;
	const io = QLab.createReadonlyDocumentIO({
		root,
		host: {
			verifyAccess: async () => { await verifying; return true; },
			realPath: async value => value,
			readVerified: async () => {
				readCalls++;
				return { text: "# Trusted\n", size: 10, lastModified: 1 };
			},
		},
	});
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath });
	const first = io.read(capability, descriptor);
	const second = io.read(capability, descriptor);
	await Promise.resolve();
	releaseVerify();
	const settled = await Promise.allSettled([first, second]);

	assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
	assert.equal(settled.filter(result => result.status === "rejected").length, 1);
	assert.equal(readCalls, 1);
});

test("Node readonly lease host reads from its leaf O_NOFOLLOW handle after a path swap", async t => {
	const QLab = await loadQLab();
	const root = await fixture();
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "chatero-readonly-swap-"));
	t.after(async () => {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	});
	const target = path.join(root, "knowledge", "topic.qmd");
	const moved = path.join(root, "knowledge", "original.qmd");
	const secret = path.join(outside, "secret.qmd");
	await fs.writeFile(secret, "SECRET\n");
	let closes = 0;
	const instrumentedFS = {
		...fs,
		constants: fs.constants,
		async open(...args) {
			const handle = await fs.open(...args);
			return {
				stat: (...inner) => handle.stat(...inner),
				readFile: (...inner) => handle.readFile(...inner),
				async close() { closes++; return handle.close(); },
			};
		},
	};
	const host = QLab.createNodeReadonlyDocumentLeaseHost(instrumentedFS, path);
	const request = Object.freeze({
		root,
		relativePath: "knowledge/topic.qmd",
		authority: "knowledge",
		kind: "qmd",
		writable: false,
	});
	const capability = await host.acquireVerifiedDocument(request);
	await fs.rename(target, moved);
	await fs.symlink(secret, target);

	const read = await host.readVerified(capability.access, capability);
	assert.equal(read.text, "# Trusted\n");
	assert.equal(await host.releaseVerifiedDocument(capability), true);
	assert.equal(closes, 1);
	await assert.rejects(() => host.readVerified(capability.access, capability), /revoked|lease|access/i);
});

test("reload force-revokes a handle-bound lease when the supplied release bridge fails", async t => {
	const QLab = await loadQLab();
	const root = await fixture();
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/topic.qmd" });

	for (const mode of ["false", "throw"]) {
		const host = QLab.createNodeReadonlyDocumentLeaseHost(fs, path);
		let issued;
		t.after(async () => {
			if (issued && host.verifyAccess(issued.access, issued)) {
				await host.releaseVerifiedDocument(issued);
			}
		});
		const io = QLab.createReadonlyDocumentIO({
			root,
			host,
			acquireVerifiedDocument: async request => {
				issued = await host.acquireVerifiedDocument(request);
				return issued;
			},
			releaseVerifiedDocument: async () => {
				if (mode === "throw") throw new Error("release bridge failed");
				return false;
			},
		});
		await assert.rejects(() => io.reload(descriptor), /release|revoke/i, mode);
		assert.equal(host.verifyAccess(issued.access, issued), false, mode);
		await assert.rejects(
			() => host.readVerified(issued.access, issued),
			/revoked|lease|access/i,
			mode,
		);
	}
});

test("verified readonly IO rejects file, ancestor, and authority-boundary symlink escapes", async t => {
	const QLab = await loadQLab();
	const root = await fixture();
	const outsideCreated = await fs.mkdtemp(path.join(os.tmpdir(), "chatero-readonly-outside-"));
	const outside = await fs.realpath(outsideCreated);
	t.after(async () => {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	});
	await fs.writeFile(path.join(outside, "secret.qmd"), "secret\n");
	await fs.mkdir(path.join(outside, "nested"));
	await fs.writeFile(path.join(outside, "nested", "secret.md"), "nested secret\n");
	await fs.symlink(path.join(outside, "secret.qmd"), path.join(root, "knowledge", "linked.qmd"));
	await fs.symlink(path.join(outside, "nested"), path.join(root, "literature", "escaped"));

	const active = new WeakSet();
	const io = QLab.createReadonlyDocumentIO({ root, host: nodeHost(active) });
	for (const relativePath of ["knowledge/linked.qmd", "literature/escaped/secret.md"]) {
		const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath });
		const access = Object.freeze({ relativePath });
		active.add(access);
		const capability = lease(root, relativePath, QLab.classifyWorkspaceDocument(relativePath), access);
		await assert.rejects(() => io.read(capability, descriptor), /symbolic link|outside|exact|canonical/i);
	}

	await fs.rm(path.join(root, "knowledge"), { recursive: true });
	await fs.symlink(outside, path.join(root, "knowledge"));
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/secret.qmd" });
	const access = Object.freeze({ boundary: true });
	active.add(access);
	await assert.rejects(
		() => io.read(
			lease(root, descriptor.relativePath, QLab.classifyWorkspaceDocument(descriptor.relativePath), access),
			descriptor,
		),
		/symbolic link|outside|boundary|canonical/i,
	);
});

test("every readonly reload acquires, reads, and releases a fresh verified lease", async t => {
	const QLab = await loadQLab();
	const root = await fixture();
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const active = new WeakSet();
	const issued = [];
	const order = [];
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "literature/paper.md" });
	const io = QLab.createReadonlyDocumentIO({
		root,
		host: nodeHost(active),
		acquireVerifiedDocument: async request => {
			order.push(`acquire:${request.relativePath}`);
			const access = Object.freeze({ sequence: issued.length + 1 });
			active.add(access);
			const capability = lease(root, request.relativePath, request, access);
			issued.push(capability);
			return capability;
		},
		releaseVerifiedDocument: async capability => {
			order.push(`release:${capability.access.sequence}`);
			active.delete(capability.access);
			return true;
		},
		onRead: capability => order.push(`read:${capability.access.sequence}`),
	});

	const first = await io.reload(descriptor);
	const second = await io.reload(descriptor);
	assert.equal(first.text, "# Evidence\n");
	assert.equal(second.text, "# Evidence\n");
	assert.notEqual(issued[0].access, issued[1].access);
	assert.deepEqual(order, [
		"acquire:literature/paper.md", "read:1", "release:1",
		"acquire:literature/paper.md", "read:2", "release:2",
	]);
	await assert.rejects(() => io.read(issued[0], descriptor), /access|lease|verified|revoked/i);

	const broken = QLab.createReadonlyDocumentIO({
		root,
		host: nodeHost(active),
		acquireVerifiedDocument: async request => {
			const access = Object.freeze({ broken: true });
			active.add(access);
			return lease(root, request.relativePath, request, access);
		},
		releaseVerifiedDocument: async capability => {
			active.delete(capability.access);
			return false;
		},
	});
	await assert.rejects(() => broken.reload(descriptor), /release|revoke/i);
});

test("readonly revisions include content identity even when size and mtime are unchanged", async () => {
	const QLab = await loadQLab();
	const root = "/verified/repository";
	const relativePath = "knowledge/topic.qmd";
	const active = new WeakSet();
	let text = "AAAA";
	const io = QLab.createReadonlyDocumentIO({
		root,
		host: {
			verifyAccess: access => active.has(access),
			realPath: async value => value,
			readVerified: async () => ({ text, size: 4, lastModified: 1234 }),
		},
	});
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath });
	const firstAccess = Object.freeze({ generation: 1 });
	active.add(firstAccess);
	const first = await io.read(lease(
		root, relativePath, QLab.classifyWorkspaceDocument(relativePath), firstAccess,
	), descriptor);
	text = "BBBB";
	const secondAccess = Object.freeze({ generation: 2 });
	active.add(secondAccess);
	const second = await io.read(lease(
		root, relativePath, QLab.classifyWorkspaceDocument(relativePath), secondAccess,
	), descriptor);

	assert.notEqual(first.revision, second.revision);
});

test("router prepares readonly IO and commits the document manager only after mandatory lease revocation", async t => {
	const QLab = await loadQLab();
	const root = await fixture();
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const active = new WeakSet();
	let retained;
	let snapshot;
	let manager;
	const order = [];
	const router = QLab.createWorkspaceDocumentRouter({
		getSelectedRepositoryState: async () => Object.freeze({ root, epoch: 1 }),
		canonicalizeRoot: async value => value,
		acquireVerifiedDocument: async request => {
			order.push("acquire");
			const access = Object.freeze({ live: true });
			active.add(access);
			return lease(root, request.relativePath, request, access);
		},
		releaseVerifiedDocument: async capability => {
			assert.equal(manager.snapshot().document, null, "prepared bytes must remain unpublished");
			order.push("release");
			active.delete(capability.access);
			return true;
		},
		openReadonlyQmd: async (decision, capability) => {
			retained = { decision, capability };
			const io = QLab.createReadonlyDocumentIO({
				root,
				host: nodeHost(active),
				onRead: () => order.push("read"),
			});
			manager = QLab.createQmdWorkspaceDocumentManager({
				root,
				readonlyIO: io,
				onActivate: () => order.push("commit"),
			});
			return manager.prepareWorkspaceDocument(decision, capability);
		},
	});

	const result = await router.open({ root, relativePath: "literature/paper.md" });
	snapshot = manager.snapshot();
	assert.equal(result.action, "open-readonly-qmd");
	assert.equal(snapshot.document.relativePath, "literature/paper.md");
	assert.equal(snapshot.session.snapshot().text, "# Evidence\n");
	assert.deepEqual(order, ["acquire", "read", "release", "commit"]);
	const io = QLab.createReadonlyDocumentIO({ root, host: nodeHost(active) });
	await assert.rejects(
		() => io.read(retained.capability, QLab.createWorkspaceDocumentDescriptor(retained.decision)),
		/access|lease|verified|revoked/i,
	);
});

test("failed router lease release rolls back the prepared session and preserves the active manager document", async t => {
	const QLab = await loadQLab();
	const root = await fixture();
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const active = new WeakSet();
	const io = QLab.createReadonlyDocumentIO({ root, host: nodeHost(active) });
	const manager = QLab.createQmdWorkspaceDocumentManager({ root, readonlyIO: io });
	const draft = QLab.createQmdDraftSession({
		path: "drafts/active.qmd",
		text: "# Active Draft\n",
		revision: "draft-1",
		onSave: async () => ({ revision: "draft-2" }),
	});
	assert.equal(manager.activateDraft(draft), true);
	let preparedSession;
	const originalCreate = QLab.createQmdDocumentSession;
	QLab.createQmdDocumentSession = input => {
		preparedSession = originalCreate(input);
		return preparedSession;
	};
	t.after(() => { QLab.createQmdDocumentSession = originalCreate; });

	const router = QLab.createWorkspaceDocumentRouter({
		getSelectedRepositoryState: async () => Object.freeze({ root, epoch: 1 }),
		canonicalizeRoot: async value => value,
		acquireVerifiedDocument: async request => {
			const access = Object.freeze({ live: true });
			active.add(access);
			return lease(root, request.relativePath, request, access);
		},
		releaseVerifiedDocument: async capability => {
			active.delete(capability.access);
			return false;
		},
		openReadonlyQmd: (decision, capability) => (
			manager.prepareWorkspaceDocument(decision, capability)
		),
	});

	const result = await router.open({ root, relativePath: "literature/paper.md" });
	assert.deepEqual(JSON.parse(JSON.stringify(result)), {
		action: "refuse",
		reason: "document-lease-release-failed",
	});
	assert.equal(manager.snapshot().document.relativePath, "drafts/active.qmd");
	assert.equal(manager.snapshot().session, draft);
	assert.equal(draft.snapshot().disposed, false);
	assert.equal(preparedSession.snapshot().disposed, true);
});
