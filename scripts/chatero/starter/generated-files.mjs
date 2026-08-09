const text = (value) => Buffer.from(value.replace(/^\n/, ""), "utf8");

/**
 * The starter is intentionally a generated, dependency-closed public
 * repository.  It is not a serialized development checkout: source paths are
 * checked by the builder only to verify the supported architecture, while the
 * archive contains this minimal local implementation and no user material.
 */
export const GENERATED_STARTER_FILES = Object.freeze({
  ".gitignore": text(`
node_modules/
dist/
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
.env*
`),
  ".node-version": text(`
22
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

Run \`npm run knowledge:check\` before proposing a Draft for Knowledge. Keep
rendering local and never execute QMD code while rendering.
`),
  "CLAUDE.md": text(`
# Research Loop

Follow the repository trust boundary and workflow in \`AGENTS.md\`.
`),
  "Makefile": text(`
.PHONY: build knowledge-check knowledge-preview

build:
\tnpm run build

knowledge-check:
\tnpm run knowledge:check

knowledge-preview:
\tnpm run start
`),
  "README.md": text(`
# Research Loop starter

A local, private-first workspace for reviewed Knowledge, editable Drafts, and
external Literature. Run \`npm run build\` to build the trusted Knowledge site.
`),
  "package.json": text(`
{
  "name": "research-loop-starter",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.13.0"
  },
  "dependencies": {
    "@retorquere/bibtex-parser": "10.0.0",
    "mdast-util-to-string": "4.0.0",
    "next": "16.2.6",
    "react": "19.2.6",
    "react-dom": "19.2.6",
    "remark-parse": "11.0.0",
    "tar": "7.5.19",
    "unified": "11.0.5",
    "unist-util-visit": "5.1.0",
    "yaml": "2.9.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "1.37.1",
    "@cloudflare/workers-types": "4.20260515.1",
    "@playwright/test": "1.61.1",
    "@tailwindcss/postcss": "4.2.1",
    "@types/node": "22.19.19",
    "@types/react": "19.2.14",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "6.0.2",
    "@vitejs/plugin-rsc": "0.5.26",
    "eslint": "9.39.4",
    "eslint-config-next": "16.2.6",
    "react-server-dom-webpack": "19.2.6",
    "tailwindcss": "4.2.1",
    "tsx": "4.23.1",
    "typescript": "5.9.3",
    "vinext": "0.0.50",
    "vite": "8.0.13",
    "wrangler": "4.92.0"
  },
  "scripts": {
    "start": "vinext start --host 127.0.0.1",
    "build:app": "vinext build",
    "build": "npm run knowledge:build && npm run build:app",
    "knowledge:check": "node --import tsx .research-loop/tooling/scripts/knowledge.ts check",
    "knowledge:resolve": "node --import tsx .research-loop/tooling/scripts/knowledge.ts resolve",
    "knowledge:build": "node --import tsx .research-loop/tooling/scripts/knowledge.ts build",
    "knowledge:preview": "node --import tsx .research-loop/tooling/scripts/knowledge.ts preview",
    "draft:check": "node --import tsx .research-loop/tooling/scripts/draft-check.ts",
    "draft:preview": "node --import tsx .research-loop/tooling/scripts/draft-preview.ts",
    "literature:index": "node --import tsx .research-loop/tooling/scripts/literature.ts index",
    "qlab": "node --import tsx .research-loop/tooling/scripts/qlab.ts"
  }
}
`),
  "qlab": text(`
#!/bin/sh
set -eu
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node --import tsx "$repository_root/.research-loop/tooling/scripts/qlab.ts" "$@"
`),
  "vite.config.ts": text(`
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

export default {
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      config: {
        main: "./src/worker/index.ts",
        compatibility_flags: ["nodejs_compat"],
        d1_databases: [],
        r2_buckets: [],
      },
    }),
  ],
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
};
`),
  "tsconfig.json": text(`
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", ".research-loop/tooling/scripts/**/*.ts"]
}
`),
  "knowledge/index.qmd": text(`
---
title: "Knowledge"
description: "A reviewed, trusted Research Loop knowledge index."
---

## Reading map

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
  "drafts/examples/theorem-blocks.qmd": text(String.raw`
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
  "src/app/globals.css": text(`
:root { color: #192334; background: #f6f8fb; font-family: Inter, system-ui, sans-serif; }
body { margin: 0; }
main { max-width: 56rem; margin: 0 auto; padding: 4rem 1.5rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 1rem; }
a { color: #155eef; text-decoration: none; }
.card { border: 1px solid #d8dee9; border-radius: .75rem; padding: 1rem; background: white; }
`),
  "src/app/layout.tsx": text(`
import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`),
  "src/app/page.tsx": text(`
const workflows = [
  ["Repository", "Initialize or inspect the local Research Loop workspace.", "/"],
  ["Knowledge", "Read trusted notes built from validated QMD files.", "/knowledge/"],
  ["Drafts", "Preview and check editable QMD research drafts.", "/drafts"],
  ["Literature", "Index evidence and synchronize approved Zotero metadata.", "/literature"],
] as const;

export default function Home() {
  return <main><p>Research Loop</p><h1>Local research workspace</h1><p>Use the validated workflows below. Your notes and citations remain on this computer.</p><section className="grid">{workflows.map(([name, description, href]) => <a className="card" href={href} key={name}><h2>{name}</h2><p>{description}</p></a>)}</section></main>;
}
`),
  "src/app/drafts/page.tsx": text(`
export default function DraftsPage() { return <main><h1>Drafts</h1><p>Run <code>npm run draft:check -- --file drafts/&lt;note&gt;.qmd</code> before review.</p></main>; }
`),
  "src/app/literature/page.tsx": text(`
export default function LiteraturePage() { return <main><h1>Literature</h1><p>Run <code>npm run literature:index</code> to derive local method indexes from ref.bib.</p></main>; }
`),
  "src/app/api/qlab/health/route.ts": text(`
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true, repositoryIdentity: process.env.QLAB_REPOSITORY_ID ?? null });
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
  "src/app/drafts",
  "src/app/literature",
  "src/app/api",
  "src/app/api/qlab",
  "src/app/api/qlab/health",
]);
