import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const extensionRoot = new URL("../extensions/chatero-documentation/", import.meta.url);

test("Documentation is a disabled workspace extension with only Phase 1 surfaces", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", extensionRoot), "utf8"));

  assert.equal(`${manifest.publisher}.${manifest.name}`, "chatero.chatero-documentation");
  assert.equal(manifest.engines.vscode, "^1.132.0");
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.equal(
    manifest.contributes.configuration.properties["chatero.documentation.enabled"].default,
    false,
  );
  assert.deepEqual(manifest.capabilities, {
    untrustedWorkspaces: { supported: true },
    virtualWorkspaces: false,
  });

  const explorerViews = manifest.contributes.views?.explorer ?? [];
  assert.deepEqual(explorerViews.map(view => view.name), ["Documentation"]);
  assert.ok(explorerViews[0].id.startsWith("chatero.documentation."));

  const commandIds = manifest.contributes.commands.map(command => command.command);
  assert.deepEqual(commandIds, [
    "chatero.documentation.newPage",
    "chatero.documentation.openSource",
    "chatero.documentation.markWorking",
    "chatero.documentation.markReviewed",
    "chatero.documentation.planMigration",
    "chatero.documentation.refresh",
  ]);
  assert.ok(commandIds.every(command => command.startsWith("chatero.documentation.")));

  for (const forbiddenContribution of ["customEditors", "languageModelTools", "webviewPanel"]) {
    assert.equal(Object.hasOwn(manifest.contributes, forbiddenContribution), false);
  }
  assert.equal(commandIds.some(command => /executeMigration/i.test(command)), false);
});

test("first-party materialization declares only the existing Documentation scaffold", async () => {
  const firstParty = JSON.parse(await readFile(new URL("../first-party-extensions.json", import.meta.url), "utf8"));
  assert.deepEqual(firstParty.extensions.map(extension => extension.id), [
    "chatero.documentation",
    "chatero.remote",
    "chatero.zotero",
  ]);
  const documentation = firstParty.extensions[0];
  assert.deepEqual(documentation.files.map(file => file.destination), [
    "extensions/chatero-documentation/extension.cjs",
    "extensions/chatero-documentation/media/documentation.svg",
    "extensions/chatero-documentation/package.json",
  ]);
});

async function activateWith({ enabled, registerDocumentation }) {
  const commands = [];
  const outputLines = [];
  const output = {
    appendLine(value) { outputLines.push(value); },
    dispose() {},
  };
  const vscode = {
    commands: {
      async executeCommand(...args) { commands.push(args); },
    },
    window: {
      createOutputChannel(name) {
        assert.equal(name, "Documentation");
        return output;
      },
    },
    workspace: {
      getConfiguration(section) {
        assert.equal(section, "chatero.documentation");
        return {
          get(key, fallback) {
            assert.equal(key, "enabled");
            assert.equal(fallback, false);
            return enabled;
          },
        };
      },
    },
  };
  const context = { subscriptions: [] };
  const require = createRequire(import.meta.url);
  const extensionPath = fileURLToPath(new URL("extension.cjs", extensionRoot));
  delete require.cache[require.resolve(extensionPath)];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") return vscode;
    if (request === "./documentation-tree.cjs") return { registerDocumentation };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const extension = require(extensionPath);
    assert.deepEqual(Object.keys(extension), ["activate"]);
    await extension.activate(context);
  }
  finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(extensionPath)];
  }
  return { commands, context, output, outputLines };
}

test("disabled activation sets context without registering Documentation", async () => {
  let registrations = 0;
  const result = await activateWith({
    enabled: false,
    registerDocumentation: async () => {
      registrations++;
      return [];
    },
  });

  assert.deepEqual(result.commands, [["setContext", "chatero.documentation.enabled", false]]);
  assert.equal(registrations, 0);
  assert.deepEqual(result.context.subscriptions, []);
  assert.deepEqual(result.outputLines, []);
});

test("enabled activation contains registration failure in one Documentation output entry", async () => {
  const result = await activateWith({
    enabled: true,
    registerDocumentation: async () => {
      throw new Error("registration failed");
    },
  });

  assert.deepEqual(result.commands, [["setContext", "chatero.documentation.enabled", true]]);
  assert.deepEqual(result.context.subscriptions, [result.output]);
  assert.equal(result.outputLines.length, 1);
  assert.match(result.outputLines[0], /registration failed/);
});
