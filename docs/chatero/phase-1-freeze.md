# Chatero Phase 1 — Frozen Baseline

- **Status:** Frozen
- **Date:** 2026-08-07
- **Scope:** Independent branded Zotero host only (no QLab UI)

## Freeze statement

Phase 1 is accepted and frozen. Product identity, profile isolation, URL scheme,
local-server fallback, and personal DMG packaging are the baseline for all later
work. New research features land in Phase 2+ only.

Do not reopen Phase 1 for QLab tabs, split groups, Codex, QMD, Knowledge Site,
or workspace binding.

## Acceptance checklist

Reuse [phase-1-review.md](./phase-1-review.md). Summary:

1. `Chatero.app` installs beside official Zotero without sharing profile/DB.
2. Data root is under `~/Library/Application Support/Chatero/`.
3. Zotero Sync, Reader, Notes, plugins, and Connector remain usable.
4. Preferred local API port is `23119` with fallback `23129`.
5. Public scheme is `chatero://`; Mozilla app ID stays `zotero@zotero.org`.
6. `npm run test:chatero` passes for product/build invariants.

## Guardrails carried forward

- Mozilla application ID must remain `zotero@zotero.org`.
- Personal Knowledge / Drafts / Literature / chat history never enter this repo.
- A QLab failure must never prevent Zotero core from starting
  (see repository `AGENTS.md`).

## Next phases

| Phase | Goal |
|---|---|
| 2 | Generic two-group tabs + PDF\|Chat / PDF\|Editor arrangement |
| 3 | Built-in QLab vertical slices A→D (workspace → chat → QMD → actions) |
| 4 | Promotion / literature / SSH + release-candidate DMG |

Parity details: [parity-checklist.md](./parity-checklist.md).
Implementation plan: [implementation-plan.md](./implementation-plan.md).
