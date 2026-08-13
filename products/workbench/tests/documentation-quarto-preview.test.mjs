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
  assert.equal(buildSafeQuartoSandbox({ platform: "linux", invocation: sandbox, runtimeRoot: "/runtime", snapshotRoot: "/snapshot", outputRoot: "/snapshot/output", temporaryRoot: "/snapshot/tmp" }).kind, "preview-unavailable");
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
