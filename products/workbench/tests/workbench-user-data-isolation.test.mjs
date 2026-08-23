import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the Workbench uses the Chatero product root and isolates shared storage with --user-data-dir", async () => {
  const overlay = JSON.parse(await readFile(new URL("../product.chatero.json", import.meta.url), "utf8"));
  const patch = await readFile(new URL("../patches/code-oss/0019-isolate-workbench-user-data.patch", import.meta.url), "utf8");
  const additions = patch.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).join("\n");
  assert.equal(overlay.nameShort, "Chatero");
  assert.equal(overlay.chateroWorkbenchUserDataName, "Chatero");
  assert.equal(overlay.chateroWorkbenchSharedDataInUserData, true);
  assert.match(additions, /product\.chateroWorkbenchUserDataName \?\? product\.nameShort/u);
  assert.match(additions, /productService\.chateroWorkbenchUserDataName \?\? productService\.nameShort/u);
  assert.doesNotMatch(additions, /getUserDataPath\(args, product\.nameShort \?\?/u);
  assert.doesNotMatch(additions, /getUserDataPath\(args, productService\.nameShort\)/u);
  assert.match(additions, /readonly chateroWorkbenchUserDataName\?: string/u);
  assert.match(additions, /readonly chateroWorkbenchSharedDataInUserData\?: boolean/u);
  assert.match(additions, /chateroWorkbenchSharedDataInUserData/u);
  assert.match(additions, /URI\.file\(join\(this\.userDataPath, 'Shared'\)\)/u);
});
