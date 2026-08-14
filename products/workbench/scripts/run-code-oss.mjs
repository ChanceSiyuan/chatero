import { execFile as execFileCallback, spawn } from "node:child_process";
import { readFile, stat, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { loadUpstreamContract } from "./lib/upstream-contract.mjs";
import { verifyCodeOss } from "./verify-code-oss.mjs";

const execFile = promisify(execFileCallback);
const REQUIRED_FREE_BYTES = 20 * 1024 ** 3;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKBENCH_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_REPOSITORY_ROOT = resolve(DEFAULT_WORKBENCH_ROOT, "..", "..");

async function defaultFreeBytes(path) {
  const value = await statfs(path, { bigint: true });
  return Number(value.bavail * value.bsize);
}

async function defaultFindXcrun() {
  try {
    const { stdout } = await execFile("xcrun", ["--find", "clang"], {
      encoding: "utf8",
    });
    return stdout.trim() || null;
  }
  catch {
    return null;
  }
}

async function defaultRun({ file, args, cwd }) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd,
      stdio: "inherit",
    });
    const forwardSignal = signal => {
      if (!child.killed) child.kill(signal);
    };
    const onSIGINT = () => forwardSignal("SIGINT");
    const onSIGTERM = () => forwardSignal("SIGTERM");
    process.on("SIGINT", onSIGINT);
    process.on("SIGTERM", onSIGTERM);
    const cleanup = () => {
      process.off("SIGINT", onSIGINT);
      process.off("SIGTERM", onSIGTERM);
    };
    child.once("error", error => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0) {
        resolvePromise();
      }
      else {
        reject(new Error(`${file} ${args.join(" ")} exited with ${signal || code}`));
      }
    });
  });
}

function readElectronTarget(npmrc) {
  const target = npmrc.match(/^target=["']?([^"'\r\n]+)["']?$/m)?.[1];
  const runtime = npmrc.match(/^runtime=["']?([^"'\r\n]+)["']?$/m)?.[1];
  return { runtime, target };
}

function throwPreconditions(failures) {
  if (failures.length === 0) return;
  if (failures.length === 1) throw new Error(failures[0]);
  throw new Error(`unmet Code-OSS development preconditions:\n${failures.map(failure => `  - ${failure}`).join("\n")}`);
}

export async function preflightRuntime({
  checkout,
  root = DEFAULT_REPOSITORY_ROOT,
  workbenchRoot = join(root, "products", "workbench"),
  contractPath = join(workbenchRoot, "upstreams.json"),
  contract,
  processVersions = process.versions,
  platform = process.platform,
  freeBytes = defaultFreeBytes,
  findXcrun = defaultFindXcrun,
  verify = verifyCodeOss,
} = {}) {
  const pinned = contract || await loadUpstreamContract(contractPath);

  // Host preconditions are reported together so a fresh machine is fixed in one round,
  // but nothing inspects the checkout until the host itself can run this workbench.
  const hostFailures = [];
  if (processVersions.node !== pinned.codeOss.node) {
    hostFailures.push(`Code-OSS ${pinned.codeOss.version} requires Node ${pinned.codeOss.node}; current Node is ${processVersions.node}`);
  }
  if (platform !== "darwin") {
    hostFailures.push("the first Chatero workbench developer target requires macOS");
  }
  throwPreconditions(hostFailures);

  const canonicalCheckout = resolve(checkout);
  const checkoutFailures = [];
  const available = await freeBytes(canonicalCheckout);
  if (available < REQUIRED_FREE_BYTES) {
    checkoutFailures.push(`Code-OSS development requires at least 20 GiB free; found ${(available / 1024 ** 3).toFixed(1)} GiB`);
  }
  if (!await findXcrun()) {
    checkoutFailures.push("Xcode command line tools are required; xcrun could not find clang");
  }

  const declaredNode = (await readFile(join(canonicalCheckout, ".nvmrc"), "utf8")).trim();
  if (declaredNode !== pinned.codeOss.node) {
    checkoutFailures.push(`checkout .nvmrc declares ${declaredNode}, expected ${pinned.codeOss.node}`);
  }
  const npmrc = await readFile(join(canonicalCheckout, ".npmrc"), "utf8");
  const electron = readElectronTarget(npmrc);
  if (electron.runtime !== "electron" || electron.target !== pinned.codeOss.electron) {
    checkoutFailures.push(`checkout .npmrc must declare runtime electron and target ${pinned.codeOss.electron}`);
  }
  throwPreconditions(checkoutFailures);

  const verification = await verify({
    root,
    workbenchRoot,
    destination: canonicalCheckout,
    contractPath,
    contract: pinned,
  });
  if (!verification?.ok) {
    throw new Error("Code-OSS provenance verification did not pass");
  }
  return {
    checkout: canonicalCheckout,
    node: pinned.codeOss.node,
    electron: pinned.codeOss.electron,
    freeBytes: available,
    verification,
  };
}

export async function runDevelopment({
  checkout = process.env.CHATERO_CODE_OSS_DIR || join(DEFAULT_REPOSITORY_ROOT, "vendor", "code-oss"),
  install = false,
  compile = false,
  launch = false,
  preflightOptions = {},
  run = defaultRun,
} = {}) {
  if (!install && !compile && !launch) {
    throw new Error("select at least one of --install, --compile, or --launch");
  }
  const canonicalCheckout = resolve(checkout);
  const preflight = await preflightRuntime({
    ...preflightOptions,
    checkout: canonicalCheckout,
  });
  if (launch) {
    const compiledEntry = join(canonicalCheckout, "out", "main.js");
    const compiled = await stat(compiledEntry).catch(error => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!compiled?.isFile()) {
      throw new Error("compile the workbench before launch; out/main.js is missing");
    }
  }

  const stages = [
    install && { name: "install", file: "npm", args: ["install"] },
    compile && { name: "compile", file: "npm", args: ["run", "compile"] },
    launch && { name: "launch", file: "bash", args: ["./scripts/code.sh"] },
  ].filter(Boolean);
  const completed = [];
  for (const stage of stages) {
    await run({
      file: stage.file,
      args: stage.args,
      cwd: canonicalCheckout,
    });
    completed.push(stage.name);
  }
  return { completed, preflight };
}

function parseActions(args) {
  const known = new Set(["--compile", "--install", "--launch"]);
  for (const arg of args) {
    if (!known.has(arg)) throw new Error(`unknown argument ${arg}`);
  }
  return {
    compile: args.includes("--compile"),
    install: args.includes("--install"),
    launch: args.includes("--launch"),
  };
}

function isMainModule() {
  return Boolean(process.argv[1])
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  Promise.resolve()
    .then(() => runDevelopment(parseActions(process.argv.slice(2))))
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`workbench development action failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
