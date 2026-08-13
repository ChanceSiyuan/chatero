import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  parseDocumentationIntegrationArguments,
  runDocumentationIntegration,
} from "../scripts/run-documentation-integration.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function createCheckoutFixture() {
  const root = await mkdtemp(join(tmpdir(), "chatero-documentation-integration-checkout-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "out"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "out", "main.js"), "// compiled fixture\n");
  await writeFile(join(root, "scripts", "code.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  return root;
}

test("builds one offline pinned Code-OSS launch with fresh isolated directories", async () => {
  const checkout = await createCheckoutFixture();
  const calls = [];
  const verified = [];
  await runDocumentationIntegration({
    root: repositoryRoot,
    checkout,
    target: "local",
    platform: "linux",
    verify: async input => { verified.push(input); return { ok: true }; },
    run: async call => {
      calls.push({ ...call, fixtureSource: await readFile(join(call.env.CHATERO_DOCUMENTATION_WORKSPACE_PATH, "documentation", "index.qmd"), "utf8") });
    },
  });
  assert.equal(verified.length, 1);
  assert.equal(verified[0].destination, checkout);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "xvfb-run");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-a", join(checkout, "scripts", "code.sh")]);
  assert.ok(calls[0].args.some(arg => arg.startsWith("--user-data-dir=")));
  assert.ok(calls[0].args.some(arg => arg.startsWith("--extensions-dir=")));
  assert.ok(calls[0].args.some(arg => arg.startsWith("--extensionDevelopmentPath=")));
  assert.ok(calls[0].args.some(arg => arg.startsWith("--extensionTestsPath=")));
  assert.ok(calls[0].args.includes("--disable-workspace-trust"));
  assert.ok(calls[0].args.includes("--disable-updates"));
  assert.ok(calls[0].args.includes("--skip-welcome"));
  assert.ok(calls[0].args.some(arg => arg.startsWith("--folder-uri=")));
  assert.equal(calls[0].env.CHATERO_DOCUMENTATION_TEST_TARGET, "local");
  assert.match(calls[0].fixtureSource, /# Documentation integration fixture/);
  assert.doesNotMatch(JSON.stringify(calls), /download|update\.code\.visualstudio|marketplace\.visualstudio/i);
  assert.doesNotMatch(JSON.stringify(calls), /\.zotero|Library\/Application Support|personal/i);
});

test("uses the macOS code script directly and forwards only a bounded grep", async () => {
  const checkout = await createCheckoutFixture();
  const calls = [];
  const result = await runDocumentationIntegration({
    root: repositoryRoot,
    checkout,
    target: "local",
    grep: "shared-buffer",
    platform: "darwin",
    verify: async () => ({ ok: true }),
    run: async call => calls.push(call),
  });
  assert.equal(calls[0].file, "bash");
  assert.equal(calls[0].args[0], join(checkout, "scripts", "code.sh"));
  assert.equal(calls[0].env.CHATERO_DOCUMENTATION_TEST_GREP, "shared-buffer");
  assert.equal(calls[0].args.some(arg => arg.startsWith("--chatero-documentation-grep=")), false);
  const driver = await readFile(join(
    repositoryRoot,
    "products",
    "workbench",
    "integration",
    "documentation",
    "driver",
    "run.cjs",
  ), "utf8");
  assert.match(driver, /process\.env\.CHATERO_DOCUMENTATION_TEST_GREP/);
  assert.doesNotMatch(driver, /process\.argv.*chatero-documentation-grep/);
  assert.deepEqual(result, { target: "local", workspace: "<temporary-documentation-workspace>" });
  await assert.rejects(runDocumentationIntegration({
    root: repositoryRoot,
    checkout,
    target: "local",
    grep: "x".repeat(257),
    verify: async () => ({ ok: true }),
    run: async () => {},
  }), /grep/);
});

test("fails closed when the SSH fixture lacks a signed Remote Agent release", async () => {
  const checkout = await createCheckoutFixture();
  await assert.rejects(runDocumentationIntegration({
    root: repositoryRoot,
    checkout,
    target: "ssh-fixture",
    remoteAgentReleaseDir: join(checkout, "missing-release"),
    verify: async () => ({ ok: true }),
    run: async () => { throw new Error("must not launch"); },
  }), /signed Remote Agent fixture|manifest\.json/);
});

test("parses a closed CLI and defaults to no implicit target", () => {
  assert.deepEqual(parseDocumentationIntegrationArguments(["--target", "local"]), { target: "local", grep: undefined });
  assert.deepEqual(parseDocumentationIntegrationArguments(["--target", "ssh-fixture", "--grep", "pending"]), {
    target: "ssh-fixture",
    grep: "pending",
  });
  for (const args of [[], ["--target"], ["--target", "other"], ["--unknown", "x"], ["--target", "local", "--target", "local"]]) {
    assert.throws(() => parseDocumentationIntegrationArguments(args), /target|unknown|once/i);
  }
});

test("driver declares the complete shared local and SSH scenario matrix", async () => {
  const { TEXT_DOCUMENT_SCENARIOS } = await import("../integration/documentation/fixtures.mjs");
  assert.deepEqual(TEXT_DOCUMENT_SCENARIOS, [
    "shared-buffer",
    "origin-ack-no-echo",
    "ime-and-multi-change-no-echo",
    "equal-text-external-race",
    "dirty-save-autosave-revert",
    "close-hot-exit-restart",
    "undo-redo-unit",
    "external-clean-and-dirty",
    "stale-version-race",
    "bounded-large-edit-state",
    "reload-reassociate-host-restart-snapshot",
    "disconnect-reconnect-pending",
    "nonce-bound-codemirror-styles",
    "activation-failure-isolation",
  ]);
  const runner = await readFile(join(repositoryRoot, "products/workbench/integration/documentation/driver/run.cjs"), "utf8");
  assert.match(runner, /forbidPending|failZeroTests|forbidOnly/);
  assert.doesNotMatch(runner, /@vscode\/test-electron|download/i);
});

test("fixture keeps the macOS user-data socket path within the Unix-domain limit", async () => {
  const { createTemporaryDocumentationWorkspace } = await import("../integration/documentation/fixtures.mjs");
  const checkout = await createCheckoutFixture();
  const fixture = await createTemporaryDocumentationWorkspace({
    root: repositoryRoot,
    checkout,
    target: "local",
  });
  temporaryDirectories.push(fixture.fixtureRoot);
  // Code-OSS appends per-process .sock names under user-data; a representative
  // socket path must stay below the macOS ~104-byte Unix-domain limit.
  const socketPath = join(fixture.userDataDir, "1.13-main.sock");
  assert.ok(Buffer.byteLength(socketPath) < 104, `${socketPath} is too long`);
});
