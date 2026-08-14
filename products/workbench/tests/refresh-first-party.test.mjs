import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stubGit({ status, diff }) {
  const calls = [];
  const runGit = async ({ args, cwd }) => {
    calls.push({ args, cwd });
    if (args[0] === "status") return status;
    if (args[0] === "diff") return diff;
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
  return { calls, runGit };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "chatero-refresh-first-party-"));
  temporaryDirectories.push(root);
  const checkout = join(root, "checkout");
  await mkdir(join(root, "source"), { recursive: true });
  await mkdir(join(checkout, "extensions"), { recursive: true });
  await writeFile(join(root, "source", "extension.mjs"), "export const activate = () => {};\n");
  const manifestPath = join(root, "first-party-extensions.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    extensions: [{
      id: "chatero.zotero",
      files: [{ source: "source/extension.mjs", destination: "extensions/chatero-zotero/extension.mjs" }],
    }],
  })}\n`);
  const { materializeFirstPartyExtensions } = await import("../scripts/lib/first-party-extensions.mjs");
  const materialized = await materializeFirstPartyExtensions({ root, checkout, manifestPath });
  const provenancePath = join(checkout, ".chatero-provenance.json");
  await writeFile(provenancePath, `${JSON.stringify({
    schemaVersion: 1,
    codeOssCommit: "0".repeat(40),
    codeOssVersion: "1.132.0",
    node: "24.18.0",
    electron: "42.7.1",
    firstPartyExtensions: materialized.extensions,
    patches: [],
    managedPaths: ["extensions/chatero-zotero/extension.mjs"],
    productSha256: "1".repeat(64),
    worktreeDiffSha256: sha256(""),
  }, null, 2)}\n`);
  return { checkout, manifestPath, provenancePath, root };
}

test("refresh is a no-op when the checkout already matches the repository sources", async () => {
  const { refreshFirstPartyExtensions } = await import("../scripts/lib/refresh-first-party.mjs");
  const input = await createFixture();
  const before = await readFile(input.provenancePath, "utf8");
  const beforeStat = await stat(input.provenancePath);
  const git = stubGit({ status: "", diff: "" });
  const webviewBuilds = [];

  const result = await refreshFirstPartyExtensions({
    root: input.root,
    checkout: input.checkout,
    manifestPath: input.manifestPath,
    buildWebview: async ({ root }) => { webviewBuilds.push(root); },
    runGit: git.runGit,
  });

  assert.equal(result.refreshed, false);
  assert.deepEqual(result.extensions, ["chatero.zotero"]);
  assert.equal(webviewBuilds.length, 1);
  assert.deepEqual(git.calls, []);
  assert.equal(await readFile(input.provenancePath, "utf8"), before);
  assert.equal((await stat(input.provenancePath)).mtimeMs, beforeStat.mtimeMs);
});

test("refresh re-materializes drifted extensions and re-records provenance with verify's filters", async () => {
  const { refreshFirstPartyExtensions } = await import("../scripts/lib/refresh-first-party.mjs");
  const { inspectFirstPartyExtensionSources } = await import("../scripts/lib/first-party-extensions.mjs");
  const input = await createFixture();
  await writeFile(join(input.root, "source", "extension.mjs"), "export const activate = () => 'fresh';\n");
  const git = stubGit({
    status: [
      "?? extensions/chatero-zotero/extension.mjs",
      "?? .chatero-provenance.json",
      " M product.json",
      " M src/vs/platform/extensions/common/extensionsApiProposals.ts",
    ].join("\n"),
    diff: "diff-bytes-after-refresh",
  });

  const result = await refreshFirstPartyExtensions({
    root: input.root,
    checkout: input.checkout,
    manifestPath: input.manifestPath,
    runGit: git.runGit,
  });

  assert.equal(result.refreshed, true);
  assert.deepEqual(result.extensions, ["chatero.zotero"]);
  assert.equal(
    await readFile(join(input.checkout, "extensions", "chatero-zotero", "extension.mjs"), "utf8"),
    "export const activate = () => 'fresh';\n"
  );
  const provenance = JSON.parse(await readFile(input.provenancePath, "utf8"));
  assert.deepEqual(provenance.firstPartyExtensions, await inspectFirstPartyExtensionSources({
    root: input.root,
    manifestPath: input.manifestPath,
  }));
  assert.deepEqual(provenance.managedPaths, [
    "extensions/chatero-zotero/extension.mjs",
    "product.json",
  ]);
  assert.equal(provenance.worktreeDiffSha256, sha256("diff-bytes-after-refresh"));
  assert.equal(provenance.codeOssCommit, "0".repeat(40));
  assert.ok(git.calls.some(call => call.args.includes(":(exclude)src/vs/platform/extensions/common/extensionsApiProposals.ts")));
});

test("refresh removes retired extension trees before materializing the new set", async () => {
  const { refreshFirstPartyExtensions } = await import("../scripts/lib/refresh-first-party.mjs");
  const input = await createFixture();
  await writeFile(input.manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    extensions: [{
      id: "chatero.documentation",
      files: [{ source: "source/extension.mjs", destination: "extensions/chatero-documentation/extension.mjs" }],
    }],
  })}\n`);
  const git = stubGit({ status: "?? extensions/chatero-documentation/extension.mjs", diff: "d" });

  const result = await refreshFirstPartyExtensions({
    root: input.root,
    checkout: input.checkout,
    manifestPath: input.manifestPath,
    runGit: git.runGit,
  });

  assert.equal(result.refreshed, true);
  assert.deepEqual(result.extensions, ["chatero.documentation"]);
  await assert.rejects(stat(join(input.checkout, "extensions", "chatero-zotero")), { code: "ENOENT" });
  assert.equal(
    await readFile(join(input.checkout, "extensions", "chatero-documentation", "extension.mjs"), "utf8"),
    "export const activate = () => {};\n"
  );
});

test("refresh rejects unsafe destination roots recorded in provenance", async () => {
  const { refreshFirstPartyExtensions } = await import("../scripts/lib/refresh-first-party.mjs");
  const input = await createFixture();
  const provenance = JSON.parse(await readFile(input.provenancePath, "utf8"));
  provenance.firstPartyExtensions[0] = {
    ...provenance.firstPartyExtensions[0],
    destinationRoot: "extensions/../../escape",
  };
  await writeFile(input.provenancePath, JSON.stringify(provenance));
  await writeFile(join(input.root, "source", "extension.mjs"), "export const activate = () => 'drift';\n");

  await assert.rejects(refreshFirstPartyExtensions({
    root: input.root,
    checkout: input.checkout,
    manifestPath: input.manifestPath,
    runGit: stubGit({ status: "", diff: "" }).runGit,
  }), /unsafe first-party extension destination root/);
});

test("refresh refuses to replace a tree reached through a symlinked ancestor", async () => {
  const { refreshFirstPartyExtensions } = await import("../scripts/lib/refresh-first-party.mjs");
  const { mkdir: makeDirectory, rename, symlink, stat: statPath, writeFile: write } = await import("node:fs/promises");
  const input = await createFixture();
  await writeFile(join(input.root, "source", "extension.mjs"), "export const activate = () => 'drift';\n");

  // Redirect <checkout>/extensions at a directory outside the checkout, the way
  // a tampered checkout would to make a lexically contained delete land elsewhere.
  const outside = join(input.root, "outside");
  await makeDirectory(join(outside, "chatero-zotero"), { recursive: true });
  await write(join(outside, "chatero-zotero", "keep.mjs"), "keep\n");
  await rename(join(input.checkout, "extensions"), join(input.root, "real-extensions"));
  await symlink(outside, join(input.checkout, "extensions"), "dir");

  await assert.rejects(refreshFirstPartyExtensions({
    root: input.root,
    checkout: input.checkout,
    manifestPath: input.manifestPath,
    runGit: stubGit({ status: "", diff: "" }).runGit,
  }), /unsafe/u);
  assert.ok((await statPath(join(outside, "chatero-zotero", "keep.mjs"))).isFile(), "the redirected target must survive");
});

test("refresh restores the previous trees when materializing fails", async () => {
  const { refreshFirstPartyExtensions } = await import("../scripts/lib/refresh-first-party.mjs");
  const { readdir, rm: remove } = await import("node:fs/promises");
  const input = await createFixture();
  // Drop the manifest's source so materialize fails after the old tree moved aside.
  await writeFile(join(input.root, "source", "extension.mjs"), "export const activate = () => 'drift';\n");
  const provenanceBefore = await readFile(input.provenancePath, "utf8");
  const manifest = JSON.parse(await readFile(input.manifestPath, "utf8"));
  manifest.extensions[0].files.push({ source: "source/missing.mjs", destination: "extensions/chatero-zotero/missing.mjs" });
  await writeFile(input.manifestPath, JSON.stringify(manifest));

  await assert.rejects(refreshFirstPartyExtensions({
    root: input.root,
    checkout: input.checkout,
    manifestPath: input.manifestPath,
    runGit: stubGit({ status: "", diff: "" }).runGit,
  }));

  assert.equal(
    await readFile(join(input.checkout, "extensions", "chatero-zotero", "extension.mjs"), "utf8"),
    "export const activate = () => {};\n",
    "the previous extension tree must be restored"
  );
  assert.equal(await readFile(input.provenancePath, "utf8"), provenanceBefore);
  const leftovers = (await readdir(join(input.checkout, "extensions"))).filter(name => name.includes("chatero-refresh-"));
  assert.deepEqual(leftovers, [], "no staging directories may be left behind");
  await remove(join(input.checkout, "extensions"), { force: true, recursive: true });
});
