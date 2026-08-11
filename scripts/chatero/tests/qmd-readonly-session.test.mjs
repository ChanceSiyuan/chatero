import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";
import {
	createVerifiedReadonlyRead,
	createVerifiedReadonlySession,
} from "../lib/verified-readonly-session.mjs";

const MUTATORS = [
	["applyHumanEdit", ["changed"]],
	["saveNow", []],
	["attachProposal", [{ workingPath: "work/unsafe.qmd" }]],
	["clearProposal", []],
	["applyAIEdit", ["changed"]],
	["completeTodos", []],
	["promoteToKnowledge", []],
	["insertFormalBlock", ["thm"]],
	["openExternalEditor", []],
	["insertPDFQuote", ["> quote"]],
	["addPendingInsert", [{ id: "pending" }]],
	["acceptPendingInsert", ["pending"]],
	["rejectPendingInsert", ["pending"]],
];

function frozenCapability(root, relativePath, overrides = {}) {
	const classification = {
		"knowledge/topic.qmd": { authority: "knowledge", kind: "qmd" },
		"literature/paper.md": { authority: "literature", kind: "markdown" },
		"literature/references.bib": { authority: "literature", kind: "bib" },
	}[relativePath];
	return Object.freeze({
		root,
		relativePath,
		canonicalPath: `${root}/${relativePath}`,
		authority: classification.authority,
		kind: classification.kind,
		writable: false,
		access: Object.freeze({ id: Symbol(relativePath) }),
		...overrides,
	});
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function verifiedIO(QLab, { root, relativePath, text }) {
	const active = new WeakSet();
	let sequence = 0;
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath });
	const io = QLab.createReadonlyDocumentIO({
		root,
		host: {
			verifyAccess: access => active.has(access),
			realPath: async value => value,
			readVerified: async () => ({
				text: String(text),
				size: String(text).length,
				lastModified: ++sequence,
			}),
		},
	});
	return {
		descriptor,
		io,
		issue() {
			const capability = frozenCapability(root, relativePath, {
				access: Object.freeze({ sequence: ++sequence }),
			});
			active.add(capability.access);
			return capability;
		},
	};
}

test("workspace descriptors reclassify safe paths and deeply freeze authority capabilities", async () => {
	const QLab = await loadQLab();
	const knowledge = QLab.createWorkspaceDocumentDescriptor({
		relativePath: "knowledge/topic.qmd",
		authority: "draft",
		format: "bibtex",
		readOnly: false,
	});
	assert.deepEqual(clone({
		relativePath: knowledge.relativePath,
		authority: knowledge.authority,
		format: knowledge.format,
		readOnly: knowledge.readOnly,
		badge: knowledge.badge,
		modelLanguage: knowledge.modelLanguage,
		surfaces: knowledge.surfaces,
	}), {
		relativePath: "knowledge/topic.qmd",
		authority: "knowledge",
		format: "qmd",
		readOnly: true,
		badge: "Trusted Knowledge",
		modelLanguage: "markdown",
		surfaces: ["visual", "website", "source"],
	});
	assert.equal(Object.isFrozen(knowledge), true);
	assert.equal(Object.isFrozen(knowledge.capabilities), true);
	assert.equal(Object.isFrozen(knowledge.surfaces), true);
	for (const allowed of ["read", "reload", "surfaceNavigation", "websiteNavigation", "selection", "chatSelection"]) {
		assert.equal(knowledge.capabilities[allowed], true, allowed);
	}
	for (const denied of [
		"edit", "save", "autosave", "proposal", "keepReject", "completeTodos",
		"promote", "insertFormalBlock", "externalEditor", "pdfQuote", "pendingReview",
		"aiWrite", "sharedBufferWrite",
	]) {
		assert.equal(knowledge.capabilities[denied], false, denied);
	}

	const bib = QLab.createWorkspaceDocumentDescriptor({
		relativePath: "literature/references.bib",
		authority: "knowledge",
		format: "qmd",
		readOnly: false,
	});
	assert.equal(bib.authority, "literature");
	assert.equal(bib.format, "bibtex");
	assert.equal(bib.badge, "External Evidence");
	assert.equal(bib.modelLanguage, "bibtex");
	assert.deepEqual(clone(bib.surfaces), ["source"]);

	assert.throws(
		() => QLab.createWorkspaceDocumentDescriptor({ relativePath: "drafts/a.qmd", readOnly: true }),
		/read-only|knowledge|literature/i,
	);
	for (const unsafe of ["knowledge/../drafts/a.qmd", "/knowledge/a.qmd", "literature/a.pdf", "literature/a.txt"]) {
		assert.throws(
			() => QLab.createWorkspaceDocumentDescriptor({ relativePath: unsafe }),
			/unsupported|unsafe|read-only/i,
			unsafe,
		);
	}
});

test("readonly sessions cannot be constructed from caller-supplied trusted bytes", async () => {
	const QLab = await loadQLab();
	const descriptor = QLab.createWorkspaceDocumentDescriptor({
		relativePath: "knowledge/topic.qmd",
	});
	assert.throws(
		() => QLab.createQmdDocumentSession({
			descriptor,
			text: "unverified but labeled trusted\n",
			revision: "caller-r1",
		}),
		/verified|fresh|read-only/i,
	);
});

test("readonly sessions deny every mutator without scheduling or saving", async () => {
	const QLab = await loadQLab();
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "literature/paper.md" });
	let schedules = 0;
	let saves = 0;
	let states = 0;
	const verifiedRead = await createVerifiedReadonlyRead(QLab, {
		descriptor,
		text: "original\n",
	});
	const session = QLab.createQmdDocumentSession({
		verifiedRead,
		schedule: () => { schedules++; return 1; },
		onSave: async () => { saves++; return { revision: "r2" }; },
		onState: () => { states++; },
	});
	const before = clone(session.snapshot());

	for (const [method, args] of MUTATORS) {
		assert.equal(typeof session[method], "function", method);
		assert.throws(() => session[method](...args), /read-only/i, method);
		assert.equal(session.snapshot().text, "original\n", method);
		assert.equal(session.snapshot().revision, before.revision, method);
		assert.equal(session.snapshot().dirty, false, method);
		assert.equal(session.snapshot().proposal, null, method);
	}

	assert.equal(schedules, 0);
	assert.equal(saves, 0);
	assert.equal(states, 0);
	assert.deepEqual(clone(session.snapshot()), before);
	assert.equal(session.capabilities, descriptor.capabilities);
	assert.equal(Object.isFrozen(session.capabilities), true);
	assert.equal(Object.isFrozen(session.document), true);
});

test("readonly sessions discard every forged descriptor capability surface and presentation field", async () => {
	const QLab = await loadQLab();
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
		const session = await createVerifiedReadonlySession(QLab, {
			descriptor: forged,
			text: "# Trusted\n",
		});
		assert.notEqual(session.document, forged, field);
		assert.deepEqual(clone(session.document), clone(normalized), field);
		assert.deepEqual(clone(session.snapshot().document), clone(normalized), field);
		assert.equal(session.capabilities.save, false, field);
		assert.equal(session.capabilities.aiWrite, false, field);
		assert.equal(session.capabilities.promote, false, field);
		assert.deepEqual(clone(session.document.surfaces), ["visual", "website", "source"], field);
		assert.equal(session.document.badge, "Trusted Knowledge", field);
	}
});

test("readonly sessions accept only freshly verified adapter reads for external reload", async () => {
	const QLab = await loadQLab();
	const root = "/tmp/readonly-session";
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/topic.qmd" });
	const active = new WeakSet();
	let sequence = 0;
	let source = "original\n";
	const io = QLab.createReadonlyDocumentIO({
		root,
		host: {
			verifyAccess: access => active.has(access),
			realPath: async value => value,
			readVerified: async () => ({ text: source, size: source.length, lastModified: ++sequence }),
		},
	});
	function issue(relativePath = descriptor.relativePath) {
		const capability = frozenCapability(root, relativePath, {
			access: Object.freeze({ sequence: ++sequence }),
		});
		active.add(capability.access);
		return capability;
	}
	const session = QLab.createQmdDocumentSession({
		verifiedRead: await io.read(issue(), descriptor),
	});
	const initialRevision = session.snapshot().revision;

	assert.throws(
		() => session.observeDisk({ text: "injected\n", revision: "r2" }),
		/verified|read-only/i,
	);
	assert.equal(session.snapshot().text, "original\n");

	source = "external\n";
	const verified = await io.read(issue(), descriptor);
	assert.equal(Object.isFrozen(verified), true);
	assert.equal(QLab.isVerifiedReadonlyDocumentRead(verified, descriptor), true);
	assert.equal(session.observeDisk(verified), true);
	assert.equal(session.snapshot().text, "external\n");
	assert.notEqual(session.snapshot().revision, initialRevision);

	const other = QLab.createWorkspaceDocumentDescriptor({ relativePath: "literature/paper.md" });
	assert.equal(QLab.isVerifiedReadonlyDocumentRead(verified, other), false);
	assert.throws(() => QLab.createQmdDocumentSession({
		verifiedRead: {
			document: { ...descriptor, capabilities: { ...descriptor.capabilities, edit: true } },
			text: "unsafe",
			revision: "unsafe",
		},
	}), /verified|fresh|read-only/i);

	session.dispose();
	assert.equal(session.snapshot().disposed, true);
	assert.equal(session.observeDisk(verified), false);
});

test("verified readonly reads are process-wide single-use across sessions and failed attempts", async () => {
	const QLab = await loadQLab();
	const root = "/tmp/readonly-replay";
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/topic.qmd" });
	const active = new WeakSet();
	const sources = new Map([
		[1, "first\n"],
		[2, "replay\n"],
		[3, "updated\n"],
		[4, "attempted\n"],
		[5, "evidence\n"],
		[6, "later\n"],
	]);
	const io = QLab.createReadonlyDocumentIO({
		root,
		host: {
			verifyAccess: access => active.has(access),
			realPath: async value => value,
			readVerified: async access => {
				const text = sources.get(access.sequence);
				return { text, size: text.length, lastModified: access.sequence };
			},
		},
	});
	function issue(sequence, relativePath = descriptor.relativePath) {
		const capability = frozenCapability(root, relativePath, {
			access: Object.freeze({ sequence }),
		});
		active.add(capability.access);
		return capability;
	}
	const first = QLab.createQmdDocumentSession({
		verifiedRead: await io.read(issue(1), descriptor),
	});
	const replay = QLab.createQmdDocumentSession({
		verifiedRead: await io.read(issue(2), descriptor),
	});
	const read = await io.read(issue(3), descriptor);
	assert.equal(first.observeDisk(read), true);
	assert.throws(() => replay.observeDisk(read), /verified|replay|consumed/i);
	assert.equal(replay.snapshot().text, "replay\n");

	const attempted = await io.read(issue(4), descriptor);
	const otherDescriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "literature/paper.md" });
	const wrong = QLab.createQmdDocumentSession({
		verifiedRead: await io.read(issue(5, otherDescriptor.relativePath), otherDescriptor),
	});
	assert.throws(() => wrong.observeDisk(attempted), /verified|read-only/i);
	const later = QLab.createQmdDocumentSession({
		verifiedRead: await io.read(issue(6), descriptor),
	});
	assert.throws(() => later.observeDisk(attempted), /verified|replay|consumed/i);
	assert.equal(later.snapshot().text, "later\n");
});

test("readonly sessions accept reload bytes only from the exact private IO identity", async () => {
	const QLab = await loadQLab();
	const root = "/tmp/readonly-identity";
	const relativePath = "knowledge/topic.qmd";
	const first = verifiedIO(QLab, {
		root,
		relativePath,
		text: "first identity\n",
	});
	const other = verifiedIO(QLab, {
		root,
		relativePath,
		text: "other identity\n",
	});
	const session = QLab.createQmdDocumentSession({
		verifiedRead: await first.io.read(first.issue(), first.descriptor),
	});
	const revision = session.snapshot().revision;
	const foreignReload = await other.io.read(other.issue(), other.descriptor);

	assert.throws(
		() => session.observeDisk(foreignReload),
		/identity|verified|read-only/i,
	);
	assert.equal(session.snapshot().text, "first identity\n");
	assert.equal(session.snapshot().revision, revision);

	const sameIdentityReload = await first.io.read(first.issue(), first.descriptor);
	assert.equal(session.observeDisk(sameIdentityReload), true);
	assert.equal(session.snapshot().text, "first identity\n");
	assert.notEqual(session.snapshot().revision, revision);
});
