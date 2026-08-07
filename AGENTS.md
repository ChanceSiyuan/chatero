# Chatero Agent Instructions

Chatero is a thin fork of `zotero/zotero`. Preserve Zotero's complete library,
sync, citation, note, Reader, and plugin behavior.

## Remotes

- `origin`: `git@github.com:ChanceSiyuan/chatero.git`
- `upstream`: `https://github.com/zotero/zotero.git`

Merge upstream through a dedicated branch and keep Chatero changes in small,
test-first commits. Never rewrite upstream history.

## Product identity

- Display name: Chatero
- Bundle ID: `io.github.chancesiyuan.chatero`
- Mozilla application ID: `zotero@zotero.org` (must remain unchanged)
- Public URL scheme: `chatero://`
- Profile/data root: `~/Library/Application Support/Chatero`

## QMD write authority

Two separate paths reach a Draft, and neither may bypass the other:

- **Human edits** (Apply from Chat or the Reader, Preview block edits, Source
  typing) land in the shell buffer and still go through `QmdDraftIO.writeSource`
  revision checks. `Zotero.QLab.insertIntoQmd` is UI-triggered only and must
  never be exposed as an agent tool.
- **Agent edits** go to a private working copy under
  `work/qlab-zotero/draft-changes/`. `QmdDraftIO.keepChange` remains the only
  promotion into `drafts/`.

## Personal data

The Chatero source repository must never contain personal Zotero profiles,
Knowledge, Drafts, Literature, chat history, credentials, or research output.
QLab workspaces are external user-selected directories.

## Verification

Use the upstream Zotero harness for core behavior and the Chatero Node tests
for product/build invariants. A QLab failure must never prevent Zotero core
from starting.

## Phase status

- Phase 1 is frozen: `docs/chatero/phase-1-freeze.md`
- Active plan: `docs/chatero/implementation-plan.md`
- XPI parity checklist: `docs/chatero/parity-checklist.md`
