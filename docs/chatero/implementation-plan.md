# Chatero Native-XUL Implementation Plan (Historical)

- **Date:** 2026-08-07
- **Status:** Superseded on 2026-08-11 by the Code-OSS/Electron workbench design
- **Baseline:** Phase 1 frozen ([phase-1-freeze.md](./phase-1-freeze.md))
- **Parity:** [parity-checklist.md](./parity-checklist.md)

## Goal

> This document remains the behavioral record for the current Gecko/XUL
> implementation and parity oracle. New product implementation follows
> [`../superpowers/specs/2026-08-11-code-oss-zotero-workbench-design.md`](../superpowers/specs/2026-08-11-code-oss-zotero-workbench-design.md)
> and
> [`../superpowers/plans/2026-08-11-code-oss-workbench-bootstrap.md`](../superpowers/plans/2026-08-11-code-oss-workbench-bootstrap.md).

Ship Chatero as a Cursor-like research OS on a complete Zotero core:

read papers → ask/agent → write QMD reading notes → review → promote knowledge.

The frozen QLab XPI in `quarto-lab/integrations/zotero` is the behavioral
baseline. New product work happens only in this repository.

## Phase 2 — Native tab groups + arrangement

**Acceptance:** Library / Reader / Note / shell Chat / shell QMD can occupy one
or two side-by-side groups; PDF\|Chat and PDF\|Editor commands are idempotent;
session restore keeps group membership; Reader content is not reloaded when its
group placement changes.

Deliverables:

1. Pure `Zotero.QLab.TabGroups` state model with Node tests.
2. Shell tab types `qlab-chat` and `qlab-qmd` (empty hosts OK).
3. Split host that shows left active + right active without reparenting Reader.
   **Done:** `#tabs-deck` is a class-driven dual host (`is-split`, splitter handle).
4. Arrangement commands Button A / Button C (Tools menu; Reader toolbar later).

## Phase 3 — Vertical slices A→D

Ship a daily path without the XPI:

| Slice | User-visible result |
|---|---|
| A | Select/initialize QLab workspace; path sandbox enforced |
| B | Chat shell → AgentRuntime → `codex exec --json` (app-server later) |
| C | QMD Draft host with Keep semantics scaffolding |
| D | Research Actions → repository `skills/` prompts |

Order: A → B → C → D. Do not wait for E–G.

## Phase 4 — Close the loop + RC

| Slice | Scope |
|---|---|
| E | Note ↔ QMD bridge |
| F | Knowledge preview / promotion / `knowledge-check` |
| G | Literature import, Main Site, Terminal; **remote execution optional** |

SSH is not required for RC. Remote work uses the `remote-execution`
AgentProvider slot when needed. Daily path providers: `codex-cli`,
`openai-compat`, `prove-harness`.

Then macOS smoke RC against [parity-checklist.md](./parity-checklist.md).

## Agent architecture

```text
UI / Research Actions
        │
        ▼
AgentRuntime (ProveTurn + tool grants)
        │
        ▼
AgentProviderRegistry
  ├─ codex-cli          (local `codex exec --json`; app-server later)
  ├─ openai-compat      (HTTP; keys outside prefs)
  ├─ prove-harness      (personal sidecar / evidence traces)
  └─ remote-execution   (optional/deferred; SSH is one backend)
```

Phase 3B uses `codex exec` rather than the XPI app-server stack so Chat/Actions
can run without bundling the native helper. The provider id stays `codex-cli`.

Policy (workspace sandbox, Keep, promotion) stays in Chatero. Credentials and
model transport stay in providers or sidecars.

## Engineering rules

1. Generic tab-group API knows nothing about Codex/QMD/skills.
2. QLab is a disableable module; startup failures stay inside QLab surfaces.
3. Trust boundaries are filesystem trees, not prompts.
4. Agent edits use private copies; Keep/promotion are explicit.
5. Upstream Zotero harness remains green after each phase merge.
