import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  buildChangeSetGeneration,
  changeSetGenerationId,
  changeSetGenerationPaths,
  parseChangeSetGeneration,
  serializeChangeSetGeneration,
  validateChangeSetInput,
} from "../extensions/chatero-documentation/change-set-model.mjs";
import { documentationPagePath } from "../extensions/chatero-documentation/documentation-path.mjs";
import { createChangeSetStore } from "../extensions/chatero-documentation/change-set-store.mjs";
import { registerDocumentationAgentTools } from "../extensions/chatero-documentation/documentation-agent-tools.mjs";
import { createDocumentationCapabilityIssuer } from "../extensions/chatero-documentation/documentation-capabilities.mjs";
import { createDocumentationTransactions } from "../extensions/chatero-documentation/documentation-transactions.mjs";
import { deriveStableHunks } from "../extensions/chatero-documentation/stable-hunks.mjs";
import { decodeAuthorityResponse, encodeAuthorityRequest } from "../documentation-authority/protocol.mjs";
import { runDocumentationAuthority } from "../documentation-authority/runtime/chatero-documentation-authority.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const revision = value => `sha256:${sha256(value)}`;

async function invokeAuthority(root, kind, payloadName, payload) {
  const frame = encodeAuthorityRequest({
    protocolVersion: 1,
    requestId: `${kind}-request`,
    kind,
    workspace: pathToFileURL(root).href,
    epoch: "epoch-a",
    [payloadName]: payload,
  });
  let output = "";
  await runDocumentationAuthority({
    stdin: Readable.from([`${frame}\n`]),
    stdout: new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } }),
  });
  return decodeAuthorityResponse(output.trim()).result;
}

function edit(overrides = {}) {
  return {
    kind: "edit",
    operationId: "edit-topic",
    path: documentationPagePath("topic.qmd"),
    baseRevision: `text-document:9:sha256:${sha256("dirty\r\n")}`,
    baseText: "dirty\r\n",
    proposedText: "dirty and proposed\r\n",
    ...overrides,
  };
}

function build(overrides = {}) {
  return buildChangeSetGeneration({
    lineageId: "lineage-a",
    generationId: "0000000000000001",
    repositoryIdentity: "repository:fixture",
    authorityIdentity: "authority:local",
    grantDigest: sha256("grant"),
    idempotencyKey: "agent-turn-1",
    createdAt: "2026-08-12T00:00:00.000Z",
    stateGeneration: "0000000000000001",
    operations: [edit()],
    allocateStableChangeId: value => value,
    ...overrides,
  });
}

test("builds one immutable generation from the exact dirty TextDocument bytes", () => {
  const result = build();
  assert.equal(result.kind, undefined);
  assert.equal(result.generation.operations[0].baseText, "dirty\r\n");
  assert.equal(result.generation.operations[0].proposedText, "dirty and proposed\r\n");
  assert.equal(result.generation.status, "open");
  assert.match(result.generation.generationDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(result.generation));
  assert.ok(result.generation.operations.every(Object.isFrozen));
  assert.ok(result.generation.hunks.every(Object.isFrozen));

  const paths = changeSetGenerationPaths(result.generation.ref);
  assert.equal(paths.directory, "work/qlab-zotero/documentation-changes/lineage-a/0000000000000001");
  assert.deepEqual(result.outputs.map(output => output.path), [
    paths.baseBlob("edit-topic"),
    paths.proposedBlob("edit-topic"),
    paths.manifest,
  ]);
  assert.deepEqual(result.outputs.slice(0, 2).map(output => Buffer.from(output.bytes).toString()), [
    "dirty\r\n",
    "dirty and proposed\r\n",
  ]);
  assert.ok(result.outputs.every(output => output.sha256 === sha256(output.bytes)));
});

test("uses exact 16-character lowercase generation identities before path construction", () => {
  assert.equal(changeSetGenerationId("0123456789abcdef"), "0123456789abcdef");
  for (const value of [
    "1", "00000000000000001", "0123456789ABCDEf", "0x1234567890abcdef",
    "+1234567890abcde", " 1234567890abcde", "1234567890abcd/g",
  ]) {
    assert.equal(changeSetGenerationId(value).kind, "invalid-proposal");
    assert.throws(() => changeSetGenerationPaths({ lineageId: "lineage-a", generationId: value }), /generation/i);
  }
});

test("derives content-stable hunks while preserving CRLF, Unicode, and final newlines", () => {
  const base = "start\r\nzero\r\none\r\ntwo 😀\r\nthree\r\nfour\r\nfive\r\n";
  const proposed = "start\r\nzero\r\none\r\nTWO λ\r\nthree\r\nfour\r\nfive\r\n";
  const first = deriveStableHunks({ operationId: "op", baseText: base, proposedText: proposed });
  const shifted = deriveStableHunks({
    operationId: "op",
    baseText: `prefix\r\n${base}`,
    proposedText: `prefix\r\n${proposed}`,
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].beforeText, "two 😀\r\n");
  assert.equal(first[0].afterText, "TWO λ\r\n");
  assert.equal(first[0].id, shifted[0].id);
  assert.equal(base.slice(first[0].beforeStart, first[0].beforeEnd), first[0].beforeText);
  assert.equal(proposed.slice(first[0].afterStart, first[0].afterEnd), first[0].afterText);
});

test("serializes canonically and rejects missing or digest-mismatched blobs", async () => {
  const result = build();
  const manifest = serializeChangeSetGeneration(result.generation);
  assert.deepEqual(manifest, result.outputs.at(-1).bytes);
  const blobs = new Map(result.outputs.slice(0, -1).map(output => [output.path, output.bytes]));
  const parsed = await parseChangeSetGeneration({
    manifestBytes: manifest,
    readBlob: async path => blobs.get(path),
  });
  assert.equal(parsed.generationDigest, result.generation.generationDigest);
  assert.deepEqual(serializeChangeSetGeneration(parsed), manifest);

  const missing = await parseChangeSetGeneration({ manifestBytes: manifest, readBlob: async () => undefined });
  assert.equal(missing.kind, "invalid-proposal");
  const corrupt = await parseChangeSetGeneration({
    manifestBytes: manifest,
    readBlob: async path => path.endsWith(".base") ? Buffer.from("other") : blobs.get(path),
  });
  assert.equal(corrupt.kind, "invalid-proposal");
});

test("validates the complete operation set and the consumed grant bounds", () => {
  const operations = [
    {
      kind: "create", operationId: "create-a", path: documentationPagePath("new.qmd"),
      targetAbsent: true, proposedText: "new\n",
    },
    {
      kind: "rename", operationId: "rename-a", from: documentationPagePath("old.qmd"),
      to: documentationPagePath("renamed.qmd"), baseRevision: revision("old\n"),
      baseText: "old\n", targetAbsent: true, proposedText: "old revised\n",
    },
    {
      kind: "delete", operationId: "delete-a", path: documentationPagePath("gone.qmd"),
      baseRevision: revision("gone\n"), baseText: "gone\n",
    },
  ];
  const validated = validateChangeSetInput({ operations }, {
    digest: sha256("grant"),
    pathPrefixes: ["new.qmd", "old.qmd", "renamed.qmd", "gone.qmd"],
    operationKinds: ["create", "rename", "delete"],
    maximumOperationCount: 3,
    maximumProposedBytes: 32,
  });
  assert.equal(validated.kind, undefined);
  assert.ok(Object.isFrozen(validated.operations));

  assert.equal(validateChangeSetInput({ operations }, {
    digest: sha256("grant"), pathPrefixes: ["new.qmd"], operationKinds: ["create"],
    maximumOperationCount: 1, maximumProposedBytes: 1,
  }).kind, "invalid-proposal");
  assert.equal(build({
    operations: [edit(), edit({ operationId: "duplicate", path: documentationPagePath("topic.qmd") })],
  }).kind, "invalid-proposal");
});

test("binds parent generations and caller key order into one deterministic digest", () => {
  const parentRef = { lineageId: "lineage-a", generationId: "0000000000000001" };
  const a = build({ generationId: "0000000000000002", parentRef }).generation;
  const b = build({
    generationId: "0000000000000002",
    parentRef: { generationId: "0000000000000001", lineageId: "lineage-a" },
    operations: [{
      proposedText: "dirty and proposed\r\n",
      baseText: "dirty\r\n",
      baseRevision: `text-document:9:sha256:${sha256("dirty\r\n")}`,
      path: documentationPagePath("topic.qmd"),
      operationId: "edit-topic",
      kind: "edit",
    }],
  }).generation;
  assert.equal(a.generationDigest, b.generationDigest);
  assert.equal(build({ generationId: "0000000000000002" }).kind, "invalid-proposal");
  assert.equal(build({ lineageId: "other", generationId: "0000000000000002", parentRef }).kind, "invalid-proposal");
});

test("stages manifest-last through the authority and loads the immutable generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatero-change-set-"));
  try {
    const adapter = {
      transact: request => invokeAuthority(root, "transact", "transaction", request),
      snapshot: request => invokeAuthority(root, "snapshot", "snapshot", { ...request, overlays: [] }),
    };
    const store = createChangeSetStore({ adapter, scope: Object.freeze({ kind: "scope" }) });
    const built = build();
    const staged = await store.stageGeneration(built);
    assert.deepEqual(staged, {
      kind: "generation-staged",
      ref: built.generation.ref,
      generationDigest: built.generation.generationDigest,
      reused: false,
    });
    const loaded = await store.loadGeneration(built.generation.ref);
    assert.equal(loaded.generationDigest, built.generation.generationDigest);
    assert.equal(loaded.operations[0].baseText, "dirty\r\n");
    assert.deepEqual(await store.loadCurrentRef("lineage-a"), {
      kind: "current-generation",
      ref: built.generation.ref,
      generationDigest: built.generation.generationDigest,
    });

    assert.equal((await store.stageGeneration(built)).reused, true);
    const manifest = changeSetGenerationPaths(built.generation.ref).manifest;
    const stored = await readFile(join(root, manifest));
    assert.deepEqual(stored, serializeChangeSetGeneration(built.generation));
  }
  finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects stale lineage publication without writing a child generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatero-change-set-stale-"));
  try {
    const adapter = {
      transact: request => invokeAuthority(root, "transact", "transaction", request),
      snapshot: request => invokeAuthority(root, "snapshot", "snapshot", { ...request, overlays: [] }),
    };
    const store = createChangeSetStore({ adapter, scope: Object.freeze({ kind: "scope" }) });
    const first = build();
    await store.stageGeneration(first);
    const stale = build({
      generationId: "0000000000000003",
      parentRef: { lineageId: "lineage-a", generationId: "0000000000000002" },
    });
    const result = await store.stageGeneration(stale);
    assert.equal(result.kind, "stale-generation");
    await assert.rejects(readFile(join(root, changeSetGenerationPaths(stale.generation.ref).manifest)), /ENOENT/u);
  }
  finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stages an Agent edit from the exact open-document snapshot without canonical writes", async () => {
  let sequence = 0;
  const capabilities = createDocumentationCapabilityIssuer({
    clock: { now: () => 1_000 },
    randomUUID: () => `capability-${++sequence}`,
  });
  const scope = capabilities.issueScope({ uri: "file:///workspace", authority: "local", epoch: "epoch-a" });
  const page = documentationPagePath("topic.qmd");
  const openText = "human dirty\n";
  const openRevision = `text-document:9:sha256:${sha256(openText)}`;
  const staged = [];
  const adapter = {
    async snapshot(request) {
      if (request.kind === "paths") return {
        kind: "snapshot", epoch: "epoch-a", entries: [{
          path: "documentation/topic.qmd", type: "file", bytes: Buffer.from(openText).toString("base64url"),
          sha256: sha256(openText), revision: openRevision,
        }],
      };
      if (request.kind === "documentation-state") return {
        kind: "documentation-state", epoch: "epoch-a",
        pages: [{ path: "topic.qmd", revision: openRevision }], state: { kind: "missing" },
      };
      throw new Error("unexpected snapshot");
    },
    async transact() { throw new Error("stage must not write canonical files"); },
  };
  const store = {
    async loadCurrentRef() { return { kind: "current-generation-missing" }; },
    async stageGeneration(built) {
      staged.push(built);
      return { kind: "generation-staged", ref: built.generation.ref, generationDigest: built.generation.generationDigest, reused: false };
    },
  };
  const transactions = createDocumentationTransactions({
    adapter,
    capabilities,
    workspaceView: { capture() {}, revalidate() {} },
    changeSetStore: store,
    clock: { now: () => Date.parse("2026-08-12T00:00:00.000Z") },
  });
  const grant = capabilities.issueAgentProposalGrant(scope, {
    paths: [page], operationKinds: ["edit"], maximumOperationCount: 1,
    maximumProposedBytes: 1024, expiresInMs: 30_000,
  });
  const result = await transactions.stage(grant, {
    idempotencyKey: "turn-1",
    operations: [{ kind: "edit", path: "topic.qmd", baseRevision: openRevision, proposedText: "agent proposal\n" }],
  });
  assert.equal(result.kind, "generation-staged");
  assert.equal(staged[0].generation.operations[0].baseText, openText);
  assert.equal(staged[0].generation.operations[0].baseRevision, openRevision);
  assert.equal(staged[0].generation.operations[0].proposedText, "agent proposal\n");
});

test("registers only bounded retrieve and stage tools and keeps private authority data out of results", async () => {
  let sequence = 0;
  const capabilities = createDocumentationCapabilityIssuer({
    clock: { now: () => 1_000 }, randomUUID: () => `tool-${++sequence}`,
  });
  const scope = capabilities.issueScope({ uri: "file:///workspace", authority: "local", epoch: "epoch-a" });
  const tools = new Map();
  const vscode = {
    workspace: { isTrusted: true },
    lm: {
      registerTool(name, implementation) {
        tools.set(name, implementation);
        return { dispose: () => tools.delete(name) };
      },
    },
  };
  const generation = build().generation;
  const registrations = registerDocumentationAgentTools({
    vscode, capabilities, scope,
    transactions: { async stage() { return { kind: "generation-staged", ref: generation.ref, generationDigest: generation.generationDigest }; } },
    retrieval: { async retrieve() { return { kind: "feature-unavailable", message: "Reviewed retrieval is not ready." }; } },
  });
  assert.deepEqual([...tools.keys()], ["chatero_documentation_retrieve", "chatero_documentation_stage"]);
  const result = await tools.get("chatero_documentation_stage").invoke({ input: {
    idempotencyKey: "turn-2",
    operations: [{ kind: "create", path: "new.qmd", proposedText: "# New\n" }],
  } }, { isCancellationRequested: false });
  assert.deepEqual(result.metadata, {
    changeSetRef: generation.ref,
    generationDigest: generation.generationDigest,
    reviewCommand: "chatero.documentation.reviewChangeSet",
  });
  assert.doesNotMatch(JSON.stringify(result), /documentation-changes|\.chatero|privatePath|approval|token/iu);
  assert.equal(registrations.length, 2);

  vscode.workspace.isTrusted = false;
  await assert.rejects(
    tools.get("chatero_documentation_stage").invoke({ input: {
      idempotencyKey: "turn-3", operations: [{ kind: "create", path: "other.qmd", proposedText: "x" }],
    } }, { isCancellationRequested: false }),
    /trusted/u,
  );
  registrations.forEach(value => value.dispose());
  assert.equal(tools.size, 0);
});
