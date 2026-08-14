import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

const temporaryDirectories = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true }))));

async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "chatero-latex-preview-"));
  temporaryDirectories.push(path);
  return resolve(path);
}

async function serverFixture() {
  const root = await temporary();
  const viewerRoot = join(root, "pdfjs");
  const hostRoot = join(root, "latex-preview");
  await mkdir(join(viewerRoot, "web"), { recursive: true });
  await mkdir(join(viewerRoot, "build"), { recursive: true });
  await mkdir(hostRoot, { recursive: true });
  await writeFile(join(viewerRoot, "web", "viewer.html"), "<!doctype html><title>viewer</title>");
  await writeFile(join(viewerRoot, "build", "pdf.mjs"), "export const engine = 1;\n");
  await writeFile(join(hostRoot, "latex-preview-host.html"), "<!doctype html><title>host</title>");
  await writeFile(join(root, "outside.txt"), "secret");
  const pdfPath = join(root, "note.pdf");
  await writeFile(pdfPath, "%PDF-1.7\nbody\n");
  const { LatexPreviewServer } = await import("../extensions/chatero-documentation/latex-preview-server.mjs");
  const server = new LatexPreviewServer({ hostRoot, viewerRoot });
  return { hostRoot, pdfPath, root, server, viewerRoot };
}

test("preview server serves the viewer, the host page and only leased PDFs", async () => {
  const fixture = await serverFixture();
  const lease = await fixture.server.lease({ path: fixture.pdfPath });
  try {
    assert.match(lease.viewerUrl, /\/viewer\/web\/viewer\.html\?file=/u);
    // The page addresses the viewer and the PDF relative to itself, so a single
    // asExternalUri rewrite of hostUrl carries all three onto one origin.
    assert.match(lease.hostUrl, /\/host\/latex-preview-host\.html$/u);
    assert.equal(lease.viewerPath, `../viewer/web/viewer.html?file=${encodeURIComponent(lease.documentPath)}`);
    assert.match(lease.documentPath, /^\.\.\/\.\.\/doc\//u);
    assert.equal(new URL(lease.viewerPath, lease.hostUrl).toString().split("?")[0], lease.viewerUrl.split("?")[0]);
    // documentPath is the viewer's file argument, so it resolves against the
    // viewer's own location rather than the host page's.
    assert.equal(new URL(lease.documentPath, lease.viewerUrl.split("?")[0]).toString(), lease.documentUrl);
    assert.equal(new URL(lease.documentUrl).hostname, "127.0.0.1");

    const document = await fetch(lease.documentUrl);
    assert.equal(document.status, 200);
    assert.equal(document.headers.get("content-type"), "application/pdf");
    assert.match(await document.text(), /^%PDF-1\.7/u);

    assert.equal((await fetch(lease.viewerUrl)).status, 200);
    const page = await fetch(lease.hostUrl);
    assert.equal(page.status, 200);
    // Without frame-src the host page cannot embed the viewer at all, because
    // frame loading falls back to default-src 'none'.
    assert.match(page.headers.get("content-security-policy"), /frame-src 'self'/u);
    // The engine the viewer loads from ../build must resolve inside the root.
    assert.equal((await fetch(`${lease.origin}${new URL(lease.viewerUrl).pathname.replace("/web/viewer.html", "/build/pdf.mjs")}`)).status, 200);

    const escape = `${lease.origin}${new URL(lease.viewerUrl).pathname.replace("web/viewer.html", "..%2foutside.txt")}`;
    assert.equal((await fetch(escape)).status, 404);
    assert.equal((await fetch(`${lease.origin}/wrong-token/viewer/web/viewer.html`)).status, 404);
    assert.equal((await fetch(lease.documentUrl, { method: "POST" })).status, 405);

    lease.dispose();
    assert.equal((await fetch(lease.documentUrl)).status, 404, "a revoked lease must stop serving");
  }
  finally { await fixture.server.dispose(); }
});

test("preview server refuses viewer paths reached through a symbolic link", async () => {
  const fixture = await serverFixture();
  await symlink(join(fixture.root, "outside.txt"), join(fixture.viewerRoot, "web", "linked.txt"));
  const lease = await fixture.server.lease({ path: fixture.pdfPath });
  try {
    const linked = `${lease.origin}${new URL(lease.viewerUrl).pathname.replace("viewer.html", "linked.txt")}`;
    assert.equal((await fetch(linked)).status, 404);
  }
  finally { await fixture.server.dispose(); }
});

test("preview server replaces a session lease so only the newest render is readable", async () => {
  const fixture = await serverFixture();
  const first = await fixture.server.lease({ path: fixture.pdfPath });
  try {
    const second = await fixture.server.lease({ path: fixture.pdfPath, leaseId: first.leaseId });
    assert.notEqual(second.leaseId, first.leaseId);
    assert.equal((await fetch(second.documentUrl)).status, 200);
    assert.equal((await fetch(first.documentUrl)).status, 404);
  }
  finally { await fixture.server.dispose(); }
});

test("preview panel HTML frames only the loopback origin under a nonce policy", async () => {
  const { createLatexPreviewHtml } = await import("../extensions/chatero-documentation/latex-preview-html.mjs");
  const html = createLatexPreviewHtml({
    cspSource: "https://*.vscode-cdn.net",
    hostUri: "http://127.0.0.1:4321/token/host/latex-preview-host.html?viewer=x",
    nonce: "a".repeat(24),
  });
  assert.match(html, /frame-src http:\/\/127\.0\.0\.1:4321;/u);
  assert.match(html, /script-src 'nonce-a{24}'/u);
  assert.doesNotMatch(html, /unsafe-inline/u);
  assert.match(html, /sandbox="allow-scripts allow-same-origin"/u);
  for (const bad of [
    { cspSource: "", hostUri: "http://127.0.0.1/x", nonce: "a".repeat(24) },
    { cspSource: "x", hostUri: "file:///etc/passwd", nonce: "a".repeat(24) },
    { cspSource: "x", hostUri: "http://127.0.0.1/x", nonce: "short" },
  ]) assert.throws(() => createLatexPreviewHtml(bad), TypeError);
});

function managerFixture({ documentUri, results } = {}) {
  const messages = [];
  const errors = [];
  const warnings = [];
  const statusMessages = [];
  const panels = [];
  const stored = new Map();
  let renderCall = 0;
  const document = {
    getText: () => "\\documentclass{article}\\begin{document}x\\end{document}\n",
    isDirty: false,
    uri: documentUri ?? {
      authority: "chatero-remote+lab",
      fsPath: "/work/note.tex",
      path: "/work/note.tex",
      scheme: "vscode-remote",
      toString: () => "vscode-remote://chatero-remote%2Blab/work/note.tex",
    },
    version: 1,
  };
  const vscode = {
    ViewColumn: { Beside: 2 },
    Uri: { parse: value => ({ toString: () => value }) },
    env: { async asExternalUri(uri) { return uri; } },
    workspace: { isTrusted: true },
    window: {
      activeTextEditor: { document },
      async showErrorMessage(message) { errors.push(message); },
      async showWarningMessage(message) { warnings.push(message); return "Save and Preview"; },
      setStatusBarMessage(message) { statusMessages.push(message); },
      createWebviewPanel(viewType, title, showOptions, options) {
        const panel = {
          onDidDispose() {},
          options,
          reveal() {},
          showOptions,
          title,
          viewType,
          webview: {
            cspSource: "https://*.vscode-cdn.net",
            html: "",
            onDidReceiveMessage(listener) { panel.receive = listener; },
            postMessage(message) { messages.push(message); return true; },
          },
        };
        panels.push(panel);
        return panel;
      },
    },
  };
  const leases = [];
  const server = {
    async lease({ path, leaseId }) {
      const lease = {
        documentUrl: `http://127.0.0.1:9/t/doc/${leases.length}`,
        hostUrl: `http://127.0.0.1:9/t/host/latex-preview-host.html?viewer=v${leases.length}`,
        leaseId: `lease-${leases.length}`,
        origin: "http://127.0.0.1:9",
        path,
        replaced: leaseId,
        viewerUrl: `http://127.0.0.1:9/t/viewer/web/viewer.html?file=${leases.length}`,
        dispose() { lease.disposed = true; },
      };
      leases.push(lease);
      return lease;
    },
    async dispose() {},
  };
  const renderer = {
    async render() {
      renderCall += 1;
      const outcome = results?.[renderCall - 1] ?? results?.at?.(-1);
      return outcome ?? { kind: "rendered", pdfPath: "/tmp/out/note.pdf", root: `/tmp/out-${renderCall}` };
    },
    async dispose() {},
    async releaseExcept() {},
  };
  const memento = {
    get: key => stored.get(key),
    update: async (key, value) => { stored.set(key, value); },
  };
  return {
    document, errors, leases, memento, messages, panels, renderer, server, statusMessages, stored, vscode,
    renderCalls: () => renderCall, warnings,
  };
}

test("LaTeX preview compiles remote documents, keeps focus, and swaps documents without reloading the panel", async () => {
  const { LatexPreviewManager } = await import("../extensions/chatero-documentation/latex-preview-manager.mjs");
  const fixture = managerFixture();
  const manager = new LatexPreviewManager({
    vscode: fixture.vscode,
    memento: fixture.memento,
    runtimeResolver: async () => ({ kind: "verified-runtime", latexExecutable: "/usr/bin/latexmk", runtimeRoots: ["/usr/bin"] }),
    rendererFactory: () => fixture.renderer,
    server: fixture.server,
  });

  assert.equal((await manager.open()).kind, "rendered");
  assert.equal(fixture.panels[0].showOptions.preserveFocus, true);
  assert.equal(fixture.panels[0].options.localResourceRoots.length, 0);
  assert.match(fixture.panels[0].webview.html, /127\.0\.0\.1:9/u);

  // Nothing is delivered until the loopback page announces itself, which is
  // what makes the restore race impossible and recovers a reloaded webview.
  assert.deepEqual(fixture.messages, []);
  fixture.panels[0].receive({ type: "chatero-latex-host-ready" });
  assert.equal(fixture.messages.at(-1).viewerPath, fixture.leases.at(-1).viewerPath);

  const htmlAfterFirst = fixture.panels[0].webview.html;
  await manager.refreshSaved(fixture.document);
  assert.equal(fixture.renderCalls(), 2);
  assert.equal(fixture.panels.length, 1, "a refresh must not create a second panel");
  assert.equal(fixture.panels[0].webview.html, htmlAfterFirst, "a refresh must not reload the viewer");
  const swap = fixture.messages.at(-1);
  assert.equal(swap.type, "chatero-latex-document");
  assert.equal(swap.viewerPath, fixture.leases.at(-1).viewerPath);
  assert.equal(fixture.leases.at(-1).replaced, fixture.leases[0].leaseId);

  // A webview reload re-announces; the reply must carry the live lease rather
  // than the revoked one the reloaded page would otherwise still reference.
  fixture.panels[0].receive({ type: "chatero-latex-host-ready" });
  assert.equal(fixture.messages.at(-1).viewerPath, fixture.leases.at(-1).viewerPath);
  await manager.dispose();
});

test("LaTeX preview persists the reported position and restores it on a later panel", async () => {
  const { LatexPreviewManager } = await import("../extensions/chatero-documentation/latex-preview-manager.mjs");
  const fixture = managerFixture();
  const build = () => new LatexPreviewManager({
    vscode: fixture.vscode,
    memento: fixture.memento,
    runtimeResolver: async () => ({ kind: "verified-runtime", latexExecutable: "/usr/bin/latexmk", runtimeRoots: ["/usr/bin"] }),
    rendererFactory: () => fixture.renderer,
    server: fixture.server,
  });

  const first = build();
  await first.open();
  fixture.panels[0].receive({ type: "chatero-latex-host-ready" });
  fixture.panels[0].receive({ type: "chatero-latex-position", position: { page: 3, offset: { left: 12, top: 480 } }, scale: "page-width" });
  fixture.panels[0].receive({ type: "chatero-latex-position", position: { page: "bogus" }, scale: 4 });
  await first.dispose();

  const second = build();
  await second.open();
  fixture.panels.at(-1).receive({ type: "chatero-latex-host-ready" });
  const restored = fixture.messages.at(-1);
  assert.equal(restored.type, "chatero-latex-document");
  assert.deepEqual(restored.position, { page: 3, offset: { left: 12, top: 480 } });
  assert.equal(restored.scale, "page-width");
  await second.dispose();
});

test("LaTeX preview keeps the last good PDF visible and reports failures quietly on save", async () => {
  const { LatexPreviewManager } = await import("../extensions/chatero-documentation/latex-preview-manager.mjs");
  const fixture = managerFixture({
    results: [
      { kind: "rendered", pdfPath: "/tmp/out/note.pdf", root: "/tmp/out-1" },
      { kind: "failed-with-last-good", diagnostic: "! Undefined control sequence", lastGood: { pdfPath: "/tmp/out/note.pdf", root: "/tmp/out-1" } },
    ],
  });
  const manager = new LatexPreviewManager({
    vscode: fixture.vscode,
    memento: fixture.memento,
    runtimeResolver: async () => ({ kind: "verified-runtime", latexExecutable: "/usr/bin/latexmk", runtimeRoots: ["/usr/bin"] }),
    rendererFactory: () => fixture.renderer,
    server: fixture.server,
  });

  await manager.open();
  await manager.refreshSaved(fixture.document);
  assert.equal(fixture.leases.length, 1, "a failed compile must not replace the served PDF");
  assert.deepEqual(fixture.warnings, []);
  assert.match(fixture.statusMessages.at(-1), /Undefined control sequence/u);
  await manager.dispose();
});

test("LaTeX preview refuses untrusted workspaces and foreign document schemes", async () => {
  const { LatexPreviewManager } = await import("../extensions/chatero-documentation/latex-preview-manager.mjs");
  const fixture = managerFixture();
  const manager = new LatexPreviewManager({
    vscode: fixture.vscode,
    memento: fixture.memento,
    runtimeResolver: async () => ({ kind: "verified-runtime", latexExecutable: "/usr/bin/latexmk", runtimeRoots: ["/usr/bin"] }),
    rendererFactory: () => fixture.renderer,
    server: fixture.server,
  });

  const foreign = {
    ...fixture.document,
    uri: { ...fixture.document.uri, authority: "ssh-remote+lab", toString: () => "vscode-remote://ssh-remote%2Blab/work/note.tex" },
  };
  assert.equal((await manager.open(foreign)).reason, "no-active-tex");
  const markdown = { ...fixture.document, uri: { ...fixture.document.uri, fsPath: "/work/note.md" } };
  assert.equal((await manager.open(markdown)).reason, "no-active-tex");

  fixture.vscode.workspace.isTrusted = false;
  assert.equal((await manager.open()).reason, "untrusted-workspace");
  assert.equal(fixture.panels.length, 0);
  await manager.dispose();
});

test("LaTeX preview reports an unavailable runtime instead of opening a panel", async () => {
  const { LatexPreviewManager } = await import("../extensions/chatero-documentation/latex-preview-manager.mjs");
  const fixture = managerFixture();
  const manager = new LatexPreviewManager({
    vscode: fixture.vscode,
    memento: fixture.memento,
    runtimeResolver: async () => ({ kind: "preview-unavailable", reason: "runtime-unpinned" }),
    rendererFactory: () => fixture.renderer,
    server: fixture.server,
  });
  assert.equal((await manager.open()).reason, "runtime-unpinned");
  assert.match(fixture.errors.at(-1), /runtime-unpinned/u);
  assert.equal(fixture.panels.length, 0);
  await manager.dispose();
});

test("the preview host ports Overleaf's position model with attribution", async () => {
  const root = resolve(import.meta.dirname, "..", "extensions", "chatero-documentation");
  const host = await readFile(join(root, "media", "latex-preview", "latex-preview-host.js"), "utf8");
  assert.match(host, /Overleaf/u);
  assert.match(host, /AGPL/u);
  // Position must be a page index plus a PDF-space point, not a pixel offset.
  assert.match(host, /convertToPdfPoint/u);
  assert.match(host, /scrollPageIntoView/u);
  assert.match(host, /name: "XYZ"/u);
  assert.match(host, /currentScaleValue/u);
  // A cross-origin read throws; it must never abort the retry loop or a swap.
  assert.match(host, /catch \{ return null; \}/u);
  assert.match(host, /pagesCount/u);
  const notice = await readFile(join(root, "licenses", "Overleaf-NOTICE.txt"), "utf8");
  assert.match(notice, /github\.com\/overleaf\/overleaf/u);
  assert.match(notice, /pdf-js-wrapper\.ts/u);
  const license = await readFile(join(root, "licenses", "Overleaf-AGPL-3.0.txt"), "utf8");
  assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/u);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.license, "AGPL-3.0-or-later");
});
