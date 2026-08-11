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
- Code-OSS's built-in Agent Host and Codex provider own conversations,
  approvals, history, tools, changesets, cancellation, and chat UI. Chatero
  does not ship a second Agent implementation or prompt store.
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
7. start the server on loopback with a fresh connection token and a short,
   owner-only `--agent-host-path` Unix socket;
8. enable the embedded Codex provider with OpenAI as its only usage source;
9. return a normal Code-OSS `ManagedResolvedAuthority`, whose connections are
   independent `ssh -W 127.0.0.1:<port>` channels through the authenticated
   master.

Every child process uses an executable plus argv array. User text is never
concatenated into a local shell command. The small unavoidable remote bootstrap
script is product-owned, constant text; all substituted values pass a strict
ASCII token/path validator and are independently verified on the remote host.
Unknown host keys remain an OpenSSH-owned, user-visible decision. Chatero never
silently accepts them.

The Agent bundle is generated, not committed. The build creates both Linux
architectures from the pinned Code-OSS and Node versions, embeds the exact
architecture-matched `@openai/codex` SDK, and emits a signed manifest. It never
downloads a Microsoft VS Code Server or SDK at runtime. The DMG staging gate
fails if either architecture, its Codex binary, digest, or signature is absent.

## Arbitrary and empty folders

The SSH picker asks for a POSIX absolute path after target selection. Existing
directories open unchanged. A missing path is created only after one explicit
confirmation. An existing file is rejected. No repository marker, Git
metadata, QLab contract, or starter content is required. The remote installer
never writes inside the selected workspace.

Workspace trust remains a Code-OSS decision. The extension does not auto-trust
remote folders. Local Zotero tabs can remain open in the same window because
their custom editor providers stay in the local extension host. Opening a
remote folder restarts that local extension host, so restored custom-editor
URIs are resolved again through Zotero Core by exact `(libraryId, itemKey)`.
The URI/state contains no attachment path; a deleted item fails unavailable
instead of being rebound to whichever paper is currently focused.

## Codex execution

Code-OSS selects its local Agent Host in a local workspace and its
`EditorRemoteAgentHostServiceClient` in a remote workspace. The remote
`chatero-server` owns a child Agent Host on `--agent-host-path`; therefore the
same native Agent UI runs Codex on the Linux machine with the canonical remote
workspace as `cwd`. Focus changes do not migrate or cancel a running turn, and
cancellation targets only that turn.

Chatero enables `chat.agentHost.codexAgent.enabled` and
`chat.editor.codex.preferAgentHost`, disables Copilot/Claude/BYOK providers,
and patches the upstream Codex policy so `openai` is the default and only
fallback. A signed-out remote offers a fixed integrated-terminal
`codex login --device-auth` flow using the bundled binary; credentials remain
on that Linux host. Native Agent history stores messages, stable context
identifiers, authority, and workspace identity—not Zotero paths or PDF bytes.

## PDF context bridge

The PDF webview renders a selectable PDF.js text layer. On page or selection
change it posts page index, page label, bounded page text, and bounded selected
text to its local provider. The provider supplies the already-authorized
`libraryId` and `attachmentKey`; webview-supplied identities are ignored.

The local evidence broker registers a `chatContextProvider` and publishes
immutable snapshots only after the user chooses Add Context, invokes the PDF
context command, or presses Command-K with a selection. Passive focus/page
changes update the candidate snapshot but never attach or send it. Snapshots
have these limits:

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
`Simple` Agent attachment. A small upstream patch lets a trusted built-in
extension add that explicit text attachment to the native Chat input, so the
user sees and can remove the provenance chip before Send. Context text is
evidence, never instructions. The remote side receives no local URI.

### Complete-paper transfer

“Send full paper to remote” is a separate command with a confirmation naming
the SSH target, remote cache scope, byte count, and expiry. The provider streams
the authorized attachment to a fixed signed Remote Agent helper, computes
SHA-256 locally and remotely, uploads to
`~/.cache/chatero/evidence/<digest>.pdf.part`, verifies the remote digest, then
atomically renames it. Native Chat receives only an explicit simple attachment
containing the opaque cache identity and canonical remote path; no local path
crosses the boundary. The cache is outside the workspace, expires after 24
hours, and has an immediate Revoke command. Failed or canceled uploads delete
`.part` files.

## UI

- The Remote indicator in the lower-left opens “Connect to SSH…” and shows the
  active alias, folder, reconnect state, and a link to `Chatero Remote` output.
- The remote folder picker supports recent aliases, `~/.ssh/config` aliases,
  direct `user@host`, and an absolute folder path.
- PDF selection or `Command-K` adds a removable provenance chip to native Chat.
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
- SSH channel loss makes the fixed remote process bridge reap its child process
  group on `SIGHUP`, `SIGINT`, or `SIGTERM`; long-running Codex/tool processes
  must not survive a disconnected channel unintentionally.

## Verification gates

Unit and fixture integration tests must prove:

1. SSH argv cannot be extended by alias/path input and unknown hosts are not
   auto-accepted;
2. both Linux architectures are required and manifest signature plus digest
   are checked before upload;
3. arbitrary existing and confirmed-empty paths open without QLab markers;
4. resolver reconnect fences stale processes and forwards only loopback;
5. the built-in remote Agent Host exposes only the OpenAI Codex provider and
   Codex receives the canonical remote `cwd`;
6. bounded PDF selection/page text crosses while local paths and PDF bytes do
   not;
7. full-paper transfer requires an explicit grant, verifies digest, uses the
   cache outside the workspace, expires, and revokes; and
8. existing Zotero Core, native evidence editor, workbench bootstrap, and
   upstream policy tests remain green.
