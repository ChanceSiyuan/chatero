# Chatero Agent Instructions

Chatero is transitioning from a Zotero UI fork to one Code-OSS/Electron
research workbench backed by a headless Zotero Core. Preserve Zotero's complete
library, sync, citation, note, Reader, translator, attachment, and profile
behavior while moving every first-party visible surface into the workbench.

## Remotes

- `origin`: `git@github.com:ChanceSiyuan/chatero.git`
- `upstream`: `https://github.com/zotero/zotero.git`

Code-OSS is a second managed upstream pinned by
`products/workbench/upstreams.json`. Its generated checkout lives under the
ignored `vendor/code-oss/`; do not commit copied upstream source or generated
application bundles.

Merge upstream through a dedicated branch and keep Chatero changes in small,
test-first commits. Never rewrite upstream history.

## Architecture ownership

- Code-OSS/Electron owns visible windows, editor groups, Monaco, terminals,
  source control, debugging, notebooks, settings, commands, and extensions.
- Headless Zotero Core is the exclusive owner of the profile database, sync,
  translators, attachments, full text, notes, and annotation truth.
- Electron renderers and extensions must never open or write `zotero.sqlite`.
- The workspace file service owns local or remote repository bytes.
- The Agent owns neither repository nor Zotero truth; it proposes reviewable,
  authority-scoped transactions.
- The current Gecko UI is a development-only parity oracle until the atomic
  Electron cutover gate passes.

Use Open VSX. Do not add Microsoft Marketplace endpoints, Pylance, Microsoft
Remote-SSH binaries, or Microsoft product branding. Prefer Chatero built-ins
and standard Code-OSS extension points; keep the Code-OSS core patch queue
small, ordered, digest-pinned, and fuzz-free.

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

For the workbench bootstrap:

```bash
npm run test:workbench-bootstrap
npm run workbench:verify
```

Install, compile, and launch require the exact Node/Electron pins recorded in
`products/workbench/upstreams.json`. Bootstrap and verification must never use
a personal profile or personal workspace as a fixture.

## Phase status

- Legacy Phase 1 is frozen: `docs/chatero/phase-1-freeze.md`
- Approved product design:
  `docs/superpowers/specs/2026-08-11-code-oss-zotero-workbench-design.md`
- Active implementation plan:
  `docs/superpowers/plans/2026-08-11-code-oss-workbench-bootstrap.md`
- Historical native-XUL plan: `docs/chatero/implementation-plan.md`
- XPI behavior reference: `docs/chatero/parity-checklist.md`
