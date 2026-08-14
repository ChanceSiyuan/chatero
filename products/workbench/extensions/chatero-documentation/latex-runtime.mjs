import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";

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
  executable,
  hashFile = sha256File,
  homeDirectory = homedir(),
  platform = process.platform,
  run = execute,
  runtimeRoots = [],
  sha256Allowlist = [],
} = {}) {
  if (platform !== "linux") return unavailable("runtime-unavailable");
  if (typeof executable !== "string" || resolve(executable) !== executable) return unavailable("runtime-unavailable");
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
  if (allowlist.length === 0) return unavailable("runtime-unpinned");
  let sha256;
  try { sha256 = await hashFile(canonical); }
  catch { return unavailable("runtime-unavailable"); }
  if (typeof sha256 !== "string" || !allowlist.includes(sha256.toLowerCase())) return unavailable("runtime-digest-mismatch");
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
  if (unsafePrefix(executableDirectory, homeDirectory)) return unavailable("runtime-prefix-unsafe");
  return Object.freeze({
    kind: "verified-runtime",
    latexExecutable: canonical,
    executableDirectory,
    runtimeRoots: Object.freeze([...new Set([executableDirectory, ...roots])]),
    sha256: sha256.toLowerCase(),
    version,
  });
}
