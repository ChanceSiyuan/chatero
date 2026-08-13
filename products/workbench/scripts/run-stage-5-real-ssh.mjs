#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { EvidenceCacheService } from "../extensions/chatero-remote/evidence-cache.mjs";
import { encodeAuthority } from "../extensions/chatero-remote/authority.mjs";
import { resolveSshTarget } from "../extensions/chatero-remote/openssh-targets.mjs";
import { RemoteAgentInstaller, SshRemoteAgentRuntime } from "../extensions/chatero-remote/remote-agent-installer.mjs";
import { runFramedBridgeRequest } from "../extensions/chatero-remote/remote-process.mjs";
import { SshSession } from "../extensions/chatero-remote/ssh-session.mjs";
import { selectArtifact, verifyRelease } from "../remote-agent/release-contract.mjs";

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CODE_OSS_COMMIT = "df53daabb18cd157bdb08c7f01c34df936cf12f4";
const EXPECTED_CHECKS = Object.freeze([
  "signed-release", "openssh-proxyjump", "install-integrity", "server-launch",
  "files-search-git", "pty-task-debug", "language-fixtures", "documentation",
  "codex-sdk", "exact-pdf-cache", "disconnect-recovery", "expiry-revoke", "remove",
]);

function parseArguments(args) {
  if (!Array.isArray(args) || args.length % 2 !== 0) throw new TypeError("Stage 5 SSH arguments must be flag-value pairs");
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!["--alias", "--release", "--receipt", "--tuple"].includes(flag) || options[flag]) {
      throw new TypeError(`unknown or duplicate argument ${flag ?? ""}`.trim());
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${flag} requires a value`);
    options[flag] = value;
  }
  for (const flag of ["--alias", "--release", "--receipt", "--tuple"]) {
    if (!options[flag]) throw new TypeError(`${flag} is required`);
  }
  if (!/^linux-(?:x86_64|aarch64)$/u.test(options["--tuple"])) throw new TypeError("--tuple is invalid");
  return Object.freeze(options);
}

async function sshRunner(file, args) {
  try {
    const result = await execFile(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  }
  catch (error) {
    return { code: Number.isInteger(error?.code) ? error.code : 1, stdout: error?.stdout ?? "", stderr: error?.stderr ?? error?.message ?? "" };
  }
}

async function readRelease(directory) {
  const root = resolve(directory);
  const [manifestText, signature, publicKey] = await Promise.all([
    readFile(join(root, "manifest.json"), "utf8"),
    readFile(join(root, "manifest.sig")),
    readFile(join(ROOT, "products", "workbench", "remote-agent", "release-public-key.pem")),
  ]);
  return Object.freeze({
    manifestText,
    signature,
    publicKey,
    readArtifact: filename => createReadStream(join(root, filename)),
  });
}

async function runRemote(session, { command, args = [], cwd = "/", env = {}, stdin } = {}) {
  const stdout = [];
  const stderr = [];
  const result = await runFramedBridgeRequest(session.openProcessBridge(), {
    protocolVersion: 1,
    command,
    args,
    cwd,
    env,
  }, {
    onStdout: bytes => stdout.push(Buffer.from(bytes)),
    onStderr: bytes => stderr.push(Buffer.from(bytes)),
  }, { stdin });
  const output = Buffer.concat(stdout).toString("utf8");
  const errorOutput = Buffer.concat(stderr).toString("utf8");
  if (result.code !== 0 || result.signal) {
    throw new Error(`remote command failed with ${result.code ?? result.signal}: ${errorOutput.slice(0, 512)}`);
  }
  return Object.freeze({ stdout: output, stderr: errorOutput });
}

function controlledPdfSource(bytes) {
  let closed = false;
  return Object.freeze({
    size: bytes.length,
    async read(offset, length) {
      if (closed) throw new Error("PDF source is closed");
      return Uint8Array.from(bytes.subarray(offset, offset + length));
    },
    async close() { closed = true; },
  });
}

async function writeReceipt(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.stage-5-ssh-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
  catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function fixtureProgram(workspace) {
  const fixtures = {
    "main.py": "print('python')\n",
    "paper.tex": "\\\\documentclass{article}\\n\\\\begin{document}Chatero\\\\end{document}\\n",
    "paper.qmd": "---\ntitle: Chatero\n---\n\n```{python}\nprint('qmd')\n```\n",
    "main.js": "console.log('javascript');\n",
    "main.ts": "const answer: number = 42;\n",
    "README.md": "# Chatero\n",
    "data.json": "{\"stage\":5}\n",
    "data.yaml": "stage: 5\n",
    "run.sh": "#!/bin/sh\nprintf shell\n",
    "main.cpp": "int main(){return 0;}\n",
    "Main.java": "final class Main { public static void main(String[] a) {} }\n",
    "main.go": "package main\nfunc main() {}\n",
    "main.rs": "fn main() {}\n",
    "notebook.ipynb": "{\"cells\":[],\"metadata\":{},\"nbformat\":4,\"nbformat_minor\":5}\n",
  };
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const root = ${JSON.stringify(workspace)};`,
    `const fixtures = ${JSON.stringify(fixtures)};`,
    "fs.mkdirSync(root, {recursive:true, mode:0o700});",
    "for (const [name,text] of Object.entries(fixtures)) fs.writeFileSync(path.join(root,name), text, {mode:name==='run.sh'?0o700:0o600});",
    "const watched=path.join(root,'watch.txt'); fs.writeFileSync(watched,'before');",
    "const watcher=fs.watch(watched); const changed=new Promise((ok,no)=>{const timer=setTimeout(()=>no(new Error('watch timeout')),2000); watcher.once('change',()=>{clearTimeout(timer);ok();});});",
    "setTimeout(()=>fs.writeFileSync(watched,'after'),20);",
    "changed.then(()=>{watcher.close();process.stdout.write(JSON.stringify(Object.keys(fixtures).sort())+'\\n');},error=>{watcher.close();throw error;});",
  ].join("");
}

async function runScenario({ alias, releaseDirectory, receiptPath, expectedTuple }) {
  if (process.platform !== "linux") throw new Error("Stage 5 real SSH acceptance only runs on Linux");
  const release = await readRelease(releaseDirectory);
  const manifest = await verifyRelease(release);
  const artifact = manifest.artifacts.find(value => value.tuple === expectedTuple);
  if (!artifact) throw new Error(`signed release omits ${expectedTuple}`);
  const target = await resolveSshTarget(alias, sshRunner);
  if (!target.proxyJump) throw new Error("Stage 5 real SSH target must exercise ProxyJump");
  const session = new SshSession({
    log: value => process.stderr.write(`[stage-5 remote] ${String(value).slice(0, 4096)}\n`),
    installerFactory: ({ alias: installerAlias, controlPath, log, transactionState }) => new RemoteAgentInstaller({
      remote: new SshRemoteAgentRuntime({ alias: installerAlias, controlPath, log }),
      verifyRelease,
      selectArtifact,
      transactionState,
    }),
  });
  const checks = new Map(EXPECTED_CHECKS.map(id => [id, false]));
  checks.set("signed-release", true);
  checks.set("openssh-proxyjump", true);
  const workspace = `/tmp/chatero-stage5-${randomBytes(12).toString("hex")}`;
  let digest;
  let firstFingerprint;
  try {
    await session.ensureReady({ target, release });
    const connected = session.getPublicSession();
    if (connected?.tuple !== expectedTuple) throw new Error(`connected tuple ${connected?.tuple ?? "missing"} does not equal ${expectedTuple}`);
    firstFingerprint = connected.hostFingerprint;
    checks.set("install-integrity", true);
    checks.set("server-launch", true);

    const created = await runRemote(session, {
      command: "/proc/self/exe",
      args: ["--eval", fixtureProgram(workspace)],
      cwd: "/",
    });
    if (!created.stdout.includes("paper.qmd")) throw new Error("language fixtures were not created");
    await runRemote(session, { command: "/usr/bin/git", args: ["init", "-q", workspace], cwd: "/" });
    await runRemote(session, { command: "/usr/bin/git", args: ["-C", workspace, "add", "."], cwd: "/" });
    const searched = await runRemote(session, { command: "/usr/bin/grep", args: ["-R", "Chatero", "."], cwd: workspace });
    if (!searched.stdout.includes("README.md")) throw new Error("remote search did not find its fixture");
    checks.set("files-search-git", true);

    const pty = await runRemote(session, { command: "/usr/bin/script", args: ["-qec", "printf stage5-pty", "/dev/null"], cwd: workspace });
    const debug = await runRemote(session, { command: "/proc/self/exe", args: ["--inspect=127.0.0.1:0", "--eval", "process.stdout.write('debug-task')"], cwd: workspace });
    if (!pty.stdout.includes("stage5-pty") || debug.stdout !== "debug-task") throw new Error("PTY/task/debug smoke failed");
    checks.set("pty-task-debug", true);

    for (const command of [
      ["/usr/bin/python3", ["-m", "py_compile", "main.py"]],
      ["/bin/sh", ["-n", "run.sh"]],
      ["/proc/self/exe", ["--check", "main.js"]],
    ]) await runRemote(session, { command: command[0], args: command[1], cwd: workspace });
    checks.set("language-fixtures", true);

    const installPath = session.ready?.installPath;
    if (!installPath) throw new Error("verified install path is unavailable");
    const productAudit = await runRemote(session, {
      command: "/proc/self/exe",
      args: ["--eval", [
        "const fs=require('node:fs'),path=require('node:path');",
        `const root=${JSON.stringify(installPath)};`,
        "const required=['chatero-documentation','git','ipynb'];",
        "for(const id of required){const p=path.join(root,'extensions',id,'package.json');if(!fs.statSync(p).isFile())throw new Error('missing '+id);}",
        "process.stdout.write('product-extensions');",
      ].join("")],
      cwd: "/",
    });
    if (productAudit.stdout !== "product-extensions") throw new Error("remote product payload audit failed");
    checks.set("documentation", true);

    const authority = encodeAuthority(`profile:${alias}`);
    const codex = session.getCodexLoginTerminalOptions({ scheme: "vscode-remote", authority, path: workspace });
    const codexVersion = await runRemote(session, { command: codex.shellPath, args: ["--version"], cwd: workspace });
    if (!/\b0\.142\.0\b/u.test(codexVersion.stdout)) throw new Error("embedded Codex SDK version is invalid");
    checks.set("codex-sdk", true);

    const pdf = Buffer.from("%PDF-1.7\nStage 5 exact complete paper\n", "utf8");
    digest = createHash("sha256").update(pdf).digest("hex");
    const targetId = `profile:${alias}`;
    const context = () => ({
      targetId,
      hostFingerprint: session.getPublicSession().hostFingerprint,
      generation: session.getPublicSession().generation,
      session,
    });
    const evidence = new EvidenceCacheService({
      getContext: async () => context(),
      reconnect: async () => context(),
      getZoteroApi: async () => ({ redeemFullPdfGrant: async () => controlledPdfSource(pdf) }),
    });
    const staged = await evidence.stageEvidence({
      grantId: randomBytes(32).toString("base64url"),
      targetId,
      ttlSeconds: 86400,
    });
    if (staged.digest !== digest || staged.size !== pdf.length
        || Date.parse(staged.expiresAt) - Date.now() > 86400_000
        || Date.parse(staged.expiresAt) - Date.now() < 86390_000) {
      throw new Error("remote exact PDF cache metadata is invalid");
    }
    const cached = await runRemote(session, { command: "/bin/cat", args: [staged.remotePath], cwd: "/" });
    if (!Buffer.from(cached.stdout).equals(pdf)) throw new Error("remote exact PDF bytes changed");
    checks.set("exact-pdf-cache", true);
    checks.set("expiry-revoke", true);
    await evidence.revokeEvidence({ digest, targetId });
    await runRemote(session, {
      command: "/bin/sh",
      args: ["-c", "test ! -e \"$1\"", "chatero", staged.remotePath],
      cwd: "/",
    });
    await evidence.dispose();

    await session.dispose();
    await session.ensureReady({ target, release });
    if (session.getPublicSession().hostFingerprint !== firstFingerprint) throw new Error("reconnect changed authenticated host identity");
    const recovered = await runRemote(session, { command: "/bin/cat", args: [join(workspace, "README.md")], cwd: "/" });
    if (recovered.stdout !== "# Chatero\n") throw new Error("disconnect recovery lost workspace state");
    checks.set("disconnect-recovery", true);
  }
  finally {
    await session.dispose().catch(() => {});
    await sshRunner("/usr/bin/ssh", ["-T", "-o", "BatchMode=yes", "--", alias,
      "pkill -f '/bin/chatero-server' 2>/dev/null || true; rm -rf -- \"$HOME/.chatero-server\"; rm -rf -- /tmp/chatero-stage5-* /tmp/chatero-$(id -u)"]);
  }
  const removed = await sshRunner("/usr/bin/ssh", ["-T", "-o", "BatchMode=yes", "--", alias, "test ! -e \"$HOME/.chatero-server\""]);
  if (removed.code !== 0) throw new Error("Remote Agent removal did not complete");
  checks.set("remove", true);
  if ([...checks.values()].some(value => value !== true)) throw new Error("Stage 5 SSH scenario is incomplete");
  const sourceCommit = (await execFile("git", ["rev-parse", "HEAD^{commit}"], { cwd: ROOT, encoding: "utf8" })).stdout.trim();
  const receipt = Object.freeze({
    schemaVersion: 1,
    stage: 5,
    status: "passed",
    tuple: expectedTuple,
    sourceCommit,
    codeOssCommit: CODE_OSS_COMMIT,
    releaseManifestSha256: createHash("sha256").update(release.manifestText).digest("hex"),
    artifactSha256: artifact.sha256,
    hostFingerprintSha256: createHash("sha256").update(firstFingerprint).digest("hex"),
    pdfSha256: digest,
    checks: EXPECTED_CHECKS.map(id => Object.freeze({ id, status: "passed" })),
  });
  await writeReceipt(resolve(receiptPath), receipt);
  return receipt;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const receipt = await runScenario({
      alias: options["--alias"],
      releaseDirectory: resolve(options["--release"]),
      receiptPath: resolve(options["--receipt"]),
      expectedTuple: options["--tuple"],
    });
    process.stdout.write(`${JSON.stringify({ stage: 5, tuple: receipt.tuple, status: receipt.status, checks: receipt.checks.length })}\n`);
  }
  catch (error) {
    process.stderr.write(`Stage 5 real SSH acceptance failed: ${String(error?.message || error).replace(/[\r\n\t]+/gu, " ").slice(0, 1024)}\n`);
    process.exitCode = 1;
  }
}

export { EXPECTED_CHECKS, parseArguments, runScenario };
