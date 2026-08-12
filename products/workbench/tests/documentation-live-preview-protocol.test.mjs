import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  createOperationId,
  createPendingDescriptor,
  parseHostMessage,
  parsePersistedState,
  parseViewMessage,
} from "../extensions/chatero-documentation/live-preview-protocol.mjs";
import { withChangeContext } from "../extensions/chatero-documentation/text-change-set.mjs";

const DIGEST = "a".repeat(64);
const NONCE = "A".repeat(24);

function descriptor(opId = "session-a:1") {
  return {
    opId,
    baseVersion: 4,
    changeDigest: DIGEST,
    shape: [{ from: 1, to: 1, insertedUtf8Bytes: 1, deletedUtf8Bytes: 0 }],
  };
}

function deepKeys(value, keys = []) {
  if (!value || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    deepKeys(child, keys);
  }
  return keys;
}

test("parses only closed view message schemas", () => {
  const edit = parseViewMessage({
    type: "edit",
    sessionId: "session-a",
    opId: "session-a:1",
    baseVersion: 4,
    changes: [{ from: 1, to: 1, insert: "x", deletedText: "", leftContext: "a", rightContext: "b" }],
  });
  assert.equal(edit.type, "edit");
  assert.ok(Object.isFrozen(edit));
  assert.throws(() => parseViewMessage({ ...edit, body: "complete source" }), /unknown field/);
  assert.throws(() => parseViewMessage({ ...edit, baseVersion: -1 }), /baseVersion/);
  assert.throws(() => parseViewMessage({ ...edit, sessionId: "other" }), /foreign|operation ID/);
  assert.throws(() => parseViewMessage({ ...edit, opId: "other:2" }), /foreign|operation ID/);
  assert.throws(() => parseViewMessage({ ...edit, changes: [{ ...edit.changes[0], from: 1.5 }] }), /offset/);

  assert.equal(parseViewMessage({ type: "ready", sessionId: "session-a", pendingDescriptors: [descriptor()] }).type, "ready");
  assert.equal(parseViewMessage({ type: "history", sessionId: "session-a", direction: "undo" }).direction, "undo");
  assert.equal(parseViewMessage({ type: "focus", sessionId: "session-a", anchor: 2, head: 4 }).head, 4);
  assert.throws(() => parseViewMessage({ type: "history", sessionId: "session-a", direction: "back" }), /direction/);
  assert.throws(() => parseViewMessage({ type: "unknown", sessionId: "session-a" }), /message type/);
});

test("parses only closed host schemas and enum values", () => {
  const change = { from: 0, to: 1, insert: "Q", deletedText: "q", leftContext: "", rightContext: "md" };
  const initialize = parseHostMessage({
    type: "initialize",
    sessionId: "session-a",
    source: "qmd",
    version: 4,
    digest: DIGEST,
    cspNonce: NONCE,
    reassociatedPendingOperations: [{ opId: "session-a:1", baseVersion: 4, changes: [change] }],
  });
  assert.equal(initialize.cspNonce, NONCE);
  assert.equal(parseHostMessage({
    type: "documentChanged", sessionId: "session-a", beforeVersion: 4, afterVersion: 5, changes: [change], digest: DIGEST,
  }).type, "documentChanged");
  assert.equal(parseHostMessage({
    type: "operationAcknowledged", sessionId: "session-a", opId: "session-a:1", afterVersion: 5, digest: DIGEST,
  }).type, "operationAcknowledged");
  assert.equal(parseHostMessage({
    type: "resync", sessionId: "session-a", source: "qmd", version: 5, digest: DIGEST, reason: "version-conflict",
  }).reason, "version-conflict");
  assert.equal(parseHostMessage({
    type: "pendingConflict", sessionId: "session-a", opId: "session-a:1", reason: "overlap", authoritativeExcerpt: "q", pendingInsert: "Q",
  }).reason, "overlap");
  assert.equal(parseHostMessage({ type: "connectionState", sessionId: "session-a", state: "connected" }).state, "connected");

  assert.throws(() => parseHostMessage({ ...initialize, nonce: NONCE }), /unknown field/);
  assert.throws(() => parseHostMessage({ ...initialize, cspNonce: "short" }), /nonce/);
  assert.throws(() => parseHostMessage({ ...initialize, digest: "A".repeat(64) }), /digest/);
  assert.throws(() => parseHostMessage({
    type: "resync", sessionId: "session-a", source: "", version: 1, digest: DIGEST, reason: "anything",
  }), /reason/);
  assert.throws(() => parseHostMessage({ type: "connectionState", sessionId: "session-a", state: "unknown" }), /state/);
});

test("enforces byte-oriented IDs, changes, and complete frame caps", () => {
  assert.equal(createOperationId("session-a", 12), "session-a:12");
  assert.throws(() => createOperationId("é".repeat(65), 1), /128 UTF-8 bytes/);
  assert.throws(() => createOperationId("has:colon", 1), /sessionId/);
  const base = {
    type: "edit",
    sessionId: "session-a",
    opId: "session-a:1",
    baseVersion: 1,
    changes: [{ from: 0, to: 0, insert: "", deletedText: "", leftContext: "", rightContext: "" }],
  };
  assert.throws(() => parseViewMessage({
    ...base,
    changes: [{ ...base.changes[0], leftContext: "😀".repeat(65) }],
  }), /context.*256 UTF-8 bytes/i);
  assert.throws(() => parseViewMessage({
    ...base,
    changes: [{ ...base.changes[0], insert: "😀".repeat(1024 * 1024 + 1) }],
  }), /insert.*4 MiB/i);
  assert.throws(() => parseViewMessage({ ...base, changes: Array.from({ length: 257 }, () => base.changes[0]) }), /256 changes/);
  const underFourMiB = "x".repeat(3_200_000);
  assert.throws(() => parseViewMessage({
    ...base,
    changes: Array.from({ length: 4 }, (_, index) => ({
      ...base.changes[0], from: index, to: index, insert: underFourMiB,
    })),
  }), /12 MiB/);
});

test("persists only bounded content-free pending descriptors", async () => {
  const source = "a".repeat(1024 * 1024);
  for (const insert of ["", "b".repeat(1024 * 1024)]) {
    const operation = {
      opId: "session-a:1",
      baseVersion: 4,
      changes: withChangeContext(source, [{ from: 0, to: source.length, insert }]),
    };
    const parsed = parseViewMessage({ type: "edit", sessionId: "session-a", ...operation });
    assert.equal(parsed.changes[0].insert.length, insert.length);
    const pending = await createPendingDescriptor(operation);
    const state = parsePersistedState({ sessionId: "session-a", nextSequence: 2, pendingDescriptors: [pending] });
    assert.deepEqual(Object.keys(state), ["sessionId", "nextSequence", "pendingDescriptors"]);
    const forbidden = new Set(["source", "body", "changes", "insert", "deletedText", "leftContext", "rightContext", "authoritativeExcerpt", "pendingInsert"]);
    assert.equal(deepKeys(state).some(key => forbidden.has(key)), false);
    assert.deepEqual(state.pendingDescriptors[0].shape, [{
      from: 0,
      to: source.length,
      insertedUtf8Bytes: insert.length,
      deletedUtf8Bytes: source.length,
    }]);
  }

  assert.throws(() => parsePersistedState({
    sessionId: "session-a", nextSequence: 2, pendingDescriptors: [descriptor()], source: "secret",
  }), /unknown field/);
  assert.throws(() => parsePersistedState({
    sessionId: "session-a", nextSequence: 2, pendingDescriptors: Array.from({ length: 65 }, (_, index) => descriptor(`session-a:${index + 1}`)),
  }), /64 descriptors/);
  assert.throws(() => parsePersistedState({
    sessionId: "session-a",
    nextSequence: 2,
    pendingDescriptors: [{ ...descriptor(), shape: Array.from({ length: 257 }, (_, index) => ({ from: index, to: index, insertedUtf8Bytes: 0, deletedUtf8Bytes: 0 })) }],
  }), /256 change shapes/);
});

test("the browser editor uses a nonce and no private CodeMirror history", async () => {
  const source = await readFile(new URL("../extensions/chatero-documentation/webview/live-preview-editor.mjs", import.meta.url), "utf8");
  assert.match(source, /export const hostSync = Annotation\.define\(\)/);
  assert.match(source, /EditorView\.cspNonce\.of\(cspNonce\)/);
  assert.doesNotMatch(source, /import\s*\{[^}]*\b(?:history|undo|redo)\b[^}]*\}\s*from\s*["']@codemirror\/commands/);
  assert.doesNotMatch(source, /\b(?:history|undo|redo)\s*\(/);
});
