# Remote Zotero–Codex Bridge Handoff

This checkpoint exists so development can move to another machine without
losing either in-progress worktree. It is intentionally not a completion
claim.

## Branches to fetch

- `feat/remote-zotero-codex`
  - Task 3 completion commit: `6ab1ff06f`
  - The earlier interrupted checkpoint remains `0eadc81e8` for audit history.
  - Contains the approved design/plan, signed dual-architecture Remote Agent
    contract, hardened system-OpenSSH resolver/installer, and the reviewed
    Task 3 workspace/process implementation.
- `feat/remote-zotero-rehydrate`
  - Checkpoint head: `0140cce14`
  - Contains the isolated Task 3B Zotero PDF/Note tab rehydration work.

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

Next action: finish and review the isolated Task 3B line, then cherry-pick its
formal completion onto `feat/remote-zotero-codex`.

## Task 3B isolated state

Checkpoint: `0140cce14 wip(workbench): checkpoint Zotero tab rehydration`

Focused verification passed 26/26 tests. The branch adds exact
`library.attachment` lookup, generated protocol updates, strict opaque evidence
URI parsing, single-flight Core startup, and exact PDF/Note rehydration without
persisting a local attachment path. It still needs the full Core/workbench
suite and an independent review. After that, cherry-pick it onto
`feat/remote-zotero-codex`.

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
