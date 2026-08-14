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

  forget(uri) {
    if (typeof uri?.toString === "function") this.values.delete(uri.toString());
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

function reviewItems(vscode, leaves, picked) {
  const separator = vscode.QuickPickItemKind?.Separator;
  const items = [];
  let group;
  for (const leaf of leaves) {
    const path = displayPath(leaf);
    if (separator !== undefined && path !== group) {
      group = path;
      items.push(Object.freeze({ label: path, kind: separator }));
    }
    items.push(Object.freeze({
      leaf,
      label: decisionTitle(leaf),
      description: path,
      ...(leaf.dependsOn.length > 0
        ? { detail: `Follows ${leaf.dependsOn.length} earlier decision${leaf.dependsOn.length === 1 ? "" : "s"} in this change set` }
        : {}),
      picked,
    }));
  }
  return items;
}

function chosenLeafIds(choice) {
  return new Set((choice ?? []).filter(value => value?.leaf).map(value => value.leaf.id));
}

// One decision per leaf, in snapshot order, with the dependency cascade applied afterwards so the
// emitted vector is identical to the per-leaf flow for an identical accept/reject selection.
function resolvedDecisions(leaves, acceptedIds, deferredIds) {
  const decisions = [];
  const byId = new Map();
  for (const leaf of leaves) {
    const dependencies = leaf.dependsOn.map(id => byId.get(id));
    let decision = acceptedIds.has(leaf.id) ? "accept" : deferredIds.has(leaf.id) ? "defer" : "reject";
    if (dependencies.includes("reject")) decision = "reject";
    else if (decision === "accept" && dependencies.includes("defer")) decision = "defer";
    byId.set(leaf.id, decision);
    decisions.push(Object.freeze({ id: leaf.id, decision }));
  }
  return decisions;
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
  // Review texts stay resident for exactly as long as a diff tab can ask for them, instead of
  // accumulating every reviewed document until the extension deactivates.
  const closedReviewDocuments = vscode.workspace.onDidCloseTextDocument?.(document => {
    if (document?.uri?.scheme === "chatero-documentation-review") provider.forget(document.uri);
  });
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
    const acceptedChoice = await vscode.window.showQuickPick(
      reviewItems(vscode, snapshot.leaves, true),
      {
        title: "Review Agent Documentation changes",
        placeHolder: "Checked changes are accepted; unchecked changes are rejected",
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!Array.isArray(acceptedChoice)) return Object.freeze({ kind: "cancelled" });
    const acceptedIds = chosenLeafIds(acceptedChoice);
    const notAccepted = snapshot.leaves.filter(leaf => !acceptedIds.has(leaf.id));
    let deferredIds = new Set();
    if (notAccepted.length > 0) {
      const deferredChoice = await vscode.window.showQuickPick(
        reviewItems(vscode, notAccepted, false),
        {
          title: "Defer instead of rejecting",
          placeHolder: "Checked changes are deferred to a later change set; leave all unchecked to reject them",
          canPickMany: true,
          ignoreFocusOut: true,
        },
      );
      if (!Array.isArray(deferredChoice)) return Object.freeze({ kind: "cancelled" });
      deferredIds = chosenLeafIds(deferredChoice);
    }
    const decisions = resolvedDecisions(snapshot.leaves, acceptedIds, deferredIds);
    const accepted = decisions.filter(value => value.decision === "accept").length;
    const deferred = decisions.filter(value => value.decision === "defer").length;
    const apply = await vscode.window.showInformationMessage?.(
      `Apply ${accepted} accepted Documentation change${accepted === 1 ? "" : "s"}${deferred > 0 ? ` and defer ${deferred}` : ""}? The QMD editors remain undoable and are not auto-saved.`,
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
  const registrations = [provider, providerRegistration, command];
  if (closedReviewDocuments) registrations.push(closedReviewDocuments);
  return Object.freeze(registrations.map(disposable));
}

module.exports = { ReviewContentProvider, registerDocumentationReview };
