import assert from "node:assert/strict";
import { EditorSelection, EditorState } from "@codemirror/state";
import { test } from "node:test";

import { collectFormalBlocks } from "../extensions/chatero-documentation/webview/formal-block-parser.mjs";
import { createQmdLanguage } from "../extensions/chatero-documentation/webview/qmd-language.mjs";
import {
  createProofCollapseExtension,
  isProofCollapsed,
  isProofTemporarilyRevealed,
  proofKey,
  setProofCollapsed,
} from "../extensions/chatero-documentation/webview/proof-collapse.mjs";

function stateFor(source) {
  return EditorState.create({ doc: source, extensions: [createQmdLanguage(), createProofCollapseExtension()] });
}

function proofIn(state) {
  return collectFormalBlocks(state, [{ from: 0, to: state.doc.length }]).find(block => block.kind === "proof");
}

test("initializes collapse per view and toggles without a document change", () => {
  const source = '::: {#proof-demo .proof collapse="true"}\n\nProof body.\n\n:::\n';
  let left = stateFor(source);
  const right = stateFor(source);
  const block = proofIn(left);
  assert.equal(isProofCollapsed(left, block), true);
  assert.equal(isProofCollapsed(right, proofIn(right)), true);
  const transaction = left.update({ effects: setProofCollapsed.of({ proofKey: proofKey(block), collapsed: false }) });
  assert.equal(transaction.docChanged, false);
  left = transaction.state;
  assert.equal(isProofCollapsed(left, proofIn(left)), false);
  assert.equal(isProofCollapsed(right, proofIn(right)), true);
  assert.equal(left.doc.toString(), source);
});

test("only exact collapse=true initializes collapsed", () => {
  for (const [attribute, expected] of [
    ["", false],
    [' collapse="false"', false],
    [' collapse="true"', true],
    [' collapse="yes"', false],
  ]) {
    const state = stateFor(`::: {#prf-case${attribute}}\nBody.\n:::\n`);
    assert.equal(isProofCollapsed(state, proofIn(state)), expected, attribute);
  }
});

test("maps an interactive choice across preceding edits and follows untouched source attributes", () => {
  let state = stateFor('::: {#proof-mapped .proof collapse="false"}\nBody.\n:::\n');
  let block = proofIn(state);
  state = state.update({ effects: setProofCollapsed.of({ proofKey: proofKey(block), collapsed: true }) }).state;
  state = state.update({ changes: { from: 0, insert: "Intro.\n\n" } }).state;
  block = proofIn(state);
  assert.equal(isProofCollapsed(state, block), true);

  let configured = stateFor('::: {#proof-source .proof collapse="true"}\nBody.\n:::\n');
  const from = configured.doc.toString().indexOf("true");
  configured = configured.update({ changes: { from, to: from + 4, insert: "false" } }).state;
  assert.equal(isProofCollapsed(configured, proofIn(configured)), false);
});

test("selection temporarily reveals a collapsed body without changing its stored choice", () => {
  const source = '::: {#proof-select .proof collapse="true"}\n\nBody.\n\n:::\n';
  let state = stateFor(source);
  const block = proofIn(state);
  assert.equal(isProofTemporarilyRevealed(state, block), false);
  state = state.update({ selection: EditorSelection.cursor(source.indexOf("Body")) }).state;
  assert.equal(isProofTemporarilyRevealed(state, proofIn(state)), true);
  assert.equal(isProofCollapsed(state, proofIn(state)), true);
  state = state.update({ selection: EditorSelection.cursor(0) }).state;
  assert.equal(isProofTemporarilyRevealed(state, proofIn(state)), false);
  assert.equal(isProofCollapsed(state, proofIn(state)), true);
  state = state.update({ selection: EditorSelection.cursor(source.indexOf("collapse")) }).state;
  assert.equal(isProofTemporarilyRevealed(state, proofIn(state)), true);
});

test("rejects malformed proof effects", () => {
  const state = stateFor('::: {#proof-safe .proof}\nBody.\n:::\n');
  assert.throws(() => state.update({ effects: setProofCollapsed.of({ proofKey: "", collapsed: true }) }), /proof collapse/u);
  assert.throws(() => state.update({ effects: setProofCollapsed.of({ proofKey: proofKey(proofIn(state)), collapsed: "yes" }) }), /proof collapse/u);
});
