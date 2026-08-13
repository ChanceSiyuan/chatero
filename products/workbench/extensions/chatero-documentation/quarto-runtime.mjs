import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const SUPPORTED_VERSIONS = new Set(["1.8.26", "1.8.27"]);
const QUARTO_TEAM_ID = "FYF2F5GFX4";

export async function resolveVerifiedQuartoRuntime({
  executable = process.platform === "darwin" ? "/Applications/quarto/bin/quarto" : undefined,
  inspectSignature = execute,
  run = execute,
} = {}) {
  if (typeof executable !== "string" || resolve(executable) !== executable) {
    return Object.freeze({ kind: "preview-unavailable", reason: "runtime-unavailable" });
  }
  let canonical;
  try {
    canonical = await realpath(executable);
    const metadata = await lstat(canonical);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) throw new Error("unsafe runtime");
  }
  catch { return Object.freeze({ kind: "preview-unavailable", reason: "runtime-unavailable" }); }
  if (process.platform === "darwin") {
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
    catch { return Object.freeze({ kind: "preview-unavailable", reason: "runtime-signature-mismatch" }); }
  }
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
  catch { return Object.freeze({ kind: "preview-unavailable", reason: "runtime-unavailable" }); }
  if (!SUPPORTED_VERSIONS.has(version)) return Object.freeze({ kind: "preview-unavailable", reason: "runtime-version-mismatch" });
  return Object.freeze({
    kind: "verified-runtime",
    quartoExecutable: canonical,
    runtimeRoot: resolve(dirname(canonical), ".."),
    teamIdentifier: QUARTO_TEAM_ID,
    version,
  });
}
