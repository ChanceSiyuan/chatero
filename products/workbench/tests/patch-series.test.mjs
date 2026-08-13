import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

const canonicalPatchDirectory = join(
  new URL("..", import.meta.url).pathname,
  "patches",
  "code-oss",
);

const execFile = promisify(execFileCallback);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    force: true,
    recursive: true,
  })));
});

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8" });
  return stdout.trimEnd();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createPatchFixture({ invalidSecond = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "chatero-patch-series-"));
  temporaryDirectories.push(root);
  const checkout = join(root, "checkout");
  const patches = join(root, "patches");
  await mkdir(checkout);
  await mkdir(patches);
  await git(checkout, "init", "--initial-branch=main");
  await git(checkout, "config", "user.name", "Chatero Tests");
  await git(checkout, "config", "user.email", "tests@chatero.invalid");
  await writeFile(join(checkout, "a.txt"), "one\n");
  await writeFile(join(checkout, "b.txt"), "one\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-m", "base");

  const first = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-one",
    "+two",
    "",
  ].join("\n");
  const second = [
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1 @@",
    invalidSecond ? "-does-not-exist" : "-one",
    "+three",
    "",
  ].join("\n");
  await writeFile(join(patches, "0001-a.patch"), first);
  await writeFile(join(patches, "0002-b.patch"), second);
  const seriesPath = join(patches, "series.json");
  await writeFile(seriesPath, `${JSON.stringify({
    schemaVersion: 1,
    patches: [
      { file: "0001-a.patch", sha256: sha256(first) },
      { file: "0002-b.patch", sha256: sha256(second) },
    ],
  }, null, 2)}\n`);
  return { checkout, root, seriesPath };
}

async function createDependentPatchFixture() {
  const fixture = await createPatchFixture();
  const patches = join(fixture.root, "patches");
  const first = await readFile(join(patches, "0001-a.patch"), "utf8");
  const second = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-two",
    "+three",
    "",
  ].join("\n");
  await writeFile(join(patches, "0002-b.patch"), second);
  await writeFile(fixture.seriesPath, `${JSON.stringify({
    schemaVersion: 1,
    patches: [
      { file: "0001-a.patch", sha256: sha256(first) },
      { file: "0002-b.patch", sha256: sha256(second) },
    ],
  }, null, 2)}\n`);
  return fixture;
}

test("accepts the deliberate empty initial patch series without touching Git", async () => {
  const { applyPatchSeries } = await import("../scripts/lib/patch-series.mjs");
  const directory = await mkdtemp(join(tmpdir(), "chatero-empty-patches-"));
  temporaryDirectories.push(directory);
  const seriesPath = join(directory, "series.json");
  await writeFile(seriesPath, '{"schemaVersion":1,"patches":[]}\n');

  const result = await applyPatchSeries({
    checkout: join(directory, "missing-checkout-is-not-needed"),
    seriesPath,
  });

  assert.deepEqual(result, { applied: [] });
});

test("applies a verified series in declared order", async () => {
  const { applyPatchSeries } = await import("../scripts/lib/patch-series.mjs");
  const { checkout, seriesPath } = await createPatchFixture();

  const result = await applyPatchSeries({ checkout, seriesPath });

  assert.deepEqual(result, { applied: ["0001-a.patch", "0002-b.patch"] });
  assert.equal(await readFile(join(checkout, "a.txt"), "utf8"), "two\n");
  assert.equal(await readFile(join(checkout, "b.txt"), "utf8"), "three\n");
});

test("preflights ordered patch dependencies without a temporary worktree", async () => {
  const { applyPatchSeries } = await import("../scripts/lib/patch-series.mjs");
  const { checkout, seriesPath } = await createDependentPatchFixture();

  const result = await applyPatchSeries({ checkout, seriesPath });

  assert.deepEqual(result, { applied: ["0001-a.patch", "0002-b.patch"] });
  assert.equal(await readFile(join(checkout, "a.txt"), "utf8"), "three\n");
});

test("checks every patch before applying the first one", async () => {
  const { applyPatchSeries } = await import("../scripts/lib/patch-series.mjs");
  const { checkout, seriesPath } = await createPatchFixture({ invalidSecond: true });

  await assert.rejects(
    applyPatchSeries({ checkout, seriesPath }),
    /0002-b\.patch failed git apply preflight/
  );

  assert.equal(await readFile(join(checkout, "a.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(checkout, "b.txt"), "utf8"), "one\n");
  assert.equal(await git(checkout, "status", "--porcelain=v1"), "");
});

test("rejects a digest mismatch before running Git", async () => {
  const { applyPatchSeries } = await import("../scripts/lib/patch-series.mjs");
  const { checkout, seriesPath } = await createPatchFixture();
  const series = JSON.parse(await readFile(seriesPath, "utf8"));
  series.patches[0].sha256 = "0".repeat(64);
  await writeFile(seriesPath, `${JSON.stringify(series, null, 2)}\n`);

  await assert.rejects(
    applyPatchSeries({
      checkout,
      seriesPath,
      runGit: async () => assert.fail("digest mismatch must fail before invoking Git"),
    }),
    /SHA-256 mismatch for 0001-a\.patch/
  );
  assert.equal(await readFile(join(checkout, "a.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(checkout, "b.txt"), "utf8"), "one\n");
});

test("rejects traversal, absolute paths, duplicate files, and unknown fields", async () => {
  const { applyPatchSeries } = await import("../scripts/lib/patch-series.mjs");
  const directory = await mkdtemp(join(tmpdir(), "chatero-unsafe-patches-"));
  temporaryDirectories.push(directory);
  const digest = "0".repeat(64);
  const cases = [
    { patches: [{ file: "../escape.patch", sha256: digest }], message: /unsafe patch path/ },
    { patches: [{ file: "/tmp/escape.patch", sha256: digest }], message: /unsafe patch path/ },
    { patches: [{ file: "a.patch", sha256: digest }, { file: "a.patch", sha256: digest }], message: /duplicate patch file/ },
    { patches: [{ file: "a.patch", sha256: digest, command: "echo unsafe" }], message: /unknown field patches\[0\]\.command/ },
  ];

  for (const [index, value] of cases.entries()) {
    const seriesPath = join(directory, `series-${index}.json`);
    await writeFile(seriesPath, JSON.stringify({ schemaVersion: 1, patches: value.patches }));
    await assert.rejects(
      applyPatchSeries({ checkout: directory, seriesPath }),
      value.message
    );
  }
});

test("the canonical series pins Chatero startup compatibility after native Codex and Documentation authority", async () => {
  const series = JSON.parse(await readFile(join(canonicalPatchDirectory, "series.json"), "utf8"));
  const entry = series.patches.at(-11);
  const compatibilityEntry = series.patches.at(-10);
  const startupEntry = series.patches.at(-9);
  const bundledSdkEntry = series.patches.at(-8);
  const optionalCopilotEntry = series.patches.at(-7);
  const codexIpcEntry = series.patches.at(-6);
  const liveCodexHomeEntry = series.patches.at(-5);
  const excludedSystemExtensionsEntry = series.patches.at(-4);
  const openAIIsolationEntry = series.patches.at(-3);
  const codexConnectionEntry = series.patches.at(-2);
  const codexOnlyEntry = series.patches.at(-1);

  assert.equal(entry.file, "0004-chatero-documentation-agent-authority.patch");
  assert.equal(series.patches.at(-12)?.file, "0003-chatero-native-codex.patch");
  assert.equal(compatibilityEntry.file, "0005-fix-chatero-codex-tests.patch");
  assert.equal(startupEntry.file, "0006-disable-copilot-onboarding-without-agent.patch");
  assert.equal(bundledSdkEntry.file, "0007-bundle-chatero-codex-sdk.patch");
  assert.equal(optionalCopilotEntry.file, "0008-lazy-load-optional-copilot-api.patch");
  assert.equal(codexIpcEntry.file, "0009-allow-ephemeral-codex-ipc-sockets.patch");
  assert.equal(liveCodexHomeEntry.file, "0010-shallow-pin-live-codex-home.patch");
  assert.equal(excludedSystemExtensionsEntry.file, "0011-exclude-unshipped-system-extensions.patch");
  assert.equal(openAIIsolationEntry.file, "0012-isolate-openai-codex-resources.patch");
  assert.equal(codexConnectionEntry.file, "0013-deduplicate-codex-connection-startup.patch");
  assert.equal(codexOnlyEntry.file, "0014-default-agent-host-to-codex-only.patch");
  const bytes = await readFile(join(canonicalPatchDirectory, entry.file));
  const compatibilityBytes = await readFile(join(canonicalPatchDirectory, compatibilityEntry.file));
  const startupBytes = await readFile(join(canonicalPatchDirectory, startupEntry.file));
  const bundledSdkBytes = await readFile(join(canonicalPatchDirectory, bundledSdkEntry.file));
  const optionalCopilotBytes = await readFile(join(canonicalPatchDirectory, optionalCopilotEntry.file));
  const codexIpcBytes = await readFile(join(canonicalPatchDirectory, codexIpcEntry.file));
  const liveCodexHomeBytes = await readFile(join(canonicalPatchDirectory, liveCodexHomeEntry.file));
  const excludedSystemExtensionsBytes = await readFile(join(canonicalPatchDirectory, excludedSystemExtensionsEntry.file));
  const openAIIsolationBytes = await readFile(join(canonicalPatchDirectory, openAIIsolationEntry.file));
  const codexConnectionBytes = await readFile(join(canonicalPatchDirectory, codexConnectionEntry.file));
  const codexOnlyBytes = await readFile(join(canonicalPatchDirectory, codexOnlyEntry.file));
  assert.equal(entry.sha256, sha256(bytes));
  assert.equal(compatibilityEntry.sha256, sha256(compatibilityBytes));
  assert.equal(startupEntry.sha256, sha256(startupBytes));
  assert.equal(bundledSdkEntry.sha256, sha256(bundledSdkBytes));
  assert.equal(optionalCopilotEntry.sha256, sha256(optionalCopilotBytes));
  assert.equal(codexIpcEntry.sha256, sha256(codexIpcBytes));
  assert.equal(liveCodexHomeEntry.sha256, sha256(liveCodexHomeBytes));
  assert.equal(excludedSystemExtensionsEntry.sha256, sha256(excludedSystemExtensionsBytes));
  assert.equal(openAIIsolationEntry.sha256, sha256(openAIIsolationBytes));
  assert.equal(codexConnectionEntry.sha256, sha256(codexConnectionBytes));
  assert.equal(codexOnlyEntry.sha256, sha256(codexOnlyBytes));
  assert.match(bytes.toString("utf8"), /acquireDocumentationWorkingCopyBarrier/);
  assert.match(compatibilityBytes.toString("utf8"), /chatero_workspace/);
  assert.match(startupBytes.toString("utf8"), /product\.defaultChatAgent \? OnboardingVariationA : DisabledOnboardingService/);
  assert.match(startupBytes.toString("utf8"), /if \(!productService\.defaultChatAgent\)/);
  assert.match(startupBytes.toString("utf8"), /this\.initBarrier\.open\(\)/);
  assert.doesNotMatch(startupBytes.toString("utf8"), /^\+.*Onboarding requires a default chat agent product configuration\./m);
  assert.match(bundledSdkBytes.toString("utf8"), /agent-sdk\/codex/);
  assert.match(bundledSdkBytes.toString("utf8"), /configuredCodexSdkRoot \|\| \(existsSync\(bundledCodexSdkRoot\)/);
  assert.match(bundledSdkBytes.toString("utf8"), /@openai\/codex-\$\{platform\}-\$\{arch\}/);
  assert.match(optionalCopilotBytes.toString("utf8"), /import type \{ CAPIClient, CCAModel, IExtensionInformation, RequestType as CopilotRequestType \} from '@vscode\/copilot-api'/);
  assert.match(optionalCopilotBytes.toString("utf8"), /await import\('@vscode\/copilot-api'\)/);
  assert.doesNotMatch(optionalCopilotBytes.toString("utf8"), /^\+import \{[^\n]*\} from '@vscode\/copilot-api'/m);
  assert.match(codexIpcBytes.toString("utf8"), /if \(lstat\.isSocket\(\)\) \{/);
  assert.match(codexIpcBytes.toString("utf8"), /allows an ephemeral Unix socket inside CODEX_HOME/);
  assert.match(liveCodexHomeBytes.toString("utf8"), /captureProtectedObjectInventory\(\[codexHome\], false\)/);
  assert.match(liveCodexHomeBytes.toString("utf8"), /allows ephemeral runtime links below a direct CODEX_HOME directory/);
  assert.match(liveCodexHomeBytes.toString("utf8"), /typeof fs\.realpathSync\.native === 'function'/);
  assert.match(excludedSystemExtensionsBytes.toString("utf8"), /readonly excludedSystemExtensionNames\?: readonly string\[\]/);
  assert.match(excludedSystemExtensionsBytes.toString("utf8"), /excludedNames\.has\(extension\.manifest\.name\)/);
  assert.match(openAIIsolationBytes.toString("utf8"), /return source === 'openai' \? \[\] : \[copilotResource, repoResource\]/);
  assert.match(openAIIsolationBytes.toString("utf8"), /codexProtectedResourcesForUsageSource\('openai', copilot, repo\), \[\]/);
  assert.match(openAIIsolationBytes.toString("utf8"), /`features\.plugins=false`/);
  assert.match(codexConnectionBytes.toString("utf8"), /this\._connection\.kind === 'ready'/);
  assert.match(codexConnectionBytes.toString("utf8"), /reuses a connection established while OpenAI validation was pending/);
  assert.match(codexOnlyBytes.toString("utf8"), /AgentHostClaudeAgentEnabledEnvVar\], false/);
});
