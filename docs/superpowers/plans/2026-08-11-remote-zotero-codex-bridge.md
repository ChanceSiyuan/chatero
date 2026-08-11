# Remote Zotero–Codex Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chatero open arbitrary local or SSH Linux workspaces, run Codex beside the active workspace, and explicitly bridge bounded local Zotero PDF context to a remote turn without exposing local paths.

**Architecture:** A local built-in `chatero-remote` extension resolves a normal Code-OSS remote authority using system OpenSSH and a signed, commit-matched Code-OSS Remote Agent. Code-OSS's built-in Agent Host and Codex provider remain the single conversation, approval, history, diff, tool, and cancellation implementation; the remote server starts that Agent Host on a private Unix socket so Codex runs beside the remote workspace. The existing local `chatero-zotero` PDF editor captures selectable PDF.js text and adds immutable bounded snapshots to native Chat only after a user gesture; complete PDFs use an explicit digest-addressed remote cache transaction.

**Tech Stack:** Code-OSS 1.132 proposed resolver and chat-context APIs, Node.js 24 ESM/CommonJS, system OpenSSH, Code-OSS REH server and Agent Host, Ed25519 signatures, SHA-256, PDF.js, embedded `@openai/codex` 0.142.0, Node test runner.

## Global Constraints

- Preserve Zotero's profile, sync, Note, annotation, citation, attachment, and Reader behavior; Zotero Core remains the only profile writer.
- Never read or write `zotero.sqlite` from Electron renderers or extensions.
- Never commit personal Zotero profiles, Knowledge, Drafts, Literature, chat history, credentials, research output, generated Code-OSS checkouts, Remote Agent archives, or signing private keys.
- Do not add Microsoft Marketplace endpoints, Pylance, Microsoft Remote-SSH code/binaries/services, or Microsoft product branding.
- Use Open VSX and a Chatero-built Code-OSS Remote Agent for Linux `x86_64` and `aarch64` at exact Code-OSS commit `df53daabb18cd157bdb08c7f01c34df936cf12f4`; embed the matching Linux `@openai/codex` 0.142.0 package and never use a runtime Microsoft download.
- OpenSSH owns host-key and credential decisions; Chatero never silently accepts an unknown host key.
- Local and remote processes are launched with executable-plus-argv arrays; user input never extends a shell command.
- Existing remote folders open unchanged. A missing absolute folder is created only after explicit confirmation. No QLab marker or Git repository is required.
- Ordinary PDF context is limited to 32 KiB selected text, 128 KiB page text, and 64 KiB annotation/comment text; it contains no absolute local path or PDF bytes.
- Complete-paper transfer is explicit, digest verified, stored outside the workspace under `~/.cache/chatero/evidence/`, expires after 24 hours, and is revocable.
- Existing `knowledge/`, `drafts/`, and `literature/` directories are external personal data and must not be touched.

---

### Task 1: Signed Remote Agent release contract

**Files:**
- Create: `products/workbench/remote-agent/release-contract.mjs`
- Create: `products/workbench/remote-agent/runtime/chatero-process-bridge.mjs`
- Create: `products/workbench/remote-agent/scripts/stage-release.mjs`
- Create: `products/workbench/remote-agent/scripts/build-linux-agent.mjs`
- Create: `products/workbench/remote-agent/README.md`
- Create: `products/workbench/remote-agent/release-public-key.pem`
- Create: `products/workbench/tests/remote-agent-release.test.mjs`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Produces `REMOTE_AGENT_TUPLES = ["linux-x86_64", "linux-aarch64"]`.
- Produces `parseReleaseManifest(text): ReleaseManifest`, `canonicalManifestBytes(manifest): Buffer`, `verifyRelease({manifestText, signature, publicKey, readArtifact}): Promise<ReleaseManifest>`, and `selectArtifact(manifest, {commit, tuple}): ReleaseArtifact`.
- Produces a framed process bridge accepting exactly one first-line JSON `SpawnRequest` with `{protocolVersion:1,command:string,args:string[],cwd:string,env:Record<string,string>}` and emitting JSONL `stdout`, `stderr`, `exit`, or `error` frames with base64 payloads.
- Produces `stage-release.mjs --x64 <archive> --arm64 <archive> --private-key <pem> --out <directory>`, which injects the process bridge, hashes both final archives, writes canonical `manifest.json`, and writes detached Ed25519 `manifest.sig`.

- [ ] **Step 1: Write failing release-contract tests**

```js
test("release verification requires both exact pinned Linux tuples", async () => {
  const signed = await signedFixture({ tuples: ["linux-x86_64"] });
  await assert.rejects(() => verifyRelease(signed), /linux-aarch64/);
});

test("release verification rejects a changed manifest or artifact", async () => {
  const signed = await signedFixture();
  await assert.rejects(() => verifyRelease({ ...signed, manifestText: signed.manifestText.replace("x86_64", "x86_65") }), /signature/);
  signed.artifacts.set("chatero-agent-linux-x86_64.tar.gz", Buffer.from("changed"));
  await assert.rejects(() => verifyRelease(signed), /digest/);
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `node --test products/workbench/tests/remote-agent-release.test.mjs`

Expected: FAIL because `release-contract.mjs` and the staging scripts do not exist.

- [ ] **Step 3: Implement canonical manifest verification**

Use this exact manifest shape and reject unknown/missing keys:

```json
{
  "schemaVersion": 1,
  "product": "chatero",
  "releaseVersion": "1.132.0",
  "codeOssCommit": "df53daabb18cd157bdb08c7f01c34df936cf12f4",
  "artifacts": [
    {"tuple":"linux-x86_64","filename":"chatero-agent-linux-x86_64.tar.gz","sha256":"64 lowercase hex","size":1},
    {"tuple":"linux-aarch64","filename":"chatero-agent-linux-aarch64.tar.gz","sha256":"64 lowercase hex","size":1}
  ]
}
```

Canonical bytes are UTF-8 JSON with recursively sorted object keys, array order preserved, no insignificant whitespace, and one trailing newline. Verify the Ed25519 signature before opening artifacts, then stream and verify each artifact size and SHA-256.

- [ ] **Step 4: Implement the process bridge and release staging scripts**

The bridge must use `spawn(command, args, {cwd, env:{...process.env,...env}, shell:false, stdio:["pipe","pipe","pipe"]})`, reject non-absolute `cwd`, cap its first JSON line at 1 MiB, cap each argument and environment entry at 64 KiB, and kill the child process group on `SIGTERM`. Output frames use `{type:"stdout",data:"<base64>"}`, `{type:"stderr",data:"<base64>"}`, and `{type:"exit",code,signal}`.

`build-linux-agent.mjs` must invoke the pinned checkout's `vscode-reh-linux-x64-min-ci` or `vscode-reh-linux-arm64-min-ci` target only on Linux, rename the output root to `chatero-agent-linux-<arch>`, inject `runtime/chatero-process-bridge.mjs`, and archive with deterministic ownership and timestamps. It must not download Microsoft VS Code Server.

- [ ] **Step 5: Add package scripts and generated-file exclusions**

Add:

```json
"remote-agent:stage": "node products/workbench/remote-agent/scripts/stage-release.mjs",
"test:remote-agent": "node --test products/workbench/tests/remote-agent-*.test.mjs"
```

Ignore `products/workbench/remote-agent/dist/`, `products/workbench/remote-agent/.cache/`, and every `*.private.pem` below the Remote Agent directory.

- [ ] **Step 6: Run Task 1 tests and commit**

Run: `node --test products/workbench/tests/remote-agent-release.test.mjs`

Expected: all tests PASS, including missing tuple, wrong commit, malformed key set, bad signature, bad size, bad digest, and process-bridge argv/cwd validation cases.

Commit: `feat(workbench): define signed remote agent releases`

---

### Task 2: System OpenSSH transport and Code-OSS authority resolver

**Files:**
- Create: `products/workbench/extensions/chatero-remote/package.json`
- Create: `products/workbench/extensions/chatero-remote/extension.cjs`
- Create: `products/workbench/extensions/chatero-remote/authority.mjs`
- Create: `products/workbench/extensions/chatero-remote/openssh-targets.mjs`
- Create: `products/workbench/extensions/chatero-remote/ssh-session.mjs`
- Create: `products/workbench/extensions/chatero-remote/remote-agent-installer.mjs`
- Create: `products/workbench/extensions/chatero-remote/managed-connection.mjs`
- Create: `products/workbench/extensions/chatero-remote/media/remote.svg`
- Create: `products/workbench/tests/chatero-remote-transport.test.mjs`
- Create: `products/workbench/tests/chatero-remote-manifest.test.mjs`
- Modify: `products/workbench/first-party-extensions.json`
- Modify: `products/workbench/product.chatero.json`

**Interfaces:**
- Produces opaque authorities `chatero-remote+<base64url target id>` and strict `encodeAuthority(targetId)` / `decodeAuthority(authority)`.
- Produces `discoverSshTargets({home, readFile}): Promise<SshTarget[]>` and `resolveSshTarget(alias, runner): Promise<ResolvedSshTarget>` using `ssh -G`.
- Produces `SshSession.ensureReady({target, release, signal}): Promise<{hostFingerprint, remotePort, connectionToken}>` and `makeConnection(): ManagedMessagePassing`.
- Exports extension API `getActiveSession()`, `runProcess(request, observer, signal)`, `stageEvidence(request, signal)`, and `revokeEvidence(digest, signal)` without exposing credentials.

- [ ] **Step 1: Write failing authority, argv, lifecycle, and manifest tests**

```js
test("authority round trips an opaque target id and rejects embedded paths", () => {
  const authority = encodeAuthority("profile:lab-a");
  assert.match(authority, /^chatero-remote\+[A-Za-z0-9_-]+$/);
  assert.equal(decodeAuthority(authority), "profile:lab-a");
  assert.throws(() => decodeAuthority("chatero-remote+../../private"), /authority/);
});

test("managed connection keeps stderr away from protocol bytes", async () => {
  const process = fakeSshProcess();
  const socket = managedConnection(process);
  process.stderr.emit("data", Buffer.from("warning"));
  assert.deepEqual(receivedProtocolBytes, []);
});
```

Assert exact spawn arrays contain `-T`, `-S`, `-o`, `BatchMode=yes`, `--`, and the configured alias as distinct argv entries. Assert they never contain `StrictHostKeyChecking=no`, a password, a workspace path, or a connection token. Simulate master loss and prove all dependent channels close once and a later epoch ignores stale output.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `node --test products/workbench/tests/chatero-remote-{transport,manifest}.test.mjs`

Expected: FAIL because the extension and transport modules do not exist.

- [ ] **Step 3: Implement SSH target discovery and master ownership**

Port the safe parsing behavior—not the Gecko UI—from the retained XPI `openssh-profiles.ts` and `ssh-target-transport.ts`. Expand `Include` files under `~/.ssh/`, list only concrete `Host` aliases, use `ssh -G -- <alias>` as effective configuration truth, parse the host-key fingerprint from authenticated OpenSSH diagnostics, and store control sockets under an owner-only temporary directory. One session owns one master and all channels; master exit closes them and increments the epoch.

Authentication failure must offer the user an action that opens an integrated terminal running `ssh <alias> true`. The resolver retries only after that terminal flow. Never synthesize “yes” for a host-key prompt.

- [ ] **Step 4: Implement verified, atomic Remote Agent installation**

Probe with the fixed command `uname -s; uname -m; uname -r` and accept only Linux `x86_64|amd64` or `aarch64|arm64`. Select the exact signed artifact from Task 1. Resume an interrupted upload from the verified `.part` byte count, verify remote SHA-256, extract into a sibling temporary directory, then atomically rename to `~/.chatero-server/bin/<commit>/<tuple>/`. Never write in the selected workspace. Create an owner-only token file and a short owner-only Agent Host socket below `$XDG_RUNTIME_DIR` (with a 0700 `/tmp/chatero-$UID` fallback). Launch `bin/chatero-server --host=127.0.0.1 --port=0 --connection-token-file=<file> --agent-host-path=<socket>` with fixed environment that enables the embedded Codex SDK, disables Claude/BYOK, and never exposes the token in logs.

- [ ] **Step 5: Implement the proposed resolver and managed SSH byte stream**

Declare this exact manifest core:

```json
{
  "name":"chatero-remote",
  "publisher":"chatero",
  "extensionKind":"ui",
  "enabledApiProposals":["resolvers"],
  "activationEvents":["onResolveRemoteAuthority:chatero-remote"]
}
```

Register `workspace.registerRemoteAuthorityResolver("chatero-remote", resolver)`. Return `new vscode.ManagedResolvedAuthority(makeConnection, connectionToken)` where each connection spawns `ssh -T -S <socket> -o BatchMode=yes -- <alias> -W 127.0.0.1:<remotePort>`. Implement backpressure with `drain`, separate `onDidClose` and `onDidEnd`, and redact token/key material from the `Chatero Remote` output channel. Return `TemporarilyNotAvailable` for transport loss and `NotAvailable(..., true)` for unsupported architecture, invalid signature, rejected authentication, or cancellation.

- [ ] **Step 6: Register the built-in and proposal allowlist**

Add every extension file explicitly to `first-party-extensions.json`. Add:

```json
"extensionEnabledApiProposals": {"chatero.remote":["resolvers"]}
```

to `product.chatero.json`. Keep Microsoft extension galleries and Remote-SSH absent.

- [ ] **Step 7: Run Task 2 tests and commit**

Run: `node --test products/workbench/tests/chatero-remote-{transport,manifest}.test.mjs products/workbench/tests/first-party-extensions.test.mjs products/workbench/tests/workbench-policy.test.mjs`

Expected: all tests PASS.

Commit: `feat(workbench): resolve signed SSH workspaces`

---

### Task 3: Arbitrary/empty remote workspace UX and remote process API

**Files:**
- Create: `products/workbench/extensions/chatero-remote/remote-workspace.mjs`
- Create: `products/workbench/extensions/chatero-remote/remote-process.mjs`
- Create: `products/workbench/tests/chatero-remote-workspace.test.mjs`
- Create: `products/workbench/tests/chatero-remote-process.test.mjs`
- Modify: `products/workbench/extensions/chatero-remote/package.json`
- Modify: `products/workbench/extensions/chatero-remote/extension.cjs`
- Modify: `products/workbench/remote-agent/runtime/chatero-process-bridge.mjs`

**Interfaces:**
- Produces `validateRemoteWorkspacePath(path): string`, accepting POSIX absolute paths without NUL/newline and rejecting relative paths.
- Produces `probeWorkspace(session, path): Promise<"directory"|"missing"|"file">` and `createWorkspace(session, path): Promise<void>` using a fixed bridge request with base64url path data.
- Produces `RemoteProcessService.run({command,args,cwd,env}, observer, signal): Promise<ProcessExit>` over the installed `chatero-process-bridge`, with command/args transmitted as framed JSON rather than a remote shell string.

- [ ] **Step 1: Write failing path, empty-folder, and process-frame tests**

```js
test("an empty arbitrary directory opens without QLab markers", async () => {
  const folder = await chooseRemoteWorkspace(fakes({ probe: "missing", confirmCreate: true }));
  assert.equal(folder.uri.path, "/srv/empty-research");
  assert.deepEqual(folder.created, ["/srv/empty-research"]);
  assert.equal(folder.checkedForQlab, false);
});

test("remote process transmits argv as data", async () => {
  await service.run({command:"codex",args:["exec","text; rm -rf x"],cwd:"/srv/work",env:{}}, observer);
  assert.equal(fakeSsh.argv.some(value => value.includes("rm -rf")), false);
  assert.equal(JSON.parse(fakeSsh.stdinLine).args[1], "text; rm -rf x");
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test products/workbench/tests/chatero-remote-{workspace,process}.test.mjs`

Expected: FAIL because workspace and process services do not exist.

- [ ] **Step 3: Implement picker and create-if-confirmed flow**

Contribute `Chatero: Connect to SSH…`, `Chatero: Open Remote Folder…`, `Chatero: Reconnect`, and `Chatero: Show Remote Log`. Show recent targets first, then concrete SSH aliases, then “Add user@host…”. Resolver and picker must share one `ensureAuthoritySession(authority, {signal})`: the picker establishes the authenticated session before it probes or creates a path, while resolver wraps that same epoch in `ManagedResolvedAuthority`. Prompt for an absolute remote path. For a missing path show `Create empty folder on <alias>?` with the full path; cancel performs no write. Reject existing files. Construct the URI with `vscode.Uri.from({scheme:"vscode-remote",authority,path})`, call `vscode.openFolder(uri, {forceReuseWindow:true})`, and let normal Code-OSS workspace trust run.

Persist only alias/opaque target id, last path, and host fingerprint in extension global state. Do not persist passwords, tokens, key contents, or PDF context.

- [ ] **Step 4: Implement framed remote process execution**

Open only the fixed installed bridge path through the authenticated SSH master. Send one bounded request frame, map base64 stdout/stderr frames to the observer, enforce one terminal exit, and on cancellation close the channel and make the bridge terminate/reap the child process group. Canonicalize `cwd` remotely and reject a result outside the selected root for workspace-scoped calls. The bridge must reap its child process group on `SIGHUP`, `SIGINT`, and `SIGTERM`, because an SSH channel loss commonly reaches the bridge as `SIGHUP`.

- [ ] **Step 5: Add status and error UX**

Use the normal lower-left Remote indicator plus a `Chatero Remote` status bar item showing connecting, connected alias, reconnecting, or error. Every error action opens the redacted output channel. Disconnect must not close local Zotero custom editors or delete recent targets.

- [ ] **Step 6: Run Task 3 tests and commit**

Run: `node --test products/workbench/tests/chatero-remote-{workspace,process}.test.mjs`

Expected: all tests PASS, including missing-declined, file-at-path, control characters, stale epoch, cancellation, malformed frame, and nonzero exit.

Commit: `feat(workbench): open arbitrary remote workspaces`

---

### Task 3B: Rehydrate local Zotero tabs across remote workspace reloads

**Files:**
- Modify: `services/zotero-core/protocol/chatero-core.protocol.json`
- Modify: `services/zotero-core/generated/protocol.mjs`
- Modify: `services/zotero-core/generated/protocol.d.ts`
- Modify: `chrome/content/zotero/modules/chateroCoreProtocol.mjs`
- Modify: `chrome/content/zotero/xpcom/chateroCoreLibraryAdapter.mjs`
- Modify: `chrome/content/zotero/xpcom/chateroCoreRequestRouter.mjs`
- Modify: `services/zotero-core/fixture/fixture-core.mjs`
- Modify: `products/workbench/extensions/chatero-zotero/library-tree-model.mjs`
- Modify: `products/workbench/extensions/chatero-zotero/evidence-editor-registry.mjs`
- Modify: `products/workbench/extensions/chatero-zotero/evidence-editors.cjs`
- Modify: `products/workbench/extensions/chatero-zotero/extension.cjs`
- Modify: `products/workbench/tests/zotero-evidence-editors.test.mjs`

**Interfaces:**
- Produces Core request `library.attachment({libraryId,attachmentKey})`, returning the existing trusted attachment-summary shape.
- Produces strict canonical evidence-URI parsing to `{kind,libraryId,key}` and lazy `EvidenceDocumentRegistry.resolveOrHydrate(uri, kind, resolver)`.
- Produces a single-flight `ensureCore()` so restored PDF and Note editors cannot race-start multiple Core instances.

- [ ] **Step 1: Write failing extension-host restart and identity tests**

Reset the evidence registry after staging PDF and Note documents, then restore both solely from their canonical custom-editor URIs. Assert the PDF path is fetched from Core, neither URI nor extension state contains that path, two simultaneous restorations start Core once, a missing/deleted item fails without rebinding, and a remote workspace never converts the local PDF `file:` URI to the remote authority.

- [ ] **Step 2: Add direct attachment lookup to the Core protocol**

Add and regenerate `library.attachment`. The Gecko adapter must fetch by exact `(libraryId, attachmentKey)`, require a file attachment, and return the same frozen validated summary used by item children. The request remains under `library:read`; no renderer reads `zotero.sqlite`.

- [ ] **Step 3: Implement lazy trusted rehydration**

Strictly parse the canonical custom-document URI. On a registry miss, `openCustomDocument` awaits single-flight Core startup, fetches the exact Note or attachment, verifies the returned identity byte-for-byte, stages the frozen record, and resolves it. If profile/Core configuration is missing, offer the existing setup action; never persist attachment paths, records, PDF bytes, or Note HTML in global state.

- [ ] **Step 4: Run restoration and Core protocol tests and commit**

Run: `npm run core:check && node --test services/zotero-core/tests/*.test.mjs products/workbench/tests/zotero-evidence-editors.test.mjs`

Commit: `fix(workbench): restore local Zotero tabs after remote reload`

---

### Task 4: Native remote Codex runtime and policy

**Files:**
- Create: `products/workbench/patches/code-oss/0003-chatero-native-codex.patch`
- Create: `products/workbench/tests/remote-agent-runtime.test.mjs`
- Modify: `products/workbench/patches/code-oss/series.json`
- Modify: `products/workbench/remote-agent/scripts/build-linux-agent.mjs`
- Modify: `products/workbench/extensions/chatero-remote/package.json`
- Modify: `products/workbench/product.chatero.json`
- Modify: `products/workbench/tests/upstream-copilot-quarantine.test.mjs`
- Modify: `products/workbench/tests/patch-series.test.mjs`

**Interfaces:**
- The signed release contains Code-OSS REH plus architecture-matched `agent-sdk/codex/node_modules/@openai/codex` and its Linux native package at exactly 0.142.0.
- `chatero-server --agent-host-path=<socket>` spawns and bridges the built-in Agent Host; no `chatero-agent` extension exists.
- Native Chat exposes Codex without requiring Copilot sign-in and defaults to OpenAI authentication only.
- Native command `chatero.chat.attachTextContext` adds one explicit, visible, removable `Simple` attachment to the current Chat input.

- [ ] **Step 1: Write failing runtime, SDK, policy, and attachment-command tests**

Assert the pinned server contains `agentHostMain` and registers `agentHostProxy`; Node Agent Host inherits the parent Codex env even when login-shell resolution is empty; Codex usage source defaults/falls back to `openai`; signed-out OpenAI never falls back to Copilot; Codex chat does not require Copilot sign-in; and the explicit attachment command creates one `kind:"string"` entry without sending it.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test products/workbench/tests/remote-agent-{release,runtime}.test.mjs products/workbench/tests/{patch-series,upstream-copilot-quarantine}.test.mjs`

- [ ] **Step 3: Verify the patched checkout and embed the exact Codex SDK before signing**

The canonical bootstrapped checkout is intentionally modified by the pinned Chatero patch series, product overlay, and first-party extensions. Validate its `.chatero-provenance.json` with the existing `verifyCodeOss` gate instead of requiring an empty Git porcelain; alternatively build a fresh isolated clone and apply the same verified materialization. Reuse the pinned Code-OSS `build/agent-sdk/agents/codex` lock and packaging helpers without running their Microsoft CDN upload/production scripts. The x64 release must contain `@openai/codex-linux-x64`; arm64 must contain `@openai/codex-linux-arm64`, with no wrong-architecture native package beside it. Inject the Code-OSS MIT `LICENSE.txt`, `ThirdPartyNotices.txt`, and the missing ripgrep MIT/Unlicense notice for Codex's bundled `rg` into each release. Verify the expected ELF architecture, executable bits for Codex and `rg`, licenses/notices, and `codex --version` on a native runner. Hash/sign only after SDK and notices are injected.

- [ ] **Step 4: Patch Agent Host policy and native Chat attachment**

Patch `NodeAgentHostStarter` to inherit parent env before shell env and SDK env. Make OpenAI the Codex default/fallback, prohibit silent Copilot fallback, and set `requiresCopilotSignIn:false` for Codex. Add the narrowly-scoped explicit text-context command; it accepts exact bounded fields, adds a visible attachment, focuses Chat, and never auto-sends. Add extension `configurationDefaults` for Agent Host on, Codex on, Codex preferred, Codex multi-root on, BYOK off.

- [ ] **Step 5: Run Task 4 tests and commit**

Commit: `feat(workbench): run native Codex on remote workspaces`

---

### Task 5: Selectable PDF.js evidence in native Chat

**Files:**
- Create: `products/workbench/extensions/chatero-zotero/pdf-context-broker.mjs`
- Create: `products/workbench/extensions/chatero-zotero/pdf-context-format.mjs`
- Create: `products/workbench/tests/zotero-pdf-context.test.mjs`
- Modify: `products/workbench/extensions/chatero-zotero/media/pdf-viewer/pdf-viewer.mjs`
- Modify: `products/workbench/extensions/chatero-zotero/evidence-editor-html.mjs`
- Modify: `products/workbench/extensions/chatero-zotero/evidence-editors.cjs`
- Modify: `products/workbench/extensions/chatero-zotero/extension.cjs`
- Modify: `products/workbench/extensions/chatero-zotero/package.json`
- Modify: `products/workbench/first-party-extensions.json`
- Modify: `products/workbench/product.chatero.json`
- Modify: `products/workbench/tests/zotero-evidence-editors.test.mjs`

**Interfaces:**
- Produces `PdfContextBroker.update(documentUri, trustedRecord, panelNonce, payload)` and `capture(documentUri): PdfEvidenceSnapshot`.
- Snapshot keys are exactly `kind`, `libraryId`, `attachmentKey`, `title`, `pageIndex`, `pageLabel`, `selectedText`, `pageText`, `annotations`, and `capturedAt`.
- Contributes `Zotero PDF evidence` to native Add Context and commands `chatero.zotero.addPdfContextToChat` and `chatero.zotero.sendFullPaperToRemote`.

- [ ] **Step 1: Write failing boundary, multi-tab, and editor-message tests**

Assert UTF-8 byte limits, deep immutability, no local path/PDF bytes, authoritative identity from `document.record`, nonce plus monotonic-sequence rejection, independent simultaneous PDF tabs, and no passive send on focus/page changes.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test products/workbench/tests/zotero-{pdf-context,evidence-editors}.test.mjs`

- [ ] **Step 3: Render a selectable PDF.js text layer**

For each page call `page.getTextContent()` and render PDF.js `TextLayer` above the canvas and below noninteractive Zotero highlights. On page render and debounced `selectionchange`, post only `{type:"pdf-context",panelNonce,sequence,pageIndex,pageLabel,pageText,selectedText}`. On Meta-K with nonempty selection request explicit Chat attachment. Never post a PDF URI or authoritative Zotero identity.

- [ ] **Step 4: Register explicit native Chat context**

Use `vscode.chat.registerChatAttachContextProvider` with the `chatContextProvider` proposal to expose the frozen active/last PDF snapshot through Add Context. The PDF command and Meta-K call `chatero.chat.attachTextContext`; no custom chat view or history store is added. Format content as escaped `<chatero-context trust="untrusted-evidence">` and label remote chips `Local Zotero → <SSH alias>`.

- [ ] **Step 5: Run Task 5 tests and commit**

Run: `node --test products/workbench/tests/zotero-{pdf-context,evidence-editors}.test.mjs products/workbench/tests/first-party-extensions.test.mjs`

Commit: `feat(workbench): attach bounded Zotero PDF evidence`

---

### Task 6: Explicit complete-paper remote cache

**Files:**
- Create: `products/workbench/remote-agent/runtime/chatero-evidence-cache.mjs`
- Create: `products/workbench/extensions/chatero-remote/evidence-cache.mjs`
- Create: `products/workbench/extensions/chatero-zotero/authorized-pdf-source.mjs`
- Create: `products/workbench/tests/chatero-remote-evidence-cache.test.mjs`
- Modify: `products/workbench/remote-agent/scripts/build-linux-agent.mjs`
- Modify: `products/workbench/remote-agent/scripts/stage-release.mjs`
- Modify: `products/workbench/extensions/chatero-remote/extension.cjs`
- Modify: `products/workbench/extensions/chatero-zotero/extension.cjs`

**Interfaces:**
- Produces a 256-bit, 60-second, single-use, target-bound Zotero evidence grant only after modal confirmation. The grant holds an already-open read-only file source and is never a path capability.
- Produces `stageEvidence({grantId,targetId,ttlSeconds:86400}, signal): Promise<{kind:"remote-pdf-cache",digest,size,expiresAt,targetId,remotePath}>`; `sourcePath`, arbitrary URI, and arbitrary byte-source fields are rejected.
- Produces `revokeEvidence({digest,targetId}, signal): Promise<void>` and `cleanupExpiredEvidence(session): Promise<number>`.
- Only `chatero-zotero` may issue/redeem a grant from an exact rehydrated attachment identity after confirmation; native Chat receives a bounded simple attachment containing only opaque identity, expiry, and the canonical remote path.

- [ ] **Step 1: Write failing explicit-grant and cache-transaction tests**

Assert ordinary selection context never stages bytes; decline opens no cache channel; random, expired, wrong-target, and reused grants fail; the remote API rejects `sourcePath`; confirmed staging writes outside the workspace; local paths never enter SSH/log/result/Chat data; local and remote SHA-256 match; expiry is exactly 24 hours; cancellation deletes `.part`; reconnect resumes only a matching prefix/fingerprint; and revoke is target-bound, idempotent, and wins a concurrent finalize race.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test products/workbench/tests/chatero-remote-evidence-cache.test.mjs`

- [ ] **Step 3: Implement the signed fixed cache helper**

The helper accepts only fixed `stage`, `revoke`, and `cleanup` operations, lowercase 64-hex digest, decimal size, random transfer ID, and exact `86400` TTL. It constructs `~/.cache/chatero/evidence/` itself, rejects symlinks/hardlinks/non-regular files, uses owner-only directories and `0600` files, resumes only after local and remote prefix digests match, streams/hash-checks stdin, publishes without replacing an existing final, and emits strict bounded JSON. Per-digest state/locking makes revoke invalidate in-flight finalize. It never accepts a workspace path or arbitrary shell command. Every session runs cleanup before the authority becomes usable; an expiry watcher plus next-connect cleanup handles powered-off hosts.

- [ ] **Step 4: Add confirmation, native Chat chip, expiry, and revoke**

Rehydrate the exact attachment through Zotero Core, open/fix the local handle, then confirm paper title, SSH alias, byte count, cache scope, and expiry. The Zotero extension issues the one-use grant and the Remote extension redeems it; errors never include the local path. After staging, call `chatero.chat.attachTextContext` with an injection-aware message referencing only `remote-cache://<digest>` and `@<canonical remote path>`. The title is display-only. Missing, revoked, or expired cache becomes unavailable and is never re-uploaded silently; revoke also removes an unsent chip through `chatero.chat.removeTextContext`.

- [ ] **Step 5: Run Task 6 tests and commit**

Run: `node --test products/workbench/tests/chatero-remote-evidence-cache.test.mjs products/workbench/tests/zotero-pdf-context.test.mjs products/workbench/tests/remote-agent-release.test.mjs`

Commit: `feat(workbench): stage explicit remote PDF evidence`

---

### Task 7: Release, fixture acceptance, documentation, and regression gates

**Files:**
- Create: `.github/workflows/chatero-remote-agent.yml`
- Create: `products/workbench/tests/fixtures/fake-ssh.mjs`
- Create: `products/workbench/tests/remote-zotero-codex.integration.test.mjs`
- Create: `docs/chatero/remote-ssh-and-zotero-context.md`
- Modify: `products/workbench/scripts/verify-code-oss.mjs`
- Modify: `products/workbench/tests/workbench-policy.test.mjs`
- Modify: `products/workbench/tests/bootstrap-code-oss.integration.test.mjs`
- Modify: `products/workbench/README.md`
- Modify: `package.json`

**Interfaces:**
- Produces a deterministic fake-SSH fixture that exercises the same argv, framed process, install, managed connection, and reconnect paths without using a personal host.
- Produces CI matrix artifacts `chatero-agent-linux-x86_64.tar.gz` and `chatero-agent-linux-aarch64.tar.gz`, then one signed release manifest using the protected signing secret.
- Adds `npm run verify:remote-zotero-codex` as the focused product gate.

- [ ] **Step 1: Write the failing end-to-end fixture test**

```js
test("local PDF selection reaches remote Codex in an empty SSH workspace", async () => {
  const system = await startFixture({remotePath:"/srv/empty",pathExists:false});
  await system.confirmCreate();
  system.pdf.select({pageIndex:6,text:"the bounded claim"});
  await system.nativeChat.send("Check this claim against the code");
  assert.equal(system.remote.workspace.created, true);
  assert.equal(system.remote.codex.cwd, "/srv/empty");
  assert.match(system.remote.codex.prompt, /the bounded claim/);
  assert.doesNotMatch(system.remote.codex.prompt, /Users\/|zotero\.sqlite|\.pdf/);
});
```

Also drop the managed connection, reconnect, and prove local PDF context/history survive while stale remote output is ignored.

- [ ] **Step 2: Run the fixture test and confirm RED**

Run: `node --test products/workbench/tests/remote-zotero-codex.integration.test.mjs`

Expected: FAIL until all extension wiring and fixture adapters are present.

- [ ] **Step 3: Add Linux matrix build and signing workflow**

Use `ubuntu-24.04` matrix values `x64` and `arm64`, bootstrap the exact pinned Code-OSS commit, run Task 1's build script, retain Code-OSS/Node licenses and notices, and upload unsigned architecture artifacts. A final protected job downloads both, reads `CHATERO_REMOTE_AGENT_SIGNING_KEY`, runs `stage-release.mjs`, and publishes archives plus `manifest.json` and `manifest.sig` to a Chatero GitHub release. Fork pull requests run build/tests but never receive or use the signing secret.

- [ ] **Step 4: Add product verification and user documentation**

`workbench:verify` must fail if `chatero.remote` lacks the resolver proposal allowlist, `chatero.zotero` lacks the chat-context proposal allowlist, either built-in is absent, the native Codex/OpenAI policy patch is absent, a Microsoft Remote-SSH identifier/endpoint appears, or a packaged release manifest is unsigned/wrong-commit. Document connect, first authentication, arbitrary/empty folder behavior, remote Codex probe/login, bounded PDF context, explicit full-paper transfer/revoke, logs, reconnection, and the fact that Zotero/profile/PDF remain local by default.

- [ ] **Step 5: Run focused and full regression gates**

Run:

```bash
npm run core:check
npm run test:zotero-core
npm run test:chatero
npm run test:workbench-bootstrap
npm run verify:remote-zotero-codex
npm run workbench:verify
```

Expected: every suite PASS. Then bootstrap a fresh ignored Code-OSS checkout and run `npm run workbench:compile`; expected TypeScript error count is zero.

- [ ] **Step 6: Commit the release and acceptance slice**

Commit: `test(workbench): gate remote Zotero Codex bridge`

---

## Plan self-review

- Spec coverage: release supply chain, both Linux architectures, system OpenSSH, native Code-OSS authority, terminal/Git/LSP ownership, arbitrary and empty folders, remote Codex, bounded PDF selection/page text, explicit complete-paper transfer, reconnect, history survival, security, product wiring, CI, docs, and regressions each map to a task.
- Placeholder scan: this plan contains no deferred implementation marker; every required behavior has a file, interface, failing test, implementation step, and verification command.
- Type consistency: `chatero-remote` owns transport, installation, workspace selection, `runProcess`, `stageEvidence`, and `revokeEvidence`; `chatero-zotero` owns authorized local evidence; native Code-OSS Agent Host/Codex owns conversations, prompts, approvals, tools, history, and changesets.
