import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

const SOURCE_WITH_TODOS = [
	"# Note",
	"",
	"Keep this exactly. [todo: define the symbol]",
	"",
	"Middle $x > 0$ stays. [todo: add one implication]",
	"",
	"Final sentence.",
].join("\n");

test("TODO completion manifest parser accepts the versioned local JSON shape", async () => {
	const QLab = await loadQLab();
	const parsed = QLab.parseQmdTodoCompletions(JSON.stringify({
		version: 1,
		completions: [
			{ index: 0, replacement: "First completion." },
			{ index: 1, replacement: "Second completion." },
		],
	}));

	assert.deepEqual(plain(parsed), {
		ok: true,
		completions: [
			{ index: 0, replacement: "First completion." },
			{ index: 1, replacement: "Second completion." },
		],
	});
});

test("TODO completion application rebuilds from the original placeholder offsets", async () => {
	const QLab = await loadQLab();
	const result = QLab.applyQmdTodoCompletions(
		"P[todo:a]X[todo:b]Q",
		JSON.stringify({
			version: 1,
			completions: [
				{ index: 0, replacement: "<0>" },
				{ index: 1, replacement: "<1>" },
			],
		}),
	);

	assert.deepEqual(plain(result), {
		ok: true,
		todoCount: 2,
		after: "P<0>X<1>Q",
		message: "2 TODOs completed",
	});
	assert.equal(
		QLab.validateTodoOnlyChange("P[todo:a]X[todo:b]Q", "P<0><1>XQ").ok,
		false,
		"a model response must not be allowed to migrate the fixed X segment",
	);
});

test("TODO completion application rejects duplicate, missing, and unresolved replacements", async () => {
	const QLab = await loadQLab();
	const source = "A[todo:first]B[todo:second]C";
	for (const payload of [
		{ version: 1, completions: [
			{ index: 0, replacement: "First." },
			{ index: 0, replacement: "Again." },
		] },
		{ version: 1, completions: [{ index: 0, replacement: "First." }] },
		{ version: 1, completions: [
			{ index: 0, replacement: "First." },
			{ index: 1, replacement: "[todo: still unresolved]" },
		] },
	]) {
		const result = QLab.applyQmdTodoCompletions(source, JSON.stringify(payload));
		assert.equal(result.ok, false);
	}
});

test("TODO-only validation accepts complete replacements while preserving fixed source", async () => {
	const QLab = await loadQLab();
	const after = SOURCE_WITH_TODOS
		.replace("[todo: define the symbol]", "Let $x$ denote the normalized weight.")
		.replace("[todo: add one implication]", "Therefore $x^2 > 0$.");

	assert.deepEqual(plain(QLab.validateTodoOnlyChange(SOURCE_WITH_TODOS, after)), {
		ok: true,
		todoCount: 2,
		message: "2 TODOs completed",
	});
});

test("TODO-only validation rejects edits outside placeholder spans", async () => {
	const QLab = await loadQLab();
	const after = SOURCE_WITH_TODOS
		.replace("Keep this exactly.", "This was rewritten.")
		.replace("[todo: define the symbol]", "Let $x$ denote the normalized weight.")
		.replace("[todo: add one implication]", "Therefore $x^2 > 0$.");

	const result = plain(QLab.validateTodoOnlyChange(SOURCE_WITH_TODOS, after));
	assert.equal(result.ok, false);
	assert.equal(result.todoCount, 2);
	assert.match(result.message, /outside|before the first/);
});

test("TODO-only validation rejects repeated fixed separators that could hide a changed boundary", async () => {
	const QLab = await loadQLab();
	const result = QLab.validateTodoOnlyChange(
		"P[todo:a]X[todo:b]X[todo:c]X",
		"PoneYtwoXthreeXfourX",
	);
	assert.equal(result.ok, false);
	assert.match(result.message, /ambiguous|repeated fixed/i);
});

test("TODO-only validation rejects unresolved, empty, and adjacent replacements", async () => {
	const QLab = await loadQLab();
	const unresolved = QLab.validateTodoOnlyChange(
		SOURCE_WITH_TODOS,
		SOURCE_WITH_TODOS.replace("[todo: define the symbol]", "Definition supplied."),
	);
	assert.equal(unresolved.ok, false);
	assert.match(unresolved.message, /remains unresolved/);

	const empty = QLab.validateTodoOnlyChange(
		SOURCE_WITH_TODOS,
		SOURCE_WITH_TODOS
			.replace("[todo: define the symbol]", "")
			.replace("[todo: add one implication]", "Implication supplied."),
	);
	assert.equal(empty.ok, false);
	assert.match(empty.message, /removed without a completion/);

	const adjacent = QLab.validateTodoOnlyChange(
		"A [todo: first][todo: second] Z",
		"A first second Z",
	);
	assert.equal(adjacent.ok, false);
	assert.match(adjacent.message, /Adjacent TODO placeholders/);
});

test("TODO-only validation treats a Draft without placeholders as immutable", async () => {
	const QLab = await loadQLab();
	assert.deepEqual(plain(QLab.validateTodoOnlyChange("No work.", "No work.")), {
		ok: true,
		todoCount: 0,
		message: "No TODO placeholders were present",
	});
	const changed = QLab.validateTodoOnlyChange("No work.", "Changed.");
	assert.equal(changed.ok, false);
	assert.equal(changed.todoCount, 0);
});

test("TODO completion prompt grants writes only to the isolated manifest", async () => {
	const QLab = await loadQLab();
	const prompt = QLab.buildQmdTodoPrompt({
		workingPath: "work/qlab-zotero/draft-changes/token/draft.qmd",
		originalPath: "drafts/topic/note.qmd",
	});

	assert.match(prompt, /Action: complete-todos/);
	assert.match(prompt, /Mode: todo-only/);
	assert.match(prompt, /Follow \$complete-gaps at skills\/complete-gaps\/SKILL\.md/);
	assert.match(prompt, /work\/qlab-zotero\/draft-changes\/token\/draft\.qmd/);
	assert.match(prompt, /drafts\/topic\/note\.qmd/);
	assert.match(prompt, /Read \.\/input\.qmd/i);
	assert.match(prompt, /todo-completions\.json/);
	assert.match(prompt, /Write only .*todo-completions\.json/i);
	assert.match(prompt, /Do not edit .*input\.qmd/i);
	assert.match(prompt, /Do not edit .*draft\.qmd/i);
	assert.match(prompt, /Preserve every byte outside/i);
	assert.match(prompt, /Do not (?:edit|write).*original Draft/i);
	assert.match(prompt, /Knowledge/);
	assert.match(prompt, /Literature/);


	assert.throws(
		() => QLab.buildQmdTodoPrompt({
			workingPath: "knowledge/escape.qmd",
			originalPath: "drafts/topic/note.qmd",
		}),
		/Unsafe private working-copy path/,
	);
	assert.throws(
		() => QLab.buildQmdTodoPrompt({
			workingPath: "work/qlab-zotero/draft-changes/token/draft.qmd",
			originalPath: "literature/escape.qmd",
		}),
		/Unsafe original Draft path/,
	);
});

test("TODO guard discards an invalid manifest and requests one private retry", async () => {
	const QLab = await loadQLab();
	const decision = plain(QLab.decideQmdTodoGuard({
		ok: false,
		todoCount: 2,
		message: "Content outside a [todo: ...] placeholder changed",
	}, { attempt: 1 }));

	assert.deepEqual(decision, {
		outcome: "discard-and-retry",
		discardManifest: true,
		retryPrivately: true,
		nextAttempt: 2,
		privateFeedback: "Content outside a [todo: ...] placeholder changed",
	});
});

test("TODO guard accepts valid output and stops after the one private retry", async () => {
	const QLab = await loadQLab();
	assert.deepEqual(plain(QLab.decideQmdTodoGuard({
		ok: true,
		todoCount: 1,
		message: "1 TODO completed",
	}, { attempt: 1 })), {
		outcome: "accept",
		discardManifest: false,
		retryPrivately: false,
		nextAttempt: null,
		privateFeedback: null,
	});

	assert.deepEqual(plain(QLab.decideQmdTodoGuard({
		ok: false,
		todoCount: 1,
		message: "A TODO remains unresolved",
	}, { attempt: 2 })), {
		outcome: "discard-and-stop",
		discardManifest: true,
		retryPrivately: false,
		nextAttempt: null,
		privateFeedback: "A TODO remains unresolved",
	});
});
