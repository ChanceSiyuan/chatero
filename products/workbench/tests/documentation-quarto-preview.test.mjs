import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const temporaryDirectories = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true }))));

async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "chatero-safe-quarto-test-"));
  temporaryDirectories.push(path);
  return path;
}

test("passive Quarto policy accepts prose metadata and rejects every executable surface", async () => {
  const { validatePassiveQuartoInput } = await import("../extensions/chatero-documentation/quarto-input-policy.mjs");
  const safe = validatePassiveQuartoInput("---\ntitle: Safe paper\nauthor:\n  - Ada\ncategories: [proof, notes]\n---\n# Result\n\nInline $x^2$.\n");
  assert.equal(safe.kind, "passive-input");
  assert.equal(safe.metadata.title, "Safe paper");

  for (const [source, reason] of [
    ["---\nexecute: true\n---\nText\n", "execute"],
    ["---\nfilters: [evil.lua]\n---\nText\n", "filters"],
    ["---\nformat: html\n---\nText\n", "format"],
    ["```{python}\nopen('/tmp/owned','w')\n```\n", "executable-code"],
    ["{{< include /etc/passwd >}}\n", "shortcode"],
    ["<script>alert(1)</script>\n", "raw-html"],
    ["```{=html}\n<iframe src='https://evil.example'>\n```\n", "raw-block"],
  ]) {
    const result = validatePassiveQuartoInput(source);
    assert.equal(result.kind, "unsafe-input", source);
    assert.equal(result.reason, reason, source);
  }
});

test("fixed Quarto invocation always renders one disposable source without execution or listener", async () => {
  const { buildSafeQuartoInvocation } = await import("../extensions/chatero-documentation/safe-quarto-renderer.mjs");
  const invocation = buildSafeQuartoInvocation({
    snapshot: { disposableRoot: "/private/snapshot", entryBasename: "index.qmd" },
    runtime: { quartoExecutable: "/Applications/quarto/bin/quarto" },
    output: { relativePath: "./output" },
  });
  assert.deepEqual(invocation, {
    file: "/Applications/quarto/bin/quarto",
    args: ["render", "./source/index.qmd", "--no-execute", "--output-dir", "./output"],
    cwd: "/private/snapshot",
    shell: false,
  });
  assert.equal(invocation.args.includes("preview"), false);
  assert.equal(invocation.args.filter(value => value === "--no-execute").length, 1);
});

test("macOS sandbox denies network and home while granting only runtime, snapshot, output and private temp", async () => {
  const { buildSafeQuartoSandbox } = await import("../extensions/chatero-documentation/safe-quarto-sandbox.mjs");
  const sandbox = buildSafeQuartoSandbox({
    platform: "darwin",
    invocation: { file: "/Applications/quarto/bin/quarto", args: ["render"], cwd: "/private/snapshot", shell: false },
    runtimeRoot: "/Applications/quarto",
    snapshotRoot: "/private/snapshot",
    outputRoot: "/private/snapshot/output",
    temporaryRoot: "/private/snapshot/tmp",
  });
  assert.equal(sandbox.file, "/usr/bin/sandbox-exec");
  assert.deepEqual(sandbox.args.slice(-2), ["/Applications/quarto/bin/quarto", "render"]);
  assert.match(sandbox.profile, /\(deny network\*\)/u);
  assert.match(sandbox.profile, /deny file-read\*.*\/Users/u);
  assert.match(sandbox.profile, /deny process-exec.*\/Users.*\/Volumes/u);
  assert.doesNotMatch(sandbox.profile, /\/Users\/[^"]+/);
  assert.deepEqual(Object.keys(sandbox.env).sort(), ["HOME", "LANG", "LC_ALL", "PATH", "QUARTO_DENO_EXTRA_OPTIONS", "TMPDIR"]);
  assert.equal(buildSafeQuartoSandbox({ platform: "linux", probeSandboxExecutable: () => false, invocation: sandbox, runtimeRoot: "/runtime", snapshotRoot: "/snapshot", outputRoot: "/snapshot/output", temporaryRoot: "/snapshot/tmp" }).kind, "preview-unavailable");
  assert.equal(buildSafeQuartoSandbox({ platform: "freebsd", invocation: sandbox, runtimeRoot: "/runtime", snapshotRoot: "/snapshot", outputRoot: "/snapshot/output", temporaryRoot: "/snapshot/tmp" }).kind, "preview-unavailable");
  assert.equal(buildSafeQuartoSandbox({ platform: "darwin", execution: true, invocation: sandbox, runtimeRoot: "/runtime", snapshotRoot: "/snapshot", outputRoot: "/snapshot/output", temporaryRoot: "/snapshot/tmp" }).reason, "execution-unavailable");
});

test("Linux sandbox confines Quarto with bubblewrap and opens network only for sandboxed execution", async () => {
  const { buildSafeQuartoSandbox } = await import("../extensions/chatero-documentation/safe-quarto-sandbox.mjs");
  const invocation = { file: "/opt/quarto/bin/quarto", args: ["render", "./source/index.qmd", "--output-dir", "./output"], cwd: "/tmp/chatero-quarto-x", shell: false };
  const base = {
    platform: "linux",
    probeSandboxExecutable: path => path === "/usr/bin/bwrap",
    invocation,
    runtimeRoot: "/opt/quarto",
    snapshotRoot: "/tmp/chatero-quarto-x",
    outputRoot: "/tmp/chatero-quarto-x/output",
    temporaryRoot: "/tmp/chatero-quarto-x/tmp",
  };
  const passive = buildSafeQuartoSandbox(base);
  assert.equal(passive.kind, "sandboxed");
  assert.equal(passive.file, "/usr/bin/bwrap");
  assert.equal(passive.execution, false);
  assert.ok(passive.args.includes("--unshare-net"));
  assert.deepEqual(passive.args.slice(-1 - invocation.args.length), [invocation.file, ...invocation.args]);
  const readOnlyRuntime = passive.args.indexOf("--ro-bind");
  assert.deepEqual(passive.args.slice(readOnlyRuntime, readOnlyRuntime + 3), ["--ro-bind", "/usr", "/usr"]);
  const flat = passive.args.join(" ");
  assert.ok(flat.includes("--ro-bind-try /opt/quarto/bin /opt/quarto/bin"));
  assert.ok(flat.includes("--ro-bind-try /opt/quarto/share /opt/quarto/share"));
  assert.equal(flat.includes("--ro-bind /opt/quarto /opt/quarto"), false);
  assert.ok(flat.includes("--bind /tmp/chatero-quarto-x /tmp/chatero-quarto-x"));
  assert.ok(flat.includes("--chdir /tmp/chatero-quarto-x"));
  const { homedir } = await import("node:os");
  const boundSources = passive.args.filter((value, index) => ["--bind", "--ro-bind", "--ro-bind-try"].includes(passive.args[index - 1]));
  for (const forbidden of ["/", homedir()]) assert.equal(boundSources.includes(forbidden), false);
  assert.deepEqual(Object.keys(passive.env).sort(), ["HOME", "LANG", "LC_ALL", "PATH", "QUARTO_DENO_EXTRA_OPTIONS", "TMPDIR"]);

  const executing = buildSafeQuartoSandbox({ ...base, execution: true });
  assert.equal(executing.kind, "sandboxed");
  assert.equal(executing.execution, true);
  assert.ok(executing.args.includes("--unshare-net"), "execution-enabled renders must also unshare the network namespace");
  assert.ok(executing.args.includes("--unshare-pid"));
});

test("bubblewrap keeps loopback usable for Jupyter kernels while blocking external network", { skip: process.platform !== "linux" }, async t => {
  const { buildSafeQuartoSandbox } = await import("../extensions/chatero-documentation/safe-quarto-sandbox.mjs");
  const { mkdir } = await import("node:fs/promises");
  const snapshotRoot = resolve(await temporary());
  await mkdir(join(snapshotRoot, "output"));
  await mkdir(join(snapshotRoot, "tmp"));
  const probe = 'import socket\ns = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(1)\nc = socket.socket(); c.connect(("127.0.0.1", s.getsockname()[1])); print("LOOPBACK_OK")\ntry:\n    x = socket.socket(); x.settimeout(2); x.connect(("10.255.255.1", 80)); print("EXTERNAL_BAD")\nexcept Exception:\n    print("EXTERNAL_BLOCKED")\n';
  const sandbox = buildSafeQuartoSandbox({
    platform: "linux",
    execution: true,
    invocation: { file: "/usr/bin/python3", args: ["-c", probe], cwd: snapshotRoot, shell: false },
    runtimeRoot: "/usr",
    snapshotRoot,
    outputRoot: join(snapshotRoot, "output"),
    temporaryRoot: join(snapshotRoot, "tmp"),
  });
  if (sandbox.kind !== "sandboxed") {
    t.skip("bubblewrap unavailable");
    return;
  }
  let stdout;
  try { ({ stdout } = await execFile(sandbox.file, sandbox.args, { cwd: sandbox.cwd, env: sandbox.env, timeout: 20_000 })); }
  catch {
    t.skip("bubblewrap or python3 unavailable, or user namespaces are restricted");
    return;
  }
  assert.match(stdout, /LOOPBACK_OK/u);
  assert.match(stdout, /EXTERNAL_BLOCKED/u);
  assert.doesNotMatch(stdout, /EXTERNAL_BAD/u);
});

test("installed bubblewrap blocks reads outside the snapshot while serving files inside it", { skip: process.platform !== "linux" }, async t => {
  const { buildSafeQuartoSandbox } = await import("../extensions/chatero-documentation/safe-quarto-sandbox.mjs");
  try {
    await execFile("/usr/bin/bwrap", ["--ro-bind", "/usr", "/usr", "--ro-bind-try", "/bin", "/bin", "--ro-bind-try", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--unshare-net", "/usr/bin/true"], { timeout: 10_000 });
  }
  catch {
    t.skip("bubblewrap unavailable or user namespaces are restricted");
    return;
  }
  const { mkdir } = await import("node:fs/promises");
  const snapshotRoot = resolve(await temporary());
  const outsideRoot = resolve(await temporary());
  await mkdir(join(snapshotRoot, "output"));
  await mkdir(join(snapshotRoot, "tmp"));
  await writeFile(join(snapshotRoot, "inside.txt"), "inside");
  await writeFile(join(outsideRoot, "secret.txt"), "secret");
  const build = file => buildSafeQuartoSandbox({
    platform: "linux",
    invocation: { file: "/bin/cat", args: [file], cwd: snapshotRoot, shell: false },
    runtimeRoot: "/usr",
    snapshotRoot,
    outputRoot: join(snapshotRoot, "output"),
    temporaryRoot: join(snapshotRoot, "tmp"),
  });
  const denied = build(join(outsideRoot, "secret.txt"));
  await assert.rejects(execFile(denied.file, denied.args, { cwd: denied.cwd, env: denied.env }));
  const allowed = build(join(snapshotRoot, "inside.txt"));
  const { stdout } = await execFile(allowed.file, allowed.args, { cwd: allowed.cwd, env: allowed.env });
  assert.equal(stdout, "inside");
});

test("installed macOS sandbox blocks real workspace reads and loopback network access", { skip: process.platform !== "darwin" }, async () => {
  const { buildSafeQuartoSandbox } = await import("../extensions/chatero-documentation/safe-quarto-sandbox.mjs");
  const root = resolve(await temporary());
  const outputRoot = join(root, "output");
  const temporaryRoot = join(root, "tmp");
  await Promise.all([import("node:fs/promises").then(({ mkdir }) => mkdir(outputRoot)), import("node:fs/promises").then(({ mkdir }) => mkdir(temporaryRoot))]);
  const protectedWorkspaceFile = resolve(import.meta.dirname, "../../../package.json");
  const deniedRead = buildSafeQuartoSandbox({
    invocation: { file: "/bin/cat", args: [protectedWorkspaceFile], cwd: root, shell: false },
    runtimeRoot: "/Applications/quarto", snapshotRoot: root, outputRoot, temporaryRoot,
  });
  await assert.rejects(execFile(deniedRead.file, deniedRead.args, { cwd: deniedRead.cwd, env: deniedRead.env }), /Operation not permitted|Permission denied/iu);

  let contacted = false;
  const server = createServer((_request, response) => { contacted = true; response.end("unexpected"); });
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const deniedNetwork = buildSafeQuartoSandbox({
    invocation: { file: "/usr/bin/curl", args: ["--max-time", "1", `http://127.0.0.1:${address.port}/`], cwd: root, shell: false },
    runtimeRoot: "/Applications/quarto", snapshotRoot: root, outputRoot, temporaryRoot,
  });
  await assert.rejects(execFile(deniedNetwork.file, deniedNetwork.args, { cwd: deniedNetwork.cwd, env: deniedNetwork.env }));
  assert.equal(contacted, false);
  await new Promise(resolveClose => server.close(resolveClose));
});

test("renderer promotes only validated HTML and retains last-good output after refresh failure", async () => {
  const { SafeQuartoRenderer } = await import("../extensions/chatero-documentation/safe-quarto-renderer.mjs");
  const root = await temporary();
  const sourcePath = join(root, "paper.qmd");
  await writeFile(sourcePath, "---\ntitle: Paper\n---\n# First\n");
  let calls = 0;
  const renderer = new SafeQuartoRenderer({
    runtime: { quartoExecutable: "/Applications/quarto/bin/quarto", runtimeRoot: "/Applications/quarto" },
    sandboxFactory: input => ({ ...input.invocation, env: {}, kind: "sandboxed" }),
    run: async invocation => {
      calls += 1;
      if (calls === 2) return { code: 1, stderr: "paper.qmd:4: invalid citation" };
      await import("node:fs/promises").then(({ mkdir }) => mkdir(join(invocation.cwd, "output", "source"), { recursive: true }));
      await writeFile(join(invocation.cwd, "output", "source", "index.html"), "<!doctype html><html><body>exact</body></html>");
      return { code: 0, stderr: "" };
    },
  });
  const first = await renderer.render({ sourcePath, source: await readFile(sourcePath, "utf8"), version: 1 });
  assert.equal(first.kind, "rendered");
  assert.equal(await readFile(first.entryPath, "utf8"), "<!doctype html><html><body>exact</body></html>");
  await writeFile(sourcePath, "# Broken\n");
  const second = await renderer.render({ sourcePath, source: await readFile(sourcePath, "utf8"), version: 2 });
  assert.equal(second.kind, "failed-with-last-good");
  assert.equal(second.lastGood.entryPath, first.entryPath);
  assert.match(second.diagnostic, /invalid citation/u);
  await renderer.dispose();
});

test("tokenized static preview serves only immutable contained GET/HEAD files", async () => {
  const { createQuartoStaticServer } = await import("../extensions/chatero-documentation/quarto-static-server.mjs");
  const root = await temporary();
  await writeFile(join(root, "index.html"), "<!doctype html><title>Paper</title>");
  const server = await createQuartoStaticServer({ root, token: "a".repeat(43) });
  assert.match(server.url, new RegExp(`/a{43}/index\\.html$`, "u"));
  const ok = await fetch(server.url);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "<!doctype html><title>Paper</title>");
  assert.match(ok.headers.get("content-security-policy"), /script-src 'self' 'unsafe-inline'.*connect-src 'none'.*form-action 'none'/u);
  assert.equal((await fetch(new URL("../secret", server.url))).status, 404);
  assert.equal((await fetch(server.url, { method: "POST" })).status, 405);
  await server.dispose();
});

test("installed pinned Quarto renders a passive QMD inside the macOS product sandbox", { skip: process.platform !== "darwin" }, async t => {
  const [{ resolveVerifiedQuartoRuntime }, { SafeQuartoRenderer }] = await Promise.all([
    import("../extensions/chatero-documentation/quarto-runtime.mjs"),
    import("../extensions/chatero-documentation/safe-quarto-renderer.mjs"),
  ]);
  const runtime = await resolveVerifiedQuartoRuntime();
  if (runtime.kind !== "verified-runtime") {
    t.skip(`pinned Quarto unavailable: ${runtime.reason}`);
    return;
  }
  const root = await temporary();
  const sourcePath = join(root, "paper.qmd");
  await writeFile(sourcePath, "---\ntitle: Sandboxed Paper\n---\n# Exact preview\n\nInline $x^2$.\n");
  const renderer = new SafeQuartoRenderer({ runtime });
  const result = await renderer.render({ sourcePath, source: await readFile(sourcePath, "utf8"), version: 1 });
  assert.equal(result.kind, "rendered", JSON.stringify(result));
  assert.match(await readFile(result.entryPath, "utf8"), /Sandboxed Paper|Exact preview/u);
  await renderer.dispose();
});

test("preview manager saves dirty source, forwards the exact entry, and keeps last-good on refresh failure", async () => {
  const { QuartoPreviewManager } = await import("../extensions/chatero-documentation/quarto-preview-manager.mjs");
  const root = await temporary();
  const entryPath = join(root, "source", "index.html");
  const document = {
    isDirty: true,
    version: 1,
    uri: { scheme: "file", fsPath: join(root, "paper.qmd"), path: "/paper.qmd", toString: () => "file:///paper.qmd" },
    getText: () => "# Paper\n",
    async save() { this.isDirty = false; return true; },
  };
  const panels = [];
  const warnings = [];
  let disposeServer = 0;
  let renderCall = 0;
  const renderer = {
    async render() {
      renderCall += 1;
      return renderCall === 1
        ? { kind: "rendered", root, entryPath }
        : { kind: "failed-with-last-good", diagnostic: "bad citation", lastGood: { root, entryPath } };
    },
    async dispose() {},
  };
  const vscode = {
    ViewColumn: { Beside: 2 },
    Uri: { parse: value => ({ toString: () => value }) },
    env: { async asExternalUri(uri) { return uri; } },
    workspace: { isTrusted: true },
    window: {
      activeTextEditor: { document },
      async showWarningMessage(message) { warnings.push(message); return "Save and Preview"; },
      async showErrorMessage() {},
      createWebviewPanel() {
        const panel = { webview: { cspSource: "https://*.vscode-cdn.net", html: "" }, onDidDispose() {}, reveal() {} };
        panels.push(panel);
        return panel;
      },
    },
  };
  const manager = new QuartoPreviewManager({
    vscode,
    runtimeResolver: async () => ({ kind: "verified-runtime", quartoExecutable: "/runtime/quarto", runtimeRoot: "/runtime" }),
    rendererFactory: () => renderer,
    staticServerFactory: async input => {
      assert.equal(input.entryPath, entryPath);
      return { url: "http://127.0.0.1:4444/token/source/index.html", async dispose() { disposeServer += 1; } };
    },
  });
  assert.equal((await manager.open()).kind, "rendered");
  assert.match(panels[0].webview.html, /Exact Quarto Preview · read-only/u);
  assert.match(panels[0].webview.html, /sandbox="allow-scripts allow-same-origin"/u);
  assert.equal((await manager.open()).kind, "failed-with-last-good");
  assert.match(warnings.at(-1), /last good preview remains visible/iu);
  assert.equal(disposeServer, 0);
  await manager.dispose();
  assert.equal(disposeServer, 1);
});

test("Linux runtime resolver requires a pinned sha256 allowlist and verifies digest and version", async () => {
  const { resolveVerifiedQuartoRuntime } = await import("../extensions/chatero-documentation/quarto-runtime.mjs");
  const { chmod, mkdir: makeDirectory, realpath } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const root = resolve(await realpath(await temporary()));
  await makeDirectory(join(root, "bin"));
  const executable = join(root, "bin", "quarto");
  const script = "#!/bin/sh\necho 1.8.26\n";
  await writeFile(executable, script);
  await chmod(executable, 0o755);
  const digest = createHash("sha256").update(script).digest("hex");
  const run = async () => ({ stdout: "1.8.26\n" });

  assert.equal((await resolveVerifiedQuartoRuntime({ platform: "linux", executable, run })).reason, "runtime-unpinned");
  assert.equal((await resolveVerifiedQuartoRuntime({ platform: "linux", executable, run, sha256Allowlist: ["not-a-digest"] })).reason, "runtime-unpinned");
  assert.equal((await resolveVerifiedQuartoRuntime({ platform: "linux", executable, run, sha256Allowlist: ["f".repeat(64)] })).reason, "runtime-digest-mismatch");
  assert.equal((await resolveVerifiedQuartoRuntime({
    platform: "linux", executable, sha256Allowlist: [digest], run: async () => ({ stdout: "9.9.9\n" }),
  })).reason, "runtime-version-mismatch");
  assert.equal((await resolveVerifiedQuartoRuntime({ platform: "freebsd", executable, run, sha256Allowlist: [digest] })).reason, "runtime-unavailable");

  const verified = await resolveVerifiedQuartoRuntime({ platform: "linux", executable, run, sha256Allowlist: [digest.toUpperCase()] });
  assert.equal(verified.kind, "verified-runtime");
  assert.equal(verified.version, "1.8.26");
  assert.equal(verified.sha256, digest);
  assert.equal(verified.teamIdentifier, undefined);
  assert.equal(verified.runtimeRoot, root);
});

test("runtime resolver refuses prefixes that would mount the user home into the sandbox", async () => {
  const { resolveVerifiedQuartoRuntime } = await import("../extensions/chatero-documentation/quarto-runtime.mjs");
  const { chmod, mkdir: makeDirectory, realpath } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const root = resolve(await realpath(await temporary()));
  await makeDirectory(join(root, "bin"));
  const executable = join(root, "bin", "quarto");
  const script = "#!/bin/sh\necho 1.8.26\n";
  await writeFile(executable, script);
  await chmod(executable, 0o755);
  const digest = createHash("sha256").update(script).digest("hex");
  const run = async () => ({ stdout: "1.8.26\n" });
  const base = { platform: "linux", executable, run, sha256Allowlist: [digest] };

  for (const homeDirectory of [root, join(root, "bin"), join(root, "deep", "nested", "home")]) {
    const rejected = await resolveVerifiedQuartoRuntime({ ...base, homeDirectory });
    assert.equal(rejected.reason, "runtime-prefix-unsafe", homeDirectory);
  }
  assert.equal((await resolveVerifiedQuartoRuntime({ ...base, homeDirectory: join(root, "..", "elsewhere-home") })).kind, "verified-runtime");
});

test("execution-enabled invocation drops --no-execute while staying pinned to the snapshot", async () => {
  const { buildSafeQuartoInvocation } = await import("../extensions/chatero-documentation/safe-quarto-renderer.mjs");
  const invocation = buildSafeQuartoInvocation({
    snapshot: { disposableRoot: "/private/snapshot", entryBasename: "index.qmd" },
    runtime: { quartoExecutable: "/opt/quarto/bin/quarto" },
    output: { relativePath: "./output" },
    execution: true,
  });
  assert.deepEqual(invocation.args, ["render", "./source/index.qmd", "--output-dir", "./output"]);
  assert.throws(() => buildSafeQuartoInvocation({
    snapshot: { disposableRoot: "/private/snapshot", entryBasename: "index.qmd" },
    runtime: { quartoExecutable: "/opt/quarto/bin/quarto" },
    output: { relativePath: "./output" },
    execution: "yes",
  }), TypeError);
});

test("sandboxed execution mode waives the passive policy and enables execution inside the sandbox only", async () => {
  const { SafeQuartoRenderer } = await import("../extensions/chatero-documentation/safe-quarto-renderer.mjs");
  const root = await temporary();
  const sourcePath = join(root, "paper.qmd");
  const source = "---\ntitle: Computed\n---\n```{python}\n1 + 1\n```\n";
  await writeFile(sourcePath, source);

  const forbidding = new SafeQuartoRenderer({
    runtime: { quartoExecutable: "/opt/quarto/bin/quarto", runtimeRoot: "/opt/quarto" },
    sandboxFactory: input => ({ ...input.invocation, env: {}, kind: "sandboxed" }),
    run: async () => ({ code: 0, stderr: "" }),
  });
  const rejected = await forbidding.render({ sourcePath, source, version: 1 });
  assert.equal(rejected.kind, "unsafe-input");
  assert.equal(rejected.reason, "executable-code");
  await forbidding.dispose();

  const sandboxInputs = [];
  const projectFiles = [];
  const renderer = new SafeQuartoRenderer({
    executionMode: () => "sandboxed",
    runtime: { quartoExecutable: "/opt/quarto/bin/quarto", runtimeRoot: "/opt/quarto" },
    sandboxFactory: input => {
      sandboxInputs.push(input);
      return { ...input.invocation, env: {}, kind: "sandboxed" };
    },
    run: async invocation => {
      projectFiles.push(await readFile(join(invocation.cwd, "_quarto.yml"), "utf8"));
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(invocation.cwd, "output", "source"), { recursive: true });
      await writeFile(join(invocation.cwd, "output", "source", "index.html"), "<!doctype html><html><body>computed</body></html>");
      return { code: 0, stderr: "" };
    },
  });
  const result = await renderer.render({ sourcePath, source, version: 1 });
  assert.equal(result.kind, "rendered", JSON.stringify(result));
  assert.equal(sandboxInputs[0].execution, true);
  assert.equal(sandboxInputs[0].invocation.args.includes("--no-execute"), false);
  assert.match(projectFiles[0], /execute:\n {2}enabled: true/u);
  await renderer.dispose();

  assert.throws(() => new SafeQuartoRenderer({
    executionMode: "unsafe",
    runtime: { quartoExecutable: "/opt/quarto/bin/quarto", runtimeRoot: "/opt/quarto" },
  }), TypeError);
});

test("preview manager accepts Chatero remote documents, keeps source focus, and refreshes quietly on save", async () => {
  const { QuartoPreviewManager } = await import("../extensions/chatero-documentation/quarto-preview-manager.mjs");
  const document = {
    isDirty: false,
    version: 1,
    uri: {
      scheme: "vscode-remote",
      authority: "chatero-remote+lab",
      fsPath: "/work/paper.qmd",
      path: "/work/paper.qmd",
      toString: () => "vscode-remote://chatero-remote%2Blab/work/paper.qmd",
    },
    getText: () => "# Paper\n",
  };
  const foreign = {
    ...document,
    uri: { ...document.uri, authority: "ssh-remote+lab", toString: () => "vscode-remote://ssh-remote%2Blab/work/paper.qmd" },
  };
  const errors = [];
  const warnings = [];
  const statusMessages = [];
  const panelCreations = [];
  let renderCall = 0;
  const renderer = {
    async render() {
      renderCall += 1;
      return renderCall === 1
        ? { kind: "rendered", root: "/served/one", entryPath: "/served/one/source/index.html" }
        : { kind: "failed-with-last-good", diagnostic: "kernel died", lastGood: { root: "/served/one", entryPath: "/served/one/source/index.html" } };
    },
    async dispose() {},
  };
  const vscode = {
    ViewColumn: { Beside: 2 },
    Uri: { parse: value => ({ toString: () => value }) },
    env: { async asExternalUri(uri) { return uri; } },
    workspace: { isTrusted: true },
    window: {
      activeTextEditor: { document },
      async showErrorMessage(message) { errors.push(message); },
      async showWarningMessage(message) { warnings.push(message); },
      setStatusBarMessage(message) { statusMessages.push(message); },
      createWebviewPanel(viewType, title, showOptions, options) {
        panelCreations.push({ viewType, title, showOptions, options });
        return { webview: { cspSource: "https://*.vscode-cdn.net", html: "" }, onDidDispose() {}, reveal() {} };
      },
    },
  };
  const manager = new QuartoPreviewManager({
    vscode,
    runtimeResolver: async () => ({ kind: "verified-runtime", quartoExecutable: "/opt/quarto/bin/quarto", runtimeRoot: "/opt/quarto" }),
    rendererFactory: () => renderer,
    staticServerFactory: async () => ({ url: "http://127.0.0.1:4444/token/source/index.html", async dispose() {} }),
  });

  assert.equal((await manager.open(foreign)).reason, "no-active-qmd");
  assert.match(errors.at(-1), /saved QMD source file/u);

  assert.equal((await manager.open()).kind, "rendered");
  assert.equal(panelCreations[0].showOptions.preserveFocus, true);
  assert.equal(panelCreations[0].showOptions.viewColumn, 2);
  assert.equal(panelCreations[0].options.enableScripts, false);

  await manager.refreshSaved(foreign);
  assert.equal(renderCall, 1);
  await manager.refreshSaved(document);
  assert.equal(renderCall, 2);
  assert.equal(warnings.length, 0);
  assert.match(statusMessages.at(-1), /kernel died/u);

  vscode.window.activeTextEditor = undefined;
  vscode.window.tabGroups = { activeTabGroup: { activeTab: { input: { uri: document.uri } } } };
  vscode.workspace.textDocuments = [document];
  assert.equal((await manager.open()).kind, "failed-with-last-good");
  assert.equal(renderCall, 3);
  await manager.dispose();
});

test("registerQuartoPreview wires the save listener and Linux settings-driven runtime and execution mode", { skip: process.platform !== "linux" }, async () => {
  const { registerQuartoPreview } = await import("../extensions/chatero-documentation/quarto-preview-manager.mjs");
  const { chmod } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const root = resolve(await temporary());
  const executable = join(root, "quarto");
  const script = "#!/bin/sh\necho 1.8.26\n";
  await writeFile(executable, script);
  await chmod(executable, 0o755);
  const settings = {
    executablePath: executable,
    sha256Allowlist: [createHash("sha256").update(script).digest("hex")],
    allowExecution: true,
  };
  const commands = [];
  const saveListeners = [];
  const vscode = {
    ViewColumn: { Beside: 2 },
    Uri: { parse: value => ({ toString: () => value }) },
    env: { remoteName: "chatero-remote", async asExternalUri(uri) { return uri; } },
    commands: { registerCommand: (name, handler) => { commands.push(name); return { dispose() {}, handler }; } },
    workspace: {
      isTrusted: true,
      getConfiguration(section) {
        assert.equal(section, "chatero.documentation.remoteQuarto");
        return { get: key => settings[key] };
      },
      onDidSaveTextDocument(listener) { saveListeners.push(listener); return { dispose() {} }; },
    },
    window: { activeTextEditor: undefined, async showErrorMessage() {}, async showWarningMessage() {} },
  };
  const [command, saveSubscription, previewManager] = await registerQuartoPreview({ vscode, platform: "linux" });
  assert.equal(commands[0], "chatero.documentation.openQuartoPreview");
  assert.equal(typeof saveSubscription.dispose, "function");
  assert.equal(saveListeners.length, 1);
  saveListeners[0]({ uri: { scheme: "file", fsPath: "/somewhere/else.qmd", toString: () => "file:///somewhere/else.qmd" } });

  assert.equal(previewManager.executionMode(), "sandboxed");
  vscode.env.remoteName = undefined;
  assert.equal(previewManager.executionMode(), "forbid", "execution must be denied outside a Chatero remote workspace");
  vscode.env.remoteName = "chatero-remote";
  settings.allowExecution = false;
  assert.equal(previewManager.executionMode(), "forbid");

  const runtime = await previewManager.runtimeResolver();
  assert.equal(runtime.kind, "verified-runtime", JSON.stringify(runtime));
  assert.equal(runtime.sha256, settings.sha256Allowlist[0]);
  settings.sha256Allowlist = [];
  assert.equal((await previewManager.runtimeResolver()).reason, "runtime-unpinned");
  assert.ok(command);
  await previewManager.dispose();
});
