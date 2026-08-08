# Single-View QMD Workspace Design

## Goal

Make the Chatero QMD workspace comfortable beside a PDF by replacing the simultaneous Source/Preview columns with one light-colored main surface. The eye toolbar action switches that surface between editable QMD source and rendered Quarto Preview.

## Approved interaction

- QLab Explorer remains the left navigation for `drafts/`, `knowledge/`, and `literature/`.
- The main surface shows exactly one of Source or Preview at a time.
- Source is the default. Clicking the eye action shows Preview; clicking it again returns to Source.
- Switching views preserves the Monaco model, cursor, dirty state, Preview process, Original/Proposed selection, and AI proposal state.
- Monaco always uses the light `vs` theme. It does not follow macOS dark appearance.
- Original/Proposed controls appear inside Preview only when a proposal exists. Original remains the default.
- Compare continues to use Monaco's diff editor and therefore returns the main surface to Source.

## Responsive layout

- At wide QMD-tab widths, Explorer is a fixed 190-pixel column beside the single main surface.
- Below the compact threshold, Explorer no longer consumes document width. It becomes an overlay drawer over the QMD workspace, opened and closed by the folder action.
- The drawer belongs to the QMD pane and does not resize or cover the adjacent native PDF pane.
- The top toolbar stays on one row. Actions are icon-only; accessible labels are visually hidden and remain available through `title`, Fluent, and `aria-label`.
- Low-priority path decoration may truncate, but actions must never overlap.

## Preview process reliability

- Quarto discovery checks the GUI process PATH and common macOS installations: `/usr/local/bin/quarto`, `/opt/homebrew/bin/quarto`, and `/Applications/quarto/bin/quarto`.
- The resolved absolute executable is passed to the process runner.
- Spawn errors and early non-zero exits reject readiness immediately with the original diagnostic instead of degrading to a generic timeout.
- Readiness polling remains bounded. A successful page reuses the existing Preview session and is not restarted by Source/Preview toggles.
- When Preview cannot start, Chatero retains the safe non-executing fallback render and exposes the actionable error in the status bar. Retry repeats discovery and launch.
- Every Quarto invocation keeps `--no-execute`, loopback-only hosting, and a Draft-scoped working directory.

## State and compatibility

- The persisted workspace field becomes `surface: "source" | "preview"`; older `previewVisible` state is accepted and mapped without breaking restored tabs.
- The obsolete Source/Preview splitter is removed from the rendered workspace. Existing split-ratio data may remain ignored for backward compatibility.
- AI proposal storage, Draft autosave, Keep/Reject semantics, PDF/Chat/QMD native tabs, and Zotero profile data are unchanged.

## Verification

- Unit tests cover single-surface markup and controller toggling.
- CSS structure tests cover light Monaco styling, overlay Explorer, hidden assistive labels, and non-overlapping toolbar behavior.
- Quarto tests cover common-path discovery, immediate spawn failure propagation, early exit propagation, and the existing successful launch contract.
- Focused QMD tests, full Chatero tests, application build, and personal DMG packaging must pass.
