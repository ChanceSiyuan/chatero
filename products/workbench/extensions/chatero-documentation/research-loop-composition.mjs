import { documentationPagePath } from "./documentation-path.mjs";

const ZOTERO_COMMANDS = Object.freeze({
  exportBibliographySnapshot: "chatero.zotero.research.bibliography",
  getActiveNoteSnapshot: "chatero.zotero.research.activeNote",
  getActiveResearchObject: "chatero.zotero.research.activeObject",
  getSelectionSnapshot: "chatero.zotero.research.selection",
});

export function workspaceAuthority(uri) {
  if (uri?.scheme === "file" && uri.authority === "") return "local";
  if (uri?.scheme === "vscode-remote" && typeof uri.authority === "string"
      && uri.authority.startsWith("chatero-remote+")) return uri.authority;
  throw new TypeError("workspace authority is unsupported");
}

export function createCommandBackedZoteroResearchApi(commands) {
  if (typeof commands?.executeCommand !== "function") throw new TypeError("Code-OSS command service is unavailable");
  return Object.freeze(Object.fromEntries(Object.entries(ZOTERO_COMMANDS).map(([method, command]) => [
    method,
    () => commands.executeCommand(command),
  ])));
}

export function createResearchProposalStager({ capabilities, randomUUID, scope, transactions } = {}) {
  if (typeof capabilities?.issueAgentProposalGrant !== "function" || typeof randomUUID !== "function"
      || typeof transactions?.stage !== "function" || !scope) {
    throw new TypeError("Research proposal staging dependencies are invalid");
  }
  return async proposal => {
    if (proposal?.kind === "literature-refresh-plan") {
      throw new TypeError("Literature changes require a dedicated Literature review boundary");
    }
    if (proposal?.kind !== "draft-proposal" || proposal.reviewRequired !== true
        || proposal.operation?.kind !== "create") throw new TypeError("Research proposal is invalid");
    const path = documentationPagePath(proposal.operation.path);
    const proposedText = proposal.operation.proposedText;
    if (typeof proposedText !== "string" || Buffer.byteLength(proposedText, "utf8") > 8 * 1024 * 1024) {
      throw new TypeError("Research proposal text is invalid");
    }
    const grant = capabilities.issueAgentProposalGrant(scope, {
      expiresInMs: 60_000,
      maximumOperationCount: 1,
      maximumProposedBytes: Buffer.byteLength(proposedText, "utf8"),
      operationKinds: ["create"],
      paths: [path],
    });
    return transactions.stage(grant, {
      idempotencyKey: `research-note-${randomUUID()}`,
      operations: [{ kind: "create", path: proposal.operation.path, proposedText }],
    });
  };
}
