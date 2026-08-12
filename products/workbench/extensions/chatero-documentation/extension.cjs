async function activate(context) {
  let vscode;
  try {
    vscode = require("vscode");
  }
  catch {
    return;
  }

  let output;
  const report = (label, error) => {
    if (!output) {
      output = vscode.window.createOutputChannel("Documentation");
      context.subscriptions.push(output);
    }
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`${label} registration failed: ${message}`);
  };

  async function registerSafely(label, register) {
    try {
      const registrations = await register();
      if (!Array.isArray(registrations)) throw new TypeError(`${label} registration did not return an array`);
      return registrations;
    }
    catch (error) {
      report(label, error);
      return [];
    }
  }

  const livePreview = await registerSafely("Documentation Live Preview", async () => {
    const { registerLivePreview } = require("./live-preview-provider.cjs");
    return registerLivePreview({ vscode, context });
  });
  context.subscriptions.push(...livePreview);

  let enabled = false;
  try {
    enabled = vscode.workspace
      .getConfiguration("chatero.documentation")
      .get("enabled", false) === true;
    await vscode.commands.executeCommand("setContext", "chatero.documentation.enabled", enabled);
  }
  catch (error) {
    report("Documentation routing", error);
    return;
  }
  if (!enabled) return;

  const documentation = await registerSafely("Documentation", async () => {
    const { registerDocumentation } = require("./documentation-tree.cjs");
    const services = context.documentationServices
      ?? await import("./documentation-services.mjs").then(module =>
        module.createProductionDocumentationServices({ vscode, context }));
    let registrationServices = services;
    if (services.recoveryStatus?.kind === "documentation-tamper") {
      await vscode.window.showErrorMessage?.(
        "Documentation recovery detected inconsistent operation evidence. Documentation remains isolated; unrelated workbench and Zotero features are still available.",
      );
    }
    else if (services.recoveryStatus?.kind === "recovery-conflict") {
      await vscode.window.showWarningMessage?.(
        "Documentation recovery preserved newer human bytes and kept the affected page isolated for explicit resolution.",
      );
    }
    if (typeof services.transactions?.planMigration === "function") {
      const { MigrationReportContentProvider } = await import("./migration-planner.mjs");
      const migrationReports = new MigrationReportContentProvider();
      context.subscriptions.push(
        migrationReports,
        vscode.workspace.registerTextDocumentContentProvider(
          "chatero-documentation-report",
          migrationReports,
        ),
      );
      registrationServices = Object.freeze({ ...services, migrationReports });
    }
    const registrations = [];
    if (typeof vscode.lm?.registerTool === "function"
      && typeof services.transactions?.stage === "function"
      && typeof services.retrieval?.retrieve === "function") {
      const { registerDocumentationAgentTools } = await import("./documentation-agent-tools.mjs");
      registrations.push(...registerDocumentationAgentTools({
        vscode,
        transactions: services.transactions,
        retrieval: services.retrieval,
        capabilities: services.capabilities,
        scope: services.scope,
      }));
    }
    if (typeof services.transactions?.review === "function"
      && typeof services.transactions?.settle === "function") {
      const { registerDocumentationReview } = require("./documentation-review.cjs");
      registrations.push(...await registerDocumentationReview({ vscode, services }));
    }
    registrations.push(...await registerDocumentation(vscode, context, registrationServices));
    return registrations;
  });
  context.subscriptions.push(...documentation);
}

module.exports = { activate };
