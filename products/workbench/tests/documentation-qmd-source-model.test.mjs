import assert from "node:assert/strict";
import { EditorSelection, EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { test } from "node:test";

import { createQmdLanguage } from "../extensions/chatero-documentation/webview/qmd-language.mjs";
import { collectVisualNodes } from "../extensions/chatero-documentation/webview/qmd-source-model.mjs";
import { createLineEndingMap } from "../extensions/chatero-documentation/webview/line-ending-map.mjs";
import { sourceRevealRange } from "../extensions/chatero-documentation/webview/source-reveal.mjs";

function stateFor(source) {
  const lineBreak = source.includes("\r\n") ? "\r\n" : "\n";
  return EditorState.create({
    doc: source,
    extensions: [EditorState.lineSeparator.of(lineBreak), createQmdLanguage()],
  });
}

test("maps CodeMirror LF offsets to exact TextDocument line endings", () => {
  const source = "# α\r\n\r\nText\r\n";
  const map = createLineEndingMap(source);
  assert.equal(map.editorText, "# α\n\nText\n");
  assert.equal(map.toSourceOffset(map.editorText.indexOf("Text")), source.indexOf("Text"));
  assert.equal(map.toEditorOffset(source.indexOf("Text")), map.editorText.indexOf("Text"));
  assert.equal(map.encodeEditorText("one\ntwo"), "one\r\ntwo");
  assert.throws(() => map.toEditorOffset(source.indexOf("\r\n") + 1), /line-ending/);
});

test("collects visible QMD prose without changing LF or CRLF source", () => {
  for (const eol of ["\n", "\r\n"]) {
    const source = [
      "---",
      "title: Demo",
      "---",
      "",
      "# Heading",
      "",
      "Text with *care*, [link](notes.qmd), and `x <- 1`.",
      "",
      "- one",
      "- two",
      "",
    ].join(eol);
    const state = stateFor(source);
    const editorSource = state.doc.toString();
    const visibleFrom = editorSource.indexOf("# Heading");
    const nodes = collectVisualNodes(state, [{ from: visibleFrom, to: state.doc.length }]);
    assert.deepEqual(nodes.map(node => node.kind), ["heading", "prose", "list"]);
    assert.equal(state.sliceDoc(), source);
    assert.ok(nodes.every(Object.isFrozen));
    assert.ok(nodes.every(node => Object.isFrozen(node.children)));
    assert.deepEqual(
      sourceRevealRange(nodes[0], EditorSelection.cursor(editorSource.indexOf("Heading"))),
      { from: editorSource.indexOf("# Heading"), to: editorSource.indexOf("\n", editorSource.indexOf("# Heading")) },
    );
    const paragraph = nodes[1];
    const code = paragraph.children.find(node => node.kind === "code-span");
    assert.ok(code);
    assert.equal(state.sliceDoc(code.from, code.to), "`x <- 1`");
    assert.deepEqual(sourceRevealRange(paragraph, EditorSelection.cursor(editorSource.indexOf("x <- 1"))), {
      from: code.from,
      to: code.to,
    });
  }
});

test("returns only top-level nodes intersecting visible ranges", () => {
  const source = Array.from({ length: 10_000 }, (_, index) => `Paragraph ${index}.`).join("\n\n");
  const state = stateFor(source);
  const marker = "Paragraph 9000.";
  const from = source.indexOf(marker);
  const nodes = collectVisualNodes(state, [{ from, to: from + marker.length }]);
  assert.deepEqual(nodes.map(node => node.source), [marker]);
  assert.ok(nodes.length < 10);

  const beforeTree = syntaxTree(state);
  const changed = state.update({ changes: { from, to: from + marker.length, insert: "Changed 9000." } }).state;
  const changedNodes = collectVisualNodes(changed, [{ from, to: from + 13 }]);
  assert.equal(changedNodes[0].source, "Changed 9000.");
  assert.notEqual(syntaxTree(changed), beforeTree);
});

test("keeps code, raw HTML, citations, and malformed syntax source-visible", () => {
  const source = [
    "`$not-math$` and [@citation] and *broken",
    "",
    "```{python}",
    "value = '$not-math$'",
    "```",
    "",
    "<script>alert('never active')</script>",
    "",
    "::: {.unknown}",
    "unsupported",
    ":::",
    "",
  ].join("\n");
  const state = stateFor(source);
  const nodes = collectVisualNodes(state, [{ from: 0, to: source.length }]);
  const serialized = nodes.map(node => [node.kind, node.source]);
  assert.ok(serialized.some(([kind, text]) => kind === "prose" && text.includes("[@citation]")));
  assert.ok(serialized.some(([kind, text]) => kind === "unsupported" && text.includes("<script>")));
  assert.equal(nodes.some(node => node.kind.startsWith("formula")), false);
  assert.equal(state.doc.toString(), source);
});

test("validates ranges and reveals only when a selection intersects", () => {
  const source = "# Heading\n\nText *emphasis*.\n";
  const state = stateFor(source);
  assert.throws(() => collectVisualNodes(state, [{ from: -1, to: 2 }]), /visible range/);
  assert.throws(() => collectVisualNodes(state, [{ from: 10, to: 3 }]), /visible range/);
  const nodes = collectVisualNodes(state, [{ from: 0, to: source.length }]);
  const heading = nodes[0];
  assert.equal(sourceRevealRange(heading, EditorSelection.cursor(source.indexOf("Text"))), null);
  assert.throws(() => sourceRevealRange({ ...heading, from: 4, to: 1 }, EditorSelection.cursor(0)), /source range/);
});
