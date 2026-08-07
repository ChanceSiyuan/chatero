import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const DOC = [
	"---",
	"title: Draft",
	"---",
	"",
	"# Heading",
	"",
	"First paragraph.",
	"",
	"```{r}",
	"plot(x)",
	"```",
	"",
	"Last paragraph.",
	"",
].join("\n");

test("snapQmdOffset never lands inside the frontmatter", async () => {
	const QLab = await loadQLab();
	const frontmatterEnd = DOC.indexOf("---\n\n") + "---\n".length;
	assert.equal(QLab.snapQmdOffset(DOC, 0), frontmatterEnd);
	assert.equal(QLab.snapQmdOffset(DOC, 5), frontmatterEnd);
});

test("snapQmdOffset never splits a fenced code block", async () => {
	const QLab = await loadQLab();
	const inside = DOC.indexOf("plot(x)") + 3;
	const snapped = QLab.snapQmdOffset(DOC, inside);
	const blocks = QLab.visualQmdBlocks(DOC);
	const code = blocks.find((b) => b.kind === "code");
	assert.ok(snapped === code.start || snapped === code.end);
});

test("composeQmdInsertion pads block inserts with a blank line", async () => {
	const QLab = await loadQLab();
	const anchor = { mode: "cursor", offset: DOC.indexOf("First paragraph.") };
	const result = QLab.composeQmdInsertion(DOC, anchor, "Inserted line.");
	assert.equal(result.changed, true);
	assert.ok(result.source.includes("\n\nInserted line.\n\nFirst paragraph."));
	assert.equal(
		result.source.slice(result.insertedStart, result.insertedEnd),
		"Inserted line.",
	);
});

test("composeQmdInsertion after-block inserts below the chosen block", async () => {
	const QLab = await loadQLab();
	const blocks = QLab.visualQmdBlocks(DOC);
	const headingIndex = blocks.findIndex((b) => b.kind === "heading");
	const result = QLab.composeQmdInsertion(
		DOC,
		{ mode: "after-block", blockIndex: headingIndex },
		"> quoted",
	);
	assert.ok(result.source.includes("# Heading\n\n> quoted\n\nFirst paragraph."));
});

test("composeQmdInsertion appends at the end and keeps a trailing newline", async () => {
	const QLab = await loadQLab();
	const result = QLab.composeQmdInsertion("A paragraph.", { mode: "end" }, "Tail.");
	assert.equal(result.source, "A paragraph.\n\nTail.\n");
});

test("composeQmdInsertion is a no-op for empty snippets", async () => {
	const QLab = await loadQLab();
	const result = QLab.composeQmdInsertion(DOC, { mode: "end" }, "   \n  ");
	assert.equal(result.changed, false);
	assert.equal(result.source, DOC);
});

test("composeQmdInsertion on an empty draft does not lead with blank lines", async () => {
	const QLab = await loadQLab();
	const result = QLab.composeQmdInsertion("", { mode: "end" }, "First.");
	assert.equal(result.source, "First.\n");
	assert.equal(result.insertedStart, 0);
});

test("buildQuoteSnippet carries a public chatero deep link to the page", async () => {
	const QLab = await loadQLab();
	const snippet = QLab.buildQuoteSnippet({
		text: "scaled dot-product attention",
		title: "Attention Is All You Need",
		origin: { type: "pdf", key: "ABCDEFGH", pageNumber: 3 },
	});
	assert.ok(snippet.startsWith("> scaled dot-product attention"));
	assert.ok(
		snippet.includes(
			"[Attention Is All You Need, p. 3](chatero://open-pdf/library/items/ABCDEFGH?page=3)",
		),
	);
});

test("buildQuoteSnippet prefers a cite key when one is known", async () => {
	const QLab = await loadQLab();
	const snippet = QLab.buildQuoteSnippet({
		text: "a claim",
		title: "Paper",
		citeKey: "vaswani2017",
		origin: { type: "pdf", key: "ABCDEFGH", pageNumber: 3 },
	});
	assert.ok(snippet.includes("[@vaswani2017, p. 3]"));
});

test("buildQuoteSnippet quotes every line, including blank ones", async () => {
	const QLab = await loadQLab();
	const snippet = QLab.buildQuoteSnippet({ text: "one\n\ntwo" });
	assert.equal(snippet, "> one\n>\n> two");
});

test("qmdSourceLink uses the group path for group libraries", async () => {
	const QLab = await loadQLab();
	assert.equal(
		QLab.qmdSourceLink({ type: "pdf", key: "K", groupID: 42, pageNumber: 2 }),
		"chatero://open-pdf/groups/42/items/K?page=2",
	);
	assert.equal(QLab.qmdSourceLink({ type: "qmd" }), "");
});

test("buildChatSnippet inserts assistant prose as authored text", async () => {
	const QLab = await loadQLab();
	assert.equal(QLab.buildChatSnippet({ text: "  a reply  " }), "a reply");
	assert.throws(() => QLab.buildChatSnippet({ text: "" }));
});

test("revertQmdRegion removes the insert and its padding exactly", async () => {
	const QLab = await loadQLab();
	const inserted = QLab.composeQmdInsertion(DOC, { mode: "end" }, "Added.");
	const reverted = QLab.revertQmdRegion(inserted.source, inserted);
	assert.equal(reverted.source, DOC);
});

test("revertQmdRegion re-anchors when the text moved", async () => {
	const QLab = await loadQLab();
	const inserted = QLab.composeQmdInsertion(DOC, { mode: "end" }, "Added.");
	const shifted = `PREFIX\n\n${inserted.source}`;
	const reverted = QLab.revertQmdRegion(shifted, inserted);
	assert.equal(reverted.source, `PREFIX\n\n${DOC}`);
});

test("revertQmdRegion refuses an ambiguous match instead of guessing", async () => {
	const QLab = await loadQLab();
	const inserted = QLab.composeQmdInsertion(DOC, { mode: "end" }, "Added.");
	// Offsets moved *and* the same text now appears twice, so re-anchoring by
	// content cannot tell the two apart.
	const ambiguous = `PREFIX\n\n${inserted.source}${inserted.outerText}`;
	assert.throws(
		() => QLab.revertQmdRegion(ambiguous, inserted),
		/more than once/,
	);
});

test("revertQmdRegion reports a change that is already gone", async () => {
	const QLab = await loadQLab();
	const inserted = QLab.composeQmdInsertion(DOC, { mode: "end" }, "Added.");
	assert.throws(
		() => QLab.revertQmdRegion(DOC, inserted),
		/no longer present/,
	);
});

test("revertQmdRegion restores the original text for a replaced block", async () => {
	const QLab = await loadQLab();
	const blocks = QLab.visualQmdBlocks(DOC);
	const index = blocks.findIndex((b) => b.kind === "paragraph");
	const replaced = QLab.composeQmdInsertion(
		DOC,
		{ mode: "replace-block", blockIndex: index },
		"Rewritten paragraph.",
	);
	assert.ok(replaced.source.includes("Rewritten paragraph."));
	assert.equal(QLab.revertQmdRegion(replaced.source, replaced).source, DOC);
});

test("two inserts can be rejected in either order", async () => {
	const QLab = await loadQLab();
	const first = QLab.composeQmdInsertion(DOC, { mode: "end" }, "One.");
	let regions = [{ ...first, id: "a" }];

	const second = QLab.composeQmdInsertion(
		first.source,
		{ mode: "cursor", offset: first.source.indexOf("# Heading") },
		"Two.",
	);
	// A later insert lands before the first one, so the first must move.
	regions = QLab.shiftQmdRegions(
		regions,
		second.outerStart,
		second.outerText.length - second.previousOuterText.length,
	).concat({ ...second, id: "b" });

	const buffer = second.source;
	const oldest = regions.find((r) => r.id === "a");
	const undoOldest = QLab.revertQmdRegion(buffer, oldest);
	assert.ok(!undoOldest.source.includes("One."));
	assert.ok(undoOldest.source.includes("Two."));

	const newest = regions.find((r) => r.id === "b");
	const undoNewest = QLab.revertQmdRegion(buffer, newest);
	assert.ok(undoNewest.source.includes("One."));
	assert.ok(!undoNewest.source.includes("Two."));
});

test("shiftQmdRegions leaves regions before the edit untouched", async () => {
	const QLab = await loadQLab();
	const regions = [
		{ outerStart: 0, outerEnd: 10, insertedStart: 0, insertedEnd: 8 },
		{ outerStart: 40, outerEnd: 50, insertedStart: 42, insertedEnd: 48 },
	];
	const shifted = QLab.shiftQmdRegions(regions, 20, 5);
	assert.equal(shifted[0].outerStart, 0);
	assert.equal(shifted[1].outerStart, 45);
	assert.equal(shifted[1].insertedEnd, 53);
});

test("qmdAnchorContext returns the blocks around the anchor", async () => {
	const QLab = await loadQLab();
	const context = QLab.qmdAnchorContext(
		DOC,
		{ mode: "cursor", offset: DOC.indexOf("```{r}") },
		{ before: 2, after: 1 },
	);
	assert.ok(context.before.includes("First paragraph."));
	assert.ok(context.before.includes("# Heading"));
	assert.ok(context.after.startsWith("```{r}"));
});

test("buildQmdInlineWritePrompt frames the anchor and demands bare markdown", async () => {
	const QLab = await loadQLab();
	const prompt = QLab.buildQmdInlineWritePrompt({
		instruction: "summarise the attention mechanism",
		composerContext: "<composer_context>\n[@pdf-selection x]\n</composer_context>",
		before: "# Heading",
		after: "Last paragraph.",
		draftPath: "drafts/notes.qmd",
	});
	assert.ok(prompt.includes("<composer_context>"));
	assert.ok(prompt.includes("draft: drafts/notes.qmd"));
	assert.ok(prompt.includes("instruction: summarise the attention mechanism"));
	assert.ok(prompt.includes("<qmd_text_before>\n# Heading\n</qmd_text_before>"));
	assert.ok(prompt.includes("<qmd_text_after>\nLast paragraph.\n</qmd_text_after>"));
	assert.ok(prompt.includes("Return only the Quarto Markdown"));
});

test("buildQmdInlineWritePrompt requires an instruction", async () => {
	const QLab = await loadQLab();
	assert.throws(() => QLab.buildQmdInlineWritePrompt({ instruction: "   " }));
});

test("stripQmdAnswerFence unwraps a whole-answer code fence only", async () => {
	const QLab = await loadQLab();
	assert.equal(
		QLab.stripQmdAnswerFence("```markdown\nHello **world**\n```"),
		"Hello **world**",
	);
	// A fence that is part of the content must survive.
	const withCode = "Text\n\n```r\nplot(x)\n```\n\nMore text";
	assert.equal(QLab.stripQmdAnswerFence(withCode), withCode);
});

test("qmdAnchorOffset resolves each anchor mode", async () => {
	const QLab = await loadQLab();
	const blocks = QLab.visualQmdBlocks(DOC);
	const heading = blocks.findIndex((b) => b.kind === "heading");
	assert.equal(QLab.qmdAnchorOffset(DOC, { mode: "end" }), DOC.length);
	assert.equal(
		QLab.qmdAnchorOffset(DOC, { mode: "after-block", blockIndex: heading }),
		blocks[heading].end,
	);
	assert.equal(
		QLab.qmdAnchorOffset(DOC, { mode: "before-block", blockIndex: heading }),
		blocks[heading].start,
	);
});
