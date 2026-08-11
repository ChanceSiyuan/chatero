import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workbenchRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const quarantinePatchPath = join(
  workbenchRoot,
  "patches",
  "code-oss",
  "0002-quarantine-upstream-copilot-sources.patch",
);
const nativeCodexPatchPath = join(
  workbenchRoot,
  "patches",
  "code-oss",
  "0003-chatero-native-codex.patch",
);

test("the Code-OSS patch set disables the unshipped Copilot provider without disabling Codex or Claude", async () => {
  const patch = await readFile(quarantinePatchPath, "utf8");

  assert.match(patch, /-import \{ CopilotAgent \}/);
  assert.match(patch, /-\s*agentService\.registerProvider\([^\n]*CopilotAgent/);
  assert.match(patch, /agentService\.registerProvider\([^\n]*ClaudeAgent/);
  assert.match(patch, /agentService\.registerProvider\([^\n]*CodexAgent/);
  assert.doesNotMatch(patch, /^\+.*@github\/copilot(?:-sdk)?/m);
});

test("only source files that import the absent Copilot SDK are type-check quarantined", async () => {
  const patch = await readFile(quarantinePatchPath, "utf8");
  const sections = patch.split(/^diff --git /m).slice(1);
  const quarantined = sections.filter(section => section.includes("+// @ts-nocheck"));

  assert.ok(quarantined.length > 0);
  for (const section of quarantined) {
    assert.match(section, /import .* from '@github\/copilot-sdk';/);
    assert.match(section, /\+\/\/ Chatero does not ship or activate the upstream Copilot provider\./);
  }
});

test("the Chatero Codex policy cannot reactivate Copilot or Claude providers", async () => {
  const patch = await readFile(nativeCodexPatchPath, "utf8");

  assert.match(patch, /^\+.*return 'openai';/m);
  assert.doesNotMatch(patch, /^\+.*registerProvider\([^\n]*(?:CopilotAgent|ClaudeAgent)/m);
  assert.doesNotMatch(patch, /^\+.*@github\/copilot(?:-sdk)?/m);
  assert.doesNotMatch(patch, /^\+.*falling back to GitHub Copilot/m);
});
