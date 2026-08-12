import { spawn as spawnChild } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  createDocumentationAuthorityClient,
  createFixedAuthorityTransport,
} from "./documentation-authority-client.mjs";
import { createDocumentationCapabilityIssuer } from "./documentation-capabilities.mjs";
import { createDocumentationTransactions } from "./documentation-transactions.mjs";
import { createDocumentationWorkspaceView } from "./documentation-workspace.mjs";
import {
  createMigrationPlanner,
  MIGRATION_PLAN_LIMITS,
} from "./migration-planner.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const EXTENSION_DESTINATION = "extensions/chatero-documentation";
const MAX_VERIFIER_OUTPUT = 64 * 1024;

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function extensionPath(extensionUri) {
  const value = extensionUri?.fsPath ?? extensionUri?.path;
  if (extensionUri?.scheme !== "file" || typeof value !== "string" || !value.startsWith("/")) {
    throw new TypeError("Documentation extension must be installed on a local extension-host filesystem");
  }
  return resolve(value);
}

async function collectExtensionFiles(checkout, directory, files) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error("Documentation extension tree contains an unsafe directory");
  }
  const names = await readdir(directory);
  names.sort(compareUtf8Bytes);
  for (const name of names) {
    const path = join(directory, name);
    const value = await lstat(path);
    if (value.isSymbolicLink()) throw new Error("Documentation extension tree contains a symbolic link");
    if (value.isDirectory()) await collectExtensionFiles(checkout, path, files);
    else if (value.isFile() && value.nlink === 1 && value.size <= 4 * 1024 * 1024) {
      const bytes = await readFile(path);
      files.push(Object.freeze({
        path: relative(checkout, path).split(sep).join("/"),
        sha256: sha256(bytes),
        size: bytes.byteLength,
      }));
    }
    else throw new Error("Documentation extension tree contains an unsafe file");
  }
}

async function verifyLocalMaterialization(root) {
  const checkout = resolve(root, "..", "..");
  const provenancePath = join(checkout, ".chatero-provenance.json");
  const provenanceMetadata = await lstat(provenancePath);
  if (!provenanceMetadata.isFile() || provenanceMetadata.isSymbolicLink() || provenanceMetadata.nlink !== 1) {
    throw new Error("Code-OSS provenance is unsafe");
  }
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  const expected = provenance?.firstPartyExtensions?.find(value => value?.id === "chatero.documentation");
  if (!expected || expected.destinationRoot !== EXTENSION_DESTINATION || !Array.isArray(expected.files)) {
    throw new Error("Documentation first-party provenance is missing");
  }
  if (resolve(checkout, expected.destinationRoot) !== root) {
    throw new Error("Documentation extension root differs from provenance");
  }
  const actual = [];
  await collectExtensionFiles(checkout, root, actual);
  actual.sort((left, right) => compareUtf8Bytes(left.path, right.path));
  const expectedFiles = [...expected.files].sort((left, right) => compareUtf8Bytes(left.path, right.path));
  if (JSON.stringify(actual) !== JSON.stringify(expectedFiles)) {
    throw new Error("Documentation extension bytes differ from first-party provenance");
  }
  const treeDigest = sha256(Buffer.from(
    actual.map(file => `${file.path}\0${file.size}\0${file.sha256}\n`).join(""),
    "utf8",
  ));
  if (treeDigest !== expected.treeSha256) throw new Error("Documentation extension tree digest differs from provenance");
  return Object.freeze({ kind: "verified", canonicalRoot: root, treeSha256: treeDigest });
}

function exactRemoteIntegrityEnvironment(environment) {
  const installRoot = environment.CHATERO_AGENT_INSTALL_ROOT;
  const treeManifestSha256 = environment.CHATERO_AGENT_TREE_MANIFEST_SHA256;
  const nodeSha256 = environment.CHATERO_AGENT_NODE_SHA256;
  const integrityVerifierSha256 = environment.CHATERO_AGENT_INTEGRITY_VERIFIER_SHA256;
  if (typeof installRoot !== "string" || !installRoot.startsWith("/")
    || !SHA256.test(treeManifestSha256 ?? "") || !SHA256.test(nodeSha256 ?? "")
    || !SHA256.test(integrityVerifierSha256 ?? "")) {
    return null;
  }
  return Object.freeze({
    installRoot: resolve(installRoot),
    treeManifestSha256,
    nodeSha256,
    integrityVerifierSha256,
  });
}

async function assertRegularDigest(path, expected) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (metadata.mode & 0o022) !== 0) {
    throw new Error("Remote Agent trusted runtime file is unsafe");
  }
  if (sha256(await readFile(path)) !== expected) throw new Error("Remote Agent trusted runtime digest changed");
}

function runVerifier(spawn, command, args) {
  return new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        env: {},
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    catch (error) {
      rejectRun(error);
      return;
    }
    if (!child?.stdout || !child?.stderr || typeof child.once !== "function") {
      rejectRun(new TypeError("Remote Agent integrity verifier process is invalid"));
      return;
    }
    const output = [];
    let size = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      rejectRun(error);
    };
    child.stdout.on("data", chunk => {
      size += chunk.byteLength;
      if (size > MAX_VERIFIER_OUTPUT) fail(new RangeError("Remote Agent integrity output is too large"));
      else output.push(Buffer.from(chunk));
    });
    child.stderr.on("data", chunk => {
      size += chunk.byteLength;
      if (size > MAX_VERIFIER_OUTPUT) fail(new RangeError("Remote Agent integrity diagnostics are too large"));
    });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal) {
        fail(new Error("Remote Agent installed-tree verification failed"));
        return;
      }
      settled = true;
      resolveRun(Buffer.concat(output).toString("utf8").trim());
    });
  });
}

async function verifyRemoteInstall(root, signed, spawn) {
  const installRoot = await realpath(signed.installRoot);
  if (installRoot !== signed.installRoot
    || (root !== installRoot && !root.startsWith(`${installRoot}${sep}`))
    || await realpath(root) !== root) {
    throw new Error("Documentation extension is outside the signed Remote Agent tree");
  }
  const node = join(installRoot, "node");
  const verifier = join(installRoot, "bin", "chatero-install-integrity.mjs");
  const manifest = join(installRoot, "integrity", "tree.v1.json");
  await assertRegularDigest(node, signed.nodeSha256);
  await assertRegularDigest(verifier, signed.integrityVerifierSha256);
  await assertRegularDigest(manifest, signed.treeManifestSha256);
  const output = await runVerifier(spawn, node, [
    verifier,
    "verify",
    installRoot,
    manifest,
    signed.treeManifestSha256,
  ]);
  const expected = JSON.stringify({ kind: "verified", treeManifestSha256: signed.treeManifestSha256 });
  if (output !== expected) throw new Error("Remote Agent installed-tree verification result is invalid");
  return Object.freeze({
    kind: "verified",
    canonicalRoot: root,
    treeSha256: signed.treeManifestSha256,
  });
}

export function createTrustedRuntimeVerifier({ extensionUri, environment = process.env, spawn = spawnChild }) {
  const root = extensionPath(extensionUri);
  const signedRemote = exactRemoteIntegrityEnvironment(environment);
  return async ({ extensionRoot, helperPath }) => {
    if (resolve(extensionRoot) !== root || resolve(helperPath) !== join(root, "runtime", "chatero-documentation-authority.mjs")) {
      throw new Error("Documentation helper path differs from the fixed product entrypoint");
    }
    return signedRemote
      ? verifyRemoteInstall(root, signedRemote, spawn)
      : verifyLocalMaterialization(root);
  };
}

function workspaceIdentity(folder, epoch) {
  const uri = folder?.uri;
  if (!uri || typeof uri.toString !== "function") throw new TypeError("Documentation workspace folder is invalid");
  const value = uri.toString(true);
  const parsed = new URL(value);
  const authority = parsed.protocol === "file:" ? "local" : parsed.host;
  if ((parsed.protocol !== "file:" && parsed.protocol !== "vscode-remote:")
    || (parsed.protocol === "vscode-remote:" && !authority.startsWith("chatero-remote+"))) {
    throw new TypeError("Documentation workspace authority is unsupported");
  }
  return Object.freeze({ uri: value, authority, epoch });
}

export async function createProductionDocumentationServices({
  vscode,
  context,
  spawn = spawnChild,
  environment = process.env,
  clock = Date,
  uuid = randomUUID,
} = {}) {
  if (!vscode?.workspace || !context?.extensionUri || typeof uuid !== "function") {
    throw new TypeError("Documentation production composition dependencies are invalid");
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length !== 1) throw new Error("Documentation requires exactly one workspace folder in Phase 1");
  const folder = folders[0];
  const epoch = `documentation-${uuid()}`;
  const capabilities = createDocumentationCapabilityIssuer({ clock, randomUUID: uuid });
  const scope = capabilities.issueScope(workspaceIdentity(folder, epoch));
  const scopeRecord = capabilities.consumeScope(scope);
  const workspaceView = createDocumentationWorkspaceView({
    workspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
    textDocuments: () => vscode.workspace.textDocuments ?? [],
  });
  const signedRemote = exactRemoteIntegrityEnvironment(environment);
  const processPath = signedRemote ? join(signedRemote.installRoot, "node") : process.execPath;
  const fixedTransport = createFixedAuthorityTransport({
    extensionUri: context.extensionUri,
    processPath,
    spawn,
    electron: signedRemote ? false : process.versions.electron !== undefined,
    verifyTrustedRuntime: createTrustedRuntimeVerifier({
      extensionUri: context.extensionUri,
      environment,
      spawn,
    }),
  });
  const adapter = createDocumentationAuthorityClient({ scope: scopeRecord, workspaceView, fixedTransport });
  const migrationPlanner = createMigrationPlanner({
    adapter,
    capabilities,
    clock,
    limits: MIGRATION_PLAN_LIMITS,
    isWorkspaceTrusted: () => vscode.workspace.isTrusted === true,
  });
  const transactions = createDocumentationTransactions({
    adapter,
    capabilities,
    workspaceView,
    migrationPlanner,
  });
  return Object.freeze({
    adapter,
    capabilities,
    scope,
    transactions,
    workspaceFolderUri: folder.uri,
    randomUUID: uuid,
    snapshotPassiveImage: request => adapter.snapshot(request),
  });
}
