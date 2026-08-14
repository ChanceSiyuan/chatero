import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// Where a tool installed without root privileges actually lands. A Linux host
// where the operator cannot write /usr is the normal case for a shared box, so
// discovery covers the user-local prefixes before the system ones rather than
// requiring either a settings entry or a root-owned symlink.
const USER_PREFIXES = Object.freeze([
  ".local/bin",
  "bin",
  ".nix-profile/bin",
]);
const SYSTEM_PREFIXES = Object.freeze([
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
]);

export function isExecutableFile(path) {
  try {
    // stat, not lstat: a symbolic link into a user prefix is a normal install
    // layout, and the target is what gets executed.
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  }
  catch { return false; }
}

function* candidatePaths({ name, extraDirectories, environment, homeDirectory }) {
  for (const directory of extraDirectories) {
    if (typeof directory === "string" && directory) yield join(directory, name);
  }
  for (const entry of (environment.PATH ?? "").split(delimiter)) {
    if (entry) yield join(entry, name);
  }
  for (const prefix of USER_PREFIXES) yield join(homeDirectory, prefix, name);
  for (const prefix of SYSTEM_PREFIXES) yield join(prefix, name);
}

// Returns the absolute path of a tool, preferring an explicitly configured one
// and otherwise searching the paths a no-root install uses. `configured` wins
// outright: when it is set but unusable the caller should report that rather
// than silently running some other binary the search happens to find.
export function discoverExecutable({
  name,
  configured,
  environment = process.env,
  extraDirectories = [],
  homeDirectory = homedir(),
  probe = isExecutableFile,
} = {}) {
  if (typeof name !== "string" || !name || name.includes("/")) {
    throw new TypeError("executable name is invalid");
  }
  if (typeof configured === "string" && configured) {
    const path = resolve(configured);
    return path === configured && probe(path)
      ? Object.freeze({ kind: "found", path, source: "configured" })
      : Object.freeze({ kind: "configured-unusable", path: configured });
  }
  for (const candidate of candidatePaths({ name, extraDirectories, environment, homeDirectory })) {
    if (resolve(candidate) === candidate && probe(candidate)) {
      return Object.freeze({ kind: "found", path: candidate, source: "discovered" });
    }
  }
  return Object.freeze({ kind: "not-found" });
}

// TeX Live and TinyTeX install into a per-architecture bin directory that is
// not necessarily on PATH when the extension host starts.
export function texBinDirectories(homeDirectory = homedir()) {
  const architectures = ["x86_64-linux", "aarch64-linux"];
  return Object.freeze([
    ...architectures.map(architecture => join(homeDirectory, ".TinyTeX", "bin", architecture)),
    ...architectures.map(architecture => join(homeDirectory, "texlive", "bin", architecture)),
    join(homeDirectory, ".local", "texlive", "bin"),
    "/opt/texlive/bin/x86_64-linux",
  ]);
}
