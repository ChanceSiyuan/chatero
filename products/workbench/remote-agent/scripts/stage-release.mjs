#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import {
  REMOTE_AGENT_TUPLES,
  canonicalManifestBytes,
} from "../release-contract.mjs";

const RELEASE_VERSION = "1.132.0";
const CODE_OSS_COMMIT = "df53daabb18cd157bdb08c7f01c34df936cf12f4";
const BRIDGE_PATH = new URL("../runtime/chatero-process-bridge.mjs", import.meta.url);

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
  const bridgeDestination = join(bin, "chatero-process-bridge.mjs");
  await copyFile(BRIDGE_PATH, bridgeDestination);
  await chmod(bridgeDestination, 0o755);

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
