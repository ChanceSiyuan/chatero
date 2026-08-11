const vscode = require("vscode");
const { NoteEditorProvider, PdfEditorProvider } = require("./evidence-editors.cjs");

class LibraryProvider {
  constructor(evidenceAuthority) {
    this.evidenceAuthority = evidenceAuthority;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.model = null;
    this.query = "";
    this.status = "Zotero Core is stopped";
  }

  refresh() {
    this.evidenceAuthority.reset();
    this._emitter.fire(undefined);
  }

  setConnection(model) {
    this.model = model;
    this.status = model ? "Zotero Core is ready" : "Zotero Core is stopped";
    this.refresh();
  }

  getTreeItem(element) {
    if (element.kind === "status") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(element.connected ? "pass-filled" : "circle-slash");
      item.contextValue = element.connected ? "chateroCoreReady" : "chateroCoreStopped";
      item.command = element.connected ? undefined : { command: "chatero.zotero.startCore", title: "Start Zotero Core" };
      return item;
    }
    if (element.kind === "collection") {
      const item = new vscode.TreeItem(element.value.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = element.value.itemCount === undefined ? undefined : String(element.value.itemCount);
      item.iconPath = new vscode.ThemeIcon("library");
      item.contextValue = "chateroZoteroCollection";
      return item;
    }
    if (element.kind === "attachment") {
      const item = new vscode.TreeItem(element.value.title, vscode.TreeItemCollapsibleState.None);
      item.description = element.value.annotationCount
        ? `${element.value.annotationCount} annotation${element.value.annotationCount === 1 ? "" : "s"}`
        : element.value.filename;
      item.iconPath = new vscode.ThemeIcon(element.value.contentType === "application/pdf" ? "file-pdf" : "file-media");
      item.contextValue = "chateroZoteroAttachment";
      item.command = { command: "chatero.zotero.openAttachment", title: "Open attachment", arguments: [element.value] };
      return item;
    }
    if (element.kind === "note") {
      const item = new vscode.TreeItem(element.value.title, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("note");
      item.contextValue = "chateroZoteroNote";
      item.command = { command: "chatero.zotero.openNote", title: "Open Note", arguments: [element.value] };
      return item;
    }
    const item = new vscode.TreeItem(element.value.title || "Untitled", vscode.TreeItemCollapsibleState.Collapsed);
    item.description = [element.value.creators?.[0], element.value.year].filter(Boolean).join(" · ");
    item.iconPath = new vscode.ThemeIcon(element.value.attachmentCount ? "file-pdf" : "book");
    item.contextValue = "chateroZoteroItem";
    item.tooltip = [element.value.title, ...(element.value.creators || [])].filter(Boolean).join("\n");
    return item;
  }

  async getChildren(element) {
    if (!this.model) return [{ kind: "status", label: this.status, connected: false }];
    if (!element) {
      const collections = await this.model.collections();
      const roots = collections.map(value => ({ kind: "collection", value }));
      if (this.query) {
        const result = await this.model.items({ query: this.query });
        roots.unshift(...result.items.map(value => ({ kind: "item", value })));
      }
      return [{ kind: "status", label: this.status, connected: true }, ...roots];
    }
    if (element.kind === "item") {
      const result = await this.model.children({ itemKey: element.value.itemKey, libraryId: element.value.libraryId });
      return [
        ...result.attachments.map(value => ({ kind: "attachment", value: this.evidenceAuthority.register(value, "attachment") })),
        ...result.notes.map(value => ({ kind: "note", value: this.evidenceAuthority.register(value, "note") })),
      ];
    }
    if (element.kind !== "collection") return [];
    const [collections, result] = await Promise.all([
      this.model.collections({ libraryId: element.value.libraryId, parentKey: element.value.collectionKey }),
      this.model.items({ collectionKey: element.value.collectionKey, libraryId: element.value.libraryId, query: this.query }),
    ]);
    return [
      ...collections.map(value => ({ kind: "collection", value })),
      ...result.items.map(value => ({ kind: "item", value })),
    ];
  }

  dispose() {
    this._emitter.dispose();
  }
}

async function activate(context) {
  const [{ LibraryTreeModel }, { EvidenceRecordAuthority }, registryModule, html] = await Promise.all([
    import("./library-tree-model.mjs"),
    import("./evidence-authority.mjs"),
    import("./evidence-editor-registry.mjs"),
    import("./evidence-editor-html.mjs"),
  ]);
  const { EvidenceDocumentRegistry, createEnsureCore, createEvidenceDocumentResolver } = registryModule;
  const evidenceAuthority = new EvidenceRecordAuthority();
  const evidenceDocuments = new EvidenceDocumentRegistry();
  const provider = new LibraryProvider(evidenceAuthority);
  let core = null;
  let disposeEvents = null;
  context.subscriptions.push(provider);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("chatero.zotero.library", provider));

  const stop = async () => {
    disposeEvents?.();
    disposeEvents = null;
    if (core) await core.stop();
    core = null;
    evidenceDocuments.reset();
    provider.setConnection(null);
  };

  const selectProfile = async () => {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Use Zotero Profile",
      title: "Select the Zotero profile for Chatero Core",
    });
    if (!selection?.[0]) return null;
    await vscode.workspace.getConfiguration("chatero.zotero").update("profilePath", selection[0].fsPath, vscode.ConfigurationTarget.Global);
    return selection[0].fsPath;
  };

  const selectCoreExecutable = async () => {
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "Use as Zotero Core",
      title: "Select the Chatero/Zotero Gecko executable",
    });
    if (!selection?.[0]) return null;
    await vscode.workspace.getConfiguration("chatero.zotero").update("coreExecutable", selection[0].fsPath, vscode.ConfigurationTarget.Global);
    return selection[0].fsPath;
  };

  const startCoreOnce = async () => {
    if (core) return core;
    const configuration = vscode.workspace.getConfiguration("chatero.zotero");
    let profileDirectory = configuration.get("profilePath", "");
    if (!profileDirectory) profileDirectory = await selectProfile();
    if (!profileDirectory) return null;
    const fixture = configuration.get("developerFixtureCore", false);
    let geckoExecutable;
    if (!fixture) {
      geckoExecutable = configuration.get("coreExecutable", "");
      if (!geckoExecutable) geckoExecutable = await selectCoreExecutable();
      if (!geckoExecutable) return null;
    }
    const { startCore } = await import("./runtime/zotero-core/supervisor/core-supervisor.mjs");
    core = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Window,
      title: "Starting Zotero Core…",
    }, () => startCore({
      profileDirectory,
      ...(geckoExecutable && { geckoExecutable }),
      requestedCapabilities: ["events:read", "library:read", "library:search", "profile:read"],
    }));
    const model = new LibraryTreeModel({ request: core.client.request });
    disposeEvents = core.client.onEvent(() => provider.refresh());
    provider.setConnection(model);
    void core.whenStopped.then(result => {
      if (!result.expected) {
        disposeEvents?.();
        disposeEvents = null;
        core = null;
        provider.setConnection(null);
        void vscode.window.showErrorMessage("Zotero Core stopped unexpectedly. Your profile lease was released safely.");
      }
    });
    return core;
  };
  const ensureCore = createEnsureCore({ getCurrent: () => core, start: startCoreOnce });
  const resolveDocument = createEvidenceDocumentResolver({
    ensureCore,
    getModel: () => provider.model,
    registry: evidenceDocuments,
  });

  context.subscriptions.push(vscode.window.registerCustomEditorProvider("chatero.zotero.pdf", new PdfEditorProvider({
    vscode,
    registry: evidenceDocuments,
    getModel: () => provider.model,
    resolveDocument,
    renderPdfEditorHTML: html.renderPdfEditorHTML,
    extensionUri: context.extensionUri,
  }), { supportsMultipleEditorsPerDocument: false }));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider("chatero.zotero.note", new NoteEditorProvider({
    registry: evidenceDocuments,
    getModel: () => provider.model,
    resolveDocument,
    renderNoteEditorHTML: html.renderNoteEditorHTML,
  }), { supportsMultipleEditorsPerDocument: false }));

  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.selectProfile", selectProfile));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.selectCoreExecutable", selectCoreExecutable));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.startCore", () => ensureCore().catch(error => vscode.window.showErrorMessage(`Could not start Zotero Core: ${error.message}`))));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.stopCore", () => stop().catch(error => vscode.window.showErrorMessage(`Could not stop Zotero Core: ${error.message}`))));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.refreshLibrary", () => provider.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.openAttachment", record => {
    const trusted = evidenceAuthority.authorize(record, "attachment");
    const uri = vscode.Uri.parse(evidenceDocuments.stage("pdf", trusted));
    return vscode.commands.executeCommand("vscode.openWith", uri, "chatero.zotero.pdf", { preview: false });
  }));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.openNote", record => {
    const trusted = evidenceAuthority.authorize(record, "note");
    const uri = vscode.Uri.parse(evidenceDocuments.stage("note", trusted));
    return vscode.commands.executeCommand("vscode.openWith", uri, "chatero.zotero.note", { preview: false });
  }));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.searchLibrary", async () => {
    const query = await vscode.window.showInputBox({ placeHolder: "Search titles and creators", prompt: "Search Zotero Library" });
    if (query === undefined) return;
    provider.query = query;
    provider.refresh();
  }));
  context.subscriptions.push({ dispose: () => { void stop(); } });
}

function deactivate() {}

module.exports = { activate, deactivate };
