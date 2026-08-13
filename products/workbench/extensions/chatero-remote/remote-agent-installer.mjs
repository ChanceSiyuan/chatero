import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute, posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { assertConcreteAlias, OPENSSH_EXECUTABLE } from "./openssh-targets.mjs";

const MAX_REMOTE_OUTPUT = 1024 * 1024;
const SAFE_CONTROL_PATH = /^\/[A-Za-z0-9_./-]+$/;
const SAFE_RELEASE_TOKEN = /^[A-Za-z0-9._/-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TRANSACTION_ID = /^[0-9a-f]{24}$/;

export const REMOTE_PLATFORM_PROBE = "uname -s; uname -m; uname -r";

const SAFE_REMOTE_FS = [
  "uid=$(id -u)",
  "home=$(cd -P \"$HOME\" && pwd)",
  "safe_permissions() {",
  "  mode=$(stat -c %a \"$1\") || return 1",
  "  [ $((0$mode & 0022)) -eq 0 ]",
  "}",
  "safe_dir() {",
  "  d=$1",
  "  [ -d \"$d\" ] && [ ! -L \"$d\" ] || return 1",
  "  [ \"$(stat -c %u \"$d\")\" = \"$uid\" ] || return 1",
  "  safe_permissions \"$d\"",
  "}",
  "safe_owner_dir() { safe_dir \"$1\" && [ \"$(stat -c %a \"$1\")\" = 700 ]; }",
  "safe_file() {",
  "  f=$1",
  "  [ -f \"$f\" ] && [ ! -L \"$f\" ] || return 1",
  "  [ \"$(stat -c %u \"$f\")\" = \"$uid\" ] || return 1",
  "  [ \"$(stat -c %h \"$f\")\" = 1 ] || return 1",
  "  safe_permissions \"$f\"",
  "}",
  "safe_marker() { safe_file \"$1\" && [ \"$(stat -c %a \"$1\")\" = 600 ]; }",
  "safe_part() { safe_marker \"$1\"; }",
  "safe_executable() { safe_file \"$1\" && [ -x \"$1\" ]; }",
  "safe_chain() {",
  "  target=$1",
  "  case \"$target\" in \"$home\"/.chatero-server|\"$home\"/.chatero-server/*) ;; *) return 1;; esac",
  "  relative=${target#\"$home\"/}",
  "  current=$home",
  "  oldifs=$IFS; IFS=/; set -- $relative; IFS=$oldifs",
  "  for component do current=$current/$component; safe_owner_dir \"$current\" || return 1; done",
  "  canonical=$(cd -P \"$target\" && pwd) || return 1",
  "  case \"$canonical\" in \"$home\"/.chatero-server|\"$home\"/.chatero-server/*) ;; *) return 1;; esac",
  "}",
  "ensure_chain() {",
  "  target=$1",
  "  case \"$target\" in \"$home\"/.chatero-server|\"$home\"/.chatero-server/*) ;; *) return 1;; esac",
  "  relative=${target#\"$home\"/}",
  "  current=$home",
  "  oldifs=$IFS; IFS=/; set -- $relative; IFS=$oldifs",
  "  for component do",
  "    current=$current/$component",
  "    if [ ! -e \"$current\" ] && [ ! -L \"$current\" ]; then",
  "      mkdir -m 700 \"$current\" 2>/dev/null || safe_owner_dir \"$current\" || return 1",
  "    fi",
  "    safe_owner_dir \"$current\" || return 1",
  "  done",
  "  safe_chain \"$target\"",
  "}",
  "safe_internal_chain() {",
  "  base=$1; target=$2",
  "  case \"$target\" in \"$base\"|\"$base\"/*) ;; *) return 1;; esac",
  "  relative=${target#\"$base\"/}",
  "  current=$base",
  "  oldifs=$IFS; IFS=/; set -- $relative; IFS=$oldifs",
  "  for component do current=$current/$component; safe_dir \"$current\" || return 1; done",
  "  canonical=$(cd -P \"$target\" && pwd) || return 1",
  "  case \"$canonical\" in \"$base\"|\"$base\"/*) ;; *) return 1;; esac",
  "}",
  "assert_transaction_relative() {",
  "  printf '%s\\n' \"$1\" | grep -Eq '^\\.chatero-server/transactions/[0-9a-f]{40}/[0-9a-f]{24}\\.part$'",
  "}",
  "assert_install_relative() {",
  "  printf '%s\\n' \"$1\" | grep -Eq '^\\.chatero-server/artifacts-v1/[0-9a-f]{64}/[0-9a-f]{40}/linux-(x86_64|aarch64)$'",
  "}",
  "file_snapshot() { safe_file \"$1\" && stat -Lc '%d:%i:%h:%u:%a:%s:%y:%z' \"$1\"; }",
  "proc_state_start() {",
  "  proc=$1",
  "  [ -r \"/proc/$proc/stat\" ] || return 1",
  "  fields=$(sed 's/^[^)]*) //' \"/proc/$proc/stat\") || return 1",
  "  set -- $fields",
  "  [ \"$#\" -ge 20 ] || return 1",
  "  printf '%s %s\\n' \"$1\" \"${20}\"",
  "}",
  "process_identity_alive() {",
  "  expected_boot=$1; expected_pid=$2; expected_start=$3",
  "  [ \"$expected_boot\" = \"$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)\" ] || return 1",
  "  case \"$expected_pid:$expected_start\" in *[!0-9:]*) return 1;; esac",
  "  identity=$(proc_state_start \"$expected_pid\") || return 1",
  "  set -- $identity",
  "  [ \"$#\" = 2 ] || return 1",
  "  [ \"$1\" != Z ] && [ \"$2\" = \"$expected_start\" ] && kill -0 \"$expected_pid\" 2>/dev/null",
  "}",
  "verify_install() {",
  "  install=$1; expected=$2; tuple=$3; tree_digest=$4; node_digest=$5; verifier_digest=$6",
  "  for signed_digest in \"$expected\" \"$tree_digest\" \"$node_digest\" \"$verifier_digest\"; do",
  "    printf '%s\\n' \"$signed_digest\" | grep -Eq '^[0-9a-f]{64}$' || return 1",
  "  done",
  "  case \"$tuple\" in linux-x86_64|linux-aarch64) ;; *) return 1;; esac",
  "  case \"${install##*/}\" in \"$tuple\"|\"chatero-agent-$tuple\") ;; *) return 1;; esac",
  "  safe_chain \"$install\" || return 1",
  "  marker=$install/.chatero-release-sha256",
  "  safe_marker \"$marker\" && [ \"$(cat \"$marker\")\" = \"$expected\" ] || return 1",
  "  manifest=$install/integrity/tree.v1.json",
  "  verifier=$install/bin/chatero-install-integrity.mjs",
  "  node=$install/node",
  "  safe_internal_chain \"$install\" \"$(dirname \"$manifest\")\" || return 1",
  "  safe_internal_chain \"$install\" \"$(dirname \"$verifier\")\" || return 1",
  "  safe_file \"$manifest\" && [ \"$(stat -c %a \"$manifest\")\" = 644 ] || return 1",
  "  safe_executable \"$node\" && safe_executable \"$verifier\" || return 1",
  "  [ \"$(sha256sum \"$manifest\" | awk '{print $1}')\" = \"$tree_digest\" ] || return 1",
  "  [ \"$(sha256sum \"$node\" | awk '{print $1}')\" = \"$node_digest\" ] || return 1",
  "  [ \"$(sha256sum \"$verifier\" | awk '{print $1}')\" = \"$verifier_digest\" ] || return 1",
  "  result=$(\"$node\" \"$verifier\" verify \"$install\" \"$manifest\" \"$tree_digest\") || return 1",
  "  [ \"$result\" = \"{\\\"kind\\\":\\\"verified\\\",\\\"treeManifestSha256\\\":\\\"$tree_digest\\\"}\" ]",
  "}",
].join("\n");

const PART_SIZE_SCRIPT = [
  "set -eu",
  "umask 077",
  SAFE_REMOTE_FS,
  "assert_transaction_relative \"$1\"",
  "p=\"$home/$1\"",
  "limit=$2",
  "case \"$limit\" in ''|*[!0-9]*) exit 73;; esac",
  "ensure_chain \"$(dirname \"$p\")\"",
  "if [ ! -e \"$p\" ] && [ ! -L \"$p\" ]; then",
  "  (set -C; : >\"$p\") 2>/dev/null || true",
  "fi",
  "safe_part \"$p\" || exit 72",
  "size=$(stat -Lc %s \"$p\")",
  "case \"$size\" in ''|*[!0-9]*) exit 73;; esac",
  "[ \"$size\" -le \"$limit\" ] || exit 74",
  "printf '%s\\n' \"$size\"",
].join("\n");

const UPLOAD_SCRIPT = [
  "set -eu",
  "umask 077",
  SAFE_REMOTE_FS,
  "assert_transaction_relative \"$1\"",
  "p=\"$home/$1\"",
  "offset=$2",
  "case \"$offset\" in ''|*[!0-9]*) exit 73;; esac",
  "safe_chain \"$(dirname \"$p\")\"",
  "safe_part \"$p\"",
  "identity=$(stat -Lc '%d:%i' \"$p\")",
  "actual=$(stat -Lc %s \"$p\")",
  "[ \"$actual\" = \"$offset\" ]",
  "exec 3>>\"$p\"",
  "fd=/proc/$$/fd/3",
  "[ \"$(stat -Lc '%d:%i' \"$fd\")\" = \"$identity\" ]",
  "case \"$(stat -Lc %F \"$fd\")\" in 'regular file'|'regular empty file') ;; *) exit 77;; esac",
  "[ \"$(stat -Lc %u \"$fd\")\" = \"$uid\" ] && [ \"$(stat -Lc %h \"$fd\")\" = 1 ] && [ \"$(stat -Lc %a \"$fd\")\" = 600 ]",
  "cat >&3",
  "[ \"$(stat -Lc '%d:%i' \"$fd\")\" = \"$identity\" ] && [ \"$(stat -Lc %h \"$fd\")\" = 1 ] && [ \"$(stat -Lc %a \"$fd\")\" = 600 ]",
  "exec 3>&-",
  "safe_part \"$p\" && [ \"$(stat -Lc '%d:%i' \"$p\")\" = \"$identity\" ]",
].join("\n");

const PROBE_INSTALLED_SCRIPT = [
  "set -eu",
  SAFE_REMOTE_FS,
  "destination=\"$home/$1\"",
  "digest=$2",
  "if ! verify_install \"$destination\" \"$digest\" \"${destination##*/}\" \"$3\" \"$4\" \"$5\"; then printf 'missing\\n'; exit 0; fi",
  "printf 'ready\\n'",
].join("\n");

const DISCARD_PART_SCRIPT = [
  "set -eu",
  SAFE_REMOTE_FS,
  "assert_transaction_relative \"$1\"",
  "p=\"$home/$1\"",
  "if [ ! -e \"$p\" ] && [ ! -L \"$p\" ]; then exit 0; fi",
  "safe_chain \"$(dirname \"$p\")\"",
  "safe_part \"$p\" || exit 78",
  "rm -f -- \"$p\"",
].join("\n");

const FINALIZE_SCRIPT = [
  "set -eu",
  "umask 077",
  SAFE_REMOTE_FS,
  "assert_transaction_relative \"$1\"",
  "assert_install_relative \"$2\"",
  "part=\"$home/$1\"",
  "destination=\"$home/$2\"",
  "root=$3",
  "digest=$4",
  "tree_digest=$5; node_digest=$6; verifier_digest=$7",
  "case \"$root\" in chatero-agent-linux-x86_64) tuple=linux-x86_64;; chatero-agent-linux-aarch64) tuple=linux-aarch64;; *) exit 79;; esac",
  "[ \"${destination##*/}\" = \"$tuple\" ] || exit 79",
  "[ \"$digest\" = \"$(printf '%s\\n' \"$2\" | cut -d/ -f3)\" ] || exit 79",
  "safe_chain \"$(dirname \"$part\")\"",
  "safe_part \"$part\"",
  "part_identity=$(stat -Lc '%d:%i' \"$part\")",
  "parent=$(dirname \"$destination\")",
  "ensure_chain \"$parent\"",
  "if [ -e \"$destination\" ] || [ -L \"$destination\" ]; then",
  "  if verify_install \"$destination\" \"$digest\" \"$tuple\" \"$tree_digest\" \"$node_digest\" \"$verifier_digest\"; then",
  "    safe_part \"$part\" && [ \"$(stat -Lc '%d:%i' \"$part\")\" = \"$part_identity\" ] && rm -f -- \"$part\"",
  "    exit 0",
  "  fi",
  "  safe_owner_dir \"$destination\" || exit 75",
  "  rm -rf -- \"$destination\"",
  "  [ ! -e \"$destination\" ] && [ ! -L \"$destination\" ] || exit 75",
  "fi",
  "boot_id=$(cat /proc/sys/kernel/random/boot_id)",
  "printf '%s\\n' \"$boot_id\" | grep -Eq '^[0-9a-f-]{36}$'",
  "set -- $(proc_state_start \"$$\")",
  "self_start=$2",
  "for stale in \"$parent\"/.installing.*; do",
  "  [ -e \"$stale\" ] || [ -L \"$stale\" ] || continue",
  "  name=${stale##*/}; identity=${name#.installing.}",
  "  oldifs=$IFS; IFS=.; set -- $identity; IFS=$oldifs",
  "  [ \"$#\" = 4 ] || continue",
  "  stale_boot=$1; stale_pid=$2; stale_start=$3; stale_nonce=$4",
  "  printf '%s\\n' \"$stale_boot.$stale_pid.$stale_start.$stale_nonce\" | grep -Eq '^[0-9a-f-]{36}\\.[0-9]+\\.[0-9]+\\.[0-9a-f]{16}$' || continue",
  "  safe_owner_dir \"$stale\" || continue",
  "  if ! process_identity_alive \"$stale_boot\" \"$stale_pid\" \"$stale_start\"; then rm -rf -- \"$stale\"; fi",
  "done",
  "nonce=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')",
  "tmp=$parent/.installing.$boot_id.$$.${self_start}.$nonce",
  "mkdir -m 700 \"$tmp\"",
  "safe_owner_dir \"$tmp\"",
  "trap 'rm -rf -- \"$tmp\"' EXIT HUP INT TERM",
  "archive_copy=$tmp/archive.tar.gz",
  "dd if=\"$part\" iflag=nofollow of=\"$archive_copy\" oflag=nofollow conv=excl status=none",
  "safe_part \"$archive_copy\"",
  "before=$(file_snapshot \"$archive_copy\")",
  "actual=$(sha256sum \"$archive_copy\" | awk '{print $1}')",
  "after=$(file_snapshot \"$archive_copy\")",
  "[ \"$before\" = \"$after\" ] && [ \"$actual\" = \"$digest\" ] || exit 76",
  "tar -xzpf \"$archive_copy\" -C \"$tmp\"",
  "safe_part \"$archive_copy\"",
  "[ \"$(file_snapshot \"$archive_copy\")\" = \"$after\" ] || exit 76",
  "[ \"$(sha256sum \"$archive_copy\" | awk '{print $1}')\" = \"$digest\" ] || exit 76",
  "candidate=$tmp/$root",
  "safe_dir \"$candidate\"",
  "chmod 700 \"$candidate\"",
  "safe_owner_dir \"$candidate\"",
  "marker=$candidate/.chatero-release-sha256",
  "[ ! -e \"$marker\" ] && [ ! -L \"$marker\" ] || exit 75",
  "(set -C; printf '%s\\n' \"$digest\" >\"$marker\")",
  "safe_marker \"$marker\"",
  "verify_install \"$candidate\" \"$digest\" \"$tuple\" \"$tree_digest\" \"$node_digest\" \"$verifier_digest\"",
  "mv -T -n \"$candidate\" \"$destination\"",
  "if [ -e \"$candidate\" ] || [ -L \"$candidate\" ]; then",
  "  verify_install \"$destination\" \"$digest\" \"$tuple\" \"$tree_digest\" \"$node_digest\" \"$verifier_digest\" || exit 75",
  "  diff -qr --no-dereference \"$candidate\" \"$destination\" >/dev/null || exit 75",
  "  rm -rf -- \"$candidate\"",
  "fi",
  "verify_install \"$destination\" \"$digest\" \"$tuple\" \"$tree_digest\" \"$node_digest\" \"$verifier_digest\"",
  "safe_part \"$archive_copy\" && rm -f -- \"$archive_copy\"",
  "rmdir \"$tmp\"",
  "if safe_part \"$part\" && [ \"$(stat -Lc '%d:%i' \"$part\")\" = \"$part_identity\" ]; then rm -f -- \"$part\"; fi",
  "trap - EXIT HUP INT TERM",
].join("\n");

const CREATE_RUNTIME_SCRIPT = [
  "set -eu",
  "umask 077",
  SAFE_REMOTE_FS,
  "assert_install_relative \"$1\"",
  "install=\"$home/$1\"",
  "digest=$(printf '%s\\n' \"$1\" | cut -d/ -f3)",
  "case \"$2\" in",
  "  linux-x86_64) native=codex-linux-x64; triple=x86_64-unknown-linux-musl;;",
  "  linux-aarch64) native=codex-linux-arm64; triple=aarch64-unknown-linux-musl;;",
  "  *) exit 86;;",
  "esac",
  "[ \"${install##*/}\" = \"$2\" ]",
  "verify_install \"$install\" \"$digest\" \"$2\" \"$3\" \"$4\" \"$5\"",
  "if [ -n \"${XDG_RUNTIME_DIR:-}\" ]; then",
  "  case \"$XDG_RUNTIME_DIR\" in /*) ;; *) exit 81;; esac",
  "  [ \"$(printf '%s' \"$XDG_RUNTIME_DIR\" | tr -d '\\r\\n')\" = \"$XDG_RUNTIME_DIR\" ] || exit 82",
  "  runtime_bytes=$(printf '%s' \"$XDG_RUNTIME_DIR/chatero\" | wc -c | tr -d ' ')",
  "  if [ \"$runtime_bytes\" -le 70 ]; then",
  "    safe_owner_dir \"$XDG_RUNTIME_DIR\" || exit 85",
  "    runtime=$XDG_RUNTIME_DIR/chatero",
  "  else runtime=/tmp/chatero-$uid; fi",
  "else",
  "  [ -d /tmp ] && [ ! -L /tmp ] || exit 85",
  "  runtime=/tmp/chatero-$uid",
  "fi",
  "if [ ! -e \"$runtime\" ] && [ ! -L \"$runtime\" ]; then",
  "  mkdir -m 700 \"$runtime\" 2>/dev/null || safe_owner_dir \"$runtime\" || exit 85",
  "fi",
  "safe_owner_dir \"$runtime\" || exit 85",
  "server_pid=",
  "token_file=",
  "server_log=",
  "agent_socket=",
  "handoff=0",
  "cleanup_runtime() {",
  "  status=$?",
  "  if [ \"$handoff\" != 1 ] && [ -n \"$server_pid\" ]; then",
  "    kill \"$server_pid\" 2>/dev/null || true",
  "    wait \"$server_pid\" 2>/dev/null || true",
  "  fi",
  "  if [ -n \"$token_file\" ] && safe_marker \"$token_file\"; then rm -f -- \"$token_file\"; fi",
  "  if [ \"$handoff\" != 1 ] && [ -n \"$server_log\" ] && safe_marker \"$server_log\"; then rm -f -- \"$server_log\"; fi",
  "  if [ \"$handoff\" != 1 ] && [ -n \"$agent_socket\" ] && [ -S \"$agent_socket\" ] && [ ! -L \"$agent_socket\" ] && [ \"$(stat -c %u \"$agent_socket\")\" = \"$uid\" ]; then rm -f -- \"$agent_socket\"; fi",
  "  return \"$status\"",
  "}",
  "on_runtime_signal() { exit 1; }",
  "trap cleanup_runtime EXIT",
  "trap on_runtime_signal HUP INT TERM",
  "nonce=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')",
  "case \"$nonce\" in ????????*) ;; *) exit 85;; esac",
  "token_file=$(mktemp \"$runtime/t.XXXXXXXXXX\")",
  "server_log=$(mktemp \"$runtime/s.XXXXXXXXXX.log\")",
  "safe_marker \"$token_file\"",
  "safe_marker \"$server_log\"",
  "agent_socket=\"$runtime/a.$nonce.sock\"",
  "socket_bytes=$(printf '%s' \"$agent_socket\" | wc -c | tr -d ' ')",
  "[ \"$socket_bytes\" -le 100 ] || exit 85",
  "[ ! -e \"$agent_socket\" ] && [ ! -L \"$agent_socket\" ] || exit 85",
  "IFS= read -r token",
  "[ -n \"$token\" ]",
  "printf '%s' \"$token\" | dd of=\"$token_file\" oflag=nofollow conv=nocreat status=none",
  "safe_marker \"$token_file\"",
  "verify_install \"$install\" \"$digest\" \"$2\" \"$3\" \"$4\" \"$5\"",
  "CHATERO_AGENT_INSTALL_ROOT=\"$install\" CHATERO_AGENT_TREE_MANIFEST_SHA256=\"$3\" CHATERO_AGENT_NODE_SHA256=\"$4\" CHATERO_AGENT_INTEGRITY_VERIFIER_SHA256=\"$5\" VSCODE_AGENT_HOST_CODEX_AGENT_ENABLED=true VSCODE_AGENT_HOST_CODEX_SDK_ROOT=\"$install/agent-sdk/codex\" VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED=false VSCODE_AGENT_HOST_BYOK_MODELS_ENABLED=false nohup \"$install/bin/chatero-server\" --host=127.0.0.1 --port=0 --connection-token-file=\"$token_file\" --agent-host-path=\"$agent_socket\" >\"$server_log\" 2>&1 </dev/null &",
  "server_pid=$!",
  "port=''",
  "tries=0",
  "while [ \"$tries\" -lt 200 ]; do",
  "  if ! kill -0 \"$server_pid\" 2>/dev/null; then exit 83; fi",
  "  port=$(sed -n 's/^Extension host agent listening on \\([0-9][0-9]*\\)$/\\1/p' \"$server_log\" | tail -n 1)",
  "  [ -n \"$port\" ] && break",
  "  tries=$((tries + 1))",
  "  sleep 0.05",
  "done",
  "case \"$port\" in ''|*[!0-9]*) kill \"$server_pid\" 2>/dev/null || true; exit 84;; esac",
  "safe_marker \"$token_file\" || exit 85",
  "rm -f -- \"$token_file\"",
  "token_file=",
  "safe_marker \"$server_log\" || exit 85",
  "rm -f -- \"$server_log\"",
  "server_log=",
  "handoff=1",
  "trap - EXIT HUP INT TERM",
  "printf '%s\\n%s\\n%s\\n' \"$port\" \"$agent_socket\" \"$install\"",
].join("\n");

export const REMOTE_AGENT_SCRIPTS = Object.freeze({
  partSize: PART_SIZE_SCRIPT,
  upload: UPLOAD_SCRIPT,
  probeInstalled: PROBE_INSTALLED_SCRIPT,
  discardPart: DISCARD_PART_SCRIPT,
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

export function assertRemoteInstallPath(installPath, installRelativePath) {
  if (typeof installPath !== "string"
    || !posix.isAbsolute(installPath)
    || /[\0\r\n]/u.test(installPath)
    || Buffer.byteLength(installPath, "utf8") > 4096
    || posix.normalize(installPath) !== installPath
    || !installPath.endsWith(`/${installRelativePath}`)) {
    throw new Error("remote agent returned an invalid absolute install path");
  }
  return installPath;
}

export function makeRemoteInstallRelativePath(codeOssCommit, tuple, artifactSha256) {
  if (typeof codeOssCommit !== "string" || !/^[0-9a-f]{40}$/u.test(codeOssCommit)
      || typeof tuple !== "string" || !/^linux-(?:x86_64|aarch64)$/u.test(tuple)
      || typeof artifactSha256 !== "string" || !SHA256.test(artifactSha256)) {
    throw new TypeError("remote agent immutable install identity is invalid");
  }
  return `.chatero-server/artifacts-v1/${artifactSha256}/${codeOssCommit}/${tuple}`;
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

async function* inputChunks(input) {
  if (input === undefined || input === null) return;
  const chunks = Buffer.isBuffer(input) || input instanceof Uint8Array ? [input] : input;
  for await (const chunk of chunks) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      throw new TypeError("remote stdin source returned non-byte data");
    }
    yield Buffer.from(chunk);
  }
}

export async function pumpInput(stream, input, signal) {
  if (!stream || typeof stream.write !== "function" || typeof stream.end !== "function") {
    throw new TypeError("remote stdin must be a writable stream");
  }
  await pipeline(Readable.from(inputChunks(input)), stream, signal ? { signal } : {});
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
    const transfer = new AbortController();
    const onAbort = () => transfer.abort(signal.reason ?? new Error("remote bootstrap was cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    let complete;
    let completed = false;
    const completion = new Promise(resolve => {
      complete = value => {
        if (completed) return;
        completed = true;
        resolve(value);
      };
    });
    child.on("error", error => complete({ source: "process", error, code: null, signal: null }));
    child.on("close", (code, closeSignal) => complete({ source: "process", error: null, code, signal: closeSignal }));
    const writing = pumpInput(child.stdin, input, transfer.signal).then(
      () => null,
      error => {
        // OpenSSH may close its local stdin immediately after the remote
        // command has consumed and durably accepted the final bytes. Node can
        // surface that terminal close as EPIPE before the child `close` event.
        // Preserve the error until the authenticated SSH process reports its
        // status: exit 0 proves the fixed remote script completed; every
        // non-zero status below still rejects the transfer.
        if (error?.code === "EPIPE") return error;
        child.kill("SIGTERM");
        complete({ source: "input", error, code: null, signal: null });
        return error;
      },
    );
    const result = await completion;
    transfer.abort(result.error ?? new Error("remote SSH channel closed"));
    const inputError = await writing;
    signal?.removeEventListener("abort", onAbort);
    if (size > MAX_REMOTE_OUTPUT) throw new Error("remote bootstrap output exceeded 1 MiB");
    const errorText = Buffer.concat(stderr).toString("utf8").trim();
    if (errorText) this.log(errorText);
    if (result.source === "input") throw result.error;
    if (result.error) throw result.error;
    if (result.code !== 0 || result.signal) {
      const error = new Error(`remote bootstrap exited with ${result.code ?? result.signal ?? "unknown status"}`);
      error.code = result.code === 255 ? "SSH_TRANSPORT" : "REMOTE_BOOTSTRAP";
      error.remoteExitCode = result.code;
      error.remoteSignal = result.signal;
      throw error;
    }
    if (inputError && inputError.code !== "EPIPE") throw inputError;
    return Buffer.concat(stdout).toString("utf8");
  }

  probe({ signal } = {}) {
    return this.#exec(REMOTE_PLATFORM_PROBE, [], { signal });
  }

  async probeInstalled({
    installRelativePath,
    sha256,
    treeManifestSha256,
    nodeSha256,
    integrityVerifierSha256,
    signal,
  }) {
    const output = await this.#exec(PROBE_INSTALLED_SCRIPT, [
      installRelativePath,
      sha256,
      treeManifestSha256,
      nodeSha256,
      integrityVerifierSha256,
    ], { signal });
    const state = output.trim();
    if (state !== "ready" && state !== "missing") {
      throw new Error("remote install probe returned an invalid state");
    }
    return state === "ready";
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

  async discardPart({ partRelativePath, signal }) {
    await this.#exec(DISCARD_PART_SCRIPT, [partRelativePath], { signal });
  }

  async finalize({
    partRelativePath,
    installRelativePath,
    archiveRoot,
    sha256,
    treeManifestSha256,
    nodeSha256,
    integrityVerifierSha256,
    signal,
  }) {
    await this.#exec(FINALIZE_SCRIPT, [
      partRelativePath,
      installRelativePath,
      archiveRoot,
      sha256,
      treeManifestSha256,
      nodeSha256,
      integrityVerifierSha256,
    ], { signal });
  }

  async createRuntime({
    installRelativePath,
    tuple,
    treeManifestSha256,
    nodeSha256,
    integrityVerifierSha256,
    connectionToken,
    signal,
  }) {
    const output = await this.#exec(CREATE_RUNTIME_SCRIPT, [
      installRelativePath,
      tuple,
      treeManifestSha256,
      nodeSha256,
      integrityVerifierSha256,
    ], {
      input: Buffer.from(`${connectionToken}\n`, "utf8"),
      signal,
    });
    const [portText, agentHostPath, installPath, ...extra] = output.trim().split(/\r?\n/u);
    const remotePort = Number(portText);
    if (extra.length || !Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65535
      || !isAbsolute(agentHostPath) || /[\0\r\n]/u.test(agentHostPath) || Buffer.byteLength(agentHostPath) > 100) {
      throw new Error("remote agent returned invalid readiness data");
    }
    assertRemoteInstallPath(installPath, installRelativePath);
    return Object.freeze({ remotePort, agentHostPath, installPath });
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
    randomTransactionId = () => randomBytes(12).toString("hex"),
    transactionState = new Map(),
  }) {
    if (!remote) throw new TypeError("remote runtime is required");
    if (!(transactionState instanceof Map)) throw new TypeError("transaction state must be a Map");
    this.remote = remote;
    this.verify = verifyRelease;
    this.select = selectArtifact;
    this.randomToken = randomToken;
    this.randomTransactionId = randomTransactionId;
    this.resumeTransactions = transactionState;
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
    if (!SHA256.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 1
      || !SHA256.test(artifact.treeManifestSha256)
      || !SHA256.test(artifact.nodeSha256)
      || !SHA256.test(artifact.integrityVerifierSha256)) {
      throw new TypeError("verified artifact metadata is malformed");
    }
    const installRelativePath = makeRemoteInstallRelativePath(
      manifest.codeOssCommit,
      hostPlatform.tuple,
      artifact.sha256,
    );
    const archiveRoot = `chatero-agent-${hostPlatform.tuple}`;
    const transactionKey = `${manifest.codeOssCommit}/${hostPlatform.tuple}/${artifact.sha256}`;
    const installed = await this.remote.probeInstalled({
      alias,
      controlPath,
      installRelativePath,
      sha256: artifact.sha256,
      treeManifestSha256: artifact.treeManifestSha256,
      nodeSha256: artifact.nodeSha256,
      integrityVerifierSha256: artifact.integrityVerifierSha256,
      signal,
    });
    if (installed) {
      const staleTransaction = this.resumeTransactions.get(transactionKey);
      if (staleTransaction) {
        const stalePart = `.chatero-server/transactions/${manifest.codeOssCommit}/${staleTransaction}.part`;
        await this.remote.discardPart({ alias, controlPath, partRelativePath: stalePart, signal });
        this.resumeTransactions.delete(transactionKey);
      }
    }
    else {
      const transactionId = this.resumeTransactions.get(transactionKey) ?? this.randomTransactionId();
      this.resumeTransactions.delete(transactionKey);
      if (typeof transactionId !== "string" || !TRANSACTION_ID.test(transactionId)) {
        throw new Error("transaction id generator returned invalid material");
      }
      const partRelativePath = `.chatero-server/transactions/${manifest.codeOssCommit}/${transactionId}.part`;
      let completed = false;
      let reusable = true;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
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
          try {
            await this.remote.finalize({
              alias,
              controlPath,
              partRelativePath,
              installRelativePath,
              archiveRoot,
              sha256: artifact.sha256,
              treeManifestSha256: artifact.treeManifestSha256,
              nodeSha256: artifact.nodeSha256,
              integrityVerifierSha256: artifact.integrityVerifierSha256,
              signal,
            });
            completed = true;
            break;
          }
          catch (error) {
            if (error?.remoteExitCode !== 76) throw error;
            reusable = false;
            await this.remote.discardPart({
              alias,
              controlPath,
              partRelativePath,
              signal,
            });
            if (attempt !== 0) throw error;
            reusable = true;
          }
        }
      }
      finally {
        if (!completed && reusable) {
          const retained = this.resumeTransactions.get(transactionKey);
          if (!retained) this.resumeTransactions.set(transactionKey, transactionId);
          else if (retained !== transactionId) {
            // One failed transaction is enough for a future resume. Avoid
            // leaking a second concurrent partial without masking the cause.
            await this.remote.discardPart({ alias, controlPath, partRelativePath, signal }).catch(() => {});
          }
        }
      }
    }
    const connectionToken = this.randomToken();
    if (typeof connectionToken !== "string" || !/^[A-Za-z0-9_-]{32,256}$/u.test(connectionToken)) {
      throw new Error("connection token generator returned invalid secret material");
    }
    const runtime = await this.remote.createRuntime({
      alias,
      controlPath,
      installRelativePath,
      tuple: hostPlatform.tuple,
      treeManifestSha256: artifact.treeManifestSha256,
      nodeSha256: artifact.nodeSha256,
      integrityVerifierSha256: artifact.integrityVerifierSha256,
      connectionToken,
      signal,
    });
    assertRemoteInstallPath(runtime.installPath, installRelativePath);
    return Object.freeze({
      ...runtime,
      connectionToken,
      installRelativePath,
      codeOssCommit: manifest.codeOssCommit,
      artifactSha256: artifact.sha256,
      treeManifestSha256: artifact.treeManifestSha256,
      nodeSha256: artifact.nodeSha256,
      integrityVerifierSha256: artifact.integrityVerifierSha256,
      tuple: hostPlatform.tuple,
      hostPlatform,
    });
  }
}
