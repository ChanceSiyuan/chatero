import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const ROOT = "/tmp/selected-research-loop";
const ORIGIN = "http://127.0.0.1:4180";
const plain = value => JSON.parse(JSON.stringify(value));

test("workspace document classification is closed by authority and extension", async () => {
	const QLab = await loadQLab();
	const cases = [
		["drafts/note.qmd", { kind: "qmd", authority: "draft", openMode: "edit", writable: true }],
		["knowledge/topic.qmd", { kind: "qmd", authority: "knowledge", openMode: "site", writable: false }],
		["literature/paper.qmd", { kind: "qmd", authority: "literature", openMode: "readonly", writable: false }],
		["literature/paper.md", { kind: "markdown", authority: "literature", openMode: "readonly", writable: false }],
		["literature/ref.bib", { kind: "bib", authority: "literature", openMode: "readonly", writable: false }],
		["literature/paper.pdf", { kind: "pdf", authority: "literature", openMode: "reader", writable: false }],
	];
	for (const [relativePath, expected] of cases) {
		assert.deepEqual(plain(QLab.classifyWorkspaceDocument(relativePath)), {
			path: relativePath,
			...expected,
		});
	}
	for (const relativePath of [
		"knowledge/file.md", "drafts/file.md", "literature/code.js", "work/note.qmd",
		"../knowledge/a.qmd", "/tmp/knowledge/a.qmd", "knowledge/a.qmd?path=../../x",
	]) {
		assert.equal(QLab.classifyWorkspaceDocument(relativePath), null, relativePath);
	}
});

test("workspace decisions keep Draft editable and Knowledge or Literature read-only", async () => {
	const QLab = await loadQLab();
	const decide = relativePath => QLab.workspaceDocumentOpenDecision({
		root: ROOT, selectedRoot: ROOT, relativePath, source: "explorer", placement: "current",
	});
	assert.equal(decide("drafts/note.qmd").action, "open-draft");
	assert.deepEqual(plain(decide("knowledge/topic.qmd")), {
		action: "open-knowledge-site", root: ROOT, relativePath: "knowledge/topic.qmd",
		sitePath: "/knowledge/topic.html", placement: "current",
	});
	assert.equal(QLab.workspaceDocumentOpenDecision({
		root: ROOT, selectedRoot: ROOT, relativePath: "knowledge/topic.qmd",
		source: "site", placement: "beside", explicitSource: true,
	}).action, "open-readonly-qmd");
	assert.equal(decide("literature/paper.qmd").action, "open-readonly-qmd");
	assert.equal(decide("literature/paper.md").action, "open-readonly-qmd");
	assert.equal(decide("literature/ref.bib").action, "open-readonly-bib");
});

test("PDF decisions reuse a matched native attachment and review an unmatched file", async () => {
	const QLab = await loadQLab();
	const base = {
		root: ROOT, selectedRoot: ROOT, relativePath: "literature/paper.pdf",
		source: "explorer", placement: "current",
	};
	assert.deepEqual(plain(QLab.workspaceDocumentOpenDecision({ ...base, attachmentID: 42 })), {
		action: "open-native-reader", root: ROOT, relativePath: "literature/paper.pdf",
		attachmentID: 42, placement: "current",
	});
	assert.equal(QLab.workspaceDocumentOpenDecision(base).action, "review-pdf-link");
	for (const attachmentID of ["42", 0, -1, 1.5, Number.NaN]) {
		assert.equal(
			QLab.workspaceDocumentOpenDecision({ ...base, attachmentID }).action,
			"review-pdf-link",
		);
	}
});

test("workspace decisions refuse foreign roots, traversal, unsupported entry points, and metadata injection", async () => {
	const QLab = await loadQLab();
	for (const input of [
		{ root: "/tmp/foreign", selectedRoot: ROOT, relativePath: "drafts/a.qmd" },
		{ root: ROOT, selectedRoot: ROOT, relativePath: "drafts/../knowledge/a.qmd" },
		{ root: ROOT, selectedRoot: ROOT, relativePath: "/tmp/a.qmd" },
		{ root: ROOT, selectedRoot: ROOT, relativePath: "drafts/a.exe" },
		{ root: ROOT, selectedRoot: ROOT, relativePath: "drafts/a.qmd", source: "shell" },
		{ root: ROOT, selectedRoot: ROOT, relativePath: "drafts/a.qmd", placement: "window" },
	]) {
		assert.equal(QLab.workspaceDocumentOpenDecision(input).action, "refuse");
	}
	const injected = QLab.workspaceDocumentOpenDecision({
		root: ROOT, selectedRoot: ROOT, relativePath: "knowledge/topic.qmd",
		metadata: { action: "open-draft", executable: "/bin/sh", url: "https://evil.test" },
	});
	assert.equal(injected.action, "open-knowledge-site");
	assert.equal("executable" in injected, false);
	assert.equal("url" in injected, false);
});

test("Knowledge URL mapping accepts only the exact active origin and known safe routes", async () => {
	const QLab = await loadQLab();
	const availablePaths = new Set([
		"knowledge/index.qmd", "knowledge/topic.qmd", "knowledge/section/index.qmd",
	]);
	const map = requestedURL => QLab.knowledgeURLToQmdPath({
		currentSiteOrigin: ORIGIN, requestedURL, availablePaths,
	});
	assert.equal(map(`${ORIGIN}/knowledge/`), "knowledge/index.qmd");
	assert.equal(map(`${ORIGIN}/knowledge/topic.html?view=source#theorem`), "knowledge/topic.qmd");
	assert.equal(map(`${ORIGIN}/knowledge/section/`), "knowledge/section/index.qmd");
	for (const requestedURL of [
		"http://127.0.0.1:4181/knowledge/topic.html",
		"http://localhost:4180/knowledge/topic.html",
		`${ORIGIN}/drafts/topic.html`,
		`${ORIGIN}/knowledge/missing.html`,
		`${ORIGIN}/knowledge/topic.pdf`,
		`${ORIGIN}/knowledge/%2e%2e/drafts/a.html`,
		`${ORIGIN}/knowledge/section%2F..%2Ftopic.html`,
		`${ORIGIN}/knowledge/section%5Ctopic.html`,
	]) {
		assert.equal(map(requestedURL), null, requestedURL);
	}
});

test("router canonicalizes roots, resolves PDF matches, and calls only fixed action bridges", async () => {
	const QLab = await loadQLab();
	const calls = [];
	const bridges = securityBridges({
		getSelectedRoot: async () => "/selected-link",
		canonicalizeRoot: async root => root === "/selected-link" || root === ROOT ? ROOT : root,
		findAttachment: async capability => capability.relativePath.endsWith("matched.pdf") ? 77 : null,
		openDraft: input => { calls.push(["draft", input]); return true; },
		openReadonlyQmd: input => { calls.push(["readonly-qmd", input]); return true; },
		openReadonlyBib: input => { calls.push(["readonly-bib", input]); return true; },
		openKnowledgeSite: input => { calls.push(["site", input]); return true; },
		openNativeReader: input => { calls.push(["reader", input]); return true; },
		reviewPDFLink: input => { calls.push(["review", input]); return true; },
	});
	const router = QLab.createWorkspaceDocumentRouter(bridges);
	assert.equal((await router.open({ root: "/selected-link", relativePath: "drafts/a.qmd" })).action, "open-draft");
	assert.equal((await router.open({ root: ROOT, relativePath: "literature/matched.pdf" })).action, "open-native-reader");
	assert.equal((await router.open({ root: ROOT, relativePath: "literature/new.pdf" })).action, "review-pdf-link");
	assert.equal((await router.open({
		root: ROOT, relativePath: "knowledge/a.qmd",
		metadata: { executable: "/bin/sh", url: "https://evil.test", action: "open-draft" },
	})).action, "open-knowledge-site");
	assert.deepEqual(calls.map(([name]) => name), ["draft", "reader", "review", "site"]);
	assert.equal((await router.open({ root: "/tmp/foreign", relativePath: "drafts/a.qmd" })).action, "refuse");
	assert.deepEqual(calls.map(([name]) => name), ["draft", "reader", "review", "site"]);
});

test("unmatched PDF review never silently imports or opens a generic file URL", async () => {
	const QLab = await loadQLab();
	let reviews = 0;
	const router = QLab.createWorkspaceDocumentRouter(securityBridges({
		findAttachment: async () => null,
		reviewPDFLink: () => { reviews++; return true; },
		importAttachment: () => { throw new Error("must not import silently"); },
		openExternal: () => { throw new Error("must not open PDF generically"); },
	}));
	const result = await router.open({ root: ROOT, relativePath: "literature/new.pdf" });
	assert.equal(result.action, "review-pdf-link");
	assert.equal(reviews, 1);
});

function verifiedCapability(request, overrides = {}) {
	return Object.freeze({
		root: request.root,
		relativePath: request.relativePath,
		canonicalPath: `${request.root}/${request.relativePath}`,
		authority: request.authority,
		kind: request.kind,
		writable: request.writable,
		access: Object.freeze({ fixture: true }),
		...overrides,
	});
}

function securityBridges(overrides = {}) {
	return {
		getSelectedRoot: async () => ROOT,
		getSelectionEpoch: async () => 7,
		canonicalizeRoot: async root => root,
		getCurrentSiteOrigin: async () => ORIGIN,
		getKnowledgePaths: async () => ["knowledge/index.qmd", "knowledge/topic.qmd"],
		acquireVerifiedDocument: async request => verifiedCapability(request),
		releaseVerifiedDocument: async () => {},
		// Deliberately retain the obsolete bridge while running RED against the
		// previous router; the remediated router must ignore it completely.
		withVerifiedDocument: async (request, callback) => callback(verifiedCapability(request)),
		...overrides,
	};
}

test("router rejects the obsolete callback guard and requires document lease acquisition", async () => {
	const QLab = await loadQLab();
	let opens = 0;
	const router = QLab.createWorkspaceDocumentRouter({
		getSelectedRoot: async () => ROOT,
		getSelectionEpoch: async () => 7,
		canonicalizeRoot: async root => root,
		validateDocument: async () => true,
		withVerifiedDocument: async (request, callback) => callback(verifiedCapability(request)),
		openDraft: () => { opens++; return true; },
	});
	const result = await router.open({ root: ROOT, relativePath: "drafts/a.qmd" });
	assert.equal(result.action, "refuse");
	assert.equal(result.reason, "verified-document-lease-unavailable");
	assert.equal(opens, 0);
});

test("null, false, and throwing lease acquisition cannot dispatch", async () => {
	const QLab = await loadQLab();
	for (const acquire of [
		async () => null,
		async () => false,
		async () => { throw new Error("verification failed"); },
	]) {
		let opens = 0;
		const router = QLab.createWorkspaceDocumentRouter(securityBridges({
			acquireVerifiedDocument: acquire,
			openDraft: () => { opens++; },
		}));
		assert.equal((await router.open({ root: ROOT, relativePath: "drafts/a.qmd" })).action, "refuse");
		assert.equal(opens, 0);
	}
});

test("mismatched or non-opaque verified capabilities refuse symlink and canonical escapes", async () => {
	const QLab = await loadQLab();
	for (const capability of [
		request => verifiedCapability(request, { canonicalPath: "/tmp/outside/note.qmd" }),
		request => verifiedCapability(request, { root: "/tmp/outside" }),
		request => Object.freeze({ ...verifiedCapability(request), access: null }),
		request => Object.freeze({ ...verifiedCapability(request), access: null, token: Symbol("not-weak") }),
	]) {
		let opens = 0;
		const router = QLab.createWorkspaceDocumentRouter(securityBridges({
			acquireVerifiedDocument: async request => capability(request),
			openDraft: () => { opens++; },
		}));
		const result = await router.open({ root: ROOT, relativePath: "drafts/a.qmd" });
		assert.equal(result.action, "refuse");
		assert.equal(opens, 0);
	}
});

test("site routing ignores request-supplied origin and availability evidence", async () => {
	const QLab = await loadQLab();
	let opens = 0;
	const router = QLab.createWorkspaceDocumentRouter(securityBridges({
		getCurrentSiteOrigin: async () => ORIGIN,
		getKnowledgePaths: async () => ["knowledge/index.qmd"],
		openReadonlyQmd: () => { opens++; },
	}));
	const forgedMissing = await router.open({
		root: ROOT,
		requestedURL: `${ORIGIN}/knowledge/forged.html`,
		currentSiteOrigin: ORIGIN,
		availablePaths: ["knowledge/forged.qmd"],
		pathExists: () => true,
	});
	assert.equal(forgedMissing.action, "refuse");
	const forgedOrigin = await router.open({
		root: ROOT,
		requestedURL: "http://127.0.0.1:4181/knowledge/index.html",
		currentSiteOrigin: "http://127.0.0.1:4181",
		availablePaths: ["knowledge/index.qmd"],
	});
	assert.equal(forgedOrigin.action, "refuse");
	assert.equal(opens, 0);
});

test("root or selection epoch changes during lease acquisition refuse before dispatch", async () => {
	const QLab = await loadQLab();
	for (const changed of ["root", "epoch"]) {
		let reads = 0;
		let opens = 0;
		const router = QLab.createWorkspaceDocumentRouter(securityBridges({
			getSelectedRoot: async () => (++reads > 1 && changed === "root" ? "/tmp/other" : ROOT),
			getSelectionEpoch: async () => (reads > 1 && changed === "epoch" ? 8 : 7),
			openDraft: () => { opens++; },
		}));
		const result = await router.open({ root: ROOT, relativePath: "drafts/a.qmd" });
		assert.equal(result.action, "refuse");
		assert.equal(opens, 0);
	}
});

test("selection epoch is mandatory and must be a valid nonempty scalar", async () => {
	const QLab = await loadQLab();
	for (const epoch of [undefined, null, "", "   ", -1, 1.5, Number.NaN, true, {}]) {
		let opens = 0;
		const bridges = securityBridges({ openDraft: () => { opens++; } });
		if (epoch === undefined) delete bridges.getSelectionEpoch;
		else bridges.getSelectionEpoch = async () => epoch;
		const result = await QLab.createWorkspaceDocumentRouter(bridges)
			.open({ root: ROOT, relativePath: "drafts/a.qmd" });
		assert.equal(result.action, "refuse", String(epoch));
		assert.equal(opens, 0);
	}
});

test("same-root A to B to A selection change is detected by mandatory epoch", async () => {
	const QLab = await loadQLab();
	let epochReads = 0;
	let opens = 0;
	const router = QLab.createWorkspaceDocumentRouter(securityBridges({
		getSelectedRoot: async () => ROOT,
		getSelectionEpoch: async () => (++epochReads === 1 ? "repo-A:1" : "repo-A:3"),
		openDraft: () => { opens++; return true; },
	}));
	const result = await router.open({ root: ROOT, relativePath: "drafts/a.qmd" });
	assert.equal(result.action, "refuse");
	assert.equal(opens, 0);
});

test("a verified capability is single-use and a repeated lease cannot dispatch twice", async () => {
	const QLab = await loadQLab();
	let opens = 0;
	const request = {
		root: ROOT, relativePath: "drafts/a.qmd", authority: "draft", kind: "qmd", writable: true,
	};
	const repeated = verifiedCapability(request);
	const router = QLab.createWorkspaceDocumentRouter(securityBridges({
		acquireVerifiedDocument: async () => repeated,
		openDraft: () => { opens++; return true; },
	}));
	assert.equal((await router.open({ root: ROOT, relativePath: "drafts/a.qmd" })).action, "open-draft");
	assert.equal((await router.open({ root: ROOT, relativePath: "drafts/a.qmd" })).action, "refuse");
	assert.equal(opens, 1);
});

test("a host-owned access token cannot be reused through a fresh capability wrapper", async () => {
	const QLab = await loadQLab();
	let opens = 0;
	const access = Object.freeze({ lease: "same-host-handle" });
	const router = QLab.createWorkspaceDocumentRouter(securityBridges({
		acquireVerifiedDocument: async request => verifiedCapability(request, { access }),
		openDraft: () => { opens++; return true; },
	}));
	assert.equal((await router.open({ root: ROOT, relativePath: "drafts/a.qmd" })).action, "open-draft");
	assert.equal((await router.open({ root: ROOT, relativePath: "drafts/a.qmd" })).action, "refuse");
	assert.equal(opens, 1);
});

test("fixed action bridges must resolve true and every refusal still releases the lease", async () => {
	const QLab = await loadQLab();
	for (const bridgeResult of [false, undefined, null, { action: "refuse" }]) {
		let releases = 0;
		const router = QLab.createWorkspaceDocumentRouter(securityBridges({
			openDraft: async () => bridgeResult,
			releaseVerifiedDocument: async () => { releases++; },
		}));
		const result = await router.open({ root: ROOT, relativePath: "drafts/a.qmd" });
		assert.equal(result.action, "refuse");
		assert.equal(result.reason, "routing-bridge-refused");
		assert.equal(releases, 1);
	}
	let releases = 0;
	const throwing = QLab.createWorkspaceDocumentRouter(securityBridges({
		openDraft: async () => { throw new Error("open failed"); },
		releaseVerifiedDocument: async () => { releases++; },
	}));
	const failed = await throwing.open({ root: ROOT, relativePath: "drafts/a.qmd" });
	assert.equal(failed.action, "refuse");
	assert.equal(failed.reason, "document-lease-operation-failed");
	assert.equal(releases, 1);
});

test("the complete fixed action table dispatches only inside the guard with its capability", async () => {
	const QLab = await loadQLab();
	const order = [];
	const calls = [];
	const bridges = securityBridges({
		findAttachment: async (capability) => capability.relativePath.endsWith("matched.pdf") ? 77 : null,
		acquireVerifiedDocument: async request => {
			order.push(`acquire:${request.relativePath}`);
			return verifiedCapability(request);
		},
		releaseVerifiedDocument: async capability => {
			order.push(`release:${capability.relativePath}`);
		},
		openDraft: (...args) => { order.push("bridge:draft"); calls.push(["draft", ...args]); return true; },
		openReadonlyQmd: (...args) => { order.push("bridge:readonly-qmd"); calls.push(["readonly-qmd", ...args]); return true; },
		openReadonlyBib: (...args) => { order.push("bridge:readonly-bib"); calls.push(["readonly-bib", ...args]); return true; },
		openKnowledgeSite: (...args) => { order.push("bridge:site"); calls.push(["site", ...args]); return true; },
		openNativeReader: (...args) => { order.push("bridge:reader"); calls.push(["reader", ...args]); return true; },
		reviewPDFLink: (...args) => { order.push("bridge:review"); calls.push(["review", ...args]); return true; },
	});
	const router = QLab.createWorkspaceDocumentRouter(bridges);
	const requests = [
		{ relativePath: "drafts/a.qmd", expected: "open-draft" },
		{ relativePath: "literature/a.qmd", expected: "open-readonly-qmd" },
		{ relativePath: "literature/ref.bib", expected: "open-readonly-bib" },
		{ relativePath: "knowledge/topic.qmd", expected: "open-knowledge-site" },
		{ relativePath: "literature/matched.pdf", expected: "open-native-reader" },
		{ relativePath: "literature/new.pdf", expected: "review-pdf-link" },
	];
	for (const request of requests) {
		assert.equal((await router.open({ root: ROOT, ...request })).action, request.expected);
	}
	assert.equal((await router.open({
		root: ROOT,
		requestedURL: `${ORIGIN}/knowledge/topic.html`,
		currentSiteOrigin: "http://127.0.0.1:4199",
		availablePaths: [],
	})).action, "open-readonly-qmd");
	assert.deepEqual(calls.map(call => call[0]), [
		"draft", "readonly-qmd", "readonly-bib", "site", "reader", "review", "readonly-qmd",
	]);
	for (const [name, decision, capability] of calls) {
		assert.equal(typeof name, "string");
		assert.ok(decision.action.startsWith("open-") || decision.action === "review-pdf-link");
		assert.equal(Object.isFrozen(capability), true);
		assert.ok(capability.access);
		assert.equal("capability" in decision, false);
	}
	assert.equal(order.length, (requests.length + 1) * 3);
	for (let index = 0; index < order.length; index += 3) {
		assert.match(order[index], /^acquire:/);
		assert.match(order[index + 1], /^bridge:/);
		assert.match(order[index + 2], /^release:/);
	}
});
