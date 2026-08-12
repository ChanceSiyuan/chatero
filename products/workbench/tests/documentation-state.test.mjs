import assert from "node:assert/strict";
import { test } from "node:test";

import { documentationPagePath } from "../extensions/chatero-documentation/documentation-path.mjs";
import {
  compareUtf8Bytes,
  nextStateGeneration,
  parseDocumentationState,
  projectDocumentationState,
  serializeDocumentationState,
} from "../extensions/chatero-documentation/documentation-state.mjs";

const STATE_PATH = ".chatero/documentation-state.v1.json";

test("parses and serializes only the exact canonical state snapshot", () => {
  const bytes = Buffer.from(
    '{"schemaVersion":1,"generation":"0000000000000001","documents":{"index.qmd":{"state":"reviewed"}}}\n',
  );
  const valid = parseDocumentationState(bytes);
  assert.equal(valid.kind, "valid");
  assert.equal(valid.state.documents["index.qmd"].state, "reviewed");
  assert.equal(Object.isFrozen(valid.state.documents), true);
  assert.deepEqual(serializeDocumentationState(valid.state), bytes);

  const state = {
    schemaVersion: 1,
    generation: "000000000000000a",
    documents: {
      "中.qmd": { state: "working" },
      "ä.qmd": { state: "reviewed" },
      "z.qmd": { state: "working" },
    },
  };
  const serialized = serializeDocumentationState(state).toString("utf8");
  assert.ok(serialized.indexOf('"z.qmd"') < serialized.indexOf('"ä.qmd"'));
  assert.ok(serialized.indexOf('"ä.qmd"') < serialized.indexOf('"中.qmd"'));
  assert.equal(compareUtf8Bytes("ä.qmd", "中.qmd") < 0, true);
});

test("invalid or missing state snapshots project every current page as working", () => {
  const pages = [documentationPagePath("index.qmd"), documentationPagePath("topics/result.qmd")];
  const invalidBytes = [
    Buffer.from("{"),
    Buffer.from('{"schemaVersion":2}\n'),
    Buffer.from('{"schemaVersion":1,"generation":"1","documents":{}}\n'),
    Buffer.from('{"schemaVersion":1,"generation":"0000000000000001","documents":{"index.qmd":{"state":"reviewed","extra":true}}}\n'),
    Buffer.from('{"schemaVersion":1,"generation":"0000000000000001","documents":{"../index.qmd":{"state":"reviewed"}}}\n'),
    Buffer.from('{"schemaVersion":1,"generation":"0000000000000001","documents":{"Topic.qmd":{"state":"reviewed"},"topic.qmd":{"state":"working"}}}\n'),
    Buffer.from('{"schemaVersion":1,"generation":"0000000000000001","documents":{"index.qmd":{"state":"reviewed"}},"extra":true}\n'),
    Buffer.from('{"generation":"0000000000000001","schemaVersion":1,"documents":{}}\n'),
  ];

  for (const bytes of [null, ...invalidBytes]) {
    const projected = projectDocumentationState({ pages, parsed: parseDocumentationState(bytes) });
    assert.deepEqual(projected.documents, {
      "index.qmd": { state: "working" },
      "topics/result.qmd": { state: "working" },
    });
    assert.equal(projected.diagnostics.length, 1);
    assert.equal(projected.diagnostics[0].path, STATE_PATH);
  }
});

test("valid state preserves same-path edits and reports external structural changes", () => {
  const parsed = parseDocumentationState(Buffer.from(
    '{"schemaVersion":1,"generation":"0000000000000002","documents":{"old.qmd":{"state":"reviewed"},"stable.qmd":{"state":"reviewed"}}}\n',
  ));
  const samePaths = projectDocumentationState({
    pages: [documentationPagePath("old.qmd"), documentationPagePath("stable.qmd")],
    parsed,
  });
  assert.equal(samePaths.documents["old.qmd"].state, "reviewed");
  assert.equal(samePaths.documents["stable.qmd"].state, "reviewed");
  assert.deepEqual(samePaths.diagnostics, []);

  const renamed = projectDocumentationState({
    pages: [documentationPagePath("new.qmd"), documentationPagePath("stable.qmd")],
    parsed,
  });
  assert.deepEqual(renamed.documents, {
    "new.qmd": { state: "working" },
    "old.qmd": { state: "reviewed", orphan: true },
    "stable.qmd": { state: "reviewed" },
  });
  assert.deepEqual(renamed.diagnostics, [{
    code: "documentation-state-orphan",
    path: "old.qmd",
    message: "State entry has no current Documentation page.",
  }]);
});

test("state generations increment without changing width or numeric representation", () => {
  assert.equal(nextStateGeneration("0000000000000000"), "0000000000000001");
  assert.equal(nextStateGeneration("000000000000000f"), "0000000000000010");
  for (const value of [
    "1",
    "000000000000000A",
    "+000000000000001",
    "0x00000000000001",
    "00000000000000000",
  ]) {
    assert.throws(() => nextStateGeneration(value), TypeError);
  }
  assert.throws(() => nextStateGeneration("ffffffffffffffff"), /overflow/);
});
