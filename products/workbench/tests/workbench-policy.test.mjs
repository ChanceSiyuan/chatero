import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function createPolicyFixture({
  serviceUrl = "https://open-vsx.org/vscode/gallery",
  patchText = "Chatero patch without external extension ids\n",
  outsideText = "",
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "chatero-policy-"));
  temporaryDirectories.push(root);
  const patches = join(root, "patches", "code-oss");
  const generated = join(root, "generated");
  await mkdir(patches, { recursive: true });
  await mkdir(generated, { recursive: true });
  await writeFile(join(root, "product.chatero.json"), JSON.stringify({
    nameShort: "Chatero",
    builtInExtensions: [],
  }));
  await writeFile(join(patches, "0001-policy.patch"), patchText);
  await writeFile(join(root, "tests-are-outside-policy-scope.js"), outsideText);
  const productPath = join(generated, "product.json");
  await writeFile(productPath, JSON.stringify({
    nameShort: "Chatero",
    extensionsGallery: {
      serviceUrl,
      itemUrl: "https://open-vsx.org/vscode/item",
      resourceUrlTemplate: "https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/Microsoft.VisualStudio.Code.WebResources/extension",
    },
  }));
  return { productPath, root };
}

test("reports Microsoft Marketplace hosts and restricted extension ids", async () => {
  const { verifyWorkbenchPolicy } = await import("../scripts/lib/workbench-policy.mjs");
  const input = await createPolicyFixture({
    serviceUrl: "https://marketplace.visualstudio.com/_apis/public/gallery",
    patchText: "extension: ms-python.vscode-pylance\n",
  });

  const report = await verifyWorkbenchPolicy(input);

  assert.equal(report.ok, false);
  assert.deepEqual(report.violations.map(value => value.rule).sort(), [
    "forbidden-extension",
    "forbidden-host",
    "non-open-vsx-gallery",
  ]);
  assert.ok(report.violations.every(value => !value.path.startsWith("/")));
  assert.ok(report.violations.every(value => Number.isInteger(value.line) && value.line >= 1));
});

test("accepts Chatero identity, Open VSX, and an unrestricted patch set", async () => {
  const { verifyWorkbenchPolicy } = await import("../scripts/lib/workbench-policy.mjs");
  const input = await createPolicyFixture();

  const report = await verifyWorkbenchPolicy(input);

  assert.equal(report.ok, true);
  assert.ok(report.scannedFiles >= 3);
  assert.deepEqual(report.violations, []);
});

test("does not scan arbitrary repository files or user workspace content", async () => {
  const { verifyWorkbenchPolicy } = await import("../scripts/lib/workbench-policy.mjs");
  const input = await createPolicyFixture({
    outsideText: "https://marketplace.visualstudio.com ms-vscode-remote.remote-ssh\n",
  });

  const report = await verifyWorkbenchPolicy(input);

  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
});

test("reports the exact nested patch path and line of a forbidden Remote-SSH id", async () => {
  const { verifyWorkbenchPolicy } = await import("../scripts/lib/workbench-policy.mjs");
  const input = await createPolicyFixture({
    patchText: "first safe line\nsecond safe line\nms-vscode-remote.remote-ssh\n",
  });

  const report = await verifyWorkbenchPolicy(input);

  assert.equal(report.ok, false);
  assert.deepEqual(report.violations, [{
    rule: "forbidden-extension",
    path: "patches/code-oss/0001-policy.patch",
    line: 3,
    excerpt: "ms-vscode-remote.remote-ssh",
  }]);
});

test("fails closed on symbolic links inside the patch policy tree", async () => {
  const { symlink } = await import("node:fs/promises");
  const { verifyWorkbenchPolicy } = await import("../scripts/lib/workbench-policy.mjs");
  const input = await createPolicyFixture();
  await symlink("/tmp", join(input.root, "patches", "code-oss", "external"));

  const report = await verifyWorkbenchPolicy(input);

  assert.equal(report.ok, false);
  assert.deepEqual(report.violations, [{
    rule: "unsafe-symlink",
    path: "patches/code-oss/external",
    line: 1,
    excerpt: "symbolic links are not scanned",
  }]);
});
