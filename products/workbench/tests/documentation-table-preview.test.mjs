import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EditorState } from "@codemirror/state";
import { test } from "node:test";

import { createQmdLanguage } from "../extensions/chatero-documentation/webview/qmd-language.mjs";
import {
  collectTableNodes,
  renderTableRowElement,
  tableCellSelection,
  tableRowRevealRange,
} from "../extensions/chatero-documentation/webview/table-decorations.mjs";

function stateFor(source) {
  return EditorState.create({
    doc: source,
    extensions: [
      EditorState.lineSeparator.of(source.includes("\r\n") ? "\r\n" : "\n"),
      createQmdLanguage(),
    ],
  });
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

test("collects immutable row and cell ranges while honoring escaped and code pipes", () => {
  const source = [
    "| Name | Value | Empty |",
    "| :--- | ---: | :---: |",
    String.raw`| α | \| literal | |`,
    "| β | `a|b` | 2 |",
    "",
  ].join("\r\n");
  const state = stateFor(source);
  const [table] = collectTableNodes(state, [{ from: 0, to: state.doc.length }]);
  assert.ok(table);
  assert.deepEqual(table.alignments, ["left", "right", "center"]);
  assert.deepEqual(table.rows.map(row => row.cells.map(cell => cell.displayText)), [
    ["Name", "Value", "Empty"],
    ["α", "| literal", ""],
    ["β", "`a|b`", "2"],
  ]);
  assert.ok(Object.isFrozen(table));
  assert.ok(table.rows.every(row => Object.isFrozen(row) && Object.isFrozen(row.cells)));
  const beta = state.doc.toString().indexOf("β");
  assert.deepEqual(tableRowRevealRange(table, beta), {
    from: state.doc.toString().lastIndexOf("|", beta),
    to: state.doc.toString().indexOf("\n", beta),
  });
  assert.equal(state.sliceDoc(table.from, table.to), source.trimEnd());
  assert.equal(tableCellSelection(table, 2, 1), table.rows[2].cells[1].from);
});

test("renders table, row, and cell semantics without interpreting cell HTML", () => {
  const state = stateFor("| A | B |\n| --- | --- |\n| <img> | 2 |\n");
  const [table] = collectTableNodes(state, [{ from: 0, to: state.doc.length }]);
  const header = renderTableRowElement(fakeDocument(), table, table.rows[0]);
  assert.equal(header.tagName, "TABLE");
  assert.equal(header.children[0].tagName, "THEAD");
  assert.equal(header.children[0].children[0].children[0].tagName, "TH");
  assert.equal(header.children[0].children[0].children[0].attributes.scope, "col");
  const body = renderTableRowElement(fakeDocument(), table, table.rows[1]);
  assert.equal(body.children[0].tagName, "TBODY");
  assert.equal(body.children[0].children[0].children[0].textContent, "<img>");
});

test("leaves malformed and inconsistent tables as editable source", () => {
  for (const source of [
    "| A | B |\n| one | two |\n",
    "| A | B |\n| --- | --- |\n| only-one |\n",
    "| A | B |\n| --- | --- |\n| unclosed `code | value |\n",
  ]) {
    const state = stateFor(source);
    assert.deepEqual(collectTableNodes(state, [{ from: 0, to: state.doc.length }]), []);
    assert.equal(state.doc.toString(), source);
  }
});

test("table modules never parse QMD through HTML APIs", async () => {
  const source = await readFile(new URL("../extensions/chatero-documentation/webview/table-decorations.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\binnerHTML\b|insertAdjacentHTML|DOMParser/u);
});
