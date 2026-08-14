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
A second `workbench:bootstrap` returns the verified checkout, re-materializing the
first-party extensions and re-recording their provenance when the repository
sources have moved ahead of the generated checkout. `workbench:compile` and
`workbench:dev` perform the same refresh, so a launch always runs current
extension code.

`workbench:install`, `workbench:compile`, and `workbench:dev` never imply one
another. The runner refuses an unverified checkout, a mismatched Node version,
insufficient disk, missing Xcode tools, or launch without `out/main.js`.

Run the committed bootstrap gate with:

```bash
npm run verify:workbench-bootstrap
```

## Stage 1 acceptance

The complete Stage 1 source, compile, and local-runtime gate is one closed
command:

```bash
npm run verify:stage-1
```

Before invoking it, use Node `24.18.0`, initialize the repository's pinned
submodules with `git submodule update --init --recursive`, run `npm ci`, and
materialize the pinned checkout and its dependencies with
`npm run workbench:bootstrap` followed by `npm run workbench:install`. Keep the
normal system executable paths available so the real Quarto starter tests can
invoke the installed `quarto` binary. The command executes every descriptor in
`acceptance/stage-1.requirements.json` in order; it has no skip or optional
flags and stops at the first failed requirement.

The machine-readable result is written atomically to
`products/workbench/.cache/acceptance/stage-1.json`. It contains source,
upstream, product, and patch-series digests plus check status and timing, but no
command output, environment, credential, or personal path. The stage is not
accepted when a required command is absent, skipped, failed, run from dirty
tracked source, or represented by evidence from another source commit.

The disposable integration profile intentionally has no personal Agent
credentials, so the bounded `No default agent registered` startup message is
allowed. Upstream Agent extension activation failures, duplicate providers,
or GitHub protected-resource requests are not allowed.

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

## Zotero Core boundary

The first headless-Core boundary lives in `services/zotero-core/`. Its
checked-in protocol is generated with `npm run core:generate` and verified with
`npm run core:check`. `npm run test:zotero-core` exercises bounded framing,
single-use capability authentication, the non-destructive profile lease, a
fixture Core process, cancellation, monotonic events, and structured errors.

The fixture intentionally never opens `zotero.sqlite`. It makes the
Electron/Core contract executable before the pinned Gecko adapter replaces its
method handlers. Bootstrap secrets travel over inherited fd 3, RPC uses only an
owner-protected Unix-domain socket, and renderer code must call a workbench
service rather than this transport directly.

The first verified native extension is materialized from
`products/workbench/extensions/chatero-zotero/`. It contributes a normal
Activity Bar container, TreeView, commands, configuration, progress, and
ThemeIcons. It does not use a webview. For safety, the Library remains stopped
until a profile is selected; the data-free fixture can be enabled only with the
`chatero.zotero.developerFixtureCore` developer setting. Without that setting,
the current slice never opens the selected profile while the Gecko adapter is
still under construction.
