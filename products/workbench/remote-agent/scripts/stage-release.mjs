#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { once } from "node:events";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import {
  REMOTE_AGENT_TUPLES,
  canonicalManifestBytes,
} from "../release-contract.mjs";
import { REMOTE_AGENT_NOTICE_FILES } from "./build-linux-agent.mjs";

const RELEASE_VERSION = "1.132.0";
const CODE_OSS_COMMIT = "df53daabb18cd157bdb08c7f01c34df936cf12f4";
const BRIDGE_PATH = new URL("../runtime/chatero-process-bridge.mjs", import.meta.url);
const EVIDENCE_HELPER_PATH = new URL("../runtime/chatero-evidence-cache.mjs", import.meta.url);
const CODEX_SDK_VERSION = "0.142.0";
const ARCHIVE_ARCHITECTURES = Object.freeze({
  "linux-x86_64": {
    machine: 62,
    nativePackage: "codex-linux-x64",
    nativeVersion: `${CODEX_SDK_VERSION}-linux-x64`,
    nativeTriple: "x86_64-unknown-linux-musl",
  },
  "linux-aarch64": {
    machine: 183,
    nativePackage: "codex-linux-arm64",
    nativeVersion: `${CODEX_SDK_VERSION}-linux-arm64`,
    nativeTriple: "aarch64-unknown-linux-musl",
  },
});

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--x64", "--arm64", "--private-key", "--out"].includes(flag)) {
      throw new TypeError(`unknown argument ${flag ?? ""}`.trim());
    }
    if (!value || value.startsWith("--")) {
      throw new TypeError(`${flag} requires a value`);
    }
    if (Object.hasOwn(options, flag)) {
      throw new TypeError(`${flag} may be provided only once`);
    }
    options[flag] = value;
  }
  for (const flag of ["--x64", "--arm64", "--private-key", "--out"]) {
    if (!options[flag]) {
      throw new TypeError(`${flag} is required`);
    }
  }
  return options;
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));
  const [code, signal] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`${command} exited with ${code ?? signal}: ${Buffer.concat(stderr).toString("utf8").trim()}`);
  }
  return Buffer.concat(stdout);
}

function validateArchiveListing(text, expectedRoot) {
  const entries = text.split("\n").filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`archive for ${expectedRoot} is empty`);
  }
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/, "");
    if (isAbsolute(normalized)
      || normalized.split("/").includes("..")
      || normalized.split("/")[0] !== expectedRoot) {
      throw new Error(`archive entry escapes expected root ${expectedRoot}: ${entry}`);
    }
  }
}

async function packDeterministically(source, root, destination) {
  const common = ["-czf", destination, "-C", source, root];
  const args = process.platform === "linux"
    ? [
      "--sort=name",
      "--format=posix",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--pax-option=delete=atime,delete=ctime",
      ...common,
    ]
    : [
      "--format=pax",
      "--uid", "0",
      "--gid", "0",
      "--uname", "root",
      "--gname", "root",
      ...common,
    ];
  await run("tar", args, {
    env: { ...process.env, COPYFILE_DISABLE: "1", GZIP: "-n" },
  });
}

async function hashFile(path) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.byteLength;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), size };
}

async function assertPayloadDirectory(root, relativePath, label) {
  const canonicalRoot = resolve(root);
  if (await realpath(canonicalRoot) !== canonicalRoot) {
    throw new Error("payload root must be a real directory");
  }
  const parts = relativePath.split("/");
  if (!relativePath || parts.some(part => !part || part === "." || part === "..")) {
    throw new Error(`${label} has an invalid payload path`);
  }
  let current = canonicalRoot;
  for (const part of parts) {
    current = join(current, part);
    let metadata;
    try {
      metadata = await lstat(current);
    }
    catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`${label} ancestors must be real directories`);
      }
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || await realpath(current) !== current) {
      throw new Error(`${label} ancestors must be real directories`);
    }
  }
  return current;
}

async function assertRegularPayloadFile(root, relativePath, label, { executable = false } = {}) {
  const separator = relativePath.lastIndexOf("/");
  const parent = separator === -1 ? root : await assertPayloadDirectory(
    root,
    relativePath.slice(0, separator),
    label,
  );
  const path = join(parent, relativePath.slice(separator + 1));
  let metadata;
  try {
    metadata = await lstat(path);
  }
  catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} must be a regular file`);
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || await realpath(path) !== path) {
    throw new Error(`${label} must be a regular file`);
  }
  if (metadata.size === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (executable && (metadata.mode & 0o111) === 0) {
    throw new Error(`${label} must be executable`);
  }
  return path;
}

async function assertExactPayloadEntries(root, relativePath, expectedEntries, label) {
  const directory = await assertPayloadDirectory(root, relativePath, label);
  const actual = (await readdir(directory)).sort();
  const expected = [...expectedEntries].sort();
  if (actual.length !== expected.length
    || actual.some((entry, index) => entry !== expected[index])) {
    throw new Error(`${label} must contain exactly ${expected.join(", ")}`);
  }
  return directory;
}

async function readElfMachine(path, label) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length
      || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || header[5] !== 1) {
      throw new Error(`${label} must be a little-endian ELF executable`);
    }
    return header.readUInt16LE(18);
  }
  finally {
    await handle.close();
  }
}

async function assertAgentPayload(root, tuple) {
  const architecture = ARCHIVE_ARCHITECTURES[tuple];
  if (!architecture) {
    throw new Error(`unsupported Remote Agent tuple ${tuple}`);
  }
  try {
    await lstat(join(root, ".chatero-release-sha256"));
    throw new Error("Remote Agent input must not provide the install release marker");
  }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await assertRegularPayloadFile(root, "bin/chatero-server", "chatero-server", {
    executable: true,
  });
  await assertRegularPayloadFile(
    root,
    "bin/chatero-evidence-cache.mjs",
    "chatero-evidence-cache.mjs",
    { executable: true },
  );
  for (const relativePath of REMOTE_AGENT_NOTICE_FILES) {
    await assertRegularPayloadFile(root, relativePath, relativePath);
  }

  const productPath = await assertRegularPayloadFile(root, "product.json", "product.json");
  const product = JSON.parse(await readFile(productPath, "utf8"));
  if (!product || typeof product !== "object" || Array.isArray(product)
    || !Object.hasOwn(product, "agentSdks")
    || !product.agentSdks || typeof product.agentSdks !== "object"
    || Array.isArray(product.agentSdks)
    || Object.keys(product.agentSdks).length !== 0) {
    throw new Error("product.json agentSdks must be empty in a signed Remote Agent");
  }

  await assertExactPayloadEntries(root, "agent-sdk", ["codex"], "agent-sdk");
  await assertExactPayloadEntries(root, "agent-sdk/codex", ["node_modules"], "agent-sdk/codex");
  await assertExactPayloadEntries(
    root,
    "agent-sdk/codex/node_modules",
    [".bin", ".package-lock.json", "@openai"],
    "Codex node_modules",
  );
  await assertRegularPayloadFile(
    root,
    "agent-sdk/codex/node_modules/.package-lock.json",
    "Codex package lock",
  );
  const binDirectory = await assertExactPayloadEntries(
    root,
    "agent-sdk/codex/node_modules/.bin",
    ["codex"],
    "Codex .bin",
  );
  const codexLink = join(binDirectory, "codex");
  const codexLinkMetadata = await lstat(codexLink);
  const expectedCodexLink = "../@openai/codex/bin/codex.js";
  const expectedCodexTarget = join(root, "agent-sdk", "codex", "node_modules", "@openai", "codex", "bin", "codex.js");
  if (!codexLinkMetadata.isSymbolicLink()
    || await readlink(codexLink) !== expectedCodexLink
    || await realpath(codexLink) !== expectedCodexTarget) {
    throw new Error("Codex .bin/codex must be the fixed in-package symlink");
  }
  await assertRegularPayloadFile(
    root,
    "agent-sdk/codex/node_modules/@openai/codex/bin/codex.js",
    "Codex JavaScript launcher",
    { executable: true },
  );

  const openAiRelative = "agent-sdk/codex/node_modules/@openai";
  const openAiRoot = await assertPayloadDirectory(root, openAiRelative, "Codex SDK");
  await assertExactPayloadEntries(
    root,
    openAiRelative,
    ["codex", architecture.nativePackage],
    "@openai",
  );
  const basePackagePath = await assertRegularPayloadFile(
    root,
    `${openAiRelative}/codex/package.json`,
    "@openai/codex package.json",
  );
  const basePackage = JSON.parse(await readFile(basePackagePath, "utf8"));
  if (basePackage.version !== CODEX_SDK_VERSION) {
    throw new Error(`@openai/codex must equal ${CODEX_SDK_VERSION}`);
  }
  const nativePackages = (await readdir(openAiRoot))
    .filter(name => name.startsWith("codex-") && name !== "codex");
  if (nativePackages.length !== 1 || nativePackages[0] !== architecture.nativePackage) {
    throw new Error(`${tuple} contains wrong Codex native packages: ${nativePackages.join(", ")}`);
  }
  const nativePackagePath = await assertRegularPayloadFile(
    root,
    `${openAiRelative}/${architecture.nativePackage}/package.json`,
    `${architecture.nativePackage} package.json`,
  );
  const nativePackage = JSON.parse(await readFile(nativePackagePath, "utf8"));
  if (nativePackage.version !== architecture.nativeVersion) {
    throw new Error(`${architecture.nativePackage} must equal ${architecture.nativeVersion}`);
  }

  for (const [label, relativePath] of [
    ["Codex", `${openAiRelative}/${architecture.nativePackage}/vendor/${architecture.nativeTriple}/bin/codex`],
    ["ripgrep", `${openAiRelative}/${architecture.nativePackage}/vendor/${architecture.nativeTriple}/codex-path/rg`],
  ]) {
    const path = await assertRegularPayloadFile(root, relativePath, label, { executable: true });
    if (await readElfMachine(path, label) !== architecture.machine) {
      throw new Error(`${label} ELF architecture does not match ${tuple}`);
    }
  }
}

async function stageArchive({ archive, tuple, workDirectory }) {
  const expectedRoot = `chatero-agent-${tuple}`;
  const extractDirectory = join(workDirectory, `${tuple}-extract`);
  await mkdir(extractDirectory);
  const listing = await run("tar", ["-tzf", archive]);
  validateArchiveListing(listing.toString("utf8"), expectedRoot);
  await run("tar", ["-xzf", archive, "-C", extractDirectory]);

  const roots = await readdir(extractDirectory, { withFileTypes: true });
  if (roots.length !== 1 || roots[0].name !== expectedRoot || !roots[0].isDirectory()) {
    throw new Error(`archive must contain exactly one ${expectedRoot} root directory`);
  }
  const root = join(extractDirectory, expectedRoot);
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const binStat = await lstat(bin);
  if (!binStat.isDirectory() || binStat.isSymbolicLink()) {
    throw new Error(`${expectedRoot}/bin must be a directory`);
  }
  const rootPath = await realpath(root);
  const binPath = await realpath(bin);
  const binRelative = relative(rootPath, binPath);
  if (binRelative === "" || binRelative.startsWith("..") || isAbsolute(binRelative)) {
    throw new Error(`${expectedRoot}/bin escapes the extracted archive root`);
  }
  const bridgeDestination = join(bin, "chatero-process-bridge.mjs");
  try {
    const destinationStat = await lstat(bridgeDestination);
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
      throw new Error("bridge destination must be a regular file when it already exists");
    }
  }
  catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  const temporaryBridge = join(bin, `.chatero-process-bridge.${process.pid}.tmp`);
  try {
    await copyFile(BRIDGE_PATH, temporaryBridge, constants.COPYFILE_EXCL);
    await chmod(temporaryBridge, 0o755);
    await rename(temporaryBridge, bridgeDestination);
  }
  finally {
    await rm(temporaryBridge, { force: true });
  }
  const evidenceHelperDestination = join(bin, "chatero-evidence-cache.mjs");
  try {
    const destinationStat = await lstat(evidenceHelperDestination);
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink()
        || destinationStat.nlink !== 1) {
      throw new Error("evidence helper destination must be a regular file when it already exists");
    }
  }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporaryEvidenceHelper = join(bin, `.chatero-evidence-cache.${process.pid}.tmp`);
  try {
    await copyFile(EVIDENCE_HELPER_PATH, temporaryEvidenceHelper, constants.COPYFILE_EXCL);
    await chmod(temporaryEvidenceHelper, 0o755);
    await rename(temporaryEvidenceHelper, evidenceHelperDestination);
  }
  finally {
    await rm(temporaryEvidenceHelper, { force: true });
  }

  await assertAgentPayload(root, tuple);

  const filename = `${expectedRoot}.tar.gz`;
  const destination = join(workDirectory, filename);
  await packDeterministically(extractDirectory, expectedRoot, destination);
  return { filename, tuple, ...await hashFile(destination) };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const outputDirectory = resolve(options["--out"]);
  await mkdir(outputDirectory, { recursive: true });
  const workDirectory = await mkdtemp(join(outputDirectory, ".stage-"));
  try {
    const inputs = new Map([
      ["linux-x86_64", resolve(options["--x64"])],
      ["linux-aarch64", resolve(options["--arm64"])],
    ]);
    for (const [tuple, archive] of inputs) {
      if (!(await stat(archive)).isFile()) {
        throw new Error(`${archive} must be a regular archive file`);
      }
    }

    const privateKeyPath = resolve(options["--private-key"]);
    const privateKey = createPrivateKey(await readFile(privateKeyPath));
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new TypeError(`${basename(privateKeyPath)} must contain an Ed25519 private key`);
    }

    const artifacts = [];
    for (const tuple of REMOTE_AGENT_TUPLES) {
      artifacts.push(await stageArchive({
        archive: inputs.get(tuple),
        tuple,
        workDirectory,
      }));
    }
    const manifest = {
      schemaVersion: 1,
      product: "chatero",
      releaseVersion: RELEASE_VERSION,
      codeOssCommit: CODE_OSS_COMMIT,
      artifacts,
    };
    const manifestBytes = canonicalManifestBytes(manifest);
    await writeFile(join(workDirectory, "manifest.json"), manifestBytes);
    await writeFile(join(workDirectory, "manifest.sig"), sign(null, manifestBytes, privateKey));

    for (const filename of [
      ...artifacts.map(artifact => artifact.filename),
      "manifest.json",
      "manifest.sig",
    ]) {
      await rename(join(workDirectory, filename), join(outputDirectory, filename));
    }
  }
  finally {
    await rm(workDirectory, { force: true, recursive: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
