# Documentation Phase 2 TextDocument Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional plain-source `chatero.documentation.livePreview` CodeMirror 6 custom text editor whose edits, splits, dirty state, lifecycle, and undo/redo are owned by the same versioned Code-OSS `TextDocument` locally and over SSH.

**Architecture:** The workspace extension contributes a `CustomTextEditorProvider`, while each webview holds only a transient CodeMirror source mirror with history disabled. One extension-host bridge per URI serializes all view operations through a version-bound `WorkingCopyCoordinator`; before apply it records the origin and exact expected document-event fingerprint, forwards the authoritative event only to non-origin views, and acknowledges the optimistic origin only after the coordinator settles that same event. `WorkingCopyCoordinator` is the shared working-copy seam that Phase 4 settlement and Phase 5 cutover must reuse directly, without routing through the provider or webview.

**Tech Stack:** Code-OSS 1.132.0 at `df53daabb18cd157bdb08c7f01c34df936cf12f4`, Electron 42.7.1, Node 24.18.0, stable VS Code `CustomTextEditorProvider`/`TextDocument`/`WorkspaceEdit` APIs, CodeMirror 6, esbuild, Acorn bundle auditing, CommonJS activation, ESM domain/webview modules, Node test runner, and Code-OSS extension-host integration tests.

## Global Constraints

- Execute only after [Phase 1](./2026-08-12-documentation-phase-1-authority.md) passes its checkpoint; the approved contract remains [the unified Documentation design](../specs/2026-08-12-unified-agent-knowledge-documentation-design.md).
- Keep `chatero.documentation.enabled` defaulted to `false`; keep `chatero.documentation.livePreview` boolean defaulted to `true`. The first controls Chatero product routes, while the second controls only how enabled Chatero Documentation commands open a page.
- Keep `extensionKind` exactly `["workspace"]`; the same extension code must execute beside either the local workspace authority or the signed Chatero SSH Remote Agent.
- Contribute view type `chatero.documentation.livePreview` with `priority: "option"`. Do not change ordinary QMD opens, user `workbench.editorAssociations`, or availability of the standard Text Editor.
- Use only the stable custom text editor API. Do not set or depend on `supportsMultipleEditorsPerDocument`: Code-OSS 1.132.0 ignores that option for `CustomTextEditorProvider`.
- The Code-OSS `TextDocument` is the only logical editing buffer and owns dirty state, save, Save As, autosave, revert, close confirmation, hot exit, external-file conflict handling, and undo/redo.
- The CodeMirror document is a transient source mirror. Disable CodeMirror history. `vscode.setState` may persist only content-free pending descriptors containing operation ID, base version, SHA-256 change digest, and numeric change shape; it must never persist inserted/deleted/context text, a source body, or a replayable delta.
- Use UTF-16 `[from,to)` offsets. One CodeMirror user transaction maps to one smallest-practical `WorkspaceEdit` and therefore one Workbench undo unit.
- `onDidChangeTextDocument` is the only commit acknowledgement. Never acknowledge from the boolean returned by `workspace.applyEdit`, never use whole-document `setValue`, and never patch Code-OSS undo grouping. An origin Live Preview applies its edit optimistically and then receives only `operationAcknowledged`; the matching authoritative `documentChanged` delta goes to every non-origin panel, while standard-editor/external events go to every panel.
- Serialize every edit for a URI across all Live Preview views. Undo/redo must drain that URI queue before invoking normal Workbench `undo`/`redo` commands.
- `WorkingCopyCoordinator` must acquire multi-URI locks in sorted URI order, re-open/re-read documents under the lock, validate versions and ranges, issue one `WorkspaceEdit`, and settle only after matching document-change events. Phase 4 settlement and Phase 5 operations consume this exact seam.
- Extension and webview modules must not import Node `fs`; build/test scripts may use Node filesystem APIs only for repository artifacts and generated temporary fixtures.
- Bundle all browser dependencies at build time from the repository lockfile. Runtime code must not fetch npm, a CDN, Open VSX, Microsoft Marketplace, or any Microsoft download endpoint.
- Keep every materialized first-party file below the existing 4 MiB per-file limit. Do not commit `products/workbench/.cache/`, `vendor/code-oss/`, generated application bundles, temporary workspaces, or test profiles.
- Safe passive source editing must work in an untrusted workspace. A Documentation or Live Preview activation failure must leave the standard Text Editor and Zotero Core available.
- Tests use generated, non-personal QMD fixtures and run the same editor contract for `file:` and `vscode-remote://chatero-remote+...` URIs.

---

## Phase File Map

### Create

- `products/workbench/extensions/chatero-documentation/working-copy-coordinator.mjs`
- `products/workbench/extensions/chatero-documentation/text-change-set.mjs`
- `products/workbench/extensions/chatero-documentation/pending-edit-rebase.mjs`
- `products/workbench/extensions/chatero-documentation/live-preview-protocol.mjs`
- `products/workbench/extensions/chatero-documentation/live-preview-bridge.mjs`
- `products/workbench/extensions/chatero-documentation/live-preview-provider.cjs`
- `products/workbench/extensions/chatero-documentation/live-preview-html.mjs`
- `products/workbench/extensions/chatero-documentation/webview/live-preview-entry.mjs`
- `products/workbench/extensions/chatero-documentation/webview/live-preview-editor.mjs`
- `products/workbench/extensions/chatero-documentation/webview/live-preview.css`
- `products/workbench/extensions/chatero-documentation/licenses/CodeMirror-MIT.txt`
- `products/workbench/scripts/build-documentation-webview.mjs`
- `products/workbench/scripts/run-documentation-integration.mjs`
- `products/workbench/tests/documentation-webview-build.test.mjs`
- `products/workbench/tests/documentation-text-change-set.test.mjs`
- `products/workbench/tests/documentation-working-copy-coordinator.test.mjs`
- `products/workbench/tests/documentation-live-preview-protocol.test.mjs`
- `products/workbench/tests/documentation-pending-edit-rebase.test.mjs`
- `products/workbench/tests/documentation-live-preview-bridge.test.mjs`
- `products/workbench/tests/documentation-live-preview-provider.test.mjs`
- `products/workbench/tests/documentation-integration-runner.test.mjs`
- `products/workbench/integration/documentation/driver/package.json`
- `products/workbench/integration/documentation/driver/extension.cjs`
- `products/workbench/integration/documentation/driver/run.cjs`
- `products/workbench/integration/documentation/fixtures.mjs`
- `products/workbench/integration/documentation/text-document-editor.test.mjs`

### Modify

- `package.json`
- `package-lock.json`
- `products/workbench/extensions/chatero-documentation/package.json`
- `products/workbench/extensions/chatero-documentation/extension.cjs`
- `products/workbench/extensions/chatero-documentation/documentation-tree.cjs`
- `products/workbench/first-party-extensions.json`
- `products/workbench/scripts/bootstrap-code-oss.mjs`
- `products/workbench/tests/first-party-extensions.test.mjs`
- `products/workbench/tests/documentation-extension.test.mjs`
- `products/workbench/tests/remote-agent-release.test.mjs`

## Normative Phase 2 Types

These TypeScript shapes are normative JSDoc contracts for the JavaScript implementation:

```ts
type TextOffsetChange = Readonly<{
  from: number;
  to: number;
  insert: string;
  deletedText: string;
  leftContext: string;
  rightContext: string;
}>;

type PendingOperation = Readonly<{
  opId: string;
  baseVersion: number;
  changes: readonly TextOffsetChange[];
}>;

type PersistedPendingDescriptor = Readonly<{
  opId: string;
  baseVersion: number;
  changeDigest: string; // exactly 64 lowercase hexadecimal SHA-256 characters
  shape: readonly Readonly<{
    from: number;
    to: number;
    insertedUtf8Bytes: number;
    deletedUtf8Bytes: number;
  }>[];
}>;

type DocumentEventFingerprint = Readonly<{
  beforeVersion: number;
  afterVersion: number;
  changesDigest: string; // SHA-256 of the canonical ordered TextOffsetChange encoding
  afterDigest: string; // SHA-256 of the authoritative UTF-8 source after the event
}>;

type ExpectedOriginEvent = Readonly<{
  sessionId: string;
  opId: string;
  fingerprint: DocumentEventFingerprint;
}>;

const MAX_OPERATION_ID_UTF8 = 128;
const MAX_CHANGE_COUNT = 256;
const MAX_CHANGE_TEXT_FIELD_UTF8 = 4 * 1024 * 1024;
const MAX_CHANGE_CONTEXT_FIELD_UTF8 = 256;
const MAX_EDIT_FRAME_UTF8 = 12 * 1024 * 1024;
const MAX_SNAPSHOT_SOURCE_UTF8 = 16 * 1024 * 1024;
const MAX_PENDING_REASSOCIATION_UTF8 = 12 * 1024 * 1024;
const MAX_HOST_FRAME_UTF8 = 32 * 1024 * 1024;
const MAX_PERSISTED_PENDING_OPERATIONS = 64;
const MAX_PERSISTED_CHANGE_SHAPES = 256;
const MAX_PERSISTED_STATE_UTF8 = 32 * 1024;

type VersionedDocumentEdit = Readonly<{
  uri: vscode.Uri;
  baseVersion: number;
  changes: readonly TextOffsetChange[];
}>;

type WorkingCopyResult =
  | Readonly<{
      kind: "applied";
      operationId: string;
      versions: readonly Readonly<{uri: vscode.Uri; before: number; after: number}>[];
    }>
  | Readonly<{
      kind: "version-conflict";
      operationId: string;
      documents: readonly Readonly<{
        uri: vscode.Uri;
        expectedVersion: number;
        actualVersion: number;
        text: string;
      }>[];
    }>
  | Readonly<{kind: "apply-failed"; operationId: string; message: string}>;
```

## Task 1: Pin and Deterministically Bundle the Plain Editor

**Files:**

- Create: `products/workbench/scripts/build-documentation-webview.mjs`
- Create: `products/workbench/extensions/chatero-documentation/webview/live-preview-entry.mjs`
- Create: `products/workbench/extensions/chatero-documentation/webview/live-preview-editor.mjs`
- Create: `products/workbench/extensions/chatero-documentation/webview/live-preview.css`
- Create: `products/workbench/extensions/chatero-documentation/licenses/CodeMirror-MIT.txt`
- Create: `products/workbench/tests/documentation-webview-build.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `products/workbench/first-party-extensions.json`
- Modify: `products/workbench/scripts/bootstrap-code-oss.mjs`
- Modify: `products/workbench/tests/first-party-extensions.test.mjs`

**Interfaces:**

- Consumes: root npm lockfile; `materializeFirstPartyExtensions({root,checkout,manifestPath})`; source entry `webview/live-preview-entry.mjs`.
- Produces: `buildDocumentationWebview({root?: string, outdir?: string}): Promise<{files: readonly {path:string,size:number,sha256:string}[]}>`; `auditDocumentationJavaScript(source:string):Readonly<{urlLiterals:readonly string[]}>`; deterministic ignored outputs `products/workbench/.cache/documentation-webview/live-preview.js` and `live-preview.css`; scripts `build:documentation-webview` and `test:documentation:integration`.

- [ ] **Step 1: Write the failing build and supply-chain test.** Build twice into different temporary directories and compare names and bytes; assert every output is below 4 MiB, has no source map, `eval`, absolute repository path, dynamic import, network API, remote resource load, Microsoft endpoint, or non-namespace URL literal. Do not reject every `http(s)` literal: Phase 3 render dependencies legitimately carry fixed XML namespace identifiers. Start with this exact test body:

```js
const first = await mkdtemp(join(tmpdir(), "chatero-documentation-bundle-a-"));
const second = await mkdtemp(join(tmpdir(), "chatero-documentation-bundle-b-"));
const {
  XML_NAMESPACE_URLS,
  auditDocumentationJavaScript,
  buildDocumentationWebview,
} = await import("../scripts/build-documentation-webview.mjs");
const a = await buildDocumentationWebview({ root: repositoryRoot, outdir: first });
const b = await buildDocumentationWebview({ root: repositoryRoot, outdir: second });
assert.deepEqual(a.files, b.files);
for (const file of a.files) {
  const bytesA = await readFile(join(first, file.path));
  const bytesB = await readFile(join(second, file.path));
  assert.deepEqual(bytesA, bytesB);
  assert.ok(bytesA.length < 4 * 1024 * 1024);
  assert.doesNotMatch(bytesA.toString("utf8"), /sourceMappingURL|marketplace\.visualstudio\.com|update\.code\.visualstudio\.com/i);
  if (file.path.endsWith(".js")) {
    const audit = auditDocumentationJavaScript(bytesA.toString("utf8"));
    assert.ok(audit.urlLiterals.every(value => XML_NAMESPACE_URLS.includes(value)));
  }
}
```

- [ ] Add negative scanner fixtures for `import("./late.mjs")`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, `importScripts`, remote `Worker`/`SharedWorker`, a CDN script loader, and each forbidden Microsoft/Marketplace host. Add positive fixtures containing only `http://www.w3.org/2000/svg`, `http://www.w3.org/1998/Math/MathML`, `http://www.w3.org/1999/xlink`, `http://www.w3.org/1999/xhtml`, and `http://www.w3.org/XML/1998/namespace`; these five exact strings are the complete `XML_NAMESPACE_URLS` allowlist, and every other `http:` or `https:` string literal must fail.
- [ ] Parse JavaScript with Acorn rather than a blanket byte regex: reject `ImportExpression`; direct/indirect `eval` and `Function` construction; calls to `fetch`, `importScripts`, `navigator.sendBeacon`, or `XMLHttpRequest.open`; construction/reference of `XMLHttpRequest`, `WebSocket`, `EventSource`, `Worker`, or `SharedWorker`; `document.createElement("script"|"link"|"iframe")` dynamic loaders; non-empty esbuild `metafile.outputs[*].imports`; forbidden endpoint substrings; and URL-valued literals outside `XML_NAMESPACE_URLS`. Walk all AST child nodes, including computed callees; scanner fixture tests must prove comments and harmless identifier substrings do not create false positives.
- [ ] Extend the test to parse `package-lock.json` and require exact direct pins `@codemirror/commands@6.10.4`, `@codemirror/state@6.7.1`, `@codemirror/view@6.43.8`, `acorn@8.15.0`, and `esbuild@0.28.2`; every resolved package URL must use `https://registry.npmjs.org/` and carry an integrity value. This lockfile supply-chain check is separate from the bundle URL-literal allowlist.
- [ ] Assert `first-party-extensions.json` declares both generated files and `licenses/CodeMirror-MIT.txt` explicitly, and that `bootstrapCodeOss()` invokes the builder before first-party materialization.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-webview-build.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `build-documentation-webview.mjs`.

- [ ] **Step 3: Install exact build dependencies and write the minimal deterministic builder.** Run the exact lockfile mutation command:

```bash
npm install --save-dev --save-exact @codemirror/commands@6.10.4 @codemirror/state@6.7.1 @codemirror/view@6.43.8 acorn@8.15.0 esbuild@0.28.2
```

Use this build configuration and return sorted digests:

```js
const ENTRY = join(root, "products/workbench/extensions/chatero-documentation/webview/live-preview-entry.mjs");
const buildResult = await esbuild.build({
  entryPoints: [ENTRY],
  outfile: join(outdir, "live-preview.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["chrome142"],
  charset: "utf8",
  legalComments: "none",
  minify: true,
  sourcemap: false,
  metafile: true,
});
await copyFile(
  join(root, "products/workbench/extensions/chatero-documentation/webview/live-preview.css"),
  join(outdir, "live-preview.css"),
);
```

- [ ] Make `live-preview-entry.mjs` acquire the VS Code API once and call a minimal `startLivePreview({vscode,window,document})`; make the initial editor module render a non-editing mount until Task 4 supplies CodeMirror behavior. Commit the complete MIT license text from the pinned CodeMirror packages in `licenses/CodeMirror-MIT.txt`.
- [ ] Export `XML_NAMESPACE_URLS` as one frozen five-string array and use a private `Set` for membership so callers cannot widen policy. Run `auditDocumentationJavaScript` on `live-preview.js` before returning build metadata. The audit must parse the emitted IIFE as `sourceType:"script"`, recursively visit the complete Acorn AST, enforce that allowlist, and reject dynamic imports/network or remote-loader APIs even when no URL literal is present. Reject any esbuild external import from `buildResult.metafile`.
- [ ] Set `build:documentation-webview` to `node products/workbench/scripts/build-documentation-webview.mjs`; make `test:documentation` build first, then run `node --test products/workbench/tests/documentation-*.test.mjs`; set `test:documentation:integration` to build first and run `run-documentation-integration.mjs`.
- [ ] Call `buildDocumentationWebview({root})` inside `bootstrapCodeOss()` immediately before `materializeFirstPartyExtensions()`. Add explicit cache-to-extension mappings for `media/documentation-webview/live-preview.js` and `.css`; never add a glob or the cache directory itself.
- [ ] **Step 4: Run the build and scoped tests and verify green.**

Run: `npm run build:documentation-webview && node --test products/workbench/tests/documentation-webview-build.test.mjs products/workbench/tests/first-party-extensions.test.mjs`

Expected: PASS; the output list is exactly `live-preview.css`, `live-preview.js`, and neither generated file is tracked by Git.

- [ ] **Step 5: Refactor without changing output bytes.** Extract and freeze these build constants, rebuild twice, and keep the digest test green:

```js
export const DOCUMENTATION_WEBVIEW_OUTPUTS = Object.freeze([
  "live-preview.css",
  "live-preview.js",
]);
const ESBUILD_OPTIONS = Object.freeze({
  bundle: true,
  platform: "browser",
  format: "iife",
  target: Object.freeze(["chrome142"]),
  charset: "utf8",
  legalComments: "none",
  minify: true,
  sourcemap: false,
  metafile: true,
});
```

- [ ] **Step 6: Re-run after refactor.**

Run: `npm run build:documentation-webview && node --test products/workbench/tests/documentation-webview-build.test.mjs products/workbench/tests/first-party-extensions.test.mjs`

Expected: PASS with byte-identical artifacts and no unexpected manifest file.

- [ ] **Step 7: Commit.**

```bash
git add package.json package-lock.json products/workbench/scripts/build-documentation-webview.mjs products/workbench/scripts/bootstrap-code-oss.mjs products/workbench/first-party-extensions.json products/workbench/extensions/chatero-documentation/webview products/workbench/extensions/chatero-documentation/licenses/CodeMirror-MIT.txt products/workbench/tests/documentation-webview-build.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "build(documentation): pin and bundle editor dependencies"
```

## Task 2: Define Exact UTF-16 Change Sets

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/text-change-set.mjs`
- Create: `products/workbench/tests/documentation-text-change-set.test.mjs`
- Modify: `products/workbench/first-party-extensions.json`

**Interfaces:**

- Consumes: JavaScript/CodeMirror UTF-16 offsets and a VS Code `TextDocument` exposing `getText()` and `positionAt(offset)`.
- Produces: `validateOffsetChanges(text:string, changes:readonly TextOffsetChange[]): readonly TextOffsetChange[]`; `withChangeContext(text:string, changes:readonly {from:number,to:number,insert:string}[], contextUnits?:number): readonly TextOffsetChange[]`; `applyOffsetChanges(text:string, changes:readonly TextOffsetChange[]):string`; `toWorkspaceTextEdits(document,changes,Range): readonly {range:vscode.Range,newText:string}[]`; `canonicalOffsetChangesBytes(changes:readonly TextOffsetChange[]):Uint8Array`; `sha256Hex(bytes:Uint8Array,subtle?:SubtleCrypto):Promise<string>`; `digestOffsetChanges(changes,subtle?):Promise<string>`; `digestSourceText(text:string,subtle?):Promise<string>`.

- [ ] **Step 1: Write the failing Unicode and byte-preservation tests.** Cover surrogate pairs, combining marks, CRLF, final newline, insertion, deletion, multiple disjoint edits, inverted/out-of-bounds ranges, overlaps, unsorted changes, and mismatched `deletedText`. Begin with:

```js
const source = "A😀e\u0301\r\nB\n";
const changes = withChangeContext(source, [{ from: 1, to: 3, insert: "λ" }], 4);
assert.equal(changes[0].deletedText, "😀");
assert.equal(applyOffsetChanges(source, changes), "Aλe\u0301\r\nB\n");
assert.throws(
  () => validateOffsetChanges(source, [{ ...changes[0], from: 2 }]),
  /UTF-16 boundary|deleted text/,
);
```

- [ ] Assert `toWorkspaceTextEdits` uses `document.positionAt(from/to)`, produces one replacement per change, preserves ascending source order, and never creates a whole-document replacement when a smaller change exists.
- [ ] Assert canonical change bytes are UTF-8 of JSON arrays in exact field order `[[from,to,insert,deletedText,leftContext,rightContext],...]`, with no object-key or whitespace ambiguity. Assert both digest functions return exactly 64 lowercase hexadecimal SHA-256 characters in Node 24 and an injected browser-compatible `SubtleCrypto`; identical changes have identical digests and any text/context/range change alters the digest.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-text-change-set.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `text-change-set.mjs`.

- [ ] **Step 3: Implement strict normalization and minimal replacements.** Use this validation/apply core and reject an offset that splits a surrogate pair:

```js
function isUtf16Boundary(text, offset) {
  if (offset <= 0 || offset >= text.length) return true;
  const left = text.charCodeAt(offset - 1);
  const right = text.charCodeAt(offset);
  return !(left >= 0xD800 && left <= 0xDBFF && right >= 0xDC00 && right <= 0xDFFF);
}

export function applyOffsetChanges(text, changes) {
  const valid = validateOffsetChanges(text, changes);
  let result = text;
  for (const change of [...valid].reverse()) {
    result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  }
  return result;
}

export function toWorkspaceTextEdits(document, changes, Range) {
  return validateOffsetChanges(document.getText(), changes).map(change => ({
    range: new Range(document.positionAt(change.from), document.positionAt(change.to)),
    newText: change.insert,
  }));
}
```

- [ ] Freeze normalized changes; require finite safe integer offsets, `0 <= from <= to <= text.length`, ascending non-overlap, exact `deletedText`, and string fields. `withChangeContext` records at most 16 UTF-16 units on either side by default without splitting a surrogate pair.
- [ ] Implement the canonical encoder with `TextEncoder` and SHA-256 with `globalThis.crypto.subtle` by default; accept only an explicitly injected `SubtleCrypto` in tests. Do not add a Node-only crypto import to a module bundled into the webview.
- [ ] Add the new source and test file explicitly to the first-party extension manifest/test fixture.
- [ ] **Step 4: Run the focused test and verify green.**

Run: `node --test products/workbench/tests/documentation-text-change-set.test.mjs products/workbench/tests/first-party-extensions.test.mjs`

Expected: PASS for every Unicode, CRLF, range, and minimal-edit case.

- [ ] **Step 5: Refactor immutable construction.** Centralize return freezing with this exact helper and re-use it from validation and context creation:

```js
function freezeChanges(changes) {
  return Object.freeze(changes.map(change => Object.freeze({ ...change })));
}
```

- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-text-change-set.test.mjs`

Expected: PASS with no mutation of caller arrays or change records.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/text-change-set.mjs products/workbench/first-party-extensions.json products/workbench/tests/documentation-text-change-set.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "feat(documentation): define UTF-16 editor changes"
```

## Task 3: Add the Shared Version-Bound Working-Copy Coordinator

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/working-copy-coordinator.mjs`
- Create: `products/workbench/tests/documentation-working-copy-coordinator.test.mjs`
- Modify: `products/workbench/first-party-extensions.json`

**Interfaces:**

- Consumes: `validateOffsetChanges`, `applyOffsetChanges`, `toWorkspaceTextEdits`, `digestOffsetChanges`, and `digestSourceText` from Task 2; injected stable VS Code values `{workspace, WorkspaceEdit, Position, Range}`.
- Produces: `createWorkingCopyCoordinator({workspace,WorkspaceEdit,Position,Range}): WorkingCopyCoordinator`, where `withUris<T>(uris:readonly vscode.Uri[], task:(documents:ReadonlyMap<string,vscode.TextDocument>)=>Promise<T>):Promise<T>`, `applyVersionedTextEdits({operationId:string,origin:"live-preview"|"human-apply"|"settlement",edits:readonly VersionedDocumentEdit[]}):Promise<WorkingCopyResult>`, `drain(uri:vscode.Uri):Promise<void>`, and `dispose():void`.

- [ ] **Step 1: Write the failing coordinator contract test.** Build a fake workspace whose `applyEdit` mutates documents and fires `onDidChangeTextDocument` before its promise resolves. Assert the coordinator still settles exactly once from the event:

```js
const coordinator = createWorkingCopyCoordinator({ workspace, WorkspaceEdit, Position, Range });
const result = await coordinator.applyVersionedTextEdits({
  operationId: "op-1",
  origin: "live-preview",
  edits: [{
    uri: document.uri,
    baseVersion: 7,
    changes: withChangeContext(document.getText(), [{ from: 6, to: 11, insert: "world" }]),
  }],
});
assert.deepEqual(result, {
  kind: "applied",
  operationId: "op-1",
  versions: [{ uri: document.uri, before: 7, after: 8 }],
});
assert.equal(workspace.appliedEdits.length, 1);
```

- [ ] Add tests for same-URI FIFO order across concurrent callers, sorted lock order for reversed multi-URI inputs, duplicate URI rejection, one multi-document `WorkspaceEdit`, stale base before construction, invalid UTF-16 range, `applyEdit(false)`, event-before-promise, unrelated change event, disposal, and queue drain.
- [ ] Inject a standard-editor change after final validation but before bulk-edit conversion; require `version-conflict` with the authoritative text and prove the stale range never lands.
- [ ] Inject an external edit with the same resulting text/change shape after the bridge expectation is registered but before the coordinator's locked final validation; require `version-conflict`, no `applied` result, and no second insertion/replacement. This is the causal guard against mistaking equal bytes for the coordinator-owned event.
- [ ] Assert `origin: "settlement"` uses the identical code path and a multi-URI settlement cannot deadlock against reversed Live Preview acquisition.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-working-copy-coordinator.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `working-copy-coordinator.mjs`.

- [ ] **Step 3: Implement URI locks, version validation, one edit, and event settlement.** The public construction and result branch must have this shape:

```js
export function createWorkingCopyCoordinator({ workspace, WorkspaceEdit, Position, Range }) {
  const queues = new Map();
  let disposed = false;

  async function applyVersionedTextEdits(input) {
    return withUris(input.edits.map(edit => edit.uri), async documents => {
      const conflicts = input.edits.flatMap(edit => {
        const document = documents.get(edit.uri.toString());
        return document.version === edit.baseVersion ? [] : [{
          uri: edit.uri,
          expectedVersion: edit.baseVersion,
          actualVersion: document.version,
          text: document.getText(),
        }];
      });
      if (conflicts.length) {
        return Object.freeze({ kind: "version-conflict", operationId: input.operationId, documents: Object.freeze(conflicts) });
      }
      const workspaceEdit = new WorkspaceEdit();
      const expected = new Map();
      for (const edit of input.edits) {
        const document = documents.get(edit.uri.toString());
        expected.set(edit.uri.toString(), applyOffsetChanges(document.getText(), edit.changes));
        for (const replacement of toWorkspaceTextEdits(document, edit.changes, Range)) {
          workspaceEdit.replace(edit.uri, replacement.range, replacement.newText);
        }
      }
      return applyAndAwaitDocumentEvents(input, documents, expected, workspaceEdit);
    });
  }

  return Object.freeze({ withUris, applyVersionedTextEdits, drain, dispose });
}
```

- [ ] Subscribe the matching event waiter before calling `workspace.applyEdit`. Cache each pre-apply source/version, normalize event `contentChanges` by ascending `rangeOffset`, and reconstruct deleted text/contexts from that cached source. Match every URI on the exact expected ordered content-change digest, exact expected resulting-text digest, and `afterVersion === beforeVersion + 1`; equal resulting text alone is insufficient. Immediately before the call, synchronously re-check the still-open document's version, source digest, and validated ranges, with no `await` between that final check and invoking `workspace.applyEdit`. The apply boolean alone can only produce `apply-failed`, never `applied`.
- [ ] Implement sorted, duplicate-free multi-URI acquisition by URI string. Re-open each document with `workspace.openTextDocument(uri)` only after all locks are held. Release all locks in `finally`; `drain(uri)` queues a no-op behind the current tail.
- [ ] Return the exact `WorkingCopyResult` union above. Never expose queue maps, `WorkspaceEdit`, a generic write callback, or a direct TextDocument mutation method.
- [ ] Add coordinator/test files explicitly to the first-party manifest.
- [ ] **Step 4: Run the focused test and verify green.**

Run: `node --test products/workbench/tests/documentation-working-copy-coordinator.test.mjs products/workbench/tests/documentation-text-change-set.test.mjs`

Expected: PASS, including event-before-promise, stale-conversion race, reversed multi-URI locking, and settlement-origin cases.

- [ ] **Step 5: Refactor the deterministic queue primitive.** Keep it private and use this tail-chaining rule so rejection cannot poison later work:

```js
function enqueue(key, operation) {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const tail = current.catch(() => {});
  queues.set(key, tail);
  const cleanup = () => {
    if (queues.get(key) === tail) queues.delete(key);
  };
  current.then(cleanup, cleanup);
  return current;
}
```

- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-working-copy-coordinator.test.mjs`

Expected: PASS and a rejected operation does not prevent the next queued edit.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/working-copy-coordinator.mjs products/workbench/first-party-extensions.json products/workbench/tests/documentation-working-copy-coordinator.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "feat(documentation): coordinate version-bound working-copy edits"
```

## Task 4: Define the Strict Host/Webview Protocol and Transient Source Mirror

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/live-preview-protocol.mjs`
- Create: `products/workbench/tests/documentation-live-preview-protocol.test.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/live-preview-entry.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/live-preview-editor.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/live-preview.css`
- Modify: `products/workbench/first-party-extensions.json`

**Interfaces:**

- Consumes: transient `PendingOperation`, content-free `PersistedPendingDescriptor`, `TextOffsetChange`, the normative byte/count limits, and Task 2 digest functions; CodeMirror `EditorState`, `EditorView`, `Annotation`, `keymap`, and `Prec` from the exact Task 1 pins.
- Produces: `parseViewMessage(value):ViewMessage`, `parseHostMessage(value):HostMessage`, `parsePersistedState(value):PersistedLivePreviewState`, `createOperationId(sessionId:string,sequence:number):string`, and `createPendingDescriptor(operation:PendingOperation,subtle?:SubtleCrypto):Promise<PersistedPendingDescriptor>`; browser exports `hostSync:Annotation<boolean>`, `createLivePreviewEditor({parent,initial,cspNonce,postMessage,persistState,subtle?}):LivePreviewEditor`, and `startLivePreview({vscode,window,document}):void`.

- [ ] **Step 1: Write the failing exact-schema, bounds, and persistence tests.** Accept only `ready`, `edit`, `history`, and `focus` view messages and `initialize`, `documentChanged`, `operationAcknowledged`, `resync`, `pendingConflict`, and `connectionState` host messages. `ready` carries content-free `pendingDescriptors`; `initialize` carries exact source/version/digest, the fresh CSP nonce, and only bridge-reassociated transient operations. `operationAcknowledged` carries `sessionId`, `opId`, `afterVersion`, and authoritative `digest`. Begin with:

```js
const edit = parseViewMessage({
  type: "edit",
  sessionId: "session-a",
  opId: "session-a:1",
  baseVersion: 4,
  changes: [{ from: 1, to: 1, insert: "x", deletedText: "", leftContext: "a", rightContext: "b" }],
});
assert.equal(edit.type, "edit");
assert.throws(() => parseViewMessage({ ...edit, body: "complete source" }), /unknown field/);
assert.throws(() => parseViewMessage({ ...edit, baseVersion: -1 }), /baseVersion/);
```

- [ ] Enforce every normative cap before retaining or processing a frame: operation/session IDs are at most 128 UTF-8 bytes; CSP nonce is exactly 24 base64url characters; digest is exactly 64 lowercase hexadecimal characters; type/direction/reason/state strings are closed enums rather than free text; an edit has at most 256 changes; each `insert`/`deletedText` and conflict excerpt/insert is at most 4 MiB UTF-8; each context is at most 256 UTF-8 bytes; the complete serialized edit frame is at most 12 MiB; aggregate transient bodies eligible for same-host reassociation are at most 12 MiB; snapshot source is at most 16 MiB and any host frame at most 32 MiB. Reject non-safe-integer offsets/versions, duplicate/foreign session IDs, malformed operation IDs, non-string fields, unknown fields/types, and invalid enum values.
- [ ] Test a one-change select-all delete and replace of a generated 1 MiB QMD. Both operations travel in ordinary bounded `edit` messages and reach the injected `postMessage`, while the `vscode.setState` spy receives only the small descriptor. Add over-limit fixtures for every individual string field, change count, and total UTF-8 frame; use multibyte text so tests measure bytes rather than JavaScript code units.
- [ ] Assert persisted state is exactly `{sessionId,nextSequence,pendingDescriptors}` with at most 64 descriptors, 256 total numeric change-shape records, and 32 KiB serialized UTF-8. Reject recursive/unknown keys and any `source`, `body`, `changes`, `insert`, `deletedText`, `leftContext`, `rightContext`, authoritative excerpt, or pending text at any depth. A descriptor is exactly `{opId,baseVersion,changeDigest,shape:[{from,to,insertedUtf8Bytes,deletedUtf8Bytes}]}` and cannot reconstruct an edit.
- [ ] Source-scan `live-preview-editor.mjs` to require `hostSync` and `EditorView.cspNonce.of(cspNonce)`, and to reject imports/calls of CodeMirror `history`, `undo`, or `redo`. Spy on every `persistState` call during typing, IME composition, multi-change transactions, acknowledgement, conflict, and reload; deep-walk each stored value and prove no source/edit text is retained.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-live-preview-protocol.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `live-preview-protocol.mjs`.

- [ ] **Step 3: Implement exact parsers, content-free persistence, and the plain CodeMirror mirror.** Use an own-key check for every message object and this update-listener rule:

```js
export const hostSync = Annotation.define();

const forwardUserChanges = EditorView.updateListener.of(update => {
  if (!update.docChanged || update.transactions.some(transaction => transaction.annotation(hostSync))) return;
  const changes = [];
  update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes.push({
      from: fromA,
      to: toA,
      insert: inserted.toString(),
      deletedText: update.startState.sliceDoc(fromA, toA),
      leftContext: update.startState.sliceDoc(Math.max(0, fromA - 16), fromA),
      rightContext: update.startState.sliceDoc(toA, Math.min(update.startState.doc.length, toA + 16)),
    });
  });
  queueUserOperation(changes);
});
```

- [ ] Construct `EditorState` with only source editing, selection, line wrapping, `EditorView.cspNonce.of(cspNonce)`, the update listener, and a highest-precedence keymap that sends `{type:"history",direction:"undo"|"redo"}`. Do not include CodeMirror history or a second persistence adapter. `startLivePreview` must wait for a closed-schema `initialize` before creating `EditorState`, pass that message's nonce unchanged as `cspNonce`, and reject a second initialize or nonce change.
- [ ] For each user transaction, keep the full `PendingOperation` only in current webview memory, derive its SHA-256 descriptor, enforce the pending-state limits without dropping an unacknowledged descriptor, persist the descriptor-only state, and send the full bounded `edit` message normally. If accepting one more operation would exceed 64 operations, 256 shapes, 32 KiB descriptor state, or 12 MiB aggregate transient reassociation bodies, temporarily make the editor read-only with a visible “waiting for TextDocument acknowledgement” status until the head settles; never silently omit a pending descriptor.
- [ ] Apply authoritative non-origin changes with `view.dispatch({changes, annotations: hostSync.of(true)})`. On `operationAcknowledged`, remove the matching transient operation/descriptor and update its authoritative base to `afterVersion`/`digest` without dispatching that operation's changes a second time. A single-character insert, one IME composition transaction, and one disjoint multi-change transaction must each appear exactly once in the origin document after acknowledgement.
- [ ] Persist only `{sessionId,nextSequence,pendingDescriptors}` through `vscode.setState`. On reload, send those descriptors in `ready`; instantiate from the authoritative `initialize` snapshot. Replay only `reassociatedPendingOperations` whose full changes are still held by the same extension-host bridge, whose recomputed digest/shape exactly matches a descriptor, and which the bridge marks as not yet reflected in that snapshot. A reflected/event-candidate operation is not replayed; its descriptor waits for the later acknowledgement. If the bridge has no matching in-memory operation (including extension-host restart), synchronously replace persisted state with the empty descriptor list before enabling edits, let the authoritative snapshot win, and never synthesize or replay text from shape/digest metadata.
- [ ] Add protocol source/test files to the first-party manifest and rebuild the bundle.
- [ ] **Step 4: Run the focused tests and verify green.**

Run: `npm run build:documentation-webview && node --test products/workbench/tests/documentation-live-preview-protocol.test.mjs products/workbench/tests/documentation-webview-build.test.mjs`

Expected: PASS; the bundle contains CodeMirror and nonce support but no CodeMirror history, source map, dynamic import, network API, non-namespace URL literal, or persisted edit body.

- [ ] **Step 5: Refactor message validation into closed schemas.** Define immutable allowed-key records and keep parsers exhaustive:

```js
const VIEW_KEYS = Object.freeze({
  ready: Object.freeze(["type", "sessionId", "pendingDescriptors"]),
  edit: Object.freeze(["type", "sessionId", "opId", "baseVersion", "changes"]),
  history: Object.freeze(["type", "sessionId", "direction"]),
  focus: Object.freeze(["type", "sessionId", "anchor", "head"]),
});

const HOST_KEYS = Object.freeze({
  initialize: Object.freeze(["type", "sessionId", "source", "version", "digest", "cspNonce", "reassociatedPendingOperations"]),
  documentChanged: Object.freeze(["type", "sessionId", "beforeVersion", "afterVersion", "changes", "digest"]),
  operationAcknowledged: Object.freeze(["type", "sessionId", "opId", "afterVersion", "digest"]),
  resync: Object.freeze(["type", "sessionId", "source", "version", "digest", "reason"]),
  pendingConflict: Object.freeze(["type", "sessionId", "opId", "reason", "authoritativeExcerpt", "pendingInsert"]),
  connectionState: Object.freeze(["type", "sessionId", "state"]),
});
```

- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-live-preview-protocol.test.mjs`

Expected: PASS with every unknown field/message kind, oversized UTF-8 frame, replayable persisted value, and nonce omission rejected.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/live-preview-protocol.mjs products/workbench/extensions/chatero-documentation/webview products/workbench/first-party-extensions.json products/workbench/tests/documentation-live-preview-protocol.test.mjs
git commit -m "feat(documentation): add transient CodeMirror source mirror"
```

## Task 5: Rebase Pending Edits or Preserve a Visible Conflict

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/pending-edit-rebase.mjs`
- Create: `products/workbench/tests/documentation-pending-edit-rebase.test.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/live-preview-editor.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/live-preview.css`
- Modify: `products/workbench/first-party-extensions.json`

**Interfaces:**

- Consumes: context-bearing transient `PendingOperation[]` retained by the current webview or same extension-host bridge, authoritative source text/version, and `applyOffsetChanges` from Task 2. `PersistedPendingDescriptor[]` is never accepted by this module because a descriptor is not replay input.
- Produces: `rebasePendingOperations({authoritativeText:string,authoritativeVersion:number,pendingOperations:readonly PendingOperation[]}):{replayable:readonly {opId:string,changes:readonly TextOffsetChange[]}[],conflicts:readonly PendingConflict[]}` and `formatPendingConflict(conflict:PendingConflict):string`; `PendingConflict.reason` is exactly `"overlap" | "ambiguous-anchor" | "missing-anchor"`.

- [ ] **Step 1: Write the failing non-overlap/overlap tests.** Cover insertion before a pending range, deletion after it, identical repeated anchors, changed deleted text, multiple pending operations in order, Unicode context, and CRLF. Start with:

```js
const base = "alpha beta gamma\n";
const [change] = withChangeContext(base, [{ from: 6, to: 10, insert: "BETA" }]);
const result = rebasePendingOperations({
  authoritativeText: "prefix alpha beta gamma\n",
  authoritativeVersion: 9,
  pendingOperations: [{ opId: "s:1", baseVersion: 7, changes: [change] }],
});
assert.equal(result.conflicts.length, 0);
assert.deepEqual(result.replayable[0].changes.map(({ from, to }) => ({ from, to })), [{ from: 13, to: 17 }]);
```

- [ ] Assert an overlap never edits authoritative text and returns a conflict containing the operation ID, authoritative excerpt, deleted source, pending insert, contexts, and reason. Assert repeated non-unique context returns `ambiguous-anchor` rather than guessing.
- [ ] Assert `formatPendingConflict` includes accessible headings `Authoritative TextDocument source` and `Unacknowledged Live Preview change` without generating QMD conflict markers or a canonical edit.
- [ ] Assert passing descriptor-shaped data is rejected before mapping, and that conflict source/insert/context remains transient: it may appear in a bounded `pendingConflict` host frame and view-local DOM, but never in `vscode.setState`.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-pending-edit-rebase.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `pending-edit-rebase.mjs`.

- [ ] **Step 3: Implement unique context mapping and local conflict presentation.** Use exact-slice first, then a unique combined context search; never choose the first of multiple matches:

```js
function locateChange(text, change) {
  if (text.slice(change.from, change.to) === change.deletedText
      && text.slice(Math.max(0, change.from - change.leftContext.length), change.from) === change.leftContext
      && text.slice(change.to, change.to + change.rightContext.length) === change.rightContext) {
    return { kind: "mapped", from: change.from, to: change.to };
  }
  const needle = change.leftContext + change.deletedText + change.rightContext;
  const first = text.indexOf(needle);
  if (first < 0) return { kind: "missing-anchor" };
  if (text.indexOf(needle, first + 1) >= 0) return { kind: "ambiguous-anchor" };
  const from = first + change.leftContext.length;
  return { kind: "mapped", from, to: from + change.deletedText.length };
}
```

- [ ] Rebase operations sequentially against a private working string so earlier safe pending edits shift later ones. If any change in one operation conflicts, preserve the entire operation as one conflict and do not partially replay it.
- [ ] Render conflicts as view-local CodeMirror diagnostic panels tied to an authoritative source range. Keep source editable, retain the pending insert for copy/retry, and never dispatch conflict markers through the bridge.
- [ ] Add files to the first-party manifest and rebuild.
- [ ] **Step 4: Run the focused tests and verify green.**

Run: `npm run build:documentation-webview && node --test products/workbench/tests/documentation-pending-edit-rebase.test.mjs products/workbench/tests/documentation-live-preview-protocol.test.mjs`

Expected: PASS; safe edits map in order and every uncertain mapping becomes a visible local conflict.

- [ ] **Step 5: Refactor mapping results into frozen discriminated records.** Use these constructors throughout:

```js
const mapped = (from, to) => Object.freeze({ kind: "mapped", from, to });
const unmapped = kind => Object.freeze({ kind });
```

- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-pending-edit-rebase.test.mjs`

Expected: PASS and returned operations/conflicts are immutable.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/pending-edit-rebase.mjs products/workbench/extensions/chatero-documentation/webview products/workbench/first-party-extensions.json products/workbench/tests/documentation-pending-edit-rebase.test.mjs
git commit -m "feat(documentation): preserve pending edits across version changes"
```

## Task 6: Synchronize All Views Through One Per-URI Bridge

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/live-preview-bridge.mjs`
- Create: `products/workbench/tests/documentation-live-preview-bridge.test.mjs`
- Modify: `products/workbench/first-party-extensions.json`

**Interfaces:**

- Consumes: `WorkingCopyCoordinator` from Task 3; digest helpers and `DocumentEventFingerprint`/`ExpectedOriginEvent`; protocol parsers and content-free descriptor validation from Task 4; `rebasePendingOperations` from Task 5; injected `{workspace,commands}` and VS Code webview panels.
- Produces: `class LivePreviewBridgeRegistry`, `createLivePreviewBridgeRegistry({workspace,commands,coordinator}):LivePreviewBridgeRegistry`, `attach(document:vscode.TextDocument,panel:vscode.WebviewPanel,{cspNonce:string}):vscode.Disposable`, and `dispose():void`.

- [ ] **Step 1: Write the failing multi-view/origin-suppression bridge test.** Attach two panels and one standard-editor listener to the same fake document. Let panel A optimistically insert one character, then send its edit. Require one `WorkspaceEdit`, one dirty transition, no authoritative delta back to A, one authoritative delta to B, and one event-settled acknowledgement only for A:

```js
const registry = createLivePreviewBridgeRegistry({ workspace, commands, coordinator });
registry.attach(document, panelA, { cspNonce: "AAAAAAAAAAAAAAAAAAAAAAAA" });
registry.attach(document, panelB, { cspNonce: "BBBBBBBBBBBBBBBBBBBBBBBB" });
await panelA.receive({
  type: "edit",
  sessionId: "a",
  opId: "a:1",
  baseVersion: document.version,
  changes: withChangeContext(document.getText(), [{ from: 0, to: 1, insert: "Q" }]),
});
assert.equal(workspace.appliedEdits.length, 1);
assert.equal(panelA.messages.filter(message => message.type === "operationAcknowledged").length, 1);
assert.equal(panelA.messages.filter(message => message.type === "documentChanged").length, 0);
assert.equal(panelB.messages.filter(message => message.type === "operationAcknowledged").length, 0);
assert.equal(panelB.messages.at(-1).type, "documentChanged");
assert.equal(panelA.messages.at(-1).afterVersion, document.version);
assert.equal(panelA.messages.at(-1).digest, await digestSourceText(document.getText()));
```

- [ ] Exercise real editor transactions through the bridge for a single-character insert, one IME composition commit, and one disjoint multi-change transaction. For each, assert the origin's final CodeMirror source contains the change exactly once, each non-origin panel applies one `documentChanged`, and the origin receives exactly one `{type:"operationAcknowledged",sessionId,opId,afterVersion,digest}` only after the coordinator's event-settled result.
- [ ] Add tests for interleaved A/B operations, source-editor changes, unrelated document events, panel disposal, bridge disposal, clean external reload, dirty external conflict signal, rejected apply, stale resync, and reconnect with content-free pending descriptors. A standard-editor or external event with no matching expected head must send an authoritative `documentChanged` to every attached panel.
- [ ] Add the equal-bytes causal-race test: register A's expected head, inject a standard-editor event with identical content changes/resulting digest before the coordinator's locked final validation, and then return `version-conflict`. B may receive the tentative delta immediately; A must receive an authoritative `resync` when the candidate is reclassified, both panels end on the actual TextDocument snapshot, no `operationAcknowledged` is sent, and the coordinator never applies A's edit. Prove equality of text, change digest, and after digest alone cannot mis-correlate an external event.
- [ ] Reload a webview while the same extension-host bridge still retains a full pending operation: an exact descriptor match may return an operation not yet reflected in the snapshot in `initialize.reassociatedPendingOperations`. Reload again after its authoritative event but before acknowledgement: initialize from the updated snapshot, return no replay operation, then acknowledge it once. Finally dispose/recreate the extension host and reload the same descriptor: the bridge has no body, sends an authoritative snapshot with an empty reassociation list, and never reconstructs/replays the edit. Spy on `vscode.setState` and prove no full body/change/context is persisted in every case.
- [ ] Test `history` messages: `coordinator.drain(uri)` completes before exactly one `commands.executeCommand("undo"|"redo")`; no CodeMirror history call exists.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-live-preview-bridge.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `live-preview-bridge.mjs`.

- [ ] **Step 3: Implement one bridge record per URI, one expected-event head, and event-only acknowledgement.** Establish the registry shape and central change listener as follows:

```js
export class LivePreviewBridgeRegistry {
  constructor({ workspace, commands, coordinator }) {
    this.workspace = workspace;
    this.commands = commands;
    this.coordinator = coordinator;
    this.bridges = new Map();
    this.changeSubscription = workspace.onDidChangeTextDocument(event => this.#broadcastChange(event));
  }

  attach(document, panel, { cspNonce }) {
    const key = document.uri.toString();
    const bridge = this.bridges.get(key) ?? this.#createBridge(document);
    this.bridges.set(key, bridge);
    return bridge.attach(panel, { cspNonce });
  }
}

export function createLivePreviewBridgeRegistry(dependencies) {
  return new LivePreviewBridgeRegistry(dependencies);
}
```

- [ ] Maintain authoritative `{source,version,digest}` and an event tail inside each per-URI bridge. Convert `TextDocumentChangeEvent.contentChanges` from `rangeOffset/rangeLength/text` against the cached pre-event source into sorted `TextOffsetChange[]`; compute `{beforeVersion,afterVersion,changesDigest,afterDigest}` and process events FIFO so async SHA-256 cannot reorder them.
- [ ] Before calling `coordinator.applyVersionedTextEdits`, retain the full operation only in the bridge's private in-memory map and install the single per-URI expected head `{sessionId,opId,fingerprint}`. The fingerprint must bind exact base/next version, canonical ordered changes, and expected resulting source digest. Because edits are serialized, a second origin cannot replace that head.
- [ ] If an event has no exact expected-head fingerprint, broadcast `documentChanged` with `beforeVersion`, `afterVersion`, exact changes, and digest to every panel. If it matches the head, retain its event candidate, send that authoritative delta to every panel except the origin session, and send nothing yet to the origin. Never suppress an event merely because its text equals a pending edit.
- [ ] After `coordinator.applyVersionedTextEdits` returns `applied`, await this bridge's event tail through the returned `after` version, require its before/after versions to equal the retained candidate, clear the head/body, then send only `{type:"operationAcknowledged",sessionId,opId,afterVersion,digest}` to the origin. The origin removes its optimistic pending operation without dispatching changes. If there is no exact retained candidate, fail closed to resync rather than acknowledge.
- [ ] On `version-conflict` or `apply-failed`, await the event tail through the latest authoritative version, clear only the expected head, do not acknowledge, and do not discard the transient operation. If an equal-fingerprint candidate was tentatively withheld from the origin, reclassify it as external and send the origin an authoritative full `resync` before mapping pending operations; non-origin panels must not receive a duplicate delta. Then send the authoritative snapshot plus safe mapped operations/conflicts. This makes an equal-text external race visible to all panels without double-applying it in the optimistic origin.
- [ ] On `ready`, validate descriptor caps and recompute digest/shape from any same-session operation retained by this bridge. Include a full operation in `initialize.reassociatedPendingOperations` only on exact match and only when its event is not reflected in the authoritative snapshot; an operation with a retained event candidate remains descriptor-correlated but is omitted from replay and receives its eventual acknowledgement. Otherwise send an empty list and the current authoritative snapshot. Descriptors never enter `rebasePendingOperations`, never authorize an edit, and are discarded after an extension-host restart.
- [ ] On `history`, await `coordinator.drain(document.uri)` and invoke the normal Workbench command. Do not synthesize inverse edits.
- [ ] Dispose the per-URI bridge after its last panel closes, but keep acknowledged edits in the TextDocument. Dispose the workspace listener and coordinator only from the extension composition root.
- [ ] Add source/test files to the first-party manifest.
- [ ] **Step 4: Run the focused tests and verify green.**

Run: `node --test products/workbench/tests/documentation-live-preview-bridge.test.mjs products/workbench/tests/documentation-working-copy-coordinator.test.mjs products/workbench/tests/documentation-pending-edit-rebase.test.mjs`

Expected: PASS, including no origin echo for character/IME/multi-change transactions, equal-text external-race rejection, two-view FIFO, source-view synchronization, descriptor-only reconnect, restart snapshot authority, and drain-before-undo cases.

- [ ] **Step 5: Refactor bridge lookup and teardown.** Use one exact helper so no path forgets last-panel cleanup:

```js
#deleteBridgeWhenEmpty(key, bridge) {
  if (bridge.panelCount !== 0) return;
  bridge.dispose();
  if (this.bridges.get(key) === bridge) this.bridges.delete(key);
}
```

- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-live-preview-bridge.test.mjs`

Expected: PASS with zero listener/panel leaks after disposal.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/live-preview-bridge.mjs products/workbench/first-party-extensions.json products/workbench/tests/documentation-live-preview-bridge.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "feat(documentation): synchronize Live Preview splits without echo"
```

## Task 7: Register the Optional Custom Text Editor and Open Routing

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/live-preview-provider.cjs`
- Create: `products/workbench/extensions/chatero-documentation/live-preview-html.mjs`
- Create: `products/workbench/tests/documentation-live-preview-provider.test.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/package.json`
- Modify: `products/workbench/extensions/chatero-documentation/extension.cjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-tree.cjs`
- Modify: `products/workbench/tests/documentation-extension.test.mjs`
- Modify: `products/workbench/first-party-extensions.json`

**Interfaces:**

- Consumes: `createWorkingCopyCoordinator`, `createLivePreviewBridgeRegistry`, built assets under `media/documentation-webview/`, Phase 1 `registerDocumentation(vscode,context)`, and stable VS Code custom text editor/webview APIs.
- Produces: `LIVE_PREVIEW_VIEW_TYPE = "chatero.documentation.livePreview"`; `createLivePreviewNonce(randomBytes?:typeof import("node:crypto").randomBytes):string`; `createLivePreviewHtml({webview,scriptUri,styleUri,nonce}):string`; `class LivePreviewProvider` with `resolveCustomTextEditor(document,panel,token):Promise<void>`; `registerLivePreview({vscode,context}):vscode.Disposable[]`; and `openDocumentation(vscode,uri):Promise<void>`.

- [ ] **Step 1: Write failing manifest/provider/CSP tests.** Assert this exact contribution and setting:

```js
const editor = manifest.contributes.customEditors.find(
  value => value.viewType === "chatero.documentation.livePreview",
);
assert.deepEqual(editor, {
  viewType: "chatero.documentation.livePreview",
  displayName: "Chatero Live Preview",
  selector: [{ filenamePattern: "**/documentation/**/*.qmd" }],
  priority: "option",
});
assert.deepEqual(manifest.extensionKind, ["workspace"]);
assert.equal(manifest.contributes.configuration.properties["chatero.documentation.livePreview"].default, true);
```

- [ ] Assert the provider calls `registerCustomEditorProvider` without `supportsMultipleEditorsPerDocument`, enables scripts, limits `localResourceRoots` to the materialized webview media root in Phase 2, and attaches each panel to the shared bridge registry.
- [ ] Resolve two panels and assert each receives a different 144-bit base64url nonce from `createLivePreviewNonce`; for each panel, the exact same nonce appears in the script tag, `script-src 'nonce-…'`, `style-src … 'nonce-…'`, the bridge attachment, the closed-schema `initialize` message, and `EditorView.cspNonce.of(nonce)`. Require CSP exactly `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'nonce-${nonce}';`; permit the materialized stylesheet URI only through `webview.cspSource`, and reject `unsafe-inline`, `unsafe-eval`, wildcard/data/blob/network sources, inline handlers/styles, remote URLs, `iframe`, `object`, `embed`, or raw user source.
- [ ] In the provider unit test, source-assert the exact `EditorView.cspNonce.of(cspNonce)` extension and verify the nonce-bearing initialize frame; reserve real generated-style DOM inspection for Task 8's pinned Code-OSS webview. The externally materialized `live-preview.css` remains a nonce-free `<link>` covered only by `webview.cspSource`.
- [ ] Assert enabled Chatero tree/open commands use `vscode.openWith(uri, LIVE_PREVIEW_VIEW_TYPE)` when the preference is true and `vscode.openWith(uri, "default")` when false; `openSource` always uses `"default"`; ordinary file-open commands and editor associations are untouched.
- [ ] Give the provider a generated source just over 16 MiB UTF-8 and require a scoped “Live Preview size limit” result plus `vscode.openWith(uri,"default")`; it must not truncate/chunk the source, construct an oversized host frame, or change the user's global editor association.
- [ ] Assert provider failure reports one scoped error and leaves source openable; activation never imports or starts Zotero Core.
- [ ] **Step 2: Run the focused tests and verify red.**

Run: `node --test products/workbench/tests/documentation-live-preview-provider.test.mjs products/workbench/tests/documentation-extension.test.mjs`

Expected: FAIL because the custom editor contribution/provider is absent.

- [ ] **Step 3: Implement the provider, restrictive HTML, and command routing.** Register the provider with no multiple-editor option:

```js
const LIVE_PREVIEW_VIEW_TYPE = "chatero.documentation.livePreview";

function registerLivePreview({ vscode, context, bridgeRegistry }) {
  const provider = new LivePreviewProvider({ vscode, context, bridgeRegistry });
  return [vscode.window.registerCustomEditorProvider(LIVE_PREVIEW_VIEW_TYPE, provider)];
}

async function openDocumentation(vscode, uri) {
  const preferred = vscode.workspace
    .getConfiguration("chatero.documentation")
    .get("livePreview", true) === true;
  await vscode.commands.executeCommand(
    "vscode.openWith",
    uri,
    preferred ? LIVE_PREVIEW_VIEW_TYPE : "default",
  );
}
```

- [ ] In `resolveCustomTextEditor`, set `{enableScripts:true,localResourceRoots:[mediaRoot]}`, create script/style URIs with `webview.asWebviewUri`, generate a fresh nonce with `randomBytes(18).toString("base64url")`, set nonce-bound HTML, and call `bridgeRegistry.attach(document,panel,{cspNonce:nonce})`. The bridge must echo that exact per-panel nonce only in the first closed-schema `initialize` message so `startLivePreview` can pass it to `EditorView.cspNonce.of`; never copy source into an HTML literal or reuse a nonce across resolves.
- [ ] Before attachment, measure `document.getText()` with `TextEncoder`; if it exceeds `MAX_SNAPSHOT_SOURCE_UTF8`, report the scoped limit and reopen only that URI with the standard Text Editor. This is a presentation fallback, not a source mutation.
- [ ] Modify `extension.cjs` so the safe optional provider registers even while product routing is disabled; only the Documentation tree/product commands remain behind `chatero.documentation.enabled`. Catch provider registration failure independently so Phase 1 tree and standard editing survive.
- [ ] Add `onCustomEditor:chatero.documentation.livePreview`, the exact custom editor contribution, boolean preference, and command `chatero.documentation.open` to the manifest. Preserve `extensionKind: ["workspace"]`, `priority:"option"`, and existing Phase 1 commands.
- [ ] Add every provider/HTML asset explicitly to the first-party manifest.
- [ ] **Step 4: Run focused tests and verify green.**

Run: `npm run build:documentation-webview && node --test products/workbench/tests/documentation-live-preview-provider.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/documentation-live-preview-bridge.test.mjs`

Expected: PASS; both presentations remain available and only Chatero-owned open routing observes the preference.

- [ ] **Step 5: Refactor activation into independent failure domains.** Use this composition boundary so Live Preview, tree/state, and Zotero Core cannot take one another down:

```js
async function registerSafely(label, register, report) {
  try {
    return await register();
  }
  catch (error) {
    report(label, error);
    return [];
  }
}
```

- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-live-preview-provider.test.mjs products/workbench/tests/documentation-extension.test.mjs`

Expected: PASS, including injected provider and tree activation failures.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/package.json products/workbench/extensions/chatero-documentation/extension.cjs products/workbench/extensions/chatero-documentation/documentation-tree.cjs products/workbench/extensions/chatero-documentation/live-preview-provider.cjs products/workbench/extensions/chatero-documentation/live-preview-html.mjs products/workbench/first-party-extensions.json products/workbench/tests/documentation-live-preview-provider.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "feat(documentation): register optional TextDocument Live Preview"
```

## Task 8: Gate TextDocument Semantics in Pinned Code-OSS Locally and over SSH

**Files:**

- Create: `products/workbench/scripts/run-documentation-integration.mjs`
- Create: `products/workbench/tests/documentation-integration-runner.test.mjs`
- Create: `products/workbench/integration/documentation/driver/package.json`
- Create: `products/workbench/integration/documentation/driver/extension.cjs`
- Create: `products/workbench/integration/documentation/driver/run.cjs`
- Create: `products/workbench/integration/documentation/fixtures.mjs`
- Create: `products/workbench/integration/documentation/text-document-editor.test.mjs`
- Modify: `package.json`
- Modify: `products/workbench/tests/remote-agent-release.test.mjs`
- Modify: this plan

**Interfaces:**

- Consumes: verified/compiled `vendor/code-oss`, the materialized built-in extension, Chatero Remote Agent fixture from Phase 1, and CLI `--target local|ssh-fixture` plus optional `--grep <pattern>`.
- Produces: `runDocumentationIntegration({root,checkout,target,grep?,run?}):Promise<{target:string,workspace:string}>`; extension-test `run():Promise<void>`; npm command `test:documentation:integration`; local/SSH lifecycle evidence for the phase checkpoint.

- [ ] **Step 1: Write the failing runner contract and extension-host tests.** The Node runner test must inject a process recorder and require the pinned checkout, a fresh user-data directory, fresh extensions directory, generated QMD workspace, exact extension development/test paths, and no download URL:

```js
const calls = [];
await runDocumentationIntegration({
  root: repositoryRoot,
  checkout: codeOssFixture,
  target: "local",
  run: async call => calls.push(call),
});
assert.equal(calls.length, 1);
assert.ok(calls[0].args.some(arg => arg.startsWith("--user-data-dir=")));
assert.ok(calls[0].args.some(arg => arg.startsWith("--extensionTestsPath=")));
assert.doesNotMatch(JSON.stringify(calls), /download|update\.code\.visualstudio|marketplace\.visualstudio/);
```

- [ ] In `text-document-editor.test.mjs`, specify local and `vscode-remote://chatero-remote+fixture` cases for: standard/live split sharing one `TextDocument`; two Live Preview splits; first keypress dirty; save; autosave; revert; close confirmation; hot-exit restart; undo/redo; one user transaction/one undo; clean external reload; dirty external conflict; stale apply race; disconnect/reconnect with a pending edit; activation failure not affecting standard editing or Zotero Core fixture startup.
- [ ] Drive one real single-character insert, one IME composition commit, and one disjoint multi-change transaction from the origin Live Preview. Inspect bridge test telemetry and the editor source to require zero origin `documentChanged` echoes, one event-settled acknowledgement containing exact `afterVersion`/SHA-256 digest, one delta in the other split, and exactly one copy of each edit in both presentations.
- [ ] Inject a standard-editor edit with the same range/text/resulting digest while the Live Preview expectation is pending but before the coordinator's final locked validation. Require no acknowledgement, one authoritative origin resync, no duplicate application, and convergence in both panels. Separately inject ordinary standard/external changes and require `documentChanged` delivery to every panel.
- [ ] Exercise select-all delete and replace on a generated 1 MiB QMD, inspect webview state to prove it contains only bounded descriptors, reload under the same extension host both before and after the authoritative event to prove respectively one exact reassociation and zero reflected-operation replay, then restart the extension host and prove the authoritative TextDocument snapshot wins with no descriptor-driven replay. Perform the same sequence across SSH disconnect/reconnect.
- [ ] Inspect the resolved webview DOM/CSP: the per-panel nonce must match script, both CSP directives, `initialize.cspNonce`, and every CodeMirror-generated style element; `unsafe-inline` and network sources must be absent.
- [ ] Assert ordinary `vscode.open` follows the configured editor association, `openSource` forces default, the Chatero open command observes only the Live Preview preference, and “Reopen Editor With…” can create both presentations.
- [ ] **Step 2: Run the runner unit test and verify red.**

Run: `node --test products/workbench/tests/documentation-integration-runner.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `run-documentation-integration.mjs`.

- [ ] **Step 3: Implement the offline runner and Mocha driver.** The runner must verify provenance first and launch only the compiled pinned checkout:

```js
export async function runDocumentationIntegration({ root, checkout, target, grep, run = spawnAndWait }) {
  if (!new Set(["local", "ssh-fixture"]).has(target)) throw new TypeError("invalid Documentation integration target");
  await verifyCodeOss({ root, destination: checkout });
  const fixture = await createTemporaryDocumentationWorkspace({ target });
  const args = [
    `--user-data-dir=${fixture.userDataDir}`,
    `--extensions-dir=${fixture.extensionsDir}`,
    `--extensionDevelopmentPath=${fixture.driverExtensionPath}`,
    `--extensionTestsPath=${fixture.testRunnerPath}`,
    "--disable-updates",
    "--skip-welcome",
    fixture.workspaceUri,
  ];
  if (grep) args.push(`--chatero-documentation-grep=${grep}`);
  await run({ file: fixture.codeScript, args, cwd: checkout, env: fixture.environment });
  return Object.freeze({ target, workspace: fixture.redactedWorkspaceLabel });
}
```

- [ ] Use `xvfb-run` on Ubuntu and `scripts/code.sh` on macOS; never call `@vscode/test-electron` download helpers. The CommonJS driver `run.cjs` loads Mocha from the repository lock, adds the ESM `*.test.mjs` files, selects the requested tests, fails on any skip, and resolves only after disposal assertions.
- [ ] Generate fixtures under `mkdtemp`, never a personal workspace/profile. For `ssh-fixture`, install/use the provenance-pinned Remote Agent payload and the `chatero-remote+fixture` authority; reject a missing signed agent instead of silently substituting local files.
- [ ] Extend Remote Agent release tests so the workspace-kind `chatero-documentation` extension and generated `media/documentation-webview/live-preview.js/.css` are present with provenance in both signed Linux tuples.
- [ ] **Step 4: Run the unit test, then real local and SSH gates.**

Run: `node --test products/workbench/tests/documentation-integration-runner.test.mjs products/workbench/tests/remote-agent-release.test.mjs`

Expected: PASS with exact offline launch arguments and required remote payload files.

Run: `npm run test:documentation:integration -- --target local`

Expected: PASS for every TextDocument lifecycle case with zero skipped tests.

Run: `npm run test:documentation:integration -- --target ssh-fixture`

Expected: PASS for the same cases after an SSH disconnect/reconnect.

- [ ] **Step 5: Refactor the shared scenario matrix.** Export one immutable list from `fixtures.mjs` and run it against both authorities:

```js
export const TEXT_DOCUMENT_SCENARIOS = Object.freeze([
  "shared-buffer",
  "origin-ack-no-echo",
  "ime-and-multi-change-no-echo",
  "equal-text-external-race",
  "dirty-save-autosave-revert",
  "close-hot-exit-restart",
  "undo-redo-unit",
  "external-clean-and-dirty",
  "stale-version-race",
  "bounded-large-edit-state",
  "reload-reassociate-host-restart-snapshot",
  "disconnect-reconnect-pending",
  "nonce-bound-codemirror-styles",
  "activation-failure-isolation",
]);
```

- [ ] **Step 6: Run all Phase 2 gates after refactor.**

Run: `npm run test:documentation`

Expected: PASS with no skipped Documentation unit tests.

Run: `npm run test:documentation:integration -- --target local && npm run test:documentation:integration -- --target ssh-fixture`

Expected: PASS with the same scenario count for both targets.

Run: `npm run test:workbench-bootstrap`

Expected: PASS with deterministic first-party provenance and no generated file tracked.

Run: `npm run workbench:bootstrap && npm run workbench:verify`

Expected: PASS against Code-OSS 1.132.0 commit `df53daabb18cd157bdb08c7f01c34df936cf12f4`.

- [ ] Run `git diff --check`; inspect the scoped diff; verify no personal paths/data, `vendor/code-oss`, cache outputs, test profiles, Microsoft endpoints, or generated application bundles are staged. Record the passing commands under the checkpoint below.
- [ ] **Step 7: Commit.**

```bash
git add package.json products/workbench/scripts/run-documentation-integration.mjs products/workbench/tests/documentation-integration-runner.test.mjs products/workbench/tests/remote-agent-release.test.mjs products/workbench/integration/documentation docs/superpowers/plans/2026-08-12-documentation-phase-2-textdocument-editor.md
git commit -m "test(documentation): gate TextDocument editor locally and over SSH"
```

## Phase 2 Review Checkpoint

- [ ] `extensionKind` is exactly `["workspace"]`; `chatero.documentation.livePreview` remains an optional custom text editor and the standard Text Editor is always available.
- [ ] Ordinary opens and user editor associations remain unchanged; only enabled Chatero Documentation open commands read the Live Preview preference.
- [ ] One CodeMirror transaction produces one minimal `WorkspaceEdit`, one dirty transition, and one Workbench undo unit; CodeMirror history is absent.
- [ ] Multiple Live Preview panels and a standard editor share one `TextDocument`. A matching authoritative event reaches only non-origin panels; the optimistic origin receives only an event-settled acknowledgement with `afterVersion`/digest. Character, IME, and multi-change edits appear once, while external events reach all panels and an equal-text race cannot be mistaken for the origin apply.
- [ ] `vscode.setState` contains only bounded content-free descriptors; full pending operations are transient. Same-host reload may reassociate an exact retained operation, while extension-host restart always takes the authoritative TextDocument snapshot and never replays a descriptor. Select-all delete/replace on a 1 MiB QMD passes without persisting its body.
- [ ] Stale/non-overlap edits replay in order; overlap or ambiguous anchors remain visible locally and never overwrite authoritative source.
- [ ] Save, autosave, revert, close, hot exit, restart, external-change handling, undo, and redo pass under local and SSH authorities.
- [ ] `WorkingCopyCoordinator` has the exact Phase 4/5 shared interface in Task 3, applies multi-document settlement edits in one WorkspaceEdit, and has no dependency on Live Preview, CodeMirror, provider, or webview modules.
- [ ] Bundle generation is deterministic, lockfile-pinned, offline at runtime, license-complete, provenance-covered, below 4 MiB per file, and free of dynamic import/network loaders/Microsoft endpoints. AST auditing allows only the five fixed XML namespace URL literals and rejects every other bundle URL literal.
- [ ] Every resolved panel uses one fresh nonce shared by its script CSP/tag, style CSP, initialize message, and `EditorView.cspNonce`; CodeMirror-generated styles carry the nonce and CSP contains no `unsafe-inline`.
- [ ] `npm run test:documentation`, both `npm run test:documentation:integration` targets, `npm run test:workbench-bootstrap`, and `npm run workbench:verify` pass on the locked runtimes.
- [ ] Rollback boundary is documented: remove the Phase 2 provider/bridge/bundle files and their manifest entries and restore the Phase 1 manifest/activation. Canonical QMD remains ordinary workspace text; no migration, state rewrite, or Agent proposal is involved.
