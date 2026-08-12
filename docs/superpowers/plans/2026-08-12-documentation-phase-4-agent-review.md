# Documentation Phase 4 Agent Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the fail-closed Agent boundary, immutable multi-file Documentation Change Sets, exact human review and recoverable settlement, reviewed-first retrieval, and a reviewed-only Main Site built through the sandboxed `SafeQuartoRenderer`, with identical local and SSH semantics.

**Architecture:** The workspace-kind `chatero-documentation` extension exposes only typed retrieval and staging tools to Native Codex and sends all private or canonical resource mutations through the Phase 1 authority-local transaction helper. Review, Chat, SCM, diff, gutter, and tab affordances consume one immutable `ReviewSnapshot`. A product-private Code-OSS Working Copy Barrier freezes the complete affected resource set while the Phase 2 `WorkingCopyCoordinator` applies the one owner-authorized `WorkspaceEdit`; its one-shot structural finalizer rebinds, reloads, closes, or tombstones affected working copies before release. Settlement crosses the TextDocument boundary with typed `prepare-settlement` / `ack-settlement-text` continuations, and a human-only `resolve-settlement` continuation resolves preserved conflicts. This phase upgrades Phase 1 state/new-page/resource mutations to the same private-journal/active-marker/early-recovery state machine. A fourth digest-pinned Code-OSS patch replaces legacy sandbox selections with Chatero-owned named permission profiles, verifies resolved App Server configuration and protected filesystem identities before every lifecycle request, and applies kernel-enforced object denies to Documentation authority roots, Codex state, and the trusted runtime even when the UI says Full Access.

**Tech Stack:** Code-OSS 1.132.0 at `df53daabb18cd157bdb08c7f01c34df936cf12f4`, Native Codex/App Server 0.142.0, Electron 42.7.1, Node 24.18.0, VS Code workspace-extension/SCM/diff/language-model-tool APIs, ESM domain modules, CommonJS activation, SHA-256, Phase 1 authority protocol, Phase 2 `WorkingCopyCoordinator`, Phase 3 `SafeQuartoRenderer`, Node test runner, Code-OSS Mocha tests, and installed local/SSH integration tests.

## Global Constraints

- Execute only after Phases 1–3 and their checkpoints pass; keep `chatero.documentation.enabled` defaulted to `false` throughout Phase 4.
- `chatero-documentation` remains `extensionKind: ["workspace"]`; the standard Text Editor remains available and Live Preview remains optional.
- Extension, renderer, and webview modules never import Node `fs` for workspace bytes. Canonical/private resource mutations go only through `WorkspaceTransactionAdapter.snapshot`, `.transact`, and `.recover`; human text changes go only through `WorkingCopyCoordinator`, the product-private Working Copy Barrier lease, and one exact `WorkspaceEdit`.
- Generic Agent file and shell access must deny both read and write below `documentation/**`, `.chatero/**`, `work/qlab-zotero/documentation-changes/**`, `work/qlab-zotero/documentation-migration/**`, workspace `.codex/**`, the actual absolute `CODEX_HOME`, and every resolved trusted-runtime root for local and SSH sessions, new threads, every turn, fork, resume, read-only, default, auto-review, and Full Access.
- Reserved-root protection is enforced by resolved Codex named permission profiles, OS sandbox denies, runtime-tree verification, and approval filtering, never by prompt text, AGENTS instructions, UI labels, legacy `workspaceWrite.writableRoots`, or an unverified requested profile.
- Permission preflight inventories every regular file below reserved roots, the trusted runtime, and the real `CODEX_HOME` and requires `nlink === 1`; any pre-existing hard-link alias fails closed. It binds canonical directory/root `dev + ino` identities and revalidates them before every start/turn/fork/resume. The pinned OS sandbox must deny the underlying protected filesystem objects after an in-session hard-link/rename attempt or ancestor relocation, not merely their old lexical names. If an installed local/SSH platform/profile probe can access a relocated or aliased object, that Native Codex profile is unavailable on that platform with no weaker fallback.
- The Agent receives only typed `retrieve` and `stage` entry points. It never receives a canonical write, state, review-token, settle, recovery, migration, raw adapter, root-path, or arbitrary process capability.
- First-release Agent operations are QMD create/edit/rename/delete only. Agent-created or Agent-edited binary assets are rejected before persistence.
- Change Set generations, base blobs, proposed blobs, manifests, review inputs, journals, evidence, and receipts are immutable and private. No capability or approval token is serialized.
- Settlement requires a fresh content-bound one-use human approval and a complete decision for every leaf in the exact `ReviewSnapshot`. Invalid, incomplete, stale, or conflicting input causes zero canonical changes.
- Every settlement first acquires `vscode.workspace.acquireDocumentationWorkingCopyBarrier(...)` over the complete affected resource set. The barrier blocks standard-editor typing, manual save, autosave, bulk edits, file operations, and newly opened matching editors; only its owner lease may apply the exact bound `WorkspaceEdit` after `revalidate()`.
- Every canonical mutation—including Phase 1 `setDocumentState`, `newPage`, human resource operations, and Phase 4 settlement—first publishes and fsyncs a complete immutable `private-staged` journal plus intended evidence while canonical resources and TextDocuments remain unchanged. `.chatero/documentation-operation-active.v1.json` is then exclusively created as the content-free commit record bound to `journalDigest`, fsynced with its parent, followed by a durable `marker-committed` record and `canonicalMutationStarted:true` before the first canonical/resource mutation or owner edit. Only a marker-free valid `private-staged` record with both flags false and intact before proofs may retry exactly or be abandoned without a broad gate. A present valid marker gates its affected set; a marker with missing/mismatched journal, or any durable `marker-committed`/mutation-started/later record missing its marker, is tamper and installs a Documentation-wide gate. Startup/reconnect performs the matching typed inspection before editor restoration; extension failure or lease disposal cannot release it.
- An unknown settlement revision preserves immutable before/current/intended evidence and yields a human-only opaque recovery token. `resolveRecovery` requires a fresh one-use `RecoveryApproval` and a complete per-path `keep-current`/`restore-before`/`apply-intended` map; the typed `resolve-settlement` continuation rechecks current revisions under the complete barrier, returns a freshly bound conflict with zero resolution writes on any race, and releases the gate only after resource finalization and a terminal receipt.
- Accepted create/edit/rename targets become `working`; deleted paths lose state entries. Human edits keep their existing path-scoped state.
- Review and publication never execute QMD. Main Site includes only reviewed pages and safe raster assets reachable from those pages, passes the same passive-input policy as Phase 3, and reuses the exact `SafeQuartoRenderer`; it never directly spawns Quarto. Failed or sandbox-unavailable builds retain the last-good site.
- Local and SSH use the same extension code, helper protocol, transaction conformance suite, review scenarios, and installed smoke matrix. An SSH transaction is one complete authority-side request, never renderer-driven per-file writes.
- Documentation failures must not prevent standard Code-OSS editing, unrelated workspaces, or Zotero Core startup.
- Use only generated temporary workspaces, user-data directories, and profiles in tests. Never read, write, or stage personal Documentation, Zotero data, credentials, chat history, or research output.

---

## Phase File Map

### Create

- `products/workbench/patches/code-oss/0004-chatero-documentation-agent-authority.patch`
- `products/workbench/extensions/chatero-documentation/change-set-model.mjs`
- `products/workbench/extensions/chatero-documentation/stable-hunks.mjs`
- `products/workbench/extensions/chatero-documentation/change-set-store.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-agent-tools.mjs`
- `products/workbench/extensions/chatero-documentation/review-decisions.mjs`
- `products/workbench/extensions/chatero-documentation/three-way-reconcile.mjs`
- `products/workbench/extensions/chatero-documentation/review-snapshot.mjs`
- `products/workbench/extensions/chatero-documentation/settlement-planner.mjs`
- `products/workbench/extensions/chatero-documentation/settlement-executor.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-review.cjs`
- `products/workbench/extensions/chatero-documentation/documentation-review-content.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-retrieval.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-site.mjs`
- `products/workbench/tests/documentation-agent-authority.test.mjs`
- `products/workbench/tests/documentation-change-set.test.mjs`
- `products/workbench/tests/documentation-review.test.mjs`
- `products/workbench/tests/documentation-settlement.test.mjs`
- `products/workbench/tests/documentation-review-surfaces.test.mjs`
- `products/workbench/tests/documentation-retrieval.test.mjs`
- `products/workbench/tests/documentation-site.test.mjs`
- `products/workbench/integration/documentation/agent-review.test.mjs`
- `products/workbench/integration/documentation/agent-authority-smoke.test.mjs`
- `products/workbench/integration/documentation/main-site.test.mjs`

### Modify

- `products/workbench/patches/code-oss/series.json`
- `products/workbench/extensions/chatero-documentation/package.json`
- `products/workbench/extensions/chatero-documentation/extension.cjs`
- `products/workbench/extensions/chatero-documentation/documentation-transactions.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-capabilities.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-operations.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-workspace.mjs`
- `products/workbench/extensions/chatero-documentation/quarto-preview-manager.mjs`
- `products/workbench/documentation-authority/protocol.mjs`
- `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`
- `products/workbench/first-party-extensions.json`
- `products/workbench/tests/patch-series.test.mjs`
- `products/workbench/tests/remote-agent-runtime.test.mjs`
- `products/workbench/tests/remote-agent-release.test.mjs`
- `products/workbench/tests/first-party-extensions.test.mjs`
- `products/workbench/tests/documentation-authority.test.mjs`
- `products/workbench/tests/documentation-workspace.test.mjs`
- `products/workbench/tests/documentation-extension.test.mjs`
- `products/workbench/integration/documentation/driver/run.cjs`
- `products/workbench/integration/documentation/fixtures.mjs`
- `docs/chatero/parity-checklist.md`
- this plan

## Normative Phase 4 Types

These TypeScript shapes are normative JSDoc contracts for the JavaScript implementation. Identifiers are exact; later tasks must not rename or widen them.

```ts
type DocumentationStateName = "working" | "reviewed";
type StableChangeId = string & {readonly __stableChangeId: unique symbol};
type ChangeSetGenerationId = string & {readonly __changeSetGenerationId: unique symbol};
const CHANGE_SET_GENERATION_ID_RE = /^[0-9a-f]{16}$/;
type ChangeSetRef = Readonly<{lineageId:string; generationId:ChangeSetGenerationId}>;
type SavedRevision = `sha256:${string}`;
type OpenRevision = `text-document:${number}:sha256:${string}`;
type BoundRevision = SavedRevision | OpenRevision;

type CreateOperation = Readonly<{
  kind:"create"; operationId:string; path:DocumentationPath;
  targetAbsent:true; proposedText:string;
}>;
type EditOperation = Readonly<{
  kind:"edit"; operationId:string; path:DocumentationPath;
  baseRevision:BoundRevision; baseText:string; proposedText:string;
}>;
type RenameOperation = Readonly<{
  kind:"rename"; operationId:string; from:DocumentationPath;
  to:DocumentationPath; baseRevision:BoundRevision; baseText:string;
  targetAbsent:true; proposedText:string;
}>;
type DeleteOperation = Readonly<{
  kind:"delete"; operationId:string; path:DocumentationPath;
  baseRevision:BoundRevision; baseText:string;
}>;
type ChangeSetOperation = CreateOperation | EditOperation | RenameOperation | DeleteOperation;

type StableHunk = Readonly<{
  id:StableChangeId; operationId:string; beforeStart:number; beforeEnd:number;
  afterStart:number; afterEnd:number; beforeText:string; afterText:string;
  contextBefore:string; contextAfter:string;
  dependsOn:readonly StableChangeId[];
}>;

type ChangeSetGeneration = Readonly<{
  schemaVersion:1; ref:ChangeSetRef; parentRef?:ChangeSetRef;
  repositoryIdentity:string; authorityIdentity:string; grantDigest:string;
  idempotencyKey:string; createdAt:string; stateGeneration:string;
  operations:readonly ChangeSetOperation[]; hunks:readonly StableHunk[];
  generationDigest:string; status:"open"|"settling"|"settled"|"rejected";
}>;

type ReviewLeaf = Readonly<{
  id:StableChangeId; kind:"hunk"|"create"|"rename"|"delete";
  operationId:string; path:DocumentationPath;
  dependsOn:readonly StableChangeId[];
}>;
type ReviewSnapshot = Readonly<{
  ref:ChangeSetRef; generationDigest:string; stateGeneration:string;
  documents:readonly Readonly<{
    path:DocumentationPath; baseText:string; currentText:string;
    proposedText:string; currentRevision:BoundRevision; dirty:boolean;
  }>[];
  leaves:readonly ReviewLeaf[]; reviewToken:string;
}>;
type ReviewDecision = "accept"|"reject"|"defer";

type SettlementResult =
  | Readonly<{kind:"committed"; receipt:string; deferredRef?:ChangeSetRef}>
  | Readonly<{kind:"stale-review"; snapshot:ReviewSnapshot}>
  | Readonly<{kind:"incomplete-decision-set"; missing:readonly StableChangeId[]}>
  | Readonly<{kind:"invalid-decision-set"; violations:readonly string[]}>
  | Readonly<{kind:"conflict"; evidenceRef:string}>
  | Readonly<{kind:"dirty-working-copy"; paths:readonly DocumentationPath[]}>
  | BarrierConflict
  | Readonly<{kind:"recovering"; operationId:string}>
  | Readonly<{kind:"recovery-conflict"; evidenceRef:string; recoveryToken:string}>
  | Readonly<{kind:"idempotency-conflict"; idempotencyKey:string}>;

type DocumentationWorkingCopyBarrierResource = Readonly<{
  uri:Uri; expectedVersion?:number; expectedDigest?:string;
  expectedDirectoryGeneration?:string; intendedDigest?:string;
  requireClean:boolean; targetAbsent?:true;
}>;
type DocumentationResourceOutcome = Readonly<
  | {kind:"create";uri:Uri;intendedDigest:string}
  | {kind:"rename";from:Uri;to:Uri;intendedDigest:string}
  | {kind:"delete";uri:Uri;expectedDigest:string}
>;
interface DocumentationWorkingCopyBarrierLease {
  readonly operationId:string;
  revalidate():Promise<Readonly<{kind:"valid"}>|DirtyWorkingCopy|BarrierConflict>;
  applyWorkspaceEdit(edit:WorkspaceEdit):Promise<boolean>;
  finalizeResourceOutcomes(outcomes:readonly DocumentationResourceOutcome[]):Promise<
    Readonly<{kind:"finalized"}>|DirtyWorkingCopy|BarrierConflict>;
  dispose():void;
}
declare function acquireDocumentationWorkingCopyBarrier(input:Readonly<{
  operationId:string; resources:readonly DocumentationWorkingCopyBarrierResource[];
  reason:"human-transaction"|"settlement"|"migration"|"recovery";
}>):Promise<DocumentationWorkingCopyBarrierLease|DirtyWorkingCopy|BarrierConflict>;

type SettlementRecoveryDecision = "keep-current"|"restore-before"|"apply-intended";
type RecoveryResolutionResult =
  | Readonly<{kind:"recovery-resolved";receipt:string}>
  | Readonly<{kind:"stale-recovery"}>
  | Readonly<{kind:"recovery-conflict";evidenceRef:string;recoveryToken:string}>
  | DirtyWorkingCopy | BarrierConflict
  | Readonly<{kind:"idempotency-conflict";idempotencyKey:string}>;

type RetrievalRequest = Readonly<{
  query:string; currentPage?:DocumentationPath;
  explicitPaths?:readonly DocumentationPath[]; includeWorking?:boolean;
  limit:number;
}>;
type RetrievedPassage = Readonly<{
  path:DocumentationPath; state:DocumentationStateName; text:string;
  score:number; revision:BoundRevision; dirty:boolean;
}>;

interface DocumentationTransactionsPhase4 {
  state(scope:OpaqueWorkspaceScope):Promise<DocumentationState>;
  stage(grant:AgentProposalGrant,input:{
    idempotencyKey:string; parentRef?:ChangeSetRef;
    expectedGeneration?:ChangeSetGenerationId;
    operations:readonly ChangeSetOperation[];
  }):Promise<ChangeSetGeneration|StaleGeneration|InvalidProposal|IdempotencyConflict>;
  review(ref:ChangeSetRef):Promise<ReviewSnapshot>;
  settle(approval:HumanApproval,input:{
    reviewToken:string; decisions:ReadonlyMap<StableChangeId,ReviewDecision>;
    idempotencyKey:string;
  }):Promise<SettlementResult>;
  setDocumentState(approval:HumanApproval,input:SetDocumentStateInput):Promise<StateResult>;
  resolveRecovery(approval:RecoveryApproval,input:{
    recoveryToken:string;
    resolutions:ReadonlyMap<DocumentationPath,SettlementRecoveryDecision>;
    idempotencyKey:string;
  }):Promise<RecoveryResolutionResult>;
  planMigration(scope:OpaqueWorkspaceScope):Promise<MigrationPlan>;
}
```

The human `newPage` command and any human resource command remain narrow
module-private transaction handlers beside this facade. Phase 4 upgrades those
handlers and `setDocumentState` to the same journal, marker, barrier, resource
finalization, and recovery dispatcher as settlement. None is registered as an
Agent tool; Native Codex still receives only typed retrieval and staging.

The persistent layout is fixed for Phase 5 compatibility as
`work/qlab-zotero/documentation-changes/<lineageId>/<generationId>/manifest.v1.json`
with `blobs/<operationId>.base` and `blobs/<operationId>.proposed`. The manifest
binds every blob path and SHA-256; the normative in-memory operation types above
show `baseText`/`proposedText` so pure tests can prove byte behavior. Persistent
JSON never stores an absolute path, capability, approval, review token, or
dirty-buffer text outside those digest-bound private blobs.

## Task 1: Make Native Codex and Documentation Working Copies Fail Closed

**Files:**

- Create: `products/workbench/patches/code-oss/0004-chatero-documentation-agent-authority.patch`
- Create: `products/workbench/tests/documentation-agent-authority.test.mjs`
- Modify: `products/workbench/patches/code-oss/series.json`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-transactions.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-operations.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/extension.cjs`
- Modify: `products/workbench/documentation-authority/protocol.mjs`
- Modify: `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`
- Modify: `products/workbench/tests/patch-series.test.mjs`
- Modify: `products/workbench/tests/documentation-state.test.mjs`
- Modify: `products/workbench/tests/documentation-workspace.test.mjs`
- Modify: `products/workbench/tests/documentation-extension.test.mjs`
- Modify: `products/workbench/tests/documentation-remote-transaction.test.mjs`
- Modify: `products/workbench/tests/remote-agent-runtime.test.mjs`
- Modify: `products/workbench/tests/remote-agent-release.test.mjs`

**Interfaces:**

- Consumes: the exact bundled Codex 0.142.0 binary, generated `ThreadStartParams.permissions`, `TurnStartParams.permissions`, `ThreadForkParams.permissions`, `ThreadResumeParams.permissions`, App Server `config/read({includeLayers:true,cwd})`, `configRequirements/read`, `permissionProfile/list`, lifecycle `activePermissionProfile`, canonical runtime workspace roots and their stable filesystem identities, resolved trusted-runtime roots, actual absolute `CODEX_HOME`, the Phase 1 signed Remote Agent release, and Phase 1 state/new-page/resource transaction handlers.
- Produces: Code-OSS private `ChateroCodexPermissionProfileId = "chatero_read_only"|"chatero_workspace"|"chatero_full_access"`; `chateroCodexPermissionProfile(mode:SandboxMode):ChateroCodexPermissionProfileId`; `chateroCodexPermissionOverrides({runtimeWorkspaceRoots,trustedRuntimeRoots,codexHome}):readonly string[]`; `chateroCodexPreflight(...)`; protected-tree `{canonicalPath,dev,ino}`/`nlink` proofs; `vscode.workspace.acquireDocumentationWorkingCopyBarrier(...)`; a lease with exact methods `revalidate()`, `applyWorkspaceEdit(edit)`, `finalizeResourceOutcomes(outcomes)`, and `dispose()`; `acquireAuthorityMutationLease(operationId)` inside the helper; a closed `inspect-documentation-operation` dispatcher; and the startup/reconnect read-only gate keyed by the active marker plus durable operation heads.

- [ ] **Step 1: Write the failing patch contract and upstream test specification.** Create `documentation-agent-authority.test.mjs` with these initial assertions, then require the patch to contain upstream tests for start, turn, fork, resume, and approval filtering:

```js
const RESERVED = [
  "documentation",
  ".chatero",
  "work/qlab-zotero/documentation-changes",
  "work/qlab-zotero/documentation-migration",
  ".codex",
];
const patch = await readFile(patchPath, "utf8");
for (const path of RESERVED) assert.match(patch, new RegExp(path.replaceAll("/", "\\\\/")));
for (const profile of ["chatero_read_only", "chatero_workspace", "chatero_full_access"]) {
  assert.match(patch, new RegExp(profile));
}
assert.match(patch, /thread\/start[\s\S]*permissions/);
assert.match(patch, /thread\/fork[\s\S]*permissions/);
assert.match(patch, /thread\/resume[\s\S]*permissions/);
assert.match(patch, /turn\/start[\s\S]*permissions/);
assert.match(patch, /acquireDocumentationWorkingCopyBarrier/);
assert.match(patch, /documentation-operation-active\.v1\.json/);
assert.doesNotMatch(patch, /^\+.*developerInstructions.*reserved roots/m);
```

- [ ] Resolve the Codex executable only through the pinned release manifest and run that exact binary as `codex app-server generate-json-schema --experimental --out <generated-temp-dir>`. Parse the generated schema and assert `permissions` exists in all four exact request shapes: `ThreadStartParams`, `TurnStartParams`, `ThreadForkParams`, and `ThreadResumeParams`. A missing field or a binary other than 0.142.0 is RED before patching Code-OSS; do not infer protocol support from handwritten types.
- [ ] Add a matrix assertion for modes `read-only`, `workspace-write`, and `danger-full-access`, authorities `local` and `ssh`, and lifecycle entries `start`, `turn`, `fork`, `resume`. Every row must select a Chatero profile; none may send `sandbox` or `sandboxPolicy` with `permissions`.
- [ ] Add hostile configuration fixtures for user/global/project `sandbox_mode = "danger-full-access"`, legacy `sandbox_workspace_write`, and a nested reopen such as `permissions.chatero_workspace.filesystem."documentation/sub" = "write"`. They must fail before the first lifecycle request, never fall back to a builtin or legacy sandbox. Production accepts no user `binaryArgs` at all; fixtures for `--sandbox`, arbitrary `-c/--config`, `--listen`, `--enable`, `--disable`, and disguised `--stdio` must never enter the spawned argv. A managed requirements file that does not allow all three exact Chatero profile ids/default is also safely unavailable and is never modified by Chatero. Mutating the external `CODEX_HOME` config after start but before a later turn/fork/resume must change the config epoch and fail that request closed.
- [ ] Add real pinned-sandbox identity attacks for all three profiles and both local/SSH authorities. Before start, create hard-link aliases to regular files in every reserved root, trusted-runtime tree, and real `CODEX_HOME`; each must make that profile unavailable because protected regular files require `nlink === 1`. During a live turn attempt link/rename aliases, rename a workspace ancestor and access the same Documentation objects through the new path, and relocate runtime/`CODEX_HOME` ancestors. The kernel policy must continue denying the underlying objects during that turn, while the next lifecycle preflight must also reject changed canonical path or root/directory `dev + ino`. A successful probe disables that profile on that platform and never falls back to lexical-only or weaker permissions.
- [ ] Add Working Copy Barrier tests for the complete affected resource set: install the barrier before enumerating loaded working copies; block standard-editor typing, manual save, autosave, ordinary `workspace.applyEdit`, rename/create/delete/copy, and a matching document opened after acquisition; permit only the lease owner's one exact `applyWorkspaceEdit(edit)`; and make `revalidate()` reject version/digest/`expectedDirectoryGeneration`/cleanliness/target-absence drift before any authority mutation. The owner edit must cover only and all declared edited resources, derive from each current `expectedVersion`, and produce each optional `intendedDigest`; mismatch returns `BarrierConflict` with zero partial edits.
- [ ] Test the lease's separate one-shot `finalizeResourceOutcomes(outcomes)`: only the complete journal-bound create/rename/delete outcome set is accepted. A clean open rename source is rebound to the exact target/digest, a create target reloads exact intended bytes, and a delete source closes or receives a persistent tombstone so later Save/autosave cannot recreate its old URI. Missing/extra/duplicate outcomes, URI/digest mismatch, dirty drift, a second call, or an old tab trying Save retains a recovery-owned gate and yields zero partial finalization.
- [ ] Add startup/reconnect tests for every canonical operation kind: Phase 1 `setDocumentState`, `newPage`, human resource mutation, and settlement. A marker whose `journalDigest` proves an already fsynced immutable staging journal restores the complete affected barrier before editor restore and releases it only after the closed typed inspector plus terminal receipt. A marker-free record may retry/abandon without a broad gate only when its last valid phase is exactly `private-staged`, `markerCommitted:false`, `canonicalMutationStarted:false`, and all before proofs remain intact. A present marker always gates; a marker with absent/unreadable/mismatched journal, or a marker-free record that has durably reached `marker-committed`, `canonicalMutationStarted:true`, or any later phase, is tamper and installs the Documentation-wide gate with zero recovery mutation. Merely finding no marker is therefore not proof that ordinary editing is safe.
- [ ] Extend Phase 1 state/new-page/resource tests so each human operation acquires the complete Working Copy Barrier when it affects a TextDocument/resource plus the helper's exclusive authority mutation lease, writes/fsyncs `private-staged`, then marker, `marker-committed`, and `canonicalMutationStarted:true` before its first canonical byte. Crash at every journal/marker/mutation boundary and prove the same early local/SSH dispatcher recovers it. Agent tool registration must still omit state, new-page, resource, settle, and recovery methods.
- [ ] Add release assertions that both signed Linux tuples contain the patched Agent Host output, Working Copy Barrier implementation, and the exact Codex 0.142.0 binary used by the schema and sandbox smoke; a missing patch/output is a release failure, not a local fallback.
- [ ] **Step 2: Run focused tests and verify red.**

Run: `node --test products/workbench/tests/documentation-agent-authority.test.mjs products/workbench/tests/patch-series.test.mjs products/workbench/tests/remote-agent-runtime.test.mjs`

Expected: FAIL because patch `0004-chatero-documentation-agent-authority.patch` and its series entry do not exist.

- [ ] **Step 3: Add one fail-closed permission helper and use it on all lifecycle paths.** The patch creates `src/vs/platform/agentHost/node/codex/chateroCodexPermissions.ts` with this exact policy vocabulary:

```ts
export const CHATERO_RESERVED_WORKSPACE_SUBPATHS = Object.freeze([
	'documentation',
	'.chatero',
	'work/qlab-zotero/documentation-changes',
	'work/qlab-zotero/documentation-migration',
	'.codex',
]);
export type ChateroCodexPermissionProfileId =
	| 'chatero_read_only' | 'chatero_workspace' | 'chatero_full_access';

export function chateroCodexPermissionProfile(mode: SandboxMode): ChateroCodexPermissionProfileId {
	switch (mode) {
		case 'read-only': return 'chatero_read_only';
		case 'workspace-write': return 'chatero_workspace';
		case 'danger-full-access': return 'chatero_full_access';
		default: assertNever(mode);
	}
}
```

- [ ] `chateroCodexPermissionOverrides({runtimeWorkspaceRoots,trustedRuntimeRoots,codexHome})` emits fixed session `-c` definitions for three profiles. `chatero_read_only` extends `:read-only`; `chatero_workspace` extends `:workspace`; `chatero_full_access` must not extend `:danger-full-access` and instead sets `":root" = "write"` plus network. Every profile sets more-specific read/write `deny` rules for each canonical workspace `documentation`, `.chatero`, `work/qlab-zotero/documentation-changes`, `work/qlab-zotero/documentation-migration`, and `.codex` path, the canonical absolute `CODEX_HOME`, and every trusted-runtime root: the resolved Code-OSS/Remote Agent installation, fixed authority-helper/extension tree, and bundled Codex executable tree. The actual `CODEX_HOME` is available only to the trusted Codex parent, must be canonical, owner-private, and free of symlink escape, and must not equal or descend from any workspace, reserved, or canonical Documentation root; otherwise the provider fails before the first turn. Sandboxed commands always receive a deny for that absolute home. Reject empty, relative, overlapping, symlinked, writable-by-untrusted-user, or malformed roots rather than selecting a builtin profile.
- [ ] Build a protected-object inventory for every reserved, runtime, and `CODEX_HOME` root before defining profiles. Record each root and ancestor's canonical path plus device/inode identity, walk without following links, and require every protected regular file to have `nlink === 1`; any pre-existing hard link, replacement race, cross-device identity change, aliased root, or unverifiable filesystem fails the affected profile closed. Recompute this inventory before every lifecycle request rather than trusting activation-time paths. The platform sandbox adapter must bind denies to the resolved filesystem objects/mounts so renaming a workspace/root ancestor during a turn does not reopen access through its new pathname; path-policy plus post-turn checks alone is insufficient.
- [ ] The production composition root completely ignores `binaryArgs` as an argv source and fails closed if any user/extension `binaryArgs` value is configured; it constructs only the pinned executable, App Server/stdin transport, and complete product session-profile flags. This applies to every argument, not only sandbox arguments, including `-c`, `--config`, `--listen`, `--enable`, `--disable`, and `--stdio`. A developer-only test seam below that composition root may inject argv to prove ordering; it is unreachable in production and appends product session flags last. Never overwrite or synthesize a system managed requirements layer.
- [ ] `chateroCodexPreflight` calls `config/read({includeLayers:true,cwd})` and inspects each `layers[].config` raw JSON value. Reject any legacy `sandbox_mode`/sandbox table whose non-effect under an allowed managed-profile rule cannot be proven, and reject every `permissions.chatero_*` definition/extension outside the exact product `sessionFlags` layer, including a more-specific nested child `write` that would reopen a denied parent. Require that one session layer's three profile tables exactly equal the canonical JSON emitted by `chateroCodexPermissionOverrides`; no other layer may define or extend those names. It also recomputes the complete `nlink` and canonical `dev + ino` protected-object inventory and rejects any root/ancestor relocation or alias before the lifecycle call. Call `configRequirements/read` and require its `allowedPermissionProfiles` (when managed constraints exist) to allow all three exact Chatero ids and its `defaultPermissions` to be an allowed Chatero id. Then use `permissionProfile/list` only for what 0.142.0 exposes: require summaries for all three exact ids with `allowed:true`; do not pretend the summary proves filesystem policy. Omitted builtins must never be selected by a lifecycle request. The system managed requirements layer remains authoritative; if any result is absent, contradictory, or unprovable, mark Native Codex safely unavailable rather than weakening policy.
- [ ] Change `_materialize`, `_turnStartOptions`, `_forkSession`, and `buildCodexResumeParams` to set `permissions: chateroCodexPermissionProfile(sandboxMode)`, preserve `runtimeWorkspaceRoots`, and omit `sandbox`/`sandboxPolicy`. Immediately before every start, turn, fork, and resume request, run full preflight or prove an unchanged config-layer epoch from the same App Server; an external `CODEX_HOME` or managed-requirements change invalidates the epoch. Require every returned `activePermissionProfile` to match both the requested id and its expected base: `chatero_read_only -> :read-only`, `chatero_workspace -> :workspace`, and `chatero_full_access -> no builtin extends`; also bind it to the expected created/fork-parent/resumed thread provenance. Require the same exact id/extends and thread provenance before/after `turn/start`. If any field is absent, changed, builtin-selected, or unconfirmable, do not send/continue the turn. Reconnect always repeats full preflight before resume.
- [ ] Reject `item/permissions/requestApproval` before UI approval whenever a requested filesystem path is equal to, below, or resolves through a symlink into a reserved root. A deny returns the normal rejected permission result and writes a redacted security log; it never reveals private bytes or grants a parent path that contains a reserved descendant.
- [ ] Before every authority-helper spawn, revalidate the signed complete-tree manifest/digest for the helper, its extension runtime, the installed Agent Host, and bundled Codex, or bind execution to an already verified read-only tree handle. The helper must never spawn detached, request setuid/capability elevation, change namespaces, replace its executable, or otherwise escape the inherited Codex sandbox. A same-session attempt to tamper with helper/runtime bytes followed by a typed tool must be denied by the OS or fail the digest recheck closed.
- [ ] Add `src/vs/platform/agentHost/test/node/codex/chateroCodexPermissions.test.ts` in the patch. Test generated 0.142.0 schema fields, mode mapping, production rejection of every non-empty `binaryArgs` form, developer-injection-only final session-flag order below the composition root, exact product profile definitions in raw `layers[].config`, hostile legacy and nested-reopen configurations, `configRequirements/read` allowlist/default refusal, `permissionProfile/list` id/allowed summaries only, lifecycle active-profile id/extends and parent provenance, config-epoch invalidation between lifecycle calls, malformed roots, trusted-runtime/CODEX_HOME denies, non-private/symlinked `CODEX_HOME`, `CODEX_HOME=<workspace>/documentation`, pre-existing hard-link aliases, link/rename attempts during a turn, renamed workspace/runtime/home ancestors, changed root/ancestor `dev + ino`, direct/absolute/traversal/case-fold/symlink approval requests, same-session runtime tampering, and the full lifecycle matrix. Update existing launch-config and Agent tests where their expected request changes from `sandbox*` to `permissions`.
- [ ] In the same patch, expose `vscode.workspace.acquireDocumentationWorkingCopyBarrier({operationId,resources,reason})` only to the product-built `chatero.documentation` extension, with exact return type `Promise<DocumentationWorkingCopyBarrierLease|DirtyWorkingCopy|BarrierConflict>`. Normalize and sort the complete resource set, register the barrier before inspecting existing working copies, force matching editors read-only, suspend autosave, reject normal typing/save/bulk edit/file operations/new opens, and return a lease. Its `revalidate()` has exact return type `Promise<{kind:"valid"}|DirtyWorkingCopy|BarrierConflict>`. Its one-shot `applyWorkspaceEdit(edit):Promise<boolean>` accepts only an edit covering the pre-bound resources, based on current expected versions, whose resulting per-URI digests exactly equal declared `intendedDigest` values; otherwise it resolves `false`, the executor returns `BarrierConflict`, and Code-OSS applies zero partial edits. `revalidate()` checks every expected version/digest/directory generation, `requireClean`, and `targetAbsent`.
- [ ] Implement the lease's independent one-shot `finalizeResourceOutcomes(outcomes)`. It accepts only the exact complete set pre-bound to a helper/journal proof: rebind clean open rename sources to their exact target and intended digest, reload created targets, and close or tombstone deleted sources so their old models can never Save/autosave the URI back into existence. Verify all URI mappings, digests, directory generations, and working-copy states before making any finalization visible; a mismatch or second invocation returns `BarrierConflict` and retains the recovery gate. Tombstones survive `dispose()` until the model closes or a later helper-verified recovery rebinds it. `dispose()` remains idempotent and cannot release a startup recovery gate.
- [ ] Teach workbench startup and remote reconnection to inspect `.chatero/documentation-operation-active.v1.json` and durable operation heads through the workspace file service before editor restoration. The marker contains only schema/version, operation kind/id/digest, `journalDigest`, sorted affected relative paths and expected/intended digests, never source text or authority tokens. A valid marker is accepted only after the referenced immutable journal/evidence are hash-verified; install a recovery-owned barrier immediately and dispatch the exact kind through `recover({kind:"inspect-documentation-operation",operationKind})` to `inspect-human-resource`, `inspect-settlement`, or later migration inspection. A marker-free `private-staged` head with both flags false is inert after before-proof validation; a marker-free post-marker/mutation-started/later head or a present marker with missing/mismatched journal is tamper and keeps a broad Documentation gate with zero mutation. The extension must present a bound terminal/recovery result before Code-OSS releases any gate; invalid operations never block Zotero Core or unrelated resources.
- [ ] Add the patch last in `series.json` with its exact SHA-256; update canonical-series tests to require `0004` last and match the digest.
- [ ] **Step 4: Run Node contracts, bootstrap, and pinned upstream tests.**

Run: `node --test products/workbench/tests/documentation-agent-authority.test.mjs products/workbench/tests/patch-series.test.mjs products/workbench/tests/remote-agent-runtime.test.mjs products/workbench/tests/remote-agent-release.test.mjs`

Expected: PASS with `0004` digest-pinned last and both Remote Agent tuples requiring the patched output.

Run: `npm run workbench:bootstrap && npm --prefix vendor/code-oss run test-node -- --grep "ChateroCodexPermissions|CodexLaunchConfig|ChateroDocumentationWorkingCopyBarrier"`

Expected: PASS; generated 0.142.0 schemas expose all four `permissions` fields, hostile layered configuration fails before a turn, all lifecycle responses confirm the exact Chatero profile, runtime roots stay immutable, and the Working Copy Barrier closes every editor/save/file-operation race.

- [ ] **Step 5: Refactor lifecycle and barrier construction through one helper each.** Add `chateroCodexLifecyclePermissions(mode,runtimeWorkspaceRoots)` returning the frozen `{permissions,runtimeWorkspaceRoots}` object and call it from start, turn, fork, and resume. No lifecycle call site constructs a profile id itself. Centralize barrier normalization/authorization in `acquireDocumentationWorkingCopyBarrier`; no save participant or file-operation hook carries its own path logic.
- [ ] **Step 6: Re-run after refactor.**

Run: `npm --prefix vendor/code-oss run test-node -- --grep "ChateroCodexPermissions|CodexLaunchConfig|ChateroDocumentationWorkingCopyBarrier" && node --test products/workbench/tests/documentation-agent-authority.test.mjs`

Expected: PASS with identical verified profile/root values for new, turn, fork, and resume, and one barrier policy shared by editor, save, bulk-edit, file-operation, and startup/reconnect paths.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/patches/code-oss/0004-chatero-documentation-agent-authority.patch products/workbench/patches/code-oss/series.json products/workbench/tests/documentation-agent-authority.test.mjs products/workbench/tests/patch-series.test.mjs products/workbench/tests/remote-agent-runtime.test.mjs products/workbench/tests/remote-agent-release.test.mjs
git commit -m "security(documentation): reserve Agent authority roots"
```

## Task 2: Define Immutable Multi-File Generations and Stable Hunks

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/change-set-model.mjs`
- Create: `products/workbench/extensions/chatero-documentation/stable-hunks.mjs`
- Create: `products/workbench/extensions/chatero-documentation/change-set-store.mjs`
- Create: `products/workbench/tests/documentation-change-set.test.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-capabilities.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-operations.mjs`
- Modify: `products/workbench/documentation-authority/protocol.mjs`
- Modify: `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`
- Modify: `products/workbench/first-party-extensions.json`
- Modify: `products/workbench/tests/documentation-authority.test.mjs`
- Modify: `products/workbench/tests/documentation-workspace.test.mjs`
- Modify: `products/workbench/tests/first-party-extensions.test.mjs`

**Interfaces:**

- Consumes: Phase 1 branded paths, exact snapshots, capability grant bounds, canonical operation digest, helper `transact`; exact dirty `TextDocument` overlays from Phase 2.
- Produces: `changeSetGenerationId(input):ChangeSetGenerationId|InvalidProposal` using exact `/^[0-9a-f]{16}$/`; `validateChangeSetInput(input,grant):ValidatedChangeSetInput`; `deriveStableHunks({operationId,baseText,proposedText,dependsOn?}):readonly StableHunk[]`; `buildChangeSetGeneration(input):{generation:ChangeSetGeneration;outputs:readonly {path:DocumentationPrivatePath;bytes:Uint8Array;sha256:string}[]}|InvalidProposal`; `changeSetGenerationPaths(ref:ChangeSetRef)`; `parseChangeSetGeneration({manifestBytes,readBlob}):Promise<ChangeSetGeneration|InvalidProposal>`; `serializeChangeSetGeneration(generation):Uint8Array`; `createChangeSetStore({adapter,scope}):{stageGeneration,loadGeneration,loadCurrentRef}`.

- [ ] **Step 1: Write failing generation, property, and byte-preservation tests.** Start with an edit staged from dirty version 9 and prove the stored base is the dirty bytes, not disk bytes:

```js
const built = buildChangeSetGeneration({
  lineageId: "cs-a", generationId: "0000000000000001", grantDigest,
  idempotencyKey: "agent-1", createdAt, stateGeneration,
  allocateStableChangeId, operations: [{
    kind: "edit", operationId: "op-a", path: documentationPagePath("topic.qmd"),
    baseRevision: "text-document:9:sha256:" + sha256("dirty\n"),
    baseText: "dirty\n", proposedText: "dirty and proposed\n",
  }],
});
assert.equal(built.kind, undefined);
const { generation } = built;
assert.equal(generation.operations[0].baseText, "dirty\n");
assert.equal(generation.hunks[0].id, deriveStableHunks({
  operationId: "op-a", baseText: "dirty\n", proposedText: "dirty and proposed\n",
})[0].id);
```

- [ ] Cover create/edit/rename/delete, LF/CRLF/final newline, Unicode, repeated lines, line insertions before an unchanged hunk, multiple hunks, exact retries, child generations, stale/missing parent fields, grant byte/count/path/kind limits, binary payloads, target absence, revision mismatch, cycles, case aliases, duplicate/ancestor targets, and symlink escapes. Assert every generation id passes exactly `/^[0-9a-f]{16}$/`; reject uppercase, shorter/longer, signed, prefixed, whitespace, separator, and non-hex forms before path construction.
- [ ] Assert staging makes zero canonical/state writes and creates exactly one immutable path `documentation-changes/<lineage>/<generation>/` containing `manifest.v1.json`, `blobs/<operationId>.base`, and `blobs/<operationId>.proposed`. Reopening an existing generation compares all bound digests and never mutates it.
- [ ] **Step 2: Run focused tests and verify red.**

Run: `node --test products/workbench/tests/documentation-change-set.test.mjs products/workbench/tests/documentation-authority.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `change-set-model.mjs`.

- [ ] **Step 3: Implement deterministic validation, hunks, and persistence.** Use SHA-256 over an unambiguous versioned tuple for leaf identity:

```js
function stableHunkId(hunk) {
  return `hunk-${sha256Utf8([
    "chatero-stable-hunk-v1", hunk.operationId,
    hunk.beforeText, hunk.afterText, hunk.contextBefore, hunk.contextAfter,
  ].map(value => `${value.length}:${value}`).join("|"))}`;
}
```

- [ ] Implement deterministic Myers line diff with delete-before-insert tie breaking, three unchanged context lines, and LF-preserving offsets. Group adjacent changed spans separated by at most three unchanged lines. Hunk IDs must not use array index or current line number; structural leaf IDs use `struct-${sha256(canonical structural operation)}`.
- [ ] Validate all operations as one set before constructing a generation. New lineages omit both parent fields; child requests require both current `parentRef` and `expectedGeneration`. Freeze every returned record/array. Implement these exact cross-phase exports in `change-set-model.mjs`:

```ts
export function buildChangeSetGeneration({
  lineageId, generationId, parentRef, grantDigest, idempotencyKey,
  createdAt, stateGeneration, operations, allocateStableChangeId,
}: {
  lineageId:string; generationId:ChangeSetGenerationId; parentRef?:ChangeSetRef;
  grantDigest:string; idempotencyKey:string; createdAt:string;
  stateGeneration:string; operations:readonly ChangeSetOperation[];
  allocateStableChangeId(input:unknown):StableChangeId;
}): {generation:ChangeSetGeneration;outputs:readonly {
  path:DocumentationPrivatePath;bytes:Uint8Array;sha256:string;
}[]}|InvalidProposal;

export function changeSetGenerationPaths(ref:ChangeSetRef):Readonly<{
  directory:DocumentationPrivatePath; manifest:DocumentationPrivatePath;
  blobs:DocumentationPrivatePath;
  baseBlob(operationId:string):DocumentationPrivatePath;
  proposedBlob(operationId:string):DocumentationPrivatePath;
}>;

export function parseChangeSetGeneration(input:{
  manifestBytes:Uint8Array;
  readBlob(relativePath:DocumentationPrivatePath):Promise<Uint8Array>;
}):Promise<ChangeSetGeneration|InvalidProposal>;

export function serializeChangeSetGeneration(
  generation:ChangeSetGeneration,
):Uint8Array;

export function changeSetGenerationId(
  input:string,
):ChangeSetGenerationId|InvalidProposal;
```

- [ ] `changeSetGenerationId` is the only brand constructor and accepts exactly `CHANGE_SET_GENERATION_ID_RE` (`/^[0-9a-f]{16}$/`). `buildChangeSetGeneration` returns the complete deterministic output array (manifest plus every required base/proposed blob); `changeSetGenerationPaths` is the only layout constructor; `parseChangeSetGeneration` rejects a non-branded/non-canonical id plus missing, extra-declared, aliased, oversized, or digest-mismatched blobs and never accepts an absolute path. Task 2 store staging and Phase 5 migration import must consume these pure exports rather than inventing another layout.
- [ ] Extend authority protocol with only typed `stage-generation`/`load-generation` snapshot and transaction payloads. The fixed helper owns exclusive directory creation, no-follow containment, blob hashing, fsync, manifest-last publication, idempotency record, and current-lineage CAS; it accepts no generic private-root path or raw file operation.
- [ ] Persist status `open` in generation metadata without later rewriting that immutable record; lifecycle status changes live in append-only operation/receipt records keyed by the generation digest.
- [ ] Add every new production file explicitly to `first-party-extensions.json`; keep helper runtime out of extension imports and keep extension modules free of Node `fs`.
- [ ] **Step 4: Run focused and conformance tests.**

Run: `node --test products/workbench/tests/documentation-change-set.test.mjs products/workbench/tests/documentation-authority.test.mjs products/workbench/tests/documentation-workspace.test.mjs products/workbench/tests/first-party-extensions.test.mjs`

Expected: PASS for immutable retries, dirty bases, stable identities, grant bounds, structural validation, no canonical writes, local adapter, and SSH adapter fixtures.

- [ ] **Step 5: Refactor canonical generation construction.** Make `generationDigest` depend only on `schemaVersion`, ref/parent, public identities, grant digest, idempotency key, timestamp, state generation, ordered operations, and hunks; centralize canonical JSON sorting and prove caller object key order cannot change it.
- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-change-set.test.mjs products/workbench/tests/documentation-workspace.test.mjs`

Expected: PASS, including 1,000 randomized key-order/path/edit fixtures with deterministic digests.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/change-set-model.mjs products/workbench/extensions/chatero-documentation/stable-hunks.mjs products/workbench/extensions/chatero-documentation/change-set-store.mjs products/workbench/extensions/chatero-documentation/documentation-capabilities.mjs products/workbench/extensions/chatero-documentation/documentation-operations.mjs products/workbench/documentation-authority/protocol.mjs products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs products/workbench/first-party-extensions.json products/workbench/tests/documentation-change-set.test.mjs products/workbench/tests/documentation-authority.test.mjs products/workbench/tests/documentation-workspace.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "feat(documentation): persist immutable Agent generations"
```

## Task 3: Expose Only Typed Retrieval and Staging Tools

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/documentation-agent-tools.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-transactions.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/package.json`
- Modify: `products/workbench/extensions/chatero-documentation/extension.cjs`
- Modify: `products/workbench/first-party-extensions.json`
- Modify: `products/workbench/tests/documentation-change-set.test.mjs`
- Modify: `products/workbench/tests/documentation-extension.test.mjs`
- Modify: `products/workbench/tests/first-party-extensions.test.mjs`

**Interfaces:**

- Consumes: Task 2 `createChangeSetStore`, Phase 1 scope/capability issuer, `DocumentationTransactions.stage`, workspace trust, and Task 7 `DocumentationRetrieval.retrieve` (registered lazily; no working-page widening here).
- Produces: manifest tools `chatero_documentation_retrieve` and `chatero_documentation_stage`; `registerDocumentationAgentTools({vscode,transactions,retrieval,capabilities,scope}):readonly Disposable[]`; `transactions.stage(grant,input)`; tool results containing bounded text plus `ChangeSetRef`, never private paths/tokens.

- [ ] **Step 1: Write failing manifest and tool-boundary tests.** Require exactly two language-model tools and this staging behavior:

```js
const result = await stageTool.invoke({ input: {
  idempotencyKey: "turn-7-stage-1",
  operations: [{ kind: "edit", path: "topic.qmd", baseRevision, proposedText: "new\n" }],
}}, cancellationToken);
assert.deepEqual(result.metadata.changeSetRef, { lineageId: result.metadata.changeSetRef.lineageId, generationId: "0000000000000001" });
assert.equal(canonicalWrites.length, 0);
assert.equal(result.metadata.reviewToken, undefined);
assert.doesNotMatch(JSON.stringify(result), /documentation-changes|\.chatero|absoluteRoot/);
```

- [ ] Reject untrusted workspaces, cancelled calls, unknown fields, absolute/private paths, support assets, binary content, absent/mismatched base revision, over-limit count/bytes, forged parent refs, and any requested settle/state/migration action. Assert failures create no generation directory.
- [ ] Assert exports and manifest contain no `settle`, `accept`, `writeCanonical`, `setDocumentState`, `migrate`, `recover`, generic read/write, or UI-only `Zotero.QLab.insertIntoQmd` equivalent.
- [ ] **Step 2: Run focused tests and verify red.**

Run: `node --test products/workbench/tests/documentation-change-set.test.mjs products/workbench/tests/documentation-extension.test.mjs`

Expected: FAIL because the two tool contributions and registration module are absent.

- [ ] **Step 3: Implement the narrow tool composition.** Register only exact manifest names and issue grants inside the composition root:

```js
const stage = vscode.lm.registerTool("chatero_documentation_stage", {
  async invoke(options, token) {
    assertTrusted(vscode.workspace);
    const input = validateStageToolInput(options.input);
    const grant = capabilities.issueAgentProposalGrant(scope, {
      paths: input.operations.map(operationPath),
      operationKinds: [...new Set(input.operations.map(value => value.kind))],
      maximumOperationCount: 128,
      maximumProposedBytes: 8 * 1024 * 1024,
      expiresInMs: 30_000,
    });
    return stageToolResult(await transactions.stage(grant, input));
  },
});
```

- [ ] Tool schema uses `additionalProperties:false`, maximum 128 operations, maximum 8 MiB proposed UTF-8 bytes, QMD paths only, and exact tagged unions. Cancellation before immutable publication removes only the unpublished exclusive staging directory; cancellation after publication returns the valid ref.
- [ ] Extend `createDocumentationTransactions` with `stage` and `review` only when their implementation dependencies are injected. Keep `settle` absent until Task 5. Do not expose adapter/store/capability issuer from activation exports.
- [ ] The retrieval tool delegates to the injected service and cannot pass a raw root or private path. Until Task 7 injects the real service, registration supplies a typed `feature-unavailable` result without filesystem access; it must not broaden to generic workspace search.
- [ ] **Step 4: Run focused tests and verify green.**

Run: `node --test products/workbench/tests/documentation-change-set.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/first-party-extensions.test.mjs`

Expected: PASS with only retrieve/stage advertised, immutable staged output, bounded results, no canonical mutation, and failure isolation from Zotero Core.

- [ ] **Step 5: Refactor tool result redaction.** Route both tools through `boundedAgentToolResult({content,metadata})`, cap returned text at 256 KiB, include content/revision/state labels only when authorized, and recursively reject fields named `root`, `token`, `approval`, `privatePath`, or `evidencePath`.
- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-change-set.test.mjs products/workbench/tests/documentation-extension.test.mjs`

Expected: PASS for oversized diagnostics, nested metadata, cancellation, and redaction.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/documentation-agent-tools.mjs products/workbench/extensions/chatero-documentation/documentation-transactions.mjs products/workbench/extensions/chatero-documentation/package.json products/workbench/extensions/chatero-documentation/extension.cjs products/workbench/first-party-extensions.json products/workbench/tests/documentation-change-set.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "feat(documentation): expose scoped Agent proposal tools"
```

## Task 4: Bind Review Snapshots, Decisions, and Three-Way Reconciliation

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/review-decisions.mjs`
- Create: `products/workbench/extensions/chatero-documentation/three-way-reconcile.mjs`
- Create: `products/workbench/extensions/chatero-documentation/review-snapshot.mjs`
- Create: `products/workbench/tests/documentation-review.test.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-transactions.mjs`
- Modify: `products/workbench/first-party-extensions.json`
- Modify: `products/workbench/tests/first-party-extensions.test.mjs`

**Interfaces:**

- Consumes: immutable generation/base blobs from Task 2, current saved/open snapshots, state generation, Phase 1 `HumanApproval` issuer.
- Produces: `createReviewSnapshot({generation,currentDocuments,stateGeneration,capabilities,scope}):ReviewSnapshot`; `validateReviewDecisions(snapshot,decisions):CompleteReviewDecisions|DecisionError`; `threeWayReconcile({base,current,proposed}):ThreeWayResult`; `consumeReviewToken(token):BoundReviewRecord` internal to a snapshot registry.

- [ ] **Step 1: Write failing snapshot/decision/reconciliation tests.** Prove all identities bind exact content and decisions are leaf-complete:

```js
const snapshot = createReviewSnapshot(fixture);
assert.deepEqual(snapshot.leaves.map(leaf => leaf.id), generationLeafIds);
assert.deepEqual(validateReviewDecisions(snapshot, new Map()), {
  kind: "incomplete-decision-set", missing: generationLeafIds,
});
assert.equal(structuredClone(snapshot).reviewToken === snapshot.reviewToken, true);
assert.throws(() => registry.consume(structuredClone({reviewToken:snapshot.reviewToken})), /unrecognized review/);
```

- [ ] Cover file/all expansion to exact leaves, contradictory parent/child choices, accept-dependent-hunk/reject-rename, structural indivisibility, extra/unknown IDs, token expiry/reuse/wrong workspace, current revision/state changes, line-number drift, and deterministic leaf ordering.
- [ ] Cover non-overlapping human insertion/deletion/replacement, adjacent boundary edits, repeated anchors, CRLF, Unicode, conflicting overlap, delete-after-modification, and rename remaining structural. Conflicts retain exact base/current/proposed bytes by private evidence reference.
- [ ] **Step 2: Run focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-review.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `review-snapshot.mjs`.

- [ ] **Step 3: Implement one immutable snapshot and complete-decision validator.** Construct leaves from stable hunk/structural IDs, snapshot every current revision and dirty flag once, bind `generationDigest + current revisions + stateGeneration + leaves/dependencies` into the opaque review record, and return a random display token whose authority remains in a module-private `WeakMap`/token map with one-use semantics.

```js
export function validateReviewDecisions(snapshot, decisions) {
  const expected = new Set(snapshot.leaves.map(leaf => leaf.id));
  const missing = [...expected].filter(id => !decisions.has(id));
  if (missing.length) return Object.freeze({ kind: "incomplete-decision-set", missing: Object.freeze(missing) });
  const unknown = [...decisions.keys()].filter(id => !expected.has(id));
  const violations = dependencyViolations(snapshot.leaves, decisions);
  if (unknown.length || violations.length) {
    return Object.freeze({ kind: "invalid-decision-set", violations: Object.freeze([...unknown.map(id => `unknown:${id}`), ...violations]) });
  }
  return Object.freeze({ kind: "complete", decisions: new Map(decisions) });
}
```
- [ ] Decision validation first expands file/all UI commands to a leaf map, then requires exactly the snapshot leaf IDs, then checks dependencies. It returns the normative typed incomplete/invalid results and performs no adapter call.
- [ ] Implement a deterministic diff3 over exact UTF-16 source ranges. Apply proposed edits whose base ranges are untouched by current edits; map offsets through non-overlapping current edits; return `conflict` for any intersecting or ambiguously repeated range. Delete never rebases after any byte change; rename never degrades to edit.
- [ ] A stale revision or state generation yields a newly generated `ReviewSnapshot` and `stale-review`; never reuse a previous review token or reconstruct base text from current files.
- [ ] **Step 4: Run focused tests and verify green.**

Run: `node --test products/workbench/tests/documentation-review.test.mjs products/workbench/tests/documentation-change-set.test.mjs`

Expected: PASS for stable identity, exact snapshot binding, decision completeness/dependencies, clean reconciliation, and preserved conflicts.

- [ ] **Step 5: Refactor immutable evidence building.** Centralize `reviewDigest(snapshotWithoutToken)` and `conflictEvidence({base,current,proposed,paths})`; assert neither output contains a capability/token/absolute root and all byte fields are content addressed.
- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-review.test.mjs`

Expected: PASS with byte-identical snapshot digests across process restarts and no token persistence.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/review-decisions.mjs products/workbench/extensions/chatero-documentation/three-way-reconcile.mjs products/workbench/extensions/chatero-documentation/review-snapshot.mjs products/workbench/extensions/chatero-documentation/documentation-transactions.mjs products/workbench/first-party-extensions.json products/workbench/tests/documentation-review.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "feat(documentation): bind exact human review snapshots"
```

## Task 5: Settle Text and Mixed Operations Through a Barrier-Bound Continuation

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/settlement-planner.mjs`
- Create: `products/workbench/extensions/chatero-documentation/settlement-executor.mjs`
- Create: `products/workbench/tests/documentation-settlement.test.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-capabilities.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-transactions.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-operations.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/change-set-store.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/working-copy-coordinator.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/extension.cjs`
- Modify: `products/workbench/documentation-authority/protocol.mjs`
- Modify: `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`
- Modify: `products/workbench/first-party-extensions.json`
- Modify: `products/workbench/tests/documentation-workspace.test.mjs`
- Modify: `products/workbench/tests/documentation-state.test.mjs`
- Modify: `products/workbench/tests/documentation-remote-transaction.test.mjs`
- Modify: `products/workbench/tests/documentation-working-copy-coordinator.test.mjs`
- Modify: `products/workbench/tests/documentation-extension.test.mjs`
- Modify: `products/workbench/tests/first-party-extensions.test.mjs`

**Interfaces:**

- Consumes: Task 4 exact review/decisions/reconcile, Task 1 `vscode.workspace.acquireDocumentationWorkingCopyBarrier(...)`, Phase 2 `WorkingCopyCoordinator.applyVersionedTextEdits`, Phase 1 capability-bound `transact/recover`, human-approval reservation/acceptance, state serializer, generation store, Phase 1 state/new-page/resource handlers, and the startup/reconnect recovery gate.
- Produces: `planSettlement({snapshot,decisions,current}):SettlementPlan|DecisionError|Conflict`; `executeSettlement({plan,approval,idempotencyKey,adapter,coordinator}):Promise<SettlementResult>`; `reserveHumanApproval(approval,digest)` plus release/accept continuations; `transactions.settle(approval,input)` and human-only `transactions.resolveRecovery(...)`; typed authority requests `prepare-settlement`, `ack-settlement-text`, `inspect-settlement`, and `resolve-settlement`; closed human-operation requests `prepare-human-resource`, `inspect-human-resource`, and `resolve-human-resource`; append-only phases `private-staged -> marker-committed -> resources-applied -> awaiting-text -> text-proved -> metadata-applied -> committed`; and one terminal receipt or complete human-resolvable immutable recovery conflict.

- [ ] **Step 1: Write failing text-only, mixed, state, and crash tests.** Begin by proving text-only acceptance uses one coordinator call and does not save:

```js
const result = await executeSettlement(fixture.textOnly);
assert.equal(result.kind, "committed");
assert.equal(coordinator.calls.length, 1);
assert.equal(coordinator.calls[0].origin, "settlement");
assert.equal(coordinator.calls[0].edits.length, 2);
assert.equal(barrier.acquireCalls.length, 1);
assert.equal(barrier.lease.applyWorkspaceEditCalls.length, 1);
assert.deepEqual(barrier.resources.map(resource => resource.intendedDigest), intendedDigests);
assert.equal(workspace.saveCalls, 0);
assert.deepEqual(projectedState, {"a.qmd":"working", "b.qmd":"working"});
```

- [ ] Cover accept/reject/defer at hunk/file/all, zero accepted decisions, deferred immutable child rebased on committed output, partial settlement, reserved one-use/digest approval, stale review, one multi-document `WorkspaceEdit`, undo leaving state `working`, dirty rename/delete refusal, create target race, rename/delete revision race, and exact retry/idempotency conflict. Prove a barrier/pre-dispatch or helper-proved pre-journal failure releases the reservation, durable `private-staged` returns an `approvalAcceptanceProof` that consumes it, and an SSH disconnect/lost response after dispatch cannot release/reuse it; exact retry or inspection returns the same acceptance proof and terminal/in-flight operation.
- [ ] Cover the complete affected resource set and these named races: plan then open-and-edit an affected path, acquire then attempt standard-editor type/save/autosave, open an affected document while the barrier is held, ordinary bulk `workspace.applyEdit`, file create/copy/move/delete, dirty structural resources, and an external filesystem change just before helper precondition validation. Each case either returns `DirtyWorkingCopy`/`BarrierConflict` before the first canonical mutation or becomes read-only and cannot overwrite the bound version; no test may merely rely on event timing.
- [ ] Assert the owner bypass is one-shot: an edit omitting or adding a URI, changing a range from its bound `expectedVersion`, producing any digest other than `intendedDigest`, or calling `applyWorkspaceEdit` twice returns `BarrierConflict`/`false` with zero partial change. The one success must cover exactly the declared edited resources and produce every declared intended digest.
- [ ] Inject named crashes before journal publication, after the complete journal/evidence and staging directory are fsynced, immediately before active-marker publication, after marker fsync but before the durable `marker-committed` append, after that append, after `canonicalMutationStarted:true`, and before/after the first canonical/resource mutation. Only a marker-free valid `private-staged` record with both flags false and intact before proofs may retry exactly or be abandoned without a broad gate. Any present marker gates its affected set; a durable `marker-committed`, mutation-started, or later record missing its marker is tamper and gates all Documentation. Also crash after resources before working-copy finalization, after finalization before text, and after text before ack. Require `inspect-settlement` to classify each current text/resource as exact `before`, exact `intended`, or `unknown`; `unknown` preserves third-party bytes as immutable `recovery-conflict` evidence plus an opaque recovery token. No metadata, state, deferred child, terminal receipt, or gate release occurs before finalization and the bound text proof are acknowledged.
- [ ] Exercise `resolveRecovery` with a complete per-path map of `keep-current`, `restore-before`, or `apply-intended`. Require a fresh content-bound one-use `RecoveryApproval`, complete barrier including newly opened paths, current revision/directory-generation recheck, one exact resolution application, structural outcome finalization, and terminal receipt before gate release. Missing/extra choices, dirty/new-open races, an external change before write, token/approval reuse, crash/reconnect, or SSH disconnect returns a freshly bound `RecoveryConflict` with zero resolution writes and keeps the gate.
- [ ] Upgrade Phase 1 human mutations in the same conformance suite. `setDocumentState`, `newPage`, and human create/rename/delete use `prepare-human-resource`; bind complete path/directory-generation/target-absence proofs, acquire the complete Working Copy Barrier plus the helper's exclusive authority lease, and call `finalizeResourceOutcomes` for structural results. Crash every `private-staged`/marker/flag/mutation/finalization boundary; startup/reconnect uses `inspect-human-resource`, and an unknown revision is resolved only through human-approved `resolve-human-resource`. Verify an old rename/delete source tab cannot recreate the old URI by Save/autosave. Agent tool exports remain exactly retrieve/stage.
- [ ] Begin activation/reconnect with a marker fixture and prove the Code-OSS recovery-owned barrier is already active before editor restoration. The extension must call `recover({kind:"inspect-settlement"})` before state, review, settlement, or affected save/file operations become available. Extension failure leaves only affected Documentation resources quarantined read-only; unrelated editing and Zotero Core continue.
- [ ] **Step 2: Run focused tests and verify red.**

Run: `node --test products/workbench/tests/documentation-settlement.test.mjs products/workbench/tests/documentation-working-copy-coordinator.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `settlement-planner.mjs`.

- [ ] **Step 3: Implement precomputation and acquire the complete Working Copy Barrier.** `planSettlement` validates the bound review and decisions, reconciles every text hunk, computes all final texts/state changes/deferred material before mutation, and returns zero operations on any conflict. It derives one normalized, sorted `affectedResources` entry for every source and target: text edits bind `expectedVersion`, `expectedDigest`, and `intendedDigest`; every parent directory membership proof binds `expectedDirectoryGeneration`; structural sources set `requireClean:true`; creates set `targetAbsent:true` and bind their intended digest. Hash the canonical set into `affectedResourceDigest`. Before any helper request call the exact product-private API:

```js
const lease = await vscode.workspace.acquireDocumentationWorkingCopyBarrier({
  operationId: plan.operationId,
  resources: plan.affectedResources,
  reason: "settlement",
});
if (lease.kind === "dirty-working-copy" || lease.kind === "barrier-conflict") return lease;
const valid = await lease.revalidate();
if (valid.kind !== "valid") {
  lease.dispose();
  return valid;
}
```

- [ ] The barrier is registered before Code-OSS enumerates loaded working copies, so an editor opened after acquisition is immediately read-only. Only the returned lease can authorize one exact edit; a normal `vscode.workspace.applyEdit` remains blocked. Immediately before authority mutation call `lease.revalidate()` again; because the barrier now blocks editor/save/file-operation races, only an external authority revision can still make the helper's own no-follow revision check fail closed.
- [ ] **Step 4: Implement typed prepare/apply/ack settlement.** Call `transact({kind:"prepare-settlement",...})` with the complete immutable plan, consumed `HumanApproval`, exact structural/source revisions, target-absence assertions, intended state, staged text-overlay digests, deferred-child digest, affected-resource digest, and idempotency key. The helper first exclusively writes the complete immutable journal and all before/intended evidence into private operation staging, fsyncs every file, atomically publishes the journal, and fsyncs the staging directory; through this point it makes zero canonical/resource/TextDocument changes. It then revalidates the journal digest and operation preconditions, exclusively creates `.chatero/documentation-operation-active.v1.json` as the staging commit record bound to `journalDigest`, fsyncs the marker and `.chatero` directory, and rechecks external revisions. Only after that marker is durable may it perform the first canonical/resource mutation and apply structural resources in dependency order. It returns only:

```ts
type PreparedSettlement = Readonly<{
  kind:"awaiting-text"; operationId:string; operationDigest:string;
  affectedResourceDigest:string;
  textOverlay:readonly Readonly<{
    uri:Uri; expectedVersion:number; beforeDigest:string;
    intendedText:string; intendedDigest:string;
  }>[];
}>;
```

- [ ] The helper never accepts a renderer-selected raw file operation. Its prepared `affectedResourceDigest` and text overlay must exactly reproduce the barrier-acquisition plan; any missing/extra URI or digest mismatch becomes `BarrierConflict` before text application. `prepare-settlement` is the only step that consumes approval; a retry with the same idempotency key/digest reuses the exact durable journal and either publishes its missing marker or returns the recorded post-marker state, while a different digest conflicts. A journal without a marker is not an active operation and may be safely abandoned because it changed no canonical/resource/TextDocument bytes. A marker without its exact durable journal is impossible in the valid write order and is treated as tamper, never guessed recovery. The subsequent ack is not a new Agent capability or approval: it is an exact continuation authorized only by the durable journal's `operationId + operationDigest + affectedResourceDigest + textOverlay`.
- [ ] Apply the prepared overlay exactly once with `WorkingCopyCoordinator.applyVersionedTextEdits({operationId,origin:"settlement",edits,applyWorkspaceEdit: edit => lease.applyWorkspaceEdit(edit)})`. The coordinator validates the prepared expected versions/digests, emits one multi-document `WorkspaceEdit`, waits for matching change events, returns a content-addressed `textProof`, and never saves. Then call `transact({kind:"ack-settlement-text",operationId,operationDigest,textProof})`; the helper verifies the journal and every intended digest before appending `text-proved`, applying metadata/state, publishing any deferred immutable child, writing the terminal receipt, removing the active marker, and allowing the barrier to release. Accepted create/edit/rename targets become `working`, deletes lose state entries, rejected leaves are receipt-only, and Undo/Revert remains conservatively `working`.
- [ ] If prepare has occurred and apply/ack cannot finish, do not release the affected resources to ordinary editing; transfer/retain the lease as recovery-owned until a terminal result. `dispose()` is idempotent but cannot clear an active-marker gate. Before prepare, any barrier failure disposes the lease and performs zero writes.
- [ ] Implement `recover({kind:"inspect-settlement",operationId?,operationDigest?})` as the mandatory typed continuation on activation/reconnect and retry. It first proves the marker's `journalDigest` names a complete immutable fsynced journal; missing/mismatched proof returns tamper and retains the Documentation-wide gate with zero mutation. The helper then validates and advances structural journal phases and reports the exact overlay and per-resource classification. Under the recovery barrier: `before` reapplies the exact intended overlay through the lease and sends the bound ack; `intended` sends the bound ack without reapplying; `unknown` writes immutable before/current/intended evidence and returns `recovery-conflict` with zero overwrite. Only terminal commit/conflict may clear or replace the marker and release the gate; unknown bytes are never reconstructed from current state.
- [ ] **Step 5: Run settlement and authority tests and verify green.**

Run: `node --test products/workbench/tests/documentation-settlement.test.mjs products/workbench/tests/documentation-review.test.mjs products/workbench/tests/documentation-working-copy-coordinator.test.mjs products/workbench/tests/documentation-workspace.test.mjs`

Expected: PASS for text-only/mixed prepare/apply/ack flows, complete-set barrier races, dirty refusal, every durable phase, approval consumption only at prepare, deferred-child publication only at ack, mandatory local/SSH recovery, and unknown-revision preservation.

- [ ] **Step 6: Refactor operation transitions into one reducer.** Add private `advanceSettlement(record,event)` with an explicit transition table for `private-staged -> marker-committed -> resources-applied -> awaiting-text -> text-proved -> metadata-applied -> committed`; `private-staged` is published only after the complete private journal/evidence and its parent directory are durable, with `markerCommitted:false` and `canonicalMutationStarted:false`. Illegal skips/backtracks, canonical/resource mutation before `marker-committed`, marker publication before `private-staged`, a second approval at ack, an unbound text proof, or marker removal before a terminal record throws before I/O. Reuse it in executor and `inspect-settlement` recovery.
- [ ] **Step 7: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-settlement.test.mjs products/workbench/tests/documentation-workspace.test.mjs`

Expected: PASS with each injected crash retry producing one terminal receipt or one stable recovery conflict.

- [ ] **Step 8: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/settlement-planner.mjs products/workbench/extensions/chatero-documentation/settlement-executor.mjs products/workbench/extensions/chatero-documentation/documentation-transactions.mjs products/workbench/extensions/chatero-documentation/documentation-operations.mjs products/workbench/extensions/chatero-documentation/change-set-store.mjs products/workbench/extensions/chatero-documentation/working-copy-coordinator.mjs products/workbench/extensions/chatero-documentation/extension.cjs products/workbench/documentation-authority/protocol.mjs products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs products/workbench/first-party-extensions.json products/workbench/tests/documentation-settlement.test.mjs products/workbench/tests/documentation-workspace.test.mjs products/workbench/tests/documentation-working-copy-coordinator.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "feat(documentation): settle reviewed Agent changes"
```

## Task 6: Project One Review Snapshot into Chat, SCM, Diff, Gutter, and Tabs

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/documentation-review.cjs`
- Create: `products/workbench/extensions/chatero-documentation/documentation-review-content.mjs`
- Create: `products/workbench/tests/documentation-review-surfaces.test.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/package.json`
- Modify: `products/workbench/extensions/chatero-documentation/extension.cjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-agent-tools.mjs`
- Modify: `products/workbench/first-party-extensions.json`
- Modify: `products/workbench/tests/documentation-extension.test.mjs`
- Modify: `products/workbench/tests/first-party-extensions.test.mjs`

**Interfaces:**

- Consumes: Task 4 `ReviewSnapshot` registry and Task 5 `transactions.settle`; stable `ChangeSetRef` returned to the originating Chat tool call.
- Produces: `registerDocumentationReview({vscode,transactions,snapshots,capabilities,scope}):readonly Disposable[]`; readonly schemes `chatero-documentation-base:` and `chatero-documentation-proposed:`; commands `reviewChangeSet`, `acceptHunk`, `rejectHunk`, `deferHunk`, `acceptFile`, `rejectFile`, `settle`; one `SourceControl` named `chatero-documentation`.

- [ ] **Step 1: Write failing shared-snapshot surface tests.** Create one snapshot, open every surface, and assert object/digest identity rather than separately recomputed diffs:

```js
const snapshot = registry.publish(reviewFixture);
await surfaces.showInChat(snapshot.ref);
await surfaces.showInScm(snapshot.ref);
await surfaces.showDiff(snapshot.ref, "topic.qmd");
surfaces.decorateOpenEditors(snapshot.ref);
assert.deepEqual(consumedSnapshotDigests, Array(4).fill(snapshot.generationDigest));
assert.equal(reviewCalls, 1);
```

- [ ] Assert the originating stage tool result shows lineage/generation/status and a review command but no approval/review token. SCM resources, exact `vscode.diff`, gutter decorations, and tab `FileDecorationProvider` refer to the same stable IDs and refresh together after a fresh snapshot.
- [ ] Test hunk/file/all actions, incomplete decisions remaining visible, stale review replacing all surfaces atomically, rejected/deferred badges, multi-root isolation, disposal, SSH URI preservation, and Live Preview never replacing the source diff.
- [ ] **Step 2: Run focused tests and verify red.**

Run: `node --test products/workbench/tests/documentation-review-surfaces.test.mjs products/workbench/tests/documentation-extension.test.mjs`

Expected: FAIL because `documentation-review.cjs` is absent.

- [ ] **Step 3: Implement one snapshot-backed review controller.** Register a Source Control provider and readonly content providers; resource commands invoke `vscode.diff(baseUri,currentOrProposedUri,title,{preview:false})`. Use `TextEditorDecorationType` for exact hunk ranges and `FileDecorationProvider` for tab badges. All providers resolve `ChangeSetRef` through the registry and read the same frozen snapshot.

```js
async function show(ref) {
  const snapshot = await snapshotRegistry.getOrCreate(ref, () => transactions.review(ref));
  scmProjection.replace(snapshot);
  diffContent.replace(snapshot);
  gutterProjection.replace(snapshot);
  fileDecorations.replace(snapshot);
  return snapshot;
}
```
- [ ] Maintain UI decisions separately from the immutable snapshot. File/all commands expand through Task 4's validator. Settlement obtains a new content-bound single-use `HumanApproval` only after the user invokes the settle command and confirms the rendered summary.
- [ ] The stage tool response includes `{changeSetRef,generationDigest,reviewCommand:"chatero.documentation.reviewChangeSet"}` so the originating Chat turn displays the same proposal identity. It does not auto-accept, auto-open, auto-send another message, or serialize a token.
- [ ] Register failure domains independently: SCM/diff/decorations may fail without disabling typed staging, standard editing, Live Preview, or Zotero Core. Add exact commands/menus/when clauses and all files to the first-party manifest.
- [ ] **Step 4: Run focused tests and verify green.**

Run: `node --test products/workbench/tests/documentation-review-surfaces.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/documentation-review.test.mjs products/workbench/tests/first-party-extensions.test.mjs`

Expected: PASS with one review call/snapshot per refresh and identical stable IDs in Chat, SCM, diff, gutter, and tab projections.

- [ ] **Step 5: Refactor surface lifecycle into one controller.** Expose only `show(ref)`, `refresh(ref)`, and `dispose()` from the controller; hide SourceControl/content-provider/decoration objects. One refresh swaps the registry pointer before firing all provider events.
- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-review-surfaces.test.mjs`

Expected: PASS with no mixed old/new snapshot observed during stale refresh.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/documentation-review.cjs products/workbench/extensions/chatero-documentation/documentation-review-content.mjs products/workbench/extensions/chatero-documentation/package.json products/workbench/extensions/chatero-documentation/extension.cjs products/workbench/extensions/chatero-documentation/documentation-agent-tools.mjs products/workbench/first-party-extensions.json products/workbench/tests/documentation-review-surfaces.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "feat(documentation): add unified Change Set review surfaces"
```

## Task 7: Retrieve Reviewed Pages by Default and Label Working Context

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/documentation-retrieval.mjs`
- Create: `products/workbench/tests/documentation-retrieval.test.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-agent-tools.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-workspace.mjs`
- Modify: `products/workbench/first-party-extensions.json`
- Modify: `products/workbench/tests/first-party-extensions.test.mjs`

**Interfaces:**

- Consumes: Phase 1 projected whole-snapshot state, authority saved snapshots, Phase 2 open `TextDocument` overlay/revision, typed `RetrievalRequest`.
- Produces: `createDocumentationRetrieval({adapter,scope,workspaceView,state}):DocumentationRetrieval`; `retrieve(request):Promise<readonly RetrievedPassage[]>`; `indexSaved():Promise<RetrievalIndexReceipt>`; a working-page label exactly `Working — not reviewed` and dirty suffix exactly `Dirty buffer v<version>`.

- [ ] **Step 1: Write failing selection/ranking/revision tests.** Start with reviewed-only background behavior and explicit dirty working context:

```js
assert.deepEqual((await retrieval.retrieve({query:"lemma",limit:10})).map(x => x.path.value), ["reviewed.qmd"]);
const [working] = await retrieval.retrieve({
  query:"lemma", explicitPaths:[documentationPagePath("working.qmd")], limit:10,
});
assert.equal(working.state, "working");
assert.equal(working.dirty, true);
assert.equal(working.revision, `text-document:12:sha256:${sha256(dirtyText)}`);
assert.match(formatRetrievedPassage(working), /Working — not reviewed.*Dirty buffer v12/s);
```

- [ ] Cover missing/corrupt state (all working, no background results), current page, explicit attach/mention, `includeWorking` search, reviewed-before-working ranking, lower working score, saved indexing vs dirty explicit snapshots, stale index invalidation, orphan state, rename/delete, limits, cancellation, no private roots, and local/SSH equivalence.
- [ ] Assert automatic/background retrieval never reads open working buffers, and generic Agent file/shell tools still cannot read even reviewed QMD; only this typed service returns bounded passages.
- [ ] **Step 2: Run focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-retrieval.test.mjs products/workbench/tests/documentation-agent-authority.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `documentation-retrieval.mjs`.

- [ ] **Step 3: Implement state-gated snapshot selection and deterministic ranking.** Background indexing snapshots saved `documentation/**/*.qmd`, joins only whole-valid state, excludes non-reviewed/orphan/private paths, tokenizes normalized Unicode text, and stores only bounded derived terms/revision metadata. Explicit/current reads may overlay the exact open document and must record its `document.version`, SHA-256, and dirty label.

```js
export function retrievalEligibility({ state, isCurrent, isExplicit, includeWorking, background }) {
  if (state === "reviewed") return true;
  if (background) return false;
  return isCurrent === true || isExplicit === true || includeWorking === true;
}

function comparePassages(left, right) {
  return Number(right.state === "reviewed") - Number(left.state === "reviewed")
    || right.score - left.score
    || compareUtf8Bytes(left.path.value, right.path.value)
    || left.offset - right.offset;
}
```
- [ ] Import Phase 1's `compareUtf8Bytes` and sort by state (`reviewed` before eligible `working`), score descending, normalized UTF-8 path bytes ascending, then passage offset. Reuse the same comparator for every digest-bearing generation/path/manifest ordering. Test non-ASCII ties under distinct process locales locally and over SSH; serialized orders and digests must be byte-identical. Cap one result at 32 KiB, one request at 256 KiB, and `limit` at 32. Never return workflow-state file bytes or base/proposed blobs.
- [ ] Inject the real retrieval service into Task 3's tool. `includeWorking` defaults false and is honored only for explicit search; current/explicit paths are eligible without globally widening the index.
- [ ] **Step 4: Run focused tests and verify green.**

Run: `node --test products/workbench/tests/documentation-retrieval.test.mjs products/workbench/tests/documentation-change-set.test.mjs products/workbench/tests/documentation-agent-authority.test.mjs`

Expected: PASS for reviewed defaults, labeled/low-ranked working context, exact dirty revisions, bounded output, and reserved-root isolation.

- [ ] **Step 5: Refactor eligibility into one pure predicate.** Use `retrievalEligibility({state,isCurrent,isExplicit,includeWorking,background})` in indexing and query execution; add exhaustive truth-table tests.
- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-retrieval.test.mjs`

Expected: PASS for every truth-table row and stable tie ordering.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/documentation-retrieval.mjs products/workbench/extensions/chatero-documentation/documentation-agent-tools.mjs products/workbench/extensions/chatero-documentation/documentation-workspace.mjs products/workbench/first-party-extensions.json products/workbench/tests/documentation-retrieval.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "feat(documentation): retrieve reviewed context by default"
```

## Task 8: Build a Reviewed-Only, Reachability-Closed, No-Execute Main Site

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/documentation-site.mjs`
- Create: `products/workbench/tests/documentation-site.test.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/quarto-preview-manager.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/package.json`
- Modify: `products/workbench/extensions/chatero-documentation/extension.cjs`
- Modify: `products/workbench/first-party-extensions.json`
- Modify: `products/workbench/tests/documentation-extension.test.mjs`
- Modify: `products/workbench/tests/first-party-extensions.test.mjs`

**Interfaces:**

- Consumes: valid projected Documentation state, saved authority snapshots, Phase 3 safe relative image/link parsing and `QuartoPreviewManager` process/last-good/trust boundary.
- Produces: `createDocumentationSitePlan({pages,state,resolveReferences}):DocumentationSitePlan`; `createDocumentationSite({adapter,scope,workspaceFs,quartoManager,storageUri}):DocumentationSite`; `build():Promise<SiteBuildResult>`; commands `chatero.documentation.buildMainSite` and `chatero.documentation.previewWorkingSite`.

- [ ] **Step 1: Write failing reviewed-selection, reachability, invocation, and last-good tests.** Begin with a reviewed page referring to one raster asset and a working page referring to another:

```js
const plan = createDocumentationSitePlan(fixture);
assert.deepEqual(plan.pages.map(x => x.path.value), ["index.qmd"]);
assert.deepEqual(plan.assets.map(x => x.path.value), ["assets/reviewed.png"]);
assert.equal(plan.assets.some(x => x.path.value === "assets/working.png"), false);
const invocation = plan.quartoInvocation;
assert.equal(invocation.shell, false);
assert.equal(invocation.args.filter(x => x === "--no-execute").length, 1);
```

- [ ] Cover corrupt/missing state, orphan entries, working links from reviewed pages (not published), transitive reviewed navigation, unreferenced assets, assets reachable only from working pages, traversal/symlink/foreign URI/network/SVG/data/command refs, MIME mismatch, 20 MiB image limit, dirty reviewed buffers (saved snapshot only), remote storage URI, cancellation, Quarto absent/exit, and successful build followed by failed rebuild.
- [ ] Assert published navigation/search inputs contain reviewed pages only; local/remote working preview is visibly labeled and never replaces the reviewed Main Site's last-good output.
- [ ] **Step 2: Run focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-site.test.mjs products/workbench/tests/documentation-quarto-preview.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `documentation-site.mjs`.

- [ ] **Step 3: Implement a closed publication plan and derived staging tree.** Reject an invalid whole state snapshot, start from reviewed QMD pages, include only validated relative references reachable from included reviewed pages, and include only signature-matched PNG/JPEG/GIF/WebP/AVIF assets. Do not include external Literature, private roots, working QMD, raw HTML resources, SVG, network, or command URIs.

```js
export function createDocumentationSitePlan({ pages, state, resolveReferences }) {
  const reviewed = pages.filter(page => state.documents[page.path.value]?.state === "reviewed");
  const assets = reachabilityClosedAssets(reviewed, resolveReferences)
    .filter(asset => SAFE_RASTER_MIMES.has(asset.mime) && asset.size <= 20 * 1024 * 1024);
  return freezeSitePlan({
    pages: reviewed,
    assets,
    quartoInvocation: Object.freeze({
      file: "quarto", args: Object.freeze(["render", ".", "--no-execute"]), shell: false,
    }),
  });
}
```
- [ ] Materialize exact saved snapshots into a fresh digest-named derived directory below `storageUri/documentation-site/staging/` through `workspace.fs`; this is disposable derived output, not canonical authority. Write a generated Quarto project file whose navigation/search list is the plan's reviewed paths.
- [ ] Extend the Phase 3 manager with `buildSite({sourceUri,outputUri})` using fixed `{file:"quarto",args:["render",".","--no-execute","--output-dir",outputName],cwd:sourcePath,shell:false}`. Workspace trust is required before spawn. On success atomically switch the product-owned last-good pointer; on failure keep the prior URI and report a scoped Problem.
- [ ] Working preview uses a separate labeled derived root and cannot update reviewed publication navigation, search, or last-good pointer. Site failure does not disable editing, review, retrieval, or Zotero Core.
- [ ] **Step 4: Run focused tests and verify green.**

Run: `node --test products/workbench/tests/documentation-site.test.mjs products/workbench/tests/documentation-quarto-preview.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/first-party-extensions.test.mjs`

Expected: PASS with reviewed-only page/navigation/search output, reachability-closed assets, exactly one `--no-execute`, disposable staging, and last-good retention.

- [ ] **Step 5: Refactor publication selection into one immutable manifest.** Hash sorted `{path,revision,state}` pages and `{path,digest,mime}` assets into `siteDigest`; exact same input returns the existing last-good build without spawning Quarto.
- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-site.test.mjs`

Expected: PASS; identical builds reuse one digest, and a state/revision/reference change creates a new digest without deleting the last-good tree.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/documentation-site.mjs products/workbench/extensions/chatero-documentation/quarto-preview-manager.mjs products/workbench/extensions/chatero-documentation/package.json products/workbench/extensions/chatero-documentation/extension.cjs products/workbench/first-party-extensions.json products/workbench/tests/documentation-site.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "feat(documentation): publish reviewed no-execute site"
```

## Task 9: Gate Installed Local/SSH Review, Security, Retrieval, and Site Behavior

**Files:**

- Create: `products/workbench/integration/documentation/agent-review.test.mjs`
- Create: `products/workbench/integration/documentation/agent-authority-smoke.test.mjs`
- Create: `products/workbench/integration/documentation/main-site.test.mjs`
- Modify: `products/workbench/integration/documentation/driver/run.cjs`
- Modify: `products/workbench/integration/documentation/fixtures.mjs`
- Modify: `products/workbench/tests/remote-agent-release.test.mjs`
- Modify: `docs/chatero/parity-checklist.md`
- Modify: this plan

**Interfaces:**

- Consumes: installed pinned Code-OSS, materialized workspace-kind extension, signed Remote Agent, bundled Codex 0.142.0 App Server and `sandbox --permissions-profile`, exact product session-profile overrides, layered/managed configuration fixtures, fixed authority helper, local/SSH integration runner, and a fake Quarto executable that records argv and never executes QMD.
- Produces: one immutable `AGENT_REVIEW_SCENARIOS` matrix run for `local` and `ssh-fixture`; installed proof of resolved-profile, trusted-runtime, raw-helper, Working Copy Barrier, typed-tool, and recovery behavior; Phase 4 evidence and rollback boundary.

- [ ] **Step 1: Write failing installed scenario tests.** Define this exact shared matrix and reject skipped rows:

```js
export const AGENT_REVIEW_SCENARIOS = Object.freeze([
  "reserved-roots-read-write-denied",
  "typed-reviewed-retrieve-and-stage",
  "immutable-multi-file-generation",
  "chat-scm-diff-gutter-one-snapshot",
  "non-overlap-settlement-and-text-undo",
  "overlap-and-dirty-structural-refusal",
  "mixed-crash-recovery-and-recovery-conflict",
  "reviewed-default-retrieval",
  "reviewed-only-no-execute-site-last-good",
  "disconnect-reconnect-review",
  "documentation-failure-isolates-zotero-core",
]);
```

- [ ] The authority smoke invokes the installed binary without model/auth/network as `codex sandbox --permissions-profile <profile> <product-overrides> -C <temp-workspace> -- <probe>`, with the product overrides in their real final-argument order. For all three Chatero profiles, probe `cat`, `rg`, shell redirection, Node, Python, `apply_patch`, absolute paths, `..`, case aliases, and symlinks against the four Documentation authority roots (`documentation`, `.chatero`, `documentation-changes`, `documentation-migration`); every read/write must fail. Also deny workspace `.codex`, actual absolute `CODEX_HOME`, the installed helper/extension, bundled Codex, and Code-OSS/Remote Agent trees. Control operations outside denied roots must match the selected profile, including `chatero_full_access` outside the workspace.
- [ ] From inside each of the three sandbox profiles, directly invoke the installed fixed authority helper with forged but syntactically valid `snapshot`, `transact`, `prepare-settlement`, and `ack-settlement-text` frames targeting each of the four Documentation authority roots. Execution/read or the attempted access itself must be denied by the OS; no frame may reach a mutation branch, no marker/journal is created, and no helper path is silently delegated outside the sandbox. Static and runtime assertions forbid detached children, setuid/file capabilities, namespace/sandbox changes, executable replacement, or any equivalent privilege escape.
- [ ] In one live session attempt to modify/replace the helper, extension runtime, bundled Codex, and Agent Host tree, then invoke a legitimate typed retrieval/stage tool. The write must be OS-denied; if any byte/mode/link nevertheless changes, the pre-spawn complete-tree digest revalidation fails closed and the helper is not run. The same fixture runs locally and over SSH.
- [ ] Run start/turn/fork/resume request-recording fixtures locally and over SSH. Assert raw `config/read({includeLayers:true,cwd})` layers contain the exact profile definitions only in product `sessionFlags`, `configRequirements/read` allows the exact profiles/default, `permissionProfile/list` reports the three ids as `allowed:true` without treating its descriptions as policy proof, and every response binds the expected non-builtin active-profile id/extends. Reconnect cannot drop it. Hostile user/project configuration containing legacy `sandbox_mode="danger-full-access"`, a nested `permissions.chatero_*.filesystem."documentation/sub"="write"`, any non-empty production `binaryArgs`, `CODEX_HOME=<workspace>/documentation`, or an external config edit between lifecycle calls must stop before that request rather than fall back.
- [ ] Exercise settlement while trying standard-editor typing/save/autosave, ordinary bulk edit, file operations, and new editor opens for every affected resource. Assert only the lease-owned exact `WorkspaceEdit` succeeds. Run installed crash points before/after durable journal and before/after durable marker: pre-marker cases leave zero canonical/resource/TextDocument changes and exact-retry/abandoned staging semantics; post-marker restart/reconnect proves `journalDigest`, installs the read-only gate before editor restoration, and remains gated until `inspect-settlement` yields exact before/intended recovery or immutable unknown evidence. A forged marker with absent/mismatched journal must produce a broad Documentation tamper gate and zero recovery mutation.
- [ ] **Step 2: Run focused integration selection and verify red.**

Run: `npm run test:documentation:integration -- --target local --grep "agent review|agent authority|main site"`

Expected: FAIL because the Phase 4 integration files/scenario exports do not exist.

- [ ] **Step 3: Implement installed fixtures and scenario driver.** Build a generated workspace with reviewed/working pages, dirty open buffer, raster assets, hostile links/symlinks, multi-file proposal, fake Quarto, and crash-injectable helper. Use the same test body for local and `vscode-remote://chatero-remote+fixture`; only URI/transport setup differs.

```js
export async function runAgentReviewScenarios({ authority, fixture, runScenario }) {
  const results = [];
  for (const name of AGENT_REVIEW_SCENARIOS) {
    const result = await runScenario({ name, authority, fixture });
    assert.equal(result.status, "passed", `${authority}:${name}`);
    results.push(Object.freeze({ name, authority, status: "passed" }));
  }
  return Object.freeze(results);
}
```
- [ ] Stage only via `chatero_documentation_stage`; verify canonical digests unchanged; show exact source diff; accept/reject/defer; inject a concurrent non-overlap edit and then overlap; exercise create/edit/rename/delete, state effects, Undo, complete-resource barriers, typed prepare/apply/ack, mixed journal recovery, unknown third-party revision, disconnect/reconnect, reviewed retrieval, and reviewed-only site.
- [ ] Make fake Quarto fail after one successful build, capture argv, assert `--no-execute` exactly once and absence of cell side effects, and prove the prior last-good URI/content remains served.
- [ ] Extend signed-release tests so both Linux architectures include `chatero-documentation`, all Phase 4 source/generated files, the `0004`-patched Agent Host output, the fixed authority helper, and tree-manifest provenance. Extra/missing/mode/symlink changes force reinstall or fail closed.
- [ ] Update parity checklist to mark only Phase 4 Code-OSS Agent review/retrieval/site behavior complete; keep migration/cutover and Gecko retirement unchecked.
- [ ] **Step 4: Run the complete Phase 4 gate.**

Run: `npm run test:documentation`

Expected: PASS with zero skipped Documentation unit/property/security tests.

Run: `npm run test:documentation:integration -- --target local && npm run test:documentation:integration -- --target ssh-fixture`

Expected: PASS with the exact same `AGENT_REVIEW_SCENARIOS` count for local and SSH, including disconnect/reconnect.

Run: `npm run test:workbench-bootstrap`

Expected: PASS with patch/extension/helper provenance and no generated output tracked.

Run: `npm run workbench:bootstrap && npm run workbench:verify`

Expected: PASS against Code-OSS 1.132.0 commit `df53daabb18cd157bdb08c7f01c34df936cf12f4` and the ordered digest-pinned patch queue.

- [ ] **Step 5: Inspect and record evidence.** Run `git diff --check` and `git status --short`; verify no personal data, profiles, workspaces, Change Sets, site output, journals, credentials, `vendor/code-oss`, caches, or generated application bundles are staged. Record command results in the checkpoint below.
- [ ] **Step 6: Commit.**

```bash
git add products/workbench/integration/documentation/agent-review.test.mjs products/workbench/integration/documentation/agent-authority-smoke.test.mjs products/workbench/integration/documentation/main-site.test.mjs products/workbench/integration/documentation/driver/run.cjs products/workbench/integration/documentation/fixtures.mjs products/workbench/tests/remote-agent-release.test.mjs docs/chatero/parity-checklist.md docs/superpowers/plans/2026-08-12-documentation-phase-4-agent-review.md
git commit -m "test(documentation): gate Agent review locally and over SSH"
```

## Phase 4 Review Checkpoint

- [ ] Native Codex 0.142.0 generated schemas expose `permissions` on start, turn, fork, and resume. Raw `config/read` layers prove the three definitions come only from exact product session flags; `configRequirements/read` proves the ids/default are allowed; `permissionProfile/list` proves only that the three summaries are `allowed:true`; lifecycle responses prove selected id/extends and thread provenance. Hostile legacy/nested config, any production `binaryArgs`, disallowing managed requirements, config-epoch changes, missing response confirmation, and reconnect all fail before a lifecycle request can weaken it.
- [ ] Generic Agent reads and writes fail for `documentation/**`, `.chatero/**`, `documentation-changes/**`, `documentation-migration/**`, workspace `.codex/**`, absolute `CODEX_HOME`, and trusted runtime trees, including Full Access, approval requests, absolute/traversal/case/symlink aliases, alternate executables, direct forged helper frames, and same-session tampering.
- [ ] Only typed retrieval and staging are available to the Agent. Staging supports bounded QMD create/edit/rename/delete and never mutates canonical files/state or exposes private paths/tokens.
- [ ] Generations/base/proposed blobs are immutable, parent/current-generation bound, idempotent, restart-persistent, use exactly 16 lowercase hexadecimal generation ids, and use stable content identities rather than lines/indices.
- [ ] One `ReviewSnapshot` supplies Chat, SCM, exact Code-OSS diff, gutter, and tab affordances; hunk/file/all decisions are complete and dependency-valid before settlement.
- [ ] Non-overlapping human work reconciles; overlap preserves base/current/proposed evidence. Dirty rename/delete and raced structural targets are refused without overwrite.
- [ ] The complete affected resource set is protected by the product-private Working Copy Barrier against typing/save/autosave/bulk-edit/file-operation/new-open races; only its lease applies one exact Phase 2 `WorkspaceEdit`, which remains dirty/undoable.
- [ ] Every settlement durably publishes immutable private journal/evidence with zero canonical/resource/TextDocument changes, then publishes a `journalDigest`-bound active marker immediately before the first canonical/resource mutation, then uses approval-consuming `prepare-settlement`, lease-bound text application, and digest-bound non-authorizing `ack-settlement-text`. Pre-marker crashes retry exactly or leave safe abandoned staging; a valid marker proves its journal already durable and gates startup/reconnect until mandatory `inspect-settlement`; missing/mismatched journal is tamper under a broad Documentation gate, exact before/intended states recover, and unknown third-party bytes remain untouched in `RecoveryConflict`.
- [ ] Accepted create/edit/rename targets are `working`, deletes remove state, normal human edits preserve state, and deferred material becomes a new immutable child only after commit.
- [ ] Default/background retrieval returns reviewed pages only. Current/explicit/search-enabled working context is lower-ranked and visibly includes working/dirty/version labels.
- [ ] Main Site navigation/search contains reviewed pages only, assets are reachability-closed, every Quarto invocation is no-execute, and a failed rebuild retains last-good output.
- [ ] `npm run test:documentation`, both installed integration targets, `npm run test:workbench-bootstrap`, and `npm run workbench:verify` pass on the exact pins with zero skipped Phase 4 scenarios.
- [ ] Rollback boundary is documented: remove Phase 4 review/retrieval/site/tool files and manifest entries, remove patch `0004` plus its series entry, and restore the Phase 3 transaction/activation surface. Immutable private Change Sets created during Phase 4 remain preserved but unavailable; canonical QMD/state are never rolled back automatically, and standard editing, Live Preview, Zotero Core, and the legacy parity oracle remain usable.
