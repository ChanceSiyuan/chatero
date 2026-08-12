import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { EditorSelection, EditorState } from "@codemirror/state";
import { test } from "node:test";

import { decodeAuthorityResponse, encodeAuthorityRequest } from "../documentation-authority/protocol.mjs";
import { runDocumentationAuthority } from "../documentation-authority/runtime/chatero-documentation-authority.mjs";
import {
  MAX_PASSIVE_IMAGE_BYTES,
  PASSIVE_IMAGE_MIME,
  createDocumentationImageResolver,
} from "../extensions/chatero-documentation/documentation-image-resolver.mjs";
import {
  collectImageNodes,
  imageRevealRange,
  renderImageElement,
} from "../extensions/chatero-documentation/webview/image-decorations.mjs";
import { createQmdLanguage } from "../extensions/chatero-documentation/webview/qmd-language.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function invoke(request) {
  const output = [];
  await runDocumentationAuthority({
    stdin: Readable.from([`${encodeAuthorityRequest(request)}\n`]),
    stdout: new Writable({ write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); } }),
    clock: { now: () => 1_000 },
  });
  return decodeAuthorityResponse(Buffer.concat(output).toString("ascii").trim()).result;
}

function passiveRequest(root, target, requestId = "image-1", remote = false) {
  const pathname = pathToFileURL(root).pathname;
  const workspace = remote ? `vscode-remote://chatero-remote+lab${pathname}` : pathToFileURL(root).href;
  const pageUri = remote
    ? `vscode-remote://chatero-remote+lab${pathname}/documentation/pages/page.qmd`
    : pathToFileURL(join(root, "documentation", "pages", "page.qmd")).href;
  return {
    protocolVersion: 1,
    requestId,
    kind: "snapshot",
    workspace,
    epoch: "epoch-1",
    snapshot: {
      kind: "passive-image",
      pageUri,
      target,
      maxBytes: MAX_PASSIVE_IMAGE_BYTES,
      allowedMime: PASSIVE_IMAGE_MIME,
      overlays: [],
    },
  };
}

test("authority returns identical verified raster bytes locally and over SSH", async t => {
  const root = await mkdtemp(join(tmpdir(), "chatero-image-authority-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "documentation", "pages"), { recursive: true });
  await mkdir(join(root, "documentation", "assets"));
  await writeFile(join(root, "documentation", "pages", "page.qmd"), "![Plot](../assets/plot.png)\n");
  await writeFile(join(root, "documentation", "assets", "plot.png"), PNG);
  const local = await invoke(passiveRequest(root, "../assets/plot.png", "local-image"));
  const remote = await invoke(passiveRequest(root, "../assets/plot.png", "remote-image", true));
  assert.deepEqual(remote, local);
  assert.equal(local.kind, "passive-image");
  assert.equal(local.mime, "image/png");
  assert.equal(local.size, PNG.length);
  assert.equal(Buffer.from(local.bytes, "base64url").equals(PNG), true);
  assert.equal(local.sha256, createHash("sha256").update(PNG).digest("hex"));
});

test("authority fails closed for traversal, symlink, extension mismatch, and oversize", async t => {
  const root = await mkdtemp(join(tmpdir(), "chatero-image-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "documentation", "pages"), { recursive: true });
  await mkdir(join(root, "documentation", "assets"));
  await writeFile(join(root, "outside.png"), PNG);
  await symlink(join(root, "outside.png"), join(root, "documentation", "assets", "linked.png"));
  await writeFile(join(root, "documentation", "assets", "wrong.jpg"), PNG);
  await writeFile(join(root, "documentation", "assets", "large.png"), Buffer.alloc(MAX_PASSIVE_IMAGE_BYTES + 1, 0));
  const cases = [
    ["../../../outside.png", "unsafe"],
    ["../assets/linked.png", "unsafe"],
    ["../assets/wrong.jpg", "mime-mismatch"],
    ["../assets/large.png", "too-large"],
    ["https://example.test/image.png", "unsafe"],
    ["../assets/vector.svg", "unsupported-type"],
  ];
  for (const [target, reason] of cases) {
    const result = await invoke(passiveRequest(root, target, `case-${reason}-${cases.indexOf(cases.find(item => item[0] === target))}`));
    assert.deepEqual(result, { kind: "passive-image-placeholder", epoch: "epoch-1", reason }, target);
  }
});

class TestUri {
  constructor(path) { this.path = path; }
  toString() { return pathToFileURL(this.path).href; }
  static joinPath(base, ...parts) { return new TestUri(join(base.path, ...parts)); }
}

test("resolver verifies and materializes only a digest-named disposable session copy", async t => {
  const root = await mkdtemp(join(tmpdir(), "chatero-image-resolver-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new TestUri(join(root, "storage"));
  const written = [];
  const workspace = {
    fs: {
      createDirectory: uri => mkdir(uri.path, { recursive: true }),
      async writeFile(uri, bytes) { written.push(uri.path); await mkdir(dirname(uri.path), { recursive: true }); await writeFile(uri.path, bytes); },
      delete: uri => rm(uri.path, { recursive: true, force: true }),
    },
  };
  const digest = createHash("sha256").update(PNG).digest("hex");
  const resolver = createDocumentationImageResolver({
    scope: {},
    snapshotPassiveImage: async () => ({
      kind: "passive-image", epoch: "epoch", mime: "image/png", size: PNG.length,
      sha256: digest, revision: `sha256:${digest}`, bytes: PNG.toString("base64url"),
    }),
    workspace,
    Uri: TestUri,
    storageUri: storage,
    webview: { asWebviewUri: uri => ({ toString: () => `chatero-test-webview://session/${uri.path.split("/").at(-1)}` }) },
    sessionId: "session-a",
  });
  const ready = await resolver.resolve(new TestUri(join(root, "documentation", "page.qmd")), "assets/plot.png");
  assert.deepEqual({ kind: ready.kind, mime: ready.mime, size: ready.size }, { kind: "ready", mime: "image/png", size: PNG.length });
  assert.equal(ready.src, `chatero-test-webview://session/${digest}.png`);
  assert.equal(written.length, 1);
  assert.match(written[0], new RegExp(`/live-preview-images/session-a/${digest}\\.png$`, "u"));
  assert.equal((await readFile(written[0])).equals(PNG), true);
  assert.deepEqual(await resolver.resolve(new TestUri("/page.qmd"), "../../outside.png"), {
    kind: "placeholder", target: "../../outside.png", reason: "unsafe",
  });
  await resolver.dispose();
  await assert.rejects(stat(resolver.rootUri.path), error => error.code === "ENOENT");
});

function fakeDocument() {
  return {
    createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(), attributes: {}, className: "", dataset: {}, textContent: "",
        setAttribute(name, value) { this.attributes[name] = String(value); },
      };
    },
  };
}

test("collects Markdown images only and builds passive accessible DOM", () => {
  const source = '![Plot](assets/plot.png){width=320 height="200"}\n\n<img src="https://evil.test/x.png">\n';
  const state = EditorState.create({ doc: source, extensions: [createQmdLanguage()] });
  const [node] = collectImageNodes(state, [{ from: 0, to: state.doc.length }]);
  assert.equal(node.target, "assets/plot.png");
  assert.equal(node.alt, "Plot");
  assert.equal(node.width, 320);
  assert.equal(node.height, 200);
  assert.deepEqual(imageRevealRange(node, EditorSelection.cursor(source.indexOf("plot.png"))), { from: node.from, to: node.to });
  assert.equal(imageRevealRange(node, EditorSelection.cursor(source.indexOf("<img"))), null);
  const image = renderImageElement(fakeDocument(), node, {
    kind: "ready", target: node.target, src: "chatero-test-webview://session/digest.png",
    mime: "image/png", size: 10, revision: `sha256:${"a".repeat(64)}`,
  });
  assert.equal(image.tagName, "IMG");
  assert.equal(image.attributes.alt, "Plot");
  assert.equal(image.attributes.width, "320");
  assert.equal(JSON.stringify(image).includes("evil.test"), false);
});
