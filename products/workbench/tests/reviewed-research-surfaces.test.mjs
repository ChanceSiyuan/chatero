import assert from "node:assert/strict";
import { test } from "node:test";

import { createReviewedResearchSurfaces } from "../extensions/chatero-documentation/reviewed-research-surfaces.mjs";

function fixture() {
  const panels = [];
  const documents = new Map([
    ["/repo/documentation/a.qmd", '---\ntitle: "Alpha"\ncategories: [quantum, codes]\n---\n\n# Alpha\n\nEvidence [@lovelace1843].\n'],
    ["/repo/documentation/working.qmd", "# Secret working bytes\n"],
  ]);
  const root = { scheme: "file", authority: "", path: "/repo", with(changes) { return { ...this, ...changes }; } };
  const vscode = {
    ViewColumn: { Active: 1 },
    window: {
      createWebviewPanel(viewType, title, column, options) {
        const panel = { viewType, title, column, options, webview: { html: "" } };
        panels.push(panel);
        return panel;
      },
    },
    workspace: {
      async openTextDocument(uri) {
        const text = documents.get(uri.path);
        if (text === undefined) throw new Error("missing");
        return { getText: () => text, uri };
      },
    },
  };
  const surfaces = createReviewedResearchSurfaces({
    services: {
      scope: {}, workspaceFolderUri: root,
      transactions: { async state() { return { documents: { "a.qmd": { state: "reviewed" }, "working.qmd": { state: "working" } } }; } },
    },
    vscode,
  });
  return { panels, surfaces };
}

test("topic graph contains deterministic reviewed metadata and no working source bytes", async () => {
  const { panels, surfaces } = fixture();
  const result = await surfaces.openTopicGraph();
  assert.equal(result.kind, "topic-graph-opened");
  assert.match(panels[0].webview.html, /Alpha/u);
  assert.match(panels[0].webview.html, /quantum/u);
  assert.match(panels[0].webview.html, /lovelace1843/u);
  assert.doesNotMatch(panels[0].webview.html, /Secret working bytes/u);
  assert.equal(panels[0].options.enableScripts, false);
});

test("Main Site renders only reviewed passive QMD and escapes executable HTML", async () => {
  const { panels, surfaces } = fixture();
  const result = await surfaces.openMainSite();
  assert.equal(result.kind, "main-site-opened");
  assert.match(panels[0].webview.html, /Alpha/u);
  assert.doesNotMatch(panels[0].webview.html, /working|Secret working bytes/u);
  assert.doesNotMatch(panels[0].webview.html, /<script|https?:\/\//iu);
  assert.match(panels[0].webview.html, /default-src 'none'/u);
});
