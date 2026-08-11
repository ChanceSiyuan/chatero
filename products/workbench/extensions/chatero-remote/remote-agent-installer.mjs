import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";

import { assertConcreteAlias, OPENSSH_EXECUTABLE } from "./openssh-targets.mjs";

const MAX_REMOTE_OUTPUT = 1024 * 1024;
const SAFE_CONTROL_PATH = /^\/[A-Za-z0-9_./-]+$/;
const SAFE_RELEASE_TOKEN = /^[A-Za-z0-9._/-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const REMOTE_PLATFORM_PROBE = "uname -s; uname -m; uname -r";

const PART_SIZE_SCRIPT = [
  "set -eu",
  "umask 077",
  "p=\"$HOME/$1\"",
  "limit=$2",
  "mkdir -p \"$(dirname \"$p\")\"",
  "chmod 700 \"$(dirname \"$p\")\"",
  "if [ -L \"$p\" ]; then exit 71; fi",
  "if [ ! -e \"$p\" ]; then : >\"$p\"; chmod 600 \"$p\"; fi",
  "if [ ! -f \"$p\" ]; then exit 72; fi",
  "size=$(wc -c <\"$p\" | tr -d ' ')",
  "case \"$size\" in ''|*[!0-9]*) exit 73;; esac",
  "[ \"$size\" -le \"$limit\" ] || exit 74",
  "printf '%s\\n' \"$size\"",
].join("; ");

const UPLOAD_SCRIPT = [
  "set -eu",
  "umask 077",
  "p=\"$HOME/$1\"",
  "offset=$2",
  "[ -f \"$p\" ] && [ ! -L \"$p\" ]",
  "actual=$(wc -c <\"$p\" | tr -d ' ')",
  "[ \"$actual\" = \"$offset\" ]",
  "cat >>\"$p\"",
  "chmod 600 \"$p\"",
].join("; ");

const FINALIZE_SCRIPT = [
  "set -eu",
  "umask 077",
  "part=\"$HOME/$1\"",
  "destination=\"$HOME/$2\"",
  "root=$3",
  "digest=$4",
  "actual=$(sha256sum \"$part\" | awk '{print $1}')",
  "[ \"$actual\" = \"$digest\" ]",
  "if [ -d \"$destination\" ] && [ ! -L \"$destination\" ] && [ \"$(cat \"$destination/.chatero-release-sha256\" 2>/dev/null || true)\" = \"$digest\" ]; then rm -f \"$part\"; exit 0; fi",
  "[ ! -e \"$destination\" ]",
  "parent=$(dirname \"$destination\")",
  "mkdir -p \"$parent\"",
  "chmod 700 \"$parent\"",
  "tmp=\"$parent/.installing-${digest%????????????????????????????????????????????????????}-$$\"",
  "trap 'rm -rf \"$tmp\"' EXIT HUP INT TERM",
  "mkdir \"$tmp\"",
  "chmod 700 \"$tmp\"",
  "tar -xzf \"$part\" -C \"$tmp\"",
  "[ -d \"$tmp/$root\" ] && [ ! -L \"$tmp/$root\" ]",
  "[ -x \"$tmp/$root/bin/chatero-server\" ]",
  "printf '%s\\n' \"$digest\" >\"$tmp/$root/.chatero-release-sha256\"",
  "if ! mv -T \"$tmp/$root\" \"$destination\"; then",
  "  if [ -d \"$destination\" ] && [ ! -L \"$destination\" ] && [ \"$(cat \"$destination/.chatero-release-sha256\" 2>/dev/null || true)\" = \"$digest\" ]; then rm -rf \"$tmp/$root\"; else exit 75; fi",
  "fi",
  "rmdir \"$tmp\"",
  "rm -f \"$part\"",
  "trap - EXIT HUP INT TERM",
].join("\n");

const CREATE_RUNTIME_SCRIPT = [
  "set -eu",
  "umask 077",
  "install=\"$HOME/$1\"",
  "runtime=${XDG_RUNTIME_DIR:-/tmp/chatero-$(id -u)}",
  "case \"$runtime\" in /*) ;; *) exit 81;; esac",
  "clean_runtime=$(printf '%s' \"$runtime\" | tr -d '\\r\\n')",
  "[ \"$clean_runtime\" = \"$runtime\" ] || exit 82",
  "[ \"${#runtime}\" -le 60 ] || runtime=/tmp/chatero-$(id -u)",
  "[ ! -L \"$runtime\" ] || exit 85",
  "mkdir -p \"$runtime\"",
  "chmod 700 \"$runtime\"",
  "[ \"$(stat -c %u \"$runtime\")\" = \"$(id -u)\" ]",
  "[ \"$(stat -c %a \"$runtime\")\" = 700 ]",
  "nonce=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')",
  "token_file=\"$runtime/t-$nonce\"",
  "agent_socket=\"$runtime/a-$nonce.sock\"",
  "server_log=\"$runtime/s-$nonce.log\"",
  "IFS= read -r token",
  "[ -n \"$token\" ]",
  "printf '%s' \"$token\" >\"$token_file\"",
  "chmod 600 \"$token_file\"",
  "VSCODE_AGENT_HOST_CODEX_AGENT_ENABLED=true VSCODE_AGENT_HOST_CODEX_SDK_ROOT=\"$install/agent-sdk/codex\" VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED=false VSCODE_AGENT_HOST_BYOK_MODELS_ENABLED=false nohup \"$install/bin/chatero-server\" --host=127.0.0.1 --port=0 --connection-token-file=\"$token_file\" --agent-host-path=\"$agent_socket\" >\"$server_log\" 2>&1 </dev/null &",
  "server_pid=$!",
  "port=''",
  "tries=0",
  "while [ \"$tries\" -lt 200 ]; do",
  "  if ! kill -0 \"$server_pid\" 2>/dev/null; then cat \"$server_log\" >&2; exit 83; fi",
  "  port=$(sed -n 's/^Extension host agent listening on \\([0-9][0-9]*\\)$/\\1/p' \"$server_log\" | tail -n 1)",
  "  [ -n \"$port\" ] && break",
  "  tries=$((tries + 1))",
  "  sleep 0.05",
  "done",
  "case \"$port\" in ''|*[!0-9]*) kill \"$server_pid\" 2>/dev/null || true; exit 84;; esac",
  "rm -f \"$token_file\"",
  "printf '%s\\n%s\\n' \"$port\" \"$agent_socket\"",
].join("\n");

export const REMOTE_AGENT_SCRIPTS = Object.freeze({
  partSize: PART_SIZE_SCRIPT,
  upload: UPLOAD_SCRIPT,
  finalize: FINALIZE_SCRIPT,
  createRuntime: CREATE_RUNTIME_SCRIPT,
});

export function parseRemotePlatform(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 4096) {
    throw new TypeError("unsupported or malformed remote platform response");
  }
  const [system, rawArch, kernel, ...extra] = output.trim().split(/\r?\n/u);
  if (extra.length || system !== "Linux" || !kernel || /[\0\r\n]/u.test(kernel)) {
    throw new Error("unsupported remote operating system");
  }
  const arch = rawArch === "x86_64" || rawArch === "amd64" ? "x86_64"
    : rawArch === "aarch64" || rawArch === "arm64" ? "aarch64"
      : null;
  if (!arch) throw new Error(`unsupported remote Linux architecture ${rawArch ?? ""}`.trim());
  return Object.freeze({
    os: "linux",
    arch,
    kernel,
    tuple: `linux-${arch}`,
  });
}

function assertReleaseToken(value, label) {
  if (typeof value !== "string" || !SAFE_RELEASE_TOKEN.test(value) || value.includes("..")) {
    throw new TypeError(`${label} is not a safe release token`);
  }
  return value;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function remoteCommand(script, args = []) {
  return ["sh", "-c", script, "chatero", ...args].map(shellQuote).join(" ");
}

function sshBaseArguments(controlPath, alias) {
  assertConcreteAlias(alias);
  if (!isAbsolute(controlPath) || !SAFE_CONTROL_PATH.test(controlPath)) {
    throw new TypeError("SSH control path is invalid");
  }
  return ["-T", "-S", controlPath, "-o", "BatchMode=yes", "--", alias];
}

async function writeInput(stream, input) {
  if (input === undefined || input === null) {
    stream.end();
    return;
  }
  const chunks = Buffer.isBuffer(input) || input instanceof Uint8Array ? [input] : input;
  for await (const chunk of chunks) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      throw new TypeError("remote stdin source returned non-byte data");
    }
    if (!stream.write(Buffer.from(chunk))) {
      await new Promise(resolve => stream.once("drain", resolve));
    }
  }
  stream.end();
}

async function skipBytes(source, offset) {
  let remaining = offset;
  async function* generate() {
    const chunks = Buffer.isBuffer(source) || source instanceof Uint8Array ? [source] : source;
    for await (const input of chunks) {
      let chunk = Buffer.from(input);
      if (remaining >= chunk.length) {
        remaining -= chunk.length;
        continue;
      }
      if (remaining) {
        chunk = chunk.subarray(remaining);
        remaining = 0;
      }
      yield chunk;
    }
    if (remaining !== 0) throw new Error("resume offset exceeds local release artifact size");
  }
  return generate();
}

export class SshRemoteAgentRuntime {
  constructor({
    alias,
    controlPath,
    spawn = spawnChild,
    log = () => {},
  }) {
    this.alias = assertConcreteAlias(alias);
    this.controlPath = controlPath;
    this.spawn = spawn;
    this.log = log;
    sshBaseArguments(controlPath, alias);
  }

  async #exec(script, args = [], { input, signal } = {}) {
    const command = remoteCommand(script, args);
    const child = this.spawn(OPENSSH_EXECUTABLE, [
      ...sshBaseArguments(this.controlPath, this.alias),
      command,
    ], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    const collect = destination => chunk => {
      size += chunk.length;
      if (size > MAX_REMOTE_OUTPUT) {
        child.kill("SIGTERM");
        return;
      }
      destination.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    const writing = writeInput(child.stdin, input).catch(error => {
      child.kill("SIGTERM");
      throw error;
    });
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal }));
    });
    await writing;
    if (size > MAX_REMOTE_OUTPUT) throw new Error("remote bootstrap output exceeded 1 MiB");
    const errorText = Buffer.concat(stderr).toString("utf8").trim();
    if (errorText) this.log(errorText);
    if (result.code !== 0) {
      const error = new Error(`remote bootstrap exited with ${result.code ?? result.signal}`);
      error.code = result.code === 255 ? "SSH_TRANSPORT" : "REMOTE_BOOTSTRAP";
      throw error;
    }
    return Buffer.concat(stdout).toString("utf8");
  }

  probe({ signal } = {}) {
    return this.#exec(REMOTE_PLATFORM_PROBE, [], { signal });
  }

  async partSize({ partRelativePath, artifactSize, signal }) {
    const output = await this.#exec(PART_SIZE_SCRIPT, [
      partRelativePath,
      String(artifactSize),
    ], { signal });
    const size = Number(output.trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > artifactSize) {
      throw new Error("remote partial artifact has an invalid byte count");
    }
    return size;
  }

  async upload({ partRelativePath, source, offset, signal }) {
    const input = await skipBytes(await source(), offset);
    await this.#exec(UPLOAD_SCRIPT, [partRelativePath, String(offset)], { input, signal });
  }

  async finalize({
    partRelativePath,
    installRelativePath,
    archiveRoot,
    sha256,
    signal,
  }) {
    await this.#exec(FINALIZE_SCRIPT, [
      partRelativePath,
      installRelativePath,
      archiveRoot,
      sha256,
    ], { signal });
  }

  async createRuntime({ installRelativePath, connectionToken, signal }) {
    const output = await this.#exec(CREATE_RUNTIME_SCRIPT, [installRelativePath], {
      input: Buffer.from(`${connectionToken}\n`, "utf8"),
      signal,
    });
    const [portText, agentHostPath, ...extra] = output.trim().split(/\r?\n/u);
    const remotePort = Number(portText);
    if (extra.length || !Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65535
      || !isAbsolute(agentHostPath) || /[\0\r\n]/u.test(agentHostPath) || Buffer.byteLength(agentHostPath) > 100) {
      throw new Error("remote agent returned invalid readiness data");
    }
    return Object.freeze({ remotePort, agentHostPath });
  }
}

async function defaultContracts() {
  return import("./runtime/release-contract.mjs");
}

export class RemoteAgentInstaller {
  constructor({
    remote,
    verifyRelease,
    selectArtifact,
    randomToken = () => randomBytes(32).toString("base64url"),
  }) {
    if (!remote) throw new TypeError("remote runtime is required");
    this.remote = remote;
    this.verify = verifyRelease;
    this.select = selectArtifact;
    this.randomToken = randomToken;
  }

  async ensureInstalled({ alias, controlPath, release, signal }) {
    assertConcreteAlias(alias);
    if (signal?.aborted) throw signal.reason ?? new Error("remote agent installation was cancelled");
    const contracts = !this.verify || !this.select ? await defaultContracts() : null;
    const verifyRelease = this.verify ?? contracts.verifyRelease;
    const selectArtifact = this.select ?? contracts.selectArtifact;
    const manifest = await verifyRelease(release);
    const hostPlatform = parseRemotePlatform(await this.remote.probe({ alias, controlPath, signal }));
    const artifact = selectArtifact(manifest, {
      commit: manifest.codeOssCommit,
      tuple: hostPlatform.tuple,
    });
    assertReleaseToken(manifest.codeOssCommit, "Code-OSS commit");
    assertReleaseToken(hostPlatform.tuple, "remote tuple");
    assertReleaseToken(artifact.filename, "artifact filename");
    if (!SHA256.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 1) {
      throw new TypeError("verified artifact metadata is malformed");
    }
    const partRelativePath = `.chatero-server/cache/${manifest.codeOssCommit}/${artifact.filename}.part`;
    const installRelativePath = `.chatero-server/bin/${manifest.codeOssCommit}/${hostPlatform.tuple}`;
    const archiveRoot = `chatero-agent-${hostPlatform.tuple}`;
    const offset = await this.remote.partSize({
      alias,
      controlPath,
      partRelativePath,
      artifactSize: artifact.size,
      signal,
    });
    if (offset < artifact.size) {
      await this.remote.upload({
        alias,
        controlPath,
        partRelativePath,
        offset,
        source: () => release.readArtifact(artifact.filename),
        signal,
      });
    }
    await this.remote.finalize({
      alias,
      controlPath,
      partRelativePath,
      installRelativePath,
      archiveRoot,
      sha256: artifact.sha256,
      signal,
    });
    const connectionToken = this.randomToken();
    if (typeof connectionToken !== "string" || !/^[A-Za-z0-9_-]{32,256}$/u.test(connectionToken)) {
      throw new Error("connection token generator returned invalid secret material");
    }
    const runtime = await this.remote.createRuntime({
      alias,
      controlPath,
      installRelativePath,
      connectionToken,
      signal,
    });
    return Object.freeze({
      ...runtime,
      connectionToken,
      installRelativePath,
      tuple: hostPlatform.tuple,
      hostPlatform,
    });
  }
}
