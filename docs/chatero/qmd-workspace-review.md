# Chatero QMD Workspace Review

Use this checklist against a personal-development Chatero build. It verifies the approved source-driven writing workflow without modifying `knowledge/` or `literature/`.

## Test fixture

Choose a QLab repository that contains:

- `drafts/review-demo.qmd`
- `knowledge/` with at least one QMD note
- `literature/ref.bib` with at least one citekey
- Quarto on `PATH`

The Draft should include YAML frontmatter, inline and display math, and one each of:

```qmd
:::{#def-review}
A definition with $E = mc^2$.
:::

:::{#lem-review}
A lemma.
:::

:::{#thm-review}
A theorem.
:::

:::{#prf-review}
A proof.
:::
```

## 1. Native workspace and layout

1. Open the QMD Editor native tab.
2. Confirm the tab contains QLab Explorer, Monaco source, and Quarto Preview.
3. Drag the divider and use Left/Right Arrow while it is focused.
4. Collapse and restore Explorer; resize the window to medium and narrow widths.
5. Close and reopen Chatero.

Expected:

- PDF, Chat, and QMD remain independent native tabs and retain the existing split arrangements.
- Divider ratio, Explorer visibility, Preview visibility, and active Draft survive session restoration.
- At medium width Explorer collapses before Preview; at narrow width Monaco remains usable.

## 2. Explorer and external changes

1. Add, rename, and remove a QMD file beneath `drafts/` from another editor.
2. Change the open Draft externally while it is clean.
3. Repeat while Monaco has an unsaved human edit.

Expected:

- Explorer refreshes within roughly one second while visible.
- A clean Draft reloads without recreating the QMD tab.
- A dirty Draft opens a compare state; the in-memory edit is not overwritten.
- `knowledge/` and `literature/` are visually read-only and never become Draft write targets.

## 3. Monaco writing behavior

1. Edit prose, YAML, math, and a theorem-family fenced Div.
2. Type `@` and verify `literature/ref.bib` citekey suggestions.
3. Trigger completion for theorem, lemma, definition, and proof snippets.
4. Leave a fenced Div unclosed, then close it.
5. Save once with ⌘S and once by waiting.

Expected:

- Dirty state appears immediately.
- ⌘S saves immediately; ordinary edits save after about 800 ms.
- The malformed fenced Div receives a diagnostic that clears after correction.
- Absolute local paths never appear in Monaco model URIs or UI.

## 4. Quarto Preview

1. Confirm YAML, headings, math, `thm`, `lem`, `def`, and `proof` render normally.
2. Introduce a Quarto compile error and save.
3. Fix the error and save again.

Expected:

- Quarto runs only on `127.0.0.1` with execution disabled.
- A failed build leaves the last successful page visible and reports the failure in status/Monaco.
- Preview recovers automatically after the source is fixed.
- Three consecutive process failures pause automatic restart until Retry is requested.

## 5. AI proposal review

1. Ask Edit with AI to change the open Draft.
2. Compare the proposal in Monaco.
3. Switch Preview between Original and Proposed.
4. Reject once, then create a new proposal and Keep it.
5. Create another proposal, make a disjoint human edit, and Keep.
6. Create another proposal, edit the same line manually, and Keep.
7. Quit and reopen Chatero with a proposal pending.

Expected:

- AI writes only under `work/qlab-zotero/draft-changes/`.
- Only the latest proposal remains for a Draft.
- Reject leaves the Draft byte-for-byte unchanged.
- Keep promotes a clean proposal and rebases disjoint human edits.
- Overlap produces a visible conflict and preserves base, current, and proposed text without writing.
- Original/Proposed review state survives restart.

## 6. Inline AI command

1. Select a Monaco range and press ⌘K.
2. Request a focused rewrite.
3. Repeat with a collapsed cursor and request an insertion.

Expected:

- The exact Monaco selection/cursor becomes the edit anchor.
- The result appears as a private proposal, not an immediate Draft write.
- Compare, Keep, and Reject behave exactly as for full-document AI edits.

## 7. Data-safety check

After the review, inspect Git status and the packaged application.

Expected:

- No personal `knowledge/`, `drafts/`, or `literature/` content is inside `Chatero.app` or the DMG.
- Human writes target only `drafts/`.
- AI writes target only the private proposal tree until Keep.
- Zotero Library, Reader, sync, citations, and existing Chat behavior remain available.
