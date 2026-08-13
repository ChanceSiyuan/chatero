import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  parseStageOneAcceptanceArguments,
  runStageOneAcceptance,
  validateStageOneRequirements,
  writeStageOneEvidence,
} from "../scripts/run-stage-1-acceptance.mjs";

const requirements = JSON.parse(await readFile(
  new URL("../acceptance/stage-1.requirements.json", import.meta.url),
  "utf8",
));

const SOURCE = Object.freeze({
  commit: "1".repeat(40),
  clean: true,
});
const UPSTREAM = Object.freeze({
  commit: "2".repeat(40),
  productSha256: "3".repeat(64),
  patchSeriesSha256: "4".repeat(64),
});

function deterministicClock() {
  let value = Date.parse("2026-08-13T00:00:00.000Z");
  return () => {
    const current = value;
    value += 10;
    return current;
  };
}

test("Stage 1 requirements are an exact immutable command contract", () => {
  const validated = validateStageOneRequirements(requirements);
  assert.deepEqual(validated.checks.map(check => check.id), [
    "documentation-assets",
    "workbench-node-tests",
    "core-protocol",
    "core-node-tests",
    "legacy-node-tests",
    "code-oss-provenance",
    "code-oss-compile",
    "documentation-local-runtime",
    "tracked-source-clean",
  ]);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.checks), true);
  assert.deepEqual(validated.checks.at(-1), {
    id: "tracked-source-clean",
    kind: "source-inspection",
  });
});

test("Stage 1 requirements reject shell syntax and any descriptor drift", () => {
  const shell = structuredClone(requirements);
  shell.checks[0].args.push("&&", "whoami");
  assert.throws(() => validateStageOneRequirements(shell), /immutable Stage 1 requirement/u);

  const optional = structuredClone(requirements);
  optional.checks[2].optional = true;
  assert.throws(() => validateStageOneRequirements(optional), /immutable Stage 1 requirement/u);

  const skipped = structuredClone(requirements);
  skipped.checks.splice(3, 1);
  assert.throws(() => validateStageOneRequirements(skipped), /immutable Stage 1 requirement/u);
});

test("successful acceptance uses shell:false, fixed cwd, and sanitized complete evidence", async () => {
  const calls = [];
  const writes = [];
  const evidence = await runStageOneAcceptance({
    root: "/fixed/repository",
    requirements,
    clock: deterministicClock(),
    runCommand: async options => {
      calls.push(options);
      return 0;
    },
    inspectSource: async options => {
      assert.deepEqual(options, { root: "/fixed/repository" });
      return { source: SOURCE, upstream: UPSTREAM };
    },
    writeEvidence: async options => writes.push(options),
  });

  assert.equal(calls.length, 8);
  assert.equal(calls.every(call => call.cwd === "/fixed/repository"), true);
  assert.equal(calls.every(call => call.shell === false), true);
  assert.equal(calls.every(call => call.file === "npm"), true);
  assert.deepEqual(calls[7].args, [
    "run", "test:documentation:integration", "--", "--target", "local",
  ]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/fixed/repository/products/workbench/.cache/acceptance/stage-1.json");
  assert.equal(writes[0].evidence, evidence);
  assert.equal(evidence.status, "passed");
  assert.deepEqual(evidence.source, SOURCE);
  assert.deepEqual(evidence.upstream, UPSTREAM);
  assert.equal(evidence.checks.length, 9);
  assert.equal(evidence.checks.every(check => check.status === "passed" && check.exitCode === 0), true);
  assert.equal(evidence.checks.every(check => Number.isInteger(check.durationMs) && check.durationMs >= 0), true);
  assert.equal(evidence.startedAt, "2026-08-13T00:00:00.000Z");
  assert.match(evidence.endedAt, /^2026-08-13T00:00:00\.\d{3}Z$/u);
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /HOME|PATH|stdout|stderr|credential|token|fixed\/repository/iu);
});

test("a failed command stops later requirements and writes failed evidence", async () => {
  const calls = [];
  let inspected = false;
  let written;
  const evidence = await runStageOneAcceptance({
    root: "/fixed/repository",
    requirements,
    clock: deterministicClock(),
    runCommand: async options => {
      calls.push(options);
      return calls.length === 2 ? 7 : 0;
    },
    inspectSource: async () => {
      inspected = true;
      return { source: SOURCE, upstream: UPSTREAM };
    },
    writeEvidence: async options => { written = options.evidence; },
  });

  assert.equal(calls.length, 2);
  assert.equal(inspected, false);
  assert.equal(evidence.status, "failed");
  assert.deepEqual(evidence.checks.map(check => [check.id, check.status, check.exitCode]), [
    ["documentation-assets", "passed", 0],
    ["workbench-node-tests", "failed", 7],
  ]);
  assert.equal(written, evidence);
});

test("dirty source and missing upstream provenance fail the final inspection", async t => {
  for (const fixture of [
    {
      name: "dirty source",
      inspect: async () => ({ source: { ...SOURCE, clean: false }, upstream: UPSTREAM }),
      pattern: /tracked source is dirty/u,
    },
    {
      name: "missing upstream",
      inspect: async () => { throw new Error("Code-OSS provenance is missing"); },
      pattern: /Code-OSS provenance is missing/u,
    },
  ]) {
    await t.test(fixture.name, async () => {
      let written;
      const evidence = await runStageOneAcceptance({
        root: "/fixed/repository",
        requirements,
        clock: deterministicClock(),
        runCommand: async () => 0,
        inspectSource: fixture.inspect,
        writeEvidence: async options => { written = options.evidence; },
      });
      assert.equal(evidence.status, "failed");
      assert.equal(evidence.checks.at(-1).id, "tracked-source-clean");
      assert.equal(evidence.checks.at(-1).status, "failed");
      assert.equal(evidence.checks.at(-1).exitCode, 1);
      assert.match(evidence.failure.message, fixture.pattern);
      assert.equal(written, evidence);
    });
  }
});

test("evidence writes atomically beneath the workbench cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatero-stage-one-evidence-"));
  const path = join(root, "products", "workbench", ".cache", "acceptance", "stage-1.json");
  try {
    await writeStageOneEvidence({ path, evidence: { schemaVersion: 1, status: "passed" } });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { schemaVersion: 1, status: "passed" });
    assert.deepEqual(await readdir(join(root, "products", "workbench", ".cache", "acceptance")), ["stage-1.json"]);
  }
  finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Stage 1 CLI is closed to arguments", () => {
  assert.deepEqual(parseStageOneAcceptanceArguments([]), {});
  assert.throws(() => parseStageOneAcceptanceArguments(["--skip", "code-oss-compile"]), /accepts no arguments/u);
});
