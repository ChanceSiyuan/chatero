import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EditorState } from "@codemirror/state";
import { test } from "node:test";

import { createQmdLanguage } from "../extensions/chatero-documentation/webview/qmd-language.mjs";
import { createQmdPreviewExtensions } from "../extensions/chatero-documentation/webview/qmd-preview.mjs";
import { createProseElement } from "../extensions/chatero-documentation/webview/prose-decorations.mjs";

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
    createTextNode(value) { return { nodeType: 3, textContent: String(value) }; },
  };
}

test("creates accessible inactive prose elements using textContent", () => {
  const document = fakeDocument();
  const heading = createProseElement(document, { kind: "heading", source: "# Result", from: 0, to: 8, reveal: { from: 0, to: 8 }, children: [] });
  assert.equal(heading.tagName, "H1");
  assert.equal(heading.children[0].textContent, "Result");
  assert.equal(heading.dataset.sourceFrom, "0");

  const link = createProseElement(document, {
    kind: "link",
    source: "[Notes](notes.qmd)",
    from: 10,
    to: 28,
    reveal: { from: 10, to: 28 },
    children: [],
  });
  assert.equal(link.tagName, "SPAN");
  assert.equal(link.attributes.role, "link");
  assert.equal(link.children[0].textContent, "Notes");
  assert.equal(Object.hasOwn(link.attributes, "href"), false);

  const code = createProseElement(document, { kind: "code-span", source: "`a < b`", from: 0, to: 7, reveal: { from: 0, to: 7 }, children: [] });
  assert.equal(code.tagName, "CODE");
  assert.equal(code.children[0].textContent, "a < b");
});

test("renders inline Markdown semantics without exposing delimiters or destinations", () => {
  const document = fakeDocument();
  const prose = createProseElement(document, {
    kind: "prose",
    source: "Text *care*, [notes](private.qmd), and `x < 2`.",
    from: 0,
    to: 48,
    reveal: { from: 0, to: 48 },
    children: [
      { kind: "emphasis", source: "*care*", from: 5, to: 11, reveal: { from: 5, to: 11 }, children: [] },
      { kind: "link", source: "[notes](private.qmd)", from: 13, to: 33, reveal: { from: 13, to: 33 }, children: [] },
      { kind: "code-span", source: "`x < 2`", from: 39, to: 46, reveal: { from: 39, to: 46 }, children: [] },
    ],
  });
  assert.deepEqual(prose.children.map(child => child.tagName ?? "#text"), ["#text", "EM", "#text", "SPAN", "#text", "CODE", "#text"]);
  assert.equal(prose.children[1].children[0].textContent, "care");
  assert.equal(prose.children[3].children[0].textContent, "notes");
  assert.equal(JSON.stringify(prose).includes("private.qmd"), false);
});

test("composes an incremental language and prose extension without mutating source", () => {
  const source = "# Heading\n\nText with *care*.\n";
  const extensions = createQmdPreviewExtensions({ postMessage: async () => {} });
  assert.ok(Object.isFrozen(extensions));
  const state = EditorState.create({ doc: source, extensions: [createQmdLanguage(), ...extensions] });
  assert.equal(state.doc.toString(), source);
});

test("preview modules never inject QMD through HTML parsing APIs", async () => {
  const names = ["qmd-source-model.mjs", "source-reveal.mjs", "prose-decorations.mjs", "qmd-preview.mjs"];
  for (const name of names) {
    const source = await readFile(new URL(`../extensions/chatero-documentation/webview/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\binnerHTML\b|insertAdjacentHTML|DOMParser|setValue\s*\(/, name);
  }
});
