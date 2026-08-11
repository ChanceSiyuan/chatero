# Code-OSS Workbench Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a reproducible, policy-checked Chatero development workbench from a pinned Code-OSS commit without committing generated upstream source or contacting Microsoft's extension marketplace.

**Architecture:** The existing repository remains the product authority. Small Node ESM tools validate a pinned upstream contract, materialize Code-OSS into ignored `vendor/code-oss`, apply an exact patch series, generate Chatero product configuration, and verify provenance and marketplace policy before any build. The initial deliverable is a branded developer shell and a durable bootstrap boundary that later Zotero extensions and Core RPC work can consume.

**Tech Stack:** Node.js ESM and `node:test`; Git; Code-OSS 1.132.0 (`df53daabb18cd157bdb08c7f01c34df936cf12f4`); Node 24.18.0; Electron 42.7.1; Open VSX; npm.

## Global Constraints

- The final visible product is one Code-OSS/Electron Chatero workbench; the existing Gecko UI remains a development-only parity oracle until atomic cutover.
- Existing Zotero profiles and external Knowledge, Drafts, Literature, Git repositories, chat history, PDFs, SSH configuration, and credentials must never be modified by bootstrap or tests.
- `vendor/code-oss`, dependencies, caches, native helper outputs, application bundles, and other generated artifacts must not be committed.
- Electron and extensions must never write `zotero.sqlite`; Zotero Core remains the only profile owner.
- Use Open VSX and Chatero-owned replacements; do not contact Microsoft Marketplace or bundle Microsoft-only Pylance/Remote-SSH extensions.
- Apply Code-OSS patches without fuzz and fail when the pinned upstream checkout is dirty or has the wrong commit.
- Prefer built-in extensions and supported Code-OSS contribution points over core patches.
- All implementation changes are test-first and committed in independently reviewable slices.

---

## File Structure

```text
products/workbench/
├── upstreams.json                         # immutable Code-OSS/runtime pin
├── product.chatero.json                   # Chatero identity and Open VSX policy
├── patches/code-oss/series.json           # ordered, digest-pinned patch list
├── scripts/
│   ├── bootstrap-code-oss.mjs             # checkout + patch + product pipeline
│   ├── verify-code-oss.mjs                # standalone provenance/policy gate
│   └── lib/
│       ├── upstream-contract.mjs           # parse/validate immutable pin
│       ├── git-checkout.mjs                # exact checkout lifecycle
│       ├── patch-series.mjs                # strict ordered patch application
│       ├── product-materializer.mjs        # deterministic product.json writer
│       └── workbench-policy.mjs             # forbidden endpoint/extension scan
├── tests/
│   ├── upstream-contract.test.mjs
│   ├── git-checkout.test.mjs
│   ├── patch-series.test.mjs
│   ├── product-materializer.test.mjs
│   ├── workbench-policy.test.mjs
│   └── bootstrap-code-oss.integration.test.mjs
└── README.md                               # developer bootstrap/run contract
```

The root `package.json` exposes stable `workbench:*` commands. The root
`.gitignore` excludes only generated workbench inputs and outputs. No existing
Zotero/QLab runtime file changes in this plan.

---

### Task 1: Immutable Upstream Contract

**Files:**
- Create: `products/workbench/upstreams.json`
- Create: `products/workbench/scripts/lib/upstream-contract.mjs`
- Create: `products/workbench/tests/upstream-contract.test.mjs`

**Interfaces:**
- Consumes: a JSON file path.
- Produces: `loadUpstreamContract(path): Promise<Readonly<UpstreamContract>>`, where `UpstreamContract` contains `schemaVersion`, `codeOss.repository`, `codeOss.ref`, `codeOss.commit`, `codeOss.version`, `codeOss.node`, `codeOss.electron`, and `openVSX.gallery`.

- [ ] **Step 1: Write the failing contract tests**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadUpstreamContract } from "../scripts/lib/upstream-contract.mjs";

test("loads and freezes the pinned Code-OSS contract", async () => {
  const contract = await loadUpstreamContract(new URL("../upstreams.json", import.meta.url));
  assert.equal(contract.codeOss.version, "1.132.0");
  assert.equal(contract.codeOss.commit, "df53daabb18cd157bdb08c7f01c34df936cf12f4");
  assert.equal(contract.codeOss.node, "24.18.0");
  assert.equal(contract.codeOss.electron, "42.7.1");
  assert.equal(contract.openVSX.gallery, "https://open-vsx.org/vscode/gallery");
  assert.throws(() => { contract.codeOss.commit = "changed"; }, TypeError);
});

test("rejects mutable refs and malformed commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatero-upstream-contract-"));
  const invalid = join(directory, "upstreams.json");
  await writeFile(invalid, JSON.stringify({
    schemaVersion: 1,
    codeOss: { repository: "https://github.com/microsoft/vscode.git", ref: "main", commit: "latest", version: "1.132.0", node: "24.18.0", electron: "42.7.1" },
    openVSX: { gallery: "https://open-vsx.org/vscode/gallery" }
  }));
  await assert.rejects(
    loadUpstreamContract(invalid),
    /codeOss\.commit must be a 40-character lowercase SHA-1/
  );
});
```

- [ ] **Step 2: Run the test and confirm the missing-module failure**

Run: `node --test products/workbench/tests/upstream-contract.test.mjs`

Expected: FAIL because `upstream-contract.mjs` does not exist.

- [ ] **Step 3: Add the pinned contract and strict parser**

```json
{
  "schemaVersion": 1,
  "codeOss": {
    "repository": "https://github.com/microsoft/vscode.git",
    "ref": "refs/tags/1.132.0",
    "commit": "df53daabb18cd157bdb08c7f01c34df936cf12f4",
    "version": "1.132.0",
    "node": "24.18.0",
    "electron": "42.7.1"
  },
  "openVSX": {
    "gallery": "https://open-vsx.org/vscode/gallery",
    "item": "https://open-vsx.org/vscode/item",
    "resource": "https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/Microsoft.VisualStudio.Code.WebResources/extension"
  }
}
```

Implement `loadUpstreamContract()` with `readFile`, exact key checks, HTTPS URL
checks, immutable-ref validation, SHA-1 validation, semantic-version validation,
recursive `Object.freeze`, and error messages that name the rejected field.

- [ ] **Step 4: Run the contract test**

Run: `node --test products/workbench/tests/upstream-contract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```bash
git add products/workbench/upstreams.json products/workbench/scripts/lib/upstream-contract.mjs products/workbench/tests/upstream-contract.test.mjs
git commit -m "build(workbench): pin Code-OSS upstream"
```

### Task 2: Exact, Disposable Git Checkout

**Files:**
- Create: `products/workbench/scripts/lib/git-checkout.mjs`
- Create: `products/workbench/tests/git-checkout.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `ensureCheckout({ repository, ref, commit, destination, runGit }): Promise<CheckoutResult>`.
- Produces: `{ destination, commit, created, clean }`; `verifyCheckout({ destination, commit, runGit })`; no profile or external workspace access.

- [ ] **Step 1: Write failing tests around an injected Git runner**

```js
test("creates a detached checkout at the exact commit", async () => {
  const calls = [];
  const result = await ensureCheckout({
    repository: "https://github.com/microsoft/vscode.git",
    ref: "refs/tags/1.132.0",
    commit: PIN,
    destination: "/tmp/chatero-code-oss",
    exists: async () => false,
    runGit: async args => { calls.push(args); return args[0] === "rev-parse" ? `${PIN}\n` : ""; },
  });
  assert.equal(result.created, true);
  assert.deepEqual(calls[0], ["clone", "--filter=blob:none", "--no-checkout", "https://github.com/microsoft/vscode.git", "/tmp/chatero-code-oss"]);
  assert.ok(calls.some(args => args.join(" ") === `checkout --detach ${PIN}`));
});

test("rejects a dirty existing checkout without resetting it", async () => {
  const runGit = async args => {
    if (args[0] === "status") return " M product.json\n";
    if (args[0] === "rev-parse") return `${PIN}\n`;
    return "";
  };
  await assert.rejects(
    ensureCheckout({
      repository: "https://github.com/microsoft/vscode.git",
      ref: "refs/tags/1.132.0",
      exists: async () => true,
      runGit,
      commit: PIN,
      destination: "/tmp/source"
    }),
    /checkout is dirty/
  );
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `node --test products/workbench/tests/git-checkout.test.mjs`

Expected: FAIL because `git-checkout.mjs` does not exist.

- [ ] **Step 3: Implement non-destructive checkout lifecycle**

Use `execFile("git", args, { cwd })`, never a shell string. New destinations use
filtered clone, explicit fetch of the immutable ref, detached checkout of the
commit, and `rev-parse HEAD` verification. Existing destinations must be a Git
worktree, have an empty porcelain status, fetch the pinned ref, detach at the
pin, and verify HEAD. Do not call `reset`, `clean`, or delete a destination.

Add these exact ignore entries:

```gitignore
vendor/code-oss/
products/workbench/.cache/
products/workbench/dist/
```

- [ ] **Step 4: Run the checkout tests**

Run: `node --test products/workbench/tests/git-checkout.test.mjs`

Expected: PASS, including wrong-commit, non-Git destination, dirty checkout,
and Git failure cases.

- [ ] **Step 5: Commit checkout lifecycle**

```bash
git add .gitignore products/workbench/scripts/lib/git-checkout.mjs products/workbench/tests/git-checkout.test.mjs
git commit -m "build(workbench): materialize exact Code-OSS checkout"
```

### Task 3: Digest-Pinned Patch Series

**Files:**
- Create: `products/workbench/patches/code-oss/series.json`
- Create: `products/workbench/scripts/lib/patch-series.mjs`
- Create: `products/workbench/tests/patch-series.test.mjs`

**Interfaces:**
- Consumes: `applyPatchSeries({ checkout, seriesPath, runGit }): Promise<{ applied: string[] }>`.
- Produces: ordered, idempotent `git apply --check`/`git apply` behavior with SHA-256 verification and no fuzz.

- [ ] **Step 1: Write failing patch-series tests**

```js
test("an empty initial patch series is a valid deliberate baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatero-patches-"));
  const seriesPath = join(directory, "series.json");
  await writeFile(seriesPath, '{"schemaVersion":1,"patches":[]}\n');
  const result = await applyPatchSeries({
    checkout: "/tmp/source",
    seriesPath,
    runGit: async () => assert.fail("empty series must not invoke Git")
  });
  assert.deepEqual(result, { applied: [] });
});

test("verifies digest and checks every patch before applying any patch", async () => {
  const { checkout, seriesPath } = await createTwoPatchFixture();
  const calls = [];
  await applyPatchSeries({ checkout, seriesPath, runGit: async args => calls.push(args) });
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [["apply", "--check"], ["apply", "--check"], ["apply", "--whitespace=error"], ["apply", "--whitespace=error"]]);
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `node --test products/workbench/tests/patch-series.test.mjs`

Expected: FAIL because `patch-series.mjs` does not exist.

- [ ] **Step 3: Implement strict patch application**

The initial committed series is intentionally empty:

```json
{ "schemaVersion": 1, "patches": [] }
```

For a non-empty series, require `{ "file": "0001-name.patch", "sha256":
"64 lowercase hex characters" }`. Reject absolute paths, `..`, duplicates,
missing files, digest mismatches, and dirty checkouts. Run `git apply --check`
for the complete ordered list before applying the first patch, then
`git apply --whitespace=error` in order. A failure leaves no claim of success.

- [ ] **Step 4: Run patch tests**

Run: `node --test products/workbench/tests/patch-series.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit patch discipline**

```bash
git add products/workbench/patches products/workbench/scripts/lib/patch-series.mjs products/workbench/tests/patch-series.test.mjs
git commit -m "build(workbench): enforce strict Code-OSS patch series"
```

### Task 4: Chatero Product Materialization

**Files:**
- Create: `products/workbench/product.chatero.json`
- Create: `products/workbench/scripts/lib/product-materializer.mjs`
- Create: `products/workbench/tests/product-materializer.test.mjs`

**Interfaces:**
- Consumes: `materializeProduct({ upstreamProductPath, overlayPath, outputPath, contract }): Promise<ProductResult>`.
- Produces: deterministic Chatero `product.json`, `{ outputPath, sha256 }`, preserving unoverridden MIT Code-OSS build fields.

- [ ] **Step 1: Write failing deterministic-product tests**

```js
test("brands Code-OSS as Chatero and selects Open VSX", async () => {
  const result = await materializeFixture();
  const product = JSON.parse(await readFile(result.outputPath, "utf8"));
  assert.equal(product.nameShort, "Chatero");
  assert.equal(product.applicationName, "chatero");
  assert.equal(product.darwinBundleIdentifier, "io.github.chancesiyuan.chatero");
  assert.equal(product.urlProtocol, "chatero");
  assert.equal(product.extensionsGallery.serviceUrl, "https://open-vsx.org/vscode/gallery");
  assert.deepEqual(product.builtInExtensions, []);
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `node --test products/workbench/tests/product-materializer.test.mjs`

Expected: FAIL because `product-materializer.mjs` does not exist.

- [ ] **Step 3: Add the product overlay and deterministic merge**

The overlay must set:

```json
{
  "nameShort": "Chatero",
  "nameLong": "Chatero Research Workbench",
  "applicationName": "chatero",
  "dataFolderName": ".chatero",
  "sharedDataFolderName": ".chatero-shared",
  "serverApplicationName": "chatero-server",
  "serverDataFolderName": ".chatero-server",
  "darwinBundleIdentifier": "io.github.chancesiyuan.chatero",
  "urlProtocol": "chatero",
  "reportIssueUrl": "https://github.com/ChanceSiyuan/chatero/issues/new",
  "licenseName": "MIT",
  "builtInExtensions": []
}
```

`materializeProduct()` reads upstream and overlay JSON, replaces only explicit
overlay fields, derives `extensionsGallery` solely from the verified contract,
writes sorted, two-space JSON plus a final newline through a sibling temporary
file and atomic rename, and returns the output SHA-256.

- [ ] **Step 4: Run product tests**

Run: `node --test products/workbench/tests/product-materializer.test.mjs`

Expected: PASS, including stable digest, invalid upstream JSON, and no partial
output after a failed write.

- [ ] **Step 5: Commit product materialization**

```bash
git add products/workbench/product.chatero.json products/workbench/scripts/lib/product-materializer.mjs products/workbench/tests/product-materializer.test.mjs
git commit -m "feat(workbench): materialize Chatero product identity"
```

### Task 5: Marketplace and Bundle Policy Gate

**Files:**
- Create: `products/workbench/scripts/lib/workbench-policy.mjs`
- Create: `products/workbench/tests/workbench-policy.test.mjs`

**Interfaces:**
- Consumes: `verifyWorkbenchPolicy({ root, productPath }): Promise<PolicyReport>`.
- Produces: `{ ok, scannedFiles, violations: PolicyViolation[] }`; throws only for I/O or invalid configuration, not for policy findings.

- [ ] **Step 1: Write failing policy tests**

```js
test("rejects Microsoft Marketplace endpoints and restricted extension ids", async () => {
  const { root, productPath } = await createPolicyFixture({
    serviceUrl: "https://marketplace.visualstudio.com/_apis/public/gallery",
    extensionId: "ms-python.vscode-pylance"
  });
  const report = await verifyWorkbenchPolicy({ root, productPath });
  assert.equal(report.ok, false);
  assert.deepEqual(report.violations.map(v => v.rule).sort(), ["forbidden-extension", "forbidden-host"]);
});

test("accepts Chatero identity and Open VSX endpoints", async () => {
  const { root, productPath } = await createPolicyFixture({
    serviceUrl: "https://open-vsx.org/vscode/gallery",
    extensionId: "chatero.research-loop"
  });
  const report = await verifyWorkbenchPolicy({ root, productPath });
  assert.deepEqual(report, { ok: true, scannedFiles: report.scannedFiles, violations: [] });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `node --test products/workbench/tests/workbench-policy.test.mjs`

Expected: FAIL because `workbench-policy.mjs` does not exist.

- [ ] **Step 3: Implement bounded policy scanning**

Scan JSON, JS, MJS, CJS, TS, and shell files beneath the product overlay,
patches, and generated product configuration. Reject hostnames
`marketplace.visualstudio.com` and `*.gallerycdn.vsassets.io`, product gallery
URLs outside `open-vsx.org`, and extension ids `ms-python.vscode-pylance` and
`ms-vscode-remote.remote-ssh`. Report rule, relative path, line, and a redacted
excerpt. Do not scan ignored upstream source or user workspaces.

- [ ] **Step 4: Run policy tests**

Run: `node --test products/workbench/tests/workbench-policy.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the policy gate**

```bash
git add products/workbench/scripts/lib/workbench-policy.mjs products/workbench/tests/workbench-policy.test.mjs
git commit -m "test(workbench): reject restricted marketplace dependencies"
```

### Task 6: Transactional Bootstrap Pipeline

**Files:**
- Create: `products/workbench/scripts/bootstrap-code-oss.mjs`
- Create: `products/workbench/scripts/verify-code-oss.mjs`
- Create: `products/workbench/tests/bootstrap-code-oss.integration.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: repository root, optional `CHATERO_CODE_OSS_DIR`, and flags `--checkout-only`, `--verify`, `--json`.
- Produces: a verified Code-OSS checkout with Chatero `product.json` and `.chatero-provenance.json`; stable root commands `workbench:bootstrap`, `workbench:verify`, and `test:workbench-bootstrap`.

- [ ] **Step 1: Write a failing integration test using a local fixture Git repository**

```js
test("bootstrap materializes one verified checkout without network access", async t => {
  const fixture = await createFixtureCodeOssRepo(t);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "chatero-bootstrap-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const destination = join(temporaryRoot, "vendor", "code-oss");
  const result = await bootstrap({ contractPath: fixture.contract, destination });
  assert.equal(result.commit, fixture.commit);
  assert.equal(JSON.parse(await readFile(join(destination, "product.json"))).nameShort, "Chatero");
  assert.equal(JSON.parse(await readFile(join(destination, ".chatero-provenance.json"))).productSha256, result.productSha256);
});
```

- [ ] **Step 2: Run the integration test and confirm failure**

Run: `node --test products/workbench/tests/bootstrap-code-oss.integration.test.mjs`

Expected: FAIL because the bootstrap entry point does not exist.

- [ ] **Step 3: Implement the composed bootstrap and independent verifier**

`bootstrap-code-oss.mjs` must call the Task 1–5 interfaces in order, emit named
stages, and write provenance only after every stage passes:

```json
{
  "schemaVersion": 1,
  "codeOssCommit": "df53daabb18cd157bdb08c7f01c34df936cf12f4",
  "codeOssVersion": "1.132.0",
  "node": "24.18.0",
  "electron": "42.7.1",
  "patches": [],
  "productSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The digest shown above illustrates the field shape; the implementation writes
the actual SHA-256 returned by `materializeProduct()`.

If an existing destination already contains provenance, bootstrap first runs
the read-only verifier. A valid generated checkout is returned unchanged. An
invalid or stale generated checkout fails with its exact mismatch and never
resets or overwrites it; the recovery message points to a new destination or to
manual removal of this ignored, reproducible checkout. A checkout without
provenance is accepted only when it is pristine at the pinned commit.

On failure, remove only a temporary provenance file created by the current run;
never delete or reset the checkout. `verify-code-oss.mjs` verifies HEAD,
cleanliness excluding the generated product/provenance allowlist, product
digest, patch list, runtime pins, and policy report without fetching or writing.

Add these scripts to root `package.json`:

```json
{
  "workbench:bootstrap": "node products/workbench/scripts/bootstrap-code-oss.mjs",
  "workbench:verify": "node products/workbench/scripts/verify-code-oss.mjs",
  "test:workbench-bootstrap": "node --test products/workbench/tests/*.test.mjs"
}
```

- [ ] **Step 4: Run the bootstrap suite**

Run: `npm run test:workbench-bootstrap`

Expected: PASS with no network access and no writes outside test temporary
directories.

- [ ] **Step 5: Commit the bootstrap pipeline**

```bash
git add package.json products/workbench/scripts/bootstrap-code-oss.mjs products/workbench/scripts/verify-code-oss.mjs products/workbench/tests/bootstrap-code-oss.integration.test.mjs
git commit -m "build(workbench): add transactional Code-OSS bootstrap"
```

### Task 7: Development Build and Runtime Preflight

**Files:**
- Create: `products/workbench/scripts/run-code-oss.mjs`
- Create: `products/workbench/tests/run-code-oss.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `preflightRuntime({ checkout, processVersions, run }): Promise<RuntimeReport>` and CLI flags `--install`, `--compile`, `--launch`.
- Produces: explicit runtime diagnostics and fixed argv invocations for Code-OSS install, compile, and Electron launch.

- [ ] **Step 1: Write failing preflight/argv tests**

```js
test("refuses the wrong Node version before dependency installation", async () => {
  await assert.rejects(preflightRuntime({ checkout, processVersions: { node: "22.0.0" } }), /requires Node 24\.18\.0/);
});

test("build steps use fixed commands and the verified checkout cwd", async () => {
  const calls = [];
  await runDevelopment({ checkout, install: true, compile: true, launch: false, run: async call => calls.push(call) });
  assert.deepEqual(calls, [
    { file: "npm", args: ["install"], cwd: checkout },
    { file: "npm", args: ["run", "compile"], cwd: checkout }
  ]);
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `node --test products/workbench/tests/run-code-oss.test.mjs`

Expected: FAIL because `run-code-oss.mjs` does not exist.

- [ ] **Step 3: Implement explicit install/compile/launch stages**

Require exact Node `24.18.0`, macOS for the first developer application, verified
provenance, at least 20 GiB free at the checkout, and `xcrun` availability
before native dependency installation. Run child processes with `execFile` or
`spawn`, fixed argument arrays, the canonical checkout as `cwd`, inherited
stdio, and signal forwarding. Launch only after `out/main.js` exists. Do not
install, compile, or launch unless its corresponding flag is supplied.

Add root commands:

```json
{
  "workbench:install": "node products/workbench/scripts/run-code-oss.mjs --install",
  "workbench:compile": "node products/workbench/scripts/run-code-oss.mjs --compile",
  "workbench:dev": "node products/workbench/scripts/run-code-oss.mjs --launch"
}
```

- [ ] **Step 4: Run the preflight suite and static verification**

Run: `node --test products/workbench/tests/run-code-oss.test.mjs && npm run workbench:verify`

Expected: PASS against a bootstrapped checkout; if the real checkout has not
been materialized yet, the standalone verifier must report the exact bootstrap
command and exit nonzero without modifying the filesystem.

- [ ] **Step 5: Commit development runner**

```bash
git add package.json products/workbench/scripts/run-code-oss.mjs products/workbench/tests/run-code-oss.test.mjs
git commit -m "build(workbench): add verified development runner"
```

### Task 8: Developer Contract and Full Bootstrap Gate

**Files:**
- Create: `products/workbench/README.md`
- Modify: `AGENTS.md`
- Modify: `docs/chatero/implementation-plan.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: Tasks 1–7 commands.
- Produces: one documented path from clone to verified development shell and one root `verify:workbench-bootstrap` gate.

- [ ] **Step 1: Add a failing documentation/command contract test**

Extend `products/workbench/tests/bootstrap-code-oss.integration.test.mjs`:

```js
test("root scripts expose the documented bootstrap gate", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url)));
  assert.equal(pkg.scripts["verify:workbench-bootstrap"], "npm run test:workbench-bootstrap && npm run workbench:verify");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  for (const command of ["workbench:bootstrap", "workbench:verify", "workbench:install", "workbench:compile", "workbench:dev"]) {
    assert.match(readme, new RegExp(`npm run ${command.replace(":", "\\:")}`));
  }
});
```

- [ ] **Step 2: Run the contract test and confirm failure**

Run: `node --test products/workbench/tests/bootstrap-code-oss.integration.test.mjs`

Expected: FAIL because the README and root gate do not exist.

- [ ] **Step 3: Document bootstrap, ownership, and upstream updates**

Document the exact five-command flow, disk/runtime prerequisites, generated
paths, offline verifier behavior, common recovery messages, strict patch
workflow, Code-OSS/Zotero upstream ownership, Open VSX policy, and the rule that
personal profiles and workspaces are never test inputs. Update `AGENTS.md` so
future changes treat the root as a transitioning dual-upstream product, and
mark the reproducible bootstrap as the active implementation phase.

Add:

```json
{
  "verify:workbench-bootstrap": "npm run test:workbench-bootstrap && npm run workbench:verify"
}
```

- [ ] **Step 4: Run all new tests and existing Chatero tests**

Run: `npm run test:workbench-bootstrap && npm run test:chatero && git diff --check`

Expected: all tests pass and `git diff --check` prints nothing.

- [ ] **Step 5: Materialize and verify the real pinned checkout**

Run: `npm run workbench:bootstrap && npm run workbench:verify`

Expected: the first command creates ignored `vendor/code-oss` at
`df53daabb18cd157bdb08c7f01c34df936cf12f4`, materializes Chatero product
identity, and records provenance; the second performs no writes and passes.

- [ ] **Step 6: Commit the developer contract**

```bash
git add AGENTS.md package.json products/workbench/README.md docs/chatero/implementation-plan.md products/workbench/tests/bootstrap-code-oss.integration.test.mjs
git commit -m "docs(workbench): define reproducible bootstrap workflow"
```

## Completion Gate

The phase is complete only when:

- every `products/workbench/tests/*.test.mjs` test passes;
- the existing Chatero Node suite passes;
- a real ignored checkout is pinned to the recorded Code-OSS commit and passes
  standalone verification;
- generated `product.json` identifies Chatero and only Open VSX;
- no Microsoft Marketplace host, Pylance id, or Microsoft Remote-SSH id appears
  in committed workbench product configuration;
- no generated checkout, dependency, app, user profile, or workspace content is
  staged by Git;
- a development build preflight either succeeds or reports one exact missing
  prerequisite without mutating the checkout.

The next independent plan begins with the generated Zotero Core RPC schema,
authenticated Unix-domain transport, profile lock, supervisor, and a fixture
Core. It may consume only the verified workbench bootstrap and the process/data
ownership rules from the approved design.
