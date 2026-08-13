import { RESEARCH_ACTIONS } from "./research-loop-model.mjs";

export const RESEARCH_LOOP_COMMANDS = Object.freeze([
  Object.freeze({ id: "chatero.research.runAction", title: "Run Research Action" }),
  Object.freeze({ id: "chatero.research.chatWithSelection", title: "Chat with Selected Papers" }),
  Object.freeze({ id: "chatero.research.refreshLiterature", title: "Refresh Literature Bibliography" }),
  Object.freeze({ id: "chatero.research.noteToDraft", title: "Import Zotero Note to Documentation" }),
  Object.freeze({ id: "chatero.research.openTopicGraph", title: "Open Documentation Topic Graph" }),
  Object.freeze({ id: "chatero.research.openMainSite", title: "Open Reviewed Main Site" }),
]);

export function registerResearchLoopCommands({ vscode, handlers } = {}) {
  if (typeof vscode?.commands?.registerCommand !== "function" || !handlers
      || RESEARCH_LOOP_COMMANDS.some(command => typeof handlers[command.id] !== "function")) {
    throw new TypeError("Research Loop command dependencies are invalid");
  }
  return Object.freeze(RESEARCH_LOOP_COMMANDS.map(command =>
    vscode.commands.registerCommand(command.id, handlers[command.id])));
}

export function researchActionChoices() {
  return Object.freeze(RESEARCH_ACTIONS.map(action => Object.freeze({
    description: `$${action.skill}`,
    label: action.label,
    value: action.id,
  })));
}
