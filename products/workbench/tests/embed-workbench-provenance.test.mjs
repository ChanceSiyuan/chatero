import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  embedWorkbenchProvenance,
  verifyEmbeddedWorkbenchProvenance,
} from "../scripts/embed-workbench-provenance.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))));

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chatero-provenance-package-")));
  roots.push(root);
  const app = join(root, "Chatero.app");
  const appRoot = join(app, "Contents", "Resources", "app");
  await mkdir(appRoot, { recursive: true });
  const provenancePath = join(root, "source-provenance.json");
  const value = {
    schemaVersion: 1,
    firstPartyExtensions: [
      { id: "chatero.documentation" },
      { id: "chatero.remote" },
      { id: "chatero.zotero" },
    ],
  };
  await writeFile(provenancePath, `${JSON.stringify(value)}\n`);
  return { app, appRoot, provenancePath };
}

test("release packaging embeds and verifies the exact Code-OSS provenance bytes", async () => {
  const input = await fixture();
  const embedded = await embedWorkbenchProvenance(input.app, input);
  assert.equal(embedded.schemaVersion, 1);
  assert.equal(
    await readFile(join(input.appRoot, ".chatero-provenance.json"), "utf8"),
    await readFile(input.provenancePath, "utf8"),
  );
  assert.equal((await verifyEmbeddedWorkbenchProvenance(input.app, input)).schemaVersion, 1);
});

test("release verification rejects missing, changed, and indirect installed provenance", async () => {
  const missing = await fixture();
  await assert.rejects(verifyEmbeddedWorkbenchProvenance(missing.app, missing), /installed Workbench provenance/u);

  const changed = await fixture();
  await embedWorkbenchProvenance(changed.app, changed);
  await writeFile(join(changed.appRoot, ".chatero-provenance.json"), '{"schemaVersion":1,"firstPartyExtensions":[]}\n');
  await assert.rejects(verifyEmbeddedWorkbenchProvenance(changed.app, changed), /does not cover/u);

  const indirect = await fixture();
  await symlink(indirect.provenancePath, join(indirect.appRoot, ".chatero-provenance.json"));
  await assert.rejects(verifyEmbeddedWorkbenchProvenance(indirect.app, indirect), /must not be indirect/u);
});
