import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map(path => rm(path, { force: true, recursive: true })));
});

test("builds deterministic, self-contained Documentation webview assets", async () => {
  const first = await mkdtemp(join(tmpdir(), "chatero-documentation-bundle-a-"));
  const second = await mkdtemp(join(tmpdir(), "chatero-documentation-bundle-b-"));
  temporaryDirectories.push(first, second);
  const {
    DOCUMENTATION_WEBVIEW_OUTPUTS,
    KATEX_WOFF2_FILES,
    XML_NAMESPACE_URLS,
    auditDocumentationJavaScript,
    buildDocumentationWebview,
  } = await import("../scripts/build-documentation-webview.mjs");
  const a = await buildDocumentationWebview({ root: repositoryRoot, outdir: first });
  const b = await buildDocumentationWebview({ root: repositoryRoot, outdir: second });

  assert.deepEqual(a.files.map(file => file.path), DOCUMENTATION_WEBVIEW_OUTPUTS);
  assert.deepEqual(a.files, b.files);
  for (const file of a.files) {
    const bytesA = await readFile(join(first, file.path));
    const bytesB = await readFile(join(second, file.path));
    assert.deepEqual(bytesA, bytesB);
    assert.ok(bytesA.length < 4 * 1024 * 1024);
    assert.doesNotMatch(bytesA.toString("utf8"), /sourceMappingURL|marketplace\.visualstudio\.com|update\.code\.visualstudio\.com/i);
    assert.doesNotMatch(bytesA.toString("utf8"), new RegExp(repositoryRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (file.path.endsWith(".js")) {
      const audit = auditDocumentationJavaScript(bytesA.toString("utf8"));
      assert.ok(audit.urlLiterals.every(value => XML_NAMESPACE_URLS.includes(value)));
    }
  }
  const stylesheet = await readFile(join(first, "live-preview.css"), "utf8");
  assert.match(stylesheet, /\.katex/u);
  assert.doesNotMatch(stylesheet, /\.(?:woff|ttf)\)/u);
  assert.deepEqual(
    a.files.filter(file => file.path.startsWith("fonts/")).map(file => file.path),
    KATEX_WOFF2_FILES.map(name => `fonts/${name}`),
  );
});

test("audits JavaScript syntax rather than comments or identifier substrings", async () => {
  const { XML_NAMESPACE_URLS, auditDocumentationJavaScript } = await import("../scripts/build-documentation-webview.mjs");
  assert.deepEqual(XML_NAMESPACE_URLS, [
    "http://www.w3.org/2000/svg",
    "http://www.w3.org/1998/Math/MathML",
    "http://www.w3.org/1999/xlink",
    "http://www.w3.org/1999/xhtml",
    "http://www.w3.org/XML/1998/namespace",
  ]);

  const safe = `
    // fetch("https://example.invalid") and import("./late.mjs") are inert comments.
    const XMLHttpRequester = "harmless";
    const namespaces = ${JSON.stringify(XML_NAMESPACE_URLS)};
    void XMLHttpRequester; void namespaces;
  `;
  assert.deepEqual(auditDocumentationJavaScript(safe).urlLiterals, XML_NAMESPACE_URLS);

  const forbidden = [
    'import("./late.mjs")',
    'fetch("/data")',
    'globalThis["fetch"]("/data")',
    "new XMLHttpRequest()",
    'XMLHttpRequest.open("GET", "/data")',
    'new WebSocket("ws://localhost")',
    'new EventSource("/events")',
    'navigator.sendBeacon("/log")',
    'importScripts("worker.js")',
    'new Worker("worker.js")',
    'new SharedWorker("worker.js")',
    'document.createElement("script")',
    'document.createElement("link")',
    'document.createElement("iframe")',
    'eval("1")',
    '(0, eval)("1")',
    'Function("return 1")',
    'new Function("return 1")',
    'const endpoint = "https://example.com/asset.js"',
    'const endpoint = "https://marketplace.visualstudio.com/items"',
    'const endpoint = "https://update.code.visualstudio.com/latest"',
    'const endpoint = "https://marketplacecdn.vsassets.io/file"',
  ];
  for (const source of forbidden) {
    assert.throws(() => auditDocumentationJavaScript(source), /forbidden|URL|network|dynamic|loader|code execution/i, source);
  }
});

test("pins build dependencies and materializes only declared generated assets", async () => {
  const lockfile = JSON.parse(await readFile(join(repositoryRoot, "package-lock.json"), "utf8"));
  const expectedPins = {
    "@codemirror/commands": "6.10.4",
    "@codemirror/state": "6.7.1",
    "@codemirror/view": "6.43.8",
    acorn: "8.15.0",
    esbuild: "0.28.2",
  };
  for (const [name, version] of Object.entries(expectedPins)) {
    assert.equal(lockfile.packages[""].devDependencies[name], version);
    const entry = lockfile.packages[`node_modules/${name}`];
    assert.equal(entry.version, version);
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.integrity, /^sha512-/);
  }
  assert.equal(lockfile.packages[""].dependencies.katex, "0.16.22");
  assert.equal(lockfile.packages["node_modules/katex"].version, "0.16.22");
  for (const entry of Object.values(lockfile.packages)) {
    if (entry?.resolved) {
      assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
      assert.match(entry.integrity, /^sha(?:1|512)-/);
    }
  }

  const manifest = JSON.parse(await readFile(join(repositoryRoot, "products/workbench/first-party-extensions.json"), "utf8"));
  const documentation = manifest.extensions.find(extension => extension.id === "chatero.documentation");
  const mappings = new Map(documentation.files.map(file => [file.destination, file.source]));
  assert.equal(mappings.get("extensions/chatero-documentation/media/documentation-webview/live-preview.js"), "products/workbench/.cache/documentation-webview/live-preview.js");
  assert.equal(mappings.get("extensions/chatero-documentation/media/documentation-webview/live-preview.css"), "products/workbench/.cache/documentation-webview/live-preview.css");
  assert.equal(mappings.get("extensions/chatero-documentation/licenses/CodeMirror-MIT.txt"), "products/workbench/extensions/chatero-documentation/licenses/CodeMirror-MIT.txt");
  assert.equal(mappings.get("extensions/chatero-documentation/licenses/KaTeX-MIT.txt"), "products/workbench/extensions/chatero-documentation/licenses/KaTeX-MIT.txt");

  const bootstrap = await readFile(join(repositoryRoot, "products/workbench/scripts/bootstrap-code-oss.mjs"), "utf8");
  assert.ok(bootstrap.indexOf("await buildDocumentationWebview({ root") < bootstrap.indexOf("await materializeFirstPartyExtensions({"));
});
