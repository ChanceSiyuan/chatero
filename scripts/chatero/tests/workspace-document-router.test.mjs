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
	const bridges = {
		getSelectedRoot: async () => "/selected-link",
		canonicalizeRoot: async root => root === "/selected-link" || root === ROOT ? ROOT : root,
		findAttachment: async ({ relativePath }) => relativePath.endsWith("matched.pdf") ? 77 : null,
		openDraft: input => calls.push(["draft", input]),
		openReadonlyQmd: input => calls.push(["readonly-qmd", input]),
		openReadonlyBib: input => calls.push(["readonly-bib", input]),
		openKnowledgeSite: input => calls.push(["site", input]),
		openNativeReader: input => calls.push(["reader", input]),
		reviewPDFLink: input => calls.push(["review", input]),
	};
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
	const router = QLab.createWorkspaceDocumentRouter({
		getSelectedRoot: async () => ROOT,
		canonicalizeRoot: async root => root,
		findAttachment: async () => null,
		reviewPDFLink: () => { reviews++; },
		importAttachment: () => { throw new Error("must not import silently"); },
		openExternal: () => { throw new Error("must not open PDF generically"); },
	});
	const result = await router.open({ root: ROOT, relativePath: "literature/new.pdf" });
	assert.equal(result.action, "review-pdf-link");
	assert.equal(reviews, 1);
});
