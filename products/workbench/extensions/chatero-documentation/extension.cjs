async function activate(context) {
  let vscode;
  try {
    vscode = require("vscode");
    const enabled = vscode.workspace
      .getConfiguration("chatero.documentation")
      .get("enabled", false) === true;
    await vscode.commands.executeCommand("setContext", "chatero.documentation.enabled", enabled);
    if (!enabled) return;
    const { registerDocumentation } = require("./documentation-tree.cjs");
    const services = context.documentationServices
      ?? await import("./documentation-services.mjs").then(module =>
        module.createProductionDocumentationServices({ vscode, context }));
    let registrationServices = services;
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
    context.subscriptions.push(...await registerDocumentation(vscode, context, registrationServices));
  }
  catch (error) {
    if (!vscode) return;
    const output = vscode.window.createOutputChannel("Documentation");
    context.subscriptions.push(output);
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Documentation registration failed: ${message}`);
  }
}

module.exports = { activate };
