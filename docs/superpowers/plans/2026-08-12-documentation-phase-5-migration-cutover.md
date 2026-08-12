# Documentation Phase 5 Migration and Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute an explicitly approved, exact legacy Draft/Knowledge migration as one recoverable local-or-SSH authority transaction, then switch new workspaces and current product surfaces to Documentation without losing legacy content or proposal evidence.

**Architecture:** The `chatero-documentation` extension remains `extensionKind: ["workspace"]` and calls the fixed Phase 1 authority-local helper directly through the shared framed protocol; local and SSH differ only in where that same extension/helper executes, and no migration API is added to the `chatero-remote` UI extension. Phase 5 extends the helper with proposal import, durable migration journals, exact-plan execution, and proof-based recovery. Migration and recovery acquire Phase 4's product-private `vscode.workspace.acquireDocumentationWorkingCopyBarrier(...)` over the complete `affectedPaths`; an authority-local active-operation marker lets Code-OSS restore the same fail-closed gate before editor restoration after process restart or SSH reconnect. Product routing and starter defaults change only after a committed receipt is verified.

**Tech Stack:** Code-OSS 1.132.0 extension APIs, Electron 42.7.1, Node 24.18.0, CommonJS activation plus ESM domain modules, SHA-256, `yaml` 2.9.0, Node test runner, signed Chatero Remote Agent packages, installed Code-OSS/Electron smoke harness.

## Global Constraints

- Execute this plan only after Phases 1–4 pass their automated, installed, security, local, and SSH review gates. `chatero.documentation.enabled` remains `false` until Task 8.
- `products/workbench/extensions/chatero-documentation/package.json` remains `extensionKind: ["workspace"]`. Do not add a migration export, session escape hatch, or helper proxy to `products/workbench/extensions/chatero-remote/extension.cjs`.
- Extension and renderer modules never import Node `fs` for workspace bytes. Only the fixed `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs` may access repository bytes.
- A human first runs Phase 5 `planMigration(scope)`, which makes exactly one `snapshot({kind:"plan-migration-v2",limits,plannerVersion:"documentation-migration-v2"})` authority request, reviews that V2 report, and issues one short-lived `MigrationApproval` bound to that exact new V2 `planToken`. A Phase 1 V1 token/report/approval is stale and cannot be upgraded or reused. Startup, activation, repository bootstrap, SSH connection, reconnect, resume, and retry are not approval.
- A stale source hash, directory generation, state generation, target precondition, workspace epoch, or affected dirty working copy detected before the first canonical mutation returns `stale-plan` or `dirty-working-copy` with zero writes to `documentation/**`, `.chatero/documentation-state.v1.json`, legacy roots, or Change Set publication paths.
- `plan.affectedPaths`, not a plan-time list of open editors, is the complete migration/recovery barrier resource set. The product-private barrier blocks ordinary Text Editor and Live Preview typing, manual save, autosave, bulk edit, create/move/delete/copy, and newly opened affected resources; only the lease owner's exact `applyWorkspaceEdit` may cross it. Migration itself never applies a buffer edit.
- Before the helper's first transaction write, the lease and helper independently revalidate the complete plan and recomputed output manifest. The helper may then exclusively create/fsync only owner-private staging, journal, and intended evidence, with zero legacy/canonical/resource changes. The owner-only `.chatero/documentation-operation-active.v1.json` is the final staging commit record: it binds the already durable journal digest and is fsynced before the first legacy/canonical/resource mutation. It remains until a terminal committed/aborted receipt is durable. Its presence therefore always implies a matching durable journal and makes Code-OSS install an early startup/reconnect gate before editor restoration; the authority rejects affected settlement, state, and resource transactions until mandatory recovery inspection and any approved resolution finish.
- The helper may leave owner-only bootstrap/staging evidence under `work/qlab-zotero/documentation-migration/**`; it must never label that evidence a committed migration or index/publish it.
- Generic Agent shell/file tools remain denied for `documentation/**`, `.chatero/**`, `work/qlab-zotero/documentation-changes/**`, and `work/qlab-zotero/documentation-migration/**`, including Full Access, local, SSH, fork, resume, and restored sessions.
- Migration, migration reporting, proposal conversion, recovery inspection, and smoke fixtures never execute QMD code or start Quarto.
- Tests and smoke runs use generated disposable workspaces and profiles only. Never migrate a personal QLab workspace as part of implementation or verification.
- Do not edit `vendor/code-oss/` or generated application bundles. Rebuild them through the pinned bootstrap workflow and keep them ignored.
- Preserve the Gecko implementation as a development-only parity oracle through Tasks 1–7. Task 8 retires its production route only after the full cutover gate succeeds; physical removal is outside this plan and belongs to the broader atomic Workbench cutover.

---

## Phase File Map

### Create

- `products/workbench/extensions/chatero-documentation/migration-proposal-import.mjs` — strict legacy proposal classification and canonical Documentation Change Set output construction.
- `products/workbench/extensions/chatero-documentation/migration-executor.mjs` — approval-bound orchestration and one complete authority transaction request.
- `products/workbench/extensions/chatero-documentation/migration-recovery.mjs` — typed recovery projection and exact resolution request construction.
- `products/workbench/tests/documentation-migration-execution.test.mjs` — plan binding, stale/dirty zero-write, journal, idempotency, and local/SSH conformance.
- `products/workbench/tests/documentation-migration-recovery.test.mjs` — crash/reconnect proof matching and conflict-preserving recovery.
- `products/workbench/tests/documentation-migration-installed-smoke.mjs` — disposable installed local and SSH migration driver.
- `products/workbench/tests/documentation-phase-5-closure.test.mjs` — fail until non-personal gate evidence, packaged local/SSH receipts, and retirement boundaries are recorded.
- `products/workbench/tests/package-code-oss.test.mjs` — production-entry hard requirement, pinned Gulp target, output containment, and packaged-tree verifier tests.
- `products/workbench/scripts/package-code-oss.mjs` — sole production packaging entry; always requires a verified signed Remote Agent release and calls the pinned upstream platform/architecture package task.
- `products/workbench/scripts/verify-packaged-workbench.mjs` — verify packaged app provenance, trust root, signed Remote Agent tuples, first-party extension, and authority helper exact bytes.
- `products/workbench/patches/code-oss/0005-chatero-documentation-migration-recovery-gate.patch` — extend the Phase 4 early operation-marker barrier from settlement to typed migration inspection/resolution without adding a public API.

### Modify

- `products/workbench/extensions/chatero-documentation/migration-rewrite.mjs` — apply the Phase 1 structured rewriter to complete canonical and proposal blob output sets.
- `products/workbench/extensions/chatero-documentation/migration-planner.mjs` — make the opaque plan registry consumable exactly once by the Phase 5 executor while retaining read-only planning.
- `products/workbench/extensions/chatero-documentation/documentation-capabilities.mjs` — atomically consume migration/recovery approvals with durable `private-staged` journal acceptance.
- `products/workbench/extensions/chatero-documentation/documentation-operations.mjs` — define migration journal/receipt phases and canonical serialization.
- `products/workbench/extensions/chatero-documentation/documentation-transactions.mjs` — add `migrate` and `resolveRecovery` to the deep facade.
- `products/workbench/extensions/chatero-documentation/documentation-authority-client.mjs` — carry complete migration/recovery payloads over the existing fixed transport.
- `products/workbench/extensions/chatero-documentation/documentation-tree.cjs` — register explicit Plan, Migrate, Review Recovery, and Resolve Recovery commands.
- `products/workbench/extensions/chatero-documentation/extension.cjs` — compose executor/recovery with the Phase 4 product-private working-copy barrier and mandatory operation-gate inspection.
- `products/workbench/extensions/chatero-documentation/package.json` — contribute migration commands and switch the feature default only in Task 8.
- `products/workbench/documentation-authority/protocol.mjs` — validate migration and recovery request/result unions with exact fields and existing frame bounds.
- `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs` — stage, lease, revalidate, move, install, verify, journal, recover, and resolve beside local/SSH authority.
- `products/workbench/first-party-extensions.json` — materialize the new Phase 5 extension modules and revised shared runtime.
- `products/workbench/tests/documentation-extension.test.mjs` — command gating, explicit approval, receipt projection, and activation safety.
- `products/workbench/tests/documentation-agent-authority.test.mjs` — migration-marker startup/reconnect gate and complete affected-operation denial.
- `products/workbench/tests/documentation-migration-plan.test.mjs` — structured rewrite manifest and proposal-plan coverage.
- `products/workbench/tests/documentation-remote-transaction.test.mjs` — complete-request and local/SSH equivalence coverage.
- `products/workbench/tests/first-party-extensions.test.mjs` — exact Phase 5 extension file set.
- `products/workbench/tests/remote-agent-release.test.mjs` — signed Linux payload includes the revised helper/protocol bytes.
- `products/workbench/remote-agent/scripts/build-linux-agent.mjs` — validate revised provenance-pinned workspace extension/helper payload.
- `products/workbench/remote-agent/scripts/stage-release.mjs` — stage only Remote Agent artifacts containing the revised helper.
- `products/workbench/scripts/lib/first-party-extensions.mjs` — materialize the verified signed Remote Agent release below `chatero-remote/remote-agent/` without committing its tarballs.
- `products/workbench/scripts/bootstrap-code-oss.mjs` — require and pass the verified release input into first-party materialization.
- `products/workbench/scripts/verify-code-oss.mjs` — verify the installed release tree against recorded provenance.
- `.github/workflows/workbench.yml` — make release/production packaging use only `workbench:package` and verify its packaged output.
- `.gitignore` — ignore only generated `vendor/VSCode-<platform>-<arch>/` package roots in addition to the Code-OSS checkout.
- `products/workbench/tests/chatero-remote-manifest.test.mjs` — require actionable fail-closed behavior when the installed signed release is missing.
- `products/workbench/tests/bootstrap-code-oss.integration.test.mjs` — cover verified release materialization and provenance reuse.
- `products/workbench/patches/code-oss/series.json` — append the migration recovery gate patch with an exact digest.
- `products/workbench/tests/patch-series.test.mjs` — require the migration gate patch last and fuzz-free.
- `scripts/chatero/starter/generated-files.mjs` — generate Documentation-first public starter content and state.
- `scripts/chatero/build-qlab-starter.mjs` — copy/generate Documentation paths rather than legacy Draft/Knowledge paths.
- `resource/chatero/qlab-starter/manifest.json` — deterministically regenerated starter manifest.
- `resource/chatero/qlab-starter/research-loop-starter.zip` — deterministically regenerated public starter archive.
- `scripts/chatero/tests/qlab-starter-asset.test.mjs` — assert Documentation-only starter contents and privacy.
- `scripts/chatero/tests/qlab-starter-manifest.test.mjs` — assert Documentation root/state in the generated manifest.
- `docs/chatero/parity-checklist.md` — record Workbench Documentation as current and Gecko Draft/Knowledge as parity oracle only.
- `docs/chatero/qmd-workspace-review.md` — replace current manual Draft/Knowledge procedure with Documentation migration/recovery review.
- `AGENTS.md` — replace the superseded legacy QMD authority paragraph with the approved Documentation transaction boundary.
- `package.json` — add the production `workbench:package` entry and installed migration smoke command.

### Explicitly Unchanged

- `products/workbench/extensions/chatero-remote/extension.cjs`
- `products/workbench/extensions/chatero-remote/ssh-session.mjs`
- `chrome/content/zotero/xpcom/qlab/qmdDraftIO.js`
- `chrome/content/zotero/xpcom/qlab/qmdKnowledgePromotion.js`
- `chrome/content/zotero/xpcom/qlab/workspaceDocumentRouter.js`

The first two remain UI-side SSH plumbing with no Documentation export. The Gecko files remain source-compatible fixtures and parity-oracle code; Task 8 removes their production ownership through product routing/defaults and documentation, not by deleting the oracle.

## Locked Cross-Phase Interfaces

These signatures are normative JSDoc contracts. Do not rename them in this phase.

```ts
createDocumentationTransactions({
  adapter,
  capabilities,
  workspaceView,
  migrationPlanner,
  workingCopies,
}): {
  state(scope): Promise<DocumentationState>;
  stage(grant, input): Promise<ChangeSetResult>;
  review(ref): Promise<ReviewSnapshot>;
  settle(approval, input): Promise<SettlementResult>;
  setDocumentState(approval, input): Promise<StateResult>;
  planMigration(scope): Promise<MigrationPlanResult>;
  migrate(approval, {
    planToken: string;
    idempotencyKey: string;
  }): Promise<MigrationResult>;
  resolveRecovery(approval, {
    recoveryToken: string;
    resolutions: ReadonlyMap<DocumentationPath,
      "keep-current" | "restore-before" | "apply-intended">;
    idempotencyKey: string;
  }): Promise<RecoveryResult>;
};

// `workingCopies` remains a Phase 4 settlement dependency of this facade.
// Phase 5 migration/recovery never calls withUris(), drain(), or queues through it;
// those flows use the product-private Working Copy Barrier below.

createDocumentationCapabilityIssuer({ clock, randomUUID }): {
  issueMigrationApproval(scope, { digest, expiresInMs }): MigrationApproval;
  reserveMigrationApproval(approval, digest, {idempotencyKey}):
    {kind:"fresh"|"exact-replay";reservation:MigrationApprovalReservation};
  releaseMigrationApprovalReservation(reservation):
    {kind:"released"|"already-accepted"|"invalid"};
  acceptMigrationApprovalReservation(reservation, acceptanceProof):
    {kind:"consumed"|"exact-replay";record:CapabilityRecord};
  issueRecoveryApproval(scope, { digest, expiresInMs }): RecoveryApproval;
  consumeRecoveryApproval(approval, digest, {idempotencyKey}):
    {kind:"fresh"|"exact-replay";record:CapabilityRecord};
};

createWorkspaceTransactionAdapter({ scope, transport, workspaceView }): {
  snapshot(request): Promise<SnapshotResult>;
  transact(
    request:
      | PrepareSettlementRequest
      | AckSettlementTextRequest
      | ExecuteMigrationRequest
      | StateTransactionRequest
      | ResourceTransactionRequest,
  ): Promise<TransactionResult>;
  recover(request): Promise<RecoveryResult>;
};

vscode.workspace.acquireDocumentationWorkingCopyBarrier({
  operationId,
  reason: "settlement" | "migration" | "recovery",
  resources: readonly DocumentationWorkingCopyBarrierResource[];
}): Promise<
  | DocumentationWorkingCopyBarrierLease
  | DirtyWorkingCopy
  | BarrierConflict
>;

type DocumentationWorkingCopyBarrierResource = Readonly<{
  uri: vscode.Uri;
  expectedVersion?: number;
  expectedDigest?: string;
  expectedDirectoryGeneration?: string;
  intendedDigest?: string;
  requireClean: boolean;
  targetAbsent?: true;
}>;

type DocumentationResourceOutcome = Readonly<
  | {kind:"create";uri:vscode.Uri;intendedDigest:string}
  | {kind:"rename";from:vscode.Uri;to:vscode.Uri;intendedDigest:string}
  | {kind:"delete";uri:vscode.Uri;expectedDigest:string}
>;

interface DocumentationWorkingCopyBarrierLease {
  readonly operationId: string;
  revalidate(): Promise<
    | {kind:"valid"}
    | DirtyWorkingCopy
    | BarrierConflict
  >;
  applyWorkspaceEdit(edit: vscode.WorkspaceEdit): Promise<boolean>;
  finalizeResourceOutcomes(outcomes: readonly DocumentationResourceOutcome[]): Promise<
    | {kind:"finalized"}
    | DirtyWorkingCopy
    | BarrierConflict
  >;
  dispose(): void;
}

type MigrationPathProof = Readonly<{
  path: string; // normalized workspace-relative authority path
  role: "source" | "target";
  expectedDigest?: string;
  intendedDigest?: string;
  targetAbsent?: true;
  directoryGeneration?: string;
  requireClean: boolean;
}>;

type MigrationIntendedOutput = Readonly<{
  path: string; // normalized workspace-relative output path
  kind:
    | "canonical-page"
    | "canonical-asset"
    | "workflow-state"
    | "change-set-manifest"
    | "change-set-blob"
    | "quarantine-evidence";
  size: number;
  sha256: string;
}>;

type MigrationPlanV2 = Readonly<{
  schemaVersion: 2;
  plannerVersion: "documentation-migration-v2";
  digest: string;
  operationId: string;
  createdAt: string;
  workspaceEpoch: string;
  affectedPaths: readonly string[]; // normalized workspace-relative authority paths
  pathProofs: readonly MigrationPathProof[];
  intendedOutputManifest: readonly MigrationIntendedOutput[];
  // content-free mappings, state, collisions, rewrites, proposals, diagnostics
}>;

buildChangeSetGeneration({
  lineageId,
  generationId,
  parentRef,
  grantDigest,
  idempotencyKey,
  createdAt,
  stateGeneration,
  operations,
  allocateStableChangeId,
}): { generation: ChangeSetGeneration; outputs: readonly {path:DocumentationPrivatePath;bytes:Uint8Array;sha256:string}[] } | InvalidProposal;

changeSetGenerationPaths(ref: ChangeSetRef): Readonly<{
  directory: DocumentationPrivatePath;
  manifest: DocumentationPrivatePath;
  blobs: DocumentationPrivatePath;
  baseBlob(operationId: string): DocumentationPrivatePath;
  proposedBlob(operationId: string): DocumentationPrivatePath;
}>;

parseChangeSetGeneration({
  manifestBytes,
  readBlob,
}: {
  manifestBytes: Uint8Array;
  readBlob(relativePath: DocumentationPrivatePath): Promise<Uint8Array>;
}): Promise<ChangeSetGeneration | InvalidProposal>;
serializeChangeSetGeneration(generation): Uint8Array;
```

Imported proposals consume only the pure `change-set-model.mjs` builder and serializer. Their content-free manifest is part of the reviewed V2 plan; their bytes exist only inside authority-private planning/recomputation/staging during the same `execute-migration` transaction and are never fields of the request/response. Phase 5 must not call public `stage(...)`, write the Change Set store from the extension, or publish a generation before the committed migration receipt is durable.
The Phase 4 path layout is fixed as `work/qlab-zotero/documentation-changes/<lineageId>/<generationId>/manifest.v1.json` with `blobs/<operationId>.base` and `blobs/<operationId>.proposed`. Every `generationId` is exactly 16 lowercase hexadecimal characters (`/^[0-9a-f]{16}$/`). Migration uses the builder-returned complete output set and never invents a second layout. Migration acquires `acquireDocumentationWorkingCopyBarrier(...)` from the complete `plan.affectedPaths`, never from an open-editor snapshot, and never calls either the lease's `applyWorkspaceEdit` or `WorkingCopyCoordinator.applyVersionedTextEdits`.
Phase 4 settlement request names remain `prepare-settlement`, `ack-settlement-text`, and `inspect-settlement`. Phase 5 adds the same typed whole-request family as `execute-migration`, `inspect-migration`, and `resolve-migration`; none is a generic per-file write. All six honor the same product-private barrier and `.chatero/documentation-operation-active.v1.json` gate. A still-present marker continues the Code-OSS gate after an explicit lease is disposed, and only a helper-verified terminal receipt may clear it.
`planToken` is a new 256-bit opaque string created by Phase 5 only after validating one `plan-migration-v2` result and recording that the human opened/reviewed its V2 report; its full V2 record lives only in the planner's private registry. Every Phase 1 V1 token/report/approval is invalidated and returns `stale-plan`. `migrationPlanner.bindPlanToken(planToken,scope,idempotencyKey)` returns `{kind:"fresh"|"exact-replay",tokenId,plan,planDigest,approvalDigest}` and permanently binds that V2 token to one idempotency key. The same registered V2 token, scope, key, and digest may replay the same operation; another key, unknown token, workspace, epoch, schema/planner version, or digest is rejected. Approval consumers use the same rule: an exact replay is still the original authorized operation, not a second approval.
After binding, `migrationPlanner.boundPlanRequest(planToken,idempotencyKey)` returns only `{planDigest,approvalDigest}`. `migrationPlanner.consumePlanToken(planToken,reservation,{idempotencyKey})` returns the bound plan only when the reserved approval's private schema/planner version/scope/authority/epoch equal the V2 registry record. Neither method accepts a caller-created workspace root, serialized plan record, or token absent from the registry. Reservation is not consumption: a barrier/dirty refusal before adapter dispatch releases it, while helper acceptance durably binds its proof to the journal and consumes it exactly once; an ambiguous disconnect keeps it reserved for exact retry/recovery.
The consumed `plan` is Phase 5's frozen `MigrationPlanV2`: a newly authority-generated, content-free plan registered with its `planDigest` and `workspaceEpoch`. It contains complete normalized relative `affectedPaths`, a one-to-one sorted `pathProofs` set, and `intendedOutputManifest`, all bound into `planDigest`. Every affected path has exactly one proof; every manifest output has exactly one matching target proof, while additional target proofs cover transaction-private journal/evidence/receipt/marker paths without pretending their eventual bytes were precomputed. Neither structure contains QMD/asset/proposal bodies or absolute paths. Missing, duplicate, aliased, extra, or unbound proofs/outputs fail before barrier acquisition. A directory-membership proof with `directoryGeneration` is deliberately allowed to be the ancestor of its covered child proofs; validation rejects only a regular-file/symlink proof used as an ancestor, overlapping write targets, source/target role contradictions, rename cycles, or a directory proof whose declared children/generation coverage is incomplete. `resourcesForAffectedPaths(...)` derives barrier entries only from that registered record, maps every proof `directoryGeneration` to the exact lease field `expectedDirectoryGeneration`, and merges current `TextDocument` version/dirty overlay evidence without changing the affected set. The `execute-migration` frame carries only this registered plan record/digest, idempotency data, and a content-free approval reservation proof. The helper privately recaptures source bytes and deterministically recomputes the full intended bytes before its first write; no legacy or intended body crosses extension/renderer transport.

---

## Task 1: Complete Structured Rewrites and Legacy Proposal Import

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/migration-proposal-import.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/migration-rewrite.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/migration-planner.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-authority-client.mjs`
- Modify: `products/workbench/documentation-authority/protocol.mjs`
- Modify: `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`
- Test: `products/workbench/tests/documentation-extension.test.mjs`
- Test: `products/workbench/tests/documentation-migration-plan.test.mjs`
- Test: `products/workbench/tests/documentation-remote-transaction.test.mjs`

**Interfaces:**

- Consumes: Phase 1 authority-private snapshot, mapping, proposal-classification, and structured-rewrite primitives—not a returned V1 plan/token—plus `buildChangeSetGeneration(input)`, `changeSetGenerationPaths(ref)`, and `serializeChangeSetGeneration(generation)` from Phase 4 `change-set-model.mjs`.
- Produces: exact `SnapshotRequest` member `{kind:"plan-migration-v2",limits,plannerVersion:"documentation-migration-v2"}`, pure `buildMigrationRewriteSet({mapping,snapshot}): MigrationRewriteSet`, `importLegacyProposals({plannedProposals,snapshot,mapping,createdAt}): {generations,quarantine,report}`, `buildMigrationPlanV2({mapping,snapshot,createdAt}): {planRecord:MigrationPlanV2,intendedOutputs:AuthorityPrivateOutput[]}`, and `intendedOutputManifest(outputs): readonly MigrationIntendedOutput[]` using the locked closed `kind` union. Phase 5 `planner.planMigration(scope)` issues exactly that one request and creates a fresh V2-only opaque token/report binding. The authority helper invokes the pure functions during both planning and execution; extension/renderer code receives only `MigrationPlanV2` and its bounded report, never `snapshot`, `intendedOutputs`, or raw quarantine/audit bytes.

- [ ] **Step 1: Extend the failing migration-plan fixtures.** Add valid schema-v2 proposals, two valid generations for one `originalPath`, an exact duplicate, malformed JSON, missing base/proposed blob, digest mismatch, unknown schema, path escape, and rewritten references in both base and proposed blobs. Use this representative assertion:

```js
const imported = importLegacyProposals({
  plannedProposals, snapshot, mapping, createdAt: plannedCreatedAt,
});
assert.equal(imported.generations.length, 2);
assert.deepEqual(imported.report.map(item => item.disposition), ["imported", "duplicate-imported"]);
assert.match(imported.generations[0].outputs.find(output => output.path.value.endsWith("manifest.v1.json")).path.value,
  /^work\/qlab-zotero\/documentation-changes\/[a-f0-9-]+\/[0-9a-f]{16}\/manifest\.v1\.json$/);
assert.equal(imported.generations[0].generation.migrationEvidence.originalBaseRevision, legacyBaseRevision);
assert.equal(imported.generations[0].generation.migrationEvidence.migratedBaseRevision, sha256(migratedBaseBytes));
assert.equal(imported.generations[0].generation.migrationEvidence.originalProposedRevision, legacyProposedRevision);
assert.equal(imported.generations[0].generation.migrationEvidence.migratedProposedRevision, sha256(migratedProposedBytes));
assert.deepEqual(imported.quarantine.map(item => item.reason), [
  "malformed-manifest", "missing-blob", "digest-mismatch", "unknown-schema", "unsafe-path",
]);
```

- [ ] Add rewrite fixtures for Markdown links/images, supported QMD cross-reference targets, `project.render`, `website.navbar`, `website.sidebar`, Phase 4 Main Site route metadata, nested moved assets, CRLF, final-newline absence, code fences, inline code, raw blocks, external URLs, and ambiguous strings. Assert untouched byte ranges are identical and ambiguous candidates remain report-only.
- [ ] Assert proposal ordering is bytewise legacy manifest path then manifest digest, all valid records are imported, exact duplicates are labeled rather than discarded, and no output path includes an absolute workspace path.
- [ ] Add the new authority planning fixture for exact `MigrationPlanV2`: `schemaVersion:2`, `plannerVersion:"documentation-migration-v2"`, deterministic `operationId`, fixed `createdAt`, complete `affectedPaths`, one-to-one `pathProofs`, and sorted `intendedOutputManifest`. Assert every non-`digest` field is input to canonical `planDigest`, the `digest` field equals it, each manifest item has only `{path,kind,size,sha256}`, and the report/extension result/frame contains none of the private snapshot or output bytes. A V1 token/record/report/approval, unknown planner version, missing/extra path proof, or changed manifest entry returns `stale-plan` and can never execute or mint a V2 approval.
- [ ] Exact-validate output `kind` against only `canonical-page`, `canonical-asset`, `workflow-state`, `change-set-manifest`, `change-set-blob`, and `quarantine-evidence`; reject unknown/case-aliased kinds, duplicate/case-aliased paths, non-integer/oversized sizes, invalid SHA-256, and a manifest path without exactly one matching target proof.
- [ ] Have the helper's one exact high-level `snapshot({kind:"plan-migration-v2",limits,plannerVersion:"documentation-migration-v2"})` handler run privately: capture current snapshot A -> derive the Phase 1-compatible base mapping/classification -> V2 pure rewrite/import/Change Set/quarantine/state materialization -> output-manifest construction -> snapshot B -> exact source/path proof comparison. It returns only `{kind:"migration-plan-v2",schemaVersion:2,plannerVersion:"documentation-migration-v2",workspaceEpoch,planDigest,planRecord,reportModel}`. Reject `plan-migration`+V2 fields and `plan-migration-v2`+raw paths/output roots/write flags/wrong planner version. Instrument local/SSH frames and prove exactly one request and no raw legacy, proposal, audit, quarantine, or intended body crosses the authority boundary.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-migration-plan.test.mjs`

Expected: FAIL because `importLegacyProposals` and complete migrated proposal outputs do not exist.

- [ ] **Step 3: Implement the pure importer and complete rewrite set.** Derive lineage/generation IDs from domain-separated SHA-256 digests so identical snapshots produce identical outputs:

```js
export function legacyProposalIdentity({ manifestPath, manifestRevision }) {
  return Object.freeze({
    lineageId: digestUuid(`chatero:legacy-proposal:lineage\0${manifestPath}\0${manifestRevision}`),
    generationId: "0000000000000001",
  });
}

export function importLegacyProposals({ plannedProposals, snapshot, mapping, createdAt }) {
  const ordered = plannedProposals.toSorted(compareManifestPathThenDigest);
  const converted = ordered.map(record => convertLegacyProposal({
    record,
    snapshot,
    mapping,
    createdAt,
  }));
  return partitionAndFreezeProposalImports(converted);
}
```

- [ ] Derive `operationId` and `createdAt` once during authority planning and bind both into V2 so execution recomputes byte-identical output later rather than reading the current clock. Preserve the exact original manifest/base/proposed bytes as authority-private audit outputs; create separately rewritten migrated base/proposed blobs; record all four SHA-256 revisions plus a canonical transformation manifest in the generated `ChangeSetGeneration`.
- [ ] Use `buildChangeSetGeneration` and its complete `outputs` array for the published manifest and base/proposed blobs. Verify its paths with `changeSetGenerationPaths(ref)` and use `serializeChangeSetGeneration` only to assert the manifest bytes. Do not invoke `stage`, `change-set-store`, or filesystem methods. Return quarantine intended outputs below `work/qlab-zotero/documentation-migration/<operation-id>/quarantine/` without writing them in this pure module.
- [ ] `buildMigrationPlanV2` validates a one-to-one correspondence between complete `affectedPaths` and `pathProofs`; every sorted output-manifest entry has exactly one matching target proof, while explicitly classified transaction-private target proofs may lack a precomputed output entry. Source proof coverage is separately complete. It freezes the content-free plan record and returns byte-bearing `intendedOutputs` only to its authority-local caller, which discards them after planning. Update `migration-planner.mjs` so `planMigration(scope)` makes one `plan-migration-v2` request, validates the exact V2 result, creates a new opaque token/report binding, and registers/approves only V2. Invalidate every existing V1 registry entry with `{kind:"stale-plan"}`; require the human to open/review the new V2 report before issuing approval, with no approval/token carry-forward.
- [ ] **Step 4: Run the focused test and verify green.**

Run: `node --test products/workbench/tests/documentation-migration-plan.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs`

Expected: PASS with deterministic authority-private output bytes, a complete content-free V2 manifest/report, all valid proposal records represented, malformed records preserved as quarantine outputs, and no bodies in local/SSH frames.

- [ ] **Step 5: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/migration-proposal-import.mjs products/workbench/extensions/chatero-documentation/migration-rewrite.mjs products/workbench/extensions/chatero-documentation/migration-planner.mjs products/workbench/extensions/chatero-documentation/documentation-authority-client.mjs products/workbench/documentation-authority/protocol.mjs products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/documentation-migration-plan.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs
git commit -m "feat(documentation): convert legacy migration evidence"
```

## Task 2: Define the Durable Migration Journal and Protocol

**Files:**

- Modify: `products/workbench/extensions/chatero-documentation/documentation-operations.mjs`
- Modify: `products/workbench/documentation-authority/protocol.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-authority-client.mjs`
- Modify: `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`
- Test: `products/workbench/tests/documentation-migration-execution.test.mjs`
- Test: `products/workbench/tests/documentation-remote-transaction.test.mjs`

**Interfaces:**

- Consumes: Phase 1 `AuthorityTransport.request(frame): Promise<string>`, `canonicalOperationDigest(input)`, adapter `transact(completeRequest)`, Task 1 V2 parser plus authority-private deterministic recomputation functions. The extension never consumes Task 1's byte-bearing `intendedOutputs`.
- Produces: `serializeMigrationOperation(record): Uint8Array`, `parseMigrationOperation(bytes): MigrationOperation`, typed adapter request `transact({kind:"execute-migration",transaction})`, recovery requests `recover({kind:"inspect-migration",...})` / `recover({kind:"resolve-migration",...})`, and authority runtime `executeMigrationTransaction({workspace,epoch,transaction,failpoint = null})` where a non-null failpoint is accepted only by the injected test composition root and never decoded from production protocol bytes.

- [ ] **Step 1: Write failing journal/protocol tests.** Require exact fields and one complete frame:

```js
const request = makeMigrationRequest({
  planRecord: reviewedPlanV2,
  planDigest: reviewedPlanV2.digest,
  reservationProof: contentFreeReservationProof,
  idempotencyKey: "migration-1",
});
await adapter.transact({ kind: "execute-migration", transaction: request });
assert.equal(transport.requests.length, 1);
assert.equal(transport.requests[0].kind, "execute-migration");
assert.deepEqual(transport.requests[0].transaction.phases, [
  "private-staged", "marker-committed", "applying", "legacy-moved", "resources-applied",
  "metadata-applied", "committed",
]);
assert.deepEqual(
  transport.requests[0].transaction.planRecord.intendedOutputManifest,
  reviewedPlanV2.intendedOutputManifest,
);
assert.equal(frameContainsRawLegacyOrIntendedBytes(transport.requests[0]), false);
assert.equal(adapter.write, undefined);
```

- [ ] The exact request contains only `{schemaVersion:1,operationId,workspaceEpoch,planSchemaVersion:2,plannerVersion:"documentation-migration-v2",planDigest,planRecord,reservationProof,idempotencyKey}`. The reservation proof is content-free and bound to the V2 plan digest/key; it is not a raw approval/capability token and is not yet consumed. Assert raw snapshot/output/base/proposed/QMD/asset/quarantine fields, unknown fields, duplicate JSON keys, invalid phase transitions, duplicate/case-aliased paths, illegal file-as-ancestor or overlapping-write proofs, absolute paths, missing expected/intended revisions, oversized manifests, generic operation kinds, and a second frame are rejected before a write. Positive fixtures must retain legitimate directory-membership ancestors with complete `directoryGeneration` coverage.
- [ ] In memory, local-process, and SSH fixtures, capture the sole `execute-migration` frame and response and scan decoded JSON recursively for fixture source/output bodies and base64 encodings. Only relative paths, sizes, classifications, digests, V2 report facts, and content-free proof are permitted. The helper obtains bytes solely from its authority-private recaptured snapshot.
- [ ] Lock response proof semantics: every result whose request reached durable journal acceptance—including `recovering`, `recovery-conflict`, `migration-committed`, and exact replay—contains the same `approvalAcceptanceProof`; every pre-journal `stale-plan`, malformed request, or validation refusal omits it. A response may never contain reservation/approval/capability tokens or source/intended bodies. Inject a lost response after journal fsync and prove the still-reserved client retries the exact V2 digest/key/proof, receives the same acceptance proof, transitions to consumed, and cannot release or authorize another operation.
- [ ] Assert operation records live only at `work/qlab-zotero/documentation-migration/<operation-id>/operation.v1.json`; receipts live at `.../receipt.v1.json`; leases bind workspace epoch and operation ID. The fixed active marker lives only at `.chatero/documentation-operation-active.v1.json`, contains schema/operation/workspace epoch, journal/staging digest, and normalized affected roots/path-proof digest but no content, absolute path, capability, raw approval, or executable path. It is created/fsynced only after the owner-private staging/journal/evidence are durable and before the first legacy/canonical/resource mutation. Operation records likewise contain only relative paths and digests.
- [ ] **Step 2: Run the focused tests and verify red.**

Run: `node --test products/workbench/tests/documentation-migration-execution.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs`

Expected: FAIL because the migration transaction union and journal phases are not accepted.

- [ ] **Step 3: Extend protocol and runtime with one bounded migration request.** Use this exact record skeleton:

```js
const record = Object.freeze({
  schemaVersion: 1,
  operationId,
  operationKind: "legacy-migration",
  workspaceEpoch,
  idempotencyKey,
  requestDigest,
  planDigest,
  phase: "private-staged",
  markerCommitted: false,
  canonicalMutationStarted: false,
  before,
  intended,
  completedSteps: [],
  result: null,
});
```

- [ ] Reuse the Phase 1 frame caps and strict duplicate-key/exact-field validation. Extend the fixed runtime switch with only `execute-migration`, `inspect-migration`, and `resolve-migration`, alongside Phase 4's `prepare-settlement`, `ack-settlement-text`, and `inspect-settlement`; do not add generic `read`, `write`, `move`, arbitrary program execution, caller-selected root, or caller-selected helper path.
- [ ] On `execute-migration`, require current V2 and privately recapture the exact source snapshot, rerun Task 1 mapping/rewrites/import/quarantine/state/Change Set builders using V2's fixed `operationId`/`createdAt`, and compare workspace epoch, every source/path proof, complete sorted `intendedOutputManifest`, and `planDigest`. Any V1 record, body field, snapshot mismatch, nondeterministic byte, missing/extra path/output, or digest mismatch returns `stale-plan` with zero transaction writes.
- [ ] After successful recomputation, validate the reservation proof and, while holding the authority-local workspace operation lease, exclusively create/fsync owner-private staging bytes, operation journal, and intended evidence with no-follow traversal and zero legacy/canonical/resource changes. Publish the journal only as `private-staged` with `markerCommitted:false` and `canonicalMutationStarted:false`. Its immutable prepared portion binds the reservation-proof digest and derives `approvalAcceptanceProof` from the operation/request/prepared-journal digests; that is the atomic approval-acceptance point and exact retry/recovery returns the same proof. Bind that prepared-journal/staging digest into `.chatero/documentation-operation-active.v1.json`, create/fsync the marker as the final staging commit record, append and fsync `marker-committed` without changing the marker-bound bytes, then append/fsync `applying` with `canonicalMutationStarted:true` before the first legacy/canonical/resource mutation. A crash with marker-free `private-staged` evidence and matching before proofs can exact-retry or abandon without a gate; a present marker gates its affected set. A marker without its exact durable prepared journal, or a valid record already at `marker-committed`/`canonicalMutationStarted:true`/later whose marker is missing, is malformed/tampered and triggers the broad Documentation gate. Create quarantine/receipt files with exclusive creation, file/directory fsync, and immutable terminal receipt checks. While the marker exists, reject settlement/state/resource requests that overlap its affected set. The same-key/same-digest/reservation request returns the in-flight or terminal result; same-key/different-digest or different reservation proof returns `idempotency-conflict`.
- [ ] **Step 4: Run focused protocol/runtime tests and verify green.**

Run: `node --test products/workbench/tests/documentation-migration-execution.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs`

Expected: PASS with exactly one content-free `execute-migration` frame in memory, local-process, and SSH-fixture transports, deterministic authority-private recomputation, and no legacy/intended bodies crossing the extension/renderer boundary.

- [ ] **Step 5: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/documentation-operations.mjs products/workbench/extensions/chatero-documentation/documentation-authority-client.mjs products/workbench/documentation-authority/protocol.mjs products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs products/workbench/tests/documentation-migration-execution.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs
git commit -m "feat(documentation): journal migration transactions"
```

## Task 3: Bind Exact Plan Approval and Prove Zero-Write Staleness

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/migration-executor.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/migration-planner.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-capabilities.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-transactions.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/extension.cjs`
- Test: `products/workbench/tests/documentation-migration-execution.test.mjs`

**Interfaces:**

- Consumes: `planner.boundPlanRequest(planToken,idempotencyKey)`, `planner.consumePlanToken(planToken,reservation,{idempotencyKey})`, `capabilities.reserveMigrationApproval(...)` / `.releaseMigrationApprovalReservation(...)` / `.acceptMigrationApprovalReservation(...)`, Task 1 content-free V2 validator/registry, Task 2 `transact({kind:"execute-migration",transaction})`, and Phase 4 `vscode.workspace.acquireDocumentationWorkingCopyBarrier(...)` plus its lease `revalidate()` / `dispose()` methods. Only the authority helper consumes Task 1 proposal/rewrite builders or source/output bytes.
- Produces: `createMigrationExecutor({adapter,capabilities,migrationPlanner,workspace})`, `resourcesForAffectedPaths(plan.affectedPaths,plan.pathProofs,workspace.textDocuments)`, planner methods `bindPlanToken(planToken,scope,idempotencyKey)`, `boundPlanRequest(planToken,idempotencyKey)`, and `consumePlanToken(planToken,reservation,{idempotencyKey})`; approval reservation/acceptance semantics; `executor.migrate(approval,{planToken,idempotencyKey})`; and facade method `migrate(approval,input): Promise<MigrationCommitted | StalePlan | DirtyWorkingCopy | BarrierConflict | Recovering | RecoveryConflict | IdempotencyConflict>`.

- [ ] **Step 1: Write failing approval, stale, and dirty tests.** Bind approval to the exact token and assert no canonical mutation:

```js
const input = Object.freeze({ planToken, idempotencyKey: "migration-approved-1" });
const binding = migrationPlanner.bindPlanToken(planToken, scope, input.idempotencyKey);
const approval = capabilities.issueMigrationApproval(scope, {
  digest: binding.approvalDigest,
  expiresInMs: 30_000,
});
fixtureAuthority.mutateSource("drafts/a.qmd", "external revision\n");
const result = await transactions.migrate(approval, input);
assert.deepEqual(result, { kind: "stale-plan" });
assert.deepEqual(fixtureAuthority.canonicalMutations, []);
assert.equal(fixtureAuthority.exists("documentation"), false);
assert.equal(fixtureAuthority.exists("drafts/a.qmd"), true);
```

- [ ] Repeat the zero-write assertion for changed source bytes, added/removed directory entry, changed state generation, created target, changed workspace epoch, dirty affected `TextDocument`, token from another scope, forged token, expired approval, digest mismatch, reused approval, and a second request with the same idempotency key but different digest.
- [ ] Prove approval lifecycle explicitly: dirty/barrier refusal before adapter dispatch releases the reservation and the same still-valid approval can retry the exact V2 token/key; another token/key cannot use it while reserved. Helper pre-journal `stale-plan` has no `approvalAcceptanceProof`, releases the reservation, and invalidates that stale V2 registry entry, so replan requires a newly reviewed V2 report and new approval. Once the helper durably records `approvalAcceptanceProof` in its private journal, the approval is consumed exactly once. Every subsequent `recovering`, `recovery-conflict`, committed, or exact-replay response carries the same proof. Disconnect/timeout after possible acceptance never releases it; exact retry or recovery resolves the still-reserved client with that same proof/result without another approval.
- [ ] Add the three adversarial working-copy schedules explicitly: (1) plan while clean, then open and edit an affected path before migration; (2) pass the initial clean check, then attempt standard-editor typing, manual save, and autosave before helper dispatch; (3) open an affected path while barrier acquisition/transaction dispatch is in flight. Include bulk `WorkspaceEdit` and workspace-file create/move/delete/copy races. The first case returns `dirty-working-copy`; the later attempts are made read-only/denied and any observed version or resource change becomes `barrier-conflict`. In every case assert no adapter transaction, no active-operation marker, and zero canonical/legacy/Change Set writes; the user's buffer bytes are never overwritten.
- [ ] Assert exact idempotent retry returns the recorded result without consuming another approval or applying again. Assert planning remains read-only and token consumption does not write a journal until approval validation succeeds.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-migration-execution.test.mjs`

Expected: FAIL because `createMigrationExecutor` and `transactions.migrate` are missing.

- [ ] **Step 3: Implement approval-bound orchestration.** Resolve the opaque token and reserve (do not consume) the approval, acquire Phase 4's product-private barrier from the complete authority plan, then let helper acceptance consume the reservation atomically with its durable journal:

```js
export function createMigrationExecutor({ adapter, capabilities, migrationPlanner, workspace }) {
  return Object.freeze({
    async migrate(approval, input) {
      const binding = migrationPlanner.boundPlanRequest(input.planToken, input.idempotencyKey);
      const reserved = capabilities.reserveMigrationApproval(
        approval, binding.approvalDigest, { idempotencyKey: input.idempotencyKey },
      );
      let dispatched = false;
      let barrier = null;
      try {
        const plan = migrationPlanner.consumePlanToken(
          input.planToken, reserved.reservation, { idempotencyKey: input.idempotencyKey },
        );
        barrier = await workspace.acquireDocumentationWorkingCopyBarrier({
          operationId: plan.operationId,
          reason: "migration",
          resources: resourcesForAffectedPaths(
            plan.affectedPaths, plan.pathProofs, workspace.textDocuments,
          ),
        });
        if (barrier.kind === "dirty-working-copy" || barrier.kind === "barrier-conflict") {
          capabilities.releaseMigrationApprovalReservation(reserved.reservation);
          return barrier;
        }
        const finalBarrier = await barrier.revalidate();
        if (finalBarrier.kind !== "valid") {
          capabilities.releaseMigrationApprovalReservation(reserved.reservation);
          return finalBarrier;
        }
        dispatched = true;
        const result = await adapter.transact({
          kind: "execute-migration",
          transaction: buildCompleteMigrationRequest({
            planRecord: plan,
            planDigest: binding.planDigest,
            reservationProof: contentFreeReservationProof(reserved.reservation),
            idempotencyKey: input.idempotencyKey,
          }),
        });
        if (result.approvalAcceptanceProof) {
          capabilities.acceptMigrationApprovalReservation(
            reserved.reservation, result.approvalAcceptanceProof,
          );
        }
        else {
          capabilities.releaseMigrationApprovalReservation(reserved.reservation);
          migrationPlanner.invalidateStalePlan(input.planToken, result);
        }
        return result;
      }
      catch (error) {
        if (!dispatched) {
          capabilities.releaseMigrationApprovalReservation(reserved.reservation);
        }
        throw error;
      }
      finally {
        if (barrier && typeof barrier.dispose === "function") barrier.dispose();
        // Never release here after dispatch: a lost response may have accepted it.
      }
    },
  });
}
```

- [ ] `resourcesForAffectedPaths` validates the current authority-issued `MigrationPlanV2.pathProofs`, normalizes and sorts every entry in the complete plan, including legacy sources/directories, canonical and private targets, state, quarantine, journal, expected/intended digests, directory generations, and target-absence proofs; it maps each proof `directoryGeneration` exactly to `DocumentationWorkingCopyBarrierResource.expectedDirectoryGeneration` and never enumerates only currently open editors. Current loaded documents contribute version/dirty evidence but cannot add or remove affected paths. Barrier installation precedes its own loaded-working-copy re-enumeration, so a newly opened matching editor is born read-only. It disables/blocks normal typing, save/autosave, bulk edit and file create/move/delete/copy for matching resources; only `barrier.applyWorkspaceEdit(...)` is an owner bypass, and migration never invokes it.
- [ ] Immediately before helper dispatch call `barrier.revalidate()`, then send exactly one content-free `execute-migration` frame; do not make a second snapshot frame. The helper privately recaptures/recomputes and checks all source revisions, directory entries, state generation, target absence, workspace epoch, complete output manifest, and operation lease before any staging/journal write. An external-process edit races to `stale-plan` with zero transaction writes; after durable private staging it is caught again before the first legacy/canonical/resource mutation. Do not save, close, revert, call `applyVersionedTextEdits`, or edit buffers.
- [ ] `buildCompleteMigrationRequest` exact-validates V2, copies only its content-free record/digest, derives the content-free reservation proof from the bound reservation, and rejects any raw approval/capability/token or body-bearing field. It does not read a clock: `plan.createdAt` and deterministic `operationId` are already reviewed/digest-bound. Request/response instrumentation must show exactly one frame and no legacy/intended bytes or encodings.
- [ ] Replace/extend the planner token registry with `bindPlanToken(planToken,scope,idempotencyKey)` for newly issued V2 tokens only: derive `approvalDigest` from `{kind:"legacy-migration-v2",tokenId,planDigest,idempotencyKey}`, bind on first call, and return only exact replays thereafter. Add `boundPlanRequest` and make `consumePlanToken` require the reserved approval so schema/planner version/scope/authority/epoch and the recorded V2-report-reviewed fact are rechecked. Every V1 token/approval returns `stale-plan`; it cannot mint or carry into a V2 approval. Implement reserve/release/accept as a state machine keyed by approval identity + V2 digest + idempotency key; only a helper-returned journal-bound acceptance proof transitions reserved -> consumed, and exact replay returns the same record. Add `migrate` to `createDocumentationTransactions(...)`. Keep command/UI registration disabled until Task 7; no startup or activation code calls it.
- [ ] **Step 4: Run the focused test and verify green.**

Run: `node --test products/workbench/tests/documentation-migration-execution.test.mjs`

Expected: PASS with zero writes for every pre-mutation stale/dirty/barrier/capability case, read-only denial for all three editor-race schedules, and one exact `execute-migration` adapter request for success.

- [ ] **Step 5: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/migration-executor.mjs products/workbench/extensions/chatero-documentation/migration-planner.mjs products/workbench/extensions/chatero-documentation/documentation-capabilities.mjs products/workbench/extensions/chatero-documentation/documentation-transactions.mjs products/workbench/extensions/chatero-documentation/extension.cjs products/workbench/tests/documentation-migration-execution.test.mjs
git commit -m "feat(documentation): bind migration approval to exact plans"
```

## Task 4: Execute, Verify, and Commit the Complete Migration

**Files:**

- Modify: `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/migration-executor.mjs`
- Test: `products/workbench/tests/documentation-migration-execution.test.mjs`
- Test: `products/workbench/tests/documentation-remote-transaction.test.mjs`

**Interfaces:**

- Consumes: the Task 2 migration operation record, Task 3 content-free V2 execute request, Task 1 authority-private deterministic builders, and authority-local no-follow filesystem/lease primitives.
- Produces: `MigrationCommitted` as `{kind:"migration-committed",operationId,receipt,planDigest,canonicalDigest}` and an immutable receipt containing mappings, chosen conflict root, source/moved/staged/canonical hashes, state generation, proposal transformations, quarantine records, and every completed step.

- [ ] **Step 1: Add failing end-to-end authority fixtures.** Cover Knowledge-only, Draft-only, QMD and asset collisions, one conflict root for all collisions, nested assets, rewritten links/routes, multiple proposal imports, damaged proposal quarantine, existing empty target, and non-empty target rejection. Begin with:

```js
const { result, requestFrames } = await executeApprovedFixture({
  transport: "memory", fixture: "complete-legacy",
});
assert.equal(result.kind, "migration-committed");
assert.equal(requestFrames.length, 1);
assert.equal(frameContainsRawLegacyOrIntendedBytes(requestFrames[0]), false);
assert.equal(await fixture.read("documentation/topic.qmd"), knowledgeBytes);
assert.equal(await fixture.read("documentation/_migrated/drafts/topic.qmd"), draftBytes);
assert.equal(await fixture.state("topic.qmd"), "reviewed");
assert.equal(await fixture.state("_migrated/drafts/topic.qmd"), "working");
assert.equal(await fixture.exists("drafts"), false);
assert.equal(await fixture.exists("knowledge"), false);
assert.equal(await fixture.receipt(result.receipt).planDigest, plan.digest);
```

- [ ] Inject a post-validation target race immediately before lease acquisition and assert zero legacy/canonical mutations. Inject a race after a legacy root move and assert `recovering` or `recovery-conflict`, never `migration-committed`.
- [ ] Open clean standard Text Editor and Live Preview models for legacy QMD/proposal paths before migration. After commit and barrier release, trigger manual Save, autosave, hot-exit restore, and Save As from every stale tab; require the bound resource outcomes to rebind the model to its migrated target or keep the retired URI closed/tombstoned, and prove none can recreate `drafts/`, `knowledge/`, or `work/qlab-zotero/draft-changes/`. A finalize mismatch must keep the recovery gate and withhold the committed result.
- [ ] Inject an external revision after the extension lease's final `revalidate()` but before the helper's private recapture/recomputation. Assert `stale-plan`, no staging/journal/marker, and zero transaction writes. Inject crashes before/after staging fsync, before/after journal fsync, and before marker creation: assert zero legacy/canonical/resource changes, no startup gate, and exact retry or safe abandonment of private evidence. Then crash immediately after marker fsync and at each later boundary; assert the marker always binds an already durable matching journal and the early recovery gate reconstructs the exact affected set.
- [ ] Assert the authority privately recaptures the current source snapshot and byte-for-byte recomputes the mapping, rewritten tree, state, converted Change Sets, audits, and quarantine. Its complete `{path,kind,size,sha256}` manifest and path proofs must equal the reviewed V2 plan before any staging write. The new tree is then privately staged/digest-verified, the journal is durable, and the bound marker is fsynced before any legacy/canonical/resource mutation; moved roots are verified against V2 before installation, receipt fsync completes before marker/lease release, and recovery copies remain private afterward.
- [ ] **Step 2: Run the focused tests and verify red.**

Run: `node --test products/workbench/tests/documentation-migration-execution.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs`

Expected: FAIL at the first unimplemented stage/move/install transition.

- [ ] **Step 3: Implement the authority-local sequence exactly.**

```js
const recomputed = await recaptureAndRecomputeMigrationV2(request.planRecord);
await requireExactReviewedPlanV2(request, recomputed);
await revalidateBeforeAnyTransactionWrite(operation, recomputed);
await withMigrationLease(operation, async () => {
  await revalidateBeforePrivateStaging(operation);
  await stageIntendedTree(operation, recomputed.intendedOutputs);
  await verifyStagedTree(operation, request.planRecord.intendedOutputManifest);
  await publishAndFsyncPrivateStagedJournal(operation, {
    markerCommitted: false,
    canonicalMutationStarted: false,
  });
  await createAndFsyncActiveOperationMarker(operation, {
    preparedJournalDigest: operation.preparedJournalDigest,
    stagingDigest: operation.stagingDigest,
  });
  await appendAndFsyncOperationPhase(operation, "marker-committed", {
    markerCommitted: true,
    canonicalMutationStarted: false,
  });
  await revalidateBeforeFirstCanonicalMutation(operation);
  await appendAndFsyncOperationPhase(operation, "applying", {
    markerCommitted: true,
    canonicalMutationStarted: true,
  });
  await moveLegacyRootsToRecovery(operation);
  await verifyMovedLegacySnapshot(operation);
  await installCanonicalTreeStateAndChangeSets(operation);
  await verifyCanonicalOutputs(operation);
  await commitImmutableReceipt(operation);
});
await clearActiveMarkerAfterTerminalReceipt(operation);
```

- [ ] Move `drafts/`, `knowledge/`, and `work/qlab-zotero/draft-changes/` into the operation recovery area with journaled before/intermediate/intended revisions. Install `documentation/`, `.chatero/documentation-state.v1.json`, and all converted Change Set outputs in deterministic dependency order. Never overwrite an unexpected path or follow a replaced symlink.
- [ ] The helper imports/calls the same Task 1 pure builders for V2 planning and execution, but their byte-bearing results never leave the authority process. Recomputed `operationId`, `createdAt`, mappings, source/path proofs, every intended output digest/size/kind, and plan digest must be identical; a discrepancy returns `stale-plan` before staging. The execute request or response must never echo source/intended bodies.
- [ ] The active marker and journal carry the same operation/digest/epoch and normalized complete affected-path proof; the marker additionally commits the immutable prepared-journal/staging digests. Only a marker-free record whose last valid phase is `private-staged`, with both flags false and every canonical/legacy before proof intact, has made no legacy/canonical/resource changes and can be exactly retried or safely abandoned. A marker without the exact journal/staging proof, or a durable `marker-committed`/`canonicalMutationStarted:true`/later record whose marker is missing, is tampering and stays broadly gated. Before receipt/marker clearance, call the lease's one-shot `finalizeResourceOutcomes(...)` with the exact journal-bound legacy retire/move plus canonical create outcomes: clean open legacy/source models are rebound to their migrated target or closed/tombstoned, created canonical models reload, and any outcome/digest mismatch keeps recovery active. A later manual Save/autosave on an old `drafts/`, `knowledge/`, or `draft-changes/` URI must never recreate that retired path. While a valid marker exists, authority dispatch rejects every overlapping `prepare-settlement`, `ack-settlement-text`, state, resource, and second migration request; the product-private Code-OSS gate independently rejects editor-side changes. Only helper verification of a terminal receipt plus finalized working-copy outcomes may unlink/fsync the marker directory; extension disposal, window close, disconnect, feature disable, and retry cannot clear it.
- [ ] Verify every canonical byte, state generation, quarantine record, and receipt digest before returning committed. Validate each generated Change Set with `parseChangeSetGeneration({manifestBytes,readBlob})`, where `readBlob` is a transaction-internal lookup restricted to the builder-returned blob paths. Exact retry loads and returns the immutable receipt without touching canonical paths.
- [ ] **Step 4: Run local/SSH conformance tests and verify green.**

Run: `node --test products/workbench/tests/documentation-migration-execution.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs`

Expected: PASS with byte-identical logical snapshots and receipt digests for memory, local-process, and SSH-fixture adapters.

- [ ] **Step 5: Commit.**

```bash
git add products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs products/workbench/extensions/chatero-documentation/migration-executor.mjs products/workbench/tests/documentation-migration-execution.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs
git commit -m "feat(documentation): execute recoverable legacy migration"
```

## Task 5: Recover Crashes, Reconnects, and Third-Party Conflicts

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/migration-recovery.mjs`
- Create: `products/workbench/patches/code-oss/0005-chatero-documentation-migration-recovery-gate.patch`
- Modify: `products/workbench/patches/code-oss/series.json`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-capabilities.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-transactions.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/extension.cjs`
- Modify: `products/workbench/documentation-authority/protocol.mjs`
- Modify: `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`
- Modify: `products/workbench/tests/documentation-extension.test.mjs`
- Modify: `products/workbench/tests/documentation-agent-authority.test.mjs`
- Modify: `products/workbench/tests/patch-series.test.mjs`
- Test: `products/workbench/tests/documentation-migration-recovery.test.mjs`
- Test: `products/workbench/tests/documentation-remote-transaction.test.mjs`

**Interfaces:**

- Consumes: Phase 1 adapter `recover(request)`, Task 2 journal/receipt parser, Task 4 before/intermediate/intended proofs, `capabilities.consumeRecoveryApproval(approval,digest)`, Phase 4 `acquireDocumentationWorkingCopyBarrier(...)`, and the Phase 4 early gate keyed by `.chatero/documentation-operation-active.v1.json`.
- Produces: `createMigrationRecovery({adapter,capabilities,workspace})`, `recovery.inspect(scope): Promise<Recovered | Recovering | RecoveryConflict>`, `recovery.resolve(approval,input)`, typed `inspect-migration` / `resolve-migration` authority requests, mandatory `inspectActiveDocumentationOperation()` activation/reconnect handling, Code-OSS migration-gate patch `0005`, and facade `resolveRecovery(approval,input): Promise<RecoveryResolved | StaleRecovery | DirtyWorkingCopy | BarrierConflict | RecoveryConflict | IdempotencyConflict>`.

- [ ] **Step 1: Write failing crash/reconnect matrix tests.** Inject process exit before/after authority-local lease acquisition, private staging creation/fsync, `private-staged` journal publication/fsync, intended-evidence fsync, active-marker creation/fsync, `marker-committed` append/fsync, `canonicalMutationStarted:true` append/fsync, each legacy-root move, moved verification, canonical tree install, state install, each Change Set publication, canonical verification, receipt write/fsync, marker clear/fsync, and lease release. Marker-free `private-staged` with both flags false requires zero legacy/canonical/resource changes, no startup gate, and exact retry/safe abandonment only after every before proof still matches. From marker fsync onward, require the matching durable prepared journal and the early gate; deleting the marker after `marker-committed` or any later phase must install the broad Documentation tamper gate with zero guessed recovery mutation.

```js
for (const failpoint of MIGRATION_FAILPOINTS) {
  const crashed = await fixture.runUntilCrash(failpoint);
  assert.equal(crashed.exitKind, "injected-crash");
  const recovered = await fixture.restartAndRecover();
  assert.ok(["migration-committed", "aborted", "recovery-conflict"].includes(recovered.kind));
  assertNoLostOrUnjournaledBytes(fixture);
  assertNoMixedSuccessLabel(fixture, recovered);
}
```

- [ ] Run the same matrix with an SSH disconnect before response, disconnect after helper commit but before response, reconnect with the same workspace epoch, reconnect with a new epoch, duplicate request, and duplicate response. Place the active marker before Code-OSS startup/SSH workbench reconnection and assert its gate is installed before editor restoration and before extension activation. Committed receipt discovery makes the client retry idempotent; a new epoch without matching proof remains gated.
- [ ] Assert valid markers restore the exact affected set read-only; an unreadable, malformed, or proof-mismatched marker conservatively gates all Documentation authority roots and offers a recovery diagnostic. A missing marker is likewise tamper when the valid operation record already says `marker-committed`, `canonicalMutationStarted:true`, or later, whereas marker-free `private-staged` with both flags false does not gate. Until typed `inspect-migration` returns a marker-bound terminal/recovery result, standard/Live Preview typing, save/autosave, bulk edit, create/move/delete/copy, settlement `prepare-settlement`/`ack-settlement-text`, state transitions, resource mutations, and another migration are denied. New affected editors open read-only. Unrelated workspace paths, Zotero Core, other workspaces, and Literature remain available; for an intact marker the narrower proven unaffected Documentation pages may remain available, but marker/journal tamper never guesses such a subset.
- [ ] Make inspection mandatory at extension activation and every local/SSH reconnect even when `chatero.documentation.enabled` is false. Assert editor restore cannot outrun it, extension activation failure leaves the early gate held, and no command or UI projection releases/narrows it. A verified terminal receipt releases it; `recovering` or `recovery-conflict` narrows/retains it to the proven affected set. Startup/reconnect itself never resolves or approves a migration.
- [ ] At each nonterminal phase, replace one affected path with an unrecognized third-party revision. Assert `recovery-conflict` preserves before/current/intended bytes and structural facts, keeps the gate on affected paths, and leaves unrelated surfaces available.
- [ ] Test `keep-current`, `restore-before`, and `apply-intended` for every conflicted path under an adopted recovery barrier. Cover a restored dirty buffer, an editor opened after inspection, typing/save/autosave between clean validation and resolution dispatch, and an external-process revision after lease `revalidate()` but before the helper's first resolution write. Incomplete/unknown/duplicate resolution keys, forged/expired/reused approvals, stale recovery token, changed current revision, same idempotency key/different digest, dirty/new-open, and every race return a fresh `dirty-working-copy`, `barrier-conflict`, or `recovery-conflict` with zero resolution writes and no overwritten buffer/current bytes.
- [ ] **Step 2: Run recovery tests and verify red.**

Run: `node --test products/workbench/tests/documentation-migration-recovery.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/documentation-agent-authority.test.mjs products/workbench/tests/patch-series.test.mjs`

Expected: FAIL because migration recovery inspection/resolution and the pre-restore migration gate patch are not implemented.

- [ ] **Step 3: Implement proof-matching recovery and explicit resolution.** Use only recorded revisions:

```js
function classifyObservedRevision({ before, intermediates, intended, current }) {
  if (current === before) return "before";
  if (intermediates.includes(current)) return "intermediate";
  if (current === intended) return "intended";
  return "unrecognized";
}

export function createMigrationRecovery({ adapter, capabilities, workspace }) {
  return Object.freeze({
    inspect: scope => adapter.recover({ kind: "inspect-migration", scope }),
    resolve: (approval, input) => resolveRevisionBoundRecovery({
      adapter, capabilities, workspace, approval, input,
    }),
  });
}
```

- [ ] Patch Code-OSS with `0005` so its Phase 4 early inspector understands `operationKind:"legacy-migration"`, checks both the fixed active-marker path and a bounded no-follow authority scan of the fixed private operation roots before editor restoration, installs/adopts the exact same `DocumentationWorkingCopyBarrierLease`, and accepts only a content-bound `inspect-migration` result or helper-verified terminal receipt for gate transition. A marker-free record may be ignored only after the helper proves its last phase is `private-staged`, both marker/mutation flags are false, and canonical/legacy before proofs still match; a post-marker record missing its marker installs the broad gate before loading/restoring working copies. The scan rejects overflow, aliases, symlinks, malformed records, or an unreadable root as tamper instead of silently truncating. Append `0005` last in `series.json` with exact SHA-256 and add upstream tests for startup, local reconnect, SSH reconnect, dirty hot-exit editors, new opens, save/file-operation denial, malformed/missing markers at every durable phase, extension failure, verified release, and unrelated-resource availability.
- [ ] `inspectActiveDocumentationOperation()` is the first Documentation activation/reconnect action. It cannot be skipped by feature disable or delayed until a command. It calls only `recover({kind:"inspect-migration",scope})`, which performs the same bounded fixed-root nonterminal-record discovery as the early inspector, proves marker/journal/receipt agreement or the strictly pre-marker safe case, and hands the result to the Code-OSS gate; it does not select a resolution. Only after this mandatory inspection may affected transaction/UI commands be enabled.
- [ ] Matching proof may roll forward or restore automatically only when the recorded deterministic transition permits it; unrecognized proof must copy before/current/intended evidence into the private recovery area and return an opaque `recoveryToken`. For human resolution, acquire/adopt `acquireDocumentationWorkingCopyBarrier({reason:"recovery",resources:completeAffectedPaths})`, reject every dirty or stale resource, consume one exact approval, call `revalidate()` immediately before `recover({kind:"resolve-migration",...})`, and dispose only the explicit lease. The persistent early gate stays until helper proof makes the operation terminal.
- [ ] `resolve` requires one choice for every affected path. The helper independently rechecks the current revision map and marker/journal/receipt proof immediately before its first resolution write; any external race returns a newly digested `recovery-conflict` and makes zero writes. The extension may display the new evidence but cannot overwrite, save, close, revert, or silently reuse the old approval.
- [ ] Add `resolveRecovery` to the transaction facade. While the migration marker exists, authority dispatch permits only exact replay, `inspect-migration`, and approval-bound `resolve-migration` for that operation; it refuses settlement continuations, state, resources, and another migration. Recovery inspection may report/block affected paths, but it cannot select a resolution or start a migration without human approval.
- [ ] **Step 4: Run the recovery matrix and verify green.**

Run: `node --test products/workbench/tests/documentation-migration-recovery.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/documentation-agent-authority.test.mjs products/workbench/tests/patch-series.test.mjs`

Expected: PASS at every crash/disconnect boundary, with a pre-restore local/SSH gate, mandatory inspection, complete affected-operation denial, fresh conflict on dirty/new-open/external races, and no overwrite of an unrecognized revision.

- [ ] **Step 5: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/migration-recovery.mjs products/workbench/extensions/chatero-documentation/documentation-capabilities.mjs products/workbench/extensions/chatero-documentation/documentation-transactions.mjs products/workbench/extensions/chatero-documentation/extension.cjs products/workbench/documentation-authority/protocol.mjs products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs products/workbench/patches/code-oss/0005-chatero-documentation-migration-recovery-gate.patch products/workbench/patches/code-oss/series.json products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/documentation-agent-authority.test.mjs products/workbench/tests/patch-series.test.mjs products/workbench/tests/documentation-migration-recovery.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs
git commit -m "feat(documentation): recover interrupted migrations"
```

## Task 6: Package the Revised Helper for Local and SSH Authorities

**Files:**

- Create: `products/workbench/scripts/package-code-oss.mjs`
- Create: `products/workbench/scripts/verify-packaged-workbench.mjs`
- Create: `products/workbench/tests/package-code-oss.test.mjs`
- Modify: `products/workbench/first-party-extensions.json`
- Modify: `products/workbench/scripts/lib/first-party-extensions.mjs`
- Modify: `products/workbench/scripts/bootstrap-code-oss.mjs`
- Modify: `products/workbench/scripts/verify-code-oss.mjs`
- Modify: `products/workbench/remote-agent/scripts/build-linux-agent.mjs`
- Modify: `products/workbench/remote-agent/scripts/stage-release.mjs`
- Modify: `products/workbench/tests/bootstrap-code-oss.integration.test.mjs`
- Modify: `products/workbench/tests/first-party-extensions.test.mjs`
- Modify: `products/workbench/tests/chatero-remote-manifest.test.mjs`
- Modify: `products/workbench/tests/remote-agent-release.test.mjs`
- Modify: `products/workbench/tests/documentation-agent-authority.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `.github/workflows/workbench.yml`
- Test: `products/workbench/tests/documentation-remote-transaction.test.mjs`

**Interfaces:**

- Consumes: the revised protocol/runtime and all Phase 5 workspace-extension modules from Tasks 1–5, the exact Code-OSS/Electron/Node pins, and the signed release input containing both supported Linux Remote Agent tuples.
- Produces: `verifyInstalledRemoteAgentRelease(directory): Promise<VerifiedRemoteAgentRelease>` in `first-party-extensions.mjs`; developer API `bootstrapCodeOss({...,verifiedRemoteAgentReleaseDirectory?,requireRemoteAgentRelease?})`; production-only `packageCodeOss({root,platform,arch,verifiedRemoteAgentReleaseDirectory})` with no `requireRemoteAgentRelease` input/default; `verifyPackagedWorkbench({root,packageRoot,platform,arch,verifiedRemoteAgentRelease})`; root command `workbench:package`; CLI input `CHATERO_REMOTE_AGENT_RELEASE_DIR`; `materializeFirstPartyExtensions({root,checkout,manifestPath,remoteAgentRelease?})`; `verifyMaterializedRemoteAgentRelease({checkout,expected})`; independent provenance field `remoteAgentRelease: null | {manifestSha256,signatureSha256,publicKeySha256,files:[{path,tuple?,size,sha256}]}`; and installed signed data at `context.asAbsolutePath("remote-agent")`. `verifyInstalledRemoteAgentRelease` calls `verifyRelease({manifestText,signature,publicKey,readArtifact})` from the Phase 1 installed-tree integrity contract and additionally rejects indirect/extra entries. No API is added to `chatero-remote`.

- [ ] **Step 1: Add failing materialization/release tests.** Require every Phase 5 module and exact helper digest:

```js
const documentation = manifest.extensions.find(entry => entry.id === "chatero.documentation");
assert.ok(documentation.files.some(file =>
  file.destination === "extensions/chatero-documentation/migration-executor.mjs"));
assert.ok(documentation.files.some(file =>
  file.destination === "extensions/chatero-documentation/migration-recovery.mjs"));
assert.ok(documentation.files.some(file =>
  file.destination === "extensions/chatero-documentation/runtime/chatero-documentation-authority.mjs"));
assert.equal(await archiveSha256(localHelper), await archiveSha256(remoteHelper));
assert.equal(require("../extensions/chatero-remote/extension.cjs").migrate, undefined);
const releaseRoot = join(materializedExtensions, "chatero-remote", "remote-agent");
assert.equal((await lstat(join(releaseRoot, "manifest.json"))).isFile(), true);
assert.equal((await lstat(join(releaseRoot, "manifest.sig"))).isFile(), true);
for (const tuple of ["linux-x86_64", "linux-aarch64"]) {
  const artifact = verifiedRelease.artifacts.find(value => value.tuple === tuple);
  assert.deepEqual(await readFile(join(releaseRoot, artifact.filename)), artifact.bytes);
}
```

- [ ] In `bootstrap-code-oss.integration.test.mjs`, add three build-time fixtures: (1) no release with `requireRemoteAgentRelease:false` succeeds with `provenance.remoteAgentRelease === null` and reports `sshReady:false`; (2) the same input with `requireRemoteAgentRelease:true` fails before materialization with `verified Remote Agent release is required`; (3) a signed fixture containing both tuples materializes the default installed tree, records independent provenance, reuses only when every digest still matches, and rejects a changed/extra/symlinked artifact.
- [ ] Assert x86_64/aarch64 build and staging fail if the workspace extension, protocol, helper, or provenance digest is absent/stale/symlinked; staging must not copy a replacement helper into an already-built payload. Add a `chatero-remote-manifest` fixture proving absence/corruption of installed `remote-agent/manifest.json`, `manifest.sig`, public key, or either tuple artifact fails closed before SSH with one actionable `Reinstall Chatero or set CHATERO_REMOTE_AGENT_RELEASE_DIR to a verified development release` diagnostic.
- [ ] In `package-code-oss.test.mjs`, assert the production entry has no boolean escape hatch and calls `bootstrapCodeOss({...requireRemoteAgentRelease:true})` directly, refuses missing/unsigned/one-tuple input before checkout/package writes, invokes only the pinned checkout's `vscode-${platform}-${arch}-min` task, and accepts only the exact host platform/architecture mapping. Assert output resolves below ignored `vendor/VSCode-<platform>-<arch>/` (including `Chatero.app` on macOS), never `app/staging`, the repository, or a caller-selected directory.
- [ ] Make the packaged verifier fail independently for a missing/changed/symlinked `.chatero-provenance.json`, Remote Agent `manifest.json`, `manifest.sig`, `runtime/release-public-key.pem`, either `linux-x86_64`/`linux-aarch64` artifact, installed `chatero.documentation` extension, authority protocol/helper, `0005`-patched workbench/Agent Host output, pinned Codex binary, or any unexpected trusted-runtime entry. Unpack/inspect both signed tuple artifacts and prove their extension/helper bytes equal the local packaged provenance, rather than trusting filenames or only the outer archive digest.
- [ ] Assert `package.json` exposes only `workbench:package` for production packaging and `.github/workflows/workbench.yml` invokes that command plus packaged verification, never optional developer bootstrap followed by raw Gulp. CI supplies a verified release artifact, keeps `CHATERO_REMOTE_AGENT_RELEASE_DIR` build-time-only, uploads only a successfully verified package, and rejects a dirty/unpinned upstream or fuzzy patch application.
- [ ] **Step 2: Run packaging tests and verify red.**

Run: `node --test products/workbench/tests/package-code-oss.test.mjs products/workbench/tests/first-party-extensions.test.mjs products/workbench/tests/bootstrap-code-oss.integration.test.mjs products/workbench/tests/chatero-remote-manifest.test.mjs products/workbench/tests/remote-agent-release.test.mjs products/workbench/tests/documentation-agent-authority.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs`

Expected: FAIL because the production package entry/verifier and the new modules/digests/installed signed `chatero-remote/remote-agent/` tree are absent.

- [ ] **Step 3: Materialize and verify the revised fixed helper.** Add each new extension file explicitly to `first-party-extensions.json`; update build/release validation to require the exact materialized bytes in both tuples. Do not add a directory glob, post-build helper injection, remote UI export, arbitrary process call, or renderer-side migration transport.

```js
const requiredDocumentationRuntime = Object.freeze([
  "extensions/chatero-documentation/runtime/protocol.mjs",
  "extensions/chatero-documentation/runtime/chatero-documentation-authority.mjs",
]);
for (const path of requiredDocumentationRuntime) {
  await assertPinnedRegularPayload(join(agentRoot, path), provenance.files[path]);
}
```

- [ ] Extend the developer `bootstrapCodeOss` seam with `verifiedRemoteAgentReleaseDirectory = process.env.CHATERO_REMOTE_AGENT_RELEASE_DIR || null` and `requireRemoteAgentRelease = false`. When a directory is supplied, call the Phase 1 installed-tree verifier before checkout materialization; pass only its frozen verified manifest/files into `materializeFirstPartyExtensions`. When `requireRemoteAgentRelease` is true and no verified directory exists, fail before writing the checkout. Ordinary developer bootstrap alone may omit it, records `remoteAgentRelease:null`, returns `sshReady:false` plus the actionable diagnostic, and creates a Workbench that fails SSH closed rather than downloading or guessing.
- [ ] Copy `manifest.json`, `manifest.sig`, and both verified artifacts to `extensions/chatero-remote/remote-agent/` so the existing default `context.asAbsolutePath("remote-agent")` succeeds without a runtime environment variable. Store them in a new independent `.chatero-provenance.json` `remoteAgentRelease` field, not in `firstPartyExtensions`: relative paths, tuple, size, SHA-256, manifest digest, and signature digest. Extend `verifyCodeOss` to allow exactly those recorded installed-release files and verify each regular/no-symlink file by size/digest. Do not raise `MAX_FILE_BYTES`, relax the ordinary first-party extension 4 MiB limit, or weaken its unexpected-file/tree-digest checks.
- [ ] Source tarballs remain build inputs outside git and must never be added to `first-party-extensions.json` or committed. Preserve `CHATERO_REMOTE_AGENT_RELEASE_DIR` as the build-time CLI input and explicit development runtime override; both paths use the same signature, tuple, filename, size, digest, regular-file, and no-symlink verifier.

- [ ] **Step 4: Add the non-optional production package entry and packaged verifier.** `packageCodeOss` accepts a verified release directory as required input and directly pins the bootstrap call; it cannot receive or default a false production flag:

```js
await bootstrapCodeOss({
  root,
  verifiedRemoteAgentReleaseDirectory,
  requireRemoteAgentRelease: true,
});
await runPinnedUpstreamTask({
  checkout: join(root, "vendor/code-oss"),
  task: `vscode-${platform}-${arch}-min`,
});
await verifyPackagedWorkbench({
  root,
  platform,
  arch,
  packageRoot: join(root, `vendor/VSCode-${platform}-${arch}`),
  verifiedRemoteAgentRelease,
});
```

- [ ] Validate `platform`/`arch` against the pinned upstream task list before running anything; require the exact Node/Electron pins and a fuzz-free verified checkout. Add only generated `vendor/VSCode-*/` package roots to `.gitignore`. After Gulp, require the platform package root (and `Chatero.app` on macOS), then verify the full provenance/trust tree described in Step 1 before success. A failed verifier removes/uploads nothing and never relabels the output as a release.
- [ ] Add root script `"workbench:package": "node products/workbench/scripts/package-code-oss.mjs"` and make the release workflow call it with a verified `CHATERO_REMOTE_AGENT_RELEASE_DIR`. There is no production code path that supplies `requireRemoteAgentRelease:false`; Task 9 consumes this packaged output and never builds via the developer entry.
- [ ] Include a digest manifest for every trusted runtime root. Immediately before every local authority-helper, Native Codex, or remote installer/helper spawn, re-run regular-file/no-symlink/digest verification against that manifest; do not cache a successful preflight across spawns. Any same-session tamper fails closed with a reinstall diagnostic and does not execute the changed binary/module. Chatero named permission profiles must OS-deny Agent reads/writes to the packaged extension/helper/Codex/Remote Agent trees even in Full Access.

- [ ] **Step 5: Run packaging and authority tests and verify green.**

Run: `node --test products/workbench/tests/package-code-oss.test.mjs products/workbench/tests/first-party-extensions.test.mjs products/workbench/tests/bootstrap-code-oss.integration.test.mjs products/workbench/tests/chatero-remote-manifest.test.mjs products/workbench/tests/remote-agent-release.test.mjs products/workbench/tests/documentation-agent-authority.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs`

Expected: PASS for optional no-release developer provenance, mandatory production refusal, exact pinned package task/output, full packaged-tree verification, pre-spawn tamper refusal, local materialization, default installed-tree discovery, and both readable signed Linux artifacts.

- [ ] **Step 6: Commit.**

```bash
git add .gitignore .github/workflows/workbench.yml package.json products/workbench/first-party-extensions.json products/workbench/scripts/lib/first-party-extensions.mjs products/workbench/scripts/bootstrap-code-oss.mjs products/workbench/scripts/verify-code-oss.mjs products/workbench/scripts/package-code-oss.mjs products/workbench/scripts/verify-packaged-workbench.mjs products/workbench/remote-agent/scripts/build-linux-agent.mjs products/workbench/remote-agent/scripts/stage-release.mjs products/workbench/tests/package-code-oss.test.mjs products/workbench/tests/first-party-extensions.test.mjs products/workbench/tests/bootstrap-code-oss.integration.test.mjs products/workbench/tests/chatero-remote-manifest.test.mjs products/workbench/tests/remote-agent-release.test.mjs products/workbench/tests/documentation-agent-authority.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs
git commit -m "build(documentation): package migration authority"
```

## Task 7: Expose Explicit Human Migration and Recovery Commands

**Files:**

- Modify: `products/workbench/extensions/chatero-documentation/package.json`
- Modify: `products/workbench/extensions/chatero-documentation/extension.cjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-tree.cjs`
- Modify: `products/workbench/tests/documentation-extension.test.mjs`

**Interfaces:**

- Consumes: `transactions.planMigration(scope)`, `transactions.migrate(approval,input)`, `recovery.inspect(scope)`, `transactions.resolveRecovery(approval,input)`, and verified committed receipts.
- Produces: commands `chatero.documentation.planMigration`, `chatero.documentation.migrateApprovedPlan`, `chatero.documentation.reviewRecovery`, and `chatero.documentation.resolveRecovery`; `projectCommittedMigration({receipt,contextKeys,tree,retrieval,site})` performs rebuildable UI projection only.

- [ ] **Step 1: Add failing activation/command tests.** Assert planning and execution remain two actions and neither activation nor reconnect executes migration:

```js
await activate(harness.context);
assert.equal(harness.transactions.migrateCalls.length, 0);
const planned = await harness.commands.run("chatero.documentation.planMigration");
assert.equal(planned.plan.schemaVersion, 2);
assert.equal(planned.plan.plannerVersion, "documentation-migration-v2");
assert.equal(harness.transactions.migrateCalls.length, 0);
harness.migrationReview.markOpenedAndReviewed(planned.planToken, planned.planDigest);
harness.quickPick.answer("Migrate this exact reviewed plan");
await harness.commands.run("chatero.documentation.migrateApprovedPlan", planned.planToken);
assert.equal(harness.transactions.migrateCalls.length, 1);
assert.equal(harness.transactions.migrateCalls[0].input.planToken, planned.planToken);
```

- [ ] Assert command enablement requires trusted workspace, current opaque scope, enabled feature, an exact current `MigrationPlanV2`, recorded opening/review of its V2 report/digest, no dirty affected copy, and no unresolved operation. V1 token/report/approval, V2 report never opened, cancel, closing report before review, choosing another workspace, feature disable, expiry, or any new V2 plan invalidates approval and performs no migration call.
- [ ] Assert recovery view shows path/reason/before-current-intended metadata without exposing private absolute paths, requires a resolution for every conflicted path, and issues one approval bound to the exact recovery token plus sorted resolution map.
- [ ] Assert a committed receipt is verified before explorer/retrieval/site labels project to Documentation; failure leaves legacy/current routes unchanged and surfaces one diagnostic. Projection is idempotently rebuilt on restart without replaying migration.
- [ ] **Step 2: Run command tests and verify red.**

Run: `node --test products/workbench/tests/documentation-extension.test.mjs`

Expected: FAIL because execution/recovery commands and committed-receipt projection are absent.

- [ ] **Step 3: Register the explicit command flow.** Keep approval issuance inside the workspace extension composition root:

```js
const reviewed = await migrationReview.confirm(plan);
if (!reviewed) return;
const input = Object.freeze({ planToken: plan.planToken, idempotencyKey: randomUUID() });
const binding = migrationPlanner.bindPlanToken(input.planToken, scope, input.idempotencyKey);
const approval = capabilities.issueMigrationApproval(scope, {
  digest: binding.approvalDigest,
  expiresInMs: 30_000,
});
const result = await transactions.migrate(approval, input);
if (result.kind === "migration-committed") await projectCommittedMigration(result.receipt);
```

- [ ] Use one explicit V2 confirmation containing schema/planner version, plan digest, complete affected-path count, source/target counts, collision root, rewrite follow-ups, intended-output manifest summary, imported/quarantined proposal counts, and affected open paths. Mark the V2 report reviewed only after it was actually opened and the user confirms; the subsequent approval is bound to that exact new V2 token/digest/key. Do not add automatic/V1 approval, approval carry-forward, setting-based approval, startup migration, activation migration, or reconnect migration.
- [ ] Keep `chatero.documentation.enabled` default `false` in this task; installed smoke enables it explicitly. Standard Text Editor and Zotero Core remain available if command registration or projection fails.
- [ ] **Step 4: Run command and aggregate Documentation tests and verify green.**

Run: `node --test products/workbench/tests/documentation-extension.test.mjs && npm run test:documentation`

Expected: both commands PASS, and activation/reconnect fixtures record zero migration calls.

- [ ] **Step 5: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/package.json products/workbench/extensions/chatero-documentation/extension.cjs products/workbench/extensions/chatero-documentation/documentation-tree.cjs products/workbench/tests/documentation-extension.test.mjs
git commit -m "feat(documentation): add explicit migration commands"
```

## Task 8: Atomically Cut Over Starter, Policy, Routes, and Labels

**Files:**

- Modify: `products/workbench/extensions/chatero-documentation/package.json`
- Modify: `scripts/chatero/starter/generated-files.mjs`
- Modify: `scripts/chatero/build-qlab-starter.mjs`
- Modify: `resource/chatero/qlab-starter/manifest.json`
- Modify: `resource/chatero/qlab-starter/research-loop-starter.zip`
- Modify: `scripts/chatero/tests/qlab-starter-asset.test.mjs`
- Modify: `scripts/chatero/tests/qlab-starter-manifest.test.mjs`
- Modify: `docs/chatero/parity-checklist.md`
- Modify: `docs/chatero/qmd-workspace-review.md`
- Modify: `AGENTS.md`
- Test: `products/workbench/tests/documentation-extension.test.mjs`

**Interfaces:**

- Consumes: verified `MigrationCommitted` receipts, Phase 4 Documentation explorer/retrieval/Main Site projections, and deterministic `buildStarter({sourceRoot,outputRoot})`.
- Produces: `chatero.documentation.enabled` default `true`, a generated starter containing `documentation/` plus `.chatero/documentation-state.v1.json` and no current `drafts/` or `knowledge/` classes, policy/manual copy naming Documentation as current authority, and a freshly rebuilt/verified production package containing the committed Task 7 commands plus Task 8 defaults/assets.

- [ ] **Step 1: Add failing cutover assertions before changing defaults.** Require the generated starter and product contract:

```js
assert.equal(documentationManifest.contributes.configuration
  .properties["chatero.documentation.enabled"].default, true);
assert.equal(starterFiles.has("documentation/index.qmd"), true);
assert.equal(starterFiles.has(".chatero/documentation-state.v1.json"), true);
assert.equal([...starterFiles.keys()].some(path => path === "drafts" || path.startsWith("drafts/")), false);
assert.equal([...starterFiles.keys()].some(path => path === "knowledge" || path.startsWith("knowledge/")), false);
assert.deepEqual(JSON.parse(starterFiles.get(".chatero/documentation-state.v1.json")), {
  schemaVersion: 1,
  generation: "0000000000000001",
  documents: { "index.qmd": { state: "reviewed" } },
});
```

- [ ] Assert generated AGENTS/README/site copy uses `Documentation`, `working`, and `reviewed`; current build/check/site routes consume reviewed Documentation pages; Literature remains external/read-only; no generated text grants generic Agent access to reserved roots.
- [ ] Assert `STARTER_COPY_PATHS`, `STARTER_CURATED_COPY_PATHS`, and `GENERATED_STARTER_DIRECTORIES` contain Documentation equivalents and exclude legacy `drafts`/`knowledge` entries. Preserve the existing deterministic ZIP, privacy, symlink, mode, and credential scans.
- [ ] **Step 2: Run cutover tests and verify red.**

Run: `node --test products/workbench/tests/documentation-extension.test.mjs scripts/chatero/tests/qlab-starter-asset.test.mjs scripts/chatero/tests/qlab-starter-manifest.test.mjs`

Expected: FAIL because the feature default and starter still describe Drafts/Knowledge.

- [ ] **Step 3: Change all current defaults in one commit.** Set the feature default to `true`; replace generated Draft/Knowledge source trees, scripts, routes, labels, and rules with Documentation equivalents; generate a reviewed starter index and deterministic state file. Keep migration recognition for existing legacy workspaces and keep the Gecko source files untouched as the parity oracle.

```js
"documentation/index.qmd": text(`
---
title: "Documentation"
description: "A reviewed Research Loop documentation index."
---

## Reading map

Add human and reviewed Agent work through the Documentation workflow.
`),
".chatero/documentation-state.v1.json": text(`
{"schemaVersion":1,"generation":"0000000000000001","documents":{"index.qmd":{"state":"reviewed"}}}
`),
```

- [ ] Update root `AGENTS.md` so ordinary human edits use Code-OSS `TextDocument`/`WorkspaceEdit`, Agent edits remain private Change Sets, and only the Documentation transaction facade can settle, change state, migrate, or recover. Update the parity checklist/manual to say Gecko Draft/Knowledge is a development-only oracle and is not a current production route.
- [ ] Run `npm run build:qlab-starter` exactly once from the repository builder; do not hand-edit the manifest or ZIP. Inspect the generated manifest for only public fixture content and no personal path/profile/research bytes.
- [ ] **Step 4: Run starter, Documentation, and legacy-regression tests and verify green.**

Run: `node --test products/workbench/tests/documentation-extension.test.mjs scripts/chatero/tests/qlab-starter-asset.test.mjs scripts/chatero/tests/qlab-starter-manifest.test.mjs && npm run test:documentation && npm run test:chatero`

Expected: all commands PASS; legacy Gecko tests remain a green parity oracle while current starter/product assertions are Documentation-only.

- [ ] **Step 5: Commit the atomic cutover.**

```bash
git add AGENTS.md docs/chatero/parity-checklist.md docs/chatero/qmd-workspace-review.md products/workbench/extensions/chatero-documentation/package.json scripts/chatero/starter/generated-files.mjs scripts/chatero/build-qlab-starter.mjs scripts/chatero/tests/qlab-starter-asset.test.mjs scripts/chatero/tests/qlab-starter-manifest.test.mjs resource/chatero/qlab-starter/manifest.json resource/chatero/qlab-starter/research-loop-starter.zip
git commit -m "feat(documentation): cut over current workspace authority"
```

- [ ] **Step 6: Rebuild and sign the Remote Agent, then rebuild the production package from the committed cutover.** The Task 6 signed release is pre-cutover test evidence and is now stale because Tasks 7–8 changed `extension.cjs`, `package.json`, command contributions, defaults, and generated assets. From the exact clean Task 8 commit, first run the pinned build/stage/sign/`verifyRelease` pipeline for both `linux-x86_64` and `linux-aarch64`; require each new tuple's tree manifest/provenance to bind the final Documentation extension/helper/protocol bytes and Task 7/8 contribution/default digests. Do not reuse, patch, or inject into the Task 6 archives. Then invoke `workbench:package` with this freshly verified release and run `verifyPackagedWorkbench(...)` against the fresh output. Record and assert package provenance binds the same tuple release digests, Task 7 command handler/contribution digests, Task 8 `chatero.documentation.enabled:true`, regenerated starter manifest/archive digests, and exact `0005` patched output. Any Task 6 tuple or package is rejected by Tasks 9–10.

Run: `npm run remote-agent:build-linux-x86_64 && npm run remote-agent:build-linux-aarch64 && npm run remote-agent:stage-release && npm run remote-agent:verify-release && env CHATERO_REMOTE_AGENT_RELEASE_DIR=<fresh-task-8-verified-release-dir> npm run workbench:package && node products/workbench/scripts/verify-packaged-workbench.mjs --app vendor/VSCode-<platform>-<arch>/<packaged-app>`

Expected: PASS only for newly signed post-Task-8 Linux tuples and a newly built package whose linked provenance includes every Task 7/8 extension/helper/contribution/default and generated-asset digest; any Task 6 release or package fails as stale.

## Task 9: Run Disposable Installed Local and SSH Migration Smoke

**Files:**

- Create: `products/workbench/tests/documentation-migration-installed-smoke.mjs`
- Modify: `package.json`
- Modify: `docs/chatero/qmd-workspace-review.md`

**Interfaces:**

- Consumes: the fresh post-Task-8 `workbench:package` output accepted by `verifyPackagedWorkbench(...)`, its built-in signed Remote Agent release, explicit migration commands, and generated non-personal fixture builder from Tasks 1–8. It rejects the earlier Task 6 package, developer checkouts, `app/staging`, and unverified application roots.
- Produces: CLI `node products/workbench/tests/documentation-migration-installed-smoke.mjs --authority local|ssh --app <absolute-path> [--remote-agent <archive>]`; exit `0` only after receipt verification and cleanup.

- [ ] **Step 1: Write the failing smoke-driver contract test.** Export argument parsing and fixture assertions so Node tests can run without launching Electron:

```js
const options = parseSmokeArguments([
  "--authority", "local", "--app", "/tmp/Chatero.app",
]);
assert.deepEqual(options, {
  authority: "local",
  app: "/tmp/Chatero.app",
  remoteAgent: null,
});
assert.throws(() => parseSmokeArguments(["--authority", "ssh"]), /--app is required/);
assert.throws(() => assertDisposablePath("/opt/chatero-nondisposable-fixture"), /temporary fixture/);
```

- [ ] Define one generated fixture containing Knowledge/Draft page and asset collisions, structured links/routes, two valid same-path proposals, one exact duplicate, one damaged proposal, clean open working copies, and no executable QMD cell. Define crash mode to terminate the helper after the first legacy-root move, restart/reconnect, and resume from journal proof.
- [ ] The installed assertions must verify standard Text Editor plus Live Preview share the migrated QMD, reviewed-only retrieval/site behavior, proposal reviewability, quarantine listing, original/migrated blob hashes, receipt digest, legacy-root recovery copies, generic Agent reserved-root denial, and no visible Gecko window. Under `chatero_full_access`, attempt same-session read/write/rename/delete through Agent shell/file tooling against the installed local authority helper, `chatero.documentation` extension, pinned Codex tree, and installed Remote Agent tree; every operation is OS-denied while a control path outside trusted/reserved roots remains usable.
- [ ] Under all three Chatero permission profiles, directly invoke the fixed helper with forged but schema-valid `plan-migration-v2`, `execute-migration`, `inspect-migration`, and `resolve-migration` frames from Agent shell/process tooling. The inherited OS sandbox must deny access to every reserved workspace/runtime root before any helper mutation branch; assert no staging, journal, marker, receipt, or recovery evidence appears. The helper/runtime must never detach, elevate, change namespaces/sandbox, or delegate the frame to an unsandboxed process.
- [ ] From the same verified package create a separate disposable installation clone, mutate one byte/symlink/extra entry in each trusted runtime category with the privileged smoke driver (never through Agent and never in the original package), and request the corresponding helper/Codex/SSH spawn. The immediate pre-spawn full-tree verifier must return the reinstall diagnostic and prove the changed executable/module was never invoked.
- [ ] **Step 2: Run the smoke contract test and verify red.**

Run: `node --test products/workbench/tests/documentation-migration-installed-smoke.mjs`

Expected: FAIL because the smoke driver and `test:documentation:installed` script do not exist.

- [ ] **Step 3: Implement the installed driver and root command.** Require `--app` to resolve inside the exact fresh post-Task-8 `vendor/VSCode-<platform>-<arch>/` output and call `verifyPackagedWorkbench(...)` before fixture creation. Verify provenance includes the exact Task 7 migration/recovery commands and Task 8 enabled default/starter digests; reject a valid but pre-cutover Task 6 package as stale. Packaging happens only through `workbench:package`, whose direct bootstrap hardcodes `requireRemoteAgentRelease:true`; the smoke driver never rebuilds or accepts a developer bootstrap. Remove `CHATERO_REMOTE_AGENT_RELEASE_DIR` before every local and SSH launch. Use `mkdtemp` beneath the OS temporary directory for profile, workspace, and tamper-clone fixtures, reject non-temporary cleanup targets, spawn the packaged app with explicit disposable `--user-data-dir` and workspace URI, and clean up only the exact generated directories after process exit.

```json
"test:documentation:installed": "node products/workbench/tests/documentation-migration-installed-smoke.mjs"
```

```js
const fixture = await createDisposableMigrationFixture({ authority: options.authority });
try {
  await runInstalledMigration({
    ...options,
    fixture,
    crashAfter: "legacy-root-moved",
    environment: withoutKey(process.env, "CHATERO_REMOTE_AGENT_RELEASE_DIR"),
  });
  await verifyInstalledMigration({ ...options, fixture, reconnect: true });
}
finally {
  await fixture.cleanupExactTemporaryRoots();
}
```

- [ ] For `--authority ssh`, inspect the app's installed `extensions/chatero-remote/remote-agent/manifest.json`, verify its signature with the installed `runtime/release-public-key.pem`, require both supported tuple artifacts, select the requested tuple, and perform a real first connection with `CHATERO_REMOTE_AGENT_RELEASE_DIR` absent. The optional `--remote-agent` argument is a development cross-check only: when present its verified digest must equal the installed tuple artifact; it never replaces a missing installed tree. Local authority smoke also runs with the variable absent.
- [ ] Document exact developer invocations in `qmd-workspace-review.md`. Local and SSH runs require an installed/compiled app; SSH additionally requires a disposable Linux host/container. Do not silently fall back from SSH to an in-memory fixture, developer override, unsigned archive, or already-installed remote server.
- [ ] **Step 4: Run contract, installed local, and installed SSH smoke and verify green.**

Run: `node --test products/workbench/tests/documentation-migration-installed-smoke.mjs`

Expected: PASS for argument, fixture, privacy, and cleanup tests.

Run: `env -u CHATERO_REMOTE_AGENT_RELEASE_DIR node products/workbench/tests/documentation-migration-installed-smoke.mjs --authority local --app vendor/VSCode-darwin-arm64/Chatero.app`

Expected: PASS only for the verified post-Task-8 package, after one explicit migration, injected crash/restart recovery, Full Access trusted-tree denials, pre-spawn tamper refusal on a disposable clone, committed receipt verification, and exact temporary-root cleanup.

Run: `env -u CHATERO_REMOTE_AGENT_RELEASE_DIR node products/workbench/tests/documentation-migration-installed-smoke.mjs --authority ssh --app vendor/VSCode-darwin-arm64/Chatero.app`

Expected: PASS after a real disposable first SSH connection installs the signed tuple artifact from the verified package, its remote trusted tree remains Agent-inaccessible even in Full Access, and disconnect/reconnect recovery completes with no personal bytes returned to the local renderer.

- [ ] **Step 5: Commit.**

```bash
git add package.json products/workbench/tests/documentation-migration-installed-smoke.mjs docs/chatero/qmd-workspace-review.md
git commit -m "test(documentation): add installed migration smoke"
```

## Task 10: Close the Phase and Retire Legacy Production Ownership

**Files:**

- Create: `products/workbench/tests/documentation-phase-5-closure.test.mjs`
- Modify: `docs/chatero/parity-checklist.md`
- Modify: `docs/chatero/qmd-workspace-review.md`
- Modify: this plan

**Interfaces:**

- Consumes: all Task 1–9 commits and their recorded local/SSH installed results.
- Produces: `documentation-phase-5-closure.test.mjs`, final Phase 5 acceptance evidence and rollback boundary; no runtime API and no deletion of the Gecko parity oracle.

- [ ] **Step 1: Write the failing closure-evidence test and final checklist assertions.** The test parses only committed project docs/provenance, never a personal profile/workspace, and requires these exact recorded outcomes before it passes:

```text
- Documentation is enabled by default and new starters contain no current Draft/Knowledge classes.
- An exact approved plan makes zero canonical writes when stale or dirty.
- Local and SSH complete the same one-request migration and produce equivalent receipts.
- Every crash/reconnect boundary either commits, safely aborts, or preserves RecoveryConflict evidence.
- Valid legacy proposals remain reviewable; damaged proposals remain quarantined and recoverable.
- Gecko Draft/Knowledge code has no production route and remains only the development parity oracle.
```

- [ ] Require pinned Node/Electron/Code-OSS/Codex versions, exact `0005` patch digest, packaged verifier success, non-placeholder local/SSH disposable receipt digests, the six outcomes above, and an explicit rollback paragraph. Reject absolute temporary paths, fixture bodies, personal roots, unchecked acceptance evidence, `TBD`, and an unverified/developer app path.
- [ ] **Step 2: Run the closure test and verify red.**

Run: `node --test products/workbench/tests/documentation-phase-5-closure.test.mjs`

Expected: FAIL because Task 9 gate outputs and verified packaged local/SSH receipt digests have not yet been recorded.

- [ ] **Step 3: Run all repository gates and stop on the first failure.**

Run: `npm run test:documentation`

Expected: PASS with zero skipped migration, recovery, authority, or reserved-root tests.

Run: `npm run test:chatero`

Expected: PASS; the frozen Gecko parity oracle and starter regression suite remain intact.

Run: `npm run test:workbench-bootstrap`

Expected: PASS, including first-party materialization and both Remote Agent release fixtures.

Run: `npm run workbench:bootstrap && npm run workbench:verify`

Expected: PASS against the pinned Code-OSS commit and exact patch/first-party provenance.

Run: `npm run workbench:compile`

Expected: PASS under Node 24.18.0/Electron 42.7.1 with no edits under `vendor/code-oss/`.

Run: `git diff --check`

Expected: no whitespace errors; no personal profile, workspace, credential, generated checkout, app bundle, smoke output, or temporary migration evidence is tracked.

- [ ] **Step 4: Verify retirement and rollback boundaries manually.** Confirm no current command, route, starter, label, retrieval projection, site projection, or Agent instruction treats Draft/Knowledge as production authority. Confirm disabling `chatero.documentation.enabled` leaves standard Code-OSS editing and Zotero Core available; a committed workspace is not rolled back automatically, and its private recovery copies are never deleted by disable/uninstall.

```bash
rg -n 'Drafts|Knowledge|drafts/|knowledge/' AGENTS.md docs/chatero products/workbench/extensions/chatero-documentation scripts/chatero/starter/generated-files.mjs
git status --short
```

Expected: remaining matches are explicitly labeled legacy migration/parity-oracle references; status contains only intentional Phase 5 changes.

- [ ] **Step 5: Record passing command outputs and installed local/SSH receipt digests in the Phase 5 review section below.** Record only fixture IDs/digests and tool versions, never absolute temporary paths or fixture content.

- [ ] **Step 6: Re-run the closure test and verify green.**

Run: `node --test products/workbench/tests/documentation-phase-5-closure.test.mjs`

Expected: PASS only after all required non-personal evidence, exact versions/digests, packaged local/SSH receipts, retirement, and rollback boundaries are recorded.

- [ ] **Step 7: Commit the phase gate.**

```bash
git add products/workbench/tests/documentation-phase-5-closure.test.mjs docs/chatero/parity-checklist.md docs/chatero/qmd-workspace-review.md docs/superpowers/plans/2026-08-12-documentation-phase-5-migration-cutover.md
git commit -m "docs(documentation): close migration cutover gate"
```

## Phase 5 Review Checkpoint

- [ ] Tasks 1–7 passed while the feature default remained off; Task 8 changed starter, policy, routes, labels, and default in one reviewed commit only after receipt verification worked.
- [ ] The same fixed helper/protocol and conformance suite pass locally and over SSH; `chatero-remote` exports no Documentation migration authority.
- [ ] Plan token forgery/reuse/cross-scope checks, one-use approval checks, stale/dirty zero-write cases, and idempotency conflicts pass.
- [ ] Structured rewriting preserves unsupported/ambiguous source bytes and reports them; all valid legacy proposals are imported, exact duplicates are labeled, and malformed records are quarantined without deletion.
- [ ] Crash injection passes at every durable boundary; SSH disconnect after commit is an idempotent receipt lookup; unknown third-party revisions always become `RecoveryConflict` evidence.
- [ ] Disposable installed local and real first-connection SSH smoke runs pass without `CHATERO_REMOTE_AGENT_RELEASE_DIR`, without executing QMD code, and without using personal profiles/workspaces.
- [ ] New starters contain `documentation/` and `.chatero/documentation-state.v1.json`, contain no current Draft/Knowledge classes, and pass deterministic archive/privacy tests.
- [ ] Gecko Draft/Knowledge production ownership is retired, but its source remains a green development-only parity oracle until the broader atomic Workbench cutover authorizes physical removal.
- [ ] Rollback is explicit: disable the feature or revert the Task 8 product commit; never automatically reverse an already committed user migration, overwrite a recovery conflict, or delete private recovery copies.
