import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..", "..");

test("Stage 4 immutable requirements and Reader boundary audit pass", async () => {
  const { inspectStageFourReader, validateStageFourRequirements } = await import("../scripts/run-stage-4-acceptance.mjs");
  const requirements = JSON.parse(await readFile(join(root, "products", "workbench", "acceptance", "stage-4.requirements.json"), "utf8"));
  assert.equal(validateStageFourRequirements(requirements).checks.length, 8);
  const audit = await inspectStageFourReader({ root });
  assert.equal(audit.unsupportedEntries, 0);
  assert.equal(audit.rendererDatabaseAccess, false);
  assert.equal(audit.remoteReaderFetches, 0);
  assert.ok(audit.parityEntries >= 14);
  assert.match(audit.paritySha256, /^[a-f0-9]{64}$/);
	assert.match(audit.bundleOmniSha256, /^[a-f0-9]{64}$/);
	assert.match(audit.sourceCommit, /^[a-f0-9]{40}$/);
	assert.match(audit.packagedSourceCommit, /^[a-f0-9]{40}$/);
});

test("Stage 4 acceptance fails closed before real profile parity and writes bounded evidence", async () => {
  const { runStageFourAcceptance } = await import("../scripts/run-stage-4-acceptance.mjs");
  const requirements = JSON.parse(await readFile(join(root, "products", "workbench", "acceptance", "stage-4.requirements.json"), "utf8"));
  const written = [];
  let invocations = 0;
  const evidence = await runStageFourAcceptance({
    root, requirements,
    clock: (() => { let value = 1_700_000_000_000; return () => value += 10; })(),
    run: async () => ++invocations === 4 ? 9 : 0,
    inspect: async () => { throw new Error("inspection must not run after failure"); },
    write: async (path, value) => written.push({ path, value }),
  });
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure.checkId, "workbench-regression-tests");
  assert.equal(evidence.checks.length, 4);
  assert.equal(written.length, 1);
  assert.match(written[0].path, /stage-4\.json$/);
});

test("Stage 4 acceptance rejects altered or skippable requirements", async () => {
  const { validateStageFourRequirements } = await import("../scripts/run-stage-4-acceptance.mjs");
  assert.throws(() => validateStageFourRequirements({ schemaVersion: 1, stage: 4, checks: [] }), /immutable Stage 4/);
});
