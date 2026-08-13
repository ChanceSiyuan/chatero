#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyCodeOss } from "../../scripts/verify-code-oss.mjs";
import { assertDocumentationPayload } from "../documentation-payload.mjs";

const CODE_OSS_COMMIT = "df53daabb18cd157bdb08c7f01c34df936cf12f4";
const REQUIRED_NODE_VERSION = "24.18.0";
const CODEX_SDK_VERSION = "0.142.0";
const ARCHITECTURES = Object.freeze({
  x64: {
    tupleArch: "x86_64",
    targetArch: "x64",
    codexTarget: "linux-x64",
    codexNativePackage: "@openai/codex-linux-x64",
    codexNativeTriple: "x86_64-unknown-linux-musl",
    elfMachine: 62,
  },
  arm64: {
    tupleArch: "aarch64",
    targetArch: "arm64",
    codexTarget: "linux-arm64",
    codexNativePackage: "@openai/codex-linux-arm64",
    codexNativeTriple: "aarch64-unknown-linux-musl",
    elfMachine: 183,
  },
});
const DEFAULT_CHECKOUT = fileURLToPath(new URL("../../../../vendor/code-oss/", import.meta.url));
const DEFAULT_DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const BRIDGE_PATH = new URL("../runtime/chatero-process-bridge.mjs", import.meta.url);
const EVIDENCE_HELPER_PATH = new URL("../runtime/chatero-evidence-cache.mjs", import.meta.url);
const INTEGRITY_VERIFIER_PATH = new URL("../runtime/chatero-install-integrity.mjs", import.meta.url);
const NOTICE_SOURCE_DIRECTORY = fileURLToPath(new URL("../licenses/", import.meta.url));
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const FIRST_PARTY_MANIFEST = fileURLToPath(new URL("../../first-party-extensions.json", import.meta.url));
const REQUIRED_EXTENSION_IDS = Object.freeze([
  "chatero-documentation", "chatero-remote", "chatero-zotero", "git", "ipynb",
  "notebook-renderers", "python", "latex", "javascript", "typescript-basics",
  "markdown-basics", "json", "yaml", "shellscript", "cpp", "java", "go", "rust",
]);

export const REMOTE_AGENT_NOTICE_FILES = Object.freeze([
  "LICENSE.txt",
  "ThirdPartyNotices.txt",
  "licenses/OpenAI-Codex-Apache-2.0.txt",
  "licenses/OpenAI-Codex-NOTICE.txt",
  "licenses/ripgrep-MIT.txt",
  "licenses/ripgrep-UNLICENSE.txt",
]);

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--arch", "--checkout", "--out"].includes(flag)) {
      throw new TypeError(`unknown argument ${flag ?? ""}`.trim());
    }
    if (!value || value.startsWith("--")) {
      throw new TypeError(`${flag} requires a value`);
    }
    options[flag] = value;
  }
  if (!options["--arch"]) {
    throw new TypeError("--arch is required (x64 or arm64)");
  }
  if (!Object.hasOwn(ARCHITECTURES, options["--arch"])) {
    throw new TypeError("--arch must equal x64 or arm64");
  }
  return options;
}

export function assertBuildNodeVersion(version = process.versions.node) {
  if (version !== REQUIRED_NODE_VERSION) {
    throw new Error(
      `Remote Agent builds require Node ${REQUIRED_NODE_VERSION}, received ${version}`
    );
  }
}

async function run(command, args, options = {}) {
  const { capture = false, ...spawnOptions } = options;
  const child = spawn(command, args, {
    ...spawnOptions,
    shell: false,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  const stdout = [];
  child.stdout?.on("data", chunk => stdout.push(chunk));
  const [code, signal] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`${command} exited with ${code ?? signal}`);
  }
  return Buffer.concat(stdout).toString("utf8").trim();
}

export async function assertVerifiedCheckout(checkout, { verify = verifyCodeOss } = {}) {
  const canonicalCheckout = resolve(checkout);
  const report = await verify({ destination: canonicalCheckout });
  if (!report?.ok) {
    throw new Error("Code-OSS provenance verification did not pass");
  }
  if (resolve(report.destination) !== canonicalCheckout) {
    throw new Error(
      `verified checkout destination ${report.destination} does not match ${canonicalCheckout}`
    );
  }
  if (report.commit !== CODE_OSS_COMMIT) {
    throw new Error(`verified Code-OSS commit must be ${CODE_OSS_COMMIT}`);
  }
  return report;
}

export function makeBuildPlan({ arch, checkout, output }) {
  if (!Object.hasOwn(ARCHITECTURES, arch)) {
    throw new TypeError("arch must equal x64 or arm64");
  }
  const architecture = ARCHITECTURES[arch];
  const rootName = `chatero-agent-linux-${architecture.tupleArch}`;
  return {
    target: `vscode-reh-linux-${architecture.targetArch}-min-ci`,
    upstreamRoot: resolve(checkout, "..", `vscode-reh-linux-${architecture.targetArch}`),
    rootName,
    output: resolve(output ?? join(DEFAULT_DIST, `${rootName}.tar.gz`)),
  };
}

export function makeCodeOssBuildInvocation({
  checkout,
  target,
  nodePath = process.execPath,
  environment = process.env,
}) {
  const canonicalCheckout = resolve(checkout);
  const cleanEnvironment = { ...environment };
  delete cleanEnvironment.AGENT_SDK_RESULTS_FILE;
  return {
    command: nodePath,
    args: [
      "--experimental-strip-types",
      "--max-old-space-size=8192",
      join(canonicalCheckout, "node_modules", "gulp", "bin", "gulp.js"),
      target,
    ],
    cwd: canonicalCheckout,
    env: {
      ...cleanEnvironment,
      VSCODE_PUBLISH: "false",
    },
  };
}

export function makeCodeOssCompileInvocation({
  checkout,
  nodePath = process.execPath,
  environment = process.env,
}) {
  return makeCodeOssBuildInvocation({
    checkout,
    target: "compile-build-without-mangling",
    nodePath,
    environment,
  });
}

export function makeCodeOssExtensionsInvocation({
  checkout,
  nodePath = process.execPath,
  environment = process.env,
}) {
  return makeCodeOssBuildInvocation({
    checkout,
    target: "compile-extensions-build",
    nodePath,
    environment,
  });
}

export function makeCodexSdkPlan({ arch, checkout, root }) {
  if (!Object.hasOwn(ARCHITECTURES, arch)) {
    throw new TypeError("arch must equal x64 or arm64");
  }
  const architecture = ARCHITECTURES[arch];
  const packageOutput = resolve(checkout, ".build", "agent-sdk", "chatero");
  return {
    version: CODEX_SDK_VERSION,
    target: architecture.codexTarget,
    nativePackage: architecture.codexNativePackage,
    nativeTriple: architecture.codexNativeTriple,
    packageScript: resolve(checkout, "build", "agent-sdk", "package.ts"),
    tarball: join(packageOutput, `codex-${CODEX_SDK_VERSION}-${architecture.codexTarget}.tgz`),
    destination: resolve(root, "agent-sdk", "codex"),
  };
}

async function assertRegularFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a regular file`);
  }
  return metadata;
}

async function assertSafeFileDestination(path, label) {
  try {
    await assertRegularFile(path, label);
  }
  catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function ensureSafeOutputDirectory(root, directory, label) {
  const canonicalRoot = resolve(root);
  const relativePath = directory.slice(canonicalRoot.length + 1);
  if (resolve(directory) !== directory
    || !directory.startsWith(`${canonicalRoot}/`)
    || !relativePath
    || relativePath.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`${label} escapes the verified checkout`);
  }
  const rootMetadata = await lstat(canonicalRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
    || await realpath(canonicalRoot) !== canonicalRoot) {
    throw new Error("verified checkout root must be a real directory");
  }
  let current = canonicalRoot;
  for (const part of relativePath.split("/")) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || await realpath(current) !== current) {
        throw new Error(`${label} ancestors must be real directories`);
      }
    }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current);
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || await realpath(current) !== current) {
        throw new Error(`${label} ancestors must be real directories`);
      }
    }
  }
}

async function readElfMachine(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length
      || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error(`${path} is not an ELF executable`);
    }
    if (header[5] !== 1) {
      throw new Error(`${path} is not a little-endian ELF executable`);
    }
    return header.readUInt16LE(18);
  }
  finally {
    await handle.close();
  }
}

async function buildCodexSdk(plan) {
  const checkout = dirname(dirname(dirname(plan.packageScript)));
  await ensureSafeOutputDirectory(checkout, dirname(plan.tarball), "Codex SDK output");
  await assertSafeFileDestination(plan.tarball, "Codex SDK tarball destination");
  await run(process.execPath, [
    "--experimental-strip-types",
    plan.packageScript,
    "--sdk=codex",
    `--target=${plan.target}`,
    `--out=${dirname(plan.tarball)}`,
  ], {
    cwd: checkout,
    env: { ...process.env, VSCODE_PUBLISH: "false" },
  });
  await assertRegularFile(plan.tarball, "Codex SDK tarball");
}

async function installCodexSdk(plan, arch) {
  await mkdir(plan.destination, { recursive: true });
  await run("tar", ["-xzf", plan.tarball, "-C", plan.destination]);

  const openAiRoot = join(plan.destination, "node_modules", "@openai");
  const nativeDirectoryName = plan.nativePackage.slice("@openai/".length);
  const nativeRoot = join(openAiRoot, nativeDirectoryName);
  const basePackage = JSON.parse(await readFile(
    join(openAiRoot, "codex", "package.json"),
    "utf8"
  ));
  const nativePackage = JSON.parse(await readFile(join(nativeRoot, "package.json"), "utf8"));
  if (basePackage.version !== CODEX_SDK_VERSION
    || nativePackage.version !== `${CODEX_SDK_VERSION}-${plan.target}`) {
    throw new Error(`Codex SDK must equal ${CODEX_SDK_VERSION} for ${plan.target}`);
  }

  const installedNativePackages = (await readdir(openAiRoot))
    .filter(name => name.startsWith("codex-") && name !== "codex");
  if (installedNativePackages.length !== 1
    || installedNativePackages[0] !== nativeDirectoryName) {
    throw new Error(
      `Codex SDK for ${arch} contains wrong native packages: ${installedNativePackages.join(", ")}`
    );
  }

  const vendorRoot = join(nativeRoot, "vendor", plan.nativeTriple);
  const codexBinary = join(vendorRoot, "bin", "codex");
  const ripgrepBinary = join(vendorRoot, "codex-path", "rg");
  await chmod(codexBinary, 0o755);
  await chmod(ripgrepBinary, 0o755);
  for (const [label, path] of [["Codex", codexBinary], ["ripgrep", ripgrepBinary]]) {
    const metadata = await assertRegularFile(path, `${label} executable`);
    if ((metadata.mode & 0o111) === 0) {
      throw new Error(`${label} executable is not executable`);
    }
    const machine = await readElfMachine(path);
    if (machine !== ARCHITECTURES[arch].elfMachine) {
      throw new Error(`${label} ELF architecture does not match ${arch}`);
    }
  }

  if (process.arch === arch) {
    const version = await run(codexBinary, ["--version"], { capture: true });
    if (!new RegExp(`\\b${CODEX_SDK_VERSION.replaceAll(".", "\\.")}\\b`).test(version)) {
      throw new Error(`Codex reported an unexpected version: ${version}`);
    }
  }
}

async function installNotices(checkout, root) {
  const licenses = join(root, "licenses");
  await mkdir(licenses, { recursive: true });
  for (const [source, destination] of [
    [join(checkout, "LICENSE.txt"), join(root, "LICENSE.txt")],
    [join(checkout, "ThirdPartyNotices.txt"), join(root, "ThirdPartyNotices.txt")],
    [join(NOTICE_SOURCE_DIRECTORY, "OpenAI-Codex-Apache-2.0.txt"), join(licenses, "OpenAI-Codex-Apache-2.0.txt")],
    [join(NOTICE_SOURCE_DIRECTORY, "OpenAI-Codex-NOTICE.txt"), join(licenses, "OpenAI-Codex-NOTICE.txt")],
    [join(NOTICE_SOURCE_DIRECTORY, "ripgrep-MIT.txt"), join(licenses, "ripgrep-MIT.txt")],
    [join(NOTICE_SOURCE_DIRECTORY, "ripgrep-UNLICENSE.txt"), join(licenses, "ripgrep-UNLICENSE.txt")],
  ]) {
    await assertRegularFile(source, `notice source ${source}`);
    await assertSafeFileDestination(destination, `notice destination ${destination}`);
    await copyFile(source, destination);
    await assertRegularFile(destination, `notice destination ${destination}`);
  }
}

async function installDocumentationPayload(root) {
  const manifest = JSON.parse(await readFile(FIRST_PARTY_MANIFEST, "utf8"));
  const extension = manifest?.extensions?.find(value => value?.id === "chatero.documentation");
  if (!extension || !Array.isArray(extension.files) || extension.files.length === 0) {
    throw new Error("first-party Documentation payload declaration is missing");
  }
  for (const record of extension.files) {
    if (!record || typeof record.source !== "string" || typeof record.destination !== "string"
        || !record.destination.startsWith("extensions/chatero-documentation/")
        || record.source.includes("\\") || record.destination.includes("\\")
        || [record.source, record.destination].some(value => value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === ".."))) {
      throw new Error("first-party Documentation payload declaration is unsafe");
    }
    const source = resolve(REPOSITORY_ROOT, record.source);
    if (!source.startsWith(`${REPOSITORY_ROOT}/`)) throw new Error("Documentation payload source escapes the repository");
    await assertRegularFile(source, `Documentation payload source ${record.source}`);
    const destination = resolve(root, record.destination);
    if (!destination.startsWith(`${resolve(root)}/`)) throw new Error("Documentation payload destination escapes the agent root");
    await mkdir(dirname(destination), { recursive: true });
    await assertSafeFileDestination(destination, `Documentation payload destination ${record.destination}`);
    await copyFile(source, destination);
    await assertRegularFile(destination, `Documentation payload destination ${record.destination}`);
  }
}

async function assertRequiredExtensionPayload(root) {
  for (const id of REQUIRED_EXTENSION_IDS) {
    const manifest = join(root, "extensions", id, "package.json");
    await assertRegularFile(manifest, `required Remote Agent extension ${id}`);
  }
}

async function packDeterministically(source, root, destination) {
  await run("tar", [
    "--sort=name",
    "--format=posix",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--pax-option=delete=atime,delete=ctime",
    "-czf", destination,
    "-C", source,
    root,
  ], {
    env: { ...process.env, GZIP: "-n" },
  });
}

async function main() {
  if (process.platform !== "linux") {
    throw new Error("Remote Agent packaging only runs on Linux");
  }
  const options = parseArguments(process.argv.slice(2));
  assertBuildNodeVersion();
  const checkout = resolve(options["--checkout"] ?? DEFAULT_CHECKOUT);
  if (!(await stat(checkout)).isDirectory()) {
    throw new Error(`${checkout} must be the pinned Code-OSS checkout`);
  }
  await assertVerifiedCheckout(checkout);

  const plan = makeBuildPlan({
    arch: options["--arch"],
    checkout,
    output: options["--out"],
  });
  const sdkPlan = makeCodexSdkPlan({
    arch: options["--arch"],
    checkout,
    root: join(dirname(plan.upstreamRoot), plan.rootName),
  });
  await buildCodexSdk(sdkPlan);
  const compileInvocation = makeCodeOssCompileInvocation({ checkout });
  await run(compileInvocation.command, compileInvocation.args, {
    cwd: compileInvocation.cwd,
    env: compileInvocation.env,
  });
  const extensionsInvocation = makeCodeOssExtensionsInvocation({ checkout });
  await run(extensionsInvocation.command, extensionsInvocation.args, {
    cwd: extensionsInvocation.cwd,
    env: extensionsInvocation.env,
  });
  const buildInvocation = makeCodeOssBuildInvocation({
    checkout,
    target: plan.target,
  });
  await run(buildInvocation.command, buildInvocation.args, {
    cwd: buildInvocation.cwd,
    env: buildInvocation.env,
  });

  if (!(await stat(plan.upstreamRoot)).isDirectory()) {
    throw new Error(`${plan.target} did not produce ${plan.upstreamRoot}`);
  }
  const cache = fileURLToPath(new URL("../.cache/", import.meta.url));
  await mkdir(cache, { recursive: true });
  const workDirectory = await mkdtemp(join(cache, `build-${options["--arch"]}-`));
  try {
    const root = join(workDirectory, plan.rootName);
    await rename(plan.upstreamRoot, root);
    const installedSdkPlan = makeCodexSdkPlan({
      arch: options["--arch"],
      checkout,
      root,
    });
    await installCodexSdk(installedSdkPlan, options["--arch"]);
    await installNotices(checkout, root);
    await installDocumentationPayload(root);
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const bridgeDestination = join(bin, "chatero-process-bridge.mjs");
    await copyFile(BRIDGE_PATH, bridgeDestination);
    await chmod(bridgeDestination, 0o755);
    const evidenceHelperDestination = join(bin, "chatero-evidence-cache.mjs");
    await copyFile(EVIDENCE_HELPER_PATH, evidenceHelperDestination);
    await chmod(evidenceHelperDestination, 0o755);
    const integrityVerifierDestination = join(bin, "chatero-install-integrity.mjs");
    await copyFile(INTEGRITY_VERIFIER_PATH, integrityVerifierDestination);
    await chmod(integrityVerifierDestination, 0o755);
    await assertDocumentationPayload(root);
    await assertRequiredExtensionPayload(root);

    await mkdir(dirname(plan.output), { recursive: true });
    await packDeterministically(workDirectory, plan.rootName, plan.output);
    process.stdout.write(`${plan.output}\n`);
  }
  finally {
    await rm(workDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
