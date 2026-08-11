#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CODE_OSS_COMMIT = "df53daabb18cd157bdb08c7f01c34df936cf12f4";
const ARCHITECTURES = Object.freeze({
  x64: { tupleArch: "x86_64", targetArch: "x64" },
  arm64: { tupleArch: "aarch64", targetArch: "arm64" },
});
const DEFAULT_CHECKOUT = fileURLToPath(new URL("../../../../vendor/code-oss/", import.meta.url));
const DEFAULT_DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const BRIDGE_PATH = new URL("../runtime/chatero-process-bridge.mjs", import.meta.url);

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

export async function assertCleanCheckout(checkout) {
  const status = await run("git", [
    "-C", checkout,
    "status", "--porcelain=v1", "--untracked-files=all",
  ], { capture: true });
  if (status) {
    throw new Error(`Code-OSS checkout is dirty:\n${status}`);
  }
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
  const checkout = resolve(options["--checkout"] ?? DEFAULT_CHECKOUT);
  if (!(await stat(checkout)).isDirectory()) {
    throw new Error(`${checkout} must be the pinned Code-OSS checkout`);
  }
  const actualCommit = await run("git", ["-C", checkout, "rev-parse", "HEAD"], { capture: true });
  if (actualCommit !== CODE_OSS_COMMIT) {
    throw new Error(`Code-OSS checkout must be at ${CODE_OSS_COMMIT}, received ${actualCommit}`);
  }
  await assertCleanCheckout(checkout);

  const plan = makeBuildPlan({
    arch: options["--arch"],
    checkout,
    output: options["--out"],
  });
  await run("npm", ["run", "gulp", plan.target], { cwd: checkout });

  if (!(await stat(plan.upstreamRoot)).isDirectory()) {
    throw new Error(`${plan.target} did not produce ${plan.upstreamRoot}`);
  }
  const cache = fileURLToPath(new URL("../.cache/", import.meta.url));
  await mkdir(cache, { recursive: true });
  const workDirectory = await mkdtemp(join(cache, `build-${options["--arch"]}-`));
  try {
    const root = join(workDirectory, plan.rootName);
    await rename(plan.upstreamRoot, root);
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const bridgeDestination = join(bin, "chatero-process-bridge.mjs");
    await copyFile(BRIDGE_PATH, bridgeDestination);
    await chmod(bridgeDestination, 0o755);

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
