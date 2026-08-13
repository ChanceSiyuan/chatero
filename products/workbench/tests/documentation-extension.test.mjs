import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

import { createDocumentationCapabilityIssuer } from "../extensions/chatero-documentation/documentation-capabilities.mjs";

const extensionRoot = new URL("../extensions/chatero-documentation/", import.meta.url);

test("isolated Workbench CI gates fast policy and complete macOS Stage 1 acceptance", async () => {
  const source = await readFile(new URL("../../../.github/workflows/workbench.yml", import.meta.url), "utf8");
  const workflow = parse(source);
  assert.equal(workflow.name, "Workbench");
  assert.deepEqual(workflow.on, ["push", "pull_request"]);
  assert.deepEqual(Object.keys(workflow.jobs), ["workbench", "stage-1-macos"]);
  const job = workflow.jobs.workbench;
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.deepEqual(job.steps.map(step => step.run ?? step.uses), [
    "actions/checkout@v4",
    "actions/setup-node@v4",
    "npm ci",
    "npm run test:documentation",
    "npm run test:workbench-bootstrap",
    "actions/cache@v4",
    "npm run workbench:verify",
    "npm run workbench:bootstrap",
    "npm run workbench:verify",
  ]);
  assert.equal(job.steps[1].with["node-version"], "24.18.0");
  assert.equal(job.steps[1].with.cache, "npm");
  assert.equal(job.steps[5].id, "code-oss-cache");
  assert.equal(job.steps[5].with.path, "vendor/code-oss");
  assert.equal(job.steps[5].with.key,
    "workbench-${{ runner.os }}-${{ hashFiles('products/workbench/upstreams.json', 'products/workbench/patches/code-oss/**', 'products/workbench/first-party-extensions.json', 'package-lock.json') }}");
  assert.equal(job.steps[6].if, "steps.code-oss-cache.outputs.cache-hit == 'true'");

  const stageOne = workflow.jobs["stage-1-macos"];
  assert.equal(stageOne["runs-on"], "macos-15");
  assert.deepEqual(stageOne.steps.map(step => step.run ?? step.uses), [
    "actions/checkout@v4",
    "actions/setup-node@v4",
    "quarto-dev/quarto-actions/setup@v2",
    "npm ci",
    "npm run workbench:bootstrap",
    "npm run workbench:install",
    "npm run verify:stage-1",
    "actions/upload-artifact@v4",
  ]);
  assert.deepEqual(stageOne.steps[0].with, { submodules: "recursive" });
  assert.equal(stageOne.steps[1].with["node-version"], "24.18.0");
  assert.equal(stageOne.steps[1].with.cache, "npm");
  assert.equal(stageOne.steps[2].with.version, "1.8.27");
  assert.equal(stageOne.steps[7].if, "always()");
  assert.deepEqual(stageOne.steps[7].with, {
    name: "stage-1-acceptance-${{ github.sha }}",
    path: "products/workbench/.cache/acceptance/stage-1.json",
    "if-no-files-found": "warn",
  });
  assert.doesNotMatch(source, /marketplace\.visualstudio\.com|gallerycdn\.vsassets\.io|ms-python\.vscode-pylance|ms-vscode-remote\.remote-ssh/iu);
  assert.doesNotMatch(source, /\/Users\/|zotero\.sqlite|CHATERO_CODE_OSS_DIR/iu);
});

test("Documentation is the default workspace surface with optional Live Preview", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", extensionRoot), "utf8"));

  assert.equal(`${manifest.publisher}.${manifest.name}`, "chatero.chatero-documentation");
  assert.equal(manifest.engines.vscode, "^1.132.0");
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.equal(manifest.activationEvents.includes("*"), true);
  assert.equal(
    manifest.contributes.configuration.properties["chatero.documentation.enabled"].default,
    true,
  );
  assert.equal(
    manifest.contributes.configuration.properties["chatero.documentation.livePreview"].default,
    true,
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
    "chatero.documentation.open",
    "chatero.documentation.newPage",
    "chatero.documentation.openSource",
    "chatero.documentation.toggleEditingView",
    "chatero.documentation.markWorking",
    "chatero.documentation.markReviewed",
    "chatero.documentation.planMigration",
    "chatero.documentation.migrate",
    "chatero.documentation.reviewChangeSet",
    "chatero.documentation.refresh",
    "chatero.research.runAction",
    "chatero.research.chatWithSelection",
    "chatero.research.refreshLiterature",
    "chatero.research.noteToDraft",
    "chatero.research.openTopicGraph",
    "chatero.research.openMainSite",
  ]);
  assert.ok(commandIds.every(command => command.startsWith("chatero.documentation.") || command.startsWith("chatero.research.")));

  assert.equal(Object.hasOwn(manifest.contributes, "webviewPanel"), false);
  assert.deepEqual(manifest.contributes.languageModelTools.map(tool => tool.name), [
    "chatero_documentation_retrieve",
    "chatero_documentation_stage",
  ]);
  assert.ok(manifest.contributes.languageModelTools.every(tool =>
    tool.inputSchema.additionalProperties === false));
  const stageSchema = manifest.contributes.languageModelTools[1].inputSchema;
  assert.equal(stageSchema.properties.operations.maxItems, 128);
  assert.deepEqual(stageSchema.properties.operations.items.oneOf.map(schema => schema.properties.kind.const), [
    "create", "edit", "rename", "delete",
  ]);
  assert.doesNotMatch(JSON.stringify(manifest.contributes.languageModelTools), /settle|accept|migrate|recover|writeCanonical/iu);
  assert.deepEqual(manifest.contributes.customEditors, [{
    viewType: "chatero.documentation.livePreview",
    displayName: "Chatero Live Preview",
    selector: [{ filenamePattern: "**/documentation/**/*.qmd" }],
    priority: "option",
  }]);
  assert.equal(commandIds.some(command => /executeMigration/i.test(command)), false);
});

test("first-party materialization declares the complete Documentation authority", async () => {
  const firstParty = JSON.parse(await readFile(new URL("../first-party-extensions.json", import.meta.url), "utf8"));
  assert.deepEqual(firstParty.extensions.map(extension => extension.id), [
    "chatero.documentation",
    "chatero.remote",
    "chatero.zotero",
  ]);
  const documentation = firstParty.extensions[0];
  assert.deepEqual(documentation.files.map(file => file.destination), [
    "extensions/chatero-documentation/change-set-model.mjs",
    "extensions/chatero-documentation/change-set-store.mjs",
    "extensions/chatero-documentation/documentation-agent-tools.mjs",
    "extensions/chatero-documentation/documentation-authority-client.mjs",
    "extensions/chatero-documentation/documentation-capabilities.mjs",
    "extensions/chatero-documentation/documentation-image-resolver.mjs",
    "extensions/chatero-documentation/documentation-operations.mjs",
    "extensions/chatero-documentation/documentation-path.mjs",
    "extensions/chatero-documentation/documentation-review.cjs",
    "extensions/chatero-documentation/documentation-retrieval.mjs",
    "extensions/chatero-documentation/documentation-services.mjs",
    "extensions/chatero-documentation/documentation-state.mjs",
    "extensions/chatero-documentation/documentation-transactions.mjs",
    "extensions/chatero-documentation/documentation-tree.cjs",
    "extensions/chatero-documentation/documentation-workspace.mjs",
    "extensions/chatero-documentation/extension.cjs",
    "extensions/chatero-documentation/licenses/CodeMirror-MIT.txt",
    "extensions/chatero-documentation/licenses/KaTeX-MIT.txt",
    "extensions/chatero-documentation/live-preview-bridge.mjs",
    "extensions/chatero-documentation/live-preview-html.mjs",
    "extensions/chatero-documentation/live-preview-protocol.mjs",
    "extensions/chatero-documentation/live-preview-provider.cjs",
    "extensions/chatero-documentation/media/documentation.svg",
    "extensions/chatero-documentation/media/documentation-webview/live-preview.css",
    "extensions/chatero-documentation/media/documentation-webview/live-preview.js",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_AMS-Regular.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Caligraphic-Bold.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Caligraphic-Regular.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Fraktur-Bold.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Fraktur-Regular.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Main-Bold.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Main-BoldItalic.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Main-Italic.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Main-Regular.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Math-BoldItalic.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Math-Italic.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_SansSerif-Bold.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_SansSerif-Italic.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_SansSerif-Regular.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Script-Regular.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Size1-Regular.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Size2-Regular.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Size3-Regular.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Size4-Regular.woff2",
    "extensions/chatero-documentation/media/documentation-webview/fonts/KaTeX_Typewriter-Regular.woff2",
    "extensions/chatero-documentation/migration-model.mjs",
    "extensions/chatero-documentation/migration-executor.mjs",
    "extensions/chatero-documentation/migration-planner.mjs",
    "extensions/chatero-documentation/migration-recovery.mjs",
    "extensions/chatero-documentation/migration-rewrite.mjs",
    "extensions/chatero-documentation/package.json",
    "extensions/chatero-documentation/pending-edit-rebase.mjs",
    "extensions/chatero-documentation/review-decisions.mjs",
    "extensions/chatero-documentation/review-snapshot.mjs",
    "extensions/chatero-documentation/research-loop-commands.mjs",
    "extensions/chatero-documentation/research-loop-composition.mjs",
    "extensions/chatero-documentation/research-loop-controller.mjs",
    "extensions/chatero-documentation/research-loop-model.mjs",
    "extensions/chatero-documentation/research-loop-registration.mjs",
    "extensions/chatero-documentation/literature-review.mjs",
    "extensions/chatero-documentation/reviewed-research-surfaces.mjs",
    "extensions/chatero-documentation/settlement-planner.mjs",
    "extensions/chatero-documentation/settlement-protocol.mjs",
    "extensions/chatero-documentation/settlement-recovery.mjs",
    "extensions/chatero-documentation/settlement-operations.mjs",
    "extensions/chatero-documentation/settlement-executor.mjs",
    "extensions/chatero-documentation/runtime/chatero-documentation-authority.mjs",
    "extensions/chatero-documentation/runtime/protocol.mjs",
    "extensions/chatero-documentation/runtime/yaml-2.9.0.mjs",
    "extensions/chatero-documentation/runtime/yaml-LICENSE",
    "extensions/chatero-documentation/stable-hunks.mjs",
    "extensions/chatero-documentation/text-change-set.mjs",
    "extensions/chatero-documentation/three-way-reconcile.mjs",
    "extensions/chatero-documentation/webview/formal-block-decorations.mjs",
    "extensions/chatero-documentation/webview/formal-block-parser.mjs",
    "extensions/chatero-documentation/webview/formula-decorations.mjs",
    "extensions/chatero-documentation/webview/image-decorations.mjs",
    "extensions/chatero-documentation/webview/line-ending-map.mjs",
    "extensions/chatero-documentation/webview/prose-decorations.mjs",
    "extensions/chatero-documentation/webview/proof-collapse.mjs",
    "extensions/chatero-documentation/webview/qmd-language.mjs",
    "extensions/chatero-documentation/webview/qmd-preview.mjs",
    "extensions/chatero-documentation/webview/qmd-source-model.mjs",
    "extensions/chatero-documentation/webview/source-reveal.mjs",
    "extensions/chatero-documentation/webview/table-decorations.mjs",
    "extensions/chatero-documentation/working-copy-coordinator.mjs",
  ]);
});

async function activateWith({ enabled, registerDocumentation, registerLivePreview = async () => [] }) {
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
            assert.equal(fallback, true);
            return enabled;
          },
        };
      },
    },
  };
  const context = { subscriptions: [], documentationServices: Object.freeze({ test: true }) };
  const require = createRequire(import.meta.url);
  const extensionPath = fileURLToPath(new URL("extension.cjs", extensionRoot));
  delete require.cache[require.resolve(extensionPath)];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") return vscode;
    if (request === "./documentation-tree.cjs") return { registerDocumentation };
    if (request === "./live-preview-provider.cjs") return { registerLivePreview };
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
  let livePreviewRegistrations = 0;
  const result = await activateWith({
    enabled: false,
    registerLivePreview: async () => {
      livePreviewRegistrations++;
      return [];
    },
    registerDocumentation: async () => {
      registrations++;
      return [];
    },
  });

  assert.deepEqual(result.commands, [["setContext", "chatero.documentation.enabled", false]]);
  assert.equal(registrations, 0);
  assert.equal(livePreviewRegistrations, 1);
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

test("Live Preview activation failure does not block the enabled Documentation tree", async () => {
  const treeDisposable = { dispose() {} };
  let treeRegistrations = 0;
  const result = await activateWith({
    enabled: true,
    registerLivePreview: async () => { throw new Error("preview unavailable"); },
    registerDocumentation: async () => {
      treeRegistrations++;
      return [treeDisposable];
    },
  });
  assert.equal(treeRegistrations, 1);
  assert.ok(result.context.subscriptions.includes(treeDisposable));
  assert.equal(result.outputLines.length, 1);
  assert.match(result.outputLines[0], /Documentation Live Preview.*preview unavailable/);
});

class ExtensionTestUri {
  constructor({ scheme = "file", authority = "", path, query = "", fragment = "" }) {
    Object.assign(this, { scheme, authority, path, query, fragment });
  }

  with(changes) { return new ExtensionTestUri({ ...this, ...changes }); }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}

function createDocumentationHarness({ trusted = true, input = undefined, warning = undefined, livePreview = true } = {}) {
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
      getConfiguration(section) {
        assert.equal(section, "chatero.documentation");
        return { get: (key, fallback) => key === "livePreview" ? livePreview : fallback };
      },
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

test("Documentation Explorer follows Live Preview preference while Open Source stays standard", async () => {
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
  assert.equal(harness.provider.getTreeItem(children[0]).command.command, "chatero.documentation.open");
  await harness.commands.run("chatero.documentation.open", pageUri);
  assert.deepEqual(harness.commands.executed.at(-1), ["vscode.openWith", pageUri, "chatero.documentation.livePreview"]);
  await harness.commands.run("chatero.documentation.openSource", pageUri);
  assert.deepEqual(harness.commands.executed.at(-1), ["vscode.openWith", pageUri, "default"]);
  assert.ok(disposables.every(value => typeof value.dispose === "function"));

  const standardHarness = createDocumentationHarness({ livePreview: false });
  standardHarness.context.documentationServices = services;
  await registerDocumentation(standardHarness.vscode, standardHarness.context);
  await standardHarness.commands.run("chatero.documentation.open", pageUri);
  assert.deepEqual(standardHarness.commands.executed.at(-1), ["vscode.openWith", pageUri, "default"]);
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
  assert.equal(harness.commands.executed.at(-1)[2], "chatero.documentation.livePreview");
});

test("migration planning opens a read-only report before a separate explicit migration", async () => {
  const harness = createDocumentationHarness({ trusted: true, warning: "Migrate" });
  const base = createDocumentationServices();
  const reportUri = new ExtensionTestUri({
    scheme: "chatero-documentation-report",
    path: "/plan.md",
  });
  const publications = [];
  const services = {
    ...base,
    migrationReports: {
      publish(plan, report, Uri) {
        publications.push({ plan, report, Uri });
        return reportUri;
      },
    },
    transactions: {
      ...base.transactions,
      async planMigration() {
        return {
          kind: "planned",
          plan: {
            schemaVersion: 2,
            operationId: `migration-${"1".repeat(32)}`,
            digest: `sha256:${"a".repeat(64)}`,
          },
          planToken: `mp_${"A".repeat(43)}`,
          report: "# Dry run\n",
        };
      },
      migrationApprovalRequest(input) {
        return {
          kind: "migration-approval-request",
          digest: `sha256:${"b".repeat(64)}`,
          ...input,
        };
      },
      async migrate(_approval, input) {
        return {
          kind: "migration-committed",
          operationId: `migration-${"1".repeat(32)}`,
          receipt: input.idempotencyKey,
        };
      },
    },
  };
  harness.context.documentationServices = services;
  const { registerDocumentation } = await loadDocumentationTree();
  await registerDocumentation(harness.vscode, harness.context);

  const result = await harness.commands.run("chatero.documentation.planMigration");
  assert.equal(result.kind, "planned");
  assert.equal(publications.length, 1);
  assert.equal(publications[0].report.includes(result.planToken), false);
  assert.deepEqual(harness.commands.executed.at(-1), ["vscode.openWith", reportUri, "default"]);
  assert.equal(harness.workspaceEdits.length, 0);
  const migrated = await harness.commands.run("chatero.documentation.migrate");
  assert.equal(migrated.kind, "migration-committed");
  assert.equal(harness.workspaceEdits.length, 0);
});
