import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";

import { MIGRATION_PLAN_LIMITS } from "../extensions/chatero-documentation/migration-planner.mjs";
import { decodeAuthorityResponse, encodeAuthorityRequest } from "../documentation-authority/protocol.mjs";
import { runDocumentationAuthority } from "../documentation-authority/runtime/chatero-documentation-authority.mjs";

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function invoke(workspace, kind, payloadName, payload) {
  const chunks = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
  });
  const request = {
    protocolVersion: 1,
    requestId: `${kind}-request`,
    kind,
    workspace: new URL(`file://${workspace}`).href,
    epoch: "epoch-1",
    [payloadName]: payload,
  };
  await runDocumentationAuthority({
    stdin: Readable.from([`${encodeAuthorityRequest(request)}\n`]),
    stdout,
    clock: { now: () => Date.parse("2026-08-12T00:00:00.000Z") },
  });
  return Object.freeze({
    request,
    result: decodeAuthorityResponse(Buffer.concat(chunks).toString("ascii").trimEnd()).result,
  });
}

async function plan(workspace) {
  return (await invoke(workspace, "snapshot", "snapshot", {
    kind: "plan-migration-v2",
    limits: MIGRATION_PLAN_LIMITS,
    plannerVersion: "documentation-migration-v2",
    overlays: [],
  })).result;
}

function executeRequest(planned, idempotencyKey = "migration-1") {
  return {
    kind: "execute-migration",
    schemaVersion: 1,
    operationId: planned.planRecord.operationId,
    workspaceEpoch: "epoch-1",
    planDigest: planned.planDigest,
    planRecord: planned.planRecord,
    approvalDigest: digest(`${planned.planDigest}\0${idempotencyKey}`),
    idempotencyKey,
  };
}

test("approved V2 migration publishes unified Documentation and replays one receipt", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "chatero-migration-execute-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "knowledge", "assets"), { recursive: true });
  await mkdir(join(workspace, "drafts"));
  await writeFile(join(workspace, "knowledge", "topic.qmd"), "# Reviewed\n![Plot](assets/plot.png)\n");
  await writeFile(join(workspace, "knowledge", "assets", "plot.png"), Buffer.from([1, 2, 3]));
  await writeFile(join(workspace, "drafts", "topic.qmd"), "# Working\n");

  const planned = await plan(workspace);
  const transaction = executeRequest(planned);
  const first = await invoke(workspace, "transact", "transaction", transaction);
  assert.equal(first.result.kind, "migration-committed");
  assert.equal(first.result.planDigest, planned.planDigest);
  assert.match(first.result.approvalAcceptanceProof, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(first.request).includes("# Reviewed"), false);
  assert.equal(JSON.stringify(first.result).includes("# Reviewed"), false);

  assert.equal(await readFile(join(workspace, "documentation", "topic.qmd"), "utf8"),
    "# Reviewed\n![Plot](assets/plot.png)\n");
  assert.equal(await readFile(join(workspace, "documentation", "_migrated", "drafts", "topic.qmd"), "utf8"),
    "# Working\n");
  assert.deepEqual(await readFile(join(workspace, "documentation", "assets", "plot.png")), Buffer.from([1, 2, 3]));
  const state = JSON.parse(await readFile(join(workspace, ".chatero", "documentation-state.v1.json"), "utf8"));
  assert.deepEqual(state.documents, {
    "_migrated/drafts/topic.qmd": { state: "working" },
    "topic.qmd": { state: "reviewed" },
  });
  assert.equal(await readFile(join(workspace, "knowledge", "topic.qmd"), "utf8"),
    "# Reviewed\n![Plot](assets/plot.png)\n");

  const replay = await invoke(workspace, "transact", "transaction", transaction);
  assert.deepEqual(replay.result, first.result);
});

test("changed legacy bytes make an approved V2 plan stale before transaction writes", async t => {
  const workspace = await mkdtemp(join(tmpdir(), "chatero-migration-stale-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "knowledge"));
  await writeFile(join(workspace, "knowledge", "topic.qmd"), "# Before\n");
  const planned = await plan(workspace);
  await writeFile(join(workspace, "knowledge", "topic.qmd"), "# Human changed\n");

  const result = await invoke(workspace, "transact", "transaction", executeRequest(planned));
  assert.deepEqual(result.result, { kind: "stale-plan" });
  await assert.rejects(readFile(join(workspace, "documentation", "topic.qmd")), { code: "ENOENT" });
  await assert.rejects(readFile(join(workspace, ".chatero", "documentation-operation-active.v1.json")), { code: "ENOENT" });
});
