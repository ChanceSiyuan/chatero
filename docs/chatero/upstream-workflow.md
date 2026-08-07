# Upstream workflow

The first Chatero commit is based directly on \`zotero/zotero\` main. Its parent
commit is the reproducible Phase 1 upstream baseline.

To update:

\`\`\`bash
git fetch upstream
git switch -c merge/upstream-YYYY-MM-DD main
git merge --no-ff upstream/main
npm ci
NODE_OPTIONS=--openssl-legacy-provider npm run build
app/scripts/dir_build -f -p m
CI=1 test/runtests.sh -f
\`\`\`

Resolve Chatero-specific conflicts in the merge branch, run the complete gate,
and merge the branch into \`main\` only after review. Never force-push upstream
history.
