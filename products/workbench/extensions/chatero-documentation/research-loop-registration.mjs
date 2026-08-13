import { createLiteratureReview } from "./literature-review.mjs";
import { registerResearchLoopCommands, researchActionChoices } from "./research-loop-commands.mjs";
import {
  createCommandBackedZoteroResearchApi,
  createResearchProposalStager,
  workspaceAuthority,
} from "./research-loop-composition.mjs";
import { createResearchLoopHandlers } from "./research-loop-controller.mjs";
import { createReviewedResearchSurfaces } from "./reviewed-research-surfaces.mjs";

export async function registerResearchLoop({ services, vscode } = {}) {
  if (!services?.workspaceFolderUri || !vscode?.window) throw new TypeError("Research Loop services are unavailable");
  const surfaces = createReviewedResearchSurfaces({ services, vscode });
  const stageProposal = createResearchProposalStager({
    capabilities: services.capabilities,
    randomUUID: services.randomUUID,
    scope: services.scope,
    transactions: services.transactions,
  });
  const literature = createLiteratureReview({ vscode, workspaceFolderUri: services.workspaceFolderUri });
  const ui = Object.freeze({
    async chooseDocumentationDestination() {
      return vscode.window.showInputBox({
        prompt: "Path relative to documentation/",
        placeHolder: "imports/notes/note.qmd",
        title: "Import Zotero Note to Documentation",
      });
    },
    async chooseResearchAction() {
      const choice = await vscode.window.showQuickPick(researchActionChoices(), {
        placeHolder: "Choose a Research Action for the active Zotero or Documentation object",
        title: "Run Research Action",
      });
      return choice?.value;
    },
  });
  const handlers = createResearchLoopHandlers({
    authority: workspaceAuthority(services.workspaceFolderUri),
    documentation: Object.freeze({
      openMainSite: surfaces.openMainSite,
      openTopicGraph: surfaces.openTopicGraph,
      stageLiteratureRefresh: literature,
      stageProposal: async proposal => {
        const result = await stageProposal(proposal);
        if (result?.kind === "generation-staged" && result.ref) {
          await vscode.commands.executeCommand("chatero.documentation.reviewChangeSet", result.ref);
        }
        return result;
      },
    }),
    ui,
    vscode,
    zotero: createCommandBackedZoteroResearchApi(vscode.commands),
  });
  return registerResearchLoopCommands({ handlers, vscode });
}
