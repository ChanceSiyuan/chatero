import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("inlineQmdFormatHTML renders inline math with KaTeX", async () => {
	const QLab = await loadQLab();
	const html = QLab.inlineQmdFormatHTML("Energy is $E = mc^2$ here.");
	assert.match(html, /katex/);
	assert.match(html, /qlab-qmd-math-inline/);
	assert.ok(!html.includes("$E = mc^2$"));
});

test("renderDisplayMathHTML renders display math blocks", async () => {
	const QLab = await loadQLab();
	const html = QLab.renderDisplayMathHTML("$$\n\\int_0^1 x^2 dx\n$$");
	assert.match(html, /katex/);
	assert.match(html, /qlab-qmd-math-display/);
	assert.match(html, /qlab-qmd-math-block/);
	assert.ok(!html.includes("katex-mathml"));
});

test("callout blocks render inline math in card body", async () => {
	const QLab = await loadQLab();
	const block = {
		kind: "callout",
		source: "::: {#def .callout-note}\n\nDefine $f(u, G, x)$.\n\n:::",
		start: 0,
		end: 50,
	};
	const html = QLab.renderQmdBlockHTML(block);
	assert.match(html, /qlab-qmd-card-body/);
	assert.match(html, /katex/);
	assert.ok(!html.includes("<pre>"));
	assert.ok(!html.includes("$f(u, G, x)$"));
});

test("renderQmdBlockHTML uses KaTeX for display-math blocks", async () => {
	const QLab = await loadQLab();
	const block = {
		kind: "display-math",
		source: "$$\\alpha + \\beta$$",
		start: 0,
		end: 16,
	};
	const html = QLab.renderQmdBlockHTML(block);
	assert.match(html, /katex/);
	assert.ok(!html.includes("<pre"));
});

test("resolveQuartoPreviewTarget uses drafts root as cwd", async () => {
	const QLab = await loadQLab();
	const target = QLab.resolveQuartoPreviewTarget("/workspace", "drafts/note.qmd");
	assert.equal(target.cwd, "/workspace/drafts");
	assert.equal(target.file, "note.qmd");
});

test("startQmdQuartoPreview passes drafts cwd and no-execute flags", async () => {
	const QLab = await loadQLab();
	let seen = null;
	const runner = {
		async *run(command, args, options) {
			seen = { command, args, options };
			yield { type: "exit", exitCode: 0 };
		},
	};
	await QLab.startQmdQuartoPreview("/workspace", "drafts/note.qmd", {
		runner,
		fetch: async () => ({ ok: true }),
		port: 43100,
	});
	assert.equal(seen.command, "quarto");
	assert.equal(seen.options.cwd, "/workspace/drafts");
	assert.equal(seen.args[0], "preview");
	assert.equal(seen.args[1], "note.qmd");
	assert.ok(seen.args.includes("--no-execute"));
	assert.ok(seen.args.includes("--host"));
	assert.ok(seen.args.includes("127.0.0.1"));
	assert.equal(seen.args.at(-1), "43100");
});
