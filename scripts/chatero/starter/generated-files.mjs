const text = (value) => Buffer.from(value.replace(/^\n/, ""), "utf8");

/**
 * Public, content-free files added to every initialized Research Loop workspace.
 * These replace the deliberately excluded personal knowledge, draft, and
 * literature trees from the source checkout.
 */
export const GENERATED_STARTER_FILES = Object.freeze({
  ".gitignore": text(`
node_modules/
.next/
.vinext/
dist/
out/
public/knowledge/
drafts/.preview/
drafts/.quarto/
drafts/ai-contexts/
literature/.staging/
literature/zotero.bib
literature/**/.raw/
literature/**/.figures/
.research-loop/starter.json
.research-loop/local/
.generated/
.wrangler/
.env*
`),
  "AGENTS.md": text(`
# Research Loop — Agent Instructions

Research Loop is a local human-and-agent knowledge system. Keep the trusted
Knowledge tree, editable Drafts, and external Literature as separate areas.

| Tree | Status | Rule |
| --- | --- | --- |
| \`knowledge/\` | trusted | Add only user-reviewed material. |
| \`drafts/\` | editable | Keep unfinished work here until review. |
| \`literature/\` | external evidence | Do not treat source material as trusted knowledge. |

Run \`make knowledge-check\` before proposing a Draft for Knowledge. Keep all
preview and build work local, and never execute QMD code while rendering.
`),
  "CLAUDE.md": text(`
# Research Loop

Follow the repository trust boundary and workflow in \`AGENTS.md\`.
`),
  "vite.config.ts": text(`
import vinext from "vinext";

export default {
  plugins: [vinext()],
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
};
`),
  "knowledge/index.qmd": text(`
---
title: "Knowledge"
---

This trusted knowledge area is intentionally empty. Add reviewed notes through
the Research Loop approval workflow.
`),
  "knowledge/research-loop.css": text(`
/* Public starter stylesheet. Personal Knowledge styling is never bundled. */
`),
  "knowledge/research-loop-tree-header.html": text(`
<!-- Topic-tree assets are generated locally after Knowledge has approved notes. -->
`),
  "literature/README.md": text(`
# Literature

This evidence area is intentionally empty. Import Zotero metadata before using
citations in a draft.
`),
  "literature/ref.bib": text(`
% Research Loop bibliography
% Zotero synchronization adds reviewed references here.
`),
  "drafts/examples/theorem-blocks.qmd": text(`
---
title: "Formal blocks example"
description: "A safe draft template for definitions, lemmas, theorems, and proofs."
categories:
  - theory
---

# A small formal argument

::: {#def-starter .callout-note icon=false}
## Definition

Let $x$ be a real number. Its square is $x^2$.
:::

::: {#lem-starter .callout-note icon=false}
## Lemma

For every real $x$, $x^2 \geq 0$.
:::

::: {#thm-starter .callout-important icon=false}
## Theorem

If $x^2 = 0$, then $x = 0$.
:::

::: {.proof}
By the lemma, a square is nonnegative. The only real number whose square is
zero is zero itself.
:::

The display-math form is

$$
(x + y)^2 = x^2 + 2xy + y^2.
$$

After Zotero has refreshed \`literature/ref.bib\`, cite a record with the syntax
\`[@citekey]\`.
`),
  "src/app/api/qlab/health/route.ts": text(`
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    ok: true,
    repositoryIdentity: process.env.QLAB_REPOSITORY_ID ?? null,
  });
}
`),
});

export const GENERATED_STARTER_DIRECTORIES = Object.freeze([
  ".research-loop",
  ".research-loop/tooling",
  ".research-loop/tooling/scripts",
  "drafts",
  "drafts/examples",
  "knowledge",
  "literature",
  "src",
  "src/app",
  "src/app/api",
  "src/app/api/qlab",
  "src/app/api/qlab/health",
]);
