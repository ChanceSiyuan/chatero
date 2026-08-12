import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createDocumentationCapabilityIssuer } from "../extensions/chatero-documentation/documentation-capabilities.mjs";

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

class ExtensionTestUri {
  constructor({ scheme = "file", authority = "", path, query = "", fragment = "" }) {
    Object.assign(this, { scheme, authority, path, query, fragment });
  }

  with(changes) { return new ExtensionTestUri({ ...this, ...changes }); }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}

function createDocumentationHarness({ trusted = true, input = undefined, warning = undefined } = {}) {
  const registeredCommands = new Map();
  const executed = [];
  const diagnostics = [];
  let provider;
  class EventEmitter {
    listeners = new Set();
    event = listener => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  class TreeItem {
    constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); }
  }
  class ThemeIcon { constructor(id) { this.id = id; } }
  class WorkspaceEdit {
    operations = [];
    createFile(uri, options) { this.operations.push(["createFile", uri, options]); }
    insert(uri, position, text) { this.operations.push(["insert", uri, position, text]); }
  }
  class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
  const workspaceEdits = [];
  const vscode = {
    DiagnosticSeverity: { Warning: 1 },
    EventEmitter,
    Position,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState: { None: 0 },
    WorkspaceEdit,
    commands: {
      registerCommand(id, callback) {
        registeredCommands.set(id, callback);
        return { dispose: () => registeredCommands.delete(id) };
      },
      async executeCommand(...args) {
        executed.push(args);
        if (registeredCommands.has(args[0])) return registeredCommands.get(args[0])(...args.slice(1));
      },
    },
    languages: {
      createDiagnosticCollection() {
        return {
          clear() { diagnostics.length = 0; },
          set(uri, values) { diagnostics.push([uri, values]); },
          dispose() {},
        };
      },
    },
    window: {
      registerTreeDataProvider(_id, value) {
        provider = value;
        return { dispose() {} };
      },
      showErrorMessage: async () => undefined,
      showInputBox: async () => input,
      showWarningMessage: async () => warning,
    },
    workspace: {
      isTrusted: trusted,
      textDocuments: [],
      async applyEdit(edit) { workspaceEdits.push(edit); return true; },
      async openTextDocument(uri) {
        return vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
      },
    },
  };
  return {
    vscode,
    context: { subscriptions: [] },
    commands: {
      executed,
      async run(id, ...args) { return registeredCommands.get(id)(...args); },
    },
    diagnostics,
    get provider() { return provider; },
    workspaceEdits,
  };
}

async function loadDocumentationTree() {
  const require = createRequire(import.meta.url);
  const path = fileURLToPath(new URL("../extensions/chatero-documentation/documentation-tree.cjs", import.meta.url));
  delete require.cache[require.resolve(path)];
  return require(path);
}

function createDocumentationServices(overrides = {}) {
  let sequence = 0;
  const capabilities = createDocumentationCapabilityIssuer({
    clock: { now: () => 1_000 },
    randomUUID: () => `documentation-${++sequence}`,
  });
  const scope = capabilities.issueScope({ uri: "file:///srv/research", authority: "local", epoch: "epoch-1" });
  return {
    capabilities,
    scope,
    workspaceFolderUri: new ExtensionTestUri({ path: "/srv/research" }),
    randomUUID: () => `command-${++sequence}`,
    transactions: {
      async state() {
        return {
          schemaVersion: 1,
          generation: "0000000000000001",
          documents: {
            "index.qmd": { state: "reviewed" },
            "notes/working.qmd": { state: "working" },
          },
          diagnostics: [],
        };
      },
      async setDocumentState() { return { kind: "state-committed" }; },
    },
    ...overrides,
  };
}

test("Documentation Explorer opens QMD through the standard Text Editor", async () => {
  const harness = createDocumentationHarness();
  const services = createDocumentationServices();
  harness.context.documentationServices = services;
  const { registerDocumentation } = await loadDocumentationTree();
  const disposables = await registerDocumentation(harness.vscode, harness.context);

  const children = await harness.provider.getChildren();
  assert.deepEqual(children.map(child => child.path.value), ["index.qmd", "notes/working.qmd"]);
  assert.deepEqual(children.map(child => harness.provider.getTreeItem(child).contextValue), [
    "documentation.page.reviewed",
    "documentation.page.working",
  ]);
  const pageUri = services.workspaceFolderUri.with({ path: "/srv/research/documentation/index.qmd" });
  await harness.commands.run("chatero.documentation.openSource", pageUri);
  assert.deepEqual(harness.commands.executed.at(-1), ["vscode.openWith", pageUri, "default"]);
  assert.ok(disposables.every(value => typeof value.dispose === "function"));
});

test("untrusted workspaces keep read-only Documentation routes but issue no mutation capability", async () => {
  const harness = createDocumentationHarness({ trusted: false, input: "new.qmd" });
  let approvals = 0;
  let mutations = 0;
  const base = createDocumentationServices();
  const services = {
    ...base,
    capabilities: {
      ...base.capabilities,
      issueHumanApproval() { approvals++; },
    },
    transactions: {
      ...base.transactions,
      async setDocumentState() { mutations++; },
      async planMigration() { mutations++; },
    },
  };
  harness.context.documentationServices = services;
  const { registerDocumentation } = await loadDocumentationTree();
  await registerDocumentation(harness.vscode, harness.context);
  const pageUri = services.workspaceFolderUri.with({ path: "/srv/research/documentation/index.qmd" });
  await harness.commands.run("chatero.documentation.openSource", pageUri);
  await harness.commands.run("chatero.documentation.newPage");
  await harness.commands.run("chatero.documentation.markReviewed", pageUri);
  await harness.commands.run("chatero.documentation.planMigration");
  assert.equal(approvals, 0);
  assert.equal(mutations, 0);
  assert.equal(harness.workspaceEdits.length, 0);
  assert.deepEqual(harness.commands.executed.at(-1), ["vscode.openWith", pageUri, "default"]);
});

test("Mark Reviewed waits for explicit Save and New Page uses one WorkspaceEdit", async () => {
  const harness = createDocumentationHarness({ trusted: true, warning: "Save" });
  const calls = [];
  const base = createDocumentationServices();
  const services = {
    ...base,
    transactions: {
      ...base.transactions,
      async setDocumentState(approval, input) {
        calls.push({ approval, input });
        return { kind: "state-committed", generation: "0000000000000002", receipt: input.idempotencyKey };
      },
    },
  };
  harness.context.documentationServices = services;
  const pageUri = services.workspaceFolderUri.with({ path: "/srv/research/documentation/index.qmd" });
  const document = {
    uri: pageUri,
    version: 4,
    isDirty: true,
    getText: () => "# Reviewed\n",
    async save() { this.isDirty = false; this.version = 5; return true; },
  };
  harness.vscode.workspace.textDocuments.push(document);
  const { registerDocumentation } = await loadDocumentationTree();
  await registerDocumentation(harness.vscode, harness.context);
  const result = await harness.commands.run("chatero.documentation.markReviewed", pageUri);
  assert.equal(result.kind, "state-committed");
  assert.equal(document.isDirty, false);
  assert.equal(calls[0].input.state, "reviewed");
  assert.match(calls[0].input.expectedDocumentRevision, /^text-document:5:sha256:[0-9a-f]{64}$/);

  await harness.commands.run("chatero.documentation.newPage", {
    path: "notes/new.qmd",
    initialText: "# New\n",
  });
  assert.equal(harness.workspaceEdits.length, 1);
  assert.deepEqual(harness.workspaceEdits[0].operations.map(operation => operation[0]), ["createFile", "insert"]);
  assert.equal(harness.workspaceEdits[0].operations[1][3], "# New\n");
  assert.equal(harness.commands.executed.at(-1)[0], "vscode.openWith");
  assert.equal(harness.commands.executed.at(-1)[2], "default");
});
