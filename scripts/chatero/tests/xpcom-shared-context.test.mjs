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

test("profile isolation runs before preferences and data-directory startup", async () => {
  const source = await readFile(join(xpcomRoot, "zotero.js"), "utf8");
  const isolation = source.indexOf("await Zotero.DataDirectory.assertSafeProfileDirectory");
  const preferences = source.indexOf("await Zotero.Prefs.init()");
  const dataDirectory = source.indexOf("await Zotero.DataDirectory.init()");

  assert.notEqual(isolation, -1, "startup must enforce profile isolation");
  assert.ok(isolation < preferences, "profile isolation must precede preference access");
  assert.ok(isolation < dataDirectory, "profile isolation must precede data-directory access");
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
