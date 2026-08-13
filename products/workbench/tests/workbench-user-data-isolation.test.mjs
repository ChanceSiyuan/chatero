import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the Workbench never shares the legacy Gecko Chatero application-data root", async () => {
  const overlay = JSON.parse(await readFile(new URL("../product.chatero.json", import.meta.url), "utf8"));
  const patch = await readFile(new URL("../patches/code-oss/0019-isolate-workbench-user-data.patch", import.meta.url), "utf8");
  const additions = patch.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).join("\n");
  assert.equal(overlay.nameShort, "Chatero");
  assert.equal(overlay.chateroWorkbenchUserDataName, "Chatero Research Workbench");
  assert.match(additions, /product\.chateroWorkbenchUserDataName \?\? product\.nameShort/u);
  assert.doesNotMatch(additions, /getUserDataPath\(args, product\.nameShort \?\?/u);
  assert.match(additions, /readonly chateroWorkbenchUserDataName\?: string/u);
});
