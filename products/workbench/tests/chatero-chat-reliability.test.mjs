import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workbenchRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(workbenchRoot, "..", "..");
const patchPath = join(
  workbenchRoot,
  "patches",
  "code-oss",
  "0029-fix-locked-codex-chat-and-refresh-models.patch",
);
const startupRacePatchPath = join(
  workbenchRoot,
  "patches",
  "code-oss",
  "0030-relock-late-agent-host-chat.patch",
);
const generatedCheckout = process.env.CHATERO_CODE_OSS_DIR
  ? resolve(process.env.CHATERO_CODE_OSS_DIR)
  : join(root, "vendor", "code-oss");

test("the pinned Codex runtime matches the model-list protocol used by Chatero", async () => {
  const files = await Promise.all([
    "remote-agent/scripts/build-linux-agent.mjs",
    "remote-agent/scripts/stage-release.mjs",
    "scripts/run-stage-5-real-ssh.mjs",
  ].map(path => readFile(join(workbenchRoot, path), "utf8")));

  for (const source of files) {
    assert.ok(source.includes("0.149.1") || source.includes("0\\.149\\.1"));
    assert.ok(!source.includes("0.142.0") && !source.includes("0\\.142\\.0"));
  }
});

test("the Code-OSS patch lets a locked contributed session send without a global default agent", async () => {
  const patch = await readFile(patchPath, "utf8");

  assert.match(patch, /agentIdSilent[\s\S]*?getDefaultAgent/);
  assert.match(patch, /locked contributed session sends without a global default agent/);
  assert.match(patch, /@openai\/codex["']:\s*["']0\.149\.1/);
  assert.match(patch, /build\/agent-sdk\/agents\/codex\/package\.json/);
  assert.match(patch, /build\/codex\/codex-version\.txt/);
  assert.match(patch, /Generated from @openai\/codex 0\.149\.1/);
  assert.doesNotMatch(patch, /^\+.*@openai\/codex["']:\s*["']0\.142\.0/m);
});

test("the generated checkout contains the locked-agent send fix", {
  skip: !existsSync(join(generatedCheckout, "src", "vs", "workbench", "contrib", "chat", "common", "chatService", "chatServiceImpl.ts")),
}, async () => {
  const source = await readFile(join(
    generatedCheckout,
    "src",
    "vs",
    "workbench",
    "contrib",
    "chat",
    "common",
    "chatService",
    "chatServiceImpl.ts",
  ), "utf8");
  const packagedCodexManifest = await readFile(join(
    generatedCheckout,
    "build",
    "agent-sdk",
    "agents",
    "codex",
    "package.json",
  ), "utf8");
  const protocolVersion = await readFile(join(
    generatedCheckout,
    "build",
    "codex",
    "codex-version.txt",
  ), "utf8");

  assert.match(source, /const silentAgent = options\?\.agentIdSilent[\s\S]*?const defaultAgent = silentAgent \?\? this\.chatAgentService\.getDefaultAgent/);
  assert.equal(JSON.parse(packagedCodexManifest).dependencies["@openai/codex"], "0.149.1");
  assert.equal(protocolVersion.trim(), "0.149.1");
});

test("late Agent Host registration relocks the restored Codex chat", async () => {
  const patch = await readFile(startupRacePatchPath, "utf8");

  assert.match(patch, /onDidChangeAgents\(\)[\s\S]*?updateWidgetLockState/);
  assert.match(patch, /getAgent\(sessionType\)/);
  assert.match(patch, /lockToCodingAgent/);
  assert.match(patch, /late Agent Host registration relocks the restored contributed session/);
});

test("the generated checkout contains the late Agent Host relock fix", {
  skip: !existsSync(join(generatedCheckout, "src", "vs", "workbench", "contrib", "chat", "browser", "widgetHosts", "viewPane", "chatViewPane.ts")),
}, async () => {
  const source = await readFile(join(
    generatedCheckout,
    "src",
    "vs",
    "workbench",
    "contrib",
    "chat",
    "browser",
    "widgetHosts",
    "viewPane",
    "chatViewPane.ts",
  ), "utf8");

  assert.match(source, /onDidChangeAgents\(\)[\s\S]*?updateWidgetLockState/);
  assert.match(source, /getAgent\(sessionType\)/);
  assert.match(source, /lockToCodingAgent/);
});
