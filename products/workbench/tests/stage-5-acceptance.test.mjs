import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(new URL("../../..", import.meta.url).pathname);

test("Stage 5 immutable contract covers product, signed release, both runners, and boundary", async () => {
  const { validateStageFiveRequirements } = await import("../scripts/run-stage-5-acceptance.mjs");
  const requirements = JSON.parse(await readFile(join(root, "products", "workbench", "acceptance", "stage-5.requirements.json"), "utf8"));
  const contract = validateStageFiveRequirements(requirements);
  assert.equal(contract.stage, 5);
  assert.deepEqual(contract.checks.map(value => value.id), [
    "ide-language-product-audit",
    "remote-contract-tests",
    "code-oss-compile",
    "signed-agent-release",
    "linux-x64-real-ssh",
    "linux-arm64-real-ssh",
    "stage-five-boundary-audit",
  ]);
  assert.deepEqual(contract.checks.filter(value => value.tuple).map(value => value.tuple), [
    "linux-x86_64", "linux-aarch64",
  ]);
});

test("Stage 5 acceptance fails closed on a missing signed release and writes bounded evidence", async () => {
  const { runStageFiveAcceptance } = await import("../scripts/run-stage-5-acceptance.mjs");
  const requirements = JSON.parse(await readFile(join(root, "products", "workbench", "acceptance", "stage-5.requirements.json"), "utf8"));
  const writes = [];
  const evidence = await runStageFiveAcceptance({
    root,
    requirements,
    run: async () => 0,
    inspectProduct: async () => ({ languages: 13 }),
    inspectRelease: async () => { throw new Error(`${root}/release token=private-value missing`); },
    write: async (path, value) => writes.push({ path, value }),
    clock: (() => { let time = 0; return () => time += 5; })(),
  });
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure.checkId, "signed-agent-release");
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(root.replaceAll("/", "\\/"), "u"));
  assert.doesNotMatch(JSON.stringify(evidence), /private-value/u);
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /stage-5\.json$/u);
});

test("Stage 5 acceptance requires both architecture receipts before the boundary audit", async () => {
  const { runStageFiveAcceptance } = await import("../scripts/run-stage-5-acceptance.mjs");
  const requirements = JSON.parse(await readFile(join(root, "products", "workbench", "acceptance", "stage-5.requirements.json"), "utf8"));
  const inspected = [];
  const release = { manifestSha256: "a".repeat(64), artifacts: [] };
  const evidence = await runStageFiveAcceptance({
    root,
    requirements,
    run: async () => 0,
    inspectProduct: async () => ({ languages: 13 }),
    inspectRelease: async () => release,
    inspectReceipt: async ({ tuple }) => {
      inspected.push(tuple);
      if (tuple === "linux-aarch64") throw new Error("arm64 receipt missing");
      return { tuple, checks: 13 };
    },
    inspectBoundary: async () => { throw new Error("boundary must not run"); },
    write: async () => {},
  });
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.failure.checkId, "linux-arm64-real-ssh");
  assert.deepEqual(inspected, ["linux-x86_64", "linux-aarch64"]);
  assert.equal(Object.hasOwn(evidence.audit, "boundary"), false);
});

test("Stage 5 successful acceptance records all seven checks without secret fields", async () => {
  const { runStageFiveAcceptance } = await import("../scripts/run-stage-5-acceptance.mjs");
  const requirements = JSON.parse(await readFile(join(root, "products", "workbench", "acceptance", "stage-5.requirements.json"), "utf8"));
  const release = {
    manifestSha256: "a".repeat(64),
    artifacts: [
      { tuple: "linux-x86_64", sha256: "b".repeat(64) },
      { tuple: "linux-aarch64", sha256: "c".repeat(64) },
    ],
  };
  const evidence = await runStageFiveAcceptance({
    root,
    requirements,
    run: async () => 0,
    inspectProduct: async () => ({ languages: 13 }),
    inspectRelease: async () => release,
    inspectReceipt: async ({ tuple }) => ({ tuple, checks: 13, receiptSha256: "d".repeat(64) }),
    inspectBoundary: async () => ({ rendererDatabaseAccess: false }),
    write: async () => {},
  });
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.checks.length, 7);
  assert.ok(evidence.checks.every(value => value.status === "passed"));
  assert.doesNotMatch(JSON.stringify(evidence), /token|password|grantId|remotePath/iu);
});

test("Stage 5 product audit binds the exact generated Code-OSS checkout", async t => {
  const checkout = process.env.CHATERO_CODE_OSS_DIR;
  if (!checkout) {
    t.skip("CHATERO_CODE_OSS_DIR is not set");
    return;
  }
  const { inspectStageFiveProduct } = await import("../scripts/run-stage-5-acceptance.mjs");
  const audit = await inspectStageFiveProduct({ root });
  assert.equal(audit.languages, 13);
  assert.equal(audit.workbenchCapabilities, 13);
  assert.equal(audit.remoteCapabilities, 18);
  assert.equal(audit.restrictedComponents, 0);
});

test("Stage 5 command accepts no bypass arguments", async () => {
  const { parseStageFiveAcceptanceArguments } = await import("../scripts/run-stage-5-acceptance.mjs");
  assert.deepEqual(parseStageFiveAcceptanceArguments([]), {});
  assert.throws(() => parseStageFiveAcceptanceArguments(["--skip-ssh"]), /accepts no arguments/u);
});
