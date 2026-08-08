import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

const ACTIONS = [
	"check-compliance",
	"add-to-knowledge",
	"complete-todos",
	"compare-proposal",
	"keep-proposal",
	"insert-formal-block",
	"open-external-editor",
	"refresh-surface",
];

test("native QMD toolbar retains every former XPI capability", async () => {
	const QLab = await loadQLab();
	let html = QLab.renderQmdWorkspaceHTML({
		path: "drafts/a.qmd",
		status: "Ready",
		proposal: false,
	});
	for (let id of ACTIONS) {
		assert.match(html, new RegExp(`data-qlab-qmd-action="${id}"`), id);
	}
	assert.match(html, /data-qlab-compliance-details/);
	assert.match(html, /data-qlab-visual-tools/);
	assert.match(html, /data-qlab-formal-menu/);
});

test("toolbar action inventory has icon-only English accessible labels", async () => {
	const QLab = await loadQLab();
	let model = QLab.qmdWorkspaceAccessibilityModel();
	let expected = {
		compliance: "Check Draft compliance",
		promote: "Add to Knowledge…",
		todos: "Complete TODOs with AI",
		compare: "Compare AI changes",
		keep: "Keep AI changes",
		formal: "Insert Definition, Lemma, Theorem, or Proof",
		external: "Open Draft in external editor",
		refresh: "Refresh active QMD surface",
	};
	for (let [key, label] of Object.entries(expected)) {
		assert.equal(model.actions[key].label, label);
	}
	let html = QLab.renderQmdWorkspaceHTML({ path: "drafts/a.qmd" });
	for (let label of Object.values(expected)) {
		assert.match(html, new RegExp(`aria-label="${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
	}
	let visuallyRendered = html.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, "");
	assert.doesNotMatch(
		visuallyRendered,
		/>\s*(?:Add to Knowledge|Complete TODOs|Open Draft in external editor)\s*</,
	);
});

test("formal tools are a Visual-only group and proposal actions stay independent", async () => {
	const QLab = await loadQLab();
	let withoutProposal = QLab.renderQmdWorkspaceHTML({ path: "drafts/a.qmd", proposal: false });
	assert.match(withoutProposal, /data-qlab-visual-tools/);
	assert.match(withoutProposal, /data-qlab-qmd-action="compare-proposal"[^>]+disabled/);
	assert.match(withoutProposal, /data-qlab-qmd-action="keep-proposal"[^>]+disabled/);
	let withProposal = QLab.renderQmdWorkspaceHTML({ path: "drafts/a.qmd", proposal: true });
	assert.doesNotMatch(withProposal, /data-qlab-qmd-action="compare-proposal"[^>]+disabled/);
	assert.doesNotMatch(withProposal, /data-qlab-qmd-action="keep-proposal"[^>]+disabled/);
	assert.doesNotMatch(withProposal, /data-qlab-qmd-action="complete-todos"[^>]+disabled/);
});

test("canonical formal menu exposes exactly four source-safe block kinds", async () => {
	const QLab = await loadQLab();
	let html = QLab.renderQmdWorkspaceHTML({ path: "drafts/a.qmd" });
	let kinds = [...html.matchAll(/data-qlab-formal-kind="([^"]+)"/g)].map(match => match[1]);
	assert.deepEqual(kinds, ["def", "lem", "thm", "proof"]);
	assert.match(html, /data-qlab-formal-toggle[^>]+aria-expanded="false"/);
	assert.match(html, /data-qlab-formal-toggle[^>]+aria-controls="qlab-qmd-formal-tools"/);
	assert.match(html, /id="qlab-qmd-formal-tools"[^>]+role="group"/);
	assert.doesNotMatch(html, /role="menu(?:item)?"/);
});

test("compliance results become compact human-readable toolbar details", async () => {
	const QLab = await loadQLab();
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdCompliancePresentation({
		ok: true,
		diagnostics: [],
	}))), {
		state: "passed",
		summary: "Draft complies with the current Knowledge contract",
		details: "No compliance issues found.",
	});
	assert.deepEqual(JSON.parse(JSON.stringify(QLab.qmdCompliancePresentation({
		ok: false,
		diagnostics: [{ code: "FRONTMATTER", message: "description is required", line: 2 }],
	}))), {
		state: "failed",
		summary: "1 compliance issue",
		details: "L2 · FRONTMATTER · description is required",
	});
});
