import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..", "..");

test("-ChateroCore selects only the hidden Core host and suppresses the legacy main window", async () => {
  const [options, early, late, document, controller] = await Promise.all([
    readFile(join(root, "chrome/content/zotero/modules/commandLineOptions.mjs"), "utf8"),
    readFile(join(root, "app/assets/commandLineHandler.js"), "utf8"),
    readFile(join(root, "chrome/content/zotero/xpcom/commandLineHandler.js"), "utf8"),
    readFile(join(root, "chrome/content/zotero/chateroCore.xhtml"), "utf8"),
    readFile(join(root, "chrome/content/zotero/chateroCore.js"), "utf8"),
  ]);

  assert.match(options, /chateroCore:\s*false/);
  assert.match(early, /handleFlag\("ChateroCore", false\)/);
  assert.match(early, /chrome:\/\/zotero\/content\/chateroCore\.xhtml/);
  assert.match(early, /CommandLineOptions\.chateroCore[\s\S]*cmdLine\.preventDefault = true/);
  assert.match(late, /!CommandLineOptions\.chateroCore[\s\S]*!Zotero\.getMainWindow\(\)/);
  assert.doesNotMatch(document, /zoteroPane\.xhtml|standalone\.js/);
  assert.match(document, /chateroCore\.js/);
  assert.match(controller, /Zotero\.initializationPromise/);
  assert.match(controller, /startGeckoCoreHost/);
});

test("ordinary launches do not enter Core mode implicitly", async () => {
  const source = await readFile(join(root, "app/assets/commandLineHandler.js"), "utf8");
  const flag = source.indexOf('handleFlag("ChateroCore", false)');
  const coreBranch = source.indexOf("if (CommandLineOptions.chateroCore)", flag);
  assert.notEqual(flag, -1);
  assert.ok(coreBranch > flag);
  assert.match(source.slice(coreBranch), /cmdLine\.preventDefault = true/);
  assert.doesNotMatch(source.slice(0, flag), /chateroCore\.xhtml/);
});
