# Remote Zotero–Codex Bridge Handoff

This checkpoint exists so development can move to another machine without
losing either in-progress worktree. It is intentionally not a completion
claim.

## Branches to fetch

- `feat/remote-zotero-codex`
  - Task 3 WIP commit: `0eadc81e8` (followed by this handoff document)
  - Contains the approved design/plan, signed dual-architecture Remote Agent
    contract, hardened system-OpenSSH resolver/installer, and the interrupted
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

## Task 3 interrupted state

Checkpoint: `0eadc81e8 wip(workbench): checkpoint remote workspace UX`

Implemented so far:

- strict framed remote process client;
- arbitrary/omitted remote `cwd` handling and containment checks;
- workspace trust gate for arbitrary processes;
- fixed product-owned workspace probe/create/realpath helper;
- SIGHUP/SIGINT/SIGTERM child-process-group cleanup;
- tests for frame failures, cancellation, stale generations, hostile argv,
  empty folder confirmation, and a real detached-child SIGHUP case.

The checkpoint test run had 28 passing and 4 failing tests. The failures are
expected consequences of interruption, not regressions in the completed
Task 1/2 code:

- `formatRemoteStatus` is tested but not yet exported/implemented;
- Connect/Open Folder/Reconnect commands are tested but not yet wired into
  `extension.cjs` and `package.json`;
- `remote-process.mjs` and `remote-workspace.mjs` are not yet listed in
  `first-party-extensions.json`.

Next action: finish that wiring, status bar/global-state behavior, rerun the
Task 3 focused suite plus Task 1/2 regressions, then replace the WIP checkpoint
with a reviewed Task 3 completion commit.

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
