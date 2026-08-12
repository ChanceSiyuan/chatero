import { validateAgentStageInput } from "./documentation-transactions.mjs";

const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const FORBIDDEN_RESULT_KEYS = new Set(["root", "token", "approval", "privatePath", "evidencePath"]);

function assertTrusted(workspace) {
  if (workspace?.isTrusted !== true) throw new Error("Documentation Agent tools require a trusted workspace");
}

function assertNotCancelled(token) {
  if (token?.isCancellationRequested === true) {
    const error = new Error("Documentation Agent tool invocation was cancelled");
    error.name = "CancellationError";
    throw error;
  }
}

function rejectPrivateFields(value, depth = 0) {
  if (depth > 32) throw new TypeError("Agent tool result is too deeply nested");
  if (Array.isArray(value)) {
    value.forEach(member => rejectPrivateFields(member, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, member] of Object.entries(value)) {
    if (FORBIDDEN_RESULT_KEYS.has(key)) throw new TypeError(`Agent tool result contains forbidden field ${key}`);
    rejectPrivateFields(member, depth + 1);
  }
}

export function boundedAgentToolResult({ content, metadata = {} } = {}) {
  if (typeof content !== "string") throw new TypeError("Agent tool result content is invalid");
  const bytes = Buffer.from(content, "utf8");
  const text = bytes.byteLength <= MAX_TOOL_RESULT_BYTES
    ? content
    : `${bytes.subarray(0, MAX_TOOL_RESULT_BYTES - 64).toString("utf8")}\n[bounded result truncated]`;
  rejectPrivateFields(metadata);
  return Object.freeze({
    content: Object.freeze([Object.freeze({ type: "text", value: text })]),
    metadata: Object.freeze(structuredClone(metadata)),
  });
}

function retrievalInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("retrieval input is invalid");
  const allowed = new Set(["query", "maximumResults"]);
  if (Object.keys(value).some(key => !allowed.has(key))
    || typeof value.query !== "string" || value.query.length === 0
    || Buffer.byteLength(value.query, "utf8") > 4096
    || (value.maximumResults !== undefined
      && (!Number.isSafeInteger(value.maximumResults) || value.maximumResults < 1 || value.maximumResults > 50))) {
    throw new TypeError("retrieval input is invalid");
  }
  return Object.freeze({ query: value.query, maximumResults: value.maximumResults ?? 12 });
}

function operationPaths(operation) {
  return operation.kind === "rename" ? [operation.from, operation.to] : [operation.path];
}

function stageSuccessResult(result) {
  if (result?.kind !== "generation-staged") {
    return boundedAgentToolResult({
      content: `Documentation proposal was not staged: ${result?.kind ?? "invalid-result"}.`,
      metadata: { kind: result?.kind ?? "invalid-result" },
    });
  }
  const metadata = {
    changeSetRef: Object.freeze({
      lineageId: result.ref.lineageId,
      generationId: result.ref.generationId,
    }),
    generationDigest: result.generationDigest,
    reviewCommand: "chatero.documentation.reviewChangeSet",
  };
  return boundedAgentToolResult({
    content: `Staged Documentation Change Set ${result.ref.lineageId}/${result.ref.generationId} for human review.`,
    metadata,
  });
}

export function registerDocumentationAgentTools({
  vscode,
  transactions,
  retrieval,
  capabilities,
  scope,
} = {}) {
  if (typeof vscode?.lm?.registerTool !== "function" || !vscode.workspace
    || typeof transactions?.stage !== "function" || typeof retrieval?.retrieve !== "function"
    || typeof capabilities?.issueAgentProposalGrant !== "function" || !scope) {
    throw new TypeError("Documentation Agent tool dependencies are invalid");
  }
  const retrieve = vscode.lm.registerTool("chatero_documentation_retrieve", {
    async invoke(options, token) {
      assertTrusted(vscode.workspace);
      assertNotCancelled(token);
      const input = retrievalInput(options?.input);
      const result = await retrieval.retrieve(input, token);
      assertNotCancelled(token);
      return boundedAgentToolResult({
        content: typeof result?.text === "string" ? result.text : result?.message ?? "Reviewed Documentation retrieval is unavailable.",
        metadata: {
          kind: result?.kind ?? "feature-unavailable",
          ...(typeof result?.state === "string" ? { state: result.state } : {}),
          ...(typeof result?.revision === "string" ? { revision: result.revision } : {}),
        },
      });
    },
  });
  const stage = vscode.lm.registerTool("chatero_documentation_stage", {
    async invoke(options, token) {
      assertTrusted(vscode.workspace);
      assertNotCancelled(token);
      const input = validateAgentStageInput(options?.input);
      if (input.kind === "invalid-proposal") throw new TypeError(input.detail ?? input.code);
      const paths = input.operations.flatMap(operationPaths);
      const operationKinds = [...new Set(input.operations.map(operation => operation.kind))];
      const proposedBytes = input.operations.reduce((total, operation) =>
        total + Buffer.byteLength(operation.proposedText ?? "", "utf8"), 0);
      const grant = capabilities.issueAgentProposalGrant(scope, {
        paths,
        operationKinds,
        maximumOperationCount: input.operations.length,
        maximumProposedBytes: Math.max(1, proposedBytes),
        expiresInMs: 30_000,
      });
      const result = await transactions.stage(grant, options.input);
      assertNotCancelled(token);
      return stageSuccessResult(result);
    },
  });
  return Object.freeze([retrieve, stage]);
}
