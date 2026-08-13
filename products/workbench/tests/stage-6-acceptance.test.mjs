import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..", "..");

test("Stage 6 immutable contract and complete Research Loop catalog pass", async () => {
  const { inspectStageSixResearchLoop, validateStageSixRequirements } = await import("../scripts/run-stage-6-acceptance.mjs");
  const requirements = JSON.parse(await readFile(new URL("../acceptance/stage-6.requirements.json", import.meta.url)));
  assert.equal(validateStageSixRequirements(requirements).checks.length, 6);
  const audit = await inspectStageSixResearchLoop({ root });
  assert.ok(audit.parityEntries >= 20);
  assert.equal(audit.unsupportedEntries, 0);
  assert.equal(audit.hiddenPromotionPaths, 0);
  assert.equal(audit.parallelChatRuntimes, 0);
  assert.match(audit.sourceCommit, /^[0-9a-f]{40}$/u);
  assert.match(audit.catalogSha256, /^[0-9a-f]{64}$/u);
});

test("Stage 6 acceptance stops at the first failed real runtime and writes bounded evidence", async () => {
  const { runStageSixAcceptance } = await import("../scripts/run-stage-6-acceptance.mjs");
  const requirements = JSON.parse(await readFile(new URL("../acceptance/stage-6.requirements.json", import.meta.url)));
  const writes = [];
  let calls = 0;
  const evidence = await runStageSixAcceptance({
    root,
    requirements,
    run: async () => ++calls === 3 ? 7 : 0,
    inspect: async () => assert.fail("inspection must not run after failure"),
    write: async (path, value) => writes.push({ path, value }),
    clock: (() => { let now = 1_700_000_000_000; return () => now += 5; })(),
  });
  assert.equal(evidence.status, "failed");
  assert.match(evidence.sourceCommit, /^[0-9a-f]{40}$/u);
  assert.equal(evidence.failure.checkId, "qmd-obsidian-editing-parity");
  assert.equal(evidence.checks.length, 3);
  assert.equal(writes.length, 1);
  assert.doesNotMatch(JSON.stringify(evidence), /Users|home|token|credential/iu);
});

test("Stage 6 CLI and requirements reject every bypass", async () => {
  const { parseStageSixAcceptanceArguments, validateStageSixRequirements } = await import("../scripts/run-stage-6-acceptance.mjs");
  assert.throws(() => parseStageSixAcceptanceArguments(["--skip-ssh"]), /accepts no arguments/iu);
  assert.throws(() => validateStageSixRequirements({ schemaVersion: 1, stage: 6, checks: [] }), /immutable Stage 6/iu);
});

test("downloaded Stage 6 evidence must be complete and bound to the current source", async () => {
  const { verifyStageSixEvidence } = await import("../scripts/run-stage-6-acceptance.mjs");
  const requirements = JSON.parse(await readFile(new URL("../acceptance/stage-6.requirements.json", import.meta.url)));
  const sourceCommit = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD^{commit}"], { cwd: root, encoding: "utf8" }).trim();
  const evidence = {
    schemaVersion: 1,
    stage: 6,
    status: "passed",
    sourceCommit,
    checks: requirements.checks.map(value => ({ id: value.id, status: "passed", exitCode: 0 })),
  };
  assert.equal((await verifyStageSixEvidence({ root, read: async () => evidence })).checks, requirements.checks.length);
  await assert.rejects(verifyStageSixEvidence({ root, read: async () => ({ ...evidence, sourceCommit: "0".repeat(40) }) }), /stale/iu);
  await assert.rejects(verifyStageSixEvidence({ root, read: async () => ({ ...evidence, checks: evidence.checks.slice(1) }) }), /incomplete/iu);
});
