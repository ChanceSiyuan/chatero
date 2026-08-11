# Remote Zotero–Codex Bridge Handoff

This checkpoint exists so development can move to another machine without
losing either in-progress worktree. It is intentionally not a completion
claim.

## Branches to fetch

- `feat/remote-zotero-codex`
  - Task 4 completion commit: `fb13f31f9`
  - Task 3 completion commit: `6ab1ff06f`
  - The earlier interrupted checkpoint remains `0eadc81e8` for audit history.
  - Contains the approved design/plan, signed dual-architecture Remote Agent
    contract, hardened system-OpenSSH resolver/installer, and the reviewed
    Task 3 workspace/process implementation.
- `feat/remote-zotero-rehydrate`
  - Reviewed completion head: `d8e7bc87f`
  - The original isolated checkpoint remains `0140cce14` for audit history.
  - Both commits have been cherry-picked onto `feat/remote-zotero-codex` as
    `910a660b9` and `10bf38188`.

Do not merge either branch into `main` merely because it is present remotely.
Finish the gates and reviews below first.

## Completed and reviewed

- Signed Remote Agent release contract:
  - `69dc4dd56 feat(workbench): define signed remote agent releases`
  - `fa3bff29b fix(workbench): harden remote agent release inputs`
- System OpenSSH resolver and signed installer:
  - `3bac31373 feat(workbench): resolve signed SSH workspaces`
  - `964027fcc fix(workbench): harden remote reconnect and install`
- Task 1+2/policy verification: 52/52 tests passed.
- Independent re-review reported no remaining Critical/Important findings for
  Task 2.
- Arbitrary/empty remote workspace UX and the trust-gated framed process API:
  - `6ab1ff06f feat(workbench): open arbitrary remote workspaces`
  - Task 1-3, first-party extension, and policy regression: 76/76 tests passed.
  - Independent final review reported no remaining Critical/Important
    findings for Task 3.
- Exact local Zotero PDF/Note tab rehydration across remote reloads:
  - isolated completion: `d8e7bc87f fix(workbench): restore local Zotero tabs after remote reload`
  - integrated completion: `10bf38188 fix(workbench): restore local Zotero tabs after remote reload`
  - Core plus rehydration: 67/67 tests passed; integrated full workbench Node
    regression: 137/137 tests passed.
  - Independent final review reported no remaining Critical/Important
    findings for Task 3B.
- Native remote Code-OSS Agent Host and OpenAI Codex runtime:
  - `fb13f31f9 feat(workbench): run native Codex on remote workspaces`
  - Task 4 plus remote focused regression: 66/66 tests passed; full
    workbench Node regression: 157/157 tests passed.
  - A fresh pinned Code-OSS materialization passed provenance/policy
    verification, exact Node 24 TypeScript compilation, and the OpenAI account
    policy test. Independent final review reported no remaining
    Critical/Important findings for Task 4.

## Task 3 completed state

Completion: `6ab1ff06f feat(workbench): open arbitrary remote workspaces`

Implemented and reviewed:

- Connect to SSH, Open Remote Folder, Reconnect, Remote indicator menus,
  status/error UX, and allowlisted recent-target global state;
- arbitrary/omitted remote `cwd` handling from the remote workspace URI
  `.path`, canonical containment, and the workspace trust gate;
- fixed product-owned workspace probe/create/realpath helper and strict framed
  remote process client;
- bounded public extension API with no raw process bridge escape hatch;
- single-owner cancellation that returns `AbortError`/`ABORT_ERR` and removes
  listeners; and
- SIGHUP/SIGINT/SIGTERM two-phase process-group cleanup, including stubborn
  descendants and the leader-exits-first race.

Verification command:

```bash
node --test \
  products/workbench/tests/remote-agent-release.test.mjs \
  products/workbench/tests/chatero-remote-transport.test.mjs \
  products/workbench/tests/chatero-remote-manifest.test.mjs \
  products/workbench/tests/chatero-remote-workspace.test.mjs \
  products/workbench/tests/chatero-remote-process.test.mjs \
  products/workbench/tests/first-party-extensions.test.mjs \
  products/workbench/tests/workbench-policy.test.mjs
```

Result: 76/76 passed. The review's two non-blocking Minor follow-ups are to
bound/dispose authenticated candidate sessions that never become active and to
align the OpenSSH alias length check with the opaque authority length check.
Neither bypasses the trust, authority, or data boundaries.

Next action: implement and review Task 5's selectable PDF.js evidence and
explicit native Chat context.

## Task 3B completed and integrated state

Isolated commits:

- `0140cce14 wip(workbench): checkpoint Zotero tab rehydration`
- `d8e7bc87f fix(workbench): restore local Zotero tabs after remote reload`

Integrated commits:

- `910a660b9 wip(workbench): checkpoint Zotero tab rehydration`
- `10bf38188 fix(workbench): restore local Zotero tabs after remote reload`

Implemented and reviewed:

- exact `library.attachment` and Note lookup by `(libraryId, key)`, with
  missing/deleted/trashed/mismatched identities reported unavailable;
- strict opaque evidence URIs with no local PDF path, authority, query, or
  fragment, and no evidence persistence in global/workspace state or history;
- single-flight Core startup plus fenced pending/ready/concurrent stop,
  deactivate, crash, restart, and profile-lease cleanup;
- evidence registry epoch reset on every Core-session loss and safe reopen with
  a fresh trusted record of the same canonical identity;
- machine-scoped, global-only Core launch configuration and local-file-only
  profile/executable pickers, so an SSH workspace cannot choose local paths or
  executables; and
- local UI-extension PDF opening remains a local `file:` resource after an SSH
  workspace reload.

Verification:

```bash
npm run core:check
node --test services/zotero-core/tests/*.test.mjs \
  products/workbench/tests/zotero-evidence-editors.test.mjs
npm run test:workbench-bootstrap
```

Integrated results: protocol check passed, Core plus rehydration 67/67 passed,
and the full workbench Node suite 137/137 passed. Task 4 subsequently produced
and verified a fresh pinned Code-OSS materialization with exact Node `24.18.0`.
A real Code-OSS/Zotero GUI reload remains an explicit later integration gate.

## Task 4 completed state

Completion: `fb13f31f9 feat(workbench): run native Codex on remote workspaces`

Implemented and reviewed:

- the built-in Code-OSS Agent Host remains the only remote chat runtime and
  uses the existing remote `agentHostProxy` wiring;
- Codex defaults and falls back only to OpenAI, never requires Copilot sign-in,
  does not advertise or accept a Copilot token in OpenAI mode, and exposes a
  fixed remote `codex login --device-auth` terminal flow using only the signed
  bundled binary;
- parent, login-shell, fixed Agent Host, and embedded SDK environments merge in
  the required order, while `AGENT_SDK_RESULTS_FILE` is removed before the
  Code-OSS build so no CDN fallback can enter the product;
- `chatero.chat.attachTextContext` and its bounded remove action use native
  Chat attachments without auto-send or a second history/runtime, including
  the Code-OSS 1.132 generic-string-to-`Simple` Agent Host fix;
- both Linux tuples embed exactly `@openai/codex` 0.142.0 plus their matching
  native package and bundled ripgrep, with no other provider/package allowed;
  and
- provenance, exact payload/ELF/executable checks, intermediate-symlink and
  hardlink rejection, product `agentSdks` policy, and complete Code-OSS,
  OpenAI Codex, and ripgrep licenses/notices all run before manifest signing.

Verification:

```bash
node --test \
  products/workbench/tests/remote-agent-release.test.mjs \
  products/workbench/tests/remote-agent-runtime.test.mjs \
  products/workbench/tests/chatero-remote-manifest.test.mjs \
  products/workbench/tests/chatero-remote-transport.test.mjs \
  products/workbench/tests/patch-series.test.mjs \
  products/workbench/tests/upstream-copilot-quarantine.test.mjs
npm run test:workbench-bootstrap
CHATERO_CODE_OSS_DIR=<fresh-materialization> npm run workbench:verify
```

Results: focused 66/66 and full workbench 157/157 passed. Patch 0003 applied
without fuzz to the exact `df53daabb18cd157bdb08c7f01c34df936cf12f4`
checkout; exact Node `24.18.0` full-source TypeScript compilation passed, and
the upstream OpenAI account policy test passed 5/5. Both SDK tarballs were
created from the pinned lock; x64 reported `codex-cli 0.142.0` and ripgrep
15.1.0 on the native host, while both x64 and arm64 binaries passed their ELF
architecture checks. Arm64 `codex --version` remains assigned to Task 7's
native arm64 CI runner.

A local full x64 REH build reached and completed exact SDK packaging, then
stopped before archive creation because the isolated checkout intentionally
had only root/build `npm ci --ignore-scripts` dependencies and therefore lacked
nested built-in-extension packages needed by the upstream gulp compile. Task 7
will install the complete pinned dependency graph on clean Linux runners and
exercise both release jobs. No generated Remote Agent archive or signing
private key was added to the repository.

## Audits already incorporated into the plan

- Native remote Codex must use Code-OSS Agent Host, OpenAI-only policy, inherited
  launch environment, the exact Linux Codex SDK, and complete Code-OSS/Codex/
  ripgrep notices. Do not add a custom chat agent.
- Explicit PDF Add Context uses
  `vscode.chat.registerChatAttachContextProvider`; do not use the implicit tab
  provider. Code-OSS's generic-string-to-Agent-Host conversion bug must be
  patched and tested. The real proposal allowlist ID is
  `chatero.chatero-zotero`.
- Full-PDF transfer must use a 256-bit, 60-second, one-use, target-bound grant
  backed by an already-open Zotero file source. `chatero.remote` must reject
  local paths and generic file sources. Remote cache lifetime is exactly 24
  hours with prefix-verified resume and target-bound revoke.

The canonical requirements remain in:

- `docs/superpowers/specs/2026-08-11-remote-zotero-codex-bridge-design.md`
- `docs/superpowers/plans/2026-08-11-remote-zotero-codex-bridge.md`

## Resume on another machine

```bash
git clone git@github.com:ChanceSiyuan/chatero.git
cd chatero
git fetch origin
git switch --track origin/feat/remote-zotero-codex

# Inspect the isolated Zotero rehydration line when needed:
git switch -c feat/remote-zotero-rehydrate \
  --track origin/feat/remote-zotero-rehydrate
```

If the local clone already exists, fetch and use `git switch` plus
`git pull --ff-only` for the corresponding branch.

No personal Knowledge, Drafts, Literature, Zotero profile, chat history,
credentials, generated Remote Agent archive, or signing private key is part of
either checkpoint.
