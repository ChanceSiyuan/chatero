import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { discoverExecutable } from "./sandbox-executable.mjs";

const execute = promisify(execFile);
const SUPPORTED_VERSIONS = new Set(["1.8.26", "1.8.27"]);
const QUARTO_TEAM_ID = "FYF2F5GFX4";
const SHA256_HEX = /^[0-9a-f]{64}$/u;

function unavailable(reason) {
  return Object.freeze({ kind: "preview-unavailable", reason });
}

// The runtime prefix is read-only mounted into the Linux render sandbox, so a
// prefix that is (or contains) the user's home directory would leak SSH keys
// and credentials into document-controlled code. Refuse such installs.
function unsafeRuntimeRoot(runtimeRoot, home) {
  if (runtimeRoot === sep || runtimeRoot === "/") return true;
  const canonicalHome = resolve(home);
  return runtimeRoot === canonicalHome || `${canonicalHome}${sep}`.startsWith(`${runtimeRoot}${sep}`);
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

export async function resolveVerifiedQuartoRuntime({
  bubblewrapExecutable,
  discover = discoverExecutable,
  executable,
  hashFile = sha256File,
  homeDirectory = homedir(),
  inspectSignature = execute,
  platform = process.platform,
  run = execute,
  sha256Allowlist = [],
} = {}) {
  if (executable === undefined && platform === "darwin") executable = "/Applications/quarto/bin/quarto";
  if (typeof executable !== "string" || resolve(executable) !== executable) return unavailable("runtime-unavailable");
  let canonical;
  try {
    canonical = await realpath(executable);
    const metadata = await lstat(canonical);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) throw new Error("unsafe runtime");
  }
  catch { return unavailable("runtime-unavailable"); }
  let sha256;
  if (platform === "darwin") {
    try {
      const signature = await inspectSignature("/usr/bin/codesign", ["-dv", "--verbose=2", canonical], {
        encoding: "utf8", env: {}, maxBuffer: 16 * 1024, timeout: 10_000,
      });
      const detail = `${signature.stdout ?? ""}\n${signature.stderr ?? ""}`;
      if (!detail.includes(`TeamIdentifier=${QUARTO_TEAM_ID}`)
          || !detail.includes("Authority=Developer ID Application: RStudio Inc.")) {
        throw new Error("unexpected Quarto code signature");
      }
    }
    catch { return unavailable("runtime-signature-mismatch"); }
  }
  else if (platform === "linux") {
    const allowlist = (Array.isArray(sha256Allowlist) ? sha256Allowlist : [])
      .filter(value => typeof value === "string" && SHA256_HEX.test(value.toLowerCase()))
      .map(value => value.toLowerCase());
    if (allowlist.length === 0) return unavailable("runtime-unpinned");
    try { sha256 = await hashFile(canonical); }
    catch { return unavailable("runtime-unavailable"); }
    if (typeof sha256 !== "string" || !allowlist.includes(sha256.toLowerCase())) return unavailable("runtime-digest-mismatch");
    sha256 = sha256.toLowerCase();
  }
  else return unavailable("runtime-unavailable");
  let version;
  try {
    const result = await run(canonical, ["--version"], {
      encoding: "utf8",
      env: { HOME: "/var/empty", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/bin" },
      maxBuffer: 4096,
      timeout: 10_000,
    });
    version = result.stdout.trim();
  }
  catch { return unavailable("runtime-unavailable"); }
  if (!SUPPORTED_VERSIONS.has(version)) return unavailable("runtime-version-mismatch");
  const runtimeRoot = resolve(dirname(canonical), "..");
  if (unsafeRuntimeRoot(runtimeRoot, homeDirectory)) return unavailable("runtime-prefix-unsafe");
  // The Linux render is confined by bubblewrap, which need not live under
  // /usr: a per-user install is found without configuration.
  let sandboxPath;
  if (platform === "linux") {
    const sandbox = discover({ configured: bubblewrapExecutable, homeDirectory, name: "bwrap" });
    if (sandbox.kind !== "found") {
      return unavailable(sandbox.kind === "configured-unusable" ? "sandbox-path-unusable" : "sandbox-unavailable");
    }
    sandboxPath = sandbox.path;
  }
  return Object.freeze({
    kind: "verified-runtime",
    quartoExecutable: canonical,
    runtimeRoot,
    version,
    ...(sandboxPath && { bubblewrapExecutable: sandboxPath }),
    ...(platform === "darwin" ? { teamIdentifier: QUARTO_TEAM_ID } : { sha256 }),
  });
}
