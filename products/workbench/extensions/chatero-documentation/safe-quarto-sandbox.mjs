import { dirname, join, resolve } from "node:path";

function quoted(value) {
  return `\"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}\"`;
}

export function buildSafeQuartoSandbox({
  invocation,
  outputRoot,
  platform = process.platform,
  runtimeRoot,
  snapshotRoot,
  temporaryRoot,
} = {}) {
  if (platform !== "darwin") return Object.freeze({ kind: "preview-unavailable", reason: "sandbox-unavailable" });
  if (!invocation || invocation.shell !== false || ![runtimeRoot, snapshotRoot, outputRoot, temporaryRoot]
    .every(value => typeof value === "string" && resolve(value) === value)) {
    throw new TypeError("safe Quarto sandbox paths are invalid");
  }
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
  const runtimeBin = join(runtimeRoot, "bin");
  return Object.freeze({
    kind: "sandboxed",
    file: "/usr/bin/sandbox-exec",
    args: Object.freeze(["-p", profile, invocation.file, ...invocation.args]),
    cwd: invocation.cwd,
    shell: false,
    profile,
    env: Object.freeze({
      HOME: temporaryRoot,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: `${runtimeBin}:/usr/bin:/bin`,
      QUARTO_DENO_EXTRA_OPTIONS: "--no-prompt",
      TMPDIR: temporaryRoot,
    }),
  });
}
