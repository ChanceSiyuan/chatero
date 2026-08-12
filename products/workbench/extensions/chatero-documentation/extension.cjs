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
    context.subscriptions.push(...await registerDocumentation(vscode, context));
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
