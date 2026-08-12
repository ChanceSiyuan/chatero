import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EditorSelection, EditorState } from "@codemirror/state";
import { test } from "node:test";

import { createQmdLanguage } from "../extensions/chatero-documentation/webview/qmd-language.mjs";
import {
  collectFormalBlocks,
  parseFormalBlock,
} from "../extensions/chatero-documentation/webview/formal-block-parser.mjs";
import {
  formalSourceRevealRange,
  renderFormalHeaderElement,
} from "../extensions/chatero-documentation/webview/formal-block-decorations.mjs";

function stateFor(source) {
  return EditorState.create({ doc: source, extensions: [createQmdLanguage()] });
}

function fakeDocument() {
  return {
    createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(),
        attributes: {},
        children: [],
        className: "",
        dataset: {},
        textContent: "",
        append(...children) { this.children.push(...children); },
        setAttribute(name, value) { this.attributes[name] = String(value); },
      };
    },
  };
}

test("preserves exact theorem ranges, attributes, label, and body", () => {
  const source = '::: {#thm-pythagoras .callout-important icon="false" onclick="never"}\r\n\r\n## Pythagoras\r\n\r\n$a^2+b^2=c^2$\r\n\r\n:::\r\n';
  const block = parseFormalBlock(source, 0, source.length);
  assert.equal(block.kind, "theorem");
  assert.equal(source.slice(block.attributes.range.from, block.attributes.range.to), '{#thm-pythagoras .callout-important icon="false" onclick="never"}');
  assert.equal(block.attributes.id, "thm-pythagoras");
  assert.deepEqual(block.attributes.classes, ["callout-important"]);
  assert.equal(block.attributes.values.get("icon"), "false");
  assert.equal(source.slice(block.label.from, block.label.to), "Pythagoras");
  assert.equal(source.slice(block.body.from, block.body.to), "$a^2+b^2=c^2$\r\n\r\n");
  assert.equal(source.slice(block.range.from, block.range.to), source);
  assert.ok(Object.isFrozen(block));
  assert.ok(Object.isFrozen(block.attributes));
  assert.ok(Object.isFrozen(block.attributes.classes));
});

test("classifies lemma and both proof forms without normalizing them", () => {
  const fixtures = [
    ['::: {#lem-compact .aside}\nLemma body.\n:::\n', "lemma"],
    ['::: {#prf-direct collapse="true"}\nProof body.\n:::\n', "proof"],
    [':::: {.callout .proof #custom-proof}\nProof body.\n::::\n', "proof"],
  ];
  for (const [source, kind] of fixtures) {
    const block = parseFormalBlock(source, 0, source.length);
    assert.equal(block.kind, kind);
    assert.equal(source.slice(block.range.from, block.range.to), source);
  }
});

test("collects nested formal blocks but ignores colon fences inside code", () => {
  const source = [
    "::: {#thm-outer}",
    "```text",
    ":::",
    "```",
    "::: {#proof-inner .proof}",
    "Inner.",
    ":::",
    ":::",
    "",
  ].join("\n");
  const state = stateFor(source);
  const blocks = collectFormalBlocks(state, [{ from: 0, to: state.doc.length }]);
  assert.deepEqual(blocks.map(block => block.kind), ["theorem", "proof"]);
  assert.equal(state.doc.toString(), source);
});

test("fails closed for missing, mismatched, duplicate, and non-formal fences", () => {
  const cases = [
    "::: {#thm-open}\nbody\n",
    ":::: {#thm-mismatch}\nbody\n:::\n",
    "::: {#one #two}\nbody\n:::\n",
    "::: {.ordinary}\nbody\n:::\n",
    "::: {#thm-bad title=\"unterminated}\nbody\n:::\n",
  ];
  for (const source of cases) assert.equal(parseFormalBlock(source, 0, source.length).kind, "unsupported");
});

test("reveals the smallest formal source part and emits fixed safe header DOM", () => {
  const source = '::: {#lem-demo .proof onclick="bad"}\n\n## Label\n\nBody.\n\n:::\n';
  const block = parseFormalBlock(source, 0, source.length);
  assert.deepEqual(formalSourceRevealRange(block, EditorSelection.cursor(source.indexOf("lem-demo"))), block.attributes.range);
  assert.deepEqual(formalSourceRevealRange(block, EditorSelection.cursor(source.indexOf("Label"))), block.label);
  assert.deepEqual(formalSourceRevealRange(block, EditorSelection.cursor(source.indexOf("Body"))), block.body);
  assert.deepEqual(formalSourceRevealRange(block, EditorSelection.cursor(source.lastIndexOf(":::"))), block.closer);
  assert.equal(formalSourceRevealRange(block, EditorSelection.cursor(source.length)), null);

  const element = renderFormalHeaderElement(fakeDocument(), block, source);
  assert.equal(element.attributes.role, "group");
  assert.equal(element.attributes["aria-label"], "Lemma: Label");
  assert.equal(element.className, "chatero-qmd-formal chatero-qmd-formal-lemma");
  assert.equal(JSON.stringify(element).includes("onclick"), false);

  const proofSource = '::: {#proof-toggle .proof collapse="true"}\nBody.\n:::\n';
  const proof = parseFormalBlock(proofSource, 0, proofSource.length);
  const proofElement = renderFormalHeaderElement(fakeDocument(), proof, proofSource, { collapsed: true });
  const button = proofElement.children[1];
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.attributes.type, "button");
  assert.equal(button.attributes["aria-expanded"], "false");
  assert.equal(button.textContent, "Show proof");
});

test("formal modules never activate source HTML or serialize attributes", async () => {
  for (const name of ["formal-block-parser.mjs", "formal-block-decorations.mjs"]) {
    const source = await readFile(new URL(`../extensions/chatero-documentation/webview/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\binnerHTML\b|insertAdjacentHTML|DOMParser|outerHTML/u);
  }
});
