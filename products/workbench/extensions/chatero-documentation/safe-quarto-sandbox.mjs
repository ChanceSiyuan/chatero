import { dirname, join, resolve } from "node:path";

import { discoverExecutable, isExecutableFile } from "./sandbox-executable.mjs";

// Resolved once here so a host without a writable /usr still works: bwrap
// installed under the user's own prefix is found without configuration.
const DEFAULT_BUBBLEWRAP = discoverExecutable({ name: "bwrap" });

function quoted(value) {
  return `\"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}\"`;
}

function sandboxEnvironment(runtimeRoot, temporaryRoot) {
  return Object.freeze({
    HOME: temporaryRoot,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: `${join(runtimeRoot, "bin")}:/usr/bin:/bin`,
    QUARTO_DENO_EXTRA_OPTIONS: "--no-prompt",
    TMPDIR: temporaryRoot,
  });
}

// Read-only system surface for the Linux sandbox. The filesystem allowlist is
// the security boundary on Linux: the user home (SSH keys, credentials) and
// the workspace are never mounted, and writes land only in the disposable
// render snapshot. The network namespace is always unshared; the kernel keeps
// loopback traffic working inside the fresh namespace, which is all Jupyter
// kernels need, while external hosts, host loopback services, and cloud
// metadata endpoints stay unreachable even for execution-enabled renders.
const LINUX_OPTIONAL_READ_ONLY = Object.freeze([
  "/bin", "/sbin", "/lib", "/lib64", "/lib32",
  "/etc/alternatives", "/etc/ld.so.cache", "/etc/localtime",
  "/etc/passwd", "/etc/group", "/etc/nsswitch.conf",
  "/etc/ssl", "/etc/ca-certificates", "/etc/fonts",
]);

function buildBubblewrapSandbox({ bubblewrapExecutable, execution, invocation, runtimeRoot, snapshotRoot, temporaryRoot }) {
  // Bind only the Quarto entry directory plus the conventional bin/ and
  // share/ subtrees -- never the whole runtime prefix, so a mis-derived
  // prefix cannot expose sibling directories.
  const runtimeReadOnly = [...new Set([dirname(invocation.file), join(runtimeRoot, "bin"), join(runtimeRoot, "share")])];
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--unshare-net",
    "--proc", "/proc",
    "--dev", "/dev",
    "--ro-bind", "/usr", "/usr",
    ...LINUX_OPTIONAL_READ_ONLY.flatMap(path => ["--ro-bind-try", path, path]),
    ...runtimeReadOnly.flatMap(path => ["--ro-bind-try", path, path]),
    "--bind", snapshotRoot, snapshotRoot,
    "--chdir", invocation.cwd,
  ];
  return Object.freeze({
    kind: "sandboxed",
    file: bubblewrapExecutable,
    args: Object.freeze([...args, invocation.file, ...invocation.args]),
    cwd: invocation.cwd,
    shell: false,
    execution: execution === true,
    env: sandboxEnvironment(runtimeRoot, temporaryRoot),
  });
}

export function buildSafeQuartoSandbox({
  bubblewrapExecutable = DEFAULT_BUBBLEWRAP.kind === "found" ? DEFAULT_BUBBLEWRAP.path : "",
  execution = false,
  invocation,
  outputRoot,
  platform = process.platform,
  probeSandboxExecutable = isExecutableFile,
  runtimeRoot,
  snapshotRoot,
  temporaryRoot,
} = {}) {
  if (platform !== "darwin" && platform !== "linux") return Object.freeze({ kind: "preview-unavailable", reason: "sandbox-unavailable" });
  if (!invocation || invocation.shell !== false || ![runtimeRoot, snapshotRoot, outputRoot, temporaryRoot]
    .every(value => typeof value === "string" && resolve(value) === value)) {
    throw new TypeError("safe Quarto sandbox paths are invalid");
  }
  if (platform === "linux") {
    if (typeof bubblewrapExecutable !== "string" || resolve(bubblewrapExecutable) !== bubblewrapExecutable
        || !probeSandboxExecutable(bubblewrapExecutable)) {
      return Object.freeze({ kind: "preview-unavailable", reason: "sandbox-unavailable" });
    }
    return buildBubblewrapSandbox({ bubblewrapExecutable, execution, invocation, runtimeRoot, snapshotRoot, temporaryRoot });
  }
  if (execution) return Object.freeze({ kind: "preview-unavailable", reason: "execution-unavailable" });
  const executableDirectory = dirname(invocation.file);
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-read* (subpath \"/Users\") (subpath \"/Volumes\") (subpath \"/private/var/root\"))",
    "(deny file-write*)",
    `(deny process-exec (subpath \"/Users\") (subpath \"/Volumes\") (subpath ${quoted(snapshotRoot)}))`,
    `(allow file-read* (subpath ${quoted(runtimeRoot)}) (subpath ${quoted(snapshotRoot)}) (subpath ${quoted(executableDirectory)}) (literal \"/dev/null\"))`,
    "(allow file-write* (literal \"/dev/null\"))",
    `(allow file-write* (subpath ${quoted(outputRoot)}) (subpath ${quoted(temporaryRoot)}) (subpath ${quoted(join(snapshotRoot, ".quarto"))}) (subpath ${quoted(join(snapshotRoot, "source"))}))`,
  ].join("\n");
  return Object.freeze({
    kind: "sandboxed",
    file: "/usr/bin/sandbox-exec",
    args: Object.freeze(["-p", profile, invocation.file, ...invocation.args]),
    cwd: invocation.cwd,
    shell: false,
    execution: false,
    profile,
    env: sandboxEnvironment(runtimeRoot, temporaryRoot),
  });
}
