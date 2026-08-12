# Documentation Phase 1 Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the Documentation root, capability and transaction authority, workflow state, local/SSH contract, standard Text Editor path, and a strictly read-only legacy migration dry run behind a disabled-by-default product flag.

**Architecture:** A first-party workspace extension creates opaque workspace scopes and delegates only `snapshot`, `transact`, and `recover` through a strict client to one fixed authority-local helper. The same bounded helper protocol runs beside local and SSH workspace authority; it owns no-follow byte access, exact digests, durable operation records, idempotency, and recovery. Migration planning is one high-level `snapshot({kind:"plan-migration", limits})` request: the helper captures and compares two authority-side snapshots around the pure mapping/rewriting pass, then returns only a content-free, digest-bound plan record and bounded report model. The extension creates the opaque in-memory token; the one-shot helper remains read-only and cannot execute a migration in this phase.

**Tech Stack:** Code-OSS 1.132.0 extension APIs, Node 24.18.0, CommonJS activation, ESM domain modules, WebCrypto/Node `crypto` SHA-256, `yaml` 2.9.0, Node test runner.

## Global Constraints

- Execute only after the master plan's locked inputs and global constraints are accepted.
- Keep `chatero.documentation.enabled` defaulted to `false` for this entire phase.
- Do not register a custom QMD editor yet. `vscode.open` and `vscode.openWith(..., "default")` must remain sufficient.
- The migration command in this phase may snapshot and report. It must not create `documentation/`, state, journals, tokens, or recovery files in the selected workspace.
- Extension and renderer modules must not import Node `fs` for workspace bytes. Tests may use Node `fs` only to construct temporary fixtures. The sole production filesystem implementation is `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`, executed as a fixed child entrypoint outside the Agent sandbox.
- The helper path, executable, workspace root, request kind, and operation vocabulary are derived from an opaque scope and product code. No public function accepts a command, arbitrary helper path, absolute root, generic read/write operation, or caller-created adapter.
- Immediately before every helper spawn, the product composition root revalidates the canonical trusted Code-OSS or Remote Agent install tree and the exact Documentation helper/extension digest. A tree or helper replaced after activation fails before execution; an earlier connection-time or materialization check is not reusable as spawn authority.
- Every local/remote test uses a generated temporary workspace and a fake or fixture remote session.

---

## Phase File Map

### Create

- `products/workbench/extensions/chatero-documentation/package.json`
- `products/workbench/extensions/chatero-documentation/extension.cjs`
- `products/workbench/extensions/chatero-documentation/documentation-path.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-capabilities.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-authority-client.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-workspace.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-state.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-operations.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-transactions.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-tree.cjs`
- `products/workbench/extensions/chatero-documentation/migration-model.mjs`
- `products/workbench/extensions/chatero-documentation/migration-rewrite.mjs`
- `products/workbench/extensions/chatero-documentation/migration-planner.mjs`
- `products/workbench/extensions/chatero-documentation/media/documentation.svg`
- `products/workbench/documentation-authority/protocol.mjs`
- `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`
- `products/workbench/remote-agent/runtime/chatero-install-integrity.mjs`
- `products/workbench/tests/documentation-extension.test.mjs`
- `products/workbench/tests/documentation-authority.test.mjs`
- `products/workbench/tests/documentation-workspace.test.mjs`
- `products/workbench/tests/documentation-state.test.mjs`
- `products/workbench/tests/documentation-remote-transaction.test.mjs`
- `products/workbench/tests/documentation-migration-plan.test.mjs`
- `.github/workflows/workbench.yml`

### Modify

- `package.json`
- `package-lock.json`
- `products/workbench/first-party-extensions.json`
- `products/workbench/tests/first-party-extensions.test.mjs`
- `products/workbench/tests/remote-agent-release.test.mjs`
- `products/workbench/tests/chatero-remote-transport.test.mjs`
- `products/workbench/remote-agent/scripts/build-linux-agent.mjs`
- `products/workbench/remote-agent/scripts/stage-release.mjs`
- `products/workbench/remote-agent/release-contract.mjs`
- `products/workbench/extensions/chatero-remote/remote-agent-installer.mjs`
- `docs/chatero/parity-checklist.md`

## Task 1: Scaffold the Disabled First-Party Extension

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/package.json`
- Create: `products/workbench/extensions/chatero-documentation/extension.cjs`
- Create: `products/workbench/extensions/chatero-documentation/media/documentation.svg`
- Test: `products/workbench/tests/documentation-extension.test.mjs`
- Modify: `products/workbench/first-party-extensions.json`
- Modify: `products/workbench/tests/first-party-extensions.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: the existing first-party manifest schema `{schemaVersion: 1, extensions: [{id, files}]}` and Code-OSS `ExtensionContext`/configuration APIs.
- Produces: `activate(context: vscode.ExtensionContext): Promise<void>` and commands under `chatero.documentation.*`; it exports no authority object from the activation module.

- [ ] **Step 1: Write the failing manifest test.** Assert extension id `chatero.chatero-documentation`, Code-OSS engine `^1.132.0`, `extensionKind: ["workspace"]`, disabled default for `chatero.documentation.enabled`, an Explorer view named Documentation, and only Phase 1 commands. Start with these exact assertions:

```js
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(`${manifest.publisher}.${manifest.name}`, "chatero.chatero-documentation");
assert.equal(manifest.engines.vscode, "^1.132.0");
assert.deepEqual(manifest.extensionKind, ["workspace"]);
assert.equal(
  manifest.contributes.configuration.properties["chatero.documentation.enabled"].default,
  false,
);
```

- [ ] Assert the contributed commands are exactly `newPage`, `openSource`, `markWorking`, `markReviewed`, `planMigration`, and `refresh`; their ids use the `chatero.documentation.` prefix.
- [ ] Assert the manifest has no `customEditors`, `languageModelTools`, `webviewPanel`, or migration execution command.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-extension.test.mjs`

Expected: FAIL with `ENOENT` for `extensions/chatero-documentation/package.json`.

- [ ] **Step 3: Create the manifest and minimal activation.** Use this exact configuration shape and register the view/commands only when enabled:

```json
{
  "name": "chatero-documentation",
  "publisher": "chatero",
  "version": "0.1.0",
  "engines": { "vscode": "^1.132.0" },
  "extensionKind": ["workspace"],
  "main": "./extension.cjs",
  "capabilities": {
    "untrustedWorkspaces": { "supported": true },
    "virtualWorkspaces": false
  }
}
```

```js
async function activate(context) {
  const vscode = require("vscode");
  const enabled = vscode.workspace
    .getConfiguration("chatero.documentation")
    .get("enabled", false) === true;
  await vscode.commands.executeCommand("setContext", "chatero.documentation.enabled", enabled);
  if (!enabled) return;
  const { registerDocumentation } = require("./documentation-tree.cjs");
  context.subscriptions.push(...await registerDocumentation(vscode, context));
}

module.exports = { activate };
```

- [ ] Catch activation errors at the outer registration boundary, publish one Documentation diagnostic/output entry, and return without importing or starting Zotero Core.
- [ ] Add only `package.json`, `extension.cjs`, and `media/documentation.svg` to the new `chatero.documentation` first-party manifest entry. Later tasks append their files only after those files exist; never add a directory glob or generated checkout path.
- [ ] Extend `first-party-extensions.test.mjs` with a three-extension fixture assertion so materialization and provenance include `chatero.documentation` without weakening path, symlink, size, or unexpected-file checks.
- [ ] Add `"test:documentation": "node --test products/workbench/tests/documentation-*.test.mjs"` to root scripts.
- [ ] **Step 4: Run the scoped tests and verify green.**

Run: `node --test products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/first-party-extensions.test.mjs`

Expected: PASS with zero skipped tests.

- [ ] **Step 5: Commit.**

```bash
git add package.json products/workbench/first-party-extensions.json products/workbench/extensions/chatero-documentation products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "feat(documentation): scaffold authority extension"
```

## Task 2: Define Canonical Paths and Opaque Capabilities

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/documentation-path.mjs`
- Create: `products/workbench/extensions/chatero-documentation/documentation-capabilities.mjs`
- Test: `products/workbench/tests/documentation-authority.test.mjs`

**Interfaces:**

- Consumes: a workspace identity `{uri, authority, epoch}` created only by the extension composition root.
- Produces: `documentationPagePath(value)`, `documentationAssetPath(value)`, `validateOperationPathSet(operations)`, and `createDocumentationCapabilityIssuer({clock, randomUUID})`; the issuer returns `issueScope`, `issueAgentProposalGrant`, `issueHumanApproval`, `issueMigrationApproval`, `issueRecoveryApproval`, and matching consuming methods.

- [ ] **Step 1: Add failing path and capability tests.** Start with this table and extend it with percent-encoded traversal, NUL/control characters, query/fragment characters, duplicate separators, and paths outside `documentation/`:

```js
for (const value of ["", "/index.qmd", "file:///index.qmd", "..\\index.qmd", "a/../b.qmd"] ) {
  assert.throws(() => documentationPagePath(value), { name: "TypeError" });
}
assert.equal(documentationPagePath("topics/result.qmd").value, "topics/result.qmd");
```

- [ ] Add positive tests for normalized page paths such as `index.qmd` and `topics/result.qmd`, plus support assets that remain non-page paths.
- [ ] Add set-level tests that reject duplicate paths, case-fold aliases, file-ancestor collisions, rename cycles, duplicate targets, and source/destination overlap.
- [ ] Add this identity-forgery/replay assertion before implementation:

```js
const issuer = createDocumentationCapabilityIssuer({ clock, randomUUID });
const scope = issuer.issueScope({ uri: workspaceUri, authority: "local", epoch: "epoch-1" });
const approval = issuer.issueHumanApproval(scope, { digest: requestDigest, expiresInMs: 30_000 });
assert.throws(() => issuer.consumeHumanApproval(structuredClone(approval), requestDigest), /unrecognized capability/);
assert.equal(issuer.consumeHumanApproval(approval, requestDigest).epoch, "epoch-1");
assert.throws(() => issuer.consumeHumanApproval(approval, requestDigest), /already consumed/);
```

- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-authority.test.mjs`

Expected: FAIL because `documentation-path.mjs` and `documentation-capabilities.mjs` do not exist.

- [ ] **Step 3: Implement branded frozen paths and private capabilities.** The public return shape is exact and carries no absolute root:

```js
export function documentationPagePath(value) {
  const normalized = normalizeDocumentationRelativePath(value);
  if (!normalized.toLowerCase().endsWith(".qmd")) {
    throw new TypeError("Documentation pages must use .qmd");
  }
  return Object.freeze({ kind: "documentation-page", value: normalized });
}

export function createDocumentationCapabilityIssuer({ clock, randomUUID }) {
  const records = new WeakMap();
  const consumed = new WeakSet();
  return Object.freeze({
    issueScope,
    issueAgentProposalGrant,
    issueHumanApproval,
    issueMigrationApproval,
    issueRecoveryApproval,
    consumeHumanApproval,
    consumeMigrationApproval,
    consumeRecoveryApproval,
  });
}
```

- [ ] Implement `documentationAssetPath`, `documentationWorkspaceUri`, and `validateOperationPathSet`; reject aliases before issuing any capability. Never accept a caller-supplied absolute root after scope issuance.
- [ ] Implement `createDocumentationCapabilityIssuer()` with module-private `WeakMap` records for `OpaqueWorkspaceScope`, `AgentProposalGrant`, `HumanApproval`, `MigrationApproval`, and `RecoveryApproval`. Bind workspace URI, authority, epoch, expiry, one-use state, and canonical request digest; an Agent grant additionally binds normalized path prefixes, allowed operation kinds, maximum operation count, and maximum proposed bytes.
- [ ] Make `consumeHumanApproval`, `consumeMigrationApproval`, and `consumeRecoveryApproval` reject JSON clones, wrong authority, wrong epoch, expired values, digest mismatch, and second consumption before invoking an adapter.
- [ ] Add a test proving the module exports issuers/consumers through an authority instance but exports no token constructor, backing map, workspace root string, or generic file method.
- [ ] **Step 4: Run the focused test and verify green.**

Run: `node --test products/workbench/tests/documentation-authority.test.mjs`

Expected: PASS, including forgery, expiry, wrong-scope, digest, and replay cases.

- [ ] **Step 5: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/documentation-path.mjs products/workbench/extensions/chatero-documentation/documentation-capabilities.mjs products/workbench/tests/documentation-authority.test.mjs
git commit -m "feat(documentation): add path and capability authority"
```

## Task 3: Define Exact Snapshots and the Fixed Helper Protocol

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/documentation-workspace.mjs`
- Create: `products/workbench/documentation-authority/protocol.mjs`
- Test: `products/workbench/tests/documentation-workspace.test.mjs`

**Interfaces:**

- Consumes: opaque scopes and branded paths from Task 2 plus a private `AuthorityTransport.request(frame, signal): Promise<string>`.
- Produces: `encodeAuthorityRequest(request): string`, `decodeAuthorityRequest(frame): AuthorityRequest`, `encodeAuthorityResponse(response): string`, `decodeAuthorityResponse(frame): AuthorityResponse`, `createDocumentationWorkspaceView({workspaceFolders, textDocuments})`, and `createWorkspaceTransactionAdapter({scope, transport, workspaceView})` with only `snapshot`, `transact`, and `recover`.

- [ ] **Step 1: Write a failing protocol/adapter conformance test.** The fake transport accepts one frame per call and records complete request kinds:

```js
const frames = [];
const transport = {
  async request(frame) {
    frames.push(decodeAuthorityRequest(frame));
    return encodeAuthorityResponse({
      protocolVersion: 1,
      requestId: frames.at(-1).requestId,
      result: { kind: "snapshot", epoch: "epoch-1", entries: [] },
    });
  },
};
const adapter = createWorkspaceTransactionAdapter({ scope, transport, workspaceView });
assert.equal((await adapter.snapshot({ kind: "paths", paths: [] })).kind, "snapshot");
assert.deepEqual(frames.map(frame => frame.kind), ["snapshot"]);
assert.equal(adapter.read, undefined);
```

- [ ] Add failing tests for SHA-256 exact-byte revisions, target-absent preconditions, directory-entry generations, open dirty `TextDocument` overlays, symlink/junction ancestors, foreign URI authorities, and a workspace epoch change during a request.
- [ ] Define only these adapter methods: `snapshot(request)`, `transact(completeRequest)`, and `recover(request)`. Assert there is no public `read`, `write`, `exists`, `realpath`, or raw adapter escape hatch.
- [ ] Define `SnapshotRequest` as an exact union. Ordinary evidence requests are `{kind:"paths",paths}`; migration planning is exactly `{kind:"plan-migration",limits}` and returns a content-free plan result rather than legacy bodies. Define the matching `SnapshotResult = WorkspaceSnapshot | MigrationPlanSnapshot`; no caller may combine the migration kind with raw paths, an output root, or a write flag.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-workspace.test.mjs`

Expected: FAIL because the protocol and workspace adapter exports are missing.

- [ ] **Step 3: Define and validate the exact frame shape.** Use version `1`, canonical JSON encoded as base64url, a 96 MiB decoded-JSON ceiling and 128 MiB encoded-text ceiling in either direction, duplicate-key rejection, and exact-field validation at every object level. This carries at most 64 MiB of raw snapshot/proposal bytes after nested base64 expansion; individual operations apply stricter limits:

```js
const REQUEST_KINDS = Object.freeze(["snapshot", "transact", "recover"]);

export function encodeAuthorityRequest(request) {
  const validated = validateAuthorityRequest(request);
  const bytes = Buffer.from(canonicalJSON(validated), "utf8");
  if (bytes.byteLength > 96 * 1024 * 1024) throw new RangeError("authority request is too large");
  return bytes.toString("base64url");
}

export function decodeAuthorityResponse(frame) {
  if (Buffer.byteLength(frame, "ascii") > 128 * 1024 * 1024) {
    throw new RangeError("authority response frame is too large");
  }
  const bytes = Buffer.from(assertBase64url(frame), "base64url");
  if (bytes.byteLength > 96 * 1024 * 1024) throw new RangeError("authority response is too large");
  return validateAuthorityResponse(parseJsonWithoutDuplicateKeys(bytes.toString("utf8")));
}
```

- [ ] Implement the matching request decoder and response encoder; request fields include `protocolVersion`, `requestId`, `kind`, `workspace`, `epoch`, and one exact `snapshot | transaction | recovery` payload.
- [ ] Implement `createDocumentationWorkspaceView({ workspaceFolders, textDocuments })` only for URI resolution and open-document overlays. It must not expose or import a filesystem implementation. Its exact overlay shape is:

```js
{
  uri: document.uri.toString(true),
  version: document.version,
  dirty: document.isDirty,
  text: document.getText(),
  revision: `text-document:${document.version}:sha256:${sha256Utf8(document.getText())}`,
}
```

- [ ] Represent a saved revision as `sha256:<64 lowercase hex>` and an open revision as `text-document:<version>:sha256:<digest>`; retain exact bytes in private snapshot evidence, not in user-facing reports.
- [ ] Implement an in-memory authority transport used only by contract tests. It must recheck all preconditions immediately before its first mutation and return typed stale/conflict results.
- [ ] **Step 4: Run the focused test and verify green.**

Run: `node --test products/workbench/tests/documentation-workspace.test.mjs`

Expected: PASS with one complete frame per adapter call and no generic file methods.

- [ ] **Step 5: Commit.**

```bash
git add products/workbench/documentation-authority/protocol.mjs products/workbench/extensions/chatero-documentation/documentation-workspace.mjs products/workbench/tests/documentation-workspace.test.mjs
git commit -m "feat(documentation): define authority transaction protocol"
```

## Task 4: Implement Whole-Snapshot Workflow State

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/documentation-state.mjs`
- Test: `products/workbench/tests/documentation-state.test.mjs`

**Interfaces:**

- Consumes: branded page paths and saved revisions from Tasks 2–3.
- Produces: `parseDocumentationState(bytes)`, `projectDocumentationState({pages, parsed})`, `nextStateGeneration(generation)`, and `serializeDocumentationState(state): Uint8Array`.

- [ ] **Step 1: Add failing schema and safe-default tests.** Begin with:

```js
const valid = parseDocumentationState(Buffer.from(
  '{"schemaVersion":1,"generation":"0000000000000001","documents":{"index.qmd":{"state":"reviewed"}}}\n',
));
assert.equal(valid.kind, "valid");
assert.equal(valid.state.documents["index.qmd"].state, "reviewed");

for (const bytes of [Buffer.from("{"), Buffer.from('{"schemaVersion":2}')]) {
  const projected = projectDocumentationState({ pages: [documentationPagePath("index.qmd")], parsed: parseDocumentationState(bytes) });
  assert.equal(projected.documents["index.qmd"].state, "working");
  assert.equal(projected.diagnostics.length, 1);
}
```

- [ ] Add tests for the exact schema `{schemaVersion:1,generation,documents}`, fixed-width 16-digit lowercase hexadecimal generations, sorted normalized page keys, and only `working | reviewed` state values.
- [ ] Test safe defaults: missing file, missing entry, new page, orphan entry, corrupt JSON, unknown field, unsupported schema, invalid path, duplicate/case alias, invalid generation, and partially valid content all produce an all-working projection plus one diagnostic.
- [ ] Test that ordinary same-path byte replacement preserves a valid existing state, while external rename appears as orphan old plus new working.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-state.test.mjs`

Expected: FAIL because `parseDocumentationState` is not defined.

- [ ] **Step 3: Implement the exact state shape.** Serialization must sort page keys and produce deterministic UTF-8 JSON with one trailing newline:

```js
export function serializeDocumentationState(state) {
  const documents = Object.fromEntries(
    Object.entries(state.documents).sort(([left], [right]) => compareUtf8Bytes(left, right)),
  );
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    generation: state.generation,
    documents,
  })}\n`, "utf8");
}

export function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function nextStateGeneration(value) {
  const next = BigInt(`0x${assertGeneration(value)}`) + 1n;
  if (next > 0xffffffffffffffffn) throw new RangeError("state generation overflow");
  return next.toString(16).padStart(16, "0");
}
```

- [ ] Implement strict parse and whole-snapshot projection; an invalid object cannot contribute any apparently valid document entry. Reuse `compareUtf8Bytes` for every normalized state key, path proof, mapping, manifest, and canonical JSON object/array order in this and later phases; never use `localeCompare` or process locale for digest-bearing order. Test non-ASCII paths under at least two distinct process locales and require byte-identical serialized bytes/digests locally and over SSH.
- [ ] Return diagnostics as structured `{code,path,message}` values; never silently salvage individual entries from a rejected snapshot.
- [ ] **Step 4: Run focused and aggregate tests and verify green.**

Run: `node --test products/workbench/tests/documentation-state.test.mjs && npm run test:documentation`

Expected: both commands PASS.

- [ ] **Step 5: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/documentation-state.mjs products/workbench/tests/documentation-state.test.mjs
git commit -m "feat(documentation): add conservative workflow state"
```

## Task 5: Make State Changes Recoverable and Idempotent

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/documentation-operations.mjs`
- Create: `products/workbench/extensions/chatero-documentation/documentation-transactions.mjs`
- Test: `products/workbench/tests/documentation-state.test.mjs`
- Test: `products/workbench/tests/documentation-workspace.test.mjs`

**Interfaces:**

- Consumes: `WorkspaceTransactionAdapter`, `DocumentationState`, and capability consumers from Tasks 2–4.
- Produces: `canonicalOperationDigest(input): string`, `createDocumentationTransactions({adapter, capabilities, workspaceView})`, `transactions.state(scope)`, and `transactions.setDocumentState(approval, input)`.

- [ ] **Step 1: Add failing state-transaction tests.** Bind the request to the exact document revision and state generation:

```js
const input = Object.freeze({
  path: documentationPagePath("index.qmd"),
  expectedDocumentRevision: pageRevision,
  expectedStateGeneration: "0000000000000001",
  state: "reviewed",
  idempotencyKey: "state-index-reviewed-1",
});
const digest = canonicalOperationDigest(input);
const approval = capabilities.issueHumanApproval(scope, { digest, expiresInMs: 30_000 });
assert.deepEqual(await transactions.setDocumentState(approval, input), {
  kind: "state-committed",
  generation: "0000000000000002",
  receipt: "state-index-reviewed-1",
});
```

- [ ] Extend tests with an operation record for every state transition: `prepared`, `applying`, `metadata-applied`, and `committed`. Inject a crash after each durable step and verify retry/recovery behavior.
- [ ] Add tests for same-key/same-digest replay, same-key/different-digest conflict, stale document revision, stale state generation, dirty document, expired approval, and an unrecognized state-file revision during recovery.
- [ ] Verify `markReviewed` requires the exact clean saved revision the user inspected; `markWorking` uses the same revision binding and never silently saves.
- [ ] **Step 2: Run the focused tests and verify red.**

Run: `node --test products/workbench/tests/documentation-state.test.mjs products/workbench/tests/documentation-workspace.test.mjs`

Expected: FAIL because `canonicalOperationDigest` and `createDocumentationTransactions` are missing.

- [ ] **Step 3: Implement canonical request hashing and the narrow facade.** The facade must have exactly this Phase 1 surface:

```js
export function createDocumentationTransactions({ adapter, capabilities, workspaceView }) {
  return Object.freeze({
    state: scope => readProjectedState({ adapter, capabilities, workspaceView, scope }),
    setDocumentState: (approval, input) => setDocumentState({
      adapter,
      capabilities,
      workspaceView,
      approval,
      input,
    }),
  });
}
```

- [ ] Write `.chatero/documentation-operations/<operation-id>/operation.v1.json` through the adapter contract. Its exact stable fields are `schemaVersion`, `operationId`, `idempotencyKey`, `requestDigest`, `workspaceEpoch`, `phase`, `before`, `intended`, and `result`; it contains no capability or personal absolute root.
- [ ] Implement `state(scope)` and `setDocumentState(approval,input)`. Keep `stage`, `review`, `settle`, `migrate`, and `resolveRecovery` absent in this phase rather than shipping feature-unavailable stubs.
- [ ] On recovery, apply or restore only when current digests match a journaled before/intermediate/intended digest; otherwise return `recovery-conflict` with a private evidence reference.
- [ ] **Step 4: Run the focused tests and verify green.**

Run: `node --test products/workbench/tests/documentation-state.test.mjs products/workbench/tests/documentation-workspace.test.mjs`

Expected: PASS for every injected phase and idempotency case.

- [ ] **Step 5: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/documentation-operations.mjs products/workbench/extensions/chatero-documentation/documentation-transactions.mjs products/workbench/tests/documentation-state.test.mjs products/workbench/tests/documentation-workspace.test.mjs
git commit -m "feat(documentation): transact state changes safely"
```

## Task 6: Expose Status Commands and the Documentation Explorer

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/documentation-tree.cjs`
- Modify: `products/workbench/extensions/chatero-documentation/extension.cjs`
- Test: `products/workbench/tests/documentation-extension.test.mjs`

**Interfaces:**

- Consumes: the Task 5 transaction facade and `vscode.workspace.textDocuments`.
- Produces: `registerDocumentation(vscode, context): Promise<vscode.Disposable[]>` and `DocumentationTreeProvider` implementing `getTreeItem`, `getChildren`, `refresh`, and `onDidChangeTreeData`.

- [ ] **Step 1: Build a failing fake-`vscode` activation test.** Record command registration and require source opening to use the default editor:

```js
const harness = createVscodeHarness({ trusted: true, enabled: true });
const disposables = await registerDocumentation(harness.vscode, harness.context);
await harness.commands.run("chatero.documentation.openSource", pageUri);
assert.deepEqual(harness.commands.executed.at(-1), ["vscode.openWith", pageUri, "default"]);
assert.ok(disposables.every(value => typeof value.dispose === "function"));
```

- [ ] Add failing cases for tree refresh, new human page, mark working, mark reviewed, save-before-review prompt, state diagnostics, and an empty/missing Documentation root.
- [ ] Assert the view and read-only source-open path work in an untrusted workspace, while `newPage`, state mutations, and migration planning fail before capability issuance until `workspace.isTrusted` is true.
- [ ] Assert `newPage` rejects non-QMD names and path aliases, creates exact user-entered initial bytes through one transaction, and records `working` state.
- [ ] Assert `openSource` calls `vscode.openWith(uri, "default")`; no command routes a Documentation page to Gecko, a browser, or a hidden custom editor.
- [ ] Assert a dirty Mark Reviewed command offers Save, waits for successful save/document version stabilization, then issues a one-use exact approval; Cancel performs no workspace mutation.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-extension.test.mjs`

Expected: FAIL because `registerDocumentation` and `DocumentationTreeProvider` are missing.

- [ ] **Step 3: Implement the provider and command registration.** Tree items use this exact context vocabulary:

```js
class DocumentationTreeProvider {
  constructor({ transactions, scope, diagnostics }) {
    this.transactions = transactions;
    this.scope = scope;
    this.diagnostics = diagnostics;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  refresh() { this.changed.fire(undefined); }
}

const PAGE_CONTEXT_VALUES = Object.freeze([
  "documentation.page.working",
  "documentation.page.reviewed",
  "documentation.page.orphan",
  "documentation.page.diagnostic",
]);
```

- [ ] Complete `getTreeItem`/`getChildren`, cancellable bounded traversal, state icons, diagnostic projection, and command handlers wired only to `transactions` and normal TextDocument APIs.
- [ ] Keep tree reads bounded and cancellable. A corrupt state file still lists pages as working and surfaces a Problems diagnostic.
- [ ] **Step 4: Run the focused test and verify green.**

Run: `node --test products/workbench/tests/documentation-extension.test.mjs`

Expected: PASS in trusted, untrusted, missing-root, and corrupt-state fixtures.

- [ ] **Step 5: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/extension.cjs products/workbench/extensions/chatero-documentation/documentation-tree.cjs products/workbench/tests/documentation-extension.test.mjs
git commit -m "feat(documentation): add explorer and state commands"
```

## Task 7: Bind Cached SSH Installs to the Signed Tree

**Files:**

- Create: `products/workbench/remote-agent/runtime/chatero-install-integrity.mjs`
- Modify: `products/workbench/remote-agent/scripts/build-linux-agent.mjs`
- Modify: `products/workbench/remote-agent/scripts/stage-release.mjs`
- Modify: `products/workbench/remote-agent/release-contract.mjs`
- Modify: `products/workbench/extensions/chatero-remote/remote-agent-installer.mjs`
- Test: `products/workbench/tests/remote-agent-release.test.mjs`
- Test: `products/workbench/tests/chatero-remote-transport.test.mjs`

**Interfaces:**

- Consumes: the existing signed Remote Agent archive, manifest, installer, and immutable install path.
- Produces: release artifact fields `treeManifestSha256`, `nodeSha256`, and `integrityVerifierSha256`; `verifyInstallTree({root, manifestBytes, expectedTreeDigest})`; and remote installer calls that carry all signed integrity fields into `probeInstalled`, `finalize`, and `createRuntime`.

- [ ] **Step 1: Add failing release-contract and installed-tree tests.** Require all three new signed fields:

```js
const artifact = Object.freeze({
  tuple: "linux-x86_64",
  filename: "chatero-agent-linux-x86_64.tar.gz",
  sha256: "a".repeat(64),
  size: 4096,
  treeManifestSha256: "b".repeat(64),
  nodeSha256: "c".repeat(64),
  integrityVerifierSha256: "d".repeat(64),
});
assert.deepEqual(selectArtifact(await verifyRelease(signedRelease(artifact)), {
  commit: CODE_OSS_COMMIT,
  tuple: "linux-x86_64",
}), artifact);
```

- [ ] Add release/installer tests that alter, remove, add, chmod, or redirect each class of installed path (server, Node, process/evidence/integrity helpers, built-in extension files including Documentation, Codex SDK, notices, tree manifest, and the allowed Codex shim). `probeInstalled` and `createRuntime` must reject every changed tree even when its owner-only marker still contains the expected artifact SHA-256.
- [ ] Add a positive replay test proving an unchanged install is reusable without upload, and a tamper test proving the next connection re-uploads from the already verified local artifact before it executes any cached binary.
- [ ] **Step 2: Run the release and transport tests and verify red.**

Run: `node --test products/workbench/tests/remote-agent-release.test.mjs products/workbench/tests/chatero-remote-transport.test.mjs`

Expected: FAIL because artifact integrity fields and `chatero-install-integrity.mjs` are missing and marker-only probe fixtures incorrectly return ready.

- [ ] **Step 3: Generate and sign the exact tree contract.** `stage-release.mjs` writes `integrity/tree.v1.json` after all payload mutation and before deterministic packing. Each sorted record has this exact shape:

```js
Object.freeze({
  path: "bin/chatero-server",
  type: "file",
  mode: "0755",
  size: 12345,
  sha256: "e".repeat(64),
});
```

- [ ] File records carry `sha256`; directory records carry only `{path,type:"directory",mode}`; the sole allowed symlink record carries `{path,type:"symlink",target:"../@openai/codex/bin/codex.js"}`. Reject absolute/empty/dot/control-character paths, duplicate/case-fold aliases, ancestor collisions, unsafe modes, hard-linked files, devices, sockets, extra symlinks, and every unlisted entry. The manifest excludes only itself and the install-time `.chatero-release-sha256` marker.
- [ ] Add `treeManifestSha256`, `nodeSha256`, and `integrityVerifierSha256` to each artifact record before signing `manifest.json`. `release-contract.mjs` requires exactly those fields and 64 lowercase hexadecimal values.
- [ ] Implement `verifyInstallTree` with no-follow traversal and exact entry/content/mode/link comparison. It accepts no exclusions beyond the two named above and emits only `{kind:"verified", treeManifestSha256}` or a typed integrity failure without executing payload content.
- [ ] Replace marker-only `verify_install` with a call to the integrity verifier after shell-level SHA-256 checks of the tree manifest, bundled Node, and verifier against signed artifact metadata. Verify exact entries, content, modes, and the one allowlisted Codex shim target on every `probeInstalled` and immediately before `createRuntime`; an invalid cached install reports missing and is never executed.
- [ ] **Step 4: Run the release and transport tests and verify green.**

Run: `node --test products/workbench/tests/remote-agent-release.test.mjs products/workbench/tests/chatero-remote-transport.test.mjs`

Expected: PASS for both signed tuples, unchanged reuse, every tamper class, reinstall, and pre-runtime revalidation.

- [ ] **Step 5: Commit.**

```bash
git add products/workbench/extensions/chatero-remote/remote-agent-installer.mjs products/workbench/remote-agent/release-contract.mjs products/workbench/remote-agent/runtime/chatero-install-integrity.mjs products/workbench/remote-agent/scripts/build-linux-agent.mjs products/workbench/remote-agent/scripts/stage-release.mjs products/workbench/tests/remote-agent-release.test.mjs products/workbench/tests/chatero-remote-transport.test.mjs
git commit -m "fix(remote): verify the complete signed agent tree"
```

## Task 8: Implement and Package the Authority-Local Helper

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/documentation-authority-client.mjs`
- Create: `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`
- Modify: `products/workbench/remote-agent/scripts/build-linux-agent.mjs`
- Modify: `products/workbench/remote-agent/scripts/stage-release.mjs`
- Modify: `products/workbench/first-party-extensions.json`
- Test: `products/workbench/tests/documentation-remote-transaction.test.mjs`
- Test: `products/workbench/tests/first-party-extensions.test.mjs`
- Test: `products/workbench/tests/remote-agent-release.test.mjs`

**Interfaces:**

- Consumes: the Task 3 frame codec, `OpaqueWorkspaceScope` records resolved privately by Task 2, and the tree-bound release pipeline from Task 7.
- Produces: private `createFixedAuthorityTransport({extensionUri, processPath, spawn, verifyTrustedRuntime})`, public-facade-internal `createDocumentationAuthorityClient({scope, workspaceView, fixedTransport})`, and helper CLI `runDocumentationAuthority({stdin, stdout, filesystem, clock})`. The production `verifyTrustedRuntime` is fixed by the composition root and cannot be supplied through the public facade.

- [ ] **Step 1: Add failing fixed-helper protocol tests.** A transaction frame contains the complete logical request and the process argv contains no workspace path:

```js
const spawnCalls = [];
const transport = createFixedAuthorityTransport({
  extensionUri: Uri.file("/product/extensions/chatero-documentation"),
  processPath: "/product/node",
  electron: false,
  spawn: captureSpawn(spawnCalls, responseFrame),
});
await transport.request(frame);
const invocation = spawnCalls[0];
assert.deepEqual(invocation.args, [
  "/product/extensions/chatero-documentation/runtime/chatero-documentation-authority.mjs",
]);
assert.equal(invocation.options.shell, false);
assert.equal(invocation.stdin, `${frame}\n`);
assert.equal(invocation.args.some(value => value.includes("workspace-fixture")), false);
```

- [ ] Assert the decoded request contains `workspace`, `epoch`, complete preconditions, intended outputs, state transition, idempotency key, and operation digest.
- [ ] Test canonical base64url framing, maximum request/output bytes, stale workspace epoch, disconnect before response, duplicate response, malformed JSON, symlink escape, case alias, target race, and helper exit after each operation state.
- [ ] Verify integrity on every spawn. After one successful request, replace or mutate the helper, protocol, extension tree, bundled runtime, or another installed-tree entry and assert the next local and SSH request fails before `spawn` is called, even though the same extension host/session previously passed activation or connection verification.
- [ ] Assert one state transaction creates exactly one framed helper request; extension and renderer code must not issue per-file remote writes.
- [ ] Add local-memory and remote-fixture conformance cases that compare typed results and final logical snapshots byte-for-byte.
- [ ] **Step 2: Run the helper tests and verify red.**

Run: `node --test products/workbench/tests/documentation-remote-transaction.test.mjs`

Expected: FAIL because the fixed invocation, client, and helper entrypoint do not exist.

- [ ] **Step 3: Implement the fixed invocation and one-frame transport.** Use this exact invocation shape; the production factory remains private to `extension.cjs`:

```js
function makeFixedHelperInvocation({ processPath, helperPath, frame, electron }) {
  return Object.freeze({
    command: processPath,
    args: Object.freeze([helperPath]),
    stdin: `${frame}\n`,
    options: Object.freeze({
      shell: false,
      windowsHide: true,
      env: Object.freeze(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    }),
  });
}
```

- [ ] Before calling `makeFixedHelperInvocation` on every request, await the product-owned `verifyTrustedRuntime()` and compare its canonical root and helper/extension digests with the provenance-pinned values captured by the composition root. For SSH this re-runs complete installed-tree verification; for a packaged local workbench it revalidates the signed/materialized first-party tree. Never execute a helper from a merely previously verified path.
- [ ] Implement the helper with `lstat`/`realpath`/no-follow traversal, owner-only staging, exclusive creates, file and directory fsync, lease acquisition, digest preconditions, deterministic dependency order, immutable receipts, and evidence-preserving recovery. It reads exactly one newline-terminated bounded stdin frame and emits exactly one bounded stdout frame; both sides count bytes incrementally and terminate before buffering beyond the Task 3 cap. Workspace paths never appear in argv, environment, logs, or generated shell source.
- [ ] Implement `createDocumentationAuthorityClient({ scope, workspaceView, fixedTransport })`. The private production composition root derives the materialized helper URI and chooses local Electron Node mode or remote Node mode; tests inject a framed transport below the public facade, never a caller-selected program or path.
- [ ] Append all production files created through Task 8 plus the shared protocol/helper to `first-party-extensions.json`, with the shared files materialized as `extensions/chatero-documentation/runtime/protocol.mjs` and `runtime/chatero-documentation-authority.mjs`.
- [ ] Update Remote Agent build and release validation so both signed Linux tuples must already contain the exact provenance-pinned Documentation workspace extension and helper bytes produced by Code-OSS packaging. Regenerate the Task 7 tree manifest after those files are present; validation must fail rather than copy a missing built-in or helper into the finished payload.
- [ ] Prove the same installed helper serves `file:` locally and `vscode-remote://chatero-remote+...` in the remote workspace extension host, while foreign authorities and stale epochs fail closed.
- [ ] **Step 4: Run helper, materialization, and release tests and verify green.**

Run: `node --test products/workbench/tests/documentation-remote-transaction.test.mjs products/workbench/tests/first-party-extensions.test.mjs products/workbench/tests/remote-agent-release.test.mjs`

Expected: PASS for memory, local process, SSH fixture, x86_64 release, and aarch64 release cases.

- [ ] **Step 5: Commit.**

```bash
git add products/workbench/documentation-authority products/workbench/extensions/chatero-documentation products/workbench/first-party-extensions.json products/workbench/remote-agent/scripts/build-linux-agent.mjs products/workbench/remote-agent/scripts/stage-release.mjs products/workbench/tests/documentation-remote-transaction.test.mjs products/workbench/tests/first-party-extensions.test.mjs products/workbench/tests/remote-agent-release.test.mjs
git commit -m "feat(documentation): add local and SSH transaction authority"
```

## Task 9: Build the Read-Only Migration Model and Structured Rewriter

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/migration-model.mjs`
- Create: `products/workbench/extensions/chatero-documentation/migration-rewrite.mjs`
- Test: `products/workbench/tests/documentation-migration-plan.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: exact legacy entries held inside the authority helper's private snapshot evidence and branded destination paths from Task 2.
- Produces: pure, deterministic `buildLegacyMigrationMapping({knowledge, drafts, documentation})`, `rewriteLegacyReferences({sourcePath, destinationPath, bytes, mapping})`, and `classifyLegacyProposals({records, blobs, mapping})`. Task 10 invokes these inside the authority-local helper; their direct unit tests never make them a renderer or extension-host byte-reading path.

- [ ] **Step 1: Add failing mapping and rewrite fixtures.** Establish Knowledge precedence and deterministic Draft preservation:

```js
const mapping = buildLegacyMigrationMapping({
  knowledge: [{ path: "topic.qmd", revision: "sha256:knowledge" }],
  drafts: [{ path: "topic.qmd", revision: "sha256:draft" }],
  documentation: [],
});
assert.deepEqual(mapping.pages.map(entry => [entry.sourceRoot, entry.destination.value, entry.state]), [
  ["knowledge", "topic.qmd", "reviewed"],
  ["drafts", "_migrated/drafts/topic.qmd", "working"],
]);
```

- [ ] Extend the table with Knowledge-only, Draft-only, equal-content collision, asset collision, nested paths, file-ancestor collision, case-fold collision, and the deterministic `_migrated[-n]/drafts` search.
- [ ] Add reference fixtures covering Markdown links/images, QMD cross-references, YAML `project.render`, `website.navbar`, `website.sidebar`, Main Site routes, code fences, inline code, raw blocks, external URLs, and ambiguous strings.
- [ ] Assert only proven workspace-relative targets are rewritten, line endings and unrelated bytes are preserved, and every unsupported/ambiguous candidate appears in follow-up diagnostics.
- [ ] Add legacy proposal cases for valid schema v2, multiple proposals for one original path, exact duplicate content, malformed JSON, missing blobs, digest mismatch, unsafe path, and unknown schema.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-migration-plan.test.mjs`

Expected: FAIL because the migration model and structured rewriter are missing.

- [ ] **Step 3: Pin the structured YAML dependency.** Run `npm install --save-exact yaml@2.9.0`; verify `package.json` contains `"yaml": "2.9.0"` and the lockfile contains its npm integrity.
- [ ] Implement immutable mapping records with this exact shape and the conflict-root algorithm in `migration-model.mjs`:

```js
Object.freeze({
  kind: "page",
  sourceRoot: "knowledge",
  sourcePath: "topic.qmd",
  sourceRevision: "sha256:knowledge",
  destination: documentationPagePath("topic.qmd"),
  state: "reviewed",
  reason: "knowledge-precedence",
});
```

- [ ] Implement source-coordinate edits for Markdown/QMD references. `rewriteLegacyReferences` returns this complete union and applies edits from highest offset to lowest:

```js
{
  kind: "rewritten",
  bytes: Uint8Array,
  edits: [{ from: 42, to: 62, replacement: "documentation/topic.qmd", syntax: "markdown-link" }],
  followUps: [{ from: 90, to: 110, code: "ambiguous-reference" }],
}
```

- [ ] Parse only `project.render`, `website.navbar`, `website.sidebar`, and approved Main Site route fields with `yaml@2.9.0`, preserving all untouched source slices; never stringify the entire QMD document from an AST.
- [ ] Implement proposal classification that records raw base/proposed digests and planned migrated base/proposed digests without writing a converted Change Set.
- [ ] **Step 4: Run the focused test and verify green.**

Run: `node --test products/workbench/tests/documentation-migration-plan.test.mjs`

Expected: PASS with byte-for-byte preservation outside returned edit ranges.

- [ ] **Step 5: Commit.**

```bash
git add package.json package-lock.json products/workbench/extensions/chatero-documentation/migration-model.mjs products/workbench/extensions/chatero-documentation/migration-rewrite.mjs products/workbench/tests/documentation-migration-plan.test.mjs
git commit -m "feat(documentation): model deterministic migration rewrites"
```

## Task 10: Produce an Immutable Read-Only Dry-Run Report

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/migration-planner.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/extension.cjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-transactions.mjs`
- Modify: `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`
- Modify: `products/workbench/first-party-extensions.json`
- Test: `products/workbench/tests/documentation-migration-plan.test.mjs`
- Test: `products/workbench/tests/documentation-extension.test.mjs`
- Test: `products/workbench/tests/documentation-remote-transaction.test.mjs`
- Test: `products/workbench/tests/first-party-extensions.test.mjs`
- Test: `products/workbench/tests/remote-agent-release.test.mjs`

**Interfaces:**

- Consumes: the Task 8 adapter/helper and Task 9 pure mapping/rewriter functions.
- Produces: helper handling for exactly one `adapter.snapshot({kind:"plan-migration",limits})` request, content-free non-executable `MigrationPlanV1`, `createMigrationPlanner({adapter, capabilities, clock, limits, randomBytes})`, `planner.planMigration(scope): Promise<MigrationPlanV1Result>`, a 256-bit opaque `planToken: string`, `planner.consumePlanToken(token, scope)`, and `MigrationReportContentProvider` for `chatero-documentation-report:` URIs. The helper response contains no raw legacy body, proposal blob, intended output body, or `intendedOutputManifest`; Phase 5 must replan after its final Change Set builder exists.

- [ ] **Step 1: Add failing dry-run tests.** Require exactly one high-level adapter request, two matching snapshots internal to the helper, no writes, and an extension-created opaque token:

```js
const beforeCalls = fixtureAuthority.mutations.length;
const beforeSnapshotRequests = adapterRequests.length;
const result = await planner.planMigration(scope);
assert.equal(result.kind, "planned");
assert.deepEqual(adapterRequests.slice(beforeSnapshotRequests), [{
  kind: "plan-migration",
  limits: MIGRATION_PLAN_LIMITS,
}]);
assert.equal(fixtureAuthority.internalSnapshots.length, 2);
assert.deepEqual(
  fixtureAuthority.internalSnapshots.map(snapshot => snapshot.digest),
  [result.plan.sourceSnapshotDigest, result.plan.verificationSnapshotDigest],
);
assert.equal(result.plan.sourceSnapshotDigest, result.plan.verificationSnapshotDigest);
assert.match(result.plan.digest, /^sha256:[0-9a-f]{64}$/);
assert.deepEqual(
  result.plan.affectedPaths,
  [...new Set(result.plan.pathProofs.map(proof => proof.path))].sort(),
);
assert.equal(result.plan.pathProofs.some(proof => "expectedVersion" in proof || "dirty" in proof), false);
assert.equal(result.plan.schemaVersion, 1);
assert.equal("intendedOutputManifest" in result.plan, false);
assert.match(result.planToken, /^mp_[A-Za-z0-9_-]{43}$/);
assert.equal(result.report.includes(result.planToken), false);
assert.equal(fixtureAuthority.mutations.length, beforeCalls);
assert.equal(result.report.includes(fixtureWorkspaceRoot), false);
```

- [ ] Add failing cases whose helper-private snapshots cover legacy roots, directory entries, proposal evidence, state generation, target absence, open-document evidence, and a pre-existing non-empty `documentation/` mixed-layout conflict. The adapter captures open-document versions once and revalidates them after the response; a changed or dirty affected working copy returns typed stale/dirty evidence and no token.
- [ ] Assert untrusted workspaces cannot invoke planning and that becoming untrusted while the single request is in flight invalidates the scope without writing anything.
- [ ] Assert the helper runs `snapshot A -> pure mapping/rewriting/classification -> snapshot B -> exact digest comparison` within that one request. A mismatch returns `stale-plan-evidence`, no partial plan/report, and zero writes.
- [ ] Assert the returned immutable authority plan record has a deterministic plan digest, content hashes, mapping/state outputs, collision/link/proposal summaries, target preconditions, sorted duplicate-free `affectedPaths`, and exact `pathProofs`. Each content-free path proof is `{path,role:"source"|"target",expectedDigest?,intendedDigest?,targetAbsent?,directoryGeneration?,requireClean}` with a normalized workspace-relative path and only applicable fields; the plan must not contain `workingCopyProofs`, an editor version, or dirty-buffer content/state. `affectedPaths` is exactly the normalized unique projection of all proof paths, and canonical serialization of both arrays is covered by `planDigest`.
- [ ] Assert the plan contains no raw QMD, asset, proposal, base, or proposed bytes and no absolute path. Exact validation permits only path, digest, coordinate, classification, and diagnostic fields in `rewrites` and `proposals`; in particular it strips the Task 9 rewriter's `bytes` result. The bounded report model is derived from that record and is independently checked for the same exclusions.
- [ ] Lock this result as non-executable `MigrationPlanV1`: reject any `schemaVersion` other than `1`, reject an `intendedOutputManifest` field even if empty, and assert no migrate/execute adapter or command accepts its token. Phase 1 lacks the Phase 4 Change Set builder and therefore must not guess final proposal/output hashes. Phase 5 Task 1 performs a new authority-side plan request, returns `MigrationPlanV2` with the complete output manifest, and invalidates V1 tokens as `stale-plan` rather than upgrading them in memory.
- [ ] Assert `planMigration(scope)` performs zero workspace writes and generates `planToken` locally as 32 cryptographically random bytes. Keep the token and its frozen `{scope,workspaceEpoch,planDigest,planRecord,expiresAt}` binding only in a module-private `Map`; the helper neither receives nor returns a token.
- [ ] Add a local process and SSH fixture proving planning is one framed authority-side request, the helper exits after its one response, and neither response nor local renderer traffic contains legacy file bodies. Instrument filesystem calls and assert no create, write, rename, remove, journal, token, or recovery operation occurs.
- [ ] **Step 2: Run focused tests and verify red.**

Run: `node --test products/workbench/tests/documentation-migration-plan.test.mjs products/workbench/tests/documentation-extension.test.mjs`

Expected: FAIL because the planner and report provider are missing.

- [ ] **Step 3: Implement authority-side planning and the extension token registry.** The helper captures snapshot A, calls the Task 9 pure mapping/rewriter/classifier against only its private bytes, captures snapshot B, and compares workspace epoch, exact entry/directory generations, revisions, and target absence before returning. It is a one-shot read-only request: it may not create a temporary file, journal, plan cache, token, recovery artifact, or target directory. Return this exact content-free helper result:

```js
const planRecord = Object.freeze({
  schemaVersion: 1,
  sourceSnapshotDigest: snapshotA.digest,
  verificationSnapshotDigest: snapshotB.digest,
  affectedPaths,
  pathProofs,
  mappings,
  stateOutput,
  collisions,
  rewrites,
  proposals,
  diagnostics,
});
Object.freeze({
  kind: "migration-plan",
  workspaceEpoch,
  planDigest: canonicalPlanDigest(planRecord),
  planRecord,
  reportModel,
});
```

- [ ] Build `pathProofs` inside the helper from its matched snapshots and intended mapping outputs, normalize/sort them deterministically, and derive `affectedPaths` as the sorted duplicate-free projection of every proof path. Reject a missing/extra path, duplicate or case alias, incompatible proof fields, a proof without usable revision/absence evidence, or a digest that does not cover the exact arrays. The response must not contain `workingCopyProofs`; Phase 5 combines the immutable proofs with then-current `TextDocument.version`/dirty state when acquiring its barrier.
- [ ] Keep all rewritten bytes and proposal/base blobs helper-private while computing only the V1 mapping, rewrite/proposal summaries, digests, `affectedPaths`, and `pathProofs`. Do not emit a partial or speculative output manifest. Add a forward-compatibility fixture proving an exact V1 response is rejected by a mock Phase 5 execute decoder with `stale-plan` and zero writes, while the Phase 1 read-only report remains usable.
- [ ] In the extension, generate `planToken` as `mp_` plus 32 cryptographically random base64url bytes only after validating the helper result and post-request scope/open-document evidence. Bind the frozen plan record to the current scope, returned workspace epoch, returned plan digest, and expiry in a module-private registry. Return `{kind:"planned",plan:Object.freeze({...planRecord,digest:planDigest,workspaceEpoch}),planToken,report}`; that public plan remains content-free. Unknown, expired, wrong-scope, wrong-epoch, or digest-mismatched token strings fail closed.
- [ ] Sort traversal/report output deterministically. Fix limits at 50,000 entries, 16 MiB per QMD/proposal blob, 64 MiB aggregate source bytes, and a 2 MiB display report; exceeding a limit returns a typed `migration-limit` result and no token rather than partial success.
- [ ] Add `planMigration` to the Task 5 transaction facade only now. Register its command to open a read-only `chatero-documentation-report:` virtual Markdown document; do not register Execute, Approve, Migrate, or Recovery commands in this phase.
- [ ] Append the Task 9–10 migration files and updated helper to `first-party-extensions.json`; assert the complete Phase 1 extension/helper tree and digests in `first-party-extensions.test.mjs`. Rebuild both signed Remote Agent tuples and assert their complete tree manifests contain exactly those provenance-pinned bytes.
- [ ] **Step 4: Run planner, activation, and materialization tests and verify green.**

Run: `node --test products/workbench/tests/documentation-migration-plan.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs products/workbench/tests/first-party-extensions.test.mjs products/workbench/tests/remote-agent-release.test.mjs`

Expected: PASS with one request, two matching internal snapshots, no returned raw bodies, and zero writes in every dry-run and stale-plan case for local plus SSH.

- [ ] **Step 5: Commit.**

```bash
git add products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs products/workbench/extensions/chatero-documentation products/workbench/first-party-extensions.json products/workbench/tests/documentation-migration-plan.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs products/workbench/tests/first-party-extensions.test.mjs products/workbench/tests/remote-agent-release.test.mjs
git commit -m "feat(documentation): add read-only migration dry run"
```

## Task 11: Add CI and Close the Phase Gate

**Files:**

- Create: `.github/workflows/workbench.yml`
- Modify: `docs/chatero/parity-checklist.md`
- Modify: this plan

**Interfaces:**

- Consumes: root scripts and provenance inputs produced by Tasks 1–9.
- Produces: one isolated `workbench` CI job and the recorded Phase 1 review/rollback evidence; no runtime API.

- [ ] **Step 1: Add a failing workflow-structure assertion** to `documentation-extension.test.mjs` that parses `.github/workflows/workbench.yml` and requires `ubuntu-24.04`, Node `24.18.0`, `npm ci`, Documentation tests, bootstrap tests, bootstrap, and verify.
- [ ] Run `node --test products/workbench/tests/documentation-extension.test.mjs`.

Expected: FAIL with `ENOENT` for `.github/workflows/workbench.yml`.

- [ ] **Step 2: Create the isolated workflow.** Use these exact gate commands in order while keeping it separate from inherited Node 18 Zotero shards:

```yaml
name: Workbench
on: [push, pull_request]
jobs:
  workbench:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24.18.0
          cache: npm
      - run: npm ci
      - run: npm run test:documentation
      - run: npm run test:workbench-bootstrap
      - id: code-oss-cache
        uses: actions/cache@v4
        with:
          path: vendor/code-oss
          key: workbench-${{ runner.os }}-${{ hashFiles('products/workbench/upstreams.json', 'products/workbench/patches/code-oss/**', 'products/workbench/first-party-extensions.json', 'package-lock.json') }}
      - if: steps.code-oss-cache.outputs.cache-hit == 'true'
        run: npm run workbench:verify
      - run: npm run workbench:bootstrap
      - run: npm run workbench:verify
```

- [ ] Keep the bootstrap cache key exactly scoped to `products/workbench/upstreams.json`, Code-OSS patch files, the first-party manifest, and the package lock; the cache-hit verification must precede bootstrap reuse.
- [ ] Update `parity-checklist.md` to label Gecko Draft/Knowledge as the active parity oracle and Documentation Phase 1 as disabled-by-default Workbench code. Do not claim cutover.
- [ ] **Step 3: Run the complete phase gate.** Run `npm run test:documentation`.
- [ ] Run `npm run test:workbench-bootstrap`.
- [ ] Bootstrap and verify a fresh temporary checkout with these exact commands:

```bash
documentation_verify_parent=$(mktemp -d)
CHATERO_CODE_OSS_DIR="$documentation_verify_parent/code-oss" npm run workbench:bootstrap
CHATERO_CODE_OSS_DIR="$documentation_verify_parent/code-oss" npm run workbench:verify
```

Expected: all three phase gates exit `0`; verification reports Code-OSS commit `df53daabb18cd157bdb08c7f01c34df936cf12f4`, Node `24.18.0`, Electron `42.7.1`, the ordered patch digest set, and the complete first-party extension provenance.
- [ ] Run `git diff --check` and inspect that no fixture contains a personal path/profile/workspace and no generated checkout/bundle is tracked.
- [ ] Record the commands and passing result under the checkpoint below.
- [ ] **Step 4: Commit the gate and recorded evidence.**

```bash
git add .github/workflows/workbench.yml docs/chatero/parity-checklist.md docs/superpowers/plans/2026-08-12-documentation-phase-1-authority.md products/workbench/tests/documentation-extension.test.mjs
git commit -m "test(documentation): gate authority phase"
```

## Phase 1 Review Checkpoint

- [ ] Product flag remains off by default, and standard Text Editor QMD opening works with the extension disabled or failed.
- [ ] Capability forgery/reuse, path traversal/alias/symlink, stale revision, corrupt state, crash recovery, and idempotency tests pass.
- [ ] A marker-preserving mutation anywhere in a cached Remote Agent tree is detected before execution and causes verified reinstall or a closed connection failure.
- [ ] Replacing a local or SSH authority helper or any trusted runtime-tree entry after one successful request makes the next request fail before spawn; the extension cannot reuse an activation-time or connection-time integrity result.
- [ ] Local and SSH adapters pass the same state transaction and migration-plan conformance cases.
- [ ] A migration dry run is exactly one high-level adapter request with two matching helper-internal snapshots; it proves zero workspace writes, returns no raw legacy bodies, creates the opaque token only in the extension's private registry, and exposes no migration execution affordance.
- [ ] `npm run test:documentation`, `npm run test:workbench-bootstrap`, and `npm run workbench:verify` pass on Node 24.18.0.
- [ ] Rollback boundary is documented: disable/remove the extension and its manifest entry; no legacy data moved, and any explicitly created Documentation state remains an ordinary user workspace file.
