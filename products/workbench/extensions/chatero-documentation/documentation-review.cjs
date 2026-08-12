function disposable(value) {
  if (!value || typeof value.dispose !== "function") throw new TypeError("Documentation review registration is not disposable");
  return value;
}

function safeReference(value) {
  if (!value || typeof value !== "object"
    || typeof value.lineageId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.lineageId)
    || typeof value.generationId !== "string" || !/^[0-9a-f]{16}$/u.test(value.generationId)) {
    throw new TypeError("Change Set reference is invalid");
  }
  return Object.freeze({ lineageId: value.lineageId, generationId: value.generationId });
}

class ReviewContentProvider {
  constructor(vscode) {
    this.vscode = vscode;
    this.values = new Map();
  }

  publish(key, index, side, text) {
    const uri = this.vscode.Uri.from({
      scheme: "chatero-documentation-review",
      path: `/review/${encodeURIComponent(key)}/${index}/${side}.qmd`,
      query: "",
    });
    this.values.set(uri.toString(), text);
    return uri;
  }

  provideTextDocumentContent(uri) {
    return this.values.get(uri.toString()) ?? "";
  }

  dispose() { this.values.clear(); }
}

async function requestedReference(vscode, value) {
  if (value) return safeReference(value.ref ?? value);
  const lineageId = await vscode.window.showInputBox?.({
    title: "Review Documentation Change Set",
    prompt: "Lineage ID",
  });
  if (!lineageId) return null;
  const generationId = await vscode.window.showInputBox?.({
    title: "Review Documentation Change Set",
    prompt: "16-character generation ID",
    placeHolder: "0000000000000001",
  });
  if (!generationId) return null;
  return safeReference({ lineageId, generationId });
}

function proposalText(document) {
  return document.kind === "delete" ? "" : document.proposedText;
}

function displayPath(document) {
  return document.kind === "rename" ? document.destination.value : document.path.value;
}

function decisionTitle(leaf) {
  if (leaf.kind === "hunk") return `Review Agent hunk in ${leaf.path.value}`;
  if (leaf.kind === "rename") return `Review rename to ${leaf.destination.value}`;
  return `Review Agent ${leaf.kind}: ${leaf.path.value}`;
}

async function registerDocumentationReview({ vscode, services } = {}) {
  if (!vscode?.workspace || !vscode?.commands || !vscode?.window || !vscode?.Uri
    || typeof services?.transactions?.review !== "function"
    || typeof services?.transactions?.settle !== "function"
    || typeof services?.capabilities?.issueHumanApproval !== "function" || !services.scope) {
    throw new TypeError("Documentation review services are unavailable");
  }
  const { settlementApprovalDigest } = await import("./settlement-protocol.mjs");
  const provider = new ReviewContentProvider(vscode);
  const providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
    "chatero-documentation-review",
    provider,
  );
  const command = vscode.commands.registerCommand("chatero.documentation.reviewChangeSet", async value => {
    if (vscode.workspace.isTrusted !== true) {
      await vscode.window.showErrorMessage?.("Documentation review settlement requires a trusted workspace.");
      return Object.freeze({ kind: "workspace-untrusted" });
    }
    const ref = await requestedReference(vscode, value);
    if (!ref) return Object.freeze({ kind: "cancelled" });
    const snapshot = await services.transactions.review(ref);
    if (snapshot?.kind === "generation-missing") return snapshot;
    if (!snapshot || !Array.isArray(snapshot.documents) || !Array.isArray(snapshot.leaves)) {
      throw new TypeError("Documentation review snapshot is invalid");
    }
    const key = (services.randomUUID ?? (() => `${Date.now()}`))();
    for (const [index, document] of snapshot.documents.entries()) {
      const current = provider.publish(key, index, "current", document.currentText);
      const proposed = provider.publish(key, index, "proposed", proposalText(document));
      await vscode.commands.executeCommand(
        "vscode.diff",
        current,
        proposed,
        `${displayPath(document)} — Current ↔ Agent proposal`,
      );
    }
    const decisions = [];
    const byId = new Map();
    for (const leaf of snapshot.leaves) {
      if (leaf.dependsOn.some(id => byId.get(id) === "reject")) {
        byId.set(leaf.id, "reject");
        decisions.push(Object.freeze({ id: leaf.id, decision: "reject" }));
        continue;
      }
      const choice = await vscode.window.showQuickPick([
        { label: "$(check) Accept", value: "accept", description: "Apply this reviewed Agent change" },
        { label: "$(close) Reject", value: "reject", description: "Keep the current human-authored content" },
      ], {
        title: decisionTitle(leaf),
        placeHolder: "Choose exactly one decision",
        ignoreFocusOut: true,
      });
      if (!choice) return Object.freeze({ kind: "cancelled" });
      byId.set(leaf.id, choice.value);
      decisions.push(Object.freeze({ id: leaf.id, decision: choice.value }));
    }
    const accepted = decisions.filter(value => value.decision === "accept").length;
    const apply = await vscode.window.showInformationMessage?.(
      `Apply ${accepted} accepted Documentation change${accepted === 1 ? "" : "s"}? The QMD editors remain undoable and are not auto-saved.`,
      { modal: true },
      "Apply",
    );
    if (apply !== "Apply") return Object.freeze({ kind: "cancelled" });
    const input = Object.freeze({
      reviewToken: snapshot.reviewToken,
      reviewDigest: snapshot.reviewDigest,
      decisions: Object.freeze(decisions),
      idempotencyKey: `review-${key}`,
    });
    const approval = services.capabilities.issueHumanApproval(services.scope, {
      digest: settlementApprovalDigest(input),
      expiresInMs: 2 * 60 * 1000,
    });
    const result = await services.transactions.settle(approval, input);
    if (result?.kind === "settlement-committed") {
      await vscode.window.showInformationMessage?.("Documentation changes applied. Review or undo them in the QMD editor.");
    }
    else if (result?.kind === "settlement-conflict" || result?.kind === "stale-review") {
      await vscode.window.showErrorMessage?.("Documentation changed during review. Open a fresh review snapshot.");
    }
    return result;
  });
  return Object.freeze([provider, providerRegistration, command].map(disposable));
}

module.exports = { ReviewContentProvider, registerDocumentationReview };
