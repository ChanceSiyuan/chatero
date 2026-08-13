import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { manageFoundryLifecycleSentinel } from "../scripts/prepare-code-oss-lifecycle.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))));

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chatero-code-oss-lifecycle-")));
  roots.push(root);
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "product.json"), '{"nameShort":"Code - OSS"}\n');
  return root;
}

test("Foundry lifecycle sentinel is exact, credential-free, and recoverably removed", async () => {
  const checkout = await fixture();
  assert.deepEqual(await manageFoundryLifecycleSentinel({ checkout, mode: "prepare" }), { kind: "prepared" });
  const path = join(checkout, "node_modules", "foundry-local-sdk-winml", "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(manifest, {
    name: "foundry-local-sdk-winml", private: true, version: "0.0.0-chatero-lifecycle-sentinel",
  });
  assert.doesNotMatch(JSON.stringify(manifest), /token|credential|azure|nuget|binary/iu);
  assert.deepEqual(await manageFoundryLifecycleSentinel({ checkout, mode: "cleanup" }), { kind: "cleaned" });
  assert.deepEqual(await manageFoundryLifecycleSentinel({ checkout, mode: "cleanup" }), { kind: "already-clean" });
});

test("cleanup never removes a real or tampered Foundry package", async () => {
  const checkout = await fixture();
  const packageRoot = join(checkout, "node_modules", "foundry-local-sdk-winml");
  await mkdir(packageRoot);
  await writeFile(join(packageRoot, "package.json"), '{"name":"foundry-local-sdk-winml","version":"1.0.0"}\n');
  await assert.rejects(() => manageFoundryLifecycleSentinel({ checkout, mode: "cleanup" }), /Refusing to remove/u);
  assert.equal(JSON.parse(await readFile(join(packageRoot, "package.json"))).version, "1.0.0");
});
