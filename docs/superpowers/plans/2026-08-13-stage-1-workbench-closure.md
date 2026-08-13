# Stage 1 Workbench Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Stage 1 with a reproducible Chatero Code-OSS workbench whose source, generated checkout, compiled runtime, local Documentation integration, legacy baseline, and headless Core baseline all pass one fail-closed acceptance contract.

**Architecture:** Keep Code-OSS as the only visible application shell and preserve the patch/materialization boundary around the pinned upstream checkout. Fix the Documentation race in the integration fixture rather than weakening the editor, express upstream system-extension exclusion as a neutral product capability, and make OpenAI Codex mode independent from GitHub protected resources. A repository-owned acceptance runner executes immutable command descriptors and writes a machine-readable evidence record outside source control.

**Tech Stack:** Node.js 24.18.0, Node test runner, Code-OSS 1.132.0/Electron, ESM scripts, TypeScript upstream patches, GitHub Actions, macOS integration runner.

## Global Constraints

- Code-OSS owns all visible UI. Zotero Core remains headless and is accessed only through the authenticated RPC boundary.
- Do not add Microsoft Marketplace, Pylance, Microsoft Remote-SSH, GitHub Copilot, or a hidden second agent runtime.
- Do not edit `vendor/code-oss` as source of truth. Every upstream change must be represented by an ordered, digest-pinned patch and reproduced by `workbench:bootstrap`.
- Acceptance must fail on skips of required commands, a dirty tracked tree, a mismatched upstream commit, a fuzzy/rejected patch, policy violations, or a non-zero command.
- Integration tests use disposable workspaces and profiles only. They must not inspect or mutate a personal Zotero profile, Code profile, or Codex home.
- Tests are written or tightened before implementation. Each task is committed only after its focused tests pass.

---

## Task 1: Make the Documentation integration gate deterministic

**Files:**

- Modify: `products/workbench/tests/documentation-integration-runner.test.mjs`
- Modify: `products/workbench/scripts/run-documentation-integration.mjs`
- Modify: `products/workbench/integration/documentation/driver/run.cjs`
- Modify: `products/workbench/integration/documentation/text-document-editor.test.mjs`

- [ ] **Step 1: Add failing runner assertions for environment-based scenario selection.**

Update the macOS runner test so `grep: "shared-buffer"` is carried only in the child environment:

```js
assert.equal(calls[0].env.CHATERO_DOCUMENTATION_TEST_GREP, "shared-buffer");
assert.equal(calls[0].args.some(arg => arg.startsWith("--chatero-documentation-grep=")), false);
```

Also read `driver/run.cjs` and assert it uses `process.env.CHATERO_DOCUMENTATION_TEST_GREP` rather than `process.argv`.

- [ ] **Step 2: Run the focused test and confirm the old custom argument fails it.**

Run:

```bash
node --test products/workbench/tests/documentation-integration-runner.test.mjs
```

Expected: FAIL because the grep value is still appended to Code-OSS arguments and absent from the environment.

- [ ] **Step 3: Move the bounded grep value into the closed child environment.**

Change the runner to pass `boundedGrep` to `environmentFor` and set the variable only when present:

```js
function environmentFor(fixture, target, root, grep) {
  const environment = { /* existing allowlist */ };
  if (grep) environment.CHATERO_DOCUMENTATION_TEST_GREP = grep;
  return Object.freeze(environment);
}
```

Remove the custom `--chatero-documentation-grep` Code-OSS argument. In the driver use:

```js
const grep = process.env.CHATERO_DOCUMENTATION_TEST_GREP;
```

The existing 1–256 byte/control-character validation remains the only entry point.

- [ ] **Step 4: Reproduce the save race with the single scenario.**

Run:

```bash
npm run test:documentation:integration -- --target local --grep dirty-save-autosave-revert
```

Expected before the fixture fix: exactly one scenario runs and fails with `document.save()` returning `false` / `File Modified Since`.

- [ ] **Step 5: Reset the already-open fixture through the shared TextDocument.**

Replace the external `workspace.fs.writeFile` reset with one authoritative `WorkspaceEdit` followed by save:

```js
async function resetFixture() {
  const document = await vscode.workspace.openTextDocument(fixtureUri());
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
    "# Documentation integration fixture\n\nshared TextDocument\n",
  );
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  assert.equal(await document.save(), true);
  return document;
}
```

This prevents an out-of-band filesystem write from racing the text model opened by the preceding shared-buffer scenario.

- [ ] **Step 6: Verify the focused and complete local integration matrices.**

Run:

```bash
node --test products/workbench/tests/documentation-integration-runner.test.mjs
npm run test:documentation:integration -- --target local --grep dirty-save-autosave-revert
npm run test:documentation:integration -- --target local
```

Expected: the focused run reports one passing scenario; the complete run reports all declared scenarios passing.

- [ ] **Step 7: Commit the deterministic integration gate.**

```bash
git add products/workbench/tests/documentation-integration-runner.test.mjs products/workbench/scripts/run-documentation-integration.mjs products/workbench/integration/documentation/driver/run.cjs products/workbench/integration/documentation/text-document-editor.test.mjs
git commit -m "fix(workbench): make documentation integration deterministic"
```

---

## Task 2: Exclude the unshipped upstream agent extension at scan time

**Files:**

- Modify: `products/workbench/product.chatero.json`
- Modify: `products/workbench/tests/product-materializer.test.mjs`
- Modify: `products/workbench/tests/workbench-policy.test.mjs`
- Modify: `products/workbench/scripts/lib/workbench-policy.mjs`
- Modify: `products/workbench/tests/patch-series.test.mjs`
- Create: `products/workbench/patches/code-oss/0011-exclude-unshipped-system-extensions.patch`
- Modify: `products/workbench/patches/code-oss/series.json`
- Patched upstream targets: `src/vs/base/common/product.ts`, `src/vs/platform/extensionManagement/common/extensionsScannerService.ts`

- [ ] **Step 1: Add failing product and policy tests for the exclusion contract.**

Require the materialized product to contain:

```json
"excludedSystemExtensionNames": ["copilot-chat"]
```

Extend the policy fixture with `checkout/extensions/copilot/package.json` whose manifest name is `copilot-chat`. Assert a generated product without that exact exclusion produces `unexcluded-system-extension`, while a duplicate/non-string exclusion produces `invalid-system-extension-exclusions`.

- [ ] **Step 2: Add failing patch-series assertions.**

Make the canonical tail assertion require `0011-exclude-unshipped-system-extensions.patch`, its exact SHA-256, the neutral `excludedSystemExtensionNames` product interface, and scanner filtering by `manifest.name` before `applyScanOptions`.

Run:

```bash
node --test products/workbench/tests/product-materializer.test.mjs products/workbench/tests/workbench-policy.test.mjs products/workbench/tests/patch-series.test.mjs
```

Expected: FAIL because the exclusion field, policy rule, patch, and digest do not exist.

- [ ] **Step 3: Implement the product overlay and fail-closed policy check.**

Add the exact single-name exclusion to `product.chatero.json`. In `verifyWorkbenchPolicy`, parse the generated product and validate that exclusions are a duplicate-free array of non-empty strings. If `checkout/extensions/copilot/package.json` exists, parse its `name` and require it to be excluded; otherwise record the precise policy violation without following symlinks.

- [ ] **Step 4: Create the upstream patch from the materialized post-0010 tree.**

Patch `IProductConfiguration`:

```ts
readonly excludedSystemExtensionNames?: readonly string[];
```

Patch `scanSystemExtensions` before the command-line skip list:

```ts
if (this.productService.excludedSystemExtensionNames?.length) {
  const excludedNames = new Set(this.productService.excludedSystemExtensionNames);
  allSystemExtensions = allSystemExtensions.filter(extension => !excludedNames.has(extension.manifest.name));
}
```

Generate a normal unified diff with paths relative to the Code-OSS checkout, add it as patch 0011, calculate SHA-256, and append it to `series.json`. Do not add the restricted publisher ID to any added patch line.

- [ ] **Step 5: Run focused tests and reproduce a fresh checkout.**

Run:

```bash
node --test products/workbench/tests/product-materializer.test.mjs products/workbench/tests/workbench-policy.test.mjs products/workbench/tests/patch-series.test.mjs
npm run workbench:bootstrap
npm run workbench:verify
```

Expected: all tests pass; bootstrap applies every patch exactly and verification reports zero policy violations.

- [ ] **Step 6: Add a runtime integration scenario proving the extension is absent.**

Append `upstream-agent-extension-absent` to `TEXT_DOCUMENT_SCENARIOS`. In the integration driver assert:

```js
assert.equal(vscode.extensions.getExtension("GitHub.copilot-chat"), undefined);
assert.equal(vscode.extensions.getExtension("chatero.chatero-documentation")?.isActive, true);
```

Update the declared matrix test first, then implement the scenario and run the local integration gate.

- [ ] **Step 7: Commit the scan-time quarantine.**

```bash
git add products/workbench/product.chatero.json products/workbench/tests products/workbench/scripts/lib/workbench-policy.mjs products/workbench/patches/code-oss
git commit -m "fix(workbench): exclude unshipped upstream agent extension"
```

---

## Task 3: Remove GitHub protected-resource probing from OpenAI Codex mode

**Files:**

- Modify: `products/workbench/tests/patch-series.test.mjs`
- Create: `products/workbench/patches/code-oss/0012-isolate-openai-codex-resources.patch`
- Modify: `products/workbench/patches/code-oss/series.json`
- Patched upstream targets: `src/vs/platform/agentHost/node/codex/codexAccountState.ts`, `src/vs/platform/agentHost/test/node/codex/codexAccountState.test.ts`

- [ ] **Step 1: Add a failing canonical patch assertion for an empty OpenAI resource list.**

Require patch 0012 to change the OpenAI branch to `[]` and its upstream unit test to:

```ts
assert.deepStrictEqual(codexProtectedResourcesForUsageSource('openai', copilot, repo), []);
```

The Copilot branch remains `[copilot, repo]` as an upstream compatibility path but Chatero cannot select or package it.

- [ ] **Step 2: Create and pin the patch.**

Generate the unified diff from the post-0011 checkout, append its SHA-256 to `series.json`, and preserve strict patch order.

- [ ] **Step 3: Rebootstrap, compile, and run upstream Codex tests.**

Run:

```bash
npm run workbench:bootstrap
npm run workbench:install
npm run workbench:compile
npm run workbench:verify
```

Also invoke the existing pinned upstream node test runner for the patched Codex account-state suite. Expected: zero TypeScript errors and the OpenAI protected-resource assertion passes.

- [ ] **Step 4: Re-run the local integration gate and inspect startup output.**

Run:

```bash
npm run test:documentation:integration -- --target local
```

Expected: no duplicate upstream agent vendor registration, no missing upstream agent extension module activation, and no token-resolution request for `https://api.github.com/repos`. A signed-out “no default agent” state is allowed because the disposable profile intentionally carries no personal credentials.

- [ ] **Step 5: Commit the protected-resource isolation.**

```bash
git add products/workbench/tests/patch-series.test.mjs products/workbench/patches/code-oss
git commit -m "fix(workbench): isolate OpenAI Codex auth resources"
```

---

## Task 4: Add the machine-readable Stage 1 acceptance contract

**Files:**

- Create: `products/workbench/acceptance/stage-1.requirements.json`
- Create: `products/workbench/scripts/run-stage-1-acceptance.mjs`
- Create: `products/workbench/tests/stage-1-acceptance.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore` only if the existing workbench cache rule does not cover the evidence output

- [ ] **Step 1: Define immutable requirement IDs and command descriptors.**

The contract must have schema version 1, stage 1, and these required checks in this order:

1. `documentation-assets` — `npm run build:documentation-webview`
2. `workbench-node-tests` — `npm run test:workbench-bootstrap`
3. `core-protocol` — `npm run core:check`
4. `core-node-tests` — `npm run test:zotero-core`
5. `legacy-node-tests` — `npm run test:chatero`
6. `code-oss-provenance` — `npm run workbench:verify`
7. `code-oss-compile` — `npm run workbench:compile`
8. `documentation-local-runtime` — `npm run test:documentation:integration -- --target local`
9. `tracked-source-clean` — an internal exact Git inspection after all generated/ignored work.

No descriptor may contain shell syntax, environment interpolation, optional flags, or platform-dependent skips for a required Stage 1 check.

- [ ] **Step 2: Add failing unit tests for validation, stop-on-failure, and evidence.**

Inject `runCommand`, `inspectSource`, `clock`, and `writeEvidence`. Assert:

- every descriptor is executed with `shell:false` and a fixed `cwd`;
- failure stops subsequent commands and writes `status: "failed"`;
- success includes source commit, clean state, Code-OSS commit, generated product SHA-256, patch-series SHA-256, start/end timestamps, durations, and each exit code;
- no environment values, stdout/stderr bodies, home paths, or credentials enter the record;
- a dirty tree or missing upstream evidence fails the run;
- evidence is written atomically beneath `products/workbench/.cache/acceptance/stage-1.json`.

- [ ] **Step 3: Implement the runner and closed CLI.**

Expose pure validators plus `runStageOneAcceptance`. The CLI accepts no arguments. It streams command output to the terminal, records status only, uses an atomic temporary file/rename for evidence, and returns non-zero on the first failure.

- [ ] **Step 4: Add the root command and run focused tests.**

Add:

```json
"verify:stage-1": "node products/workbench/scripts/run-stage-1-acceptance.mjs"
```

Run:

```bash
node --test products/workbench/tests/stage-1-acceptance.test.mjs
npm run test:workbench-bootstrap
```

Expected: all focused and workbench tests pass.

- [ ] **Step 5: Commit the acceptance contract.**

```bash
git add products/workbench/acceptance products/workbench/scripts/run-stage-1-acceptance.mjs products/workbench/tests/stage-1-acceptance.test.mjs package.json .gitignore
git commit -m "test(workbench): add stage one acceptance contract"
```

---

## Task 5: Run fresh-source and CI acceptance

**Files:**

- Modify: `.github/workflows/workbench.yml`
- Modify: `products/workbench/README.md`
- Modify: `docs/superpowers/specs/2026-08-13-seven-stage-completion-design.md` only to link final evidence/status, without weakening a gate

- [ ] **Step 1: Add a failing workflow-structure test.**

Create or extend a workbench workflow test to require:

- the fast Ubuntu node/policy job;
- a macOS Stage 1 job pinned to Node 24.18.0;
- `npm ci`, fresh `workbench:bootstrap`, `workbench:install`, and `verify:stage-1`;
- upload of `products/workbench/.cache/acceptance/stage-1.json` with `if: always()`;
- no Microsoft Marketplace, raw optional packaging, personal profile path, or unpinned checkout.

- [ ] **Step 2: Implement the macOS Stage 1 workflow job.**

Use a clean GitHub-hosted macOS runner. Cache only dependency/download inputs keyed by the upstream contract, patch series, first-party manifest, and lockfile; always verify a restored checkout before using it. Do not claim the SSH fixture or signed release gate here—those belong to Stages 5 and 7.

- [ ] **Step 3: Document the one-command local gate.**

Add `npm run verify:stage-1`, its prerequisites, evidence path, allowed signed-out warning, and the rule that the stage is incomplete if any required command is skipped.

- [ ] **Step 4: Execute the full Stage 1 acceptance from the exact tracked source.**

Before starting, ensure the implementation commits are present and the tracked tree is clean. Then run:

```bash
npm run verify:stage-1
```

Expected: all nine checks pass and the JSON evidence ends in `status: "passed"` with no skipped requirement.

- [ ] **Step 5: Independently inspect the generated record and source state.**

Run:

```bash
node -e 'const fs=require("fs");const p="products/workbench/.cache/acceptance/stage-1.json";const r=JSON.parse(fs.readFileSync(p));if(r.status!=="passed"||r.checks.some(x=>x.status!=="passed"))process.exit(1);console.log(JSON.stringify({status:r.status,sourceCommit:r.source.commit,upstreamCommit:r.upstream.commit,checks:r.checks.length},null,2))'
git diff --check
git status --short --branch
```

Expected: passed evidence, clean diff check, and no tracked changes. The ignored evidence file remains available for CI artifact upload and local audit.

- [ ] **Step 6: Mark only Stage 1 complete and commit its documentation/workflow changes.**

```bash
git add .github/workflows/workbench.yml products/workbench/README.md docs/superpowers/specs/2026-08-13-seven-stage-completion-design.md
git commit -m "ci(workbench): gate stage one acceptance"
```

Stage 2 work may start only after the fresh Stage 1 record passes. Completion of Stage 1 does not imply completion of any later stage.

