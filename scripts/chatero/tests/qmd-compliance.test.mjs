import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

function reading(files) {
	let reads = [];
	return {
		reads,
		host: {
			realPath: async path => path,
			read: async path => {
				reads.push(path);
				if (!Object.hasOwn(files, path)) throw new Error(`Missing fixture: ${path}`);
				return files[path];
			},
		},
	};
}

test("runQmdCompliance checks a ready QLab Draft without a repository package script", async () => {
	const QLab = await loadQLab();
	let fixture = reading({
		"/qlab/drafts/theory/note.qmd": [
			"---",
			"title: A safe note",
			"description: A local compliance fixture.",
			"categories: [theory]",
			"aliases:",
			"  - note alias",
			"---",
			"See @knuth1984.",
		].join("\n"),
		"/qlab/literature/ref.bib": "@book{knuth1984, title={The TeXbook}}\n",
	});

	const result = await QLab.runQmdCompliance(
		"/qlab",
		"drafts/theory/note.qmd",
		{ host: fixture.host },
	);

	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, diagnostics: [] });
	assert.deepEqual(fixture.reads, [
		"/qlab/drafts/theory/note.qmd",
		"/qlab/literature/ref.bib",
	]);
});

test("runQmdCompliance reports required, unsupported, and invalid frontmatter fields", async () => {
	const QLab = await loadQLab();
	let fixture = reading({
		"/qlab/drafts/note.qmd": [
			"---",
			"title:",
			"description:",
			"categories: [unknown]",
			"owner: Research Loop",
			"---",
			"Body.",
		].join("\n"),
		"/qlab/literature/ref.bib": "",
	});

	const result = await QLab.runQmdCompliance("/qlab", "drafts/note.qmd", { host: fixture.host });

	assert.deepEqual(JSON.parse(JSON.stringify(result.diagnostics)), [
		{ code: "DRAFT_TITLE_REQUIRED", message: "title is required", line: 2 },
		{ code: "DRAFT_DESCRIPTION_REQUIRED", message: "description is required", line: 3 },
		{ code: "DRAFT_CATEGORY_INVALID", message: "category must be theory, experiment, or codes", line: 4 },
		{ code: "DRAFT_FRONTMATTER_FIELD_UNSUPPORTED", message: "owner is not allowed in Draft frontmatter", line: 5 },
	]);
});

test("runQmdCompliance rejects unsafe paths without reading the workspace", async () => {
	const QLab = await loadQLab();
	let fixture = reading({});

	const result = await QLab.runQmdCompliance("/qlab", "drafts/../literature/ref.bib", {
		host: fixture.host,
	});

	assert.equal(result.ok, false);
	assert.deepEqual(fixture.reads, []);
	assert.equal(result.diagnostics[0].code, "DRAFT_CHECK_FAILED");
	assert.match(result.diagnostics[0].message, /safe drafts\/.+\.qmd path/i);
});

test("runQmdCompliance reports unsafe markup and missing bibliography citekeys", async () => {
	const QLab = await loadQLab();
	let fixture = reading({
		"/qlab/drafts/note.qmd": [
			"---",
			"title: Safe metadata",
			"description: Safe description",
			"categories: codes",
			"---",
			"<script>run()</script>",
			"<button onclick=\"run()\">Run</button>",
			"See @known and @missing.",
		].join("\n"),
		"/qlab/literature/ref.bib": "@article{known, title={Known reference}}\n",
	});

	const result = await QLab.runQmdCompliance("/qlab", "drafts/note.qmd", { host: fixture.host });

	assert.deepEqual(JSON.parse(JSON.stringify(result.diagnostics)), [
		{ code: "DRAFT_SCRIPT_FORBIDDEN", message: "script tags are not allowed in Drafts", line: 6 },
		{ code: "DRAFT_INLINE_HANDLER_FORBIDDEN", message: "inline event handlers are not allowed in Drafts", line: 7 },
		{ code: "DRAFT_CITEKEY_MISSING", message: "citekey @missing is not in literature/ref.bib", line: 8 },
	]);
});

test("runQmdCompliance validates supplied dirty Draft and bibliography buffers without reading disk", async () => {
	const QLab = await loadQLab();
	const result = await QLab.runQmdCompliance("/qlab", "drafts/note.qmd", {
		source: [
			"---",
			"title: Unsaved buffer",
			"description: This must not be replaced with the saved Draft.",
			"categories: experiment",
			"---",
			"See @buffered.",
		].join("\n"),
		bibliographyText: "@article{buffered, title={Buffered reference}}\n",
	});

	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, diagnostics: [] });
});

test("built-in compliance accepts YAML comments and ignores prose or code that only resembles active content", async () => {
	const QLab = await loadQLab();
	const result = await QLab.runQmdCompliance("/qlab", "drafts/note.qmd", {
		source: [
			"---",
			"title: A note # ordinary YAML comment",
			"description: \"A # quoted value\" # trailing comment",
			"categories: [theory] # contract category",
			"---",
			"The equation says one = two only as prose.",
			"Inline code `@missing` is not a citation.",
			"```text",
			"@missing",
			"<button onclick=\"run()\">sample</button>",
			"```",
			"A real citation remains @known.",
		].join("\n"),
		bibliographyText: "@article{known, title={Known reference}}\n",
	});

	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, diagnostics: [] });
});

test("runQmdCompliance rejects unclosed frontmatter and still checks unsafe body content", async () => {
	const QLab = await loadQLab();
	const result = await QLab.runQmdCompliance("/qlab", "drafts/note.qmd", {
		source: [
			"---",
			"title: An unfinished header",
			"description: The closing delimiter is missing.",
			"categories: theory",
			"<script>run()</script>",
			"See @missing.",
		].join("\n"),
		bibliographyText: "",
	});

	assert.deepEqual(JSON.parse(JSON.stringify(result.diagnostics)), [
		{
			code: "DRAFT_FRONTMATTER_UNCLOSED",
			message: "Draft frontmatter must end with --- or ...",
			line: 1,
		},
		{
			code: "DRAFT_SCRIPT_FORBIDDEN",
			message: "script tags are not allowed in Drafts",
			line: 5,
		},
		{
			code: "DRAFT_CITEKEY_MISSING",
			message: "citekey @missing is not in literature/ref.bib",
			line: 6,
		},
	]);
});
