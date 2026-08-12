import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EditorSelection, EditorState } from "@codemirror/state";
import { test } from "node:test";

import { createQmdLanguage } from "../extensions/chatero-documentation/webview/qmd-language.mjs";
import {
  KATEX_OPTIONS,
  collectFormulaNodes,
  formulaRevealRange,
  renderFormulaInto,
} from "../extensions/chatero-documentation/webview/formula-decorations.mjs";

function stateFor(source) {
  return EditorState.create({
    doc: source,
    extensions: [
      EditorState.lineSeparator.of(source.includes("\r\n") ? "\r\n" : "\n"),
      createQmdLanguage(),
    ],
  });
}

function formulaSources(state) {
  return collectFormulaNodes(state, [{ from: 0, to: state.doc.length }])
    .map(node => state.sliceDoc(node.from, node.to));
}

function fakeContainer() {
  const document = {
    createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(),
        attributes: {},
        className: "",
        dataset: {},
        textContent: "",
        setAttribute(name, value) { this.attributes[name] = String(value); },
      };
    },
  };
  return {
    ownerDocument: document,
    children: [],
    replaceChildren(...children) { this.children = children; },
  };
}

test("collects exact inline and display delimiters without treating code or currency as math", () => {
  const source = [
    "Cost is `$5`, but math is $x^2 + 1$ and \\(z\\).",
    "",
    "$$",
    "y = mx+b",
    "$$",
    "",
    "\\[w\\]",
    "",
    "```qmd",
    "$not_math$",
    "```",
    "",
    String.raw`Escaped \$not_math$ and empty $$ are source.`,
  ].join("\r\n");
  const state = stateFor(source);
  assert.deepEqual(formulaSources(state), ["$x^2 + 1$", "\\(z\\)", "$$\r\ny = mx+b\r\n$$", "\\[w\\]"]);
  const formulas = collectFormulaNodes(state, [{ from: 0, to: state.doc.length }]);
  assert.deepEqual(formulaRevealRange(formulas[0]), { from: formulas[0].from, to: formulas[0].to });
  assert.equal(state.sliceDoc(), source);
});

test("renders through fixed untrusted KaTeX options and falls back locally", () => {
  const state = stateFor("Before $x^2$ after.");
  const [node] = collectFormulaNodes(state, [{ from: 0, to: state.doc.length }]);
  const calls = [];
  const container = fakeContainer();
  const rendered = renderFormulaInto({
    node,
    source: state.doc.toString(),
    container,
    katex: { render(expression, target, options) { calls.push({ expression, target, options }); } },
  });
  assert.deepEqual(rendered, { kind: "rendered" });
  assert.equal(calls[0].expression, "x^2");
  assert.deepEqual(calls[0].options, { ...KATEX_OPTIONS, displayMode: false });
  assert.equal(calls[0].target, container);
  assert.equal(KATEX_OPTIONS.trust, false);
  assert.equal(KATEX_OPTIONS.throwOnError, true);

  const fallback = renderFormulaInto({
    node,
    source: state.doc.toString(),
    container,
    katex: { render() { throw new Error("/private/user/path: bad formula\nstack"); } },
  });
  assert.deepEqual(fallback, { kind: "fallback", message: "Formula could not be rendered" });
  assert.equal(container.children[0].attributes.role, "note");
  assert.equal(container.children[0].dataset.sourceFrom, String(node.from));
  assert.doesNotMatch(container.children[0].textContent, /private|stack/u);
});

test("formula source is revealed only while its selection is active", () => {
  const state = stateFor("$a$ and $b$");
  const formulas = collectFormulaNodes(state, [{ from: 0, to: state.doc.length }]);
  assert.equal(formulaRevealRange(formulas[0], EditorSelection.cursor(8)), null);
  assert.deepEqual(formulaRevealRange(formulas[0], EditorSelection.cursor(1)), { from: 0, to: 3 });
});

test("Chatero formula modules never parse source as HTML", async () => {
  const source = await readFile(new URL("../extensions/chatero-documentation/webview/formula-decorations.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\binnerHTML\b|insertAdjacentHTML|DOMParser/u);
});
