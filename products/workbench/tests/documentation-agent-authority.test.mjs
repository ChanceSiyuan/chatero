import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workbenchRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(workbenchRoot, "..", "..");
const patchPath = join(
  workbenchRoot,
  "patches",
  "code-oss",
  "0004-chatero-documentation-agent-authority.patch",
);
const compatibilityPatchPath = join(
  workbenchRoot,
  "patches",
  "code-oss",
  "0005-fix-chatero-codex-tests.patch",
);
const checkout = join(repositoryRoot, "vendor", "code-oss");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("Documentation authority and its test compatibility patch are digest-pinned last", async () => {
  const [patch, compatibilityPatch, seriesText] = await Promise.all([
    readFile(patchPath),
    readFile(compatibilityPatchPath),
    readFile(join(workbenchRoot, "patches", "code-oss", "series.json"), "utf8"),
  ]);
  const entries = JSON.parse(seriesText).patches;
  assert.deepEqual(entries.slice(-2), [{
    file: "0004-chatero-documentation-agent-authority.patch",
    sha256: sha256(patch),
  }, {
    file: "0005-fix-chatero-codex-tests.patch",
    sha256: sha256(compatibilityPatch),
  }]);
});

test("all Native Codex lifecycle requests select one fail-closed product profile", async () => {
  const patch = await readFile(patchPath, "utf8");
  for (const profile of [
    "chatero_read_only",
    "chatero_workspace",
    "chatero_full_access",
  ]) {
    assert.match(patch, new RegExp(profile));
  }
  for (const lifecycle of ["thread/start", "turn/start", "thread/fork", "thread/resume"]) {
    assert.match(patch, new RegExp(lifecycle.replace("/", "\\/")));
  }
  assert.match(patch, /chateroCodexLifecyclePermissions/);
  assert.match(patch, /activePermissionProfile/);
  assert.match(patch, /config\/read/);
  assert.match(patch, /configRequirements\/read/);
  assert.match(patch, /permissionProfile\/list/);
  assert.doesNotMatch(patch, /^\+\s+sandbox(?:Policy)?:/m);
});

test("reserved Documentation and runtime roots cannot be reopened", async () => {
  const patch = await readFile(patchPath, "utf8");
  for (const path of [
    "documentation",
    ".chatero",
    "work/qlab-zotero/documentation-changes",
    "work/qlab-zotero/documentation-migration",
    ".codex",
  ]) {
    assert.ok(patch.includes(path), path);
  }
  assert.match(patch, /CODEX_HOME/);
  assert.match(patch, /hard-link alias/);
  assert.match(patch, /protected Codex object identity changed/);
  assert.match(patch, /does not allow user-provided Codex app-server binaryArgs/);
});

test("Working Copy Barrier is product-private and binds optimistic concurrency", async () => {
  const patch = await readFile(patchPath, "utf8");
  assert.match(patch, /chatero\.chatero-documentation/);
  assert.match(patch, /acquireDocumentationWorkingCopyBarrier/);
  assert.match(patch, /expectedVersion/);
  assert.match(patch, /expectedDigest/);
  assert.match(patch, /intendedDigest/);
  assert.match(patch, /expectedDirectoryGeneration/);
  assert.match(patch, /directoryGeneration\(this\.services\.fileSystem\.value, resource\.uri\)/);
  assert.doesNotMatch(patch, /directory generation requires the authority-side verifier/);
  assert.match(patch, /finalizeResourceOutcomes/);
  assert.match(patch, /product-private/);
});

test("pinned Codex 0.142 protocol exposes named permissions on every lifecycle", {
  skip: !existsSync(join(checkout, "src", "vs", "platform", "agentHost", "node", "codex", "protocol", "generated", "v2")),
}, async () => {
  const protocolRoot = join(
    checkout,
    "src",
    "vs",
    "platform",
    "agentHost",
    "node",
    "codex",
    "protocol",
    "generated",
    "v2",
  );
  for (const name of ["ThreadStartParams", "TurnStartParams", "ThreadForkParams", "ThreadResumeParams"]) {
    const source = await readFile(join(protocolRoot, `${name}.ts`), "utf8");
    assert.match(source, /Generated from @openai\/codex 0\.142\.0/);
    assert.match(source, /permissions\?: string \| null/);
  }
});
