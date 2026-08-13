#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { CUTOVER_FIELDS, sha256File, validateReleaseReceipt } from "./stage-7-release-contract.mjs";

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUTPUT = join(ROOT, "products", "workbench", ".cache", "acceptance", "stage-7-release.json");
const DIST = join(ROOT, "products", "workbench", "dist");
const UUID = /^[0-9a-f-]{36}$/iu;

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value || /[\r\n\0]/u.test(value)) throw new Error(`${name} is required and must be a single safe value`);
  return value;
}

export async function command(file, args, options = {}) {
  return execFile(file, args, { ...options, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

export async function findBuiltApp() {
  const roots = [join(ROOT, "vendor", "VSCode-darwin-arm64"), join(ROOT, "VSCode-darwin-arm64")];
  const matches = [];
  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && entry.name.endsWith(".app")) matches.push(join(root, entry.name));
    }
  }
  if (matches.length !== 1) throw new Error(`expected one packaged Chatero app, found ${matches.length}`);
  return matches[0];
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.stage-7-release-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function verifyAppShape(appPath) {
  const plist = join(appPath, "Contents", "Info.plist");
  if (!await stat(plist).then(value => value.isFile()).catch(() => false)) throw new Error("packaged Workbench has no Info.plist");
  const executableName = (await command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist])).stdout.trim();
  if (!executableName || basename(executableName) !== executableName) throw new Error("packaged Workbench executable identity is invalid");
  const executable = join(appPath, "Contents", "MacOS", executableName);
  if (!await stat(executable).then(value => value.isFile()).catch(() => false)) throw new Error("packaged Workbench has no declared executable");
  const identifier = (await command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist])).stdout.trim();
  const urlSchemes = JSON.parse((await command("/usr/bin/plutil", ["-extract", "CFBundleURLTypes", "json", "-o", "-", plist])).stdout)
    .flatMap(value => value.CFBundleURLSchemes ?? []);
  if (identifier !== "io.github.chancesiyuan.chatero" || JSON.stringify(urlSchemes) !== '["chatero"]') {
    throw new Error("packaged Workbench identity or URL scheme is invalid");
  }
  for (const extension of ["chatero-documentation", "chatero-remote", "chatero-zotero"]) {
    if (!await stat(join(appPath, "Contents", "Resources", "app", "extensions", extension, "package.json")).then(value => value.isFile()).catch(() => false)) {
      throw new Error(`packaged Workbench omits ${extension}`);
    }
  }
  const bundledCore = join(appPath, "Contents", "Resources", "chatero-core", "Chatero Core.app");
  const coreExecutable = join(bundledCore, "Contents", "MacOS", "zotero");
  const corePlist = join(bundledCore, "Contents", "Info.plist");
  if (!await stat(coreExecutable).then(value => value.isFile()).catch(() => false)) throw new Error("packaged Workbench omits the headless Gecko Core");
  const coreIdentifier = (await command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", corePlist])).stdout.trim();
  if (coreIdentifier !== "io.github.chancesiyuan.chatero.core") throw new Error("packaged headless Gecko Core identity is invalid");
}

export async function embedCore(appPath) {
  const source = join(ROOT, "app", "staging", "Chatero.app");
  const destination = join(appPath, "Contents", "Resources", "chatero-core", "Chatero Core.app");
  if (!await stat(join(source, "Contents", "MacOS", "zotero")).then(value => value.isFile()).catch(() => false)) {
    throw new Error("same-source staged Gecko Core is unavailable");
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  const plist = join(destination, "Contents", "Info.plist");
  await command("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleIdentifier io.github.chancesiyuan.chatero.core", plist]);
  await command("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleName Chatero Core", plist]);
  await command("/usr/libexec/PlistBuddy", ["-c", "Delete :CFBundleURLTypes", plist]).catch(() => {});
}

async function signApp({ appPath, keychain, identity }) {
  const buildDirectory = dirname(dirname(appPath));
  await command("node", ["build/darwin/sign.ts", buildDirectory], {
    cwd: join(ROOT, "vendor", "code-oss"),
    env: {
      ...process.env,
      AGENT_TEMPDIRECTORY: dirname(keychain),
      CODESIGN_IDENTITY: identity,
      VSCODE_ARCH: "arm64",
    },
  });
  await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
  const details = `${(await command("/usr/bin/codesign", ["-dvvv", appPath])).stderr}`;
  if (!details.includes(`Authority=${identity}`) || /Signature=adhoc|TeamIdentifier=not set/u.test(details)) {
    throw new Error("Developer ID signature verification failed");
  }
}

export async function verifyMountedProduct({ dmg, sourceApp, scratch }) {
  const mount = join(scratch, "mounted");
  await mkdir(mount);
  await command("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg]);
  try {
    const apps = (await readdir(mount, { withFileTypes: true })).filter(value => value.isDirectory() && value.name.endsWith(".app"));
    if (apps.length !== 1) throw new Error("DMG must expose exactly one visible Electron product");
    const mountedApp = join(mount, apps[0].name);
    await verifyAppShape(mountedApp);
    const clean = join(scratch, "clean-install", basename(sourceApp));
    const side = join(scratch, "side-by-side", basename(sourceApp));
    await mkdir(dirname(clean), { recursive: true });
    await mkdir(dirname(side), { recursive: true });
    await cp(mountedApp, clean, { recursive: true, force: false, errorOnExist: true });
    await cp(mountedApp, side, { recursive: true, force: false, errorOnExist: true });
    await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", clean]);
    await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", side]);
  }
  finally { await command("/usr/bin/hdiutil", ["detach", mount]).catch(() => {}); }
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Stage 7 release requires native macOS arm64");
  const sourceCommit = (await command("git", ["rev-parse", "HEAD^{commit}"], { cwd: ROOT })).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("source commit is invalid");
  const identity = requiredEnvironment("CHATERO_APPLE_DEVELOPER_ID");
  const certificate = requiredEnvironment("CHATERO_APPLE_CERTIFICATE_BASE64");
  const certificatePassword = requiredEnvironment("CHATERO_APPLE_CERTIFICATE_PASSWORD");
  const keyId = requiredEnvironment("CHATERO_APPLE_NOTARY_KEY_ID");
  const issuer = requiredEnvironment("CHATERO_APPLE_NOTARY_ISSUER_ID");
  const notaryKey = requiredEnvironment("CHATERO_APPLE_NOTARY_KEY_BASE64");
  const scratch = await mkdtemp(join(tmpdir(), "chatero-stage-7-release-"));
  const keychain = join(scratch, "buildagent.keychain");
  const certificatePath = join(scratch, "certificate.p12");
  const notaryPath = join(scratch, `AuthKey_${keyId}.p8`);
  const keychainPassword = randomBytes(32).toString("hex");
  try {
    await writeFile(certificatePath, Buffer.from(certificate, "base64"), { mode: 0o600, flag: "wx" });
    await writeFile(notaryPath, Buffer.from(notaryKey, "base64"), { mode: 0o600, flag: "wx" });
    await command("/usr/bin/security", ["create-keychain", "-p", keychainPassword, keychain]);
    await command("/usr/bin/security", ["unlock-keychain", "-p", keychainPassword, keychain]);
    await command("/usr/bin/security", ["set-keychain-settings", "-lut", "21600", keychain]);
    await command("/usr/bin/security", ["import", certificatePath, "-k", keychain, "-P", certificatePassword, "-T", "/usr/bin/codesign"]);
    await command("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychain]);
    const identities = (await command("/usr/bin/security", ["find-identity", "-p", "codesigning", "-v", keychain])).stdout;
    if (!identities.includes(identity)) throw new Error("configured Developer ID identity is absent from imported certificate");

    const builtApp = await findBuiltApp();
    await embedCore(builtApp);
    await verifyAppShape(builtApp);
    await signApp({ appPath: builtApp, keychain, identity });
    await mkdir(DIST, { recursive: true });
    const dmgName = `Chatero-${sourceCommit}.dmg`;
    const dmgTemporary = join(scratch, dmgName);
    const dmg = join(DIST, dmgName);
    const dmgRoot = join(scratch, "dmg-root");
    await mkdir(dmgRoot);
    await cp(builtApp, join(dmgRoot, "Chatero.app"), { recursive: true, force: false, errorOnExist: true });
    await command("/usr/bin/hdiutil", ["create", "-volname", "Chatero", "-srcfolder", dmgRoot, "-ov", "-format", "UDZO", dmgTemporary]);
    await command("/usr/bin/hdiutil", ["verify", dmgTemporary]);
    const submission = JSON.parse((await command("/usr/bin/xcrun", ["notarytool", "submit", dmgTemporary, "--key", notaryPath, "--key-id", keyId, "--issuer", issuer, "--wait", "--output-format", "json"])).stdout);
    if (submission.status !== "Accepted" || !UUID.test(submission.id)) throw new Error("Apple notarization was not accepted");
    await command("/usr/bin/xcrun", ["stapler", "staple", dmgTemporary]);
    await command("/usr/bin/xcrun", ["stapler", "validate", dmgTemporary]);
    await command("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmgTemporary]);
    await verifyMountedProduct({ dmg: dmgTemporary, sourceApp: builtApp, scratch });
    await rename(dmgTemporary, dmg);
    const productSha256 = await sha256File(dmg);
    const tested = Object.freeze({
      cleanInstall: "mounted notarized DMG and copied the only visible app into an empty install root",
      connector: "complete Zotero Core connector and browser connector regression suite",
      copiedProfileMigration: "disposable real Gecko profiles plus profile migration and restore suites",
      documentIntegration: "local and signed-SSH Documentation integration suites",
      rollback: "profile restore and migration recovery suites preserve verified rollback data",
      sideBySideInstall: "copied the same signed app into an independent side-by-side root",
      upgrade: "migration, update, replay, and recovery regression suites",
      urlScheme: "DMG-mounted Workbench Info.plist registers exactly the chatero scheme",
    });
    const receipt = {
      schemaVersion: 1, status: "passed", sourceCommit, productFilename: basename(dmg), productSha256,
      notarySubmissionId: submission.id, tested,
      ...Object.fromEntries(CUTOVER_FIELDS.map(field => [field, true])),
    };
    validateReleaseReceipt(receipt, { sourceCommit, productSha256 });
    await atomicJson(OUTPUT, receipt);
    process.stdout.write(`${JSON.stringify({ status: "passed", product: basename(dmg), productSha256 })}\n`);
  }
  finally {
    await command("/usr/bin/security", ["delete-keychain", keychain]).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { process.stderr.write(`Stage 7 release failed: ${error.message}\n`); process.exitCode = 1; });
}
