import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..", "..", "..");

test("Stage 7 immutable contract cannot cut over before every prior gate and notarized release", async () => {
  const { validateStageSevenRequirements } = await import("../scripts/run-stage-7-acceptance.mjs");
  const requirements = JSON.parse(await readFile(new URL("../acceptance/stage-7.requirements.json", import.meta.url)));
  const contract = validateStageSevenRequirements(requirements);
  assert.equal(contract.checks.length, 10);
  assert.deepEqual(contract.checks.map(value => value.id), [
    "stage-1-same-source", "stage-2-same-source", "stage-3-same-source", "stage-4-same-source",
    "stage-5-same-source", "stage-6-same-source", "complete-parity-catalog", "recovery-security-license-suite",
    "notarized-macos-release", "atomic-cutover",
  ]);
});

test("final parity catalog resolves every Stage 3-6 entry with no unsupported behavior", async () => {
  const { inspectCompleteParity } = await import("../scripts/run-stage-7-acceptance.mjs");
  const audit = await inspectCompleteParity({ root });
  assert.ok(audit.entries >= 90);
  assert.equal(audit.unsupportedEntries, 0);
  assert.equal(audit.unresolvedEvidence, 0);
  assert.match(audit.catalogSha256, /^[0-9a-f]{64}$/u);
});

test("prior evidence must be passed, complete, and bound to the final source commit", async () => {
  const { inspectPriorStageEvidence } = await import("../scripts/run-stage-7-acceptance.mjs");
  const receipt = {
    schemaVersion: 1, stage: 6, status: "passed",
    sourceCommit: "a".repeat(40),
    checks: [{ id: "one", status: "passed", exitCode: 0 }],
  };
  assert.deepEqual(inspectPriorStageEvidence(receipt, {
    stage: 6, sourceCommit: "a".repeat(40), requiredChecks: ["one"],
  }), { stage: 6, checks: 1, sourceCommit: "a".repeat(40) });
  for (const invalid of [
    { ...receipt, status: "failed" },
    { ...receipt, sourceCommit: "b".repeat(40) },
    { ...receipt, checks: [{ id: "one", status: "skipped", exitCode: 0 }] },
  ]) assert.throws(() => inspectPriorStageEvidence(invalid, {
    stage: 6, sourceCommit: "a".repeat(40), requiredChecks: ["one"],
  }), /invalid|stale|incomplete/iu);
});

test("Stage 7 derives every prior check id from the immutable stage requirements", async () => {
  const { loadPriorStageChecks } = await import("../scripts/run-stage-7-acceptance.mjs");
  assert.deepEqual(await loadPriorStageChecks({ root, stage: 3 }), [
    "native-library-tests", "core-library-tests", "official-zotero-feature-coverage",
    "workbench-tests", "code-oss-compile", "signed-gecko-bundle", "library-parity-audit",
  ]);
  assert.deepEqual(await loadPriorStageChecks({ root, stage: 5 }), [
    "ide-language-product-audit", "remote-contract-tests", "cursor-editor-agent-parity",
    "code-oss-compile", "signed-agent-release", "linux-x64-real-ssh",
    "linux-arm64-real-ssh", "stage-five-boundary-audit",
  ]);
  assert.deepEqual(await loadPriorStageChecks({ root, stage: 6 }), [
    "research-loop-contract-tests", "documentation-transaction-tests", "qmd-obsidian-editing-parity",
    "local-research-loop-runtime", "ssh-research-loop-runtime", "research-loop-boundary-audit",
  ]);
});

test("atomic cutover refuses a missing notarization ticket or legacy-visible package", async () => {
  const { inspectAtomicCutover } = await import("../scripts/run-stage-7-acceptance.mjs");
  const base = {
    schemaVersion: 1, status: "passed", sourceCommit: "a".repeat(40), productSha256: "b".repeat(64),
    productFilename: "Chatero-test.dmg", notarySubmissionId: "11111111-1111-4111-8111-111111111111",
    tested: { release: "real fixture" },
    developerIdVerified: true, notarizationAccepted: true, ticketStapled: true, gatekeeperAccepted: true,
    cleanInstall: true, sideBySideInstall: true, copiedProfileMigration: true, upgrade: true, rollback: true,
    urlScheme: true, connector: true, documentIntegration: true, electronOnlyVisibleProduct: true,
  };
  assert.deepEqual(inspectAtomicCutover(base, { sourceCommit: "a".repeat(40), productSha256: "b".repeat(64) }), {
    electronOnlyVisibleProduct: true, notarized: true, productSha256: "b".repeat(64), sourceCommit: "a".repeat(40),
  });
  assert.throws(() => inspectAtomicCutover({ ...base, ticketStapled: false }, { sourceCommit: "a".repeat(40), productSha256: "b".repeat(64) }), /cutover receipt/iu);
  assert.throws(() => inspectAtomicCutover({ ...base, electronOnlyVisibleProduct: false }, { sourceCommit: "a".repeat(40), productSha256: "b".repeat(64) }), /cutover receipt/iu);
});

test("Stage 7 release workflow is protected, macOS-native, notarizes, verifies, and uploads evidence", async () => {
  const source = await readFile(new URL("../../../.github/workflows/stage-7.yml", import.meta.url), "utf8");
  const workflow = parse(source);
  assert.equal(workflow.name, "Stage 7 Atomic Chatero Release");
  assert.deepEqual(Object.keys(workflow.jobs), ["release-macos"]);
  const job = workflow.jobs["release-macos"];
  assert.equal(job["runs-on"], "macos-15");
  assert.match(source, /workflow_dispatch/u);
  assert.match(source, /workflow_run/u);
  assert.match(source, /Stage 5 IDE and Remote SSH/u);
  assert.match(source, /github\.event\.workflow_run\.head_sha == github\.sha|github\.event\.workflow_run\.head_sha/u);
  assert.match(source, /signed-stage-5-release/u);
  assert.match(source, /stage-5-receipt/u);
  for (const stage of [1, 2, 3, 4, 5, 6]) assert.match(source, new RegExp(`verify:stage-${stage}`, "u"));
  assert.match(source, /stage-6-acceptance/u);
  assert.match(source, /verify:stage-6:evidence/u);
  assert.match(source, /app\/scripts\/dir_build/u);
  assert.match(source, /CHATERO_APPLE_DEVELOPER_ID/u);
  assert.match(source, /notarizationAccepted/u);
  assert.match(source, /ticketStapled/u);
  assert.match(source, /npm run verify:stage-7/u);
  assert.match(source, /stage-7\.json/u);
  assert.doesNotMatch(source, /continue-on-error|skip-notari|SIGN=0/iu);
});

test("both macOS release paths embed and reverify the signed dual-architecture Remote Agent", async () => {
  const [production, local, embedding] = await Promise.all([
    readFile(new URL("../scripts/create-stage-7-macos-release.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/create-local-macos-release.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/embed-remote-agent-release.mjs", import.meta.url), "utf8"),
  ]);
  for (const source of [production, local]) {
    assert.match(source, /embedRemoteAgentRelease\(app|embedRemoteAgentRelease\(builtApp/u);
    assert.match(source, /verifyEmbeddedRemoteAgentRelease/u);
    assert.match(source, /realpath\(await mkdtemp/u);
    assert.match(source, /\/usr\/bin\/ditto/u);
    assert.doesNotMatch(source, /await cp\([^;]+recursive: true/su);
  }
  assert.match(embedding, /verifyRelease/u);
  assert.match(embedding, /REMOTE_AGENT_TUPLES/u);
  assert.match(embedding, /nlink !== 1/u);
  assert.match(embedding, /remote-agent/u);
});

test("local macOS release stays distinct from notarized Stage 7 and performs a real cold-start probe", async () => {
  const source = await readFile(new URL("../scripts/create-local-macos-release.mjs", import.meta.url), "utf8");
  assert.match(source, /codesign[\s\S]*--sign[\s\S]*"-"/u);
  assert.match(source, /smokeTest\(app\)/u);
  assert.match(source, /stdio: \["ignore", "pipe", "pipe"\]/u);
  assert.match(source, /diagnosticOutput\(\)/u);
  assert.match(source, /mkdtemp\("\/tmp\/chatero-smoke-"\)/u);
  assert.match(source, /rm\(smokeRoot, \{ recursive: true, force: true \}\)/u);
  assert.match(source, /waitForSmoke/u);
  assert.match(source, /signature: "adhoc-local"/u);
  assert.match(source, /notarized: false/u);
  assert.doesNotMatch(source, /notarytool|notarizationAccepted|ticketStapled/u);
});
