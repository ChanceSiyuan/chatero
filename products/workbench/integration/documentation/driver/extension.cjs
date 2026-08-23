const vscode = require("vscode");

function activate(context) {
  const state = Object.freeze({
    target: process.env.CHATERO_DOCUMENTATION_TEST_TARGET
      ?? (vscode.env.remoteName === "chatero-remote" ? "ssh-fixture" : "local"),
    workspace: vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? null,
  });
  context.subscriptions.push(vscode.commands.registerCommand(
    "chatero.documentation.integration.state",
    () => state,
  ));
  return state;
}

module.exports = { activate };
