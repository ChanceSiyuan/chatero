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
const startupPatchPath = join(
  workbenchRoot,
  "patches",
  "code-oss",
  "0006-disable-copilot-onboarding-without-agent.patch",
);
const bundledSdkPatchPath = join(
  workbenchRoot,
  "patches",
  "code-oss",
  "0007-bundle-chatero-codex-sdk.patch",
);
const optionalCopilotPatchPath = join(
  workbenchRoot,
  "patches",
  "code-oss",
  "0008-lazy-load-optional-copilot-api.patch",
);
const codexIpcPatchPath = join(
  workbenchRoot,
  "patches",
  "code-oss",
  "0009-allow-ephemeral-codex-ipc-sockets.patch",
);
const liveCodexHomePatchPath = join(
  workbenchRoot,
  "patches",
  "code-oss",
  "0010-shallow-pin-live-codex-home.patch",
);
const checkout = join(repositoryRoot, "vendor", "code-oss");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("Documentation authority and its Chatero compatibility patches remain digest-pinned in order", async () => {
  const [patch, compatibilityPatch, startupPatch, bundledSdkPatch, optionalCopilotPatch, codexIpcPatch, liveCodexHomePatch, seriesText] = await Promise.all([
    readFile(patchPath),
    readFile(compatibilityPatchPath),
    readFile(startupPatchPath),
    readFile(bundledSdkPatchPath),
    readFile(optionalCopilotPatchPath),
    readFile(codexIpcPatchPath),
    readFile(liveCodexHomePatchPath),
    readFile(join(workbenchRoot, "patches", "code-oss", "series.json"), "utf8"),
  ]);
  const entries = JSON.parse(seriesText).patches;
  const authorityIndex = entries.findIndex(entry => entry.file === "0004-chatero-documentation-agent-authority.patch");
  assert.notEqual(authorityIndex, -1);
  assert.deepEqual(entries.slice(authorityIndex, authorityIndex + 7), [{
    file: "0004-chatero-documentation-agent-authority.patch",
    sha256: sha256(patch),
  }, {
    file: "0005-fix-chatero-codex-tests.patch",
    sha256: sha256(compatibilityPatch),
  }, {
    file: "0006-disable-copilot-onboarding-without-agent.patch",
    sha256: sha256(startupPatch),
  }, {
    file: "0007-bundle-chatero-codex-sdk.patch",
    sha256: sha256(bundledSdkPatch),
  }, {
    file: "0008-lazy-load-optional-copilot-api.patch",
    sha256: sha256(optionalCopilotPatch),
  }, {
    file: "0009-allow-ephemeral-codex-ipc-sockets.patch",
    sha256: sha256(codexIpcPatch),
  }, {
    file: "0010-shallow-pin-live-codex-home.patch",
    sha256: sha256(liveCodexHomePatch),
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

test("Documentation tools expose explicit prompt reference names", async () => {
  const manifest = JSON.parse(await readFile(join(
    workbenchRoot,
    "extensions",
    "chatero-documentation",
    "package.json",
  ), "utf8"));
  const tools = new Map(manifest.contributes.languageModelTools.map(tool => [tool.name, tool]));
  assert.equal(tools.get("chatero_documentation_retrieve")?.toolReferenceName, "reviewedDocumentation");
  assert.equal(tools.get("chatero_documentation_stage")?.toolReferenceName, "stageDocumentation");
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
