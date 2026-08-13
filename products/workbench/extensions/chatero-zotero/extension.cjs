const vscode = require("vscode");
const { homedir } = require("node:os");
const { NoteEditorProvider, PdfEditorProvider } = require("./evidence-editors.cjs");

let activeLifecycle = null;
let deactivationPromise = null;
const PDF_CONTEXT_PROVIDER_ID = "zotero-pdf-evidence";

class LibrarySourceProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.model = null;
    this.core = null;
    this.status = "Zotero Core is stopped";
  }

  refresh() {
    this._emitter.fire(undefined);
  }

  setConnection(core, model) {
    this.core = core;
    this.model = model;
    this.status = core ? "Zotero Core is ready" : "Zotero Core is stopped";
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
    const collapsible = ["collection", "feedGroup", "library"].includes(element.kind)
      ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(element.value.name || element.value.status || "Zotero", collapsible);
    const icons = {
      collection: "folder", duplicates: "files", feed: "rss", feedGroup: "rss",
      library: element.value.groupId ? "organization" : "library", savedSearch: "filter",
      sync: element.value.inProgress ? "sync~spin" : element.value.offline ? "cloud-offline" : "cloud",
      trash: "trash", unfiled: "archive",
    };
    item.iconPath = new vscode.ThemeIcon(icons[element.kind] || "circle-outline");
    item.contextValue = `chateroZoteroSource.${element.kind}`;
    if (element.kind === "sync") item.description = element.value.status;
    if (element.kind === "feed") item.description = element.value.unreadCount ? String(element.value.unreadCount) : undefined;
    return item;
  }

  async getChildren(element) {
    if (!this.model) return element ? [] : [{ kind: "status", label: this.status, connected: false }];
    return element ? this.model.children(element) : this.model.roots();
  }

  dispose() {
    this._emitter.dispose();
  }
}

class LibraryItemProvider {
  constructor({ evidenceAuthority, persist }) {
    this.evidenceAuthority = evidenceAuthority;
    this.persist = persist;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.model = null;
  }

  setConnection(model) {
    this.model = model;
    this.refresh();
  }

  refresh() {
    this.evidenceAuthority.reset();
    this._emitter.fire(undefined);
    void vscode.commands.executeCommand("setContext", "chateroZoteroHasMoreItems", this.model?.nextCursor !== undefined);
  }

  async open(source) {
    if (!this.model || !source) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Loading Zotero items…", cancellable: false }, () => this.model.open(source));
    await this.persist(this.model.snapshot());
    this.refresh();
  }

  async loadNext() {
    if (!this.model) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Loading more Zotero items…", cancellable: false }, () => this.model.loadNext());
    await this.persist(this.model.snapshot());
    this.refresh();
  }

  select(elements) {
    if (!this.model) return;
    this.model.select(elements.filter(value => value.kind === "item").map(value => `${value.value.libraryId}/${value.value.itemKey}`));
    void vscode.commands.executeCommand("setContext", "chateroZoteroHasSelection", this.model.selectedRows.length > 0);
    void this.persist(this.model.snapshot());
  }

  getTreeItem(element) {
    if (element.kind === "attachment") {
      const item = new vscode.TreeItem(element.value.title, vscode.TreeItemCollapsibleState.None);
      item.description = element.value.annotationCount ? `${element.value.annotationCount} annotations` : element.value.filename;
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
    const value = element.value;
    const item = new vscode.TreeItem(value.title || "Untitled", vscode.TreeItemCollapsibleState.Collapsed);
    const columns = vscode.workspace.getConfiguration("chatero.zotero").get("itemTableColumns", ["creators", "year", "itemType"]);
    item.description = columns.flatMap(column => column === "creators" ? value.creators.slice(0, 1) : value[column] === undefined ? [] : [String(value[column])]).join(" · ");
    item.iconPath = new vscode.ThemeIcon(value.attachmentCount ? "file-pdf" : "book");
    item.contextValue = "chateroZoteroItem";
    item.tooltip = [value.title, ...value.creators].join("\n");
    item.accessibilityInformation = { label: `${value.title}. ${item.description}`.trim(), role: "treeitem" };
    item.command = { command: "chatero.zotero.showItemDetails", title: "Show item details", arguments: [value] };
    return item;
  }

  async getChildren(element) {
    if (!this.model) return [];
    if (!element) return this.model.rows.map(value => ({ kind: "item", value }));
    if (element.kind !== "item") return [];
    const result = await this.model.core.children({ itemKey: element.value.itemKey, libraryId: element.value.libraryId });
    return [
      ...result.attachments.map(value => ({ kind: "attachment", value: this.evidenceAuthority.register(value, "attachment") })),
      ...result.notes.map(value => ({ kind: "note", value: this.evidenceAuthority.register(value, "note") })),
    ];
  }

  dispose() { this._emitter.dispose(); }
}

async function activate(context) {
  const [{ LibraryTreeModel }, { LibraryItemTableModel }, { LibrarySourceTreeModel }, { EvidenceRecordAuthority }, registryModule, html, metadataHtml, brokerModule, contextFormat] = await Promise.all([
    import("./library-tree-model.mjs"),
    import("./library-item-table-model.mjs"),
    import("./library-source-tree-model.mjs"),
    import("./evidence-authority.mjs"),
    import("./evidence-editor-registry.mjs"),
    import("./evidence-editor-html.mjs"),
    import("./item-metadata-html.mjs"),
    import("./pdf-context-broker.mjs"),
    import("./pdf-context-format.mjs"),
  ]);
  const {
    EvidenceDocumentRegistry,
    createCoreLifecycle,
    createEvidenceDocumentResolver,
    readCoreLaunchConfiguration,
    selectLocalCoreConfigurationPath,
  } = registryModule;
  const evidenceAuthority = new EvidenceRecordAuthority();
  const evidenceDocuments = new EvidenceDocumentRegistry();
  const pdfContexts = new brokerModule.PdfContextBroker();
  const sourceProvider = new LibrarySourceProvider();
  const itemProvider = new LibraryItemProvider({
    evidenceAuthority,
    persist: snapshot => context.workspaceState.update("chatero.zotero.itemTable.v1", snapshot),
  });
  let pdfMaterializer = null;
  const dragAndDropController = {
    dragMimeTypes: ["application/vnd.chatero.zotero-items"],
    dropMimeTypes: ["application/vnd.chatero.zotero-items"],
    handleDrag(source, dataTransfer) {
      const identities = source.filter(value => value.kind === "item").map(value => ({ itemKey: value.value.itemKey, libraryId: value.value.libraryId }));
      dataTransfer.set("application/vnd.chatero.zotero-items", new vscode.DataTransferItem(identities));
    },
    async handleDrop() {},
  };
  const sourceView = vscode.window.createTreeView("chatero.zotero.library", { treeDataProvider: sourceProvider });
  const itemView = vscode.window.createTreeView("chatero.zotero.items", {
    canSelectMany: true,
    dragAndDropController: dragAndDropController,
    showCollapseAll: true,
    treeDataProvider: itemProvider,
  });
  context.subscriptions.push(sourceProvider, itemProvider, pdfContexts, sourceView, itemView);
  context.subscriptions.push(sourceView.onDidChangeSelection(event => {
    const source = sourceProvider.model?.toItemSource(event.selection[0]);
    if (source) void itemProvider.open(source).catch(error => vscode.window.showErrorMessage(`Could not load Zotero items: ${error.message}`));
  }));
  context.subscriptions.push(itemView.onDidChangeSelection(event => itemProvider.select(event.selection)));

  const getRemoteAlias = async () => {
    const folder = vscode.workspace.workspaceFolders?.find(value =>
      value?.uri?.scheme === "vscode-remote"
      && typeof value.uri.authority === "string"
      && value.uri.authority.startsWith("chatero-remote+"));
    if (!folder) return null;
    const remoteExtension = vscode.extensions.getExtension("chatero.chatero-remote");
    if (!remoteExtension) throw new Error("Chatero Remote is unavailable");
    const remote = remoteExtension.isActive ? remoteExtension.exports : await remoteExtension.activate();
    const session = remote?.getActiveSession?.(folder.uri.authority);
    if (!session || typeof session.alias !== "string") throw new Error("The active Chatero SSH target is unavailable");
    return session.alias;
  };
  const attachPdfSnapshot = async snapshot => {
    const attachment = contextFormat.makePdfContextAttachment(snapshot, await getRemoteAlias());
    return vscode.commands.executeCommand("chatero.chat.attachTextContext", attachment);
  };
  const pdfAttachProvider = contextFormat.createPdfAttachContextProvider({
    broker: pdfContexts,
    getRemoteAlias,
  });
  context.subscriptions.push(vscode.chat.registerChatAttachContextProvider(PDF_CONTEXT_PROVIDER_ID, pdfAttachProvider));

  const selectProfile = async () => {
    try {
      return await selectLocalCoreConfigurationPath({
        defaultUri: vscode.Uri.file(homedir()),
        dialogOptions: {
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "Use Zotero Profile",
          title: "Select the Zotero profile for Chatero Core",
        },
        label: "Zotero profile",
        showOpenDialog: options => vscode.window.showOpenDialog(options),
        update: value => vscode.workspace.getConfiguration("chatero.zotero")
          .update("profilePath", value, vscode.ConfigurationTarget.Global),
      });
    }
    catch (error) {
      void vscode.window.showErrorMessage(`Could not select a local Zotero profile: ${error.message}`);
      return null;
    }
  };

  const selectCoreExecutable = async () => {
    try {
      return await selectLocalCoreConfigurationPath({
        defaultUri: vscode.Uri.file(homedir()),
        dialogOptions: {
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: "Use as Zotero Core",
          title: "Select the Chatero/Zotero Gecko executable",
        },
        label: "Zotero Core executable",
        showOpenDialog: options => vscode.window.showOpenDialog(options),
        update: value => vscode.workspace.getConfiguration("chatero.zotero")
          .update("coreExecutable", value, vscode.ConfigurationTarget.Global),
      });
    }
    catch (error) {
      void vscode.window.showErrorMessage(`Could not select a local Zotero Core executable: ${error.message}`);
      return null;
    }
  };

  const launchCore = async () => {
    const configuration = readCoreLaunchConfiguration(vscode.workspace.getConfiguration("chatero.zotero"));
    let profileDirectory = configuration.profilePath;
    if (!profileDirectory) profileDirectory = await selectProfile();
    if (!profileDirectory) return null;
    const fixture = configuration.developerFixtureCore;
    let geckoExecutable;
    if (!fixture) {
      geckoExecutable = configuration.coreExecutable;
      if (!geckoExecutable) geckoExecutable = await selectCoreExecutable();
      if (!geckoExecutable) return null;
    }
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Window,
      title: "Starting Zotero Core…",
    }, async () => {
      const { startCore } = await import("./runtime/zotero-core/supervisor/core-supervisor.mjs");
      return startCore({
        profileDirectory,
        ...(geckoExecutable && { geckoExecutable }),
        requestedCapabilities: [
          "attachment:read", "attachment:write", "citation:read", "events:read", "library:read", "library:search", "library:write",
          "profile:read", "sync:read", "sync:write", "translation:read", "translation:write",
        ],
      });
    });
  };
  const lifecycle = createCoreLifecycle({
    start: launchCore,
    publish: startedCore => {
      const model = new LibraryTreeModel({ request: startedCore.client.request });
      const sourceModel = new LibrarySourceTreeModel({ core: model });
      const tableModel = new LibraryItemTableModel({
        core: model,
        pageSize: vscode.workspace.getConfiguration("chatero.zotero").get("itemTablePageSize", 50),
      });
      pdfMaterializer = null;
      sourceProvider.setConnection(model, sourceModel);
      itemProvider.setConnection(tableModel);
      const snapshot = context.workspaceState.get("chatero.zotero.itemTable.v1");
      if (snapshot) {
        try { tableModel.restore(snapshot); itemProvider.refresh(); }
        catch (_) { void context.workspaceState.update("chatero.zotero.itemTable.v1", undefined); }
      }
      return startedCore.client.onEvent(() => {
        sourceProvider.refresh();
        if (tableModel.source) void tableModel.open(tableModel.source, {
          query: tableModel.query, sortBy: tableModel.sortBy, sortDirection: tableModel.sortDirection,
        }).then(() => itemProvider.refresh(), () => {});
      });
    },
    unpublish: () => {
      pdfMaterializer = null;
      evidenceDocuments.reset();
      sourceProvider.setConnection(null, null);
      itemProvider.setConnection(null);
    },
    onUnexpectedStop: () => {
      void vscode.window.showErrorMessage("Zotero Core stopped unexpectedly. Your profile lease was released safely.");
    },
  });
  activeLifecycle = lifecycle;
  deactivationPromise = null;
  const ensureCore = lifecycle.ensureCore;
  const resolveDocument = createEvidenceDocumentResolver({
    ensureCore,
    getModel: () => sourceProvider.core,
    registry: evidenceDocuments,
  });
  const materializePdf = async record => {
    const startedCore = await ensureCore();
    if (!startedCore) throw new Error("Zotero Core setup is required before opening a PDF");
    if (!pdfMaterializer) {
      const { CorePdfMaterializer } = await import("./pdf-materializer.mjs");
      const rootDirectory = (context.storageUri || context.globalStorageUri)?.fsPath;
      pdfMaterializer = new CorePdfMaterializer({ request: startedCore.client.request, rootDirectory });
    }
    return pdfMaterializer.materialize(record);
  };

  context.subscriptions.push(vscode.window.registerCustomEditorProvider("chatero.zotero.pdf", new PdfEditorProvider({
    vscode,
    registry: evidenceDocuments,
    getModel: () => sourceProvider.core,
    resolveDocument,
    renderPdfEditorHTML: html.renderPdfEditorHTML,
    extensionUri: context.extensionUri,
    materializePdf,
    contextBroker: pdfContexts,
    attachPdfContext: attachPdfSnapshot,
    onContextError: () => {
      void vscode.window.showErrorMessage("Could not attach the bounded Zotero PDF context.");
    },
  }), { supportsMultipleEditorsPerDocument: false }));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider("chatero.zotero.note", new NoteEditorProvider({
    registry: evidenceDocuments,
    getModel: () => sourceProvider.core,
    resolveDocument,
    renderNoteEditorHTML: html.renderNoteEditorHTML,
  }), { supportsMultipleEditorsPerDocument: false }));

  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.selectProfile", selectProfile));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.selectCoreExecutable", selectCoreExecutable));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.startCore", () => ensureCore().catch(error => vscode.window.showErrorMessage(`Could not start Zotero Core: ${error.message}`))));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.stopCore", () => lifecycle.stopCore().catch(error => vscode.window.showErrorMessage(`Could not stop Zotero Core: ${error.message}`))));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.refreshLibrary", () => {
    sourceProvider.refresh();
    if (itemProvider.model?.source) void itemProvider.model.open(itemProvider.model.source, {
      query: itemProvider.model.query, sortBy: itemProvider.model.sortBy, sortDirection: itemProvider.model.sortDirection,
    }).then(() => itemProvider.refresh(), error => vscode.window.showErrorMessage(`Could not refresh Zotero items: ${error.message}`));
  }));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.addPdfContextToChat", async () => {
    try {
      return await attachPdfSnapshot(pdfContexts.captureActive());
    }
    catch (_) {
      void vscode.window.showErrorMessage("Could not attach the bounded Zotero PDF context.");
      return null;
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.sendFullPaperToRemote", () =>
    vscode.window.showInformationMessage("Full-paper transfer requires a separate explicit authorization and is not enabled yet.")));
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
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.showItemDetails", async item => {
    if (!sourceProvider.core) {
      void vscode.window.showErrorMessage("Zotero Core is stopped.");
      return;
    }
    if (!item || typeof item.itemKey !== "string" || typeof item.libraryId !== "number") {
      void vscode.window.showErrorMessage("No Zotero item is selected.");
      return;
    }
    try {
      const metadata = await sourceProvider.core.metadata({ itemKey: item.itemKey, libraryId: item.libraryId });
      const panel = vscode.window.createWebviewPanel(
        "chatero.zotero.itemDetails",
        metadata.title || "Item Details",
        vscode.ViewColumn.Beside,
        { enableScripts: false, localResourceRoots: [] },
      );
      panel.webview.html = metadataHtml.renderItemMetadataHTML(metadata);
    }
    catch (error) {
      void vscode.window.showErrorMessage(`Could not load Zotero item details: ${error.message}`);
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.searchLibrary", async () => {
    const query = await vscode.window.showInputBox({ placeHolder: "Search titles and creators", prompt: "Search Zotero Library" });
    if (query === undefined || !itemProvider.model?.source) return;
    await itemProvider.model.search(query);
    await context.workspaceState.update("chatero.zotero.itemTable.v1", itemProvider.model.snapshot());
    itemProvider.refresh();
  }));
  const persistAndRefreshItems = async () => {
    if (!itemProvider.model?.source) return;
    await itemProvider.model.open(itemProvider.model.source, {
      query: itemProvider.model.query, sortBy: itemProvider.model.sortBy, sortDirection: itemProvider.model.sortDirection,
    });
    await context.workspaceState.update("chatero.zotero.itemTable.v1", itemProvider.model.snapshot());
    itemProvider.refresh();
  };
  const runBatch = async action => {
    try {
      await vscode.window.withProgress({
        cancellable: false,
        location: vscode.ProgressLocation.Notification,
        title: `${action === "trash" ? "Moving" : "Restoring"} Zotero items…`,
      }, () => itemProvider.model.batch(action));
      await persistAndRefreshItems();
    }
    catch (error) { void vscode.window.showErrorMessage(`Could not update Zotero items: ${error.message}`); }
  };
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.loadMoreItems", () => itemProvider.loadNext()));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.sortItems", async () => {
    if (!itemProvider.model?.source) return;
    const choice = await vscode.window.showQuickPick([
      { label: "Title (A–Z)", sortBy: "title", sortDirection: "asc" },
      { label: "Title (Z–A)", sortBy: "title", sortDirection: "desc" },
      { label: "Creator", sortBy: "creators", sortDirection: "asc" },
      { label: "Year (newest first)", sortBy: "year", sortDirection: "desc" },
      { label: "Item type", sortBy: "itemType", sortDirection: "asc" },
    ], { placeHolder: "Sort Zotero items" });
    if (!choice) return;
    await itemProvider.model.sort(choice.sortBy, choice.sortDirection);
    await context.workspaceState.update("chatero.zotero.itemTable.v1", itemProvider.model.snapshot());
    itemProvider.refresh();
  }));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.batchTrash", () => runBatch("trash")));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.batchRestore", () => runBatch("restore")));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.batchMoveToCollection", async () => {
    const selected = itemProvider.model?.selectedRows || [];
    if (!selected.length) return void vscode.window.showErrorMessage("Select at least one Zotero item.");
    const libraryId = selected[0].libraryId;
    const collections = (await sourceProvider.core.collections()).filter(value => value.libraryId === libraryId);
    const chosen = await vscode.window.showQuickPick(collections.map(value => ({ label: value.name, value })), { canPickMany: true, placeHolder: "Choose destination collections" });
    if (!chosen) return;
    try {
      await itemProvider.model.batch("collections", { collectionKeys: chosen.map(value => value.value.collectionKey) });
      await persistAndRefreshItems();
    }
    catch (error) { void vscode.window.showErrorMessage(`Could not move Zotero items: ${error.message}`); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.retrySync", async () => {
    if (!sourceProvider.core) return;
    try {
      const status = await sourceProvider.core.syncStatus();
      const libraryIds = status.libraries.map(value => value.libraryId);
      if (!libraryIds.length) return void vscode.window.showInformationMessage("No syncable Zotero libraries are available.");
      await vscode.window.withProgress({ cancellable: true, location: vscode.ProgressLocation.Notification, title: "Syncing Zotero libraries…" }, async (_, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort(new Error("Zotero sync was cancelled")));
        try { return await sourceProvider.core.transact("sync.retry", { libraryIds }, { scope: "sync:retry", options: { signal: controller.signal } }); }
        finally { subscription.dispose(); }
      });
      sourceProvider.refresh();
    }
    catch (error) { void vscode.window.showErrorMessage(`Could not sync Zotero: ${error.message}`); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.exportItems", async () => {
    const selected = itemProvider.model?.selectedRows || [];
    if (!selected.length) return void vscode.window.showErrorMessage("Select at least one Zotero item.");
    try {
      const translators = await sourceProvider.core.request("translation.translators", { kind: "export" });
      const translator = await vscode.window.showQuickPick(translators.translators.map(value => ({ label: value.label, value })), { placeHolder: "Choose an export format" });
      if (!translator) return;
      const result = await sourceProvider.core.request("translation.export", {
        identities: selected.map(value => ({ itemKey: value.itemKey, libraryId: value.libraryId })), translatorId: translator.value.translatorId,
      });
      await vscode.env.clipboard.writeText(result.content);
      void vscode.window.showInformationMessage(`Exported ${result.itemCount} Zotero item${result.itemCount === 1 ? "" : "s"} to the clipboard.`);
    }
    catch (error) { void vscode.window.showErrorMessage(`Could not export Zotero items: ${error.message}`); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.importItems", async () => {
    if (!itemProvider.model?.source) return void vscode.window.showErrorMessage("Select a Zotero library first.");
    const content = await vscode.window.showInputBox({ ignoreFocusOut: true, prompt: "Paste BibTeX, RIS, or another supported bibliography" });
    if (!content) return;
    try {
      const translators = await sourceProvider.core.request("translation.translators", { kind: "import" });
      const translator = await vscode.window.showQuickPick(translators.translators.map(value => ({ label: value.label, value })), { placeHolder: "Choose an import format" });
      if (!translator) return;
      const libraryId = itemProvider.model.source.libraryId;
      await sourceProvider.core.transact("translation.import", {
        content, libraryId, translatorId: translator.value.translatorId,
      }, { scope: `library:${libraryId}/translation:import` });
      await persistAndRefreshItems();
    }
    catch (error) { void vscode.window.showErrorMessage(`Could not import Zotero items: ${error.message}`); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.lookupIdentifier", async () => {
    const text = await vscode.window.showInputBox({ placeHolder: "DOI, ISBN, PMID, arXiv ID, or URL", prompt: "Look up bibliographic metadata" });
    if (!text) return;
    try {
      const result = await sourceProvider.core.request("translation.lookup", { text });
      const selected = await vscode.window.showQuickPick(result.candidates.map(value => ({ description: value.creators.join(", "), label: value.title, value })), { placeHolder: "Metadata candidates" });
      if (selected) void vscode.window.showInformationMessage(`${selected.value.title} — use Import Bibliography to add a reviewed record.`);
    }
    catch (error) { void vscode.window.showErrorMessage(`Could not look up identifier: ${error.message}`); }
  }));
  const selectedRows = () => itemProvider.model?.selectedRows || [];
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.editItemMetadata", async item => {
    const row = item?.itemKey ? item : selectedRows()[0];
    if (!row) return void vscode.window.showErrorMessage("Select one Zotero item to edit.");
    try {
      const metadata = await sourceProvider.core.metadata({ itemKey: row.itemKey, libraryId: row.libraryId });
      const title = await vscode.window.showInputBox({ prompt: "Zotero item title", value: metadata.title });
      if (title === undefined) return;
      const creatorsText = await vscode.window.showInputBox({ prompt: "Creators as JSON", value: JSON.stringify(metadata.creators.map(name => ({ creatorType: "author", name }))) });
      if (creatorsText === undefined) return;
      const tagsText = await vscode.window.showInputBox({ prompt: "Tags as comma-separated values", value: metadata.tags.join(", ") });
      if (tagsText === undefined) return;
      await sourceProvider.core.updateItem({
        creators: JSON.parse(creatorsText),
        fields: [
          { field: "title", value: title },
          { field: "date", value: metadata.date },
          { field: "abstractNote", value: metadata.abstractNote },
          ...(metadata.doi ? [{ field: "DOI", value: metadata.doi }] : []),
          ...(metadata.url ? [{ field: "url", value: metadata.url }] : []),
        ],
        itemKey: row.itemKey,
        libraryId: row.libraryId,
        tags: tagsText.split(",").map(value => value.trim()).filter(Boolean).map(name => ({ name, type: 0 })),
      });
      await persistAndRefreshItems();
    }
    catch (error) { void vscode.window.showErrorMessage(`Could not edit Zotero metadata: ${error.message}`); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.saveAdvancedSearch", async () => {
    const source = itemProvider.model?.source;
    if (!source) return void vscode.window.showErrorMessage("Select a Zotero library first.");
    const name = await vscode.window.showInputBox({ prompt: "Saved search name" });
    if (!name) return;
    const condition = await vscode.window.showQuickPick(["title", "creator", "tag", "year", "itemType"], { placeHolder: "Search field" });
    if (!condition) return;
    const value = await vscode.window.showInputBox({ prompt: `Value for ${condition}` });
    if (value === undefined) return;
    try {
      await sourceProvider.core.transact("library.saved-search-mutate", {
        action: "create", conditions: [{ condition, operator: "contains", value }], libraryId: source.libraryId, name,
      }, { scope: `library:${source.libraryId}/saved-search:catalog` });
      sourceProvider.refresh();
    }
    catch (error) { void vscode.window.showErrorMessage(`Could not save advanced search: ${error.message}`); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.showSyncConflicts", async () => {
    try {
      const status = await sourceProvider.core.syncStatus();
      const conflicts = (await Promise.all(status.libraries.map(value => sourceProvider.core.request("sync.conflicts", { libraryId: value.libraryId })))).flatMap(value => value.conflicts);
      if (!conflicts.length) return void vscode.window.showInformationMessage("No Zotero file conflicts.");
      await vscode.window.showQuickPick(conflicts.map(value => ({
        description: `${value.localModifiedAt} ↔ ${value.remoteModifiedAt}`,
        label: `${value.libraryId}/${value.attachmentKey}`,
      })), { placeHolder: "Zotero file conflicts" });
    }
    catch (error) { void vscode.window.showErrorMessage(`Could not load Zotero conflicts: ${error.message}`); }
  }));
  const copyRenderedCitation = async mode => {
    const selected = selectedRows();
    if (!selected.length) return void vscode.window.showErrorMessage("Select at least one Zotero item.");
    try {
      const styles = await sourceProvider.core.request("citation.styles", {});
      const style = await vscode.window.showQuickPick(styles.styles.map(value => ({ label: value.title, value })), { placeHolder: "Citation style" });
      if (!style) return;
      const rendered = await sourceProvider.core.request("citation.render", {
        identities: selected.map(value => ({ itemKey: value.itemKey, libraryId: value.libraryId })), mode, styleId: style.value.styleId,
      });
      await vscode.env.clipboard.writeText(rendered.text);
      void vscode.window.showInformationMessage(`${mode === "citation" ? "Citation" : "Bibliography"} copied to clipboard.`);
    }
    catch (error) { void vscode.window.showErrorMessage(`Could not render Zotero ${mode}: ${error.message}`); }
  };
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.copyCitation", () => copyRenderedCitation("citation")));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.copyBibliography", () => copyRenderedCitation("bibliography")));
  context.subscriptions.push(vscode.commands.registerCommand("chatero.zotero.copyLocateUrl", async item => {
    const row = item?.itemKey ? item : selectedRows()[0];
    if (!row) return void vscode.window.showErrorMessage("Select one Zotero item.");
    try {
      const metadata = await sourceProvider.core.metadata({ itemKey: row.itemKey, libraryId: row.libraryId });
      if (!metadata.url) return void vscode.window.showInformationMessage("This Zotero item has no URL.");
      await vscode.env.clipboard.writeText(metadata.url);
      void vscode.window.showInformationMessage("Zotero item URL copied to clipboard.");
    }
    catch (error) { void vscode.window.showErrorMessage(`Could not locate Zotero item: ${error.message}`); }
  }));
  context.subscriptions.push({
    dispose: () => {
      const cleanup = lifecycle.dispose();
      if (activeLifecycle === lifecycle) {
        activeLifecycle = null;
        deactivationPromise ||= cleanup;
      }
      void cleanup.catch(() => {});
    },
  });
}

function deactivate() {
  if (activeLifecycle) {
    const lifecycle = activeLifecycle;
    activeLifecycle = null;
    deactivationPromise ||= lifecycle.dispose();
  }
  return deactivationPromise;
}

module.exports = { activate, deactivate };
