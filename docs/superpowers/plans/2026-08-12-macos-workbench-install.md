# macOS Workbench Installation Recovery Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make commit `20a23e85d` reproducibly test, compile, launch, package, and install the Code-OSS Chatero Workbench on Apple Silicon macOS without touching a personal Zotero profile or research workspace.

**Architecture:** Keep the repository as the authority and Code-OSS as a generated, ignored checkout. Preserve strict real-path checks in production; canonicalize only the Node test environment. Express Code-OSS source corrections as a new digest-pinned patch, and permit only the one upstream tracked file that compilation deterministically regenerates when verifying a built checkout.

**Tech Stack:** Node.js 24.18.0, Electron 42.7.1, Code-OSS 1.132.0, Node test runner, Git patch series, macOS codesign/Gulp packaging.

## Global Constraints

- Do not read, copy, migrate, or overwrite a personal Zotero profile, Knowledge, Drafts, Literature, chat history, credentials, or research output.
- Use Open VSX; do not introduce Microsoft Marketplace, Pylance, Microsoft Remote-SSH, Copilot services, or Microsoft branding.
- Preserve strict no-symlink/no-alias checks for production workspace and Remote Agent roots.
- Build and launch only from digest-pinned Code-OSS commit `df53daabb18cd157bdb08c7f01c34df936cf12f4`.
- Use Node `24.18.0` and Electron `42.7.1` exactly.

---

### Task 1: Canonical macOS Test Roots

**Files:**
- Create: `products/workbench/scripts/run-node-tests.mjs`
- Create: `products/workbench/tests/run-node-tests.test.mjs`
- Modify: `package.json`
- Modify: `products/workbench/tests/documentation-remote-transaction.test.mjs`

- [ ] Write a failing test proving the test runner resolves the macOS `/var` firmlink before spawning `node --test`.
- [ ] Run the focused test and confirm the current implementation is absent.
- [ ] Implement the minimal cross-platform canonical test runner and route Workbench test scripts through it.
- [ ] Split the combined symbolic-link/case-alias fixture so each fail-closed behavior is observed independently.
- [ ] Run Documentation and Remote Agent suites with the default environment and require zero failures.

### Task 2: Codex Named-Permissions Patch Completion

**Files:**
- Create: `products/workbench/patches/code-oss/0005-fix-chatero-codex-permission-tests.patch`
- Modify: `products/workbench/patches/code-oss/series.json`
- Modify: `products/workbench/tests/documentation-agent-authority.test.mjs`

- [ ] Write a failing repository test requiring patch 5 to migrate upstream fixtures from `sandboxPolicy` assertions to Chatero named `permissions` assertions.
- [ ] Apply the minimal test-only Code-OSS patch and pin its SHA-256.
- [ ] Bootstrap a fresh generated checkout and compile it, requiring zero TypeScript errors.

### Task 3: Built-Checkout Provenance

**Files:**
- Modify: `products/workbench/tests/bootstrap-code-oss.integration.test.mjs`
- Modify: `products/workbench/scripts/verify-code-oss.mjs`

- [ ] Write a failing test proving verification accepts only the deterministic generated `src/vs/platform/extensions/common/extensionsApiProposals.ts` delta after compilation while rejecting any other new managed source path.
- [ ] Exclude that exact path from status and diff comparison without weakening product, first-party extension, patch-pin, policy, or commit verification.
- [ ] Verify bootstrap before build and launch preflight after build both pass.

### Task 4: Full Verification and Local Installation

**Files:**
- Modify only if required: `package.json`, `products/workbench/scripts/*`, and their focused tests.

- [ ] Run `npm ci`, the complete Chatero Node test gate, Core protocol checks, bootstrap, verify, install, and compile.
- [ ] Launch with an isolated user-data directory and extensions directory; confirm the Electron process remains alive and the workbench log has no fatal startup error.
- [ ] Build the Apple Silicon Code-OSS Chatero application bundle, ad-hoc sign it, verify its bundle identifier and signature, and install it as `/Applications/Chatero.app` without opening a personal profile during verification.
- [ ] Re-run non-interactive SSH connectivity and report any GUI-only Remote Agent validation that remains for the user.
