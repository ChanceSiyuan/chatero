import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const temporaryDirectories = [];

afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true }))));

async function temporary() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "chatero-latex-test-")));
  temporaryDirectories.push(path);
  return path;
}

async function fakeLatexmk() {
  const root = await temporary();
  await mkdir(join(root, "bin"));
  const executable = join(root, "bin", "latexmk");
  const script = "#!/bin/sh\necho 'Latexmk, John Collins, version: 4.83'\n";
  await writeFile(executable, script);
  await chmod(executable, 0o755);
  return { digest: createHash("sha256").update(script).digest("hex"), executable, root };
}

test("LaTeX runtime pins the entry executable by digest and refuses unsafe prefixes", async () => {
  const { resolveVerifiedLatexRuntime } = await import("../extensions/chatero-documentation/latex-runtime.mjs");
  const { digest, executable, root } = await fakeLatexmk();
  const run = async () => ({ stdout: "Latexmk, John Collins, version: 4.83\n" });
  const base = { executable, platform: "linux", run, sha256Allowlist: [digest] };

  assert.equal((await resolveVerifiedLatexRuntime({ ...base, platform: "darwin" })).reason, "runtime-unavailable");
  assert.equal((await resolveVerifiedLatexRuntime({ ...base, sha256Allowlist: [] })).reason, "runtime-unpinned");
  assert.equal((await resolveVerifiedLatexRuntime({ ...base, sha256Allowlist: ["nope"] })).reason, "runtime-unpinned");
  assert.equal((await resolveVerifiedLatexRuntime({ ...base, sha256Allowlist: ["f".repeat(64)] })).reason, "runtime-digest-mismatch");
  // A root that is the home directory, or an ancestor of it, would mount the
  // user's credentials into the sandbox; a root nested inside home is fine.
  assert.equal((await resolveVerifiedLatexRuntime({ ...base, homeDirectory: join(root, "bin") })).reason, "runtime-prefix-unsafe");
  assert.equal((await resolveVerifiedLatexRuntime({ ...base, homeDirectory: join(root, "bin", "nested", "home") })).reason, "runtime-prefix-unsafe");
  assert.equal((await resolveVerifiedLatexRuntime({ ...base, homeDirectory: root })).kind, "verified-runtime");
  assert.equal((await resolveVerifiedLatexRuntime({ ...base, homeDirectory: root, runtimeRoots: [root] })).reason, "runtime-prefix-unsafe");
  assert.equal((await resolveVerifiedLatexRuntime({ ...base, runtimeRoots: ["/"] })).reason, "runtime-prefix-unsafe");
  assert.equal((await resolveVerifiedLatexRuntime({ ...base, runtimeRoots: ["relative/path"] })).reason, "runtime-root-invalid");
  assert.equal((await resolveVerifiedLatexRuntime({ ...base, run: async () => { throw new Error("no"); } })).reason, "runtime-unavailable");

  // Roots are canonicalised before the home guard runs, so they must exist;
  // a real directory keeps this assertion platform-independent.
  const texmf = await temporary();
  assert.equal((await resolveVerifiedLatexRuntime({ ...base, runtimeRoots: [join(texmf, "absent")] })).reason, "runtime-root-invalid");

  const verified = await resolveVerifiedLatexRuntime({ ...base, runtimeRoots: [texmf, texmf] });
  assert.equal(verified.kind, "verified-runtime");
  assert.equal(verified.latexExecutable, executable);
  assert.equal(verified.sha256, digest);
  assert.match(verified.version, /^Latexmk/u);
  assert.deepEqual(verified.runtimeRoots, [join(root, "bin"), texmf]);
});

test("LaTeX runtime resolves a symlinked runtime root before applying the home guard", async () => {
  const { resolveVerifiedLatexRuntime } = await import("../extensions/chatero-documentation/latex-runtime.mjs");
  const { digest, executable } = await fakeLatexmk();
  const home = await temporary();
  const disguised = join(await temporary(), "texmf");
  await symlink(home, disguised, "dir");

  // A lexical check would pass this path and still mount the home directory.
  assert.equal((await resolveVerifiedLatexRuntime({
    executable, homeDirectory: home, platform: "linux", run: async () => ({ stdout: "Latexmk 4.83\n" }),
    runtimeRoots: [disguised], sha256Allowlist: [digest],
  })).reason, "runtime-prefix-unsafe");
});

test("LaTeX runtime rejects group- or world-writable executables and symlinked entries", async () => {
  const { resolveVerifiedLatexRuntime } = await import("../extensions/chatero-documentation/latex-runtime.mjs");
  const { digest, executable } = await fakeLatexmk();
  await chmod(executable, 0o777);
  assert.equal((await resolveVerifiedLatexRuntime({
    executable, platform: "linux", sha256Allowlist: [digest], run: async () => ({ stdout: "x\n" }),
  })).reason, "runtime-unavailable");
});

test("LaTeX invocation disables shell escape and writes only into the snapshot output directory", async () => {
  const { buildSafeLatexInvocation } = await import("../extensions/chatero-documentation/safe-latex-renderer.mjs");
  const invocation = buildSafeLatexInvocation({
    snapshot: { disposableRoot: "/tmp/snapshot", entryBasename: "note.tex" },
    runtime: { latexExecutable: "/opt/texlive/bin/latexmk" },
  });
  assert.deepEqual(invocation, {
    file: "/opt/texlive/bin/latexmk",
    args: ["-norc", "-pdf", "-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "-outdir=../output", "note.tex"],
    cwd: "/tmp/snapshot/source",
    shell: false,
  });
  assert.ok(invocation.args.includes("-no-shell-escape"));
  // latexmk evaluates a project latexmkrc as Perl, which -no-shell-escape does
  // not cover; -norc is what closes that path, including the system rc files
  // reachable through the sandbox's read-only /usr.
  assert.ok(invocation.args.includes("-norc"));
  for (const entryBasename of ["../escape.tex", "note.tex; rm -rf /", "note.pdf", "-draft.tex"]) {
    assert.throws(() => buildSafeLatexInvocation({
      snapshot: { disposableRoot: "/tmp/snapshot", entryBasename },
      runtime: { latexExecutable: "/opt/texlive/bin/latexmk" },
    }), TypeError, entryBasename);
  }
});

test("Linux LaTeX sandbox unshares the network and mounts no home or workspace path", async () => {
  const { buildSafeLatexSandbox } = await import("../extensions/chatero-documentation/safe-latex-sandbox.mjs");
  const invocation = { file: "/opt/texlive/bin/latexmk", args: ["-pdf", "note.tex"], cwd: "/tmp/snap/source", shell: false };
  const sandbox = buildSafeLatexSandbox({
    invocation,
    platform: "linux",
    probeSandboxExecutable: path => path === "/usr/bin/bwrap",
    runtimeRoots: ["/opt/texlive/bin", "/usr/share/texmf"],
    snapshotRoot: "/tmp/snap",
    temporaryRoot: "/tmp/snap/tmp",
  });

  assert.equal(sandbox.kind, "sandboxed");
  assert.equal(sandbox.file, "/usr/bin/bwrap");
  assert.ok(sandbox.args.includes("--unshare-net"));
  assert.ok(sandbox.args.includes("--unshare-pid"));
  const flat = sandbox.args.join(" ");
  assert.ok(flat.includes("--ro-bind /usr /usr"));
  assert.ok(flat.includes("--ro-bind-try /opt/texlive/bin /opt/texlive/bin"));
  assert.ok(flat.includes("--bind /tmp/snap /tmp/snap"));
  assert.ok(flat.includes("--chdir /tmp/snap/source"));
  const boundSources = sandbox.args.filter((value, index) => ["--bind", "--ro-bind", "--ro-bind-try"].includes(sandbox.args[index - 1]));
  for (const forbidden of ["/", homedir()]) assert.equal(boundSources.includes(forbidden), false);
  assert.deepEqual(sandbox.args.slice(-1 - invocation.args.length), [invocation.file, ...invocation.args]);
  assert.equal(sandbox.env.HOME, "/tmp/snap/tmp");
  assert.equal(sandbox.env.TEXMFHOME, "/tmp/snap/tmp/texmf-home");
  assert.equal(sandbox.env.TEXMFVAR, "/tmp/snap/tmp/texmf-var");
  assert.equal(sandbox.env.PATH, "/opt/texlive/bin:/usr/bin:/bin");

  assert.equal(buildSafeLatexSandbox({
    invocation, platform: "darwin", runtimeRoots: ["/opt/texlive/bin"], snapshotRoot: "/tmp/snap", temporaryRoot: "/tmp/snap/tmp",
  }).reason, "sandbox-unavailable");
  assert.equal(buildSafeLatexSandbox({
    invocation, platform: "linux", probeSandboxExecutable: () => false,
    runtimeRoots: ["/opt/texlive/bin"], snapshotRoot: "/tmp/snap", temporaryRoot: "/tmp/snap/tmp",
  }).reason, "sandbox-unavailable");
  assert.throws(() => buildSafeLatexSandbox({
    invocation, platform: "linux", runtimeRoots: [], snapshotRoot: "/tmp/snap", temporaryRoot: "/tmp/snap/tmp",
  }), TypeError);
});

test("installed bubblewrap denies LaTeX reads outside the project snapshot", { skip: process.platform !== "linux" }, async t => {
  const { buildSafeLatexSandbox } = await import("../extensions/chatero-documentation/safe-latex-sandbox.mjs");
  const snapshotRoot = await temporary();
  const outside = await temporary();
  await mkdir(join(snapshotRoot, "source"));
  await mkdir(join(snapshotRoot, "tmp"));
  await writeFile(join(snapshotRoot, "source", "inside.tex"), "inside");
  await writeFile(join(outside, "secret.key"), "secret");
  const build = file => buildSafeLatexSandbox({
    platform: "linux",
    invocation: { file: "/bin/cat", args: [file], cwd: join(snapshotRoot, "source"), shell: false },
    runtimeRoots: ["/usr/bin"],
    snapshotRoot,
    temporaryRoot: join(snapshotRoot, "tmp"),
  });
  const allowed = build(join(snapshotRoot, "source", "inside.tex"));
  if (allowed.kind !== "sandboxed") {
    t.skip("bubblewrap unavailable");
    return;
  }
  let stdout;
  try { ({ stdout } = await execFile(allowed.file, allowed.args, { cwd: allowed.cwd, env: allowed.env, timeout: 20_000 })); }
  catch {
    t.skip("bubblewrap unavailable or user namespaces are restricted");
    return;
  }
  assert.equal(stdout, "inside");
  const denied = build(join(outside, "secret.key"));
  await assert.rejects(execFile(denied.file, denied.args, { cwd: denied.cwd, env: denied.env, timeout: 20_000 }));
});

async function project(source = "\\documentclass{article}\\begin{document}Hello\\end{document}\n") {
  const root = await temporary();
  const sourcePath = join(root, "note.tex");
  await writeFile(sourcePath, source);
  await writeFile(join(root, "refs.bib"), "@article{a, title={T}}\n");
  await mkdir(join(root, "figures"));
  await writeFile(join(root, "figures", "plot.pdf"), "%PDF-1.4 figure\n");
  return { root, source, sourcePath };
}

function fakeRenderer(runtimeOverrides = {}) {
  return {
    latexExecutable: "/opt/texlive/bin/latexmk",
    runtimeRoots: ["/opt/texlive/bin"],
    ...runtimeOverrides,
  };
}

test("renderer snapshots the whole project, promotes a validated PDF, and keeps last-good on failure", async () => {
  const { SafeLatexRenderer } = await import("../extensions/chatero-documentation/safe-latex-renderer.mjs");
  const fixture = await project();
  const seen = [];
  let calls = 0;
  const renderer = new SafeLatexRenderer({
    runtime: fakeRenderer(),
    sandboxFactory: input => ({ ...input.invocation, env: {}, kind: "sandboxed" }),
    run: async invocation => {
      calls += 1;
      const snapshotRoot = resolve(invocation.cwd, "..");
      seen.push({
        bib: await readFile(join(snapshotRoot, "source", "refs.bib"), "utf8"),
        figure: await readFile(join(snapshotRoot, "source", "figures", "plot.pdf"), "utf8"),
      });
      if (calls === 2) {
        await writeFile(join(snapshotRoot, "output", "note.log"), "! Undefined control sequence.\nl.4 \\bogus\n");
        return { code: 1, stderr: "latexmk exited" };
      }
      await writeFile(join(snapshotRoot, "output", "note.pdf"), "%PDF-1.7\nrendered\n");
      return { code: 0, stderr: "" };
    },
  });

  const first = await renderer.render({ sourcePath: fixture.sourcePath, source: fixture.source, version: 1 });
  assert.equal(first.kind, "rendered", JSON.stringify(first));
  assert.match(await readFile(first.pdfPath, "utf8"), /^%PDF-1\.7/u);
  assert.equal(seen[0].bib, "@article{a, title={T}}\n");
  assert.match(seen[0].figure, /figure/u);

  const second = await renderer.render({ sourcePath: fixture.sourcePath, source: fixture.source, version: 2 });
  assert.equal(second.kind, "failed-with-last-good");
  assert.equal(second.lastGood.pdfPath, first.pdfPath);
  assert.match(second.diagnostic, /Undefined control sequence/u);
  await renderer.dispose();
});

test("renderer refuses unsaved buffers, symlinked projects, and non-PDF output", async () => {
  const { SafeLatexRenderer } = await import("../extensions/chatero-documentation/safe-latex-renderer.mjs");
  const fixture = await project();
  const outside = await temporary();
  await writeFile(join(outside, "secret.key"), "secret");
  await symlink(join(outside, "secret.key"), join(fixture.root, "link.key"));

  const linked = new SafeLatexRenderer({
    runtime: fakeRenderer(),
    sandboxFactory: input => ({ ...input.invocation, env: {}, kind: "sandboxed" }),
    run: async () => assert.fail("must not compile a project containing a symbolic link"),
  });
  const refused = await linked.render({ sourcePath: fixture.sourcePath, source: fixture.source, version: 1 });
  assert.equal(refused.kind, "unsafe-input");
  assert.match(refused.reason, /symbolic link/u);
  await linked.dispose();

  const clean = await project();
  const stale = new SafeLatexRenderer({
    runtime: fakeRenderer(),
    sandboxFactory: input => ({ ...input.invocation, env: {}, kind: "sandboxed" }),
    run: async () => assert.fail("must not compile an unsaved buffer"),
  });
  assert.equal((await stale.render({ sourcePath: clean.sourcePath, source: "edited but unsaved\n", version: 3 })).kind, "unsaved-input");
  await stale.dispose();

  const empty = await project();
  const noPdf = new SafeLatexRenderer({
    runtime: fakeRenderer(),
    sandboxFactory: input => ({ ...input.invocation, env: {}, kind: "sandboxed" }),
    run: async () => ({ code: 0, stderr: "" }),
  });
  const missing = await noPdf.render({ sourcePath: empty.sourcePath, source: empty.source, version: 1 });
  assert.equal(missing.kind, "failed");
  assert.match(missing.diagnostic, /no valid PDF|ENOENT/u);
  await noPdf.dispose();
});

test("renderer reports sandbox unavailability without leaving snapshots behind", async () => {
  const { SafeLatexRenderer } = await import("../extensions/chatero-documentation/safe-latex-renderer.mjs");
  const fixture = await project();
  const renderer = new SafeLatexRenderer({
    runtime: fakeRenderer(),
    sandboxFactory: () => ({ kind: "preview-unavailable", reason: "sandbox-unavailable" }),
    run: async () => assert.fail("must not run without a sandbox"),
  });
  const result = await renderer.render({ sourcePath: fixture.sourcePath, source: fixture.source, version: 1 });
  assert.equal(result.kind, "preview-unavailable");
  assert.equal(result.reason, "sandbox-unavailable");
  assert.equal(renderer.roots.size, 0);
  await renderer.dispose();
});

test("renderer never copies a project latexmkrc into the compile directory", async () => {
  const { SafeLatexRenderer } = await import("../extensions/chatero-documentation/safe-latex-renderer.mjs");
  const fixture = await project();
  await writeFile(join(fixture.root, "latexmkrc"), 'system("touch /tmp/chatero-latexmkrc-pwned");\n');
  await writeFile(join(fixture.root, ".latexmkrc"), 'system("touch /tmp/chatero-dot-latexmkrc-pwned");\n');
  const copied = [];
  const renderer = new SafeLatexRenderer({
    runtime: fakeRenderer(),
    sandboxFactory: input => ({ ...input.invocation, env: {}, kind: "sandboxed" }),
    run: async invocation => {
      const { readdir } = await import("node:fs/promises");
      copied.push(...await readdir(invocation.cwd));
      await writeFile(join(invocation.cwd, "..", "output", "note.pdf"), "%PDF-1.7\nok\n");
      return { code: 0, stderr: "" };
    },
  });
  assert.equal((await renderer.render({ sourcePath: fixture.sourcePath, source: fixture.source, version: 1 })).kind, "rendered");
  assert.equal(copied.includes("latexmkrc"), false, "a project latexmkrc must never reach the compile directory");
  assert.equal(copied.includes(".latexmkrc"), false);
  assert.ok(copied.includes("note.tex"));
  await renderer.dispose();
});

test("renderer stops a compile that never terminates and reports why", async () => {
  const { SafeLatexRenderer } = await import("../extensions/chatero-documentation/safe-latex-renderer.mjs");
  const fixture = await project();
  const renderer = new SafeLatexRenderer({
    runtime: fakeRenderer(),
    sandboxFactory: input => ({ ...input.invocation, env: {}, kind: "sandboxed" }),
    run: async (invocation, options) => {
      assert.ok(options && "signal" in options, "the renderer must pass an abort signal to the runner");
      return { code: 137, signal: "SIGKILL", stderr: "LaTeX compile exceeded 180s and was stopped" };
    },
  });
  const result = await renderer.render({ sourcePath: fixture.sourcePath, source: fixture.source, version: 1 });
  assert.equal(result.kind, "failed");
  assert.match(result.diagnostic, /exceeded 180s/u);
  await renderer.dispose();
});

test("renderer accepts a buffer that differs from disk only by a BOM or line endings", async () => {
  const { SafeLatexRenderer } = await import("../extensions/chatero-documentation/safe-latex-renderer.mjs");
  const fixture = await project("\\documentclass{article}\r\n\\begin{document}x\\end{document}\r\n");
  const renderer = new SafeLatexRenderer({
    runtime: fakeRenderer(),
    sandboxFactory: input => ({ ...input.invocation, env: {}, kind: "sandboxed" }),
    run: async invocation => {
      await writeFile(join(invocation.cwd, "..", "output", "note.pdf"), "%PDF-1.7\nok\n");
      return { code: 0, stderr: "" };
    },
  });
  const buffer = `\uFEFF${fixture.source.replaceAll("\r\n", "\n")}`;
  assert.equal((await renderer.render({ sourcePath: fixture.sourcePath, source: buffer, version: 1 })).kind, "rendered");
  assert.equal((await renderer.render({ sourcePath: fixture.sourcePath, source: "genuinely different\n", version: 2 })).kind, "unsaved-input");
  await renderer.dispose();
});

test("real latexmk ignores a project latexmkrc once -norc is passed", { skip: process.platform !== "linux" }, async t => {
  const { buildSafeLatexInvocation } = await import("../extensions/chatero-documentation/safe-latex-renderer.mjs");
  const { access } = await import("node:fs/promises");
  let latexmk;
  for (const candidate of ["/usr/bin/latexmk", "/usr/local/bin/latexmk", `${process.env.HOME}/.TinyTeX/bin/x86_64-linux/latexmk`]) {
    if (await access(candidate).then(() => true, () => false)) { latexmk = candidate; break; }
  }
  if (!latexmk) { t.skip("latexmk is not installed"); return; }
  const root = await temporary();
  const source = join(root, "source");
  await mkdir(source);
  await mkdir(join(root, "output"));
  const marker = join(root, "RC_EXECUTED");
  await writeFile(join(source, "note.tex"), "\\documentclass{article}\\begin{document}hi\\end{document}\n");
  await writeFile(join(source, "latexmkrc"), `system("touch ${marker}");\n`);
  const invocation = buildSafeLatexInvocation({
    snapshot: { disposableRoot: root, entryBasename: "note.tex" },
    runtime: { latexExecutable: latexmk },
  });
  await execFile(invocation.file, invocation.args, { cwd: invocation.cwd, timeout: 120_000 }).catch(() => {});
  const { access: exists } = await import("node:fs/promises");
  assert.equal(await exists(marker).then(() => true, () => false), false, "-norc must stop latexmk evaluating a project rc file");
});
