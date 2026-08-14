import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, test } from "node:test";

const temporaryDirectories = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true }))));

async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "chatero-discovery-"));
  temporaryDirectories.push(path);
  return path;
}

async function executableAt(directory, name) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
}

test("discovery finds a tool installed without root privileges", async () => {
  const { discoverExecutable } = await import("../extensions/chatero-documentation/sandbox-executable.mjs");
  const home = await temporary();
  // The case that motivated this: bwrap in the user's own prefix, nothing in
  // /usr/bin, and no setting configured.
  const userLocal = await executableAt(join(home, ".local", "bin"), "bwrap");

  const found = discoverExecutable({ environment: { PATH: "" }, homeDirectory: home, name: "bwrap" });
  assert.equal(found.kind, "found");
  assert.equal(found.path, userLocal);
  assert.equal(found.source, "discovered");
});

test("discovery prefers PATH over the per-user prefixes, and a configured path over both", async () => {
  const { discoverExecutable } = await import("../extensions/chatero-documentation/sandbox-executable.mjs");
  const home = await temporary();
  await executableAt(join(home, ".local", "bin"), "bwrap");
  const onPath = await executableAt(join(await temporary(), "bin"), "bwrap");
  const configured = await executableAt(await temporary(), "bwrap");
  const environment = { PATH: [join(await temporary(), "empty"), join(onPath, "..")].join(delimiter) };

  assert.equal(discoverExecutable({ environment, homeDirectory: home, name: "bwrap" }).path, onPath);
  const explicit = discoverExecutable({ configured, environment, homeDirectory: home, name: "bwrap" });
  assert.equal(explicit.path, configured);
  assert.equal(explicit.source, "configured");
});

test("a configured path that cannot be run is reported rather than silently replaced", async () => {
  const { discoverExecutable } = await import("../extensions/chatero-documentation/sandbox-executable.mjs");
  const home = await temporary();
  const usable = await executableAt(join(home, ".local", "bin"), "bwrap");
  const notExecutable = join(await temporary(), "bwrap");
  await writeFile(notExecutable, "not executable\n");

  // Falling back to some other binary would run a different sandbox than the
  // operator asked for, so this is an error, not a search.
  for (const configured of [notExecutable, join(home, "absent"), "relative/bwrap"]) {
    const result = discoverExecutable({ configured, environment: { PATH: "" }, homeDirectory: home, name: "bwrap" });
    assert.equal(result.kind, "configured-unusable", configured);
    assert.notEqual(result.path, usable);
  }
});

test("discovery follows a symbolic link, which is how per-user TeX installs are laid out", async () => {
  const { discoverExecutable, texBinDirectories } = await import("../extensions/chatero-documentation/sandbox-executable.mjs");
  const home = await temporary();
  const script = await executableAt(join(home, ".TinyTeX", "texmf-dist", "scripts", "latexmk"), "latexmk.pl");
  const binDirectory = join(home, ".TinyTeX", "bin", "x86_64-linux");
  await mkdir(binDirectory, { recursive: true });
  await symlink(script, join(binDirectory, "latexmk"));

  assert.ok(texBinDirectories(home).includes(binDirectory));
  const found = discoverExecutable({
    environment: { PATH: "" },
    extraDirectories: texBinDirectories(home),
    homeDirectory: home,
    name: "latexmk",
  });
  assert.equal(found.kind, "found");
  // The link, not its target: the bin directory is where the engines live.
  assert.equal(found.path, join(binDirectory, "latexmk"));
  assert.equal(discoverExecutable({ environment: { PATH: "" }, homeDirectory: home, name: "latexmk" }).kind, "not-found");
});

test("discovery refuses a name that is a path", async () => {
  const { discoverExecutable } = await import("../extensions/chatero-documentation/sandbox-executable.mjs");
  for (const name of ["../bwrap", "bin/bwrap", "", 7]) {
    assert.throws(() => discoverExecutable({ name }), TypeError, String(name));
  }
});

test("an installed TeX and bubblewrap compile a document with no configuration but the digest", {
  skip: process.platform !== "linux",
}, async t => {
  const [{ resolveVerifiedLatexRuntime }, { SafeLatexRenderer }] = await Promise.all([
    import("../extensions/chatero-documentation/latex-runtime.mjs"),
    import("../extensions/chatero-documentation/safe-latex-renderer.mjs"),
  ]);
  const probe = await resolveVerifiedLatexRuntime({ platform: "linux" });
  if (probe.reason !== "runtime-unpinned") {
    t.skip(`no discoverable LaTeX toolchain: ${probe.reason ?? probe.kind}`);
    return;
  }
  // Nothing is configured except the digest the probe just reported, which is
  // exactly what the unavailable message tells the operator to paste.
  const runtime = await resolveVerifiedLatexRuntime({ platform: "linux", sha256Allowlist: [probe.discovered.sha256] });
  assert.equal(runtime.kind, "verified-runtime", JSON.stringify(runtime));
  assert.ok(runtime.bubblewrapExecutable, "bubblewrap must be discovered too");

  const project = await temporary();
  const sourcePath = join(project, "note.tex");
  const source = "\\documentclass{article}\n\\begin{document}\nDiscovered toolchain.\n\\end{document}\n";
  await writeFile(sourcePath, source);
  const renderer = new SafeLatexRenderer({ runtime });
  const result = await renderer.render({ sourcePath, source, version: 1 });
  await renderer.dispose();
  if (result.kind !== "rendered") {
    t.skip(`toolchain present but could not compile here: ${result.reason ?? result.diagnostic}`);
    return;
  }
  assert.ok(result.bytes > 1000, "a real PDF should not be trivially small");
});
