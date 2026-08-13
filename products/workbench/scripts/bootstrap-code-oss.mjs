import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { ensureCheckout } from "./lib/git-checkout.mjs";
import { buildDocumentationWebview } from "./build-documentation-webview.mjs";
import { inspectFirstPartyExtensionSources, materializeFirstPartyExtensions } from "./lib/first-party-extensions.mjs";
import { applyPatchSeries } from "./lib/patch-series.mjs";
import { materializeProduct } from "./lib/product-materializer.mjs";
import { loadUpstreamContract } from "./lib/upstream-contract.mjs";
import { verifyWorkbenchPolicy } from "./lib/workbench-policy.mjs";
import { verifyCodeOss } from "./verify-code-oss.mjs";

const execFile = promisify(execFileCallback);
const PROVENANCE_FILE = ".chatero-provenance.json";
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKBENCH_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_REPOSITORY_ROOT = resolve(DEFAULT_WORKBENCH_ROOT, "..", "..");

async function defaultRunGit({ args, cwd }) {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trimEnd();
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseStatusPaths(status) {
  return status
    .split("\n")
    .filter(Boolean)
    .map(line => line.slice(3))
    .sort();
}

async function atomicWriteJSON(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o644,
    });
    await rename(temporaryPath, path);
  }
  catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function readPatchPins(seriesPath) {
  const series = JSON.parse(await readFile(seriesPath, "utf8"));
  return series.patches.map(patch => ({ file: patch.file, sha256: patch.sha256 }));
}

export async function bootstrapCodeOss({
  root = DEFAULT_REPOSITORY_ROOT,
  workbenchRoot = join(root, "products", "workbench"),
  destination = process.env.CHATERO_CODE_OSS_DIR || join(root, "vendor", "code-oss"),
  contractPath = join(workbenchRoot, "upstreams.json"),
  firstPartyManifestPath = join(workbenchRoot, "first-party-extensions.json"),
  contract,
  runGit = defaultRunGit,
} = {}) {
  const pinned = contract || await loadUpstreamContract(contractPath);
  const canonicalDestination = resolve(destination);
  const provenancePath = join(canonicalDestination, PROVENANCE_FILE);
  const verificationInput = {
    root,
    workbenchRoot,
    destination: canonicalDestination,
    contractPath,
    contract: pinned,
    runGit,
  };

  if (await exists(provenancePath)) {
    try {
      const report = await verifyCodeOss(verificationInput);
      const currentSources = await inspectFirstPartyExtensionSources({ root, manifestPath: firstPartyManifestPath });
      if (JSON.stringify(currentSources) !== JSON.stringify(report.firstPartyExtensions)) {
        throw new Error("first-party extension sources differ from the generated checkout; create a new generated checkout");
      }
      return { ...report, reused: true };
    }
    catch (error) {
      throw new Error(`existing generated checkout failed verification: ${error.message}`, {
        cause: error,
      });
    }
  }

  await ensureCheckout({
    repository: pinned.codeOss.repository,
    ref: pinned.codeOss.ref,
    commit: pinned.codeOss.commit,
    destination: canonicalDestination,
    runGit,
  });
  const seriesPath = join(workbenchRoot, "patches", "code-oss", "series.json");
  const patchResult = await applyPatchSeries({
    checkout: canonicalDestination,
    seriesPath,
    runGit,
  });
  const productPath = join(canonicalDestination, "product.json");
  const productResult = await materializeProduct({
    upstreamProductPath: productPath,
    overlayPath: join(workbenchRoot, "product.chatero.json"),
    outputPath: productPath,
    contract: pinned,
  });

  const policy = await verifyWorkbenchPolicy({
    root: workbenchRoot,
    productPath,
    checkout: canonicalDestination,
  });
  if (!policy.ok) {
    throw new Error(`workbench policy rejected generated product: ${policy.violations.map(value => value.rule).join(", ")}`);
  }
  await buildDocumentationWebview({ root });
  const firstParty = await materializeFirstPartyExtensions({
    root,
    checkout: canonicalDestination,
    manifestPath: firstPartyManifestPath,
  });

  const status = await runGit({
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: canonicalDestination,
  });
  const managedPaths = parseStatusPaths(status);
  const worktreeDiff = await runGit({
    args: ["diff", "--binary", "HEAD", "--"],
    cwd: canonicalDestination,
  });
  const provenance = {
    schemaVersion: 1,
    codeOssCommit: pinned.codeOss.commit,
    codeOssVersion: pinned.codeOss.version,
    node: pinned.codeOss.node,
    electron: pinned.codeOss.electron,
    firstPartyExtensions: firstParty.extensions,
    patches: await readPatchPins(seriesPath),
    managedPaths,
    productSha256: productResult.sha256,
    worktreeDiffSha256: sha256(worktreeDiff),
  };
  await atomicWriteJSON(provenancePath, provenance);

  const report = await verifyCodeOss(verificationInput);
  return {
    ...report,
    appliedPatches: patchResult.applied,
    firstPartyExtensions: firstParty.extensions,
    reused: false,
  };
}

function parseCLIArguments(args) {
  const known = new Set(["--checkout-only", "--json", "--verify"]);
  for (const arg of args) {
    if (!known.has(arg)) {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return {
    checkoutOnly: args.includes("--checkout-only"),
    json: args.includes("--json"),
    verify: args.includes("--verify"),
  };
}

function isMainModule() {
  return Boolean(process.argv[1])
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  Promise.resolve()
    .then(async () => {
      const options = parseCLIArguments(process.argv.slice(2));
      if (options.checkoutOnly && options.verify) {
        throw new Error("--checkout-only and --verify cannot be combined");
      }
      let result;
      if (options.verify) {
        result = await verifyCodeOss();
      }
      else if (options.checkoutOnly) {
        const contract = await loadUpstreamContract(join(DEFAULT_WORKBENCH_ROOT, "upstreams.json"));
        result = await ensureCheckout({
          repository: contract.codeOss.repository,
          ref: contract.codeOss.ref,
          commit: contract.codeOss.commit,
          destination: process.env.CHATERO_CODE_OSS_DIR || join(DEFAULT_REPOSITORY_ROOT, "vendor", "code-oss"),
        });
      }
      else {
        result = await bootstrapCodeOss();
      }
      process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`);
    })
    .catch(error => {
      process.stderr.write(`workbench bootstrap failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
