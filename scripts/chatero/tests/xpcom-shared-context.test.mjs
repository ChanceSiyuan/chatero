import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "acorn";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const xpcomRoot = join(repositoryRoot, "chrome/content/zotero/xpcom");

const collectPatternBindings = (pattern, bindings) => {
  if (!pattern) return;
  if (pattern.type === "Identifier") {
    bindings.add(pattern.name);
    return;
  }
  if (pattern.type === "RestElement") {
    collectPatternBindings(pattern.argument, bindings);
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    collectPatternBindings(pattern.left, bindings);
    return;
  }
  if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements) collectPatternBindings(element, bindings);
    return;
  }
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) {
      collectPatternBindings(
        property.type === "RestElement" ? property.argument : property.value,
        bindings
      );
    }
    return;
  }
  assert.fail(`unsupported binding pattern: ${pattern.type}`);
};

const topLevelLexicalBindings = (program) => {
  const bindings = new Set();
  for (const statement of program.body) {
    if (statement.type === "VariableDeclaration" && statement.kind !== "var") {
      for (const declaration of statement.declarations) {
        collectPatternBindings(declaration.id, bindings);
      }
    }
    else if (statement.type === "ClassDeclaration") {
      collectPatternBindings(statement.id, bindings);
    }
  }
  return bindings;
};

const arrayDeclaration = (program, name) => {
  const declaration = program.body
    .filter((statement) => statement.type === "VariableDeclaration")
    .flatMap((statement) => statement.declarations)
    .find(({ id }) => id.type === "Identifier" && id.name === name);

  assert.ok(declaration, `missing ${name} declaration`);
  assert.equal(declaration.init?.type, "ArrayExpression", `${name} must remain an array literal`);
  return declaration.init.elements.map((element) => {
    assert.equal(element?.type, "Literal", `${name} entries must remain literals`);
    assert.equal(typeof element.value, "string", `${name} entries must remain strings`);
    return element.value;
  });
};

test("shared XPCOM startup scripts have unique top-level lexical bindings", async () => {
  const loaderSource = await readFile(
    join(repositoryRoot, "chrome/content/zotero/zotero.mjs"),
    "utf8"
  );
  const loaderProgram = parse(loaderSource, {
    ecmaVersion: "latest",
    sourceType: "module"
  });
  const scriptNames = [
    ...arrayDeclaration(loaderProgram, "xpcomFilesAll"),
    ...arrayDeclaration(loaderProgram, "xpcomFilesQLab"),
    ...arrayDeclaration(loaderProgram, "xpcomFilesLocal")
  ];

  const bindingOwners = new Map();
  for (const scriptName of scriptNames) {
    const relativePath = `${scriptName}.js`;
    const source = await readFile(join(xpcomRoot, relativePath), "utf8");
    const program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module"
    });
    for (const binding of topLevelLexicalBindings(program)) {
      const owners = bindingOwners.get(binding) ?? [];
      owners.push(relativePath);
      bindingOwners.set(binding, owners);
    }
  }

  assert.deepEqual(
    bindingOwners.get("ZOTERO_CONFIG"),
    ["zotero.js"],
    "commandLineHandler.js and server/server.js must use zotero.js's shared ZOTERO_CONFIG binding"
  );

  const collisions = [...bindingOwners]
    .filter(([, owners]) => owners.length > 1)
    .map(([binding, owners]) => ({ binding, owners }))
    .sort((a, b) => a.binding.localeCompare(b.binding));
  assert.deepEqual(collisions, [], "shared-context lexical declarations must not collide");
});

test("QLab subscripts load in a failure-isolated loop", async () => {
  const source = await readFile(
    join(repositoryRoot, "chrome/content/zotero/zotero.mjs"),
    "utf8"
  );
  const start = source.indexOf("for (let xpcomFile of xpcomFilesQLab)");
  assert.notEqual(start, -1, "QLab files must load in their own loop");
  const end = source.indexOf("for (let xpcomFile of xpcomFilesLocal)", start);
  assert.ok(end > start, "QLab loading must stay ahead of mode-specific loading");

  const block = source.slice(start, end);
  assert.ok(
    !/\bthrow\b/.test(block),
    "a QLab load failure must never be rethrown into Zotero core startup"
  );
  assert.match(block, /reportError/, "a QLab load failure must still be reported");
});

test("profile isolation runs before preferences and data-directory startup", async () => {
  const source = await readFile(join(xpcomRoot, "zotero.js"), "utf8");
  const isolation = source.indexOf("await Zotero.DataDirectory.assertSafeProfileDirectory");
  const recentCrashes = source.indexOf("recent_crashes");
  const intlInit = source.indexOf("Zotero.Intl.init()");
  const preferences = source.indexOf("await Zotero.Prefs.init()");
  const dataDirectory = source.indexOf("await Zotero.DataDirectory.init()");

  assert.notEqual(isolation, -1, "startup must enforce profile isolation");
  assert.ok(isolation < recentCrashes, "profile isolation must precede recent_crashes pref mutation");
  assert.ok(isolation < intlInit, "profile isolation must precede Intl.init pref mutation");
  assert.ok(isolation < preferences, "profile isolation must precede preference access");
  assert.ok(isolation < dataDirectory, "profile isolation must precede data-directory access");
});

test("alternate data-directory selection is isolated before persistence", async () => {
  const source = await readFile(join(xpcomRoot, "dataDirectory.js"), "utf8");
  const blockStart = source.indexOf("let newDataDir = this.defaultDir + ' ' + profileName;");
  const blockEnd = source.indexOf("// Check for ~/Zotero/zotero.sqlite", blockStart);
  assert.notEqual(blockStart, -1, "alternate data-directory selection must remain present");
  assert.notEqual(blockEnd, -1, "early-return database check must remain present");

  const block = source.slice(blockStart, blockEnd);
  const isolation = block.indexOf("await this.assertSafeDataDirectory(newDataDir)");
  const assignment = block.indexOf("dataDir = newDataDir");
  assert.notEqual(isolation, -1, "alternate data directory must be isolated");
  assert.ok(isolation < assignment, "alternate data directory must be isolated before assignment");

  const earlyReturnStart = source.indexOf("let dbFile = OS.Path.join(dataDir, dbFilename);", blockEnd);
  const earlyReturnEnd = source.indexOf("return dataDir;", earlyReturnStart);
  const earlyReturn = source.slice(earlyReturnStart, earlyReturnEnd);
  const earlyIsolation = earlyReturn.indexOf("await this.assertSafeDataDirectory(dataDir)");
  const earlySet = earlyReturn.indexOf("this.set(dataDir)");
  assert.notEqual(earlyIsolation, -1, "early-return path must isolate before caching");
  assert.ok(earlyIsolation < earlySet, "early-return path must isolate before persisting prefs");
});

test("every interactive data-directory selection is isolated before it is saved", async () => {
  const source = await readFile(join(xpcomRoot, "dataDirectory.js"), "utf8");
  const chooseStart = source.indexOf("choose: async function");
  const forceChangeStart = source.indexOf("forceChange: async function");
  const unsafeLocationStart = source.indexOf("checkForUnsafeLocation: async function");
  const chooseSource = source.slice(chooseStart, forceChangeStart);
  const forceChangeSource = source.slice(forceChangeStart, unsafeLocationStart);

  for (const [name, methodSource] of [
    ["choose", chooseSource],
    ["forceChange", forceChangeSource]
  ]) {
    const isolation = methodSource.indexOf("await this.assertSafeDataDirectory(file.path)");
    const saved = methodSource.indexOf("this.set(file.path)");
    assert.notEqual(isolation, -1, `${name} must enforce official-root isolation`);
    assert.ok(isolation < saved, `${name} must enforce isolation before saving the selection`);
  }
});
