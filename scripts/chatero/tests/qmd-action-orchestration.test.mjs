import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import path from "node:path";
import { loadQLab } from "../lib/load-qlab.mjs";

const TODO_DRAFT = "# Stable heading\n\n[todo: add definition]\n";

function chatHost() {
	return {
		_qlabMessages: [],
		_qlabMountRoot: "/tmp/qlab",
		querySelector: () => null,
	};
}

function todoManifest(replacement = "A definition.") {
	return JSON.stringify({
		version: 1,
		completions: [{ index: 0, replacement }],
	});
}

test("Draft review makes Chat visible and records a read-only review turn", async () => {
	const QLab = await loadQLab();
	const host = chatHost();
	QLab.renderChatMessages = () => {};
	QLab.updateChatContextMeter = () => {};
	QLab.persistChatHost = async () => {};
	let visible = [];
	QLab.ensureChatPaneVisible = async (win, options) => {
		visible.push([win, options]);
		return "qlabchat";
	};
	let turnInput;
	QLab.getAgentRuntime = () => ({
		async *startTurn(input) {
			turnInput = input;
			yield { type: "text-delta", text: "Ready for Knowledge after citation checks." };
			yield { type: "done", status: "ok" };
		},
	});
	const windowRef = { Zotero_Tabs: {} };

	const result = await QLab.runQmdDraftReviewAction({
		chatHost: host,
		window: windowRef,
		root: "/tmp/qlab",
		workspaceState: "ready",
		relativePath: "drafts/notes/rg.qmd",
		title: "RG notes",
	});

	assert.equal(visible.length, 1);
	assert.equal(visible[0][0], windowRef);
	assert.equal(visible[0][1].itemID, undefined);
	assert.equal(result.status, "completed");
	assert.equal(turnInput.mode, "ask");
	assert.equal(turnInput.attachments.length, 1);
	assert.equal(turnInput.attachments[0].kind, "policy");
	assert.equal(turnInput.attachments[0].readOnly, true);
	assert.match(turnInput.prompt, /"kind": "draft"/);
	assert.match(turnInput.prompt, /"relativePath": "drafts\/notes\/rg\.qmd"/);
	assert.match(turnInput.prompt, /Do not promote the Draft/i);
	assert.equal(host._qlabMessages.length, 2);
	assert.match(host._qlabMessages[0].text, /review-draft.*drafts\/notes\/rg\.qmd/i);
	assert.match(host._qlabMessages[1].text, /Ready for Knowledge/);
});

test("Draft review waits for the Chat host created by pane visibility", async () => {
	const QLab = await loadQLab();
	const host = chatHost();
	QLab.renderChatMessages = () => {};
	QLab.updateChatContextMeter = () => {};
	QLab.persistChatHost = async () => {};
	QLab.ensureChatPaneVisible = async () => "qlabchat";
	QLab.getAgentRuntime = () => ({
		async *startTurn() {
			yield { type: "text-delta", text: "Review complete." };
			yield { type: "done", status: "ok" };
		},
	});
	let lookups = 0;
	const windowRef = {
		Zotero_Tabs: {},
		document: {
			getElementById() {
				lookups += 1;
				return lookups < 2 ? null : { querySelector: () => host };
			},
		},
	};

	const result = await QLab.runQmdDraftReviewAction({
		window: windowRef,
		root: "/tmp/qlab",
		workspaceState: "ready",
		relativePath: "drafts/notes/rg.qmd",
	});

	assert.equal(result.status, "completed");
	assert.ok(lookups >= 2);
});

test("Draft review fails closed when the Agent stream reports an error", async () => {
	const QLab = await loadQLab();
	const host = chatHost();
	QLab.renderChatMessages = () => {};
	QLab.updateChatContextMeter = () => {};
	QLab.persistChatHost = async () => {};
	QLab.ensureChatPaneVisible = async () => "qlabchat";
	QLab.getAgentRuntime = () => ({
		async *startTurn() {
			yield { type: "text-delta", text: "Partial review." };
			yield { type: "error", message: "Review provider disconnected" };
		},
	});

	await assert.rejects(
		QLab.runQmdDraftReviewAction({
			chatHost: host,
			window: { Zotero_Tabs: {} },
			root: "/tmp/qlab",
			workspaceState: "ready",
			relativePath: "drafts/notes/rg.qmd",
		}),
		/Review provider disconnected/i,
	);
	assert.match(host._qlabMessages.at(-1).text, /Review provider disconnected/i);
});

test("Draft review fails closed when an Agent approval is denied", async () => {
	const QLab = await loadQLab();
	const host = chatHost();
	host._qlabApprovalPolicy = {
		defaultAction: "ask",
		allow: [],
		deny: ["read-only review requested"],
	};
	host._qlabApprovalPolicyRoot = "/tmp/qlab";
	QLab.renderChatMessages = () => {};
	QLab.updateChatContextMeter = () => {};
	QLab.persistChatHost = async () => {};
	QLab.ensureChatPaneVisible = async () => "qlabchat";
	QLab.getAgentRuntime = () => ({
		async *startTurn() {
			yield {
				type: "approval-needed",
				tool: "shell",
				reason: "The read-only review requested a write",
			};
			yield { type: "done", status: "ok" };
		},
	});

	await assert.rejects(
		QLab.runQmdDraftReviewAction({
			chatHost: host,
			window: { Zotero_Tabs: {} },
			root: "/tmp/qlab",
			workspaceState: "ready",
			relativePath: "drafts/notes/rg.qmd",
		}),
		/approval.*denied|denied.*approval/i,
	);
	assert.match(host._qlabMessages.at(-1).text, /denied/i);
});

test("TODO completion retries an invalid isolated manifest and locally rebuilds the proposal", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-action-"));
	const ioHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), TODO_DRAFT, "utf8");
		let calls = [];
		const runtime = {
			async *startTurn(input) {
				calls.push(input);
				assert.equal(
					await readFile(join(input.workspaceRoot, "input.qmd"), "utf8"),
					TODO_DRAFT,
				);
				let next = calls.length === 1
					? JSON.stringify({ version: 1, completions: [] })
					: todoManifest();
				await writeFile(join(input.workspaceRoot, "todo-completions.json"), next, "utf8");
				yield { type: "done", status: "ok" };
			},
		};

		const uiHost = chatHost();
		QLab.renderChatMessages = () => {};
		QLab.updateChatContextMeter = () => {};
		let persisted = 0;
		QLab.persistChatHost = async () => { persisted += 1; };
		let progress = [];
		let updateMessage = QLab.updateChatMessage;
		QLab.updateChatMessage = (target, id, text, options) => {
			progress.push(String(text));
			return updateMessage(target, id, text, options);
		};
		let visible = 0;
		QLab.ensureChatPaneVisible = async () => (visible += 1, "qlabchat");

		const result = await QLab.runQmdTodoCompletion({
			root,
			originalPath: "drafts/note.qmd",
			ioHost,
			runtime,
			providerId: "test-provider",
			chatHost: uiHost,
			window: { Zotero_Tabs: {} },
		});

		assert.equal(result.status, "proposal-ready");
		assert.equal(visible, 1);
		assert.equal(uiHost._qlabMessages.length, 2);
		assert.match(uiHost._qlabMessages[0].text, /complete-todos.*drafts\/note\.qmd/i);
		assert.match(uiHost._qlabMessages[1].text, /Proposal ready/i);
		assert.ok(progress.some(text => /Retrying privately/i.test(text)));
		assert.doesNotMatch(uiHost._qlabMessages[1].text, /private_validation_feedback|Rewritten heading/i);
		assert.ok(persisted > 0);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].mode, "agent");
		const todoRoot = join(
			root,
			result.state.workingPath.replace(/\/draft\.qmd$/, "/todo-action"),
		);
		assert.equal(calls[0].workspaceRoot.startsWith(`${todoRoot}/`), true);
		assert.equal(calls[1].workspaceRoot.startsWith(`${todoRoot}/`), true);
		assert.notEqual(calls[0].workspaceRoot, calls[1].workspaceRoot);
		assert.match(calls[0].prompt, /Read \.\/input\.qmd/i);
		assert.match(calls[0].prompt, /Write only \.\/todo-completions\.json/i);
		assert.match(calls[0].prompt, new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/skills/complete-gaps/SKILL\\.md`));
		assert.match(calls[1].prompt, /<private_validation_feedback>/);
		assert.equal(result.proposal.state.originalPath, "drafts/note.qmd");
		assert.equal(result.proposal.baseText, TODO_DRAFT);
		assert.equal(result.proposal.proposedText, "# Stable heading\n\nA definition.\n");
		assert.equal(
			await readFile(join(root, result.state.workingPath), "utf8"),
			"# Stable heading\n\nA definition.\n",
		);
		await assert.rejects(fs.access(calls[1].workspaceRoot));
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), TODO_DRAFT);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("TODO completion stops after two invalid manifests without changing the proposal", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-action-stop-"));
	const ioHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), TODO_DRAFT, "utf8");
		let calls = 0;
		const runtime = {
			async *startTurn(input) {
				calls += 1;
				await writeFile(
					join(input.workspaceRoot, "todo-completions.json"),
					JSON.stringify({ version: 1, completions: [] }),
					"utf8",
				);
				yield { type: "done", status: "ok" };
			},
		};

		const uiHost = chatHost();
		QLab.renderChatMessages = () => {};
		QLab.updateChatContextMeter = () => {};
		QLab.persistChatHost = async () => {};
		QLab.ensureChatPaneVisible = async () => "qlabchat";
		const result = await QLab.runQmdTodoCompletion({
			root,
			originalPath: "drafts/note.qmd",
			ioHost,
			runtime,
			chatHost: uiHost,
			window: { Zotero_Tabs: {} },
		});

		assert.equal(result.status, "rejected");
		assert.equal(uiHost._qlabMessages.length, 2);
		assert.match(uiHost._qlabMessages[1].text, /rejected/i);
		assert.doesNotMatch(uiHost._qlabMessages[1].text, /restor/i);
		assert.equal(calls, 2);
		assert.equal(result.proposal, null);
		assert.equal(await ioHost.read(join(root, result.state.workingPath)), TODO_DRAFT);
		assert.deepEqual(await fs.readdir(join(
			root,
			result.state.workingPath.replace(/\/draft\.qmd$/, "/todo-action"),
		)), []);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), TODO_DRAFT);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("TODO completion accumulates onto the latest existing proposal", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-action-cumulative-"));
	const ioHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), TODO_DRAFT, "utf8");
		let first = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", ioHost);
		let cumulative = "# Stable heading\n\nPrior AI addition.\n\n[todo: add definition]\n";
		await QLab.QmdDraftIO.writeSource(
			root,
			first.workingPath,
			cumulative,
			QLab.QmdDraftIO._hash(TODO_DRAFT),
			ioHost,
		);
		const runtime = {
			async *startTurn(input) {
				assert.equal(
					await readFile(join(input.workspaceRoot, "input.qmd"), "utf8"),
					cumulative,
				);
				await writeFile(
					join(input.workspaceRoot, "todo-completions.json"),
					todoManifest("A cumulative definition."),
					"utf8",
				);
				yield { type: "done", status: "ok" };
			},
		};

		const result = await QLab.runQmdTodoCompletion({
			root,
			originalPath: "drafts/note.qmd",
			ioHost,
			runtime,
		});

		assert.equal(result.status, "proposal-ready");
		assert.equal(result.state.resumed, true);
		assert.equal(result.proposal.baseText, TODO_DRAFT);
		assert.equal(
			result.proposal.proposedText,
			"# Stable heading\n\nPrior AI addition.\n\nA cumulative definition.\n",
		);
		assert.equal(
			await readFile(join(root, result.state.workingPath), "utf8"),
			result.proposal.proposedText,
		);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), TODO_DRAFT);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("TODO completion detects a concurrent proposal edit before its CAS write", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-action-conflict-"));
	const ioHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), TODO_DRAFT, "utf8");
		let calls = 0;
		const concurrent = "# Concurrent proposal\n\n[todo: add definition]\n";
		const runtime = {
			async *startTurn(input) {
				calls += 1;
				await ioHost.write(join(input.workspaceRoot, "..", "..", "draft.qmd"), concurrent);
				await writeFile(
					join(input.workspaceRoot, "todo-completions.json"),
					todoManifest(),
					"utf8",
				);
				yield { type: "done", status: "ok" };
			},
		};

		const result = await QLab.runQmdTodoCompletion({
			root,
			originalPath: "drafts/note.qmd",
			ioHost,
			runtime,
		});

		assert.equal(result.status, "rejected");
		assert.equal(calls, 1);
		assert.match(result.validation.message, /changed|reload|concurrent/i);
		assert.equal(await readFile(join(root, result.state.workingPath), "utf8"), concurrent);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), TODO_DRAFT);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("ordinary Draft AI rejects a symlinked action parent before touching or cleaning its target", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-action-link-"));
	const outside = await mkdtemp(join(tmpdir(), "chatero-qmd-action-outside-"));
	const baseHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "Original Draft.\n", "utf8");
		const prepared = await QLab.QmdDraftIO.prepareChange(
			root,
			"drafts/note.qmd",
			baseHost,
		);
		const outsideTarget = join(outside, "must-not-be-touched");
		await writeFile(outsideTarget, "sentinel\n", "utf8");
		const actionParent = join(
			root,
			prepared.workingPath.replace(/\/draft\.qmd$/, "/agent-actions"),
		);
		await symlink(outsideTarget, actionParent);

		const stagingCalls = [];
		const cleanupCalls = [];
		const ioHost = {
			...baseHost,
			async makeDir(target, options) {
				if (String(target).includes("/agent-actions")) stagingCalls.push(target);
				return baseHost.makeDir(target, options);
			},
			async remove(target, options) {
				if (String(target).includes("/agent-actions")) cleanupCalls.push(target);
				return baseHost.remove(target, options);
			},
		};
		QLab.QmdDraftIO.createGeckoHost = () => ioHost;
		let agentStarted = false;
		QLab.getAgentRuntime = () => ({
			async *startTurn() {
				agentStarted = true;
				yield { type: "done", status: "ok" };
			},
		});
		QLab.Settings.getAgentProviderId = () => "test";
		const status = { textContent: "" };
		const host = {
			_qlabDraftState: { originalPath: prepared.originalPath },
			_qlabQmdWorkspace: {
				attachProposal: async () => {
					throw new Error("unsafe Agent action must not attach a proposal");
				},
			},
			querySelector: selector => selector === ".qlab-shell-status" ? status : null,
		};

		await QLab.editDraftWithAI(host, root, "ready");

		assert.equal(agentStarted, false);
		assert.deepEqual(stagingCalls, []);
		assert.deepEqual(cleanupCalls, []);
		assert.match(status.textContent, /symbolic link|outside.*private/i);
		assert.equal(await readFile(outsideTarget, "utf8"), "sentinel\n");
	}
	finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("ordinary Draft AI promotes an isolated action result into the cumulative proposal with CAS", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-ordinary-success-"));
	const ioHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		let original = "Original Draft.\n";
		let previous = "Previous cumulative proposal.\n";
		let proposed = "Updated cumulative proposal.\n";
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), original, "utf8");
		let prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", ioHost);
		let initial = await QLab.QmdDraftIO.readSource(root, prepared.workingPath, ioHost);
		await QLab.QmdDraftIO.writeSource(
			root, prepared.workingPath, previous, initial.revision, ioHost,
		);
		let turnInput;
		QLab.QmdDraftIO.createGeckoHost = () => ioHost;
		QLab.getAgentRuntime = () => ({
			async *startTurn(input) {
				turnInput = input;
				assert.equal(await readFile(join(input.workspaceRoot, "draft.qmd"), "utf8"), previous);
				await writeFile(join(input.workspaceRoot, "draft.qmd"), proposed, "utf8");
				yield { type: "done", status: "ok" };
			},
		});
		QLab.Settings.getAgentProviderId = () => "test";
		let attached;
		const status = { textContent: "" };
		const host = {
			_qlabDraftState: { originalPath: prepared.originalPath },
			_qlabQmdWorkspace: { attachProposal: async (...args) => { attached = args; } },
			querySelector: selector => selector === ".qlab-shell-status" ? status : null,
		};

		await QLab.editDraftWithAI(host, root, "ready");

		assert.match(turnInput.workspaceRoot, /\/agent-actions\/[^/]+$/);
		assert.match(turnInput.prompt, /edit only \.\/draft\.qmd/i);
		assert.equal(await readFile(join(root, prepared.workingPath), "utf8"), proposed);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), original);
		assert.equal(attached[1], proposed);
		assert.equal(attached[2], original);
		await assert.rejects(fs.access(turnInput.workspaceRoot));
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("ordinary Draft AI failure discards its action copy and leaves the cumulative proposal untouched", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-ordinary-failure-"));
	const ioHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		let original = "Original Draft.\n";
		let previous = "Previous cumulative proposal.\n";
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), original, "utf8");
		let prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", ioHost);
		let initial = await QLab.QmdDraftIO.readSource(root, prepared.workingPath, ioHost);
		await QLab.QmdDraftIO.writeSource(
			root, prepared.workingPath, previous, initial.revision, ioHost,
		);
		let workspaceRoot;
		QLab.QmdDraftIO.createGeckoHost = () => ioHost;
		QLab.getAgentRuntime = () => ({
			async *startTurn(input) {
				workspaceRoot = input.workspaceRoot;
				await writeFile(join(input.workspaceRoot, "draft.qmd"), "Agent partial output.\n", "utf8");
				yield { type: "error", message: "Agent disconnected" };
			},
		});
		QLab.Settings.getAgentProviderId = () => "test";
		let attached = false;
		const status = { textContent: "" };
		const host = {
			_qlabDraftState: { originalPath: prepared.originalPath },
			_qlabQmdWorkspace: { attachProposal: async () => { attached = true; } },
			querySelector: selector => selector === ".qlab-shell-status" ? status : null,
		};

		await QLab.editDraftWithAI(host, root, "ready");

		assert.equal(attached, false);
		assert.equal(await readFile(join(root, prepared.workingPath), "utf8"), previous);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), original);
		await assert.rejects(fs.access(workspaceRoot));
		assert.match(status.textContent, /Agent disconnected/i);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("ordinary Draft AI late failure preserves a concurrently updated proposal", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-ordinary-conflict-"));
	const ioHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), "Original Draft.\n", "utf8");
		let prepared = await QLab.QmdDraftIO.prepareChange(
			root,
			"drafts/note.qmd",
			ioHost,
		);
		let previous = "Previous cumulative proposal.\n";
		let initial = await QLab.QmdDraftIO.readSource(root, prepared.workingPath, ioHost);
		await QLab.QmdDraftIO.writeSource(
			root,
			prepared.workingPath,
			previous,
			initial.revision,
			ioHost,
		);

		let turnInput;
		let concurrent = "A newer concurrent proposal.\n";
		QLab.QmdDraftIO.createGeckoHost = () => ioHost;
		QLab.getAgentRuntime = () => ({
			async *startTurn(input) {
				turnInput = input;
				await writeFile(join(input.workspaceRoot, "draft.qmd"), "Agent partial output.\n", "utf8");
				await writeFile(join(root, prepared.workingPath), concurrent, "utf8");
				yield { type: "error", message: "Agent disconnected" };
			},
		});
		QLab.Settings.getAgentProviderId = () => "test";
		let attached = false;
		const status = { textContent: "" };
		const host = {
			_qlabDraftState: { originalPath: prepared.originalPath },
			_qlabQmdWorkspace: { attachProposal: async () => { attached = true; } },
			querySelector: selector => selector === ".qlab-shell-status" ? status : null,
		};

		await QLab.editDraftWithAI(host, root, "ready");

		assert.match(turnInput.workspaceRoot, /\/agent-actions\/[^/]+$/);
		assert.equal(attached, false);
		assert.equal(await readFile(join(root, prepared.workingPath), "utf8"), concurrent);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), "Original Draft.\n");
		assert.match(status.textContent, /Agent disconnected/i);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("ordinary Draft AI slow success cannot overwrite a newer proposal", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-ordinary-slow-"));
	const ioHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		let original = "Original Draft.\n";
		let previous = "Previous cumulative proposal.\n";
		let concurrent = "A newer concurrent proposal.\n";
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), original, "utf8");
		let prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", ioHost);
		let initial = await QLab.QmdDraftIO.readSource(root, prepared.workingPath, ioHost);
		await QLab.QmdDraftIO.writeSource(
			root, prepared.workingPath, previous, initial.revision, ioHost,
		);
		QLab.QmdDraftIO.createGeckoHost = () => ioHost;
		QLab.getAgentRuntime = () => ({
			async *startTurn(input) {
				await writeFile(join(input.workspaceRoot, "draft.qmd"), "Slow Agent result.\n", "utf8");
				await writeFile(join(root, prepared.workingPath), concurrent, "utf8");
				yield { type: "done", status: "ok" };
			},
		});
		QLab.Settings.getAgentProviderId = () => "test";
		let attached = false;
		const status = { textContent: "" };
		const host = {
			_qlabDraftState: { originalPath: prepared.originalPath },
			_qlabQmdWorkspace: { attachProposal: async () => { attached = true; } },
			querySelector: selector => selector === ".qlab-shell-status" ? status : null,
		};

		await QLab.editDraftWithAI(host, root, "ready");

		assert.equal(attached, false);
		assert.equal(await readFile(join(root, prepared.workingPath), "utf8"), concurrent);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), original);
		assert.match(status.textContent, /revision changed|reload/i);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("successive inline AI writes append to the latest cumulative proposal", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-inline-cumulative-"));
	const ioHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		let original = "Original Draft.\n";
		let cumulative = "Original Draft.\n\nPrior proposal.\n";
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), original, "utf8");
		let prepared = await QLab.QmdDraftIO.prepareChange(
			root,
			"drafts/note.qmd",
			ioHost,
		);
		let initial = await QLab.QmdDraftIO.readSource(root, prepared.workingPath, ioHost);
		await QLab.QmdDraftIO.writeSource(
			root,
			prepared.workingPath,
			cumulative,
			initial.revision,
			ioHost,
		);

		let turnInput;
		QLab.QmdDraftIO.createGeckoHost = () => ioHost;
		QLab.Settings.getAgentProviderId = () => "test";
		QLab.Settings.getAgentModel = () => "";
		QLab.getAgentRuntime = () => ({
			async *startTurn(input) {
				turnInput = input;
				yield { type: "text-delta", text: "Next proposal." };
				yield { type: "done", status: "ok" };
			},
		});
		let attached;
		const status = { textContent: "" };
		const host = {
			_qlabBuffer: original,
			_qlabDraftState: { originalPath: "drafts/note.qmd" },
			_qlabQmdWorkspace: {
				saveNow: async () => null,
				attachProposal: async (...args) => { attached = args; return true; },
			},
			querySelector: selector => selector === ".qlab-shell-status" ? status : null,
		};

		await QLab.requestQmdInlineWrite({
			host,
			instruction: "continue the note",
			root,
			workspaceState: "ready",
		});

		let expected = "Original Draft.\n\nPrior proposal.\n\nNext proposal.\n";
		assert.match(turnInput.prompt, /Prior proposal\./);
		assert.equal(await readFile(join(root, prepared.workingPath), "utf8"), expected);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), original);
		assert.equal(attached[1], expected);
		assert.equal(attached[2], original);
		assert.match(status.textContent, /proposal ready/i);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("successive inline rewrite reanchors the human selection in the cumulative proposal", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-inline-reanchor-"));
	const ioHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		let original = "# Heading\n\nTarget paragraph.\n";
		let cumulative = "# Prior AI heading\n\nPrior text.\n\n# Heading\n\nTarget paragraph.\n";
		let expected = "# Prior AI heading\n\nPrior text.\n\n# Heading\n\nRewritten target.\n";
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), original, "utf8");
		let prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", ioHost);
		let initial = await QLab.QmdDraftIO.readSource(root, prepared.workingPath, ioHost);
		await QLab.QmdDraftIO.writeSource(
			root, prepared.workingPath, cumulative, initial.revision, ioHost,
		);
		let start = original.indexOf("Target paragraph.");
		let prompt;
		QLab.QmdDraftIO.createGeckoHost = () => ioHost;
		QLab.Settings.getAgentProviderId = () => "test";
		QLab.Settings.getAgentModel = () => "";
		QLab.getAgentRuntime = () => ({
			async *startTurn(input) {
				prompt = input.prompt;
				yield { type: "text-delta", text: "Rewritten target." };
				yield { type: "done", status: "ok" };
			},
		});
		let attached;
		const status = { textContent: "" };
		const host = {
			_qlabBuffer: original,
			_qlabMonacoSelection: { start, end: start + "Target paragraph.".length },
			_qlabDraftState: { originalPath: prepared.originalPath },
			_qlabQmdWorkspace: {
				saveNow: async () => null,
				attachProposal: async (...args) => { attached = args; return true; },
			},
			querySelector: selector => selector === ".qlab-shell-status" ? status : null,
		};

		await QLab.requestQmdInlineWrite({
			host,
			instruction: "rewrite the selected paragraph",
			root,
			workspaceState: "ready",
		});

		assert.match(prompt, /<qmd_text_selected>\nTarget paragraph\.\n<\/qmd_text_selected>/);
		assert.equal(await readFile(join(root, prepared.workingPath), "utf8"), expected);
		assert.equal(attached[1], expected);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), original);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("successive Visual Edit inline rewrite reanchors the active block in the cumulative proposal", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-inline-visual-reanchor-"));
	const ioHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		let original = "# Heading\n\nTarget paragraph.\n";
		let cumulative = "# Prior AI heading\n\nPrior text.\n\n# Heading\n\nTarget paragraph.\n";
		let expected = "# Prior AI heading\n\nPrior text.\n\n# Heading\n\nRewritten target.\n";
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), original, "utf8");
		let prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", ioHost);
		let initial = await QLab.QmdDraftIO.readSource(root, prepared.workingPath, ioHost);
		await QLab.QmdDraftIO.writeSource(
			root, prepared.workingPath, cumulative, initial.revision, ioHost,
		);
		let prompt;
		QLab.QmdDraftIO.createGeckoHost = () => ioHost;
		QLab.Settings.getAgentProviderId = () => "test";
		QLab.Settings.getAgentModel = () => "";
		QLab.getAgentRuntime = () => ({
			async *startTurn(input) {
				prompt = input.prompt;
				yield { type: "text-delta", text: "Rewritten target." };
				yield { type: "done", status: "ok" };
			},
		});
		let attached;
		const status = { textContent: "" };
		const host = {
			_qlabBuffer: original,
			_qlabSurfaceMode: "visual",
			_qlabActiveBlockIndex: 1,
			_qlabDraftState: { originalPath: prepared.originalPath },
			_qlabQmdWorkspace: {
				saveNow: async () => null,
				attachProposal: async (...args) => { attached = args; return true; },
			},
			querySelector: selector => selector === ".qlab-shell-status" ? status : null,
		};

		await QLab.requestQmdInlineWrite({
			host,
			instruction: "rewrite the active paragraph",
			root,
			workspaceState: "ready",
		});

		assert.match(prompt, /<qmd_text_selected>\nTarget paragraph\.\n<\/qmd_text_selected>/);
		assert.equal(await readFile(join(root, prepared.workingPath), "utf8"), expected);
		assert.equal(attached[1], expected);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), original);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("slow inline AI result cannot overwrite a newer proposal", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-inline-conflict-"));
	const ioHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		let original = "Original Draft.\n";
		let cumulative = "Original Draft.\n\nPrior proposal.\n";
		let concurrent = "A newer concurrent proposal.\n";
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), original, "utf8");
		let prepared = await QLab.QmdDraftIO.prepareChange(root, "drafts/note.qmd", ioHost);
		let initial = await QLab.QmdDraftIO.readSource(root, prepared.workingPath, ioHost);
		await QLab.QmdDraftIO.writeSource(
			root, prepared.workingPath, cumulative, initial.revision, ioHost,
		);
		QLab.QmdDraftIO.createGeckoHost = () => ioHost;
		QLab.Settings.getAgentProviderId = () => "test";
		QLab.Settings.getAgentModel = () => "";
		QLab.getAgentRuntime = () => ({
			async *startTurn() {
				await writeFile(join(root, prepared.workingPath), concurrent, "utf8");
				yield { type: "text-delta", text: "Slow inline result." };
				yield { type: "done", status: "ok" };
			},
		});
		let attached = false;
		const status = { textContent: "" };
		const host = {
			_qlabBuffer: original,
			_qlabDraftState: { originalPath: prepared.originalPath },
			_qlabQmdWorkspace: {
				saveNow: async () => null,
				attachProposal: async () => { attached = true; },
			},
			querySelector: selector => selector === ".qlab-shell-status" ? status : null,
		};

		await QLab.requestQmdInlineWrite({
			host,
			instruction: "continue the note",
			root,
			workspaceState: "ready",
		});

		assert.equal(attached, false);
		assert.equal(await readFile(join(root, prepared.workingPath), "utf8"), concurrent);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), original);
		assert.match(status.textContent, /proposal changed|reload/i);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("slow inline AI result cannot overwrite after the human Draft changes", async () => {
	const QLab = await loadQLab();
	const root = await mkdtemp(join(tmpdir(), "chatero-qmd-inline-human-conflict-"));
	const ioHost = QLab.QmdDraftIO.createNodeHost(fs, path);
	try {
		let original = "Original Draft.\n";
		let humanEdit = "New human Draft edit.\n";
		await mkdir(join(root, "drafts"), { recursive: true });
		await writeFile(join(root, "drafts", "note.qmd"), original, "utf8");
		QLab.QmdDraftIO.createGeckoHost = () => ioHost;
		QLab.Settings.getAgentProviderId = () => "test";
		QLab.Settings.getAgentModel = () => "";
		QLab.getAgentRuntime = () => ({
			async *startTurn() {
				await writeFile(join(root, "drafts", "note.qmd"), humanEdit, "utf8");
				yield { type: "text-delta", text: "Stale inline result." };
				yield { type: "done", status: "ok" };
			},
		});
		let attached = false;
		const status = { textContent: "" };
		const host = {
			_qlabBuffer: original,
			_qlabDraftState: { originalPath: "drafts/note.qmd" },
			_qlabQmdWorkspace: {
				saveNow: async () => null,
				attachProposal: async () => { attached = true; },
			},
			querySelector: selector => selector === ".qlab-shell-status" ? status : null,
		};

		await QLab.requestQmdInlineWrite({
			host,
			instruction: "continue the note",
			root,
			workspaceState: "ready",
		});

		let proposal = await QLab.QmdDraftIO.findProposal(root, "drafts/note.qmd", ioHost);
		assert.equal(attached, false);
		assert.equal(await readFile(join(root, proposal.workingPath), "utf8"), original);
		assert.equal(await readFile(join(root, "drafts", "note.qmd"), "utf8"), humanEdit);
		assert.match(status.textContent, /Draft context changed|human version/i);
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});
