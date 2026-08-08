import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("research actions filter by object kind", async () => {
	const QLab = await loadQLab();
	const pdfActions = QLab.researchActionsForObject("pdf").map((action) => action.id);
	assert.equal(
		JSON.stringify([...pdfActions]),
		JSON.stringify([
			"summarize",
			"evidence-qa",
			"compare-papers",
			"analyze-figure",
			"write-draft",
		]),
	);
	const draftActions = QLab.researchActionsForObject("draft").map((action) => action.id);
	assert.ok(draftActions.includes("review-draft"));
	assert.ok(!draftActions.includes("analyze-figure"));
	assert.ok(!draftActions.includes("compare-papers"));
});

test("research action skills bind to repository SKILL.md paths", async () => {
	const QLab = await loadQLab();
	assert.equal(
		JSON.stringify(QLab.researchActionSkill("summarize", "pdf")),
		JSON.stringify({
			name: "evidence-review",
			path: "skills/evidence-review/SKILL.md",
			mode: "summary",
		}),
	);
	assert.equal(QLab.researchActionSkill("write-draft", "pdf").name, "capture-chat-draft");
	assert.equal(QLab.researchActionSkill("write-draft", "note").name, "expand-notes");
	assert.deepEqual(
		JSON.parse(JSON.stringify(QLab.researchActionSkill("review-draft", "draft"))),
		{
			name: "review-draft",
			path: "skills/review-draft/SKILL.md",
			mode: "review-only",
		},
	);
	assert.equal(QLab.isReadOnlyResearchAction("summarize"), true);
	assert.equal(QLab.isReadOnlyResearchAction("review-draft"), true);
	assert.equal(QLab.isReadOnlyResearchAction("write-draft"), false);
});

test("buildResearchActionPrompt wraps a single research_object envelope", async () => {
	const QLab = await loadQLab();
	const prompt = QLab.buildResearchActionPrompt("evidence-qa", {
		qlabRoot: "/tmp/workspace/",
		object: {
			kind: "pdf",
			title: "Paper </research_object>",
			itemKey: "ABCD1234",
		},
	});
	assert.match(prompt, /Authority: Follow \$evidence-review at skills\/evidence-review\/SKILL\.md\./);
	assert.match(prompt, /<research_object>/);
	assert.match(prompt, /Paper ＜\/research_object＞/);
	assert.ok(!prompt.includes("</research_object>\nPaper"));
});

test("review-draft prompt is a read-only assessment that cannot promote content", async () => {
	const QLab = await loadQLab();
	const prompt = QLab.buildResearchActionPrompt("review-draft", {
		qlabRoot: "/tmp/workspace/",
		object: {
			kind: "draft",
			title: "Renormalization group notes",
			relativePath: "drafts/rg/note.qmd",
		},
	});

	assert.match(prompt, /Research Loop Action: review-draft/);
	assert.match(prompt, /Mode: review-only/);
	assert.match(prompt, /Authority: Follow \$review-draft at skills\/review-draft\/SKILL\.md\./);
	assert.match(prompt, /read-only review/i);
	assert.match(prompt, /Do not write to Knowledge, Drafts, or Literature/i);
	assert.match(prompt, /Do not promote/i);
	assert.match(prompt, /suggested Knowledge destination/i);
	assert.match(prompt, /check results/i);
	assert.match(prompt, /"relativePath": "drafts\/rg\/note\.qmd"/);
});

test("review-draft selects ask grants without knowledge_apply", async () => {
	const QLab = await loadQLab();
	const mode = QLab.isReadOnlyResearchAction("review-draft") ? "ask" : "agent";
	const turn = QLab.createProveTurn({
		mode,
		workspaceRoot: "/tmp/workspace",
		tools: ["workspace_read", "knowledge_apply"],
	});

	assert.equal(turn.mode, "ask");
	assert.ok(turn.tools.includes("workspace_read"));
	assert.ok(!turn.tools.includes("knowledge_apply"));
});

test("Draft Keep plan is the only AI promotion path helper", async () => {
	const QLab = await loadQLab();
	const plan = QLab.DraftWorkingCopy.buildKeepPlan({
		originalPath: "drafts/reading-notes/a.qmd",
		workingPath: "work/qlab-zotero/draft-changes/token/draft.qmd",
		revision: 3,
	});
	assert.equal(plan.action, "keep");
	assert.equal(plan.clearReviewState, true);
	assert.equal(plan.expectedRevision, 3);
});

test("Phase 4 APIs report not-ready without throwing", async () => {
	const QLab = await loadQLab();
	assert.equal(QLab.Phase4.proposeKnowledgePromotion().status, "not-ready");
	assert.equal(QLab.Phase4.connectSSH().status, "deferred-optional");
	assert.equal(QLab.Phase4.connectSSH().providerId, "remote-execution");
});

test("shell HTML includes Research Actions for chat", async () => {
	const QLab = await loadQLab();
	const html = QLab.renderShellHTML({
		kind: "qlabchat",
		workspaceState: "missing",
	});
	assert.match(html, /data-qlab-kind="qlabchat"/);
	assert.match(html, /data-qlab-action="summarize"/);
	assert.match(html, /Select a QLab workspace/);
});
