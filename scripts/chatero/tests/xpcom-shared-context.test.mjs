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
