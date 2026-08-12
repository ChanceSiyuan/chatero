# Chatero QMD Workspace Review

Use this checklist only as the frozen Gecko parity oracle. The Workbench now
uses one `documentation/` tree: standard Text Editor and
`chatero.documentation.livePreview` share the same QMD `TextDocument`, while
Agent changes remain private Change Sets until explicit human review. Existing
`drafts/` and `knowledge/` trees are brought across with the separate Plan and
Migrate commands; their original bytes remain in place.

The unchecked manual steps below document the former three-surface behavior
that the Workbench must preserve where applicable; they are not a record that a
particular build or DMG has passed review.

## Test fixture

Use a temporary QLab repository with this shape:

```text
drafts/
  review-demo.qmd
knowledge/
  index.qmd
literature/
  ref.bib
```

Keep personal QLab repositories out of the test and packaging paths. Make sure
Quarto is available to the GUI process through `PATH`, `/usr/local/bin`,
`/opt/homebrew/bin`, or `/Applications/quarto/bin`.

The Draft should include YAML frontmatter, prose, inline and display math, and
one each of the supported formal blocks:

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

## 1. Native tab and three resident surfaces

1. Open a new Draft in the native QMD Editor tab.
2. Confirm that it opens in **Visual Edit**.
3. Click the single eye action three times.
4. Leave each surface active in turn, close Chatero, and restore the session.
5. Collapse and restore Explorer, then resize the QMD pane beside a PDF tab.

Expected:

- The eye follows exactly **Visual Edit → Website Preview → Monaco Source →
  Visual Edit**. It is one three-state action, not independent show/hide or
  binary preview controls.
- A new Draft defaults to Visual Edit. A restored Draft resumes its last
  normalized surface; legacy `preview` state restores as Website Preview.
- Visual Edit, Website Preview, Monaco, and the shared Draft session stay
  mounted while another surface is visible. Switching surfaces does not
  recreate an editor, discard selection/scroll state, or restart a live Quarto
  process.
- Only the active surface is shown; no internal Source/Preview divider remains.
- PDF, Chat, and QMD remain independent native tabs and retain existing split
  arrangements.
- At compact width Explorer is contained by the QMD pane and does not obscure
  an adjacent PDF.
- Toolbar actions are icon-only without overlap; every icon exposes an English
  accessible label and tooltip.

## 2. Explorer and shared Draft session

1. Add, rename, and remove a QMD file beneath `drafts/` in another editor.
2. Change the open Draft externally while its shared session is clean.
3. Repeat while there is an unsaved human edit.
4. Move between all three surfaces after editing on each writable surface.

Expected:

- Explorer refreshes within roughly one second while visible.
- A clean Draft reloads without recreating the QMD tab or its resident
  surfaces.
- A dirty Draft opens a compare state; the in-memory human edit is not
  overwritten.
- Leaving Visual Edit flushes its active field before the surface changes.
- Visual and Monaco edits pass through the same revision-guarded Draft session,
  so an older editor snapshot cannot overwrite a newer disk revision.
- `knowledge/` and `literature/` remain visually read-only and never become
  Draft write targets.

## 3. Visual Edit

1. Edit ordinary prose and save by leaving the active field.
2. Click inline and display formulas, edit their LaTeX source, then leave them.
3. Click definition, lemma, theorem, and proof cards and edit each complete QMD
   fenced Div source.
4. Edit a formula inside one of those cards without opening the whole card.
5. Insert Definition, Lemma, Theorem, and Proof with the Visual Edit tools.
6. Switch away during an active edit, then return.

Expected:

- Prose, math, and formal blocks visually resemble the rendered Quarto page
  until their exact source range is being edited.
- Formula-only editing replaces only the selected inline/display LaTeX range;
  duplicate formulas, literal dollar signs, and fenced code do not shift the
  target.
- A formal card can expose and save its complete source, including formulas.
- Inserted blocks use unique `def`, `lem`, `thm`, or `prf` anchors.
- Visual edits autosave through the shared Draft session. Stale saves from a
  previously opened file or generation are ignored.
- Formal-block insertion tools are visible only while Visual Edit is active.

## 4. Website Preview

1. Enter Website Preview immediately after opening or saving a Draft.
2. Confirm YAML, headings, math, definition, lemma, theorem, and proof output.
3. Switch away and back repeatedly while Quarto remains healthy.
4. Introduce a Quarto compile error and save, then fix it and save again.
5. Temporarily make Quarto unavailable, select Retry, and inspect the status.

Expected:

- A safe **quick** preview appears while the exact selected QMD page is still
  compiling; it is replaced by the loopback **exact** Quarto page when ready.
- Quarto binds only to `127.0.0.1` and always runs with execution disabled.
- Re-entering Website Preview reuses a healthy resident process instead of
  rendering the whole workspace or restarting Quarto for a surface switch.
- A failed compile keeps the **last-good** exact page visible and reports the
  current failure rather than replacing it with a blank surface.
- Missing executables and early process exits report their real error instead
  of only a generic readiness timeout.
- Preview recovers after the source is fixed. Repeated process failure pauses
  automatic restart until Retry is requested.
- Hidden Website progress does not overwrite a human save/conflict status;
  Website progress is shown when Website Preview is active.

## 5. Monaco Source

1. Enter Monaco Source with the eye action.
2. Edit prose, YAML, math, and a theorem-family fenced Div.
3. Type `@` and inspect `literature/ref.bib` citekey suggestions.
4. Trigger definition, lemma, theorem, and proof completions.
5. Leave a fenced Div unclosed, then close it.
6. Save once with ⌘S and once by waiting for autosave.

Expected:

- Monaco uses the light Chatero workspace style, retains its model and editor
  state while hidden, and preserves the Draft's existing line endings.
- Dirty state appears immediately. ⌘S saves immediately; ordinary edits save
  after the configured idle interval.
- The malformed fenced Div receives a diagnostic that clears after correction.
- Absolute local paths never appear in Monaco model URIs or UI.
- Returning to Visual Edit shows the same saved source without rebuilding
  either editor.

## 6. Original and Proposed version axis

1. Create an AI proposal for the open Draft.
2. In Website Preview, toggle Original/Proposed, then leave and re-enter the
   surface with Proposed selected.
3. Use Compare from Visual Edit or Monaco Source and confirm it opens the
   source diff without promoting the proposal.
4. Quit and reopen Chatero with a proposal pending.

Expected:

- `original | proposed` is independent of
  `visual | website | source`; neither control silently changes the other.
- Website Preview can inspect both rendered versions; Compare remains the
  source-oriented review path from the other surfaces.
- Surface and version target survive session restoration.
- A delayed AI result for Draft A cannot attach itself to Draft B after a fast
  file switch.

## 7. Cumulative AI proposal, TODO completion, Keep, and Reject

1. Ask AI to edit a Draft, then ask for a second change before Keep.
2. Run Complete TODOs while that proposal is pending.
3. Include several `[todo: ...]` markers and verify only those ranges change.
4. Simulate an invalid or interrupted TODO result, then retry.
5. Reject once. Create another proposal and Keep it.
6. Before Keep, make a disjoint human edit; repeat with an overlapping edit.

Expected:

- AI writes only under the private proposal tree in
  `work/qlab-zotero/draft-changes/`; the human Draft is unchanged before Keep.
- Consecutive AI actions cumulatively update the one latest proposal. They do
  not create a proposal chain or erase earlier unkept proposal work.
- TODO completion runs in its own guarded staging directory, reads an isolated
  input, and returns a structured completion manifest. Chatero applies only the
  identified TODO replacements to the current proposal locally.
- Invalid, cancelled, or stale TODO output cannot alter the Draft or destroy
  the previous proposal; retry starts from a fresh staging run.
- Reject removes the proposal and leaves the Draft byte-for-byte unchanged.
- Keep is the only promotion path. It promotes a clean proposal, rebases
  disjoint human edits, and reports overlapping edits as a conflict while
  retaining base/current/proposed text.
- Only the latest private proposal for a Draft is retained across restart.

## 8. Toolbar workflow and data safety

1. Exercise compliance, Add to Knowledge, Complete TODOs, Original/Proposed,
   Keep, Reject, formal insertion, external editor, save, and refresh actions.
2. Attempt to open or write a symlinked Draft/proposal path outside the QLab
   repository.
3. Inspect Git status and the packaged application after review.

Expected:

- Compliance is read-only. Add to Knowledge validates the current source,
  runs a read-only AI review in Chat, and then shows the exact destination in
  a human confirmation prompt. Agent errors and denied approvals fail closed;
  neither action silently promotes a Draft.
- Human-approved publication atomically creates a new Knowledge page, retains
  the Draft, and never overwrites an existing file or follows a destination
  symlink.
- External editing accepts only real QMD files beneath `drafts/`.
- Draft, proposal, manifest, and TODO staging guards reject symlink/path escape
  attempts without touching the external target.
- No personal `knowledge/`, `drafts/`, `literature/`, Zotero profile, chat
  history, credentials, or QLab content is copied into `Chatero.app` or a DMG.
- Human writes target only `drafts/`; AI writes stay private until Keep.
- Zotero Library, Reader, sync, citations, Chat, PDF tabs, and native split-tab
  behavior remain available.
