import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..", "..");

test("Stage 3 immutable requirements and source audit pass", async () => {
  const { inspectStageThreeLibrary, validateStageThreeRequirements } = await import("../scripts/run-stage-3-acceptance.mjs");
  const requirements = JSON.parse(await readFile(join(root, "products", "workbench", "acceptance", "stage-3.requirements.json"), "utf8"));
  assert.equal(validateStageThreeRequirements(requirements).checks.length, 6);
  const audit = await inspectStageThreeLibrary({ root });
  assert.equal(audit.unsupportedEntries, 0);
  assert.ok(audit.parityEntries >= 35);
  assert.ok(audit.commandCount >= 25);
  assert.equal(audit.localeCount, 2);
  assert.match(audit.paritySha256, /^[a-f0-9]{64}$/);
});

test("Stage 3 acceptance fails closed and writes bounded evidence", async () => {
  const { runStageThreeAcceptance } = await import("../scripts/run-stage-3-acceptance.mjs");
  const requirements = JSON.parse(await readFile(join(root, "products", "workbench", "acceptance", "stage-3.requirements.json"), "utf8"));
  const written = [];
  let invocations = 0;
  const evidence = await runStageThreeAcceptance({
    root,
    requirements,
    clock: (() => { let value = 1_700_000_000_000; return () => value += 10; })(),
    run: async () => ++invocations === 2 ? 7 : 0,
    inspect: async () => { throw new Error("inspection must not run after failure"); },
    write: async (path, value) => written.push({ path, value }),
  });
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure.checkId, "core-library-tests");
  assert.equal(evidence.checks.length, 2);
  assert.equal(evidence.checks[1].exitCode, 7);
  assert.equal(written.length, 1);
  assert.match(written[0].path, /stage-3\.json$/);
});

test("Stage 3 acceptance rejects altered requirements", async () => {
  const { validateStageThreeRequirements } = await import("../scripts/run-stage-3-acceptance.mjs");
  assert.throws(() => validateStageThreeRequirements({ schemaVersion: 1, stage: 3, checks: [] }), /immutable Stage 3/);
});
