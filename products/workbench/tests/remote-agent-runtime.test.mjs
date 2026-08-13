import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workbenchRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const nativeCodexPatchPath = join(
  workbenchRoot,
  "patches",
  "code-oss",
  "0003-chatero-native-codex.patch",
);
const productPath = join(workbenchRoot, "product.chatero.json");
const remoteExtensionManifestPath = join(
  workbenchRoot,
  "extensions",
  "chatero-remote",
  "package.json",
);
const generatedCheckout = process.env.CHATERO_CODE_OSS_DIR
  ? resolve(process.env.CHATERO_CODE_OSS_DIR)
  : join(workbenchRoot, "..", "..", "vendor", "code-oss");

async function runtimeContract() {
  const [patch, productText, extensionText] = await Promise.all([
    readFile(nativeCodexPatchPath, "utf8"),
    readFile(productPath, "utf8"),
    readFile(remoteExtensionManifestPath, "utf8"),
  ]);
  return {
    patch,
    product: JSON.parse(productText),
    extension: JSON.parse(extensionText),
  };
}

test("the native remote runtime keeps Code-OSS Agent Host as the only chat runtime", async () => {
  const { patch } = await runtimeContract();

  assert.doesNotMatch(patch, /^\+.*chatero-agent(?:\b|\/)/m);
  assert.doesNotMatch(patch, /^\+.*registerProvider\([^\n]*(?:CopilotAgent|ClaudeAgent)/m);
});

test("the pinned server registers the native Agent Host remote proxy", {
  skip: !existsSync(join(generatedCheckout, "src", "vs", "server", "node", "serverServices.ts")),
}, async () => {
  const [starter, services, channelIds] = await Promise.all([
    readFile(join(generatedCheckout, "src", "vs", "platform", "agentHost", "node", "nodeAgentHostStarter.ts"), "utf8"),
    readFile(join(generatedCheckout, "src", "vs", "server", "node", "serverServices.ts"), "utf8"),
    readFile(join(generatedCheckout, "src", "vs", "platform", "agentHost", "common", "agentService.ts"), "utf8"),
  ]);

  assert.match(starter, /VSCODE_ESM_ENTRYPOINT:\s*'vs\/platform\/agentHost\/node\/agentHostMain'/);
  assert.match(starter, /catch \(error\)[\s\S]*return \{\};/);
  assert.ok(
    starter.indexOf("Object.assign(env, sdkEnv)") > starter.indexOf("...shellEnv"),
    "pinned Agent SDK variables must override inherited variables"
  );
  assert.match(services, /socketServer\.registerChannel\(AgentHostIpcChannels\.RemoteProxy/);
  assert.match(channelIds, /RemoteProxy\s*=\s*'agentHostProxy'/);
});

test("Node Agent Host inherits the parent Codex environment before shell and SDK overrides", async () => {
  const { patch } = await runtimeContract();

  const starterSection = patch
    .split("diff --git ")
    .find(section => section.includes("nodeAgentHostStarter.ts"));
  assert.ok(starterSection, "Node Agent Host starter patch is required");
  assert.match(
    starterSection,
    /\+\s*\.\.\.process\.env as Record<string, string>,\n\s*\.\.\.shellEnv as Record<string, string>/,
    "resolved login-shell variables must override the inherited parent environment"
  );
});

test("Codex is OpenAI-only and a signed-out account never falls back to Copilot", async () => {
  const { patch } = await runtimeContract();

  assert.match(patch, /_resolveUsageSource\(\): CodexUsageSource/);
  assert.match(patch, /return ['"]openai['"]/);
  assert.match(patch, /resolveCodexUsageSourceAfterAccountRead/);
  assert.match(patch, /requiresCopilotSignIn:\s*agent\.provider !== CODEX_AGENT_PROVIDER_ID/);
  assert.match(patch, /source === 'openai' \? \[repoResource\] : \[copilotResource, repoResource\]/);
  assert.match(patch, /this\._usageSource === 'openai'[\s\S]*?return false;/);
  assert.match(patch, /Enable Codex Agent sessions in Chatero[\s\S]*bundled OpenAI Codex SDK and your OpenAI account/);
  assert.match(patch, /bundled Codex App Server using your OpenAI account/);
  assert.match(patch, /description: localize\('codexAgent\.description\.openai', "Codex agent using your OpenAI account"\)/);
  assert.doesNotMatch(patch, /^\+.*falling back to GitHub Copilot/m);
  assert.doesNotMatch(patch, /^\+.*\?\? ['"]copilot['"]/m);
  assert.doesNotMatch(patch, /^\+.*Codex.*(?:GitHub Copilot|Copilot subscription)/mi);
});

test("explicit text context is visible, removable, and never auto-sends", async () => {
  const { patch } = await runtimeContract();

  assert.match(patch, /chatero\.chat\.attachTextContext/);
  assert.match(patch, /chatero\.chat\.removeTextContext/);
  assert.match(patch, /CHATERO_TEXT_CONTEXT_ID_PATTERN/);
  assert.match(patch, /kind:\s*'string'/);
  assert.match(patch, /attachmentModel\.addContext/);
  assert.match(patch, /attachmentModel\.delete/);
  assert.match(patch, /widget\.focusInput\(\)/);
  assert.doesNotMatch(patch, /^\+.*(?:acceptInput|sendRequest|submit)\(/m);
});

test("generic string context is serialized as an Agent Host Simple attachment", async () => {
  const { patch } = await runtimeContract();

  assert.match(patch, /v\.kind === 'generic'/);
  assert.match(patch, /typeof v\.value === 'string'/);
  assert.match(patch, /type:\s*MessageAttachmentKind\.Simple/);
  assert.match(patch, /_toSimpleAttachment\(v\.name, v\.value/);
});

test("Chatero defaults enable native Codex while disabling Claude and BYOK", async () => {
  const { product, extension } = await runtimeContract();
  const defaults = extension.contributes?.configurationDefaults;

  assert.deepEqual(defaults, {
    "chat.agentHost.enabled": true,
    "chat.agentHost.claudeAgent.enabled": false,
    "chat.agentHost.codexAgent.enabled": true,
    "chat.agentHost.codexAgent.multiRootEnabled": true,
    "chat.agentHost.byokModels.enabled": false,
    "chat.editor.codex.preferAgentHost": true,
  });
  assert.deepEqual(product.agentSdks, {});
  assert.equal(product.defaultChatAgent, null);
});
