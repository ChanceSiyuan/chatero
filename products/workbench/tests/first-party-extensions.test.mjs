import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    force: true,
    recursive: true,
  })));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "chatero-first-party-extension-"));
  temporaryDirectories.push(root);
  const checkout = join(root, "checkout");
  await mkdir(join(root, "source"), { recursive: true });
  await mkdir(join(checkout, "extensions"), { recursive: true });
  await writeFile(join(root, "source", "package.json"), '{"name":"chatero-zotero"}\n');
  await writeFile(join(root, "source", "extension.mjs"), 'export const activate = () => {};\n');
  const manifestPath = join(root, "first-party-extensions.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    extensions: [{
      id: "chatero.zotero",
      files: [
        { source: "source/package.json", destination: "extensions/chatero-zotero/package.json" },
        { source: "source/extension.mjs", destination: "extensions/chatero-zotero/extension.mjs" },
      ],
    }],
  })}\n`);
  return { checkout, manifestPath, root };
}

test("materializes declared regular files with deterministic provenance", async () => {
  const { materializeFirstPartyExtensions, verifyFirstPartyExtensions } = await import("../scripts/lib/first-party-extensions.mjs");
  const input = await createFixture();

  const result = await materializeFirstPartyExtensions(input);

  assert.equal(result.extensions.length, 1);
  assert.equal(result.extensions[0].id, "chatero.zotero");
  assert.deepEqual(result.extensions[0].files.map(value => value.path), [
    "extensions/chatero-zotero/extension.mjs",
    "extensions/chatero-zotero/package.json",
  ]);
  assert.match(result.extensions[0].treeSha256, /^[0-9a-f]{64}$/);
  assert.equal(await readFile(join(input.checkout, "extensions", "chatero-zotero", "extension.mjs"), "utf8"), 'export const activate = () => {};\n');
  assert.deepEqual(await verifyFirstPartyExtensions({
    checkout: input.checkout,
    expected: result.extensions,
  }), result.extensions);
});

test("verification rejects changed, missing, and extra extension bytes", async () => {
  const { materializeFirstPartyExtensions, verifyFirstPartyExtensions } = await import("../scripts/lib/first-party-extensions.mjs");
  const input = await createFixture();
  const result = await materializeFirstPartyExtensions(input);
  await writeFile(join(input.checkout, "extensions", "chatero-zotero", "extension.mjs"), "tampered\n");

  await assert.rejects(verifyFirstPartyExtensions({
    checkout: input.checkout,
    expected: result.extensions,
  }), /digest/);
});

test("rejects traversal, duplicate destinations, symlink sources, and occupied destinations before writing", async () => {
  const { materializeFirstPartyExtensions } = await import("../scripts/lib/first-party-extensions.mjs");
  const cases = [
    async input => {
      const manifest = JSON.parse(await readFile(input.manifestPath, "utf8"));
      manifest.extensions[0].files[0].destination = "../escape";
      await writeFile(input.manifestPath, JSON.stringify(manifest));
    },
    async input => {
      const manifest = JSON.parse(await readFile(input.manifestPath, "utf8"));
      manifest.extensions[0].files[1].destination = manifest.extensions[0].files[0].destination;
      await writeFile(input.manifestPath, JSON.stringify(manifest));
    },
    async input => {
      await rm(join(input.root, "source", "extension.mjs"));
      await symlink(join(input.root, "source", "package.json"), join(input.root, "source", "extension.mjs"));
    },
    async input => {
      await mkdir(join(input.checkout, "extensions", "chatero-zotero"));
      await writeFile(join(input.checkout, "extensions", "chatero-zotero", "package.json"), "user bytes\n");
    },
  ];

  for (const arrange of cases) {
    const input = await createFixture();
    await arrange(input);
    await assert.rejects(materializeFirstPartyExtensions(input), /unsafe|duplicate|symbolic|already exists/);
    assert.deepEqual(await readdir(join(input.checkout, "extensions")), cases.indexOf(arrange) === 3 ? ["chatero-zotero"] : []);
  }
});
