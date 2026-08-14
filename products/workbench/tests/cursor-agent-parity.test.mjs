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

test("Cmd+K inline chat stays scoped so the upstream Cmd+K chord family survives", async () => {
  const patch = await readFile(new URL("../patches/code-oss/0018-cursor-agent-keybindings.patch", import.meta.url), "utf8");
  const inlineChatHunk = patch
    .split(/^diff --git /mu)
    .find(section => section.includes("inlineChatActions.ts"));

  assert.ok(inlineChatHunk, "the inline chat keybinding hunk is missing");
  assert.match(inlineChatHunk, /primary: KeyMod\.CtrlCmd \| KeyCode\.KeyK/);
  const added = inlineChatHunk
    .split("\n")
    .filter(line => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
  assert.match(added, /EditorContextKeys\.hasNonEmptySelection/);
});
