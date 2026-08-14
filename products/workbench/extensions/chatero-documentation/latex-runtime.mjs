import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { discoverExecutable, texBinDirectories } from "./sandbox-executable.mjs";

const execute = promisify(execFile);
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MAX_RUNTIME_ROOTS = 8;

function unavailable(reason) {
  return Object.freeze({ kind: "preview-unavailable", reason });
}

function sha256File(path) {
  return new Promise((accept, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", chunk => hash.update(chunk))
      .on("end", () => accept(hash.digest("hex")));
  });
}

// A runtime root is read-only mounted into the render sandbox, so a root that
// is (or contains) the user's home directory would leak SSH keys and
// credentials into document-controlled TeX code.
function unsafePrefix(root, home) {
  if (root === sep || root === "/") return true;
  const canonicalHome = resolve(home);
  return root === canonicalHome || `${canonicalHome}${sep}`.startsWith(`${root}${sep}`);
}

// Verifies the LaTeX driver on a remote Linux host: latexmk (or another
// configured entry executable) is pinned by a machine-scoped sha256 allowlist
// -- the digest pins only the entry executable; the bubblewrap sandbox, not
// this pin, is the security boundary. LaTeX compilation is remote-only: there
// is no macOS branch by design.
export async function resolveVerifiedLatexRuntime({
  bubblewrapExecutable,
  discover = discoverExecutable,
  executable,
  hashFile = sha256File,
  homeDirectory = homedir(),
  platform = process.platform,
  run = execute,
  runtimeRoots = [],
  sha256Allowlist = [],
} = {}) {
  if (platform !== "linux") return unavailable("runtime-unavailable");
  // Neither tool has to live under /usr: a host where the operator cannot
  // write system directories is the normal case, so both are discovered from
  // the user-local install locations unless a path is configured.
  const sandbox = discover({ configured: bubblewrapExecutable, name: "bwrap", homeDirectory });
  if (sandbox.kind !== "found") {
    return unavailable(sandbox.kind === "configured-unusable" ? "sandbox-path-unusable" : "sandbox-unavailable");
  }
  const found = discover({
    configured: executable,
    extraDirectories: texBinDirectories(homeDirectory),
    homeDirectory,
    name: "latexmk",
  });
  if (found.kind !== "found") {
    return unavailable(found.kind === "configured-unusable" ? "runtime-path-unusable" : "runtime-unavailable");
  }
  executable = found.path;
  let canonical;
  try {
    canonical = await realpath(executable);
    const metadata = await lstat(canonical);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) throw new Error("unsafe runtime");
  }
  catch { return unavailable("runtime-unavailable"); }
  const allowlist = (Array.isArray(sha256Allowlist) ? sha256Allowlist : [])
    .filter(value => typeof value === "string" && SHA256_HEX.test(value.toLowerCase()))
    .map(value => value.toLowerCase());
  let sha256;
  try { sha256 = await hashFile(canonical); }
  catch { return unavailable("runtime-unavailable"); }
  if (typeof sha256 !== "string") return unavailable("runtime-unavailable");
  sha256 = sha256.toLowerCase();
  // Report what was found and its digest, so pinning is a copy of two values
  // out of the message rather than a hunt for the binary.
  if (allowlist.length === 0) {
    return Object.freeze({
      kind: "preview-unavailable",
      reason: "runtime-unpinned",
      discovered: Object.freeze({ path: canonical, sha256 }),
    });
  }
  if (!allowlist.includes(sha256)) {
    return Object.freeze({
      kind: "preview-unavailable",
      reason: "runtime-digest-mismatch",
      discovered: Object.freeze({ path: canonical, sha256 }),
    });
  }
  let version;
  try {
    const result = await run(canonical, ["--version"], {
      encoding: "utf8",
      env: { HOME: "/var/empty", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
      maxBuffer: 16 * 1024,
      timeout: 10_000,
    });
    version = result.stdout.split("\n", 1)[0].trim().slice(0, 256);
  }
  catch { return unavailable("runtime-unavailable"); }
  if (!version) return unavailable("runtime-version-mismatch");
  const executableDirectory = dirname(canonical);
  const roots = [];
  const requested = Array.isArray(runtimeRoots) ? runtimeRoots.slice(0, MAX_RUNTIME_ROOTS) : [];
  for (const value of requested) {
    if (typeof value !== "string" || resolve(value) !== value) return unavailable("runtime-root-invalid");
    // The guard has to run on the path the kernel will mount, not the one that
    // was typed: a symbolic link to the home directory passes a lexical check
    // and still exposes it inside the sandbox.
    let canonicalRoot;
    try { canonicalRoot = await realpath(value); }
    catch { return unavailable("runtime-root-invalid"); }
    if (unsafePrefix(canonicalRoot, homeDirectory) || unsafePrefix(value, homeDirectory)) {
      return unavailable("runtime-prefix-unsafe");
    }
    roots.push(canonicalRoot);
  }
  // Directories are derived from where latexmk was found, not from where the
  // link resolves to: in a TeX Live layout the entry is a symbolic link in the
  // per-architecture bin directory pointing at a script deep inside
  // texmf-dist, and it is the bin directory that holds pdflatex, xelatex and
  // kpsewhich. Deriving from the resolved script would put neither the engines
  // on PATH nor their directory in the sandbox.
  const binDirectory = dirname(found.path);
  // A TeX distribution keeps its macros and formats beside that bin directory
  // (<dist>/bin/<arch>), and kpathsea resolves them relative to it. Mounting
  // only the bin directory would leave the engine unable to find texmf-dist,
  // so the distribution root comes along whenever it is safe -- for a system
  // install this is /usr, which is mounted read-only anyway.
  // TeX Live installs as <dist>/bin/<arch>, a package manager as <prefix>/bin;
  // anything else is not a recognisable distribution, and a root guessed by
  // counting directory levels could be far too broad. When the root is not
  // recognisable or would expose the home directory it is simply left out --
  // the engine may then need an explicit runtimeRoots entry, which is a
  // fixable configuration problem rather than a mounted home directory.
  const binParent = dirname(binDirectory);
  const distributionRoot = basename(binDirectory) === "bin"
    ? binParent
    : basename(binParent) === "bin" ? dirname(binParent) : undefined;
  for (const candidate of [binDirectory, executableDirectory]) {
    if (unsafePrefix(candidate, homeDirectory)) return unavailable("runtime-prefix-unsafe");
  }
  if (distributionRoot && !unsafePrefix(distributionRoot, homeDirectory)) roots.unshift(distributionRoot);
  return Object.freeze({
    kind: "verified-runtime",
    binDirectory,
    bubblewrapExecutable: sandbox.path,
    latexExecutable: canonical,
    executableDirectory,
    runtimeRoots: Object.freeze([...new Set([binDirectory, executableDirectory, ...roots])]),
    sha256,
    version,
  });
}
