const { createHash, randomUUID: nodeRandomUUID } = require("node:crypto");

const PAGE_CONTEXT_VALUES = Object.freeze([
  "documentation.page.working",
  "documentation.page.reviewed",
  "documentation.page.orphan",
  "documentation.page.diagnostic",
]);

function uriString(uri) {
  if (!uri || typeof uri.toString !== "function") throw new TypeError("Documentation URI is invalid");
  return uri.toString(true);
}

function disposable(value) {
  if (!value || typeof value.dispose !== "function") throw new TypeError("Documentation registration is not disposable");
  return value;
}

class DocumentationTreeProvider {
  constructor({ vscode, transactions, scope, diagnostics, workspaceFolderUri, paths }) {
    this.vscode = vscode;
    this.transactions = transactions;
    this.scope = scope;
    this.diagnostics = diagnostics;
    this.workspaceFolderUri = workspaceFolderUri;
    this.paths = paths;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  refresh() {
    this.changed.fire(undefined);
  }

  dispose() {
    this.changed.dispose();
  }

  _uri(path) {
    return this.paths.documentationWorkspaceUri(this.workspaceFolderUri, path);
  }

  _diagnosticValue(value) {
    if (typeof this.vscode.Diagnostic === "function" && typeof this.vscode.Range === "function") {
      return new this.vscode.Diagnostic(
        new this.vscode.Range(0, 0, 0, 1),
        value.message,
        this.vscode.DiagnosticSeverity.Warning,
      );
    }
    return Object.freeze({ message: value.message, severity: this.vscode.DiagnosticSeverity?.Warning });
  }

  _publishDiagnostics(values) {
    this.diagnostics.clear?.();
    const grouped = new Map();
    for (const value of values) {
      let uri;
      try {
        uri = value.path.toLowerCase().endsWith(".qmd")
          ? this._uri(this.paths.documentationPagePath(value.path))
          : this.workspaceFolderUri.with({
              path: `${this.workspaceFolderUri.path.replace(/\/+$/u, "")}/${value.path}`,
              query: "",
              fragment: "",
            });
      }
      catch {
        continue;
      }
      const key = uriString(uri);
      const entry = grouped.get(key) ?? { uri, values: [] };
      entry.values.push(this._diagnosticValue(value));
      grouped.set(key, entry);
    }
    for (const { uri, values: diagnostics } of grouped.values()) this.diagnostics.set?.(uri, diagnostics);
  }

  getTreeItem(element) {
    if (element.kind === "empty" || element.kind === "diagnostic") {
      const item = new this.vscode.TreeItem(element.label, this.vscode.TreeItemCollapsibleState.None);
      item.contextValue = element.kind === "empty" ? "documentation.empty" : "documentation.diagnostic";
      item.iconPath = new this.vscode.ThemeIcon(element.kind === "empty" ? "info" : "warning");
      return item;
    }
    const item = new this.vscode.TreeItem(element.path.value, this.vscode.TreeItemCollapsibleState.None);
    const uri = this._uri(element.path);
    item.resourceUri = uri;
    item.description = element.orphan ? "orphan" : element.state;
    item.contextValue = element.diagnostic
      ? PAGE_CONTEXT_VALUES[3]
      : element.orphan
        ? PAGE_CONTEXT_VALUES[2]
        : element.state === "reviewed" ? PAGE_CONTEXT_VALUES[1] : PAGE_CONTEXT_VALUES[0];
    item.iconPath = new this.vscode.ThemeIcon(
      element.diagnostic || element.orphan ? "warning"
        : element.state === "reviewed" ? "pass-filled" : "edit",
    );
    item.command = {
      command: "chatero.documentation.openSource",
      title: "Open Documentation Source",
      arguments: [uri],
    };
    return item;
  }

  async getChildren(element) {
    if (element) return [];
    const state = await this.transactions.state(this.scope);
    this._publishDiagnostics(state.diagnostics ?? []);
    const diagnosticPaths = new Set((state.diagnostics ?? []).map(value => value.path));
    const pages = Object.entries(state.documents ?? {}).map(([value, record]) => Object.freeze({
      kind: "page",
      path: this.paths.documentationPagePath(value),
      state: record.state,
      orphan: record.orphan === true,
      diagnostic: diagnosticPaths.has(value),
    }));
    if (pages.length > 0) return pages;
    if ((state.diagnostics ?? []).length > 0) {
      return [Object.freeze({ kind: "diagnostic", label: state.diagnostics[0].message })];
    }
    return [Object.freeze({ kind: "empty", label: "No Documentation pages" })];
  }
}

async function registerDocumentation(vscode, context, injectedServices) {
  const [paths, operations] = await Promise.all([
    import("./documentation-path.mjs"),
    import("./documentation-operations.mjs"),
  ]);
  const services = injectedServices ?? context.documentationServices;
  if (!services?.transactions || !services.scope || !services.capabilities || !services.workspaceFolderUri) {
    throw new TypeError("Documentation authority services are unavailable");
  }
  const diagnostics = services.diagnostics
    ?? vscode.languages.createDiagnosticCollection("Documentation");
  const provider = new DocumentationTreeProvider({
    vscode,
    transactions: services.transactions,
    scope: services.scope,
    diagnostics,
    workspaceFolderUri: services.workspaceFolderUri,
    paths,
  });
  const registrations = [
    provider,
    diagnostics,
    vscode.window.registerTreeDataProvider("chatero.documentation.pages", provider),
  ];

  const requireTrusted = async () => {
    if (vscode.workspace.isTrusted === true) return true;
    await vscode.window.showErrorMessage?.("Documentation changes require a trusted workspace.");
    return false;
  };

  const pageFrom = value => {
    if (value?.kind === "documentation-page") {
      paths.validateOperationPathSet([{ kind: "edit", path: value }]);
      return value;
    }
    if (value?.path?.kind === "documentation-page") {
      paths.validateOperationPathSet([{ kind: "edit", path: value.path }]);
      return value.path;
    }
    if (!value || typeof value.path !== "string") throw new TypeError("Documentation page is required");
    const root = services.workspaceFolderUri.path === "/"
      ? "/documentation/"
      : `${services.workspaceFolderUri.path.replace(/\/+$/u, "")}/documentation/`;
    if (value.scheme !== services.workspaceFolderUri.scheme
      || value.authority !== services.workspaceFolderUri.authority
      || !value.path.startsWith(root)) {
      throw new TypeError("Documentation page is outside the active workspace");
    }
    return paths.documentationPagePath(value.path.slice(root.length));
  };

  const uriFor = page => paths.documentationWorkspaceUri(services.workspaceFolderUri, page);

  registrations.push(vscode.commands.registerCommand("chatero.documentation.openSource", async value => {
    const page = pageFrom(value);
    return vscode.commands.executeCommand("vscode.openWith", uriFor(page), "default");
  }));

  registrations.push(vscode.commands.registerCommand("chatero.documentation.refresh", () => provider.refresh()));

  registrations.push(vscode.commands.registerCommand("chatero.documentation.newPage", async request => {
    if (!await requireTrusted()) return Object.freeze({ kind: "workspace-untrusted" });
    const requestedPath = request?.path ?? await vscode.window.showInputBox({
      title: "New Documentation Page",
      prompt: "Enter a path relative to documentation/",
      placeHolder: "notes/result.qmd",
      validateInput(value) {
        try { paths.documentationPagePath(value); return null; }
        catch (error) { return error?.message ?? "Enter a normalized .qmd path"; }
      },
    });
    if (!requestedPath) return Object.freeze({ kind: "cancelled" });
    const page = paths.documentationPagePath(requestedPath);
    const initialText = request?.initialText ?? "";
    if (typeof initialText !== "string" || Buffer.byteLength(initialText, "utf8") > 16 * 1024 * 1024) {
      throw new TypeError("initial Documentation text is invalid");
    }
    const uri = uriFor(page);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { ignoreIfExists: false, overwrite: false });
    edit.insert(uri, new vscode.Position(0, 0), initialText);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error("Could not create Documentation page");
    provider.refresh();
    await vscode.commands.executeCommand("vscode.openWith", uri, "default");
    return Object.freeze({ kind: "created", path: page });
  }));

  const documentFor = async uri => {
    const existing = (vscode.workspace.textDocuments ?? []).find(value => uriString(value.uri) === uriString(uri));
    return existing ?? vscode.workspace.openTextDocument(uri);
  };

  const mark = state => async value => {
    if (!await requireTrusted()) return Object.freeze({ kind: "workspace-untrusted" });
    const page = pageFrom(value);
    const uri = uriFor(page);
    const document = await documentFor(uri);
    if (!document) throw new Error("Documentation page is not openable");
    if (document.isDirty) {
      if (state !== "reviewed") {
        await vscode.window.showWarningMessage?.("Save the Documentation page before changing its workflow state.");
        return Object.freeze({ kind: "dirty-working-copy", paths: Object.freeze([page]) });
      }
      const choice = await vscode.window.showWarningMessage(
        "Save this Documentation page before marking it Reviewed?",
        { modal: true },
        "Save",
        "Cancel",
      );
      if (choice !== "Save") return Object.freeze({ kind: "cancelled" });
      if (typeof document.save !== "function" || !await document.save() || document.isDirty) {
        return Object.freeze({ kind: "dirty-working-copy", paths: Object.freeze([page]) });
      }
    }
    const text = document.getText();
    const revision = `text-document:${document.version}:sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
    const current = await services.transactions.state(services.scope);
    const idempotencyKey = `state-${state}-${(services.randomUUID ?? nodeRandomUUID)()}`;
    const input = Object.freeze({
      path: page,
      expectedDocumentRevision: revision,
      expectedStateGeneration: current.generation,
      state,
      idempotencyKey,
    });
    const digest = operations.canonicalOperationDigest(input);
    const approval = services.capabilities.issueHumanApproval(services.scope, {
      digest,
      expiresInMs: 30_000,
    });
    const result = await services.transactions.setDocumentState(approval, input);
    provider.refresh();
    return result;
  };

  registrations.push(vscode.commands.registerCommand("chatero.documentation.markWorking", mark("working")));
  registrations.push(vscode.commands.registerCommand("chatero.documentation.markReviewed", mark("reviewed")));

  registrations.push(vscode.commands.registerCommand("chatero.documentation.planMigration", async () => {
    if (!await requireTrusted()) return Object.freeze({ kind: "workspace-untrusted" });
    if (typeof services.transactions.planMigration !== "function") {
      await vscode.window.showErrorMessage?.("Documentation migration planning is not available yet.");
      return Object.freeze({ kind: "feature-unavailable" });
    }
    const result = await services.transactions.planMigration(services.scope);
    if (result?.kind !== "planned") return result;
    if (!services.migrationReports) throw new TypeError("Documentation migration report provider is unavailable");
    const uri = services.migrationReports.publish(result.plan, result.report, vscode.Uri);
    await vscode.commands.executeCommand("vscode.openWith", uri, "default");
    return result;
  }));

  return Object.freeze(registrations.map(disposable));
}

module.exports = {
  DocumentationTreeProvider,
  PAGE_CONTEXT_VALUES,
  registerDocumentation,
};
