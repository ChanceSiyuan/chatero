import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const TEXT_DOCUMENT_SCENARIOS = Object.freeze([
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

async function fixtureTempBase() {
  // Code-OSS Unix-domain IPC sockets are capped near 104 bytes on macOS, and
  // the default tmpdir() under /var/folders is already too deep once the
  // workspace, user-data, and per-connection socket paths are appended. Use
  // the short /tmp root there and canonicalize it; keep tmpdir() elsewhere.
  const base = process.platform === "darwin" ? "/tmp" : tmpdir();
  return realpath(base);
}

export async function createTemporaryDocumentationWorkspace({ root, checkout, target, remoteAgentReleaseDir }) {
  if (!new Set(["local", "ssh-fixture"]).has(target)) throw new TypeError("invalid Documentation integration target");
  const fixtureRoot = await mkdtemp(join(await fixtureTempBase(), "chatero-doc-"));
  const workspacePath = join(fixtureRoot, "workspace");
  const userDataDir = join(fixtureRoot, "user-data");
  const extensionsDir = join(fixtureRoot, "extensions");
  const homeDir = join(fixtureRoot, "home");
  await Promise.all([
    mkdir(join(workspacePath, "documentation"), { recursive: true }),
    mkdir(userDataDir, { recursive: true }),
    mkdir(extensionsDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
  ]);
  await writeFile(join(workspacePath, "documentation", "index.qmd"), [
    "---",
    "title: Documentation integration fixture",
    "---",
    "",
    "# Documentation integration fixture",
    "",
    "Human and Agent edits share this QMD TextDocument.",
    "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
  await writeFile(join(workspacePath, ".gitignore"), ".chatero/\n", { flag: "wx", mode: 0o600 });

  const driverExtensionPath = join(root, "products", "workbench", "integration", "documentation", "driver");
  const testRunnerPath = join(driverExtensionPath, "run.cjs");
  const codeScript = join(checkout, "scripts", "code.sh");
  const remoteAuthority = "chatero-remote+cHJvZmlsZTpmaXh0dXJl";
  const workspaceUri = target === "local"
    ? pathToFileURL(workspacePath).href
    : `vscode-remote://${remoteAuthority}${workspacePath}`;
  return Object.freeze({
    codeScript,
    driverExtensionPath,
    extensionsDir,
    fixtureRoot,
    homeDir,
    remoteAgentReleaseDir,
    testRunnerPath,
    userDataDir,
    workspacePath,
    workspaceUri,
  });
}
