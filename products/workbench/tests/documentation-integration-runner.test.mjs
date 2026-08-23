import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  parseDocumentationIntegrationArguments,
  removeDocumentationRemoteWorkspace,
  runDocumentationIntegration,
  spawnDocumentationIntegrationProcess,
  stageDocumentationRemoteWorkspace,
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

test("remote integration activates the workspace extension across the host boundary", async () => {
  const driverManifest = JSON.parse(await readFile(join(
    repositoryRoot,
    "products",
    "workbench",
    "integration",
    "documentation",
    "driver",
    "package.json",
  ), "utf8"));
  const source = await readFile(join(
    repositoryRoot,
    "products",
    "workbench",
    "integration",
    "documentation",
    "text-document-editor.test.mjs",
  ), "utf8");
  assert.deepEqual(driverManifest.extensionKind, ["ui"]);
  assert.match(source, /vscode\.env\.remoteName === "chatero-remote"/);
  assert.match(source, /REMOTE_ACTIVATION_TIMEOUT_MS = 30_000/);
  assert.match(source, /executeCommand\("chatero\.documentation\.refresh"\)/);
  assert.match(source, /remote workspace extensions are not visible from the UI Extension Host/);
  assert.match(source, /join\(repositoryRoot, "products", "workbench", "extensions", "chatero-documentation"\)/);
  assert.doesNotMatch(source, /vscode\.extensions\.onDidChange/);
});

test("rejects extension proposal failures reported during startup", async () => {
  const checkout = await createCheckoutFixture();
  await assert.rejects(runDocumentationIntegration({
    root: repositoryRoot,
    checkout,
    target: "local",
    platform: "darwin",
    verify: async () => ({ ok: true }),
    run: async () => ({
      stdout: "Extension 'vscode.example' appears in product.json but enables LESS API proposals than the extension wants. EXTENSION WILL BE BROKEN",
      stderr: "",
    }),
  }), /extension startup audit/i);
});

test("rejects duplicate Codex startup and disabled provider registration from agent-host logs", async () => {
  const checkout = await createCheckoutFixture();
  await assert.rejects(runDocumentationIntegration({
    root: repositoryRoot,
    checkout,
    target: "local",
    platform: "darwin",
    verify: async () => ({ ok: true }),
    run: async call => {
      const userDataArgument = call.args.find(value => value.startsWith("--user-data-dir="));
      const userDataDir = userDataArgument.slice("--user-data-dir=".length);
      const logs = join(userDataDir, "logs", "fixture");
      await mkdir(logs, { recursive: true });
      await writeFile(join(logs, "agenthost.log"), [
        "Registering agent provider: claude",
        "[Codex] spawning usageSource=openai",
        "[Codex] spawning usageSource=openai",
      ].join("\n"));
      return { stdout: "", stderr: "" };
    },
  }), /agent host startup audit/i);
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
    "upstream-agent-extension-absent",
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

test("SSH fixture binds the remote workspace to an explicit real OpenSSH alias", async () => {
  const { createTemporaryDocumentationWorkspace } = await import("../integration/documentation/fixtures.mjs");
  const checkout = await createCheckoutFixture();
  const fixture = await createTemporaryDocumentationWorkspace({
    root: repositoryRoot,
    checkout,
    target: "ssh-fixture",
    sshAlias: "stage5-target",
  });
  temporaryDirectories.push(fixture.fixtureRoot);
  const workspace = new URL(fixture.workspaceUri);
  assert.equal(workspace.protocol, "vscode-remote:");
  assert.equal(workspace.hostname, "chatero-remote+cHJvZmlsZTpzdGFnZTUtdGFyZ2V0");
  assert.equal(Buffer.from(workspace.hostname.slice("chatero-remote+".length), "base64url").toString("utf8"), "profile:stage5-target");
  assert.match(fixture.remoteFixtureRoot, /^\/tmp\/chatero-remote-doc-[A-Za-z0-9]+$/u);
  assert.equal(fixture.workspacePath, join(fixture.remoteFixtureRoot, "workspace"));
  assert.notEqual(fixture.workspacePath, fixture.localWorkspacePath);
  assert.match(
    await readFile(join(fixture.localWorkspacePath, "documentation", "index.qmd"), "utf8"),
    /# Documentation integration fixture/u,
  );
});

test("SSH fixture stages and removes only its isolated remote workspace through OpenSSH", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "chatero-documentation-remote-stage-"));
  temporaryDirectories.push(fixtureRoot);
  const fixture = {
    homeDir: join(fixtureRoot, "home"),
    localWorkspacePath: join(fixtureRoot, "workspace"),
    remoteFixtureRoot: "/tmp/chatero-remote-doc-Ab12Cd",
    workspacePath: "/tmp/chatero-remote-doc-Ab12Cd/workspace",
  };
  await mkdir(join(fixture.homeDir, ".ssh"), { recursive: true });
  await mkdir(fixture.localWorkspacePath, { recursive: true });
  await writeFile(join(fixture.homeDir, ".ssh", "config"), "Host stage5-target\n");
  await writeFile(join(fixture.homeDir, ".ssh", "known_hosts"), "fixture ssh-ed25519 AAAA\n");
  const calls = [];
  const execute = async call => calls.push(call);
  await stageDocumentationRemoteWorkspace({ alias: "stage5-target", fixture, execute });
  await removeDocumentationRemoteWorkspace({ alias: "stage5-target", fixture, execute });
  assert.deepEqual(calls.map(call => call.file), ["ssh", "ssh", "scp", "ssh", "ssh"]);
  assert.ok(calls.every(call => call.args.includes("BatchMode=yes")));
  assert.ok(calls.every(call => call.env.HOME === fixture.homeDir));
  assert.deepEqual(calls[0].args.slice(-6), [
    "stage5-target", "mkdir", "-m", "700", "--", fixture.remoteFixtureRoot,
  ]);
  assert.deepEqual(calls[1].args.slice(-6), [
    "stage5-target", "mkdir", "-m", "700", "--", fixture.workspacePath,
  ]);
  assert.deepEqual(calls[2].args.slice(-2), [
    `${fixture.localWorkspacePath}/.`,
    `stage5-target:${fixture.workspacePath}/`,
  ]);
  assert.deepEqual(calls[3].args.slice(-4), [
    "stage5-target", "test", "-f", `${fixture.workspacePath}/documentation/index.qmd`,
  ]);
  assert.deepEqual(calls[4].args.slice(-5), [
    "stage5-target", "rm", "-rf", "--", fixture.remoteFixtureRoot,
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /StrictHostKeyChecking=no|sh\s+-c/u);
  await assert.rejects(removeDocumentationRemoteWorkspace({
    alias: "stage5-target",
    fixture: { ...fixture, remoteFixtureRoot: "/home/chance" },
    execute,
  }), /unsafe remote Documentation fixture/u);
});

test("integration child has a hard deadline and cannot wait forever in authority resolution", async () => {
  await assert.rejects(spawnDocumentationIntegrationProcess({
    file: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: repositoryRoot,
    env: process.env,
    timeoutMs: 25,
    killGraceMs: 25,
  }), /timed out/i);
});

test("integration deadline terminates the complete spawned process group", async () => {
  if (process.platform === "win32") return;
  const started = Date.now();
  await assert.rejects(spawnDocumentationIntegrationProcess({
    file: process.execPath,
    args: [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "spawn(process.execPath, ['-e', 'process.on(\\\"SIGTERM\\\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join(" "),
    ],
    cwd: repositoryRoot,
    env: process.env,
    timeoutMs: 50,
    killGraceMs: 50,
  }), /timed out/i);
  assert.ok(Date.now() - started < 2_000);
});

test("SSH integration home receives only public OpenSSH routing material", async () => {
  const { prepareDocumentationSshHome } = await import("../integration/documentation/fixtures.mjs");
  const sourceHome = await mkdtemp(join(tmpdir(), "chatero-documentation-ssh-source-"));
  const fixtureHome = await mkdtemp(join(tmpdir(), "chatero-documentation-ssh-home-"));
  temporaryDirectories.push(sourceHome, fixtureHome);
  await mkdir(join(sourceHome, ".ssh"), { mode: 0o700 });
  await writeFile(join(sourceHome, ".ssh", "config"), "Host stage5-target\n  IdentityFile /runner/.ssh/stage5_ed25519\n", { mode: 0o600 });
  await writeFile(join(sourceHome, ".ssh", "known_hosts"), "fixture ssh-ed25519 AAAA\n", { mode: 0o600 });
  await writeFile(join(sourceHome, ".ssh", "stage5_ed25519"), "PRIVATE", { mode: 0o600 });
  await prepareDocumentationSshHome({ sourceHome, fixtureHome });
  assert.equal(await readFile(join(fixtureHome, ".ssh", "config"), "utf8"), "Host stage5-target\n  IdentityFile /runner/.ssh/stage5_ed25519\n");
  assert.equal(await readFile(join(fixtureHome, ".ssh", "known_hosts"), "utf8"), "fixture ssh-ed25519 AAAA\n");
  await assert.rejects(readFile(join(fixtureHome, ".ssh", "stage5_ed25519")), /ENOENT/u);
});
