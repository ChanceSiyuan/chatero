import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const SAMPLE = `---
title: Demo
---

# Hello

A paragraph with **bold**.

\`\`\`js
console.log(1)
\`\`\`

::: {.theorem}
## Claim

Proof body.
:::
`;

const FORMAL_MATH_SOURCE = `::: {#def-r-local-function .callout-note icon="false"}
## ($r$-local function)

A function $f(u,G,x)$ is $r$-local iff
$f(u,G,x)=F\\!\\left(\\mathcal V_r(u,G,x)\\right).$
:::`;

test("visualQmdBlocks splits frontmatter heading paragraph code theorem", async () => {
	const QLab = await loadQLab();
	const blocks = QLab.visualQmdBlocks(SAMPLE);
	const kinds = blocks.map((b) => b.kind);
	assert.ok(kinds.includes("frontmatter"));
	assert.ok(kinds.includes("heading"));
	assert.ok(kinds.includes("paragraph"));
	assert.ok(kinds.includes("code"));
	assert.ok(kinds.includes("theorem"));
});

for (const [label, source] of [
	["LF", FORMAL_MATH_SOURCE],
	["CRLF", FORMAL_MATH_SOURCE.replace(/\n/g, "\r\n")],
]) {
	test(`visualQmdBlocks exposes the exact block-local formal title range for ${label}`, async () => {
		const QLab = await loadQLab();
		const original = `Before.${label === "CRLF" ? "\r\n\r\n" : "\n\n"}${source}`;
		const block = QLab.visualQmdBlocks(original).find(candidate => candidate.semantic === "definition");

		assert.ok(block);
		assert.equal(block.title, "($r$-local function)");
		assert.deepEqual(JSON.parse(JSON.stringify(block.titleRange)), {
			source: "($r$-local function)",
			start: block.source.indexOf("($r$-local function)"),
			end: block.source.indexOf("($r$-local function)") + "($r$-local function)".length,
		});
		assert.equal(
			original.slice(
				block.start + block.titleRange.start,
				block.start + block.titleRange.end,
			),
			block.titleRange.source,
		);
	});
}

test("applyQmdVisualBlock updates source losslessly", async () => {
	const QLab = await loadQLab();
	const blocks = QLab.visualQmdBlocks(SAMPLE);
	const heading = blocks.find((b) => b.kind === "heading");
	const result = QLab.applyQmdVisualBlock(SAMPLE, heading, "# Hello world");
	assert.equal(result.changed, true);
	assert.match(result.source, /# Hello world/);
	assert.ok(!result.source.includes("# Hello\n") || result.source.includes("# Hello world"));
});

test("surface modes normalize, migrate, label, and cycle Visual/Website/Source", async () => {
	const QLab = await loadQLab();
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.QMD_SURFACE_MODES)), [
		"visual",
		"website",
		"source",
	]);
	assert.equal(QLab.normalizeQmdSurfaceMode("website"), "website");
	assert.equal(QLab.normalizeQmdSurfaceMode("preview"), "website");
	assert.equal(QLab.normalizeQmdSurfaceMode("nope"), "visual");
	assert.equal(QLab.qmdSurfaceModeLabel("visual"), "Visual Edit");
	assert.equal(QLab.qmdSurfaceModeLabel("website"), "Website Preview");
	assert.equal(QLab.qmdSurfaceModeLabel("source"), "Monaco Source");
	assert.equal(QLab.nextQmdSurfaceMode("visual"), "website");
	assert.equal(QLab.nextQmdSurfaceMode("website"), "source");
	assert.equal(QLab.nextQmdSurfaceMode("source"), "visual");
});

test("legacy surface requests delegate to the resident native workspace without repainting it", async () => {
	const QLab = await loadQLab();
	let requested = [];
	const host = {
		_qlabQmdWorkspace: {
			showSurface(mode) {
				requested.push(mode);
				return Promise.resolve(true);
			},
		},
		querySelector() {
			throw new Error("legacy surface code must not query the native workspace DOM");
		},
		querySelectorAll() {
			throw new Error("legacy surface code must not repaint resident panes");
		},
	};
	QLab.applyQmdSurfaceMode(host, "preview");
	assert.deepEqual(requested, ["website"]);
});

test("qmd shell HTML keeps Visual Edit, Website Preview, and Monaco resident", async () => {
	const QLab = await loadQLab();
	const html = QLab.renderShellHTML({
		kind: "qlabqmd",
		workspaceState: "ready",
		root: "/tmp/ws",
		drafts: ["drafts/a.qmd"],
	});
	assert.match(html, /data-qlab-visual-surface/);
	assert.match(html, /data-qlab-qmd-monaco/);
	assert.match(html, /data-qlab-qmd-preview/);
	assert.match(html, /data-qlab-preview-quick/);
	assert.match(html, /data-qlab-preview-browser-host/);
	assert.match(html, /data-qlab-editor/);
});

test("shared buffer survives mode metadata and soft website HTML", async () => {
	const QLab = await loadQLab();
	const descriptor = QLab.createQmdDraftDocumentDescriptor({ relativePath: "drafts/a.qmd" });
	const host = {
		_qlabDocumentState: Object.freeze({ document: descriptor, path: descriptor.relativePath, revision: "r1" }),
		_qlabBuffer: "",
		querySelector(sel) {
			if (sel === "[data-qlab-editor]") {
				return { value: this._editor || "" };
			}
			return null;
		},
	};
	QLab.setQmdShellBuffer(host, SAMPLE, { dirty: false });
	assert.equal(QLab.getQmdShellBuffer(host), SAMPLE);
	const doc = QLab.renderQmdDocumentHTML(SAMPLE, { title: "Demo" });
	assert.match(doc, /<!DOCTYPE html>/);
	assert.match(doc, /Hello/);
});

test("readonly shared buffer rejects direct writes and synthetic source flushes while navigation remains available", async () => {
	const QLab = await loadQLab();
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/topic.qmd" });
	const editor = { value: "synthetic mutation" };
	let visualRenders = 0;
	let websiteRenders = 0;
	QLab.renderQmdVisualPane = () => { visualRenders++; };
	QLab.refreshQmdWebsitePane = async () => { websiteRenders++; };
	const host = {
		_qlabDocumentState: Object.freeze({ document: descriptor, path: descriptor.relativePath, revision: "r1" }),
		_qlabBuffer: SAMPLE,
		_qlabDirty: false,
		_qlabLastSaved: SAMPLE,
		_qlabSurfaceMode: "source",
		_qlabQmdWorkspace: null,
		querySelector(selector) {
			if (selector === "[data-qlab-editor]") return editor;
			if (selector === ".qlab-shell-status") return { textContent: "" };
			return null;
		},
		querySelectorAll: () => [],
	};

	assert.equal(QLab.setQmdShellBuffer(host, "attack", { dirty: true, render: true }), false);
	QLab.applyQmdSurfaceMode(host, "website");
	assert.equal(host._qlabBuffer, SAMPLE);
	assert.equal(host._qlabDirty, false);
	assert.equal(host._qlabLastSaved, SAMPLE);
	assert.equal(host._qlabSurfaceMode, "website");
	assert.equal(editor.value, "synthetic mutation");
	assert.equal(visualRenders, 0);
	assert.equal(websiteRenders, 1, "readonly Website navigation remains available");
});

test("stale Website preview completions cannot write across an exact document identity switch", async () => {
	const logged = [];
	const QLab = await loadQLab({ logError: error => logged.push(error) });
	const urlB = "http://127.0.0.1:43002/b.html";
	const srcdocB = "<p>B current preview</p>";
	const metaB = "B current metadata";
	const statusB = "B current status";
	let outcomes = [];

	for (let completion of ["success", "error"]) {
		let previewOwner = null;
		let releasedOwners = [];
		let resolvePreview;
		let rejectPreview;
		let markStarted;
		let started = new Promise((resolve) => {
			markStarted = resolve;
		});
		let preview = new Promise((resolve, reject) => {
			resolvePreview = resolve;
			rejectPreview = reject;
		});
		QLab.startQmdQuartoPreview = (root, path, options = {}) => {
			assert.equal(root, "/repo");
			assert.equal(path, "drafts/a.qmd");
			previewOwner = options.owner || null;
			markStarted();
			return preview;
		};
		QLab.stopQmdQuartoPreview = (root, path, options = {}) => {
			releasedOwners.push({ root, path, owner: options.owner || null });
		};

		let documentA = QLab.createQmdDraftDocumentDescriptor({ relativePath: "drafts/a.qmd" });
		let documentB = QLab.createQmdDraftDocumentDescriptor({ relativePath: "drafts/b.qmd" });
		let stateA = Object.freeze({ document: documentA, path: documentA.relativePath, revision: "a-r1" });
		let stateB = Object.freeze({ document: documentB, path: documentB.relativePath, revision: "b-r1" });
		let writes = [];
		let websiteUrl = "";
		let attributes = new Map();
		let metadata = "";
		let status = "";
		let frame = {
			removeAttribute(name) {
				writes.push(["frame.removeAttribute", name]);
				attributes.delete(name);
			},
			setAttribute(name, value) {
				writes.push(["frame.setAttribute", name, value]);
				attributes.set(name, value);
			},
		};
		let meta = {
			get textContent() {
				return metadata;
			},
			set textContent(value) {
				writes.push(["metadata.textContent", value]);
				metadata = value;
			},
		};
		let statusNode = {
			get textContent() {
				return status;
			},
			set textContent(value) {
				writes.push(["status.textContent", value]);
				status = value;
			},
		};
		let pane = {
			querySelector(selector) {
				if (selector === "[data-qlab-website-frame]") return frame;
				if (selector === "[data-qlab-website-meta]") return meta;
				return null;
			},
		};
		let host = {
			_qlabDocumentState: stateA,
			_qlabDraftState: { originalPath: documentA.relativePath, viewingWorking: false },
			_qlabBuffer: "A source\n",
			querySelector(selector) {
				if (selector === '[data-qlab-surface="website"]') return pane;
				if (selector === ".qlab-shell-status") return statusNode;
				return null;
			},
		};
		Object.defineProperty(host, "_qlabWebsiteUrl", {
			get() {
				return websiteUrl;
			},
			set(value) {
				writes.push(["host._qlabWebsiteUrl", value]);
				websiteUrl = value;
			},
		});

		let request = QLab.refreshQmdWebsitePane(host, { root: "/repo" });
		await started;
		assert.notEqual(stateA, stateB);
		host._qlabDocumentState = stateB;
		host._qlabDraftState = { originalPath: documentB.relativePath, viewingWorking: false };
		host._qlabBuffer = "B source\n";
		websiteUrl = urlB;
		attributes.set("src", urlB);
		attributes.set("srcdoc", srcdocB);
		metadata = metaB;
		status = statusB;
		writes.length = 0;

		if (completion === "success") {
			resolvePreview("http://127.0.0.1:43001/a.html");
		}
		else {
			rejectPreview(new Error("A preview failed"));
		}
		outcomes.push({
			completion,
			result: await request,
			writes: [...writes],
			websiteUrl,
			src: attributes.get("src"),
			srcdoc: attributes.get("srcdoc"),
			metadata,
			status,
			owned: !!previewOwner,
			released: releasedOwners.length === 1
				&& releasedOwners[0].root === "/repo"
				&& releasedOwners[0].path === "drafts/a.qmd"
				&& releasedOwners[0].owner === previewOwner,
		});
	}

	assert.deepEqual(outcomes, ["success", "error"].map(completion => ({
		completion,
		result: false,
		writes: [],
		websiteUrl: urlB,
		src: urlB,
		srcdoc: srcdocB,
		metadata: metaB,
		status: statusB,
		owned: true,
		released: true,
	})));
	assert.deepEqual(logged, [], "a superseded preview rejection is not a current error");
});

test("readonly legacy Visual and pending-review entry points stay inert", async () => {
	const QLab = await loadQLab();
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "literature/paper.qmd" });
	const block = QLab.visualQmdBlocks(SAMPLE).find(item => item.kind === "paragraph");
	let replacements = 0;
	let pendingHTML = 0;
	const card = {
		classList: { contains: () => false, toggle() {} },
		querySelector: () => null,
		replaceChildren() { replacements++; },
	};
	const pane = {
		_qlabBlocks: [block],
		querySelector: () => card,
		querySelectorAll: () => [card],
	};
	const bar = {
		hidden: false,
		replaceChildren() { this.cleared = true; },
	};
	const host = {
		_qlabDocumentState: Object.freeze({ document: descriptor, path: descriptor.relativePath, revision: "r1" }),
		_qlabBuffer: SAMPLE,
		_qlabDirty: false,
		_qlabActiveBlockIndex: null,
		_qlabPendingInserts: [{ id: "stale", insertedStart: 1, insertedEnd: 2 }],
		querySelector(selector) {
			if (selector === '[data-qlab-surface="visual"]') return pane;
			if (selector === "[data-qlab-pending]") return bar;
			return null;
		},
	};
	QLab.setHTML = () => { pendingHTML++; };

	assert.equal(QLab.beginQmdVisualBlockEdit(host, 0), false);
	QLab.renderQmdPendingBar(host);
	assert.equal(replacements, 0);
	assert.equal(host._qlabActiveBlockIndex, null);
	assert.deepEqual(Array.from(host._qlabPendingInserts), []);
	assert.equal(bar.hidden, true);
	assert.equal(bar.cleared, true);
	assert.equal(pendingHTML, 0);
});

test("a frozen readonly host descriptor cannot forge any denied capability", async () => {
	const QLab = await loadQLab();
	const descriptor = QLab.createWorkspaceDocumentDescriptor({ relativePath: "knowledge/topic.qmd" });
	const denied = [
		"edit", "save", "autosave", "proposal", "keepReject", "completeTodos", "promote",
		"insertFormalBlock", "externalEditor", "pdfQuote", "pendingReview", "aiWrite",
		"sharedBufferWrite",
	];
	for (const capability of denied) {
		const forged = Object.freeze({
			...descriptor,
			capabilities: Object.freeze({ ...descriptor.capabilities, [capability]: true }),
		});
		const host = {
			_qlabDocumentState: Object.freeze({
				document: forged,
				path: forged.relativePath,
				revision: "r1",
			}),
		};
		assert.equal(QLab.qmdHostAllows(host, capability), false, capability);
	}
});

test("mutable Draft state can never substitute for immutable host document authority", async () => {
	const QLab = await loadQLab();
	const host = {
		_qlabDraftState: {
			originalPath: "drafts/forged.qmd",
			workingPath: "work/forged.qmd",
		},
	};
	assert.equal(QLab.getQmdHostDocumentDescriptor(host), null);
	for (const capability of ["edit", "save", "aiWrite", "pendingReview", "sharedBufferWrite"]) {
		assert.equal(QLab.qmdHostAllows(host, capability), false, capability);
	}
});

test("pendingRegionsForQmdBlock finds overlapping inserts", async () => {
	const QLab = await loadQLab();
	const descriptor = QLab.createQmdDraftDocumentDescriptor({ relativePath: "drafts/a.qmd" });
	const blocks = QLab.visualQmdBlocks(SAMPLE);
	const paragraph = blocks.find((b) => b.kind === "paragraph");
	const host = {
		_qlabDocumentState: Object.freeze({ document: descriptor, path: descriptor.relativePath, revision: "r1" }),
		_qlabPendingInserts: [
			{
				id: "r1",
				insertedStart: paragraph.start + 1,
				insertedEnd: paragraph.start + 4,
			},
			{
				id: "r2",
				insertedStart: paragraph.end + 10,
				insertedEnd: paragraph.end + 20,
			},
		],
	};
	const hits = QLab.pendingRegionsForQmdBlock(host, paragraph);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].id, "r1");
});

test("preview port is stable for a seed", async () => {
	const QLab = await loadQLab();
	const a = QLab.nextQmdPreviewPort(42);
	const b = QLab.nextQmdPreviewPort(42);
	assert.equal(a, b);
	assert.ok(a >= 43000 && a < 44500);
});
