#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  command,
  embedCore,
  findBuiltApp,
  verifyAppShape,
} from "./create-stage-7-macos-release.mjs";
import { sha256File } from "./stage-7-release-contract.mjs";
import { embedRemoteAgentRelease, verifyEmbeddedRemoteAgentRelease } from "./embed-remote-agent-release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_DIST = join(ROOT, "products", "workbench", "dist");

async function waitForSmoke(child, durationMs = 12_000) {
  let exit = null;
  let launchError = null;
  child.once("exit", (code, signal) => { exit = { code, signal }; });
  child.once("error", error => { launchError = error; });
  await new Promise(accept => setTimeout(accept, durationMs));
  if (launchError) throw launchError;
  if (exit) throw new Error(`Chatero exited during its cold-start smoke test (${exit.code ?? exit.signal})`);
  child.kill("SIGTERM");
  await new Promise(accept => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); accept(); }, 5_000);
    child.once("exit", () => { clearTimeout(timer); accept(); });
  });
}

async function smokeTest(appPath, scratch) {
  const plist = join(appPath, "Contents", "Info.plist");
  const executableName = (await command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist])).stdout.trim();
  const executable = join(appPath, "Contents", "MacOS", executableName);
  const userData = join(scratch, "user-data");
  const extensions = join(scratch, "extensions");
  await mkdir(userData);
  await mkdir(extensions);
  const child = spawn(executable, [
    "--disable-gpu",
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensions}`,
    "--skip-release-notes",
    "--skip-welcome",
    "--new-window",
  ], { env: { ...process.env }, stdio: "ignore" });
  await waitForSmoke(child);
}

async function verifyDmg(dmg, scratch) {
  const mount = join(scratch, "mounted");
  await mkdir(mount);
  await command("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg]);
  try {
    const apps = (await readdir(mount, { withFileTypes: true })).filter(value => value.isDirectory() && value.name.endsWith(".app"));
    if (apps.length !== 1) throw new Error("local DMG must expose exactly one Chatero app");
    await verifyAppShape(join(mount, apps[0].name));
    await verifyEmbeddedRemoteAgentRelease(join(mount, apps[0].name));
    await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", join(mount, apps[0].name)]);
  }
  finally { await command("/usr/bin/hdiutil", ["detach", mount]); }
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("local Chatero packaging requires native macOS arm64");
  const sourceCommit = (await command("git", ["rev-parse", "HEAD^{commit}"], { cwd: ROOT })).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("source commit is invalid");
  const outputDirectory = resolve(process.env.CHATERO_LOCAL_RELEASE_OUTPUT ?? DEFAULT_DIST);
  const scratch = await mkdtemp(join(tmpdir(), "chatero-local-release-"));
  try {
    const builtApp = await findBuiltApp();
    const app = join(scratch, "Chatero.app");
    await cp(builtApp, app, { recursive: true, force: false, errorOnExist: true });
    await embedCore(app);
    await embedRemoteAgentRelease(app);
    await verifyAppShape(app);
    await command("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app]);
    await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    await smokeTest(app, scratch);

    await mkdir(outputDirectory, { recursive: true });
    const filename = `Chatero-local-${sourceCommit}.dmg`;
    const temporaryDmg = join(scratch, filename);
    const finalDmg = join(outputDirectory, filename);
    if (await stat(finalDmg).then(() => true).catch(() => false)) throw new Error("local release output already exists");
    const root = join(scratch, "dmg-root");
    await mkdir(root);
    await cp(app, join(root, "Chatero.app"), { recursive: true, force: false, errorOnExist: true });
    await command("/usr/bin/hdiutil", ["create", "-volname", "Chatero Local", "-srcfolder", root, "-format", "UDZO", temporaryDmg]);
    await command("/usr/bin/hdiutil", ["verify", temporaryDmg]);
    await verifyDmg(temporaryDmg, scratch);
    await rename(temporaryDmg, finalDmg);
    process.stdout.write(`${JSON.stringify({
      status: "passed",
      sourceCommit,
      product: basename(finalDmg),
      productSha256: await sha256File(finalDmg),
      signature: "adhoc-local",
      notarized: false,
    })}\n`);
  }
  finally { await rm(scratch, { recursive: true, force: true }); }
}

main().catch(error => { process.stderr.write(`Local Chatero release failed: ${error.message}\n`); process.exitCode = 1; });
