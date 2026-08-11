# Remote Zotero–Codex Bridge Design

**Status:** Approved implementation slice of
`2026-08-11-code-oss-zotero-workbench-design.md`

## Outcome

Chatero can open an arbitrary local or SSH Linux folder—including an empty
folder—using normal Code-OSS editors. A Codex turn runs on the same side as the
active workspace. A locally open Zotero PDF remains local, while the user can
grant its current page or selection to a remote Codex turn without leaking a
local path. Sending the complete PDF is a separate, explicit action.

This slice does not depend on a QLab layout and does not create `knowledge/`,
`drafts/`, or `literature/` in a general workspace.

## Product boundaries

- `chatero-zotero` remains a local UI extension. It owns PDF/Note editor
  identity and emits bounded, immutable evidence snapshots.
- `chatero-remote` is a local UI extension. It discovers OpenSSH targets,
  installs and starts the matching Linux Remote Agent, resolves the
  `chatero-remote` authority, and owns connection logs and reconnection.
- `chatero-agent` is a local UI extension. It owns conversations and context
  grants. It invokes Codex through the active local or remote execution
  authority; it never reads a Zotero profile or remote workspace directly.
- the Code-OSS Remote Agent is the workspace-side authority for filesystem,
  watch, search, PTY, Git, process execution, forwarding, the remote extension
  host, language servers, and debug adapters.
- Zotero Core remains the only owner of profile data and attachment truth.

## Remote authority

The authority prefix is `chatero-remote`. A target authority contains only a
URL-safe identifier for a persisted SSH profile; it never embeds a password,
key, repository path, or shell command. The selected folder is the path of the
`vscode-remote://` workspace URI.

The resolver uses the system OpenSSH client and existing user configuration.
It performs these steps:

1. resolve the selected alias with `ssh -G` and show the resulting endpoint;
2. establish a multiplexed master with strict host-key verification;
3. probe `uname -s` and `uname -m` through a fixed command;
4. select only `linux-x86_64` or `linux-aarch64`;
5. verify a signed, version-matched bundle manifest and SHA-256 digest;
6. upload to a temporary user-owned path and atomically install under
   `~/.local/share/chatero/remote-agent/<product-version>/<tuple>/`;
7. start the server on loopback with a fresh connection token;
8. create a local OpenSSH forward through the authenticated master; and
9. return a normal Code-OSS `ResolvedAuthority`.

Every child process uses an executable plus argv array. User text is never
concatenated into a local shell command. The small unavoidable remote bootstrap
script is product-owned, constant text; all substituted values pass a strict
ASCII token/path validator and are independently verified on the remote host.
Unknown host keys remain an OpenSSH-owned, user-visible decision. Chatero never
silently accepts them.

The Agent bundle is generated, not committed. The build creates both Linux
architectures from the pinned Code-OSS and Node versions and emits a signed
manifest. The DMG staging gate fails if either architecture, its digest, or
its signature is absent.

## Arbitrary and empty folders

The SSH picker asks for a POSIX absolute path after target selection. Existing
directories open unchanged. A missing path is created only after one explicit
confirmation. An existing file is rejected. No repository marker, Git
metadata, QLab contract, or starter content is required. The remote installer
never writes inside the selected workspace.

Workspace trust remains a Code-OSS decision. The extension does not auto-trust
remote folders. Local Zotero tabs can remain open in the same window because
their custom editor providers stay in the local extension host.

## Codex execution

`chatero-agent` resolves one execution authority per turn from the workspace
snapshot captured when Send is pressed. Local turns use a local Codex process;
remote turns use the resolver's remote execution service with the canonical
remote workspace as `cwd`. Focus changes do not migrate or cancel a running
turn. Cancellation targets only that turn.

The minimum supported remote launch is `codex exec --json` with an argv array,
workspace-write sandbox, and the canonical remote root. The connection probes
Codex before Send and offers the fixed device-auth terminal flow when it is
missing or signed out. Conversation records store messages, stable context
identifiers, authority, and workspace identity—not attachment bytes or local
paths.

## PDF context bridge

The PDF webview renders a selectable PDF.js text layer. On page or selection
change it posts page index, page label, bounded page text, and bounded selected
text to its local provider. The provider supplies the already-authorized
`libraryId` and `attachmentKey`; webview-supplied identities are ignored.

The local evidence broker publishes immutable snapshots with these limits:

- selected text: 32 KiB UTF-8;
- current page text: 128 KiB UTF-8;
- annotation/comment text included in one turn: 64 KiB UTF-8 total;
- no local absolute attachment/profile path; and
- no raw PDF bytes in an ordinary Send.

The context manifest records provenance and exact authority:

```json
{
  "workspace": {
    "authority": "chatero-remote+lab",
    "root": "/srv/research/project"
  },
  "resources": [
    {
      "kind": "pdf-selection",
      "libraryId": 1,
      "attachmentKey": "ABCD1234",
      "pageIndex": 6,
      "pageLabel": "7",
      "text": "bounded immutable text"
    }
  ],
  "grants": ["workspace:read", "workspace:write", "zotero:bounded-context"]
}
```

The broker serializes the manifest into a clearly delimited, injection-aware
context section before the user's prompt. Context text is evidence, never
instructions. The remote side receives no local URI.

### Complete-paper transfer

“Send full paper to remote” is a separate command with a confirmation naming
the SSH target, remote cache scope, byte count, and expiry. The provider streams
the authorized attachment, computes SHA-256 locally, uploads to
`~/.cache/chatero/evidence/<digest>.pdf.part`, verifies the remote digest, then
atomically renames it. The final context contains a `remote-cache://<digest>`
reference. The cache is outside the workspace, expires after 24 hours, and has
an immediate Revoke command. Failed or canceled uploads delete `.part` files.

## UI

- The Remote indicator in the lower-left opens “Connect to SSH…” and shows the
  active alias, folder, reconnect state, and a link to `Chatero Remote` output.
- The remote folder picker supports recent aliases, `~/.ssh/config` aliases,
  direct `user@host`, and an absolute folder path.
- PDF selection or `Command-K` adds a removable provenance chip to the Agent.
- Remote context chips say “Local Zotero → <SSH alias>” so the boundary is
  visible before Send.
- Full-paper transfer is never triggered implicitly by Send or by merely
  opening a PDF.
- On disconnect, local PDF/Zotero tabs and local chat history remain usable;
  remote editors and turns show one reconnectable state.

## Failure and recovery

- Master loss invalidates every dependent channel and increments a connection
  epoch. Late output from an old epoch is ignored.
- Reconnect re-resolves the authority, revalidates the host fingerprint and
  installed Agent version, and never changes the workspace path.
- A mismatched signature, digest, product version, platform, architecture,
  canonical root, or connection token fails closed and opens the log.
- Failed folder creation, Agent installation, forwarding, or Codex launch
  leaves existing remote files untouched.
- Local PDF context remains an unavailable chip if the Zotero item disappears;
  it is not silently rebound to the currently focused paper.

## Verification gates

Unit and fixture integration tests must prove:

1. SSH argv cannot be extended by alias/path input and unknown hosts are not
   auto-accepted;
2. both Linux architectures are required and manifest signature plus digest
   are checked before upload;
3. arbitrary existing and confirmed-empty paths open without QLab markers;
4. resolver reconnect fences stale processes and forwards only loopback;
5. remote Codex receives the canonical remote `cwd`;
6. bounded PDF selection/page text crosses while local paths and PDF bytes do
   not;
7. full-paper transfer requires an explicit grant, verifies digest, uses the
   cache outside the workspace, expires, and revokes; and
8. existing Zotero Core, native evidence editor, workbench bootstrap, and
   upstream policy tests remain green.
