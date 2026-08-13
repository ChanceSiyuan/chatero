import {
  buildLiteratureRefreshPlan,
  buildMultiPaperContextManifest,
  buildNoteDraftProposal,
  buildResearchActionPrompt,
} from "./research-loop-model.mjs";

function trusted(vscode) {
  if (vscode?.workspace?.isTrusted !== true) throw new Error("Research Loop commands require a trusted workspace");
}

function callable(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} is unavailable`);
  return value;
}

function nativeChat(vscode, query) {
  return callable(vscode?.commands?.executeCommand, "native chat command").call(
    vscode.commands,
    "workbench.action.chat.open",
    Object.freeze({ mode: "agent", preserveInput: false, query }),
  );
}

export function createResearchLoopHandlers({ vscode, authority, zotero, documentation, ui } = {}) {
  const guard = handler => async (...args) => {
    trusted(vscode);
    return handler(...args);
  };
  return Object.freeze({
    "chatero.research.runAction": guard(async () => {
      const [actionId, object] = await Promise.all([
        callable(ui?.chooseResearchAction, "Research Action picker")(),
        callable(zotero?.getActiveResearchObject, "active research object")(),
      ]);
      if (!actionId || !object) return Object.freeze({ kind: "cancelled" });
      return nativeChat(vscode, buildResearchActionPrompt({ actionId, object, workspaceAuthority: authority }));
    }),

    "chatero.research.chatWithSelection": guard(async () => {
      const papers = await callable(zotero?.getSelectionSnapshot, "Zotero selection snapshot")();
      const manifest = buildMultiPaperContextManifest({ authority, papers });
      const contextId = await callable(vscode?.commands?.executeCommand, "native chat command").call(
        vscode.commands,
        "chatero.chat.attachTextContext",
        Object.freeze({ label: `${manifest.papers.length} Zotero papers`, text: JSON.stringify(manifest) }),
      );
      try {
        return await nativeChat(vscode, "Compare the selected papers using their attached immutable Zotero context manifest.");
      }
      catch (error) {
        if (typeof contextId === "string") {
          await vscode.commands.executeCommand("chatero.chat.removeTextContext", contextId).catch(() => {});
        }
        throw error;
      }
    }),

    "chatero.research.refreshLiterature": guard(async () => {
      const snapshot = await callable(zotero?.exportBibliographySnapshot, "Zotero bibliography export")();
      return callable(documentation?.stageLiteratureRefresh, "Literature review staging")(snapshot);
    }),

    "chatero.research.noteToDraft": guard(async () => {
      const [note, destination] = await Promise.all([
        callable(zotero?.getActiveNoteSnapshot, "active Zotero Note")(),
        callable(ui?.chooseDocumentationDestination, "Documentation destination picker")(),
      ]);
      if (!note || !destination) return Object.freeze({ kind: "cancelled" });
      return callable(documentation?.stageProposal, "Research proposal staging")(
        buildNoteDraftProposal({ note, destination }),
      );
    }),

    "chatero.research.openTopicGraph": guard(async () =>
      callable(documentation?.openTopicGraph, "Documentation topic graph")()),

    "chatero.research.openMainSite": guard(async () =>
      callable(documentation?.openMainSite, "reviewed Main Site")()),
  });
}
