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
  "scripts": {
    "knowledge:check": "node .research-loop/tooling/scripts/knowledge.mjs check",
    "knowledge:build": "node .research-loop/tooling/scripts/knowledge.mjs build",
    "build:app": "node .research-loop/tooling/scripts/build-app.mjs",
    "build": "npm run knowledge:check && npm run knowledge:build && npm run build:app",
    "start": "node .research-loop/tooling/scripts/start-site.mjs",
    "qlab": "node .research-loop/tooling/scripts/qlab.mjs --help"
  }
}
`),
  "package-lock.json": text(`
{
  "name": "research-loop-starter",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "research-loop-starter",
      "version": "0.1.0",
      "engines": {
        "node": ">=22.13.0"
      }
    }
  }
}
`),
  "qlab": text(`
#!/bin/sh
set -eu
repository_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$repository_root/.research-loop/tooling/scripts/qlab.mjs" "$@"
`),
  "vite.config.ts": text(`
export default {
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
};
`),
  "knowledge/_quarto.yml": text(`
project:
  type: website
  output-dir: ../public/knowledge
  render:
    - "**/*.qmd"
website:
  title: "Research Loop Knowledge"
format:
  html:
    toc: true
execute:
  enabled: false
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
  "drafts/_quarto.yml": text(`
project:
  type: website
  output-dir: .preview
execute:
  enabled: false
bibliography: ../literature/ref.bib
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
  ".research-loop/tooling/scripts/knowledge.mjs": text(`
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const indexPath = join(repository, "knowledge", "index.qmd");

async function checkKnowledge() {
  const index = await readFile(indexPath, "utf8");
  if (!/^description:\\s*["'][^"']+["']$/m.test(index)) {
    throw new Error("knowledge/index.qmd requires a non-empty description");
  }
  if (!/^## Reading map$/m.test(index)) {
    throw new Error("knowledge/index.qmd requires a ## Reading map section");
  }
}

const command = process.argv[2];
if (command !== "check" && command !== "build") {
  console.error("Usage: knowledge.mjs <check|build>");
  process.exitCode = 2;
} else {
  try {
    await checkKnowledge();
    if (command === "build") {
      const result = spawnSync("quarto", ["render", "knowledge", "--no-execute"], {
        cwd: repository,
        stdio: "inherit",
      });
      if (result.status !== 0) process.exitCode = result.status ?? 1;
    } else {
      console.log("knowledge: the trusted tree is valid");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
`),
  ".research-loop/tooling/scripts/build-app.mjs": text(`
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const output = join(repository, "dist");
await mkdir(output, { recursive: true });
await writeFile(join(output, "index.html"), [
  "<!doctype html>",
  "<html><head><meta charset=\\"utf-8\\"><title>Research Loop</title></head>",
  "<body><main><h1>Research Loop</h1><p><a href=\\"/knowledge/\\">Open Knowledge</a></p></main></body></html>",
].join(""));
`),
  ".research-loop/tooling/scripts/start-site.mjs": text(`
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const port = Number.parseInt(process.env.PORT ?? "4180", 10);
const safePort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 4180;
const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/api/qlab/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, repositoryIdentity: process.env.QLAB_REPOSITORY_ID ?? null }));
    return;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\\/+/, "");
  const safe = normalize(relative).replace(/^([.][.][/\\\\])+/, "");
  const target = join(repository, safe.startsWith("knowledge/") ? "public" : "dist", safe.startsWith("knowledge/") ? safe : safe);
  try {
    response.writeHead(200, { "content-type": contentTypes[extname(target)] ?? "application/octet-stream" });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(safePort, "127.0.0.1", () => {
  console.log("Research Loop is available at http://127.0.0.1:" + safePort + "/");
});
`),
  ".research-loop/tooling/scripts/qlab.mjs": text(`
const command = process.argv.slice(2).join(" ");
if (!command || command === "--help") {
  console.log("Research Loop starter: use npm run knowledge:check, npm run build, or npm run start.");
} else {
  console.error("Unsupported starter command: " + command);
  process.exitCode = 2;
}
`),
  "src/app/api/qlab/health/route.ts": text(`
export function healthResponse(repositoryIdentity = process.env.QLAB_REPOSITORY_ID ?? null) {
  return { ok: true, repositoryIdentity };
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
