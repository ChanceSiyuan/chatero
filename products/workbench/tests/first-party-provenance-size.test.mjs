import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workbenchRoot = join(repositoryRoot, "products", "workbench");

// bootstrap-code-oss.mjs and refresh-first-party.mjs both write provenance with
// JSON.stringify(value, null, 2) plus a trailing newline, and verify-code-oss
// refuses to read a file larger than MAX_PROVENANCE_BYTES. Packaging more
// first-party files grows provenance on both the extension list and the
// managed-path list, so a manifest change can silently push the generated
// checkout past the point where it can verify itself -- which fails every
// workbench:verify, workbench:compile and workbench:dev until the bound moves.
test("provenance for the real first-party manifest fits the verification bound", async () => {
  const [{ inspectFirstPartyExtensionSources }, { MAX_PROVENANCE_BYTES }] = await Promise.all([
    import("../scripts/lib/first-party-extensions.mjs"),
    import("../scripts/verify-code-oss.mjs"),
  ]);
  const manifestPath = join(workbenchRoot, "first-party-extensions.json");
  const extensions = await inspectFirstPartyExtensionSources({ root: repositoryRoot, manifestPath });
  const series = JSON.parse(await readFile(join(workbenchRoot, "patches", "code-oss", "series.json"), "utf8"));

  const managedPaths = [
    ...extensions.flatMap(extension => extension.files.map(file => file.path)),
    "product.json",
    ...series.patches.flatMap(patch => patch.touches ?? []),
  ].sort();
  const provenance = {
    schemaVersion: 1,
    codeOssCommit: "0".repeat(40),
    codeOssVersion: "1.132.0",
    node: "24.18.0",
    electron: "42.7.1",
    firstPartyExtensions: extensions,
    patches: series.patches.map(patch => ({ file: patch.file, sha256: patch.sha256 })),
    managedPaths,
    productSha256: "0".repeat(64),
    worktreeDiffSha256: "0".repeat(64),
  };
  const bytes = Buffer.byteLength(`${JSON.stringify(provenance, null, 2)}\n`, "utf8");

  assert.ok(
    bytes < MAX_PROVENANCE_BYTES,
    `provenance for ${managedPaths.length} managed paths is ${bytes} bytes, over the ${MAX_PROVENANCE_BYTES} byte verification bound; raise MAX_PROVENANCE_BYTES in verify-code-oss.mjs`
  );
  // Fail while there is still room to react, rather than at the moment the
  // generated checkout stops verifying.
  assert.ok(
    bytes < MAX_PROVENANCE_BYTES * 0.75,
    `provenance is ${bytes} bytes, within 25% of the ${MAX_PROVENANCE_BYTES} byte bound; raise MAX_PROVENANCE_BYTES before packaging more first-party files`
  );
});
