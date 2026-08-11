import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function writeContract(value) {
  const directory = await mkdtemp(join(tmpdir(), "chatero-upstream-contract-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "upstreams.json");
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function validContract(overrides = {}) {
  const {
    codeOss: codeOssOverrides = {},
    openVSX: openVSXOverrides = {},
    ...rootOverrides
  } = overrides;
  return {
    schemaVersion: 1,
    codeOss: {
      repository: "https://github.com/microsoft/vscode.git",
      ref: "refs/tags/1.132.0",
      commit: "df53daabb18cd157bdb08c7f01c34df936cf12f4",
      version: "1.132.0",
      node: "24.18.0",
      electron: "42.7.1",
      ...codeOssOverrides,
    },
    openVSX: {
      gallery: "https://open-vsx.org/vscode/gallery",
      item: "https://open-vsx.org/vscode/item",
      resource: "https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/Microsoft.VisualStudio.Code.WebResources/extension",
      ...openVSXOverrides,
    },
    ...rootOverrides,
  };
}

test("loads and recursively freezes the pinned Code-OSS contract", async () => {
  const { loadUpstreamContract } = await import("../scripts/lib/upstream-contract.mjs");
  const path = new URL("../upstreams.json", import.meta.url);

  const contract = await loadUpstreamContract(path);

  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.codeOss.version, "1.132.0");
  assert.equal(contract.codeOss.commit, "df53daabb18cd157bdb08c7f01c34df936cf12f4");
  assert.equal(contract.codeOss.node, "24.18.0");
  assert.equal(contract.codeOss.electron, "42.7.1");
  assert.equal(contract.openVSX.gallery, "https://open-vsx.org/vscode/gallery");
  assert.ok(Object.isFrozen(contract));
  assert.ok(Object.isFrozen(contract.codeOss));
  assert.ok(Object.isFrozen(contract.openVSX));
  assert.throws(() => {
    contract.codeOss.commit = "changed";
  }, TypeError);
});

test("rejects a malformed commit before returning a contract", async () => {
  const { loadUpstreamContract } = await import("../scripts/lib/upstream-contract.mjs");
  const path = await writeContract(validContract({
    codeOss: { commit: "latest" },
  }));

  await assert.rejects(
    loadUpstreamContract(path),
    /codeOss\.commit must be a 40-character lowercase SHA-1/
  );
});

test("rejects a mutable ref and non-HTTPS upstream URLs", async () => {
  const { loadUpstreamContract } = await import("../scripts/lib/upstream-contract.mjs");
  const mutableRef = await writeContract(validContract({
    codeOss: { ref: "refs/heads/main" },
  }));
  const insecureRepository = await writeContract(validContract({
    codeOss: { repository: "http://github.com/microsoft/vscode.git" },
  }));

  await assert.rejects(loadUpstreamContract(mutableRef), /codeOss\.ref must identify an immutable tag/);
  await assert.rejects(loadUpstreamContract(insecureRepository), /codeOss\.repository must use HTTPS/);
});

test("rejects missing, unknown, and malformed fields with their field names", async () => {
  const { loadUpstreamContract } = await import("../scripts/lib/upstream-contract.mjs");
  const missingRuntime = validContract();
  delete missingRuntime.codeOss.node;
  const unknownField = validContract({ extra: true });
  const invalidVersion = validContract({ codeOss: { version: "rolling" } });

  await assert.rejects(loadUpstreamContract(await writeContract(missingRuntime)), /codeOss\.node is required/);
  await assert.rejects(loadUpstreamContract(await writeContract(unknownField)), /unknown field extra/);
  await assert.rejects(loadUpstreamContract(await writeContract(invalidVersion)), /codeOss\.version must be a semantic version/);
});

test("rejects a contract whose tag does not match its pinned version", async () => {
  const { loadUpstreamContract } = await import("../scripts/lib/upstream-contract.mjs");
  const path = await writeContract(validContract({
    codeOss: { ref: "refs/tags/1.131.0" },
  }));

  await assert.rejects(loadUpstreamContract(path), /codeOss\.ref must equal refs\/tags\/1\.132\.0/);
});
