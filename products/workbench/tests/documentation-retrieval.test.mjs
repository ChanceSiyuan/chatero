import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { createDocumentationCapabilityIssuer } from "../extensions/chatero-documentation/documentation-capabilities.mjs";
import { documentationPagePath } from "../extensions/chatero-documentation/documentation-path.mjs";
import {
  createDocumentationRetrieval,
  formatRetrievedPassage,
  retrievalEligibility,
} from "../extensions/chatero-documentation/documentation-retrieval.mjs";

const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");

function fixture() {
  const stateText = '{"schemaVersion":1,"generation":"0000000000000004","documents":{"reviewed.qmd":{"state":"reviewed"},"working.qmd":{"state":"working"},"量子.qmd":{"state":"reviewed"}}}\n';
  const saved = new Map([
    ["reviewed.qmd", "# Reviewed\nA useful lemma about compactness.\n"],
    ["working.qmd", "# Working\nA draft lemma from disk.\n"],
    ["量子.qmd", "# 量子\nA useful lemma about spectra.\n"],
  ]);
  const dirty = "# Working\nA dirty lemma in the open editor.\n";
  const requests = [];
  const adapter = {
    async snapshot(request) {
      requests.push(request);
      if (request.kind === "documentation-state") return {
        kind: "documentation-state",
        epoch: "epoch-a",
        pages: [...saved].map(([path, text]) => ({ path, revision: `sha256:${sha256(text)}` })),
        state: {
          kind: "file",
          bytes: Buffer.from(stateText).toString("base64url"),
          sha256: sha256(stateText),
          revision: `sha256:${sha256(stateText)}`,
        },
      };
      return {
        kind: "snapshot",
        epoch: "epoch-a",
        entries: request.paths.map(path => {
          const useDirty = request.includeOpenBuffers === true && path.value === "working.qmd";
          const text = useDirty ? dirty : saved.get(path.value);
          return {
            path: `documentation/${path.value}`,
            type: "file",
            bytes: Buffer.from(text).toString("base64url"),
            sha256: sha256(text),
            revision: useDirty
              ? `text-document:12:sha256:${sha256(text)}`
              : `sha256:${sha256(text)}`,
            dirty: useDirty,
          };
        }),
      };
    },
  };
  let sequence = 0;
  const capabilities = createDocumentationCapabilityIssuer({
    clock: { now: () => 1_000 }, randomUUID: () => `retrieval-${++sequence}`,
  });
  const scope = capabilities.issueScope({ uri: "file:///workspace", authority: "local", epoch: "epoch-a" });
  return {
    dirty,
    requests,
    retrieval: createDocumentationRetrieval({ adapter, capabilities, scope }),
  };
}

test("background retrieval returns reviewed saved pages only in deterministic order", async () => {
  const { retrieval, requests } = fixture();
  const result = await retrieval.retrieve({ query: "lemma", limit: 10 });
  assert.deepEqual(result.map(value => value.path.value), ["reviewed.qmd", "量子.qmd"]);
  assert.ok(result.every(value => value.state === "reviewed" && value.dirty === false));
  assert.equal(requests.filter(value => value.kind === "paths").every(value => value.includeOpenBuffers === false), true);
  assert.match(formatRetrievedPassage(result[0]), /Reviewed/);
});

test("an explicit working page returns its exact dirty revision with a warning label", async () => {
  const { retrieval, dirty } = fixture();
  const [working] = await retrieval.retrieve({
    query: "lemma",
    explicitPaths: [documentationPagePath("working.qmd")],
    limit: 10,
  });
  assert.equal(working.path.value, "working.qmd");
  assert.equal(working.state, "working");
  assert.equal(working.dirty, true);
  assert.equal(working.revision, `text-document:12:sha256:${sha256(dirty)}`);
  assert.match(formatRetrievedPassage(working), /Working — not reviewed.*Dirty buffer v12/s);
});

test("retrieval eligibility keeps background working content closed", () => {
  for (const state of ["reviewed", "working"]) {
    for (const isCurrent of [false, true]) {
      for (const isExplicit of [false, true]) {
        for (const includeWorking of [false, true]) {
          for (const background of [false, true]) {
            const actual = retrievalEligibility({ state, isCurrent, isExplicit, includeWorking, background });
            const expected = state === "reviewed" || (!background && (isCurrent || isExplicit || includeWorking));
            assert.equal(actual, expected, JSON.stringify({ state, isCurrent, isExplicit, includeWorking, background }));
          }
        }
      }
    }
  }
});
