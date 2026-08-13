import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Code-OSS patch preserves Cursor Agent muscle memory for code context", async () => {
  const patch = await readFile(new URL("../patches/code-oss/0018-cursor-agent-keybindings.patch", import.meta.url), "utf8");
  assert.match(patch, /primary: KeyMod\.CtrlCmd \| KeyCode\.KeyK/);
  assert.match(patch, /primary: KeyMod\.CtrlCmd \| KeyCode\.KeyL/);
  assert.match(patch, /primary: KeyMod\.CtrlCmd \| KeyMod\.Shift \| KeyCode\.KeyL/);
  assert.match(patch, /AttachSelectionToChatAction/);
  assert.match(patch, /EditorContextKeys\.hasNonEmptySelection/);
});
