#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createTemporaryDocumentationWorkspace } from "../integration/documentation/fixtures.mjs";
import { verifyRelease } from "../remote-agent/release-contract.mjs";
import { verifyCodeOss } from "./verify-code-oss.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIRECTORY, "..", "..", "..");
const TARGETS = new Set(["local", "ssh-fixture"]);
const MAX_GREP_UTF8 = 256;
const MAX_STARTUP_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_AGENT_HOST_LOG_BYTES = 4 * 1024 * 1024;

async function safeRegularFile(path, label) {
  const metadata = await lstat(path).catch(error => {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${path}`);
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} is not a safe regular file: ${path}`);
  return path;
}

async function verifySignedRemoteAgentFixture({ root, releaseDirectory }) {
  if (!releaseDirectory) throw new Error("signed Remote Agent fixture directory is required for ssh-fixture");
  const canonical = await realpath(resolve(releaseDirectory)).catch(error => {
    if (error?.code === "ENOENT") throw new Error(`signed Remote Agent fixture manifest.json is missing under ${releaseDirectory}`);
    throw error;
  });
  const manifestPath = await safeRegularFile(join(canonical, "manifest.json"), "signed Remote Agent manifest.json");
  const signaturePath = await safeRegularFile(join(canonical, "manifest.sig"), "signed Remote Agent manifest.sig");
  const publicKeyPath = await safeRegularFile(
    join(root, "products", "workbench", "remote-agent", "release-public-key.pem"),
    "Remote Agent public key",
  );
  return verifyRelease({
    manifestText: await readFile(manifestPath, "utf8"),
    signature: await readFile(signaturePath),
    publicKey: await readFile(publicKeyPath),
    readArtifact: async filename => createReadStream(await safeRegularFile(join(canonical, filename), `signed Remote Agent artifact ${filename}`)),
  });
}

function environmentFor(fixture, target, root, grep) {
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: fixture.homeDir,
    LANG: process.env.LANG ?? "C.UTF-8",
    CHATERO_DOCUMENTATION_TEST_TARGET: target,
    CHATERO_DOCUMENTATION_WORKSPACE_PATH: fixture.workspacePath,
    CHATERO_REPOSITORY_ROOT: root,
  };
  for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  if (grep) environment.CHATERO_DOCUMENTATION_TEST_GREP = grep;
  if (fixture.remoteAgentReleaseDir) environment.CHATERO_REMOTE_AGENT_RELEASE_DIR = fixture.remoteAgentReleaseDir;
  return Object.freeze(environment);
}

async function spawnAndWait({ file, args, cwd, env }) {
  return new Promise((accept, reject) => {
    const child = spawn(file, args, { cwd, env, shell: false, stdio: ["inherit", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const relay = (stream, destination, append) => {
      stream.on("data", chunk => {
        destination.write(chunk);
        append(chunk);
      });
    };
    relay(child.stdout, process.stdout, chunk => {
      if (Buffer.byteLength(stdout) < MAX_STARTUP_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    relay(child.stderr, process.stderr, chunk => {
      if (Buffer.byteLength(stderr) < MAX_STARTUP_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    const forwardSignal = signal => {
      if (!child.killed) child.kill(signal);
    };
    const onInterrupt = () => forwardSignal("SIGINT");
    const onTerminate = () => forwardSignal("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    const cleanup = () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0) accept(Object.freeze({ stdout, stderr }));
      else reject(new Error(`Documentation integration process exited with ${signal ?? code}`));
    });
  });
}

async function readAgentHostLogs(root) {
  const chunks = [];
  let totalBytes = 0;
  async function visit(path) {
    const metadata = await lstat(path).catch(error => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (!metadata || metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
      return;
    }
    if (!metadata.isFile() || basename(path) !== "agenthost.log") return;
    if (metadata.size > MAX_AGENT_HOST_LOG_BYTES || totalBytes + metadata.size > MAX_AGENT_HOST_LOG_BYTES) {
      throw new Error("agent host startup audit exceeded its bounded log budget");
    }
    chunks.push(await readFile(path, "utf8"));
    totalBytes += metadata.size;
  }
  await visit(root);
  return chunks.join("\n");
}

function auditStartup({ processResult, agentHostLogs }) {
  const processOutput = typeof processResult === "object" && processResult
    ? `${processResult.stdout ?? ""}\n${processResult.stderr ?? ""}`
    : "";
  if (/CANNOT use .*API proposal|enables LESS API proposals|EXTENSION WILL BE BROKEN/iu.test(processOutput)) {
    throw new Error("extension startup audit found an API-proposal or activation failure");
  }
  const disabledProvider = agentHostLogs.match(/Registering agent provider: (?:claude|copilot)|usageSource=copilot|https:\/\/api\.github\.com/iu)?.[0];
  if (disabledProvider) {
    throw new Error(`agent host startup audit found a disabled provider or GitHub network authority: ${disabledProvider}`);
  }
  const codexSpawns = agentHostLogs.match(/\[Codex\] spawning usageSource=openai/gu) ?? [];
  if (codexSpawns.length > 1) {
    throw new Error(`agent host startup audit found ${codexSpawns.length} Codex app-server spawns`);
  }
}

function validateGrep(grep) {
  if (grep === undefined) return undefined;
  if (typeof grep !== "string" || grep.length === 0
    || new TextEncoder().encode(grep).byteLength > MAX_GREP_UTF8
    || /[\u0000-\u001F\u007F]/u.test(grep)) {
    throw new TypeError("Documentation integration grep must be 1-256 safe UTF-8 bytes");
  }
  return grep;
}

export async function runDocumentationIntegration({
  root = DEFAULT_ROOT,
  checkout = process.env.CHATERO_CODE_OSS_DIR || join(root, "vendor", "code-oss"),
  target,
  grep,
  remoteAgentReleaseDir = process.env.CHATERO_REMOTE_AGENT_RELEASE_DIR,
  platform = process.platform,
  run = spawnAndWait,
  verify = verifyCodeOss,
} = {}) {
  if (!TARGETS.has(target)) throw new TypeError("invalid Documentation integration target");
  const boundedGrep = validateGrep(grep);
  const canonicalCheckout = resolve(checkout);
  const verification = await verify({ root, destination: canonicalCheckout });
  if (!verification?.ok) throw new Error("pinned Code-OSS verification did not pass");
  await safeRegularFile(join(canonicalCheckout, "out", "main.js"), "compiled pinned Code-OSS entry");
  await safeRegularFile(join(canonicalCheckout, "scripts", "code.sh"), "pinned Code-OSS launch script");
  if (target === "ssh-fixture") {
    await verifySignedRemoteAgentFixture({ root, releaseDirectory: remoteAgentReleaseDir });
  }
  if (platform !== "linux" && platform !== "darwin") throw new Error("Documentation integration supports Linux and macOS only");

  const fixture = await createTemporaryDocumentationWorkspace({
    root,
    checkout: canonicalCheckout,
    target,
    remoteAgentReleaseDir,
  });
  try {
    const codeArguments = [
      `--user-data-dir=${fixture.userDataDir}`,
      `--extensions-dir=${fixture.extensionsDir}`,
      `--extensionDevelopmentPath=${fixture.driverExtensionPath}`,
      `--extensionTestsPath=${fixture.testRunnerPath}`,
      "--disable-workspace-trust",
      "--disable-updates",
      "--skip-welcome",
      `--folder-uri=${fixture.workspaceUri}`,
    ];
    const invocation = platform === "linux"
      ? { file: "xvfb-run", args: ["-a", fixture.codeScript, ...codeArguments] }
      : { file: "bash", args: [fixture.codeScript, ...codeArguments] };
    const processResult = await run({
      ...invocation,
      cwd: canonicalCheckout,
      env: environmentFor(fixture, target, root, boundedGrep),
    });
    auditStartup({
      processResult,
      agentHostLogs: await readAgentHostLogs(fixture.userDataDir),
    });
    return Object.freeze({ target, workspace: "<temporary-documentation-workspace>" });
  }
  finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

export function parseDocumentationIntegrationArguments(args) {
  if (!Array.isArray(args)) throw new TypeError("Documentation integration arguments must be an array");
  let target;
  let grep;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${flag ?? "argument"} requires a value`);
    if (flag === "--target") {
      if (target !== undefined) throw new TypeError("--target may be specified only once");
      if (!TARGETS.has(value)) throw new TypeError("invalid Documentation integration target");
      target = value;
    }
    else if (flag === "--grep") {
      if (grep !== undefined) throw new TypeError("--grep may be specified only once");
      grep = validateGrep(value);
    }
    else throw new TypeError(`unknown Documentation integration argument ${flag}`);
  }
  if (!target) throw new TypeError("--target is required");
  return Object.freeze({ target, grep });
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  runDocumentationIntegration(parseDocumentationIntegrationArguments(process.argv.slice(2)))
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => {
      process.stderr.write(`Documentation integration failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
