import { createHash } from "node:crypto";

import { buildLiteratureRefreshPlan } from "./research-loop-model.mjs";

function sha256(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function missing(error) {
  return error?.code === "FileNotFound" || error?.code === "ENOENT";
}

export function createLiteratureReview({ vscode, workspaceFolderUri } = {}) {
  if (!vscode?.workspace?.fs || typeof vscode.workspace.openTextDocument !== "function"
      || typeof vscode?.commands?.executeCommand !== "function" || !workspaceFolderUri) {
    throw new TypeError("Literature review dependencies are invalid");
  }
  const directory = vscode.Uri.joinPath(workspaceFolderUri, "literature");
  const target = vscode.Uri.joinPath(directory, "ref.bib");
  const readCurrent = async () => {
    try {
      const bytes = await vscode.workspace.fs.readFile(target);
      const text = Buffer.from(bytes).toString("utf8");
      if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) throw new TypeError("Literature bibliography is not UTF-8");
      return Object.freeze({ revision: sha256(text), text });
    }
    catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  };
  return async snapshot => {
    const initial = await readCurrent();
    if (snapshot?.current && (snapshot.current.revision !== initial?.revision || snapshot.current.text !== initial?.text)) {
      throw new Error("Literature bibliography changed since Zotero export");
    }
    const plan = buildLiteratureRefreshPlan({ ...snapshot, current: initial });
    const before = await vscode.workspace.openTextDocument({ content: initial?.text ?? "", language: "bibtex" });
    const after = await vscode.workspace.openTextDocument({ content: plan.operation.proposedText, language: "bibtex" });
    await vscode.commands.executeCommand("vscode.diff", before.uri ?? before, after.uri ?? after, "Review Zotero Literature Refresh");
    const choice = await vscode.window.showInformationMessage(
      `Apply reviewed Zotero bibliography refresh for ${plan.records.length} item${plan.records.length === 1 ? "" : "s"}?`,
      { modal: true },
      "Apply",
    );
    if (choice !== "Apply") return Object.freeze({ kind: "cancelled" });
    const revalidated = await readCurrent();
    if (revalidated?.revision !== initial?.revision || revalidated?.text !== initial?.text) {
      throw new Error("Literature bibliography changed during review");
    }
    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(target, Buffer.from(plan.operation.proposedText, "utf8"));
    return Object.freeze({
      kind: "literature-refreshed",
      recordDigest: plan.recordDigest,
      revision: sha256(plan.operation.proposedText),
    });
  };
}
