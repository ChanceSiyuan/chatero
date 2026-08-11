# Chatero Code-OSS Workbench

This directory owns the reproducible transition from the current Zotero-based
Chatero development application to one Code-OSS/Electron research workbench.
The generated Code-OSS checkout is a disposable build input. It never owns or
opens a Zotero profile, QLab workspace, personal repository, or SSH credential.

The approved architecture and executable plan are:

- [`../../docs/superpowers/specs/2026-08-11-code-oss-zotero-workbench-design.md`](../../docs/superpowers/specs/2026-08-11-code-oss-zotero-workbench-design.md)
- [`../../docs/superpowers/plans/2026-08-11-code-oss-workbench-bootstrap.md`](../../docs/superpowers/plans/2026-08-11-code-oss-workbench-bootstrap.md)

## Pinned development environment

- Code-OSS: `1.132.0` at
  `df53daabb18cd157bdb08c7f01c34df936cf12f4`
- Node.js: `24.18.0`
- Electron headers/runtime target: `42.7.1`
- macOS with Xcode command line tools
- at least 20 GiB free before dependency installation
- public extension gallery: Open VSX only

The current shell must report Node `v24.18.0` before install, compile, or launch.
For example, with a local Node version manager:

```bash
nvm install 24.18.0
nvm use 24.18.0
```

## Clone to development shell

Run each stage explicitly from the repository root:

```bash
npm run workbench:bootstrap
npm run workbench:verify
npm run workbench:install
npm run workbench:compile
npm run workbench:dev
```

`workbench:bootstrap` clones the immutable Code-OSS tag into the ignored
`vendor/code-oss`, checks out the exact commit, validates the complete patch
series before applying any patch, writes deterministic Chatero product identity
and Open VSX configuration, applies the marketplace policy gate, and publishes
`.chatero-provenance.json` last.

`workbench:verify` is read-only. It checks HEAD, runtime pins, patch digests,
product digest, managed worktree paths, complete binary diff digest, and policy.
A second `workbench:bootstrap` returns the verified checkout unchanged.

`workbench:install`, `workbench:compile`, and `workbench:dev` never imply one
another. The runner refuses an unverified checkout, a mismatched Node version,
insufficient disk, missing Xcode tools, or launch without `out/main.js`.

Run the committed bootstrap gate with:

```bash
npm run verify:workbench-bootstrap
```

## Generated paths

The following paths are build inputs or outputs and remain outside Git:

```text
vendor/code-oss/
products/workbench/.cache/
products/workbench/dist/
```

`CHATERO_CODE_OSS_DIR` may select another absolute generated checkout path.
Do not point it at a personal repository. The bootstrap refuses a non-Git,
dirty, stale, or unverified existing destination and never runs `git reset`,
`git clean`, or recursive deletion.

## Recovery

- **Wrong Node:** switch the shell to `24.18.0`; do not force native dependency
  installation under a different ABI.
- **Dirty checkout without provenance:** preserve it for inspection or choose a
  new `CHATERO_CODE_OSS_DIR`. If it contains only reproducible generated data,
  remove it manually and bootstrap again.
- **Existing checkout failed verification:** inspect the reported product,
  patch, status, or diff mismatch. Bootstrap will not repair it automatically.
- **Patch drift:** update the patch against the pinned upstream, recompute its
  SHA-256 in `patches/code-oss/series.json`, and rerun the entire gate.
- **Upstream update:** change `upstreams.json` on a dedicated merge branch,
  rebase the ordered patch series without fuzz, update product/runtime pins,
  and pass both workbench and Zotero parity gates before integration.

## Ownership and policy

Code-OSS owns the visible workbench and standard IDE behavior. The current
Zotero tree remains the pinned source for the future headless Zotero Core and
the legacy parity oracle. Electron and extensions must never access
`zotero.sqlite` directly.

Open VSX is the only public gallery. Product configuration and patches may not
contain Microsoft Marketplace endpoints, `ms-python.vscode-pylance`, or
`ms-vscode-remote.remote-ssh`. Chatero supplies its own Python and Remote SSH
experiences in later plans.
