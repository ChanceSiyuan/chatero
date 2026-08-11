# Zotero Notes, PDF, and Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Zotero Notes, attached PDFs, highlights, comments, page locations, and sync identity while presenting them as native Chatero workbench tabs.

**Architecture:** The headless Gecko Zotero Core remains the only owner of Zotero data and attachment identity. Code-OSS receives validated, read-only item/attachment/note/annotation records over the authenticated Unix socket; PDF and Note editors open from those records in native workbench tabs. Later mutations use a separate review capability and apply a bounded batch only after a user confirms the proposed annotations.

**Tech Stack:** Zotero Gecko APIs, generated JSON protocol, authenticated framed Unix sockets, Code-OSS extension APIs, Electron webviews, PDF.js/Zotero Reader assets, Node test runner.

## Global Constraints

- Never access or mutate `zotero.sqlite` from Electron or an extension.
- Identify every record with both `libraryId` and Zotero item key.
- Keep ordinary Library, Note, PDF, and annotation reads capability-scoped and read-only.
- Preserve Zotero annotation keys, page labels, colors, comments, and canonical position JSON.
- Do not copy, relocate, or rewrite user attachment files merely to preview them.
- AI-created annotations remain proposals until one explicit user approval applies the batch through Zotero Core.
- No Knowledge, Draft, Literature, Zotero profile, or attachment content enters Git.

---

### Task 1: Read-only evidence protocol

**Files:**
- Modify: `services/zotero-core/protocol/chatero-core.protocol.json`
- Modify: `services/zotero-core/generated/protocol.mjs`
- Modify: `services/zotero-core/generated/protocol.d.ts`
- Modify: `chrome/content/zotero/modules/chateroCoreProtocol.mjs`
- Test: `services/zotero-core/tests/protocol-generation.test.mjs`

**Interfaces:**
- Produces: `library.item-children({ libraryId, itemKey }) -> { attachments, notes }`.
- Produces: `library.annotations({ attachmentKey, libraryId }) -> { annotations }`.
- Produces: `library.note({ libraryId, noteKey }) -> { html, ...identity }`.

- [x] **Step 1: Write failing protocol-generation assertions** for all three method names and the attachment, note, and annotation record declarations.
- [x] **Step 2: Run `node --test services/zotero-core/tests/protocol-generation.test.mjs`** and confirm the new assertions fail because the methods are absent.
- [x] **Step 3: Add exact protocol records.** `LibraryAttachmentSummary` carries `attachmentKey`, `annotationCount`, `contentType`, `filename`, `libraryId`, `parentItemKey`, `path`, and `title`. `LibraryNoteSummary` carries `libraryId`, `noteKey`, `parentItemKey`, and `title`. `LibraryAnnotationSummary` carries `annotationKey`, `color`, `comment`, `libraryId`, `pageLabel`, `positionJson`, `sortIndex`, `text`, and `type`.
- [x] **Step 4: Regenerate and check the three runtime/declaration outputs** with `npm run core:generate && npm run core:check`.
- [x] **Step 5: Commit the protocol slice** with message `feat(core): define Zotero evidence records`.

### Task 2: Real Zotero read adapter and authenticated routing

**Files:**
- Modify: `chrome/content/zotero/xpcom/chateroCoreLibraryAdapter.mjs`
- Modify: `chrome/content/zotero/xpcom/chateroCoreRequestRouter.mjs`
- Modify: `services/zotero-core/fixture/fixture-core.mjs`
- Test: `services/zotero-core/tests/zotero-library-adapter.test.mjs`
- Test: `services/zotero-core/tests/gecko-core-router.test.mjs`
- Test: `services/zotero-core/tests/core-supervisor.integration.test.mjs`

**Interfaces:**
- Consumes: the three Task 1 methods and record shapes.
- Produces: `adapter.itemChildren(params)`, `adapter.annotations(params)`, and `adapter.note(params)`.

- [x] **Step 1: Add failing adapter tests** for a regular item with a PDF, child Note, duplicate keys in another library, and a PDF highlight with canonical page/position fields.
- [x] **Step 2: Run the adapter and router tests** and confirm they fail on the missing functions.
- [x] **Step 3: Implement exact parameter validation and composite-key lookup.** Resolve child IDs only through `Zotero.Items`, obtain paths with `getFilePathAsync()`, return no attachment record for a missing file, and never return an annotation from another attachment or library.
- [x] **Step 4: Route the three methods through the existing `library:read` capability** and implement deterministic fixture responses for transport tests.
- [x] **Step 5: Run `npm run test:zotero-core`** and require zero failures.
- [x] **Step 6: Commit the adapter slice** with message `feat(core): expose Notes and PDF annotations read-only`.

### Task 3: Native Library expansion and open commands

**Files:**
- Modify: `products/workbench/extensions/chatero-zotero/library-tree-model.mjs`
- Modify: `products/workbench/extensions/chatero-zotero/extension.cjs`
- Modify: `products/workbench/extensions/chatero-zotero/package.json`
- Test: `products/workbench/tests/native-library-extension.test.mjs`

**Interfaces:**
- Consumes: `library.item-children`, `library.note`, and `library.annotations`.
- Produces: `chatero.zotero.openAttachment` and `chatero.zotero.openNote` commands with frozen Core-originated records.

- [x] **Step 1: Add failing model and manifest tests** asserting regular items expand into PDF and Note rows and that only those rows expose open commands.
- [x] **Step 2: Run `npm run test:workbench-bootstrap`** and confirm the missing commands fail.
- [x] **Step 3: Implement lazy child loading and strict record validation.** Never accept a caller-supplied filesystem path that did not originate in the active Core session.
- [x] **Step 4: Register open commands that pass an opaque extension-owned record to the editor provider.** Do not use `openExternal`, macOS Preview, or a generic shell command.
- [x] **Step 5: Run the workbench tests and commit** with message `feat(workbench): open Zotero evidence from Library`.

### Task 4: Native PDF and Note editor tabs

**Files:**
- Create: `products/workbench/extensions/chatero-zotero/pdf-editor.cjs`
- Create: `products/workbench/extensions/chatero-zotero/note-editor.cjs`
- Create: `products/workbench/extensions/chatero-zotero/media/pdf-viewer/` from the repository-owned Zotero/PDF.js assets selected by the packaging manifest
- Modify: `products/workbench/extensions/chatero-zotero/extension.cjs`
- Modify: `products/workbench/extensions/chatero-zotero/package.json`
- Modify: `products/workbench/first-party-extensions.json`
- Test: `products/workbench/tests/zotero-evidence-editors.test.mjs`

**Interfaces:**
- Consumes: frozen attachment/note/annotation records from Task 3.
- Produces: one native custom-editor tab per `libraryId/itemKey`, PDF page navigation, visible highlights/comments, and a read-only Zotero Note view.

- [x] **Step 1: Add failing editor tests** for stable tab identity, page deep links, annotation overlay serialization, CSP, and disposal.
- [x] **Step 2: Run the focused editor tests** and confirm the providers are absent.
- [x] **Step 3: Register read-only custom editors.** Stream the Core-authorized local PDF URI through `webview.asWebviewUri`, load packaged PDF.js assets only, sanitize Note HTML, and block network/subframe navigation.
- [x] **Step 4: Map annotation `positionJson` into PDF.js page overlays** without changing the source PDF or Zotero database.
- [x] **Step 5: Run clean Code-OSS materialization and compilation** so the editors are proven in a generated workbench.
- [x] **Step 6: Commit the editor slice** with message `feat(workbench): add native Zotero PDF and Note tabs`.

### Task 5: Manual highlights and reviewed annotation writeback

**Files:**
- Modify: `services/zotero-core/protocol/chatero-core.protocol.json`
- Create: `chrome/content/zotero/xpcom/chateroCoreAnnotationReview.mjs`
- Modify: `chrome/content/zotero/xpcom/chateroCoreRequestRouter.mjs`
- Modify: `products/workbench/extensions/chatero-zotero/pdf-editor.cjs`
- Test: `services/zotero-core/tests/annotation-review.test.mjs`
- Test: `products/workbench/tests/zotero-evidence-editors.test.mjs`

**Interfaces:**
- Produces: native text selection and highlight controls that preserve Zotero annotation identity and positions.
- Produces: `annotation.review.prepare` under `annotations:propose` and `annotation.review.apply` under `annotations:write`.
- Produces: an expiring review token bound to profile epoch, library, attachment, exact proposal digest, and proposed operations.

- [ ] **Step 1: Add failing tests** proving ordinary sessions cannot write, tampered/expired/cross-profile proposals fail closed, and a valid reviewed batch writes once.
- [ ] **Step 2: Add the PDF.js text layer and manual highlight controls.** A user-created highlight is previewed in the PDF tab and written through the same bounded Zotero transaction path; existing annotation keys and positions remain untouched.
- [ ] **Step 3: Implement prepare without mutation** and show a single human-readable review panel in the PDF tab.
- [ ] **Step 4: Implement apply inside one Zotero transaction** using Zotero annotation items, then emit `library.changed`; consume the token even when application fails.
- [ ] **Step 5: Run Core, workbench, legacy Chatero, clean Code-OSS compile, and a disposable-profile Gecko smoke.**
- [ ] **Step 6: Commit the writeback slice** with message `feat(zotero): preserve manual and reviewed annotations`.
