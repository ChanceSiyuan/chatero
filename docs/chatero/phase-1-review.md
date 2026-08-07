# Chatero Phase 1 review

## Install

1. Quit any older Chatero build. Zotero may remain installed.
2. Open the DMG in `app/dist/`.
3. Drag `Chatero.app` to `/Applications`.
4. On first launch, right-click Chatero and choose **Open** if Gatekeeper asks.

## Verify isolation

1. Confirm both Zotero and Chatero exist in `/Applications`.
2. Open both applications.
3. Confirm Chatero starts with a fresh library rather than the existing local
   Zotero database.
4. In Chatero, open Settings → Advanced → Files and Folders and confirm the
   data directory is under `~/Library/Application Support/Chatero/Data`.
5. Confirm the original Zotero library remains unchanged.

## Verify Zotero behavior

1. Sign in to Zotero Sync in Chatero.
2. Let metadata synchronize and open a synced PDF.
3. Create an annotation and a Zotero Note.
4. Open Preferences and the plugin manager.
5. With Zotero closed, save one browser item through Zotero Connector and
   confirm it reaches Chatero on port 23119.
6. With Zotero already open, start Chatero and confirm Chatero remains usable;
   its local server should use fallback port 23129.

Phase 1 intentionally contains no QLab tabs or split groups. Those begin only
after this complete-Zotero baseline is accepted.

**Phase 1 is frozen.** See [phase-1-freeze.md](./phase-1-freeze.md).
Further work follows [implementation-plan.md](./implementation-plan.md).
