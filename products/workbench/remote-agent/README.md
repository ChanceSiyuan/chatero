# Chatero Remote Agent releases

Chatero builds its Linux Remote Agent directly from the Code-OSS checkout pinned
at `df53daabb18cd157bdb08c7f01c34df936cf12f4`. It does not download or redistribute
Microsoft VS Code Server. Supported release tuples are `linux-x86_64` and
`linux-aarch64` only.

## Build unsigned architecture archives

Run these commands on Linux after the pinned checkout has been bootstrapped:

```bash
node products/workbench/remote-agent/scripts/build-linux-agent.mjs --arch x64
node products/workbench/remote-agent/scripts/build-linux-agent.mjs --arch arm64
```

The builder invokes the corresponding `vscode-reh-linux-*-min-ci` target, renames
the bundle root to its Chatero tuple, installs `bin/chatero-process-bridge.mjs`,
and creates an archive with deterministic timestamps and ownership.

## Stage a signed release

Keep the Ed25519 private key outside the repository and restrict it to the
protected release job. Stage both unsigned architecture archives together:

```bash
npm run remote-agent:stage -- \
  --x64 /secure/input/chatero-agent-linux-x86_64.tar.gz \
  --arm64 /secure/input/chatero-agent-linux-aarch64.tar.gz \
  --private-key /secure/input/chatero-release.private.pem \
  --out products/workbench/remote-agent/dist
```

Staging reinjects the audited process bridge, rebuilds and hashes the final
archives, writes canonical `manifest.json`, and creates the raw detached
Ed25519 signature `manifest.sig`. Runtime installers must use
`release-contract.mjs` with the pinned `release-public-key.pem`, verify the
signature before opening either archive, and then verify every streamed byte.

The committed public key is the release trust root. A production signing key
must be provisioned so that its public half exactly matches this file before
publishing a release; signing private keys must never be committed.
