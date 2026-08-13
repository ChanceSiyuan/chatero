import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  parseStageTwoAcceptanceArguments,
  runStageTwoAcceptance,
  validateStageTwoRequirements,
} from "../scripts/run-stage-2-acceptance.mjs";

const requirements = JSON.parse(await readFile(new URL("../../../products/workbench/acceptance/stage-2.requirements.json", import.meta.url), "utf8"));

test("Stage 2 requirements are an exact immutable Core exit gate", () => {
  const value = validateStageTwoRequirements(requirements);
  assert.deepEqual(value.checks.map(check => check.id), [
    "core-protocol", "core-node-and-real-gecko", "profile-discovery-and-import", "signed-gecko-bundle", "core-boundary-audit",
  ]);
  assert.equal(Object.isFrozen(value), true);
  const drift = structuredClone(requirements);
  drift.checks[1].optional = true;
  assert.throws(() => validateStageTwoRequirements(drift), /immutable Stage 2/);
});

test("Stage 2 acceptance is fail-fast and emits bounded evidence", async () => {
  const calls = [];
  let written;
  const evidence = await runStageTwoAcceptance({
    root: new URL("../../..", import.meta.url).pathname,
    requirements,
    clock: (() => { let now = 0; return () => now += 10; })(),
    run: async options => { calls.push(options); return calls.length === 2 ? 9 : 0; },
    inspect: async () => assert.fail("audit must not run after a failure"),
    write: async (_path, value) => { written = value; },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls.every(call => call.shell === false && call.cwd === new URL("../../..", import.meta.url).pathname), true);
  assert.match(evidence.sourceCommit, /^[0-9a-f]{40}$/u);
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure.checkId, "core-node-and-real-gecko");
  assert.equal(written, evidence);
});

test("Stage 2 CLI cannot skip an acceptance requirement", () => {
  assert.deepEqual(parseStageTwoAcceptanceArguments([]), {});
  assert.throws(() => parseStageTwoAcceptanceArguments(["--skip-real-gecko"]), /accepts no arguments/);
});
