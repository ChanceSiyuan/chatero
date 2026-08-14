import { dirname, join, resolve } from "node:path";

import { discoverExecutable, isExecutableFile } from "./sandbox-executable.mjs";

// Resolved once here so a host without a writable /usr still works: bwrap
// installed under the user's own prefix is found without configuration.
const DEFAULT_BUBBLEWRAP = discoverExecutable({ name: "bwrap" });

// Same posture as the Quarto Linux sandbox: the filesystem allowlist is the
// security boundary -- the user home and workspace are never mounted, writes
// land only in the disposable snapshot, and the network namespace is always
// unshared (TeX never needs the network; \write18 is additionally disabled at
// the invocation with -no-shell-escape). TEXMF caches are pointed into the
// snapshot's private tmp so nothing touches the real user tree.
const LINUX_OPTIONAL_READ_ONLY = Object.freeze([
  "/bin", "/sbin", "/lib", "/lib64", "/lib32",
  "/etc/alternatives", "/etc/ld.so.cache", "/etc/localtime",
  "/etc/passwd", "/etc/group", "/etc/nsswitch.conf",
  "/etc/ssl", "/etc/ca-certificates", "/etc/fonts", "/etc/texmf",
  "/var/lib/texmf",
]);

export function buildSafeLatexSandbox({
  binDirectory,
  bubblewrapExecutable = DEFAULT_BUBBLEWRAP.kind === "found" ? DEFAULT_BUBBLEWRAP.path : "",
  invocation,
  platform = process.platform,
  probeSandboxExecutable = isExecutableFile,
  runtimeRoots,
  snapshotRoot,
  temporaryRoot,
} = {}) {
  if (platform !== "linux") return Object.freeze({ kind: "preview-unavailable", reason: "sandbox-unavailable" });
  if (!invocation || invocation.shell !== false
      || !Array.isArray(runtimeRoots) || runtimeRoots.length === 0
      || ![...runtimeRoots, snapshotRoot, temporaryRoot]
        .every(value => typeof value === "string" && resolve(value) === value)) {
    throw new TypeError("safe LaTeX sandbox paths are invalid");
  }
  if (typeof bubblewrapExecutable !== "string" || resolve(bubblewrapExecutable) !== bubblewrapExecutable
      || !probeSandboxExecutable(bubblewrapExecutable)) {
    return Object.freeze({ kind: "preview-unavailable", reason: "sandbox-unavailable" });
  }
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
    ...[...new Set(runtimeRoots)].flatMap(path => ["--ro-bind-try", path, path]),
    "--bind", snapshotRoot, snapshotRoot,
    "--chdir", invocation.cwd,
  ];
  return Object.freeze({
    kind: "sandboxed",
    file: bubblewrapExecutable,
    args: Object.freeze([...args, invocation.file, ...invocation.args]),
    cwd: invocation.cwd,
    shell: false,
    env: Object.freeze({
      HOME: temporaryRoot,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      // The TeX engines live beside latexmk in the distribution's bin
      // directory, which is not where a symlinked latexmk resolves to.
      PATH: `${binDirectory || dirname(invocation.file)}:/usr/bin:/bin`,
      TEXMFCONFIG: join(temporaryRoot, "texmf-config"),
      TEXMFHOME: join(temporaryRoot, "texmf-home"),
      TEXMFVAR: join(temporaryRoot, "texmf-var"),
      TMPDIR: temporaryRoot,
    }),
  });
}
