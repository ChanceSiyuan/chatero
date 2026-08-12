# Documentation Phase 3 Live Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 2 plain-source editor into an incremental, source-preserving QMD Live Preview for prose, formulas, tables, safe relative raster images, theorem/lemma/proof blocks, per-view proof collapse, and a separate read-only Quarto render isolated by a product-private child-process sandbox.

**Architecture:** The CodeMirror document always retains the exact QMD source; incremental Lezer nodes and viewport-scoped decorations provide visual presentation, while selection-aware source maps reveal the smallest editable source range. Structure modules are independent failure boundaries composed by `qmd-preview.mjs`; unsafe, malformed, ambiguous, or failed nodes fall back locally to source. Image bytes cross a typed authority-side snapshot boundary into a disposable extension cache. The reusable `SafeQuartoRenderer` never runs in a canonical/document working directory and never starts Quarto's preview server: the authority materializes a content-addressed passive snapshot, a deny-by-default product sandbox runs one fixed Quarto render, and a Chatero-owned static loopback server exposes only validated last-good output.

**Tech Stack:** Phase 2 `CustomTextEditorProvider`/`WorkingCopyCoordinator`, CodeMirror 6, `@codemirror/language` 6.12.4, `@codemirror/lang-markdown` 6.5.2, `@lezer/markdown` 1.7.2, KaTeX 0.16.22, esbuild 0.28.2, stable Code-OSS 1.132.0 extension/webview APIs, a signature-pinned Quarto/Pandoc runtime invoked with `render --no-execute`, a product-private OS child-process sandbox, a Chatero static loopback server, Node 24.18.0, Electron 42.7.1, Node test runner, and pinned Code-OSS extension-host integration tests.

## Global Constraints

- Execute only after [Phase 2](./2026-08-12-documentation-phase-2-textdocument-editor.md) passes its checkpoint; the approved contract remains [the unified Documentation design](../specs/2026-08-12-unified-agent-knowledge-documentation-design.md).
- Preserve `extensionKind: ["workspace"]`, view type `chatero.documentation.livePreview`, `priority: "option"`, the standard Text Editor, the Phase 2 per-URI bridge, and the Phase 2 `WorkingCopyCoordinator` interface unchanged.
- Keep `chatero.documentation.enabled` defaulted to `false` through this phase. Safe passive Live Preview may operate in an untrusted workspace; Quarto must refuse before process creation unless the workspace is trusted.
- The CodeMirror document always contains the original QMD. Decorations and widgets never normalize or serialize a document AST, never call whole-document `setValue`, and never gain save/undo authority.
- Parse incrementally with Lezer and decorate only affected nodes intersecting visible ranges. A normal keypress must not parse, render, stringify, or diff the complete document.
- All source coordinates are exact UTF-16 `[from,to)` ranges. Preserve CRLF, final newline, delimiters, IDs, attributes, labels, whitespace, and unsupported bytes.
- Moving the caret into or selecting a supported structure reveals the smallest editable source range; leaving it restores presentation. One failed/ambiguous node falls back only its smallest safe range to source.
- Support prose, headings, emphasis, lists, links, code spans, inline/display formulas, Markdown tables, workspace-relative raster images, theorem/lemma fenced Divs, and proof blocks. Do not activate raw HTML or unsupported QMD.
- Formula reveal includes original delimiters/expression. Table cell entry reveals the complete source row only. Image entry reveals original Markdown target/attributes. Formal source reveal preserves opener, exact attributes/label/body, and closer.
- Proof collapse is per `EditorView`: `collapse="true"` initializes collapsed, missing/false initializes expanded, selection temporarily reveals, and toggling never creates a document transaction.
- Live Preview never loads `http:`, `https:`, `file:`, foreign-authority, SVG, `data:`, command URI, raw active HTML, script, iframe, object, or embed content. KaTeX uses `trust:false`.
- Image preview accepts only contained relative PNG, JPEG, GIF, WebP, or AVIF whose signature matches its MIME, with a 20 MiB maximum. Source symlink/junction containment is proven authority-side; `localResourceRoots` alone is not proof.
- The Live Preview webview CSP is deny-by-default. A fresh per-panel nonce authorizes the fixed bundle and every CodeMirror-created style element through `EditorView.cspNonce`; `style-src`, `font-src`, and `img-src` admit only `webview.cspSource` backed by the exact materialized media/font and per-session derived-image `localResourceRoots`. Network, `data:`, `blob:`, `file:`, and `'unsafe-inline'` are never allowed.
- Exact Quarto preview is a separate read-only command/webview. It accepts only saved, authority-verified input and requires normal workspace trust, but trust and `--no-execute` are not a sandbox. Quarto runs only against a content-addressed disposable snapshot under a product-private deny-by-default OS sandbox; it never receives a canonical/document cwd, never listens on a port, and never sees the rest of the workspace, home, `CODEX_HOME`, credentials, or network. Sandbox unavailability makes exact preview unavailable on that platform. A Chatero-owned static loopback server, forwarded with `env.asExternalUri`, serves validated output and retains last-good content.
- Extension/webview modules never import Node `fs`. A fixed authority helper may read a bounded verified image snapshot; the extension may use `workspace.fs` only for a derived, disposable cache outside the canonical workspace.
- Browser runtime assets are lockfile-pinned, deterministically bundled, provenance-covered, below 4 MiB each, license-complete, and contain no runtime dependency on npm/CDN/Open VSX/Microsoft endpoints.
- On Ubuntu 24.04 with Node 24.18.0, a generated 1 MiB/10,000-block fixture must keep p95 synchronous input transaction plus incremental decoration update at or below 16 ms after warm-up. Image decode, Quarto, indexing, and SSH/network latency are excluded.
- Use generated non-personal fixtures. Gecko files `qmdSourceModel.js`, `qmdVisualEditor.js`, `qmdMathRender.js`, `qmdPreview.js`, and `qmdPreviewController.js` are behavior oracles only; do not port their regex parser, Gecko DOM, resident-mode UI, Draft autosave, or whole-document replacement model.

---

## Phase File Map

### Create

- `products/workbench/extensions/chatero-documentation/webview/qmd-language.mjs`
- `products/workbench/extensions/chatero-documentation/webview/qmd-source-model.mjs`
- `products/workbench/extensions/chatero-documentation/webview/qmd-preview.mjs`
- `products/workbench/extensions/chatero-documentation/webview/source-reveal.mjs`
- `products/workbench/extensions/chatero-documentation/webview/prose-decorations.mjs`
- `products/workbench/extensions/chatero-documentation/webview/formula-decorations.mjs`
- `products/workbench/extensions/chatero-documentation/webview/table-decorations.mjs`
- `products/workbench/extensions/chatero-documentation/webview/image-decorations.mjs`
- `products/workbench/extensions/chatero-documentation/webview/formal-block-parser.mjs`
- `products/workbench/extensions/chatero-documentation/webview/formal-block-decorations.mjs`
- `products/workbench/extensions/chatero-documentation/webview/proof-collapse.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-image-resolver.mjs`
- `products/workbench/extensions/chatero-documentation/quarto-target.mjs`
- `products/workbench/extensions/chatero-documentation/quarto-input-policy.mjs`
- `products/workbench/extensions/chatero-documentation/safe-quarto-sandbox.mjs`
- `products/workbench/extensions/chatero-documentation/safe-quarto-renderer.mjs`
- `products/workbench/extensions/chatero-documentation/quarto-static-server.mjs`
- `products/workbench/extensions/chatero-documentation/quarto-preview-manager.mjs`
- `products/workbench/extensions/chatero-documentation/quarto-preview-html.mjs`
- `products/workbench/extensions/chatero-documentation/licenses/KaTeX-MIT.txt`
- `products/workbench/tests/documentation-qmd-source-model.test.mjs`
- `products/workbench/tests/documentation-prose-preview.test.mjs`
- `products/workbench/tests/documentation-formula-preview.test.mjs`
- `products/workbench/tests/documentation-table-preview.test.mjs`
- `products/workbench/tests/documentation-image-preview.test.mjs`
- `products/workbench/tests/documentation-formal-block-preview.test.mjs`
- `products/workbench/tests/documentation-proof-collapse.test.mjs`
- `products/workbench/tests/documentation-quarto-preview.test.mjs`
- `products/workbench/tests/documentation-live-preview-security.test.mjs`
- `products/workbench/tests/documentation-live-preview-accessibility.test.mjs`
- `products/workbench/tests/documentation-live-preview-performance.test.mjs`
- `products/workbench/integration/documentation/live-preview.test.mjs`
- `products/workbench/integration/documentation/quarto-preview.test.mjs`

### Modify

- `package.json`
- `package-lock.json`
- `products/workbench/extensions/chatero-documentation/package.json`
- `products/workbench/extensions/chatero-documentation/extension.cjs`
- `products/workbench/extensions/chatero-documentation/documentation-authority-client.mjs`
- `products/workbench/extensions/chatero-documentation/documentation-workspace.mjs`
- `products/workbench/extensions/chatero-documentation/live-preview-protocol.mjs`
- `products/workbench/extensions/chatero-documentation/live-preview-bridge.mjs`
- `products/workbench/extensions/chatero-documentation/live-preview-provider.cjs`
- `products/workbench/extensions/chatero-documentation/webview/live-preview-editor.mjs`
- `products/workbench/extensions/chatero-documentation/webview/live-preview.css`
- `products/workbench/documentation-authority/protocol.mjs`
- `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`
- `products/workbench/scripts/build-documentation-webview.mjs`
- `products/workbench/first-party-extensions.json`
- `products/workbench/tests/first-party-extensions.test.mjs`
- `products/workbench/tests/documentation-live-preview-protocol.test.mjs`
- `products/workbench/tests/documentation-live-preview-provider.test.mjs`
- `products/workbench/tests/documentation-remote-transaction.test.mjs`
- `products/workbench/tests/remote-agent-release.test.mjs`
- `products/workbench/integration/documentation/driver/run.cjs`

## Normative Phase 3 Types

```ts
type SourceRange = Readonly<{from:number; to:number}>;
type VisualKind =
  | "prose" | "heading" | "emphasis" | "list" | "link" | "code-span"
  | "formula-inline" | "formula-display" | "table" | "image"
  | "theorem" | "lemma" | "proof" | "unsupported";

type QmdVisualNode = Readonly<{
  kind: VisualKind;
  from: number;
  to: number;
  source: string;
  reveal: SourceRange;
  children: readonly QmdVisualNode[];
}>;

type ImageResolution =
  | Readonly<{kind:"ready";target:string;src:string;mime:string;size:number;revision:string}>
  | Readonly<{
      kind:"placeholder";
      target:string;
      reason:"missing"|"unsafe"|"too-large"|"mime-mismatch"|"unsupported-type"|"unavailable";
    }>;

type FormalBlock = Readonly<{
  kind:"theorem"|"lemma"|"proof";
  range:SourceRange;
  opener:SourceRange;
  attributes:Readonly<{range:SourceRange;raw:string;id:string|null;classes:readonly string[];values:ReadonlyMap<string,string>}>;
  label:SourceRange|null;
  body:SourceRange;
  closer:SourceRange;
}>;
```

## Task 1: Add Incremental QMD Prose Parsing and Local Source Reveal

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/webview/qmd-language.mjs`
- Create: `products/workbench/extensions/chatero-documentation/webview/qmd-source-model.mjs`
- Create: `products/workbench/extensions/chatero-documentation/webview/qmd-preview.mjs`
- Create: `products/workbench/extensions/chatero-documentation/webview/source-reveal.mjs`
- Create: `products/workbench/extensions/chatero-documentation/webview/prose-decorations.mjs`
- Create: `products/workbench/tests/documentation-qmd-source-model.test.mjs`
- Create: `products/workbench/tests/documentation-prose-preview.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `products/workbench/extensions/chatero-documentation/webview/live-preview-editor.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/live-preview.css`
- Modify: `products/workbench/first-party-extensions.json`

**Interfaces:**

- Consumes: exact QMD source in Phase 2 `EditorState.doc`; CodeMirror `markdown`, `GFM`, `syntaxTree`, `ensureSyntaxTree`, `Decoration`, `ViewPlugin`, and `visibleRanges`.
- Produces: `createQmdLanguage():LanguageSupport`; `collectVisualNodes(state:EditorState,visibleRanges:readonly SourceRange[]):readonly QmdVisualNode[]`; `sourceRevealRange(node:QmdVisualNode,selection:EditorSelection):SourceRange|null`; `createProseDecorations():Extension`; and `createQmdPreviewExtensions({postMessage}):readonly Extension[]`.

- [ ] **Step 1: Write failing parser/reveal/presentation tests.** Use generated LF and CRLF fixtures containing YAML, paragraphs, ATX headings, emphasis, lists, links, code spans, fenced code cells, raw HTML, citations, unknown extensions, and malformed delimiters. Start with:

```js
const source = "---\r\ntitle: Demo\r\n---\r\n\r\n# Heading\r\n\r\nText with *care* and `x <- 1`.\r\n";
const state = EditorState.create({ doc: source, extensions: [createQmdLanguage()] });
const nodes = collectVisualNodes(state, [{ from: source.indexOf("#"), to: source.length }]);
assert.deepEqual(nodes.map(node => node.kind), ["heading", "prose"]);
assert.equal(state.doc.toString(), source);
assert.deepEqual(
  sourceRevealRange(nodes[0], EditorSelection.cursor(source.indexOf("Heading"))),
  { from: source.indexOf("# Heading"), to: source.indexOf("\r\n", source.indexOf("# Heading")) },
);
```

- [ ] Assert only nodes intersecting the supplied visible ranges are returned; an edit in one paragraph reuses the unaffected syntax tree and does not enumerate all 10,000 offscreen blocks.
- [ ] Assert code fences/code spans exclude QMD math/fenced-Div recognition, raw HTML/unknown/malformed ranges remain literal source, and decoration-only selection/viewport/focus transactions leave exact source bytes unchanged.
- [ ] Assert inactive prose semantics are represented with accessible DOM roles/classes, while caret/selection reveals the smallest complete heading/emphasis/link/code-span range.
- [ ] **Step 2: Run focused tests and verify red.**

Run: `node --test products/workbench/tests/documentation-qmd-source-model.test.mjs products/workbench/tests/documentation-prose-preview.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `qmd-language.mjs`.

- [ ] **Step 3: Install exact language pins and implement the incremental source model.** Mutate the lockfile with:

```bash
npm install --save-dev --save-exact @codemirror/language@6.12.4 @codemirror/lang-markdown@6.5.2 @lezer/markdown@1.7.2
```

Build the language and visible-range traversal with these boundaries:

```js
export function createQmdLanguage() {
  return markdown({
    base: markdownLanguage,
    extensions: [GFM, qmdMathExtension, qmdFencedDivExtension],
  });
}

export function collectVisualNodes(state, visibleRanges) {
  const nodes = [];
  for (const range of visibleRanges) {
    const tree = ensureSyntaxTree(state, range.to, 16) ?? syntaxTree(state);
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(cursor) {
        const node = visualNodeFromCursor(state, cursor);
        if (node) nodes.push(node);
      },
    });
  }
  return Object.freeze(coalesceAndFreeze(nodes));
}
```

- [ ] Implement Lezer Markdown extensions for QMD math and fenced Div boundaries, but leave structure-specific interpretation to later tasks. Exclude fenced/inline code by parser context instead of a global regex scan.
- [ ] Build prose marks/widgets only for visible supported nodes. Use DOM `createElement`/`textContent`, validated Workbench link messages, and CodeMirror decorations; never inject source with `innerHTML`.
- [ ] Compose language/source/prose extensions in `qmd-preview.mjs` and add them to the Phase 2 editor state. A thrown node conversion returns one `unsupported` range and does not disable the view.
- [ ] Add all modules/tests to the first-party manifest and rebuild.
- [ ] **Step 4: Run focused tests and verify green.**

Run: `npm run build:documentation-webview && node --test products/workbench/tests/documentation-qmd-source-model.test.mjs products/workbench/tests/documentation-prose-preview.test.mjs products/workbench/tests/documentation-webview-build.test.mjs`

Expected: PASS with exact LF/CRLF preservation, visible-range traversal, code exclusion, and local source reveal.

- [ ] **Step 5: Refactor node conversion into a closed handler map.** Keep unsupported syntax explicit:

```js
const NODE_HANDLERS = Object.freeze({
  Paragraph: proseNode,
  ATXHeading1: headingNode,
  ATXHeading2: headingNode,
  Emphasis: emphasisNode,
  BulletList: listNode,
  OrderedList: listNode,
  Link: linkNode,
  InlineCode: codeSpanNode,
});
```

- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-qmd-source-model.test.mjs products/workbench/tests/documentation-prose-preview.test.mjs`

Expected: PASS and unknown node names stay source-visible.

- [ ] **Step 7: Commit.**

```bash
git add package.json package-lock.json products/workbench/extensions/chatero-documentation/webview products/workbench/first-party-extensions.json products/workbench/tests/documentation-qmd-source-model.test.mjs products/workbench/tests/documentation-prose-preview.test.mjs
git commit -m "feat(documentation): render incremental QMD prose"
```

## Task 2: Render Source-Preserving Inline and Display Formulas

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/webview/formula-decorations.mjs`
- Create: `products/workbench/extensions/chatero-documentation/licenses/KaTeX-MIT.txt`
- Create: `products/workbench/tests/documentation-formula-preview.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `products/workbench/scripts/build-documentation-webview.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/live-preview-html.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/live-preview-provider.cjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/live-preview-editor.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/qmd-preview.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/live-preview.css`
- Modify: `products/workbench/first-party-extensions.json`
- Modify: `products/workbench/tests/documentation-live-preview-provider.test.mjs`

**Interfaces:**

- Consumes: exact `InlineMath`/`DisplayMath` QMD Lezer nodes, selection-aware source reveal, injected KaTeX `render(expression,element,options)`, and the fresh nonce generated by the Phase 2 provider/HTML composition root.
- Produces: `KATEX_OPTIONS`; `collectFormulaNodes(state,visibleRanges):readonly FormulaNode[]`; `formulaRevealRange(node):SourceRange`; `renderFormulaInto({node,source,container,katex}):{kind:"rendered"}|{kind:"fallback";message:string}`; `createFormulaDecorations({katex}):Extension`; and one CSP path in which `live-preview-editor.mjs` consumes that nonce with `EditorView.cspNonce.of(nonce)`.

- [ ] **Step 1: Write failing formula mapping/render tests.** Cover `$x$`, `\(x\)`, `$$x$$`, `\[x\]`, multiline display math, CRLF, escaped delimiters, currency, code spans/fences, malformed/empty expressions, KaTeX errors, and formulas inside formal-block bodies. Begin with:

```js
const source = "Cost is `$5`, but math is $x^2 + 1$.\r\n\r\n$$\r\ny = mx+b\r\n$$\r\n";
const formulas = collectFormulaNodes(makeState(source), [{ from: 0, to: source.length }]);
assert.deepEqual(formulas.map(node => source.slice(node.from, node.to)), ["$x^2 + 1$", "$$\r\ny = mx+b\r\n$$"]);
assert.deepEqual(formulaRevealRange(formulas[0]), { from: formulas[0].from, to: formulas[0].to });
```

- [ ] Inject a fake KaTeX renderer and assert exact expression text, `displayMode`, `output:"htmlAndMathml"`, `throwOnError:true`, `strict:"error"`, `trust:false`, `maxExpand:1000`, and `maxSize:20`. Source-scan Chatero modules to prove they never assign/call `innerHTML`/`insertAdjacentHTML`; the source expression is passed only to this fixed-trust KaTeX call, and only DOM/markup generated by KaTeX may populate the supplied container.
- [ ] Assert inactive math is visual, entering reveals exact delimiters/expression, leaving restores the widget, and a KaTeX error shows a source-linked diagnostic without affecting another formula or document bytes.
- [ ] Exercise a real custom-editor webview rather than only matching an HTML string: require a fresh nonce for each panel, observe CodeMirror's dynamically created style element carrying that nonce, load the bundled stylesheet and one materialized KaTeX WOFF2 through `webview.cspSource`, and prove computed CodeMirror/KaTeX styles apply. Requests for a network, `data:`, `blob:`, `file:`, non-materialized font, or a style without the nonce must be blocked.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-formula-preview.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `formula-decorations.mjs`.

- [ ] **Step 3: Pin KaTeX and implement trusted-library DOM rendering.** Make the existing dependency exact:

```bash
npm install --save-exact katex@0.16.22
```

Use this fixed option record and never permit QMD attributes to override it:

```js
export const KATEX_OPTIONS = Object.freeze({
  output: "htmlAndMathml",
  throwOnError: true,
  strict: "error",
  trust: false,
  maxExpand: 1000,
  maxSize: 20,
});

export function renderFormulaInto({ node, source, container, katex }) {
  try {
    katex.render(source.slice(node.contentFrom, node.contentTo), container, {
      ...KATEX_OPTIONS,
      displayMode: node.kind === "formula-display",
    });
    return Object.freeze({ kind: "rendered" });
  }
  catch (error) {
    container.replaceChildren(makeFormulaFallback(node, error));
    return Object.freeze({ kind: "fallback", message: String(error.message ?? error) });
  }
}
```

- [ ] Extend the deterministic builder to copy only KaTeX WOFF2 files referenced by generated CSS under `fonts/`; omit WOFF/TTF, source maps, and data URLs. Add exact generated font mappings plus the complete KaTeX MIT license to the first-party manifest.
- [ ] Harden `createLivePreviewHtml` to emit `default-src 'none'`; nonce-only `script-src`; `style-src` restricted to `webview.cspSource` plus that nonce; and `font-src`/`img-src` restricted to `webview.cspSource`. It must omit network origins, `data:`, `blob:`, `file:`, and `'unsafe-inline'`. The provider supplies a new nonce per resolved panel, passes it to the fixed bootstrap, and keeps `localResourceRoots` to the exact materialized webview media root at this task. `live-preview-editor.mjs` consumes the same nonce with `EditorView.cspNonce.of(nonce)`; QMD can neither read nor override it.
- [ ] Add formula decorations to `qmd-preview.mjs`. Hide/replace only the exact inactive formula range; active selection returns source. Preserve formulas inside formal bodies for Task 5 composition.
- [ ] **Step 4: Run focused tests and verify green.**

Run: `npm run build:documentation-webview && node --test products/workbench/tests/documentation-formula-preview.test.mjs products/workbench/tests/documentation-webview-build.test.mjs products/workbench/tests/documentation-live-preview-provider.test.mjs products/workbench/tests/first-party-extensions.test.mjs`

Expected: PASS; the webview actually loads nonce-bearing CodeMirror styles and a materialized WOFF2, rejects every other source class, KaTeX trust is false, and every output stays below 4 MiB.

- [ ] **Step 5: Refactor formula parsing/rendering failure boundaries.** Use a frozen fallback result and strip stack/absolute paths from user-facing messages:

```js
function formulaFallback(message = "Formula could not be rendered") {
  return Object.freeze({ kind: "fallback", message });
}
```

- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-formula-preview.test.mjs products/workbench/tests/documentation-webview-build.test.mjs`

Expected: PASS with no absolute path or raw stack in the fallback.

- [ ] **Step 7: Commit.**

```bash
git add package.json package-lock.json products/workbench/scripts/build-documentation-webview.mjs products/workbench/extensions/chatero-documentation/live-preview-html.mjs products/workbench/extensions/chatero-documentation/live-preview-provider.cjs products/workbench/extensions/chatero-documentation/webview/live-preview-editor.mjs products/workbench/extensions/chatero-documentation/webview/formula-decorations.mjs products/workbench/extensions/chatero-documentation/webview/qmd-preview.mjs products/workbench/extensions/chatero-documentation/webview/live-preview.css products/workbench/extensions/chatero-documentation/licenses/KaTeX-MIT.txt products/workbench/first-party-extensions.json products/workbench/tests/documentation-formula-preview.test.mjs products/workbench/tests/documentation-live-preview-provider.test.mjs products/workbench/tests/documentation-webview-build.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "feat(documentation): render source-preserving formulas"
```

## Task 3: Render Markdown Tables with Row-Scoped Source Editing

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/webview/table-decorations.mjs`
- Create: `products/workbench/tests/documentation-table-preview.test.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/qmd-preview.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/live-preview.css`
- Modify: `products/workbench/first-party-extensions.json`

**Interfaces:**

- Consumes: GFM table nodes from `createQmdLanguage`, exact source slices, selection, and DOM `textContent`.
- Produces: `collectTableNodes(state,visibleRanges):readonly TableNode[]`; `tableRowRevealRange(table:TableNode,offset:number):SourceRange|null`; `tableCellSelection(table,rowIndex,columnIndex):number`; and `createTableDecorations():Extension`.

- [ ] **Step 1: Write failing exact-row tests.** Cover alignment separators, escaped pipes, code spans containing pipes, empty cells, Unicode, CRLF, missing separator, inconsistent columns, and a table adjacent to unsupported QMD. Begin with:

```js
const source = "| Name | Value |\r\n| :--- | ---: |\r\n| α | `a|b` |\r\n| β | 2 |\r\n";
const [table] = collectTableNodes(makeState(source), [{ from: 0, to: source.length }]);
const beta = source.indexOf("β");
assert.deepEqual(
  tableRowRevealRange(table, beta),
  { from: source.lastIndexOf("|", beta), to: source.indexOf("\r\n", beta) },
);
assert.equal(source.slice(table.from, table.to), source);
```

- [ ] Assert inactive rows render as table/header/body/cell semantics; selecting/clicking one cell reveals that complete original source row while all other valid rows remain visual.
- [ ] Assert editing the revealed row emits only its normal Phase 2 source change; leaving restores from reparsed source. No path serializes cells, alignment, or the whole table.
- [ ] Assert malformed/ambiguous table ranges remain source, and one widget exception yields a source-linked table fallback without hiding adjacent prose.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-table-preview.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `table-decorations.mjs`.

- [ ] **Step 3: Implement syntax-tree row/cell ranges and safe DOM.** Map offsets from Lezer children and reveal complete physical rows:

```js
export function tableRowRevealRange(table, offset) {
  const row = table.rows.find(value => value.from <= offset && offset <= value.to);
  return row ? Object.freeze({ from: row.from, to: row.to }) : null;
}

function renderCell(document, cell) {
  const element = document.createElement(cell.header ? "th" : "td");
  element.textContent = cell.displayText;
  element.dataset.sourceFrom = String(cell.from);
  return element;
}
```

- [ ] Decode only Markdown display escapes for presentation; retain exact source ranges as authority. A click dispatches a selection into the cell source and relies on the selection-aware decoration rebuild.
- [ ] Add table decorations to `qmd-preview.mjs` and files to the first-party manifest.
- [ ] **Step 4: Run focused tests and verify green.**

Run: `npm run build:documentation-webview && node --test products/workbench/tests/documentation-table-preview.test.mjs products/workbench/tests/documentation-qmd-source-model.test.mjs`

Expected: PASS for row-only reveal, malformed fallback, CRLF, pipes, and exact byte preservation.

- [ ] **Step 5: Refactor immutable table records.** Freeze row/cell arrays at construction:

```js
const freezeTable = table => Object.freeze({
  ...table,
  rows: Object.freeze(table.rows.map(row => Object.freeze({
    ...row,
    cells: Object.freeze(row.cells.map(Object.freeze)),
  }))),
});
```

- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-table-preview.test.mjs`

Expected: PASS and caller mutation cannot alter table coordinates.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/webview/table-decorations.mjs products/workbench/extensions/chatero-documentation/webview/qmd-preview.mjs products/workbench/extensions/chatero-documentation/webview/live-preview.css products/workbench/first-party-extensions.json products/workbench/tests/documentation-table-preview.test.mjs
git commit -m "feat(documentation): render row-editable Markdown tables"
```

## Task 4: Resolve and Render Safe Relative Raster Images

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/documentation-image-resolver.mjs`
- Create: `products/workbench/extensions/chatero-documentation/webview/image-decorations.mjs`
- Create: `products/workbench/tests/documentation-image-preview.test.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-workspace.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-authority-client.mjs`
- Modify: `products/workbench/documentation-authority/protocol.mjs`
- Modify: `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/live-preview-protocol.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/live-preview-bridge.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/live-preview-provider.cjs`
- Modify: `products/workbench/extensions/chatero-documentation/live-preview-html.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/qmd-preview.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/live-preview.css`
- Modify: `products/workbench/tests/documentation-live-preview-protocol.test.mjs`
- Modify: `products/workbench/tests/documentation-live-preview-provider.test.mjs`
- Modify: `products/workbench/tests/documentation-remote-transaction.test.mjs`
- Modify: `products/workbench/first-party-extensions.json`

**Interfaces:**

- Consumes: opaque Phase 1 workspace scope; internal authority `snapshot` transport; `workspace.fs`; `ExtensionContext.storageUri`; webview `asWebviewUri`; image Markdown nodes.
- Produces: `createPassiveImageSnapshotRequest(scope,{pageUri,target,maxBytes:20971520})`; internal `snapshotPassiveImage(request):Promise<PassiveImageSnapshot>`; `class DocumentationImageResolver` with `resolve(pageUri,target):Promise<ImageResolution>` and `dispose():Promise<void>`; `createDocumentationImageResolver(dependencies)`; `collectImageNodes`; `imageRevealRange`; and `createImageDecorations({requestImage}):Extension`.

- [ ] **Step 1: Write failing authority/security/render tests.** Generate signature-correct PNG/JPEG/GIF/WebP/AVIF fixtures and cases for missing files, absolute paths, `..` escape, percent traversal, foreign authority, `http:`, `https:`, `file:`, `data:`, command URI, SVG, symlink/junction escape, case alias, MIME/extension mismatch, signature mismatch, exactly 20 MiB, and 20 MiB + 1 byte. Start with:

```js
const webview = {
  asWebviewUri(uri) {
    assert.equal(uri.path, "/derived/live-preview-images/session-a/png-digest.png");
    return { toString: () => "chatero-test-webview://session-a/png-digest.png" };
  },
};
const resolver = createDocumentationImageResolver({ ...dependencies, webview });
const ready = await resolver.resolve(pageUri, "../assets/plot.png");
assert.deepEqual(
  { kind: ready.kind, mime: ready.mime, size: ready.size },
  { kind: "ready", mime: "image/png", size: pngBytes.length },
);
assert.equal(ready.src, "chatero-test-webview://session-a/png-digest.png");
assert.doesNotMatch(ready.src, /data:|file:|plot\.png/);

const escaped = await resolver.resolve(pageUri, "../../outside.png");
assert.deepEqual(escaped, { kind: "placeholder", target: "../../outside.png", reason: "unsafe" });
```

- [ ] Assert the fixed helper performs no-follow containment and signature detection in one bounded `passive-image` snapshot request for both local and SSH adapters; the public transaction facade gains no generic `read`, `write`, `exists`, absolute root, or raw adapter method.
- [ ] Assert the extension verifies returned SHA-256, writes only digest-named derived bytes below `storageUri/live-preview-images/<session>/`, converts that cache URI with `asWebviewUri`, never sends bytes/source URI to the webview, and deletes only that exact derived session cache on disposal.
- [ ] Assert inactive image has accessible alt text; entering it reveals original target and attributes; unsafe/unavailable images show a passive source-linked placeholder. Raw HTML image tags never become active.
- [ ] Open the actual custom-editor webview with one valid derived raster and observe the image request and successful decode. Assert `img-src` remains only `webview.cspSource`, while `localResourceRoots` is exactly the materialized media root plus this panel's digest-named derived-image session root; a sibling session, workspace/canonical file, network, `data:`, `blob:`, and `file:` image must fail to load. Reassert the WOFF2 and CodeMirror nonce-style loads so adding the image root cannot widen `font-src` or `style-src`.
- [ ] **Step 2: Run focused tests and verify red.**

Run: `node --test products/workbench/tests/documentation-image-preview.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs`

Expected: FAIL because `documentation-image-resolver.mjs` and the typed `passive-image` snapshot schema are absent.

- [ ] **Step 3: Implement the typed authority snapshot and disposable cache.** The only new helper request has this closed shape:

```js
export function createPassiveImageSnapshotRequest(scope, { pageUri, target, maxBytes = 20 * 1024 * 1024 }) {
  return Object.freeze({
    protocolVersion: 1,
    kind: "snapshot",
    snapshotKind: "passive-image",
    scope,
    pageUri: pageUri.toString(),
    target,
    maxBytes,
    allowedMime: Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]),
  });
}
```

- [ ] In the fixed helper, normalize relative to the page parent, require final containment under the scope's `documentation/` root after no-follow ancestor checks, open the final regular file without following a replacement link, enforce size, detect MIME from bytes, require extension/MIME agreement, hash exact bytes, and return bounded base64 only for this typed result. Cap encoded response size and reject unknown fields.
- [ ] Implement `DocumentationImageResolver` so production receives only a scope-bound `snapshotPassiveImage` closure, not a raw adapter. Verify digest/size/MIME again, write a digest-named cache file with `workspace.fs`, and return only `webview.asWebviewUri(cacheUri).toString()`.
- [ ] Extend host/webview protocols with exact `imageRequest {requestId,pageUri,target}` and `imageResult {requestId,resolution}` messages. The bridge binds `pageUri` to its own document instead of trusting the webview field.
- [ ] Add only that panel's digest-named derived-image session root to its existing materialized-media `localResourceRoots`; do not add the workspace, Documentation, cache parent, or another panel's root. Keep `createLivePreviewHtml` at `img-src ${webview.cspSource}`/`font-src ${webview.cspSource}` with no network, `data:`, `blob:`, `file:`, or `'unsafe-inline'`; filesystem reach is the intersection with those exact roots. Compose image decorations into `qmd-preview.mjs`; use DOM `img.src`, `alt`, `width`/`height` only from validated values, never source HTML.
- [ ] Add all files to the first-party manifest and extend local/remote protocol conformance tests.
- [ ] **Step 4: Run focused tests and verify green.**

Run: `npm run build:documentation-webview && node --test products/workbench/tests/documentation-image-preview.test.mjs products/workbench/tests/documentation-live-preview-protocol.test.mjs products/workbench/tests/documentation-live-preview-provider.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs`

Expected: PASS for all formats, hostile paths, MIME cases, actual CSP-authorized raster/font/style loads, rejection of every unmaterialized source, cache cleanup, and identical local/SSH typed results.

- [ ] **Step 5: Refactor placeholder construction into one non-throwing boundary.** Use this exact result helper for every expected image failure:

```js
function placeholder(target, reason) {
  return Object.freeze({ kind: "placeholder", target, reason });
}
```

- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-image-preview.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs`

Expected: PASS; expected failures never reject the render loop or expose an absolute path.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/documentation-image-resolver.mjs products/workbench/extensions/chatero-documentation/documentation-workspace.mjs products/workbench/extensions/chatero-documentation/documentation-authority-client.mjs products/workbench/extensions/chatero-documentation/live-preview-protocol.mjs products/workbench/extensions/chatero-documentation/live-preview-bridge.mjs products/workbench/extensions/chatero-documentation/live-preview-provider.cjs products/workbench/extensions/chatero-documentation/live-preview-html.mjs products/workbench/extensions/chatero-documentation/webview/image-decorations.mjs products/workbench/extensions/chatero-documentation/webview/qmd-preview.mjs products/workbench/extensions/chatero-documentation/webview/live-preview.css products/workbench/documentation-authority/protocol.mjs products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs products/workbench/first-party-extensions.json products/workbench/tests/documentation-image-preview.test.mjs products/workbench/tests/documentation-live-preview-protocol.test.mjs products/workbench/tests/documentation-live-preview-provider.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs
git commit -m "feat(documentation): render safe relative raster images"
```

## Task 5: Parse and Render Exact Theorem, Lemma, and Proof Blocks

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/webview/formal-block-parser.mjs`
- Create: `products/workbench/extensions/chatero-documentation/webview/formal-block-decorations.mjs`
- Create: `products/workbench/tests/documentation-formal-block-preview.test.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/qmd-source-model.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/qmd-preview.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/live-preview.css`
- Modify: `products/workbench/first-party-extensions.json`

**Interfaces:**

- Consumes: Lezer fenced-Div nodes, exact source, formula decorations from Task 2, and selection-aware reveal.
- Produces: `parseFormalBlock(source:string,from:number,to:number):FormalBlock|UnsupportedRange`; `collectFormalBlocks(state,visibleRanges):readonly (FormalBlock|UnsupportedRange)[]`; `formalSourceRevealRange(block,selection):SourceRange|null`; and `createFormalBlockDecorations():Extension`.

- [ ] **Step 1: Write failing exact-range/form tests.** Derive generated fixtures from the public behavior in `scripts/chatero/tests/qmd-visual-editor.test.mjs` and `scripts/chatero/starter/generated-files.mjs`; cover `#thm-*`, `#lem-*`, `#prf-*`, `#proof-*`, `.proof`, class order, quoted/unquoted attributes, title headings, labels, formulas, CRLF, nested valid Divs, mismatched fences, missing closer, ambiguous nesting, duplicate IDs, malicious attributes, and fences inside code blocks. Begin with:

```js
const source = '::: {#thm-pythagoras .callout-important icon="false"}\r\n\r\n## Pythagoras\r\n\r\n$a^2+b^2=c^2$\r\n\r\n:::\r\n';
const block = parseFormalBlock(source, 0, source.length);
assert.equal(block.kind, "theorem");
assert.equal(source.slice(block.attributes.range.from, block.attributes.range.to), '{#thm-pythagoras .callout-important icon="false"}');
assert.equal(source.slice(block.label.from, block.label.to), "Pythagoras");
assert.equal(source.slice(block.body.from, block.body.to), "$a^2+b^2=c^2$\r\n\r\n");
assert.equal(source.slice(block.range.from, block.range.to), source);
```

- [ ] Assert parsing/viewing/focusing/splitting does not change bytes or convert one proof form to another. A malformed or ambiguous block returns `{kind:"unsupported",from,to,reason}` for the smallest safe fenced range.
- [ ] Assert inactive cards expose theorem/lemma/proof semantics, exact label/title, body prose, and nested formula rendering; entering opener/attributes/label/body/closer reveals only the corresponding editable source span.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-formal-block-preview.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `formal-block-parser.mjs`.

- [ ] **Step 3: Implement source-coordinate parsing over Lezer fenced ranges.** Preserve every raw slice and classify without normalization:

```js
function classifyFormal(attributes) {
  if (attributes.id?.startsWith("thm-")) return "theorem";
  if (attributes.id?.startsWith("lem-")) return "lemma";
  if (attributes.id?.startsWith("prf-") || attributes.id?.startsWith("proof-") || attributes.classes.includes("proof")) return "proof";
  return null;
}

export function parseFormalBlock(source, from, to) {
  const fenced = parseExactFencedDiv(source, from, to);
  if (fenced.kind === "unsupported") return fenced;
  const kind = classifyFormal(fenced.attributes);
  return kind ? freezeFormalBlock({ ...fenced, kind }) : unsupported(fenced.range, "not-formal");
}
```

- [ ] Parse only the attribute grammar needed to preserve ID/classes/key/value boundaries; retain `raw` and exact ranges. Never stringify the attribute map back to source. Detect nesting from Lezer child ranges rather than a global fence regex.
- [ ] Render cards with DOM methods and validated fixed classes. QMD attributes never become HTML attributes, classes, styles, event handlers, or URLs. Compose formula decorations inside body ranges.
- [ ] Add source/test files to the first-party manifest and compose formal decorations after prose/formula so ranges do not double-replace.
- [ ] **Step 4: Run focused tests and verify green.**

Run: `npm run build:documentation-webview && node --test products/workbench/tests/documentation-formal-block-preview.test.mjs products/workbench/tests/documentation-formula-preview.test.mjs products/workbench/tests/documentation-qmd-source-model.test.mjs`

Expected: PASS with exact IDs/attributes/labels/body bytes and local fallback for every malformed/ambiguous case.

- [ ] **Step 5: Refactor immutable range creation.** Use one range constructor and reject invalid nesting early:

```js
function sourceRange(from, to) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
    throw new TypeError("invalid formal source range");
  }
  return Object.freeze({ from, to });
}
```

- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-formal-block-preview.test.mjs`

Expected: PASS and all returned blocks/ranges/attribute collections are immutable.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/webview/formal-block-parser.mjs products/workbench/extensions/chatero-documentation/webview/formal-block-decorations.mjs products/workbench/extensions/chatero-documentation/webview/qmd-source-model.mjs products/workbench/extensions/chatero-documentation/webview/qmd-preview.mjs products/workbench/extensions/chatero-documentation/webview/live-preview.css products/workbench/first-party-extensions.json products/workbench/tests/documentation-formal-block-preview.test.mjs
git commit -m "feat(documentation): render exact theorem lemma and proof blocks"
```

## Task 6: Add Per-View, Source-Neutral Proof Collapse

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/webview/proof-collapse.mjs`
- Create: `products/workbench/tests/documentation-proof-collapse.test.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/formal-block-decorations.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/qmd-preview.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/webview/live-preview.css`
- Modify: `products/workbench/first-party-extensions.json`

**Interfaces:**

- Consumes: proof `FormalBlock` records and CodeMirror `StateField`, `StateEffect`, selection, view dispatch, and decorations.
- Produces: `setProofCollapsed:StateEffectType<{proofKey:string;collapsed:boolean}>`; `createProofCollapseExtension():Extension`; `proofKey(block):string`; `isProofCollapsed(state,block):boolean`; and `toggleProof(view,block):void`.

- [ ] **Step 1: Write failing state-isolation and source-neutrality tests.** Create two EditorStates from identical source and prove independent toggles:

```js
const source = '::: {#proof-demo .proof collapse="true"}\n\nProof body.\n\n:::\n';
let left = makeProofState(source);
let right = makeProofState(source);
const block = collectFormalBlocks(left, [{ from: 0, to: source.length }])[0];
assert.equal(isProofCollapsed(left, block), true);
assert.equal(isProofCollapsed(right, block), true);
left = left.update({ effects: setProofCollapsed.of({ proofKey: proofKey(block), collapsed: false }) }).state;
assert.equal(isProofCollapsed(left, block), false);
assert.equal(isProofCollapsed(right, block), true);
assert.equal(left.doc.toString(), source);
```

- [ ] Cover missing/`false`/`true`/malformed collapse attributes, reopening a new view, source editing of the attribute, selection inside collapsed body, selection leaving, split views, block range shifts, deletion, Enter/Space disclosure activation, and toggling while another proof exists.
- [ ] Assert toggle transactions have `docChanged === false`; selection inside temporarily reveals without changing the stored interactive choice; a newly created view derives only from current QMD attributes.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-proof-collapse.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `proof-collapse.mjs`.

- [ ] **Step 3: Implement a view-local StateField keyed by stable source identity.** Initialize from exact attributes and apply only presentation effects:

```js
export const setProofCollapsed = StateEffect.define();

const proofCollapseField = StateField.define({
  create(state) {
    return initialProofState(state);
  },
  update(value, transaction) {
    let next = mapProofKeys(value, transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setProofCollapsed)) next = next.set(effect.value.proofKey, effect.value.collapsed);
    }
    return next;
  },
});

export function toggleProof(view, block) {
  view.dispatch({ effects: setProofCollapsed.of({
    proofKey: proofKey(block),
    collapsed: !isProofCollapsed(view.state, block),
  }) });
}
```

- [ ] Use a key derived from formal kind, exact ID when present, and mapped opener position so ordinary edits shift state safely. Drop state for a deleted/unrecognized proof; never write repository metadata.
- [ ] Render a semantic button with `aria-expanded`, `aria-controls`, visible focus, and keyboard activation. If selection intersects body/attributes, show source/body temporarily regardless of collapse state.
- [ ] Add the extension to `qmd-preview.mjs` and files to the manifest.
- [ ] **Step 4: Run focused tests and verify green.**

Run: `npm run build:documentation-webview && node --test products/workbench/tests/documentation-proof-collapse.test.mjs products/workbench/tests/documentation-formal-block-preview.test.mjs`

Expected: PASS for initial attributes, per-view isolation, temporary selection reveal, accessibility behavior, and zero source mutation.

- [ ] **Step 5: Refactor immutable proof-state updates.** Keep an unchanged map identity when an effect does not affect a proof:

```js
function updateCollapsed(map, key, collapsed) {
  if (map.get(key) === collapsed) return map;
  const next = new Map(map);
  next.set(key, collapsed);
  return next;
}
```

- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-proof-collapse.test.mjs`

Expected: PASS and no unnecessary decoration rebuild occurs for an unchanged collapse value.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/webview/proof-collapse.mjs products/workbench/extensions/chatero-documentation/webview/formal-block-decorations.mjs products/workbench/extensions/chatero-documentation/webview/qmd-preview.mjs products/workbench/extensions/chatero-documentation/webview/live-preview.css products/workbench/first-party-extensions.json products/workbench/tests/documentation-proof-collapse.test.mjs
git commit -m "feat(documentation): add per-view proof collapse"
```

## Task 7: Build the Reusable, Sandboxed SafeQuartoRenderer

**Files:**

- Create: `products/workbench/extensions/chatero-documentation/quarto-target.mjs`
- Create: `products/workbench/extensions/chatero-documentation/quarto-input-policy.mjs`
- Create: `products/workbench/extensions/chatero-documentation/safe-quarto-sandbox.mjs`
- Create: `products/workbench/extensions/chatero-documentation/safe-quarto-renderer.mjs`
- Create: `products/workbench/extensions/chatero-documentation/quarto-static-server.mjs`
- Create: `products/workbench/extensions/chatero-documentation/quarto-preview-manager.mjs`
- Create: `products/workbench/extensions/chatero-documentation/quarto-preview-html.mjs`
- Create: `products/workbench/tests/documentation-quarto-preview.test.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/documentation-authority-client.mjs`
- Modify: `products/workbench/extensions/chatero-documentation/package.json`
- Modify: `products/workbench/extensions/chatero-documentation/extension.cjs`
- Modify: `products/workbench/documentation-authority/protocol.mjs`
- Modify: `products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs`
- Modify: `products/workbench/tests/documentation-extension.test.mjs`
- Modify: `products/workbench/tests/documentation-remote-transaction.test.mjs`
- Modify: `products/workbench/tests/remote-agent-release.test.mjs`
- Modify: `products/workbench/first-party-extensions.json`

**Interfaces:**

- Consumes: workspace-trust state, one stabilized saved QMD `TextDocument`, typed authority snapshot creation, the signed Quarto/Pandoc runtime manifest, a product-private OS sandbox launcher, `vscode.env.asExternalUri`, `DiagnosticCollection`, and webview panel APIs.
- Produces: `validatePassiveQuartoInput(input):PassiveQuartoInput|UnsafeQuartoInput`; `createSafeQuartoSnapshotRequest(scope,input)`; `buildSafeQuartoInvocation({snapshot,runtime,output}):SafeQuartoInvocation`; `class SafeQuartoRenderer` with `render(request):Promise<SafeQuartoRenderResult>` and `dispose():Promise<void>`; `createQuartoStaticServer({rootUri,outputManifest}):StaticPreviewServer`; `createQuartoPreviewHtml({webview,externalUri,nonce}):string`; `class QuartoPreviewManager` as a panel/last-good wrapper around the exact renderer; and command `chatero.documentation.openQuartoPreview`.

- [ ] **Step 1: Write failing input/snapshot/sandbox/static-server/lifecycle tests.** Cover LF/CRLF source, dirty document, untrusted workspace, missing or signature-mismatched Quarto/Pandoc, filenames beginning with `-`, spaces/Unicode, local/remote URIs, stderr diagnostics, nonzero exit, crash after success, repeated open, panel close, document close, and extension disposal. Begin with a fixed render invocation, never `quarto preview`:

```js
const snapshot = await authority.createSafeQuartoSnapshot(savedDocument);
const invocation = buildSafeQuartoInvocation({ snapshot, runtime, output });
assert.deepEqual(invocation, {
  file: runtime.quartoExecutable,
  args: ["render", "./source/index.qmd", "--no-execute", "--output-dir", "./output"],
  cwd: snapshot.disposableRoot,
  shell: false,
});
assert.equal(invocation.args.filter(value => value === "--no-execute").length, 1);
assert.equal(invocation.args.includes("preview"), false);
```

- [ ] Parse frontmatter and body before any snapshot or process creation. Permit only a closed passive metadata allowlist such as scalar `title`, `subtitle`, `author`, `date`, `abstract`, and `categories`; the product owns format/project/output configuration. Reject malformed YAML and any project, `pre-render`, `post-render`, `filters`, extensions, custom/bare `format`, template, include, shortcode, raw HTML/raw block, `execute` or engine hook, Lua/JavaScript, command, or unknown execution-capable key. Rejection is explicit `unsafe-input`, not silent stripping followed by an “exact” claim, and records zero spawn calls.
- [ ] Include only the saved and digest-verified QMD, its signature-matched contained PNG/JPEG/GIF/WebP/AVIF dependencies, and a fixed product-generated project configuration in an authority-created content-addressed disposable snapshot. Reject unsaved/changed revisions, symlink/junction aliases, non-raster dependencies, missing dependencies, traversal, and network references. The request/response exposes only bounded content-free manifests and an opaque snapshot handle; it does not return canonical roots or source bytes to a renderer/webview.
- [ ] Test the real deny-by-default child-process boundary, not only argv: the render can read only the signed Quarto/Pandoc runtime and disposable snapshot, write only its derived output/temp roots, and execute only digest-pinned programs in that runtime. It cannot read or write canonical Documentation, any other workspace path, home, credentials, SSH agent, or absolute `CODEX_HOME`; cannot open network sockets or DNS; and cannot start a shell, arbitrary interpreter, filter, extension, or other subprocess. Simulate each forbidden access from a hostile fake Quarto child and require an OS denial with zero canonical change. If the equivalent platform sandbox is absent or cannot prove these controls, result is `preview-unavailable` before spawn with no unsandboxed fallback.
- [ ] Assert trust and input/runtime/sandbox validation occur before spawn. Dirty input offers explicit Save and Preview or Cancel, waits for `document.save()` plus a stable version/digest, and never writes a temporary canonical file. `--no-execute` is asserted as defense in depth only; tests must still fail if the OS sandbox or passive-input validation is removed.
- [ ] After render, validate the output manifest and serve only that immutable derived directory with a Chatero-owned tokenized static loopback server. Quarto itself must never bind/listen. Pass the Chatero server URI through `env.asExternalUri`; the webview receives only that forwarded URI. Exact-preview HTML is labelled read-only, has restrictive CSP, and uses one sandboxed iframe with no top-navigation, downloads, opener, source-edit messages, or authority tokens.
- [ ] Assert first failure shows a passive Problem/placeholder; a failed refresh after success retains the last-good immutable output/server URI and reports one scoped Problem. Quarto, sandbox, validator, or static-server failure never disposes Live Preview or invokes Zotero Core.
- [ ] **Step 2: Run the focused test and verify red.**

Run: `node --test products/workbench/tests/documentation-quarto-preview.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `safe-quarto-renderer.mjs`.

- [ ] **Step 3: Implement passive snapshot validation and the fixed sandboxed render.** Keep target arguments non-interpreted and bind them to the verified runtime/snapshot:

```js
export function buildSafeQuartoInvocation({ snapshot, runtime, output }) {
  return Object.freeze({
    file: runtime.quartoExecutable,
    args: Object.freeze([
      "render",
      `./source/${snapshot.entryBasename}`,
      "--no-execute",
      "--output-dir", output.relativePath,
    ]),
    cwd: snapshot.disposableRoot,
    shell: false,
  });
}
```

- [ ] `validatePassiveQuartoInput` uses a real YAML/QMD parser and one explicit key/construct allowlist. It returns source-linked diagnostics and refuses unknown active semantics; it never rewrites or silently removes them. The typed authority helper independently revalidates the saved revision and policy, resolves safe raster reachability with no-follow containment, writes the digest-named snapshot plus fixed project configuration to private disposable storage, fsyncs it, and returns an opaque handle with a signed content manifest.
- [ ] Resolve Quarto and Pandoc only from a release-manifest-pinned, complete-tree-verified runtime; reject `PATH`, workspace executables, user configuration, extensions, filters, or caller args. Use `shell:false`, closed stdio except bounded sanitized stdout/stderr, and a strict environment allowlist containing only fixed locale/runtime variables and sandbox-private `HOME`/temp. Explicitly omit inherited `PATH` outside the signed runtime, proxy/network variables, credential/config variables, SSH/GPG agents, `CODEX_HOME`, and user Quarto/Pandoc state.
- [ ] `SafeQuartoSandbox` installs the platform's product-verified object/filesystem, network, and exec policy before process start. It grants read only to the signed runtime and snapshot, write only to output/temp, and exec only to the signed Quarto/Pandoc runtime set. The renderer refuses before spawn when that exact policy is unavailable; a supported release/Remote Agent tuple may advertise Quarto only after an installed attack probe proves equivalent enforcement. Never retry outside the sandbox.
- [ ] `SafeQuartoRenderer.render()` invokes one fixed `render ... --no-execute` command, verifies that every resulting path is regular, contained, digest-manifested, and within size/count limits, and promotes only a complete immutable output. It then asks `quarto-static-server.mjs` to serve that one root on `127.0.0.1` with traversal rejection, fixed MIME mappings, no directory listing/write method, unguessable route token, and passive response headers. Quarto receives no host/port arguments and never listens.
- [ ] `QuartoPreviewManager` owns only Save/Cancel, panel, diagnostics, and last-good leases around the injected exact `SafeQuartoRenderer`; it contains no direct `spawn`. Convert the Chatero static-server URI through `env.asExternalUri`, record last-good only after render/output/server validation, and keep the previous immutable server lease until its replacement is ready. Register only in the workspace extension and require `workspace.isTrusted === true` before authority snapshot creation.
- [ ] Add all files/command contribution to the first-party manifest and extension tests.
- [ ] **Step 4: Run focused tests and verify green.**

Run: `node --test products/workbench/tests/documentation-quarto-preview.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs products/workbench/tests/remote-agent-release.test.mjs products/workbench/tests/first-party-extensions.test.mjs`

Expected: PASS with passive-metadata fail-closed behavior, authority-created disposable snapshots, fixed no-execute render args, real sandbox denial, zero Quarto listeners, remote Chatero URI forwarding, last-good retention, and lifecycle cleanup.

- [ ] **Step 5: Refactor renderer state into one closed transition function.** Permit only these transitions:

```js
const SAFE_QUARTO_TRANSITIONS = Object.freeze({
  idle: Object.freeze(["validating", "disposed"]),
  validating: Object.freeze(["snapshotting", "unavailable", "failed", "disposed"]),
  snapshotting: Object.freeze(["rendering", "failed", "disposed"]),
  rendering: Object.freeze(["serving", "failed", "disposed"]),
  serving: Object.freeze(["validating", "failed", "disposed"]),
  unavailable: Object.freeze(["validating", "disposed"]),
  failed: Object.freeze(["validating", "disposed"]),
  disposed: Object.freeze([]),
});
```

- [ ] **Step 6: Re-run after refactor.**

Run: `node --test products/workbench/tests/documentation-quarto-preview.test.mjs`

Expected: PASS and duplicate exit/server events cannot create an illegal transition, weaken the sandbox, replace last-good early, or duplicate a diagnostic.

- [ ] **Step 7: Commit.**

```bash
git add products/workbench/extensions/chatero-documentation/quarto-target.mjs products/workbench/extensions/chatero-documentation/quarto-input-policy.mjs products/workbench/extensions/chatero-documentation/safe-quarto-sandbox.mjs products/workbench/extensions/chatero-documentation/safe-quarto-renderer.mjs products/workbench/extensions/chatero-documentation/quarto-static-server.mjs products/workbench/extensions/chatero-documentation/quarto-preview-manager.mjs products/workbench/extensions/chatero-documentation/quarto-preview-html.mjs products/workbench/extensions/chatero-documentation/documentation-authority-client.mjs products/workbench/extensions/chatero-documentation/package.json products/workbench/extensions/chatero-documentation/extension.cjs products/workbench/documentation-authority/protocol.mjs products/workbench/documentation-authority/runtime/chatero-documentation-authority.mjs products/workbench/first-party-extensions.json products/workbench/tests/documentation-quarto-preview.test.mjs products/workbench/tests/documentation-extension.test.mjs products/workbench/tests/documentation-remote-transaction.test.mjs products/workbench/tests/remote-agent-release.test.mjs products/workbench/tests/first-party-extensions.test.mjs
git commit -m "security(documentation): sandbox read-only Quarto rendering"
```

## Task 8: Gate Source Preservation, Security, Accessibility, and Performance

**Files:**

- Create: `products/workbench/tests/documentation-live-preview-security.test.mjs`
- Create: `products/workbench/tests/documentation-live-preview-accessibility.test.mjs`
- Create: `products/workbench/tests/documentation-live-preview-performance.test.mjs`
- Create: `products/workbench/integration/documentation/live-preview.test.mjs`
- Create: `products/workbench/integration/documentation/quarto-preview.test.mjs`
- Modify: `products/workbench/integration/documentation/driver/run.cjs`
- Modify: `products/workbench/tests/remote-agent-release.test.mjs`
- Modify: this plan

**Interfaces:**

- Consumes: all Phase 3 render modules, `createQmdPreviewExtensions`, the Phase 2 local/SSH integration runner, generated fixture builders, and `performance.now()`.
- Produces: `createPerformanceFixture({minimumBytes:1048576,minimumBlocks:10000}):string`; `measureIncrementalPreview({source,iterations,warmup,viewport}):{p50:number,p95:number,max:number}`; complete local/SSH visual and Quarto acceptance evidence.

- [ ] **Step 1: Write failing aggregate security/accessibility/performance tests.** Build a hostile fixture containing raw HTML/script/iframe/object/embed, SVG/data/network/file/command images/links, malicious Div attributes, malformed formulas/tables, unknown QMD, Quarto project/pre/post-render hooks, filters/extensions, custom formats/templates/includes, shortcodes, raw blocks, and execute/engine metadata. Assert the Live Preview DOM/message stream has no active hostile node/URI while exact source remains editable, and `SafeQuartoRenderer` rejects every active construct before snapshot/spawn.
- [ ] In a real webview, observe successful loading and application of the CodeMirror nonce style, bundled stylesheet, KaTeX WOFF2, and one derived raster. Attempt another panel's raster, an unmaterialized media/font path, network, `data:`, `blob:`, `file:`, and a nonce-free style/script; require each to be blocked. Assert CSP and `localResourceRoots` remain the exact intersection described in Tasks 2 and 4.
- [ ] Build accessibility assertions for editor label/role, heading semantics, links, table headers/cells, image alt/placeholder text, formula MathML, formal labels, proof disclosure name/state/keyboard operation, local conflict announcements, render fallback messages, and read-only Quarto labelling.
- [ ] Generate at least 1 MiB and 10,000 mixed blocks; edit one visible prose/formula/table/formal node after 50 warm-up iterations and collect 200 synchronous transaction-plus-decoration samples:

```js
const source = createPerformanceFixture({ minimumBytes: 1_048_576, minimumBlocks: 10_000 });
const result = measureIncrementalPreview({
  source,
  warmup: 50,
  iterations: 200,
  viewport: { from: 0, to: 8_192 },
});
assert.ok(Buffer.byteLength(source, "utf8") >= 1_048_576);
assert.ok(countBlocks(source) >= 10_000);
assert.ok(result.p95 <= 16, `p95 ${result.p95.toFixed(2)} ms exceeds 16 ms`);
```

- [ ] Add extension-host scenarios for every structure: inactive visual form, minimum source reveal, exact source edit, restored visual form, unsupported fallback, scrolling/folding/navigation/split/reopen byte preservation, two-view proof state, image local/SSH resolution, and Zotero Core isolation. Quarto rows must prove saved-snapshot input, passive-metadata rejection, signed-runtime selection, fixed `render --no-execute`, sandbox denial of workspace/home/`CODEX_HOME`/network/arbitrary subprocess access, absence of a Quarto listener, Chatero static serving/remote forwarding, fail-closed platform unavailability, and last-good retention.
- [ ] **Step 2: Run aggregate tests and verify red.**

Run: `node --test products/workbench/tests/documentation-live-preview-security.test.mjs products/workbench/tests/documentation-live-preview-accessibility.test.mjs products/workbench/tests/documentation-live-preview-performance.test.mjs`

Expected: FAIL because aggregate fixture/measurement exports and full accessibility labels are absent.

- [ ] **Step 3: Implement only the measured/identified gaps.** Keep measurement around synchronous state/update/decorations only:

```js
export function measureIncrementalPreview({ source, warmup, iterations, viewport }) {
  let state = makePreviewState(source);
  const samples = [];
  for (let index = 0; index < warmup + iterations; index += 1) {
    const started = performance.now();
    state = state.update({ changes: { from: viewport.from + 1, insert: index % 2 ? "x" : "" } }).state;
    buildVisibleDecorations(state, [viewport]);
    const elapsed = performance.now() - started;
    if (index >= warmup) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  return Object.freeze({
    p50: samples[Math.ceil(samples.length * 0.50) - 1],
    p95: samples[Math.ceil(samples.length * 0.95) - 1],
    max: samples.at(-1),
  });
}
```

- [ ] If the first measurement exceeds 16 ms, restrict traversal/decorations to `EditorView.visibleRanges`, cache immutable node records by syntax-tree identity/range, and invalidate only mapped changed ranges. Do not weaken the fixture, percentile, sample count, or threshold.
- [ ] Add missing fixed ARIA labels/roles and local fallbacks using DOM properties/textContent only. Add the new Mocha files to the driver and require zero skipped tests.
- [ ] Extend Remote Agent release tests to require the final bundle, KaTeX CSS/WOFF2/licenses, image authority code, `SafeQuartoRenderer`, sandbox/static-server modules, and signature-pinned Quarto/Pandoc/runtime manifests in both signed tuples. Run the same installed sandbox attack probe on every advertised platform/architecture; failure disables exact preview for that tuple rather than selecting an unsandboxed fallback.
- [ ] **Step 4: Run focused and integration tests and verify green.**

Run: `node --test products/workbench/tests/documentation-live-preview-security.test.mjs products/workbench/tests/documentation-live-preview-accessibility.test.mjs products/workbench/tests/documentation-live-preview-performance.test.mjs`

Expected: PASS on Ubuntu 24.04/Node 24.18.0 with p95 at or below 16 ms and no active hostile content.

Run: `npm run test:documentation:integration -- --target local --grep "Live Preview|Quarto"`

Expected: PASS for every visual/source/Quarto scenario with zero skips.

Run: `npm run test:documentation:integration -- --target ssh-fixture --grep "Live Preview|Quarto"`

Expected: PASS for the identical scenario count over `chatero-remote+fixture`.

- [ ] **Step 5: Refactor the aggregate fixture into fixed reusable blocks.** Use deterministic, non-personal templates and no random content:

```js
const PERFORMANCE_BLOCKS = Object.freeze([
  "## Heading\n\nParagraph with *emphasis* and [link](topic.qmd).\n\n",
  "Inline $x^2$ and display:\n\n$$y = mx+b$$\n\n",
  "| A | B |\n|---|---:|\n| α | 1 |\n\n",
  '::: {#thm-generated .callout-important}\n\nGenerated theorem.\n\n:::\n\n',
  '::: {#prf-generated .proof collapse="true"}\n\nGenerated proof.\n\n:::\n\n',
]);
```

- [ ] **Step 6: Run all Phase 3 gates after refactor.**

Run: `npm run test:documentation`

Expected: PASS, including source, rendering, security, accessibility, and performance tests with no skips.

Run: `npm run test:documentation:integration -- --target local && npm run test:documentation:integration -- --target ssh-fixture`

Expected: PASS with equal scenario counts for both targets.

Run: `npm run test:chatero`

Expected: PASS for the Gecko parity-oracle suite; no Gecko production behavior was changed.

Run: `npm run test:workbench-bootstrap`

Expected: PASS with deterministic bundle/font/extension provenance.

Run: `npm run workbench:bootstrap && npm run workbench:verify`

Expected: PASS against Code-OSS 1.132.0 commit `df53daabb18cd157bdb08c7f01c34df936cf12f4` with no untracked generated bundle committed.

- [ ] Run `git diff --check`; inspect the scoped diff; verify fixtures contain no personal profile/workspace/research data, caches are ignored/disposable, every Quarto invocation is the fixed sandboxed `render ... --no-execute` form, no Quarto invocation uses `preview`/host/port or a canonical cwd, and no bundle/source contains a forbidden endpoint.
- [ ] **Step 7: Commit.**

```bash
git add products/workbench/tests/documentation-live-preview-security.test.mjs products/workbench/tests/documentation-live-preview-accessibility.test.mjs products/workbench/tests/documentation-live-preview-performance.test.mjs products/workbench/tests/remote-agent-release.test.mjs products/workbench/integration/documentation/driver/run.cjs products/workbench/integration/documentation/live-preview.test.mjs products/workbench/integration/documentation/quarto-preview.test.mjs docs/superpowers/plans/2026-08-12-documentation-phase-3-live-preview.md
git commit -m "test(documentation): gate Live Preview safety and performance"
```

## Phase 3 Review Checkpoint

- [ ] Prose/headings/emphasis/lists/links/code spans, formulas, tables, images, theorem/lemma/proof blocks render in the same source document and reveal their exact minimum editable source ranges.
- [ ] Decoration-only activity, scrolling, folding, navigation, split, reopen, render failure, and proof toggles preserve every source byte, including CRLF and final newline.
- [ ] Unsupported, malformed, nested-ambiguous, or failed nodes fall back only their smallest safe range to editable source; no failure disables the document, standard Text Editor, or Zotero Core.
- [ ] Formula rendering uses KaTeX 0.16.22 with `trust:false`; table cell entry reveals a full source row only; image entry reveals exact target/attributes. A fresh panel nonce reaches `EditorView.cspNonce`, and the actual webview loads only materialized CodeMirror styles, WOFF2, and per-session derived rasters through the minimum CSP/root intersection; network, `data:`, `blob:`, `file:`, `'unsafe-inline'`, sibling roots, and unmaterialized resources are blocked.
- [ ] Image preview uses one typed no-follow authority snapshot, accepts only signature-matched contained raster formats up to 20 MiB, sends only a derived `asWebviewUri` to the webview, and cleans its exact cache.
- [ ] Formal parsing preserves exact fences, IDs, class/value attributes, labels, and body; `#thm-*`, `#lem-*`, `#prf-*`, `#proof-*`, and `.proof` forms remain unconverted.
- [ ] Proof collapse initializes from QMD, is independent per view, temporarily reveals selection, is keyboard/screen-reader operable, and never changes source when toggled.
- [ ] The exact Quarto surface is separate/read-only and trust-gated, but never treats trust or `--no-execute` as a sandbox. `SafeQuartoRenderer` accepts only passive authority-created saved snapshots, uses the signed fixed runtime under the product-private deny-by-default OS sandbox, invokes only `render ... --no-execute`, gives Quarto no listener/canonical cwd/network/arbitrary subprocess access, and serves validated last-good output only through Chatero's static loopback server plus `asExternalUri`; unavailable equivalent sandboxing fails closed without blocking editing.
- [ ] Hostile HTML/resources/URIs/attributes never become active; passive Live Preview remains available untrusted; accessibility tests pass.
- [ ] The 1 MiB/10,000-block fixture records p95 synchronous input plus decoration update at or below 16 ms on Ubuntu 24.04/Node 24.18.0.
- [ ] `npm run test:documentation`, local/SSH integration, `npm run test:chatero`, `npm run test:workbench-bootstrap`, and `npm run workbench:verify` all pass on locked runtimes.
- [ ] Rollback boundary is documented: revert Phase 3 visual/image/Quarto modules and bundle mappings to the Phase 2 plain-source bundle. `WorkingCopyCoordinator`, TextDocument edits, standard editor access, canonical QMD bytes, and Phase 1 authority/state remain intact.
