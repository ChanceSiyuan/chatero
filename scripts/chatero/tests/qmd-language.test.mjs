import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("QMD completions include theorem-family snippets and BibTeX citekeys", async () => {
	const QLab = await loadQLab();
	let items = QLab.qmdCompletionItems({
		source: "See @bra",
		offset: 8,
		bibliographyText: [
			"@article{bravyi_correcting_2018, title={Correcting}}",
			"@book{wilson_rg_1975, title={RG}}",
		].join("\n"),
	});
	let labels = Array.from(items, item => item.label);
	assert.ok(labels.includes("Theorem block"));
	assert.ok(labels.includes("Lemma block"));
	assert.ok(labels.includes("Definition block"));
	assert.ok(labels.includes("Proof block"));
	assert.ok(labels.includes("@bravyi_correcting_2018"));
	assert.equal(labels.includes("@wilson_rg_1975"), false);
	assert.match(items.find(item => item.label === "Definition block").insertText, /#def-/);
});

test("language snapshot maps explicit theorem IDs and inline math", async () => {
	const QLab = await loadQLab();
	let snapshot = QLab.qmdLanguageSnapshot([
		"# Fixed points",
		"",
		":::{#lem-contraction .callout-note icon=false}",
		"The map $R_b$ is contractive.",
		":::",
		"",
	].join("\n"), "");
	let lemma = Array.from(snapshot.blocks).find(block => block.key === "div:lem-contraction");
	assert.ok(lemma);
	assert.equal(lemma.semantic, "lemma");
	assert.ok(Array.from(snapshot.decorations).some(item => item.kind === "math"));
});

test("language snapshot reports an unclosed fenced Div", async () => {
	const QLab = await loadQLab();
	let snapshot = QLab.qmdLanguageSnapshot(":::{#def-open}\nBody\n", "");
	let diagnostics = Array.from(snapshot.diagnostics);
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].code, "qmd-unclosed-div");
	assert.equal(diagnostics[0].severity, "error");
});
