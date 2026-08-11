import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "chatero-product-"));
  temporaryDirectories.push(directory);
  const upstreamProductPath = join(directory, "upstream-product.json");
  const outputPath = join(directory, "generated", "product.json");
  await writeFile(upstreamProductPath, `${JSON.stringify({
    nameShort: "Code - OSS",
    nameLong: "Code - OSS",
    applicationName: "code-oss",
    dataFolderName: ".vscode-oss",
    licenseName: "MIT",
    licenseUrl: "https://github.com/microsoft/vscode/blob/main/LICENSE.txt",
    builtInExtensions: [{ name: "downloaded-upstream-extension" }],
    preservedBuildField: { enabled: true },
  }, null, "\t")}\n`);
  const { loadUpstreamContract } = await import("../scripts/lib/upstream-contract.mjs");
  const contract = await loadUpstreamContract(new URL("../upstreams.json", import.meta.url));
  return {
    contract,
    directory,
    outputPath,
    upstreamProductPath,
    overlayPath: new URL("../product.chatero.json", import.meta.url),
  };
}

test("brands Code-OSS as Chatero and selects only Open VSX", async () => {
  const { materializeProduct } = await import("../scripts/lib/product-materializer.mjs");
  const input = await fixture();

  const result = await materializeProduct(input);
  const bytes = await readFile(input.outputPath);
  const product = JSON.parse(bytes);

  assert.equal(product.nameShort, "Chatero");
  assert.equal(product.nameLong, "Chatero Research Workbench");
  assert.equal(product.applicationName, "chatero");
  assert.equal(product.dataFolderName, ".chatero");
  assert.equal(product.darwinBundleIdentifier, "io.github.chancesiyuan.chatero");
  assert.equal(product.urlProtocol, "chatero");
  assert.deepEqual(product.extensionsGallery, {
    itemUrl: "https://open-vsx.org/vscode/item",
    resourceUrlTemplate: "https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/Microsoft.VisualStudio.Code.WebResources/extension",
    serviceUrl: "https://open-vsx.org/vscode/gallery",
  });
  assert.deepEqual(product.builtInExtensions, []);
  assert.deepEqual(product.preservedBuildField, { enabled: true });
  assert.equal(result.outputPath, input.outputPath);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("produces byte-identical sorted JSON from the same inputs", async () => {
  const { materializeProduct } = await import("../scripts/lib/product-materializer.mjs");
  const input = await fixture();

  const first = await materializeProduct(input);
  const firstBytes = await readFile(input.outputPath, "utf8");
  const second = await materializeProduct(input);
  const secondBytes = await readFile(input.outputPath, "utf8");

  assert.equal(second.sha256, first.sha256);
  assert.equal(secondBytes, firstBytes);
  assert.equal(firstBytes.at(-1), "\n");
  assert.deepEqual(Object.keys(JSON.parse(firstBytes)), [...Object.keys(JSON.parse(firstBytes))].sort());
});

test("does not replace an existing product when an input is invalid", async () => {
  const { materializeProduct } = await import("../scripts/lib/product-materializer.mjs");
  const input = await fixture();
  await mkdir(join(input.directory, "generated"));
  await writeFile(input.outputPath, "existing valid product\n");
  await writeFile(input.upstreamProductPath, "{ invalid json\n");

  await assert.rejects(materializeProduct(input), /upstream product is not valid JSON/);
  assert.equal(await readFile(input.outputPath, "utf8"), "existing valid product\n");
});

test("rejects an overlay that attempts to choose its own extension gallery", async () => {
  const { materializeProduct } = await import("../scripts/lib/product-materializer.mjs");
  const input = await fixture();
  const unsafeOverlay = join(input.directory, "unsafe-overlay.json");
  await writeFile(unsafeOverlay, JSON.stringify({
    nameShort: "Chatero",
    extensionsGallery: { serviceUrl: "https://marketplace.visualstudio.com" },
  }));

  await assert.rejects(
    materializeProduct({ ...input, overlayPath: unsafeOverlay }),
    /overlay must not define extensionsGallery/
  );
});
