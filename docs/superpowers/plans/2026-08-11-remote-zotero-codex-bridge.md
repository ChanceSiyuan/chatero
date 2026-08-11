# Remote Zotero–Codex Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chatero open arbitrary local or SSH Linux workspaces, run Codex beside the active workspace, and explicitly bridge bounded local Zotero PDF context to a remote turn without exposing local paths.

**Architecture:** A local built-in `chatero-remote` extension resolves a normal Code-OSS remote authority using system OpenSSH and a signed, commit-matched Code-OSS Remote Agent. A local built-in `chatero-agent` extension owns conversations and delegates execution to the active authority. The existing local `chatero-zotero` PDF editor captures selectable PDF.js text and sends immutable bounded snapshots to the Agent only after a user gesture; complete PDFs use an explicit digest-addressed remote cache transaction.

**Tech Stack:** Code-OSS 1.132 proposed resolver API, Node.js 24 ESM/CommonJS, system OpenSSH, Code-OSS REH server, Ed25519 signatures, SHA-256, PDF.js, Codex CLI JSONL, Node test runner.

## Global Constraints

- Preserve Zotero's profile, sync, Note, annotation, citation, attachment, and Reader behavior; Zotero Core remains the only profile writer.
- Never read or write `zotero.sqlite` from Electron renderers or extensions.
- Never commit personal Zotero profiles, Knowledge, Drafts, Literature, chat history, credentials, research output, generated Code-OSS checkouts, Remote Agent archives, or signing private keys.
- Do not add Microsoft Marketplace endpoints, Pylance, Microsoft Remote-SSH code/binaries/services, or Microsoft product branding.
- Use Open VSX and a Chatero-built Code-OSS Remote Agent for Linux `x86_64` and `aarch64` at exact Code-OSS commit `df53daabb18cd157bdb08c7f01c34df936cf12f4`.
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

Probe with the fixed command `uname -s; uname -m; uname -r` and accept only Linux `x86_64|amd64` or `aarch64|arm64`. Select the exact signed artifact from Task 1. Resume an interrupted upload from the verified `.part` byte count, verify remote SHA-256, extract into a sibling temporary directory, then atomically rename to `~/.chatero-server/bin/<commit>/<tuple>/`. Never write in the selected workspace. Create an owner-only token file below `~/.chatero-server/data/<commit>/` and launch `bin/chatero-server --host=127.0.0.1 --port=0 --connection-token-file=<file>`.

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

Contribute `Chatero: Connect to SSH…`, `Chatero: Open Remote Folder…`, `Chatero: Reconnect`, and `Chatero: Show Remote Log`. Show recent targets first, then concrete SSH aliases, then “Add user@host…”. Prompt for an absolute remote path. For a missing path show `Create empty folder on <alias>?` with the full path; cancel performs no write. Reject existing files. Open with `vscode.openFolder(vscode.Uri.parse("vscode-remote://<authority><encoded path>"), {forceNewWindow:false})` and let normal Code-OSS workspace trust run.

Persist only alias/opaque target id, last path, and host fingerprint in extension global state. Do not persist passwords, tokens, key contents, or PDF context.

- [ ] **Step 4: Implement framed remote process execution**

Open only the fixed installed bridge path through the authenticated SSH master. Send one bounded request frame, map base64 stdout/stderr frames to the observer, enforce one terminal exit, and on cancellation close the channel and make the bridge terminate/reap the child process group. Canonicalize `cwd` remotely and reject a result outside the selected root for workspace-scoped calls.

- [ ] **Step 5: Add status and error UX**

Use the normal lower-left Remote indicator plus a `Chatero Remote` status bar item showing connecting, connected alias, reconnecting, or error. Every error action opens the redacted output channel. Disconnect must not close local Zotero custom editors or delete recent targets.

- [ ] **Step 6: Run Task 3 tests and commit**

Run: `node --test products/workbench/tests/chatero-remote-{workspace,process}.test.mjs`

Expected: all tests PASS, including missing-declined, file-at-path, control characters, stale epoch, cancellation, malformed frame, and nonzero exit.

Commit: `feat(workbench): open arbitrary remote workspaces`

---

### Task 4: Selectable PDF.js evidence snapshots

**Files:**
- Create: `products/workbench/extensions/chatero-zotero/pdf-context-broker.mjs`
- Create: `products/workbench/tests/zotero-pdf-context.test.mjs`
- Modify: `products/workbench/extensions/chatero-zotero/media/pdf-viewer/pdf-viewer.mjs`
- Modify: `products/workbench/extensions/chatero-zotero/evidence-editor-html.mjs`
- Modify: `products/workbench/extensions/chatero-zotero/evidence-editors.cjs`
- Modify: `products/workbench/extensions/chatero-zotero/extension.cjs`
- Modify: `products/workbench/extensions/chatero-zotero/package.json`
- Modify: `products/workbench/first-party-extensions.json`
- Modify: `products/workbench/tests/zotero-evidence-editors.test.mjs`

**Interfaces:**
- Produces `PdfContextBroker.update(record, payload)` and `captureActive({preferSelection}): PdfEvidenceSnapshot`.
- Snapshot keys are exactly `kind`, `libraryId`, `attachmentKey`, `title`, `pageIndex`, `pageLabel`, `selectedText`, `pageText`, and `capturedAt`.
- Produces commands `chatero.zotero.addPdfContextToAgent` and `chatero.zotero.sendFullPaperToRemote` available only for an active authorized PDF editor.

- [ ] **Step 1: Write failing context boundary and editor-message tests**

```js
test("PDF context is immutable, byte bounded, and path free", () => {
  const snapshot = broker.update(attachmentWithPrivatePath, {
    pageIndex: 2, pageLabel: "3", selectedText: "x".repeat(40_000), pageText: "y".repeat(140_000)
  });
  assert.ok(Buffer.byteLength(snapshot.selectedText) <= 32 * 1024);
  assert.ok(Buffer.byteLength(snapshot.pageText) <= 128 * 1024);
  assert.equal(JSON.stringify(snapshot).includes("/tmp/private"), false);
  assert.ok(Object.isFrozen(snapshot));
});
```

Assert the provider ignores webview-supplied `libraryId`, `attachmentKey`, `path`, and `title`, and uses only the authorized record from `EvidenceDocumentRegistry`.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test products/workbench/tests/zotero-{pdf-context,evidence-editors}.test.mjs`

Expected: FAIL because the broker and text-layer message flow do not exist.

- [ ] **Step 3: Render a selectable PDF.js text layer**

For each rendered page call `page.getTextContent()` and render PDF.js `TextLayer` into a positioned `.text-layer` above the canvas and below noninteractive Zotero highlights. Preserve normal selection. On page render and debounced `selectionchange`, post `{type:"pdf-context",pageIndex,pageLabel,pageText,selectedText}`. On `Meta+K` with a nonempty selection post the same payload with `openAgent:true`. Never post the PDF URI.

- [ ] **Step 4: Implement the local broker and user gesture**

Track the active provider panel via `onDidChangeViewState`. Apply UTF-8-safe truncation at the exact global limits and freeze every snapshot. `addPdfContextToAgent` captures the active snapshot then executes `chatero.agent.addContext`; no context moves merely because focus or page changes. A missing/deleted item remains an unavailable identity rather than rebinding to another PDF.

- [ ] **Step 5: Run Task 4 tests and commit**

Run: `node --test products/workbench/tests/zotero-{pdf-context,evidence-editors}.test.mjs`

Expected: all tests PASS and existing PDF annotation navigation remains green.

Commit: `feat(workbench): capture bounded PDF evidence`

---

### Task 5: Authority-scoped Codex Agent and chat surface

**Files:**
- Create: `products/workbench/extensions/chatero-agent/package.json`
- Create: `products/workbench/extensions/chatero-agent/extension.cjs`
- Create: `products/workbench/extensions/chatero-agent/context-manifest.mjs`
- Create: `products/workbench/extensions/chatero-agent/codex-runner.mjs`
- Create: `products/workbench/extensions/chatero-agent/conversation-store.mjs`
- Create: `products/workbench/extensions/chatero-agent/agent-view.cjs`
- Create: `products/workbench/extensions/chatero-agent/agent-view-html.mjs`
- Create: `products/workbench/extensions/chatero-agent/media/agent.svg`
- Create: `products/workbench/tests/chatero-agent-context.test.mjs`
- Create: `products/workbench/tests/chatero-agent-runner.test.mjs`
- Create: `products/workbench/tests/chatero-agent-manifest.test.mjs`
- Modify: `products/workbench/first-party-extensions.json`

**Interfaces:**
- Produces `buildContextManifest({workspace,resources,grants})` and `renderPrompt(manifest,userText)`.
- Produces `CodexRunner.run(turn, observer, signal)` that snapshots authority/root at Send and uses local `spawn` for local workspaces or `chatero.remote.runProcess` for SSH workspaces.
- Produces commands `chatero.agent.open`, `chatero.agent.addContext`, `chatero.agent.newConversation`, and `chatero.agent.cancelTurn`.
- Conversation storage records messages, authority/root identity, and stable context metadata; it omits context text/bytes, paths from Zotero, tokens, and credentials.

- [ ] **Step 1: Write failing manifest, prompt, runner, and history tests**

```js
test("remote turn receives bounded evidence but never a local path", async () => {
  const turn = makeTurn({ authority:"chatero-remote+lab", pdf:{ selectedText:"claim", localPath:"/Users/me/paper.pdf" } });
  await runner.run(turn, observer, signal);
  assert.equal(remote.request.cwd, "/srv/work");
  assert.match(remote.request.args.at(-1), /claim/);
  assert.doesNotMatch(JSON.stringify(remote.request), /\/Users\/me|paper\.pdf/);
});

test("focus changes do not move or cancel an in-flight turn", async () => {
  const running = runner.run(makeTurn({authority:"chatero-remote+lab"}), observer, signal);
  workspaceAuthority = "local";
  await remote.finish();
  await running;
  assert.equal(remote.cancelled, false);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test products/workbench/tests/chatero-agent-{context,runner,manifest}.test.mjs`

Expected: FAIL because the Agent extension does not exist.

- [ ] **Step 3: Implement immutable context manifests and prompt framing**

Treat all resource text as untrusted evidence. Render:

```text
<chatero-context trust="untrusted-evidence" authority="chatero-remote+lab">
[PDF selection · ABCD1234 · page 7]
bounded text
</chatero-context>

<user-request>
the user's request
</user-request>
```

Escape literal closing tags in evidence and user text, enforce the Task 4 limits again, and reject resources whose stable identity or authority does not match the captured turn. Context chips are removable before Send and visibly label `Local Zotero → <SSH alias>`.

- [ ] **Step 4: Implement local/remote Codex execution and cancellation**

Use exact argv `codex exec --json -C <canonical root> --sandbox workspace-write <rendered prompt>` and `shell:false`. Probe the executable before enabling Send. Parse Codex JSONL into one ordered stream of assistant text, reasoning/status, tool activity, error, and terminal exit. A turn owns its AbortController and process/channel; changing PDF, editor, Agent conversation tab, or workspace focus does not cancel it. Cancel kills only that turn.

If remote Codex is absent or unauthenticated, show actions to open a remote integrated terminal for installation or `codex login --device-auth`; do not collect credentials in the Agent webview.

- [ ] **Step 5: Implement the Chatero Agent view**

Use a workbench view with conversation tabs, history button, context chips, streaming transcript, input, Send, and Stop. It may float/pin through existing workbench layout behavior, but this task must at minimum remain usable beside a PDF and source editor. `Command-K` from the PDF opens it with the captured context; Code-OSS editor selection uses `window.activeTextEditor.selection` and the same command. Persist history in extension global storage, never in the repository.

- [ ] **Step 6: Materialize the extension and run Task 5 tests**

Run: `node --test products/workbench/tests/chatero-agent-{context,runner,manifest}.test.mjs products/workbench/tests/first-party-extensions.test.mjs`

Expected: all tests PASS, with one assistant message per streamed event and no duplicate output.

Commit: `feat(workbench): run Codex on the active authority`

---

### Task 6: Explicit complete-paper remote cache

**Files:**
- Create: `products/workbench/extensions/chatero-remote/evidence-cache.mjs`
- Create: `products/workbench/tests/chatero-remote-evidence-cache.test.mjs`
- Modify: `products/workbench/extensions/chatero-remote/extension.cjs`
- Modify: `products/workbench/extensions/chatero-zotero/extension.cjs`
- Modify: `products/workbench/extensions/chatero-zotero/evidence-editors.cjs`
- Modify: `products/workbench/extensions/chatero-agent/context-manifest.mjs`

**Interfaces:**
- Produces `stageEvidence({sourcePath,libraryId,attachmentKey,targetId,ttlSeconds}, signal): Promise<{kind:"remote-pdf-cache",digest,size,expiresAt,targetId}>`.
- Produces `revokeEvidence({digest,targetId}, signal): Promise<void>` and `cleanupExpiredEvidence(session): Promise<number>`.
- Only `chatero-zotero` may initiate staging from an authorized active attachment record, after confirmation; the Agent receives only the returned opaque cache record.

- [ ] **Step 1: Write failing explicit-grant and cache-transaction tests**

```js
test("ordinary Send never stages the full PDF", async () => {
  await agent.send({ resources:[boundedPdfSelection] });
  assert.equal(remote.stageCalls.length, 0);
});

test("confirmed staging verifies digest and stores outside the workspace", async () => {
  const record = await cache.stageEvidence(request, signal);
  assert.match(remote.finalPath, /^~\/\.cache\/chatero\/evidence\/[a-f0-9]{64}\.pdf$/);
  assert.equal(remote.workspaceWrites.length, 0);
  assert.equal(record.expiresAt - now, 24 * 60 * 60 * 1000);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test products/workbench/tests/chatero-remote-evidence-cache.test.mjs`

Expected: FAIL because `evidence-cache.mjs` does not exist.

- [ ] **Step 3: Implement local hash, resumable upload, remote verification, and revoke**

Show one confirmation containing paper title, target alias, byte size, remote cache scope, and 24-hour expiry. Hash the authorized local file with streaming SHA-256. Upload to `<digest>.pdf.part`, resume only when the remote prefix size is valid, verify remote size and SHA-256, then atomically rename. The remote helper accepts only lowercase 64-hex digests, decimal sizes, and bounded TTL; it constructs the cache path itself. On cancellation or mismatch delete `.part`. Revoke deletes only that digest. Cleanup deletes expired cache records without following symlinks.

- [ ] **Step 4: Add opaque full-paper context and UI state**

After a successful transaction execute `chatero.agent.addContext` with the opaque `remote-pdf-cache` record and display expiry plus Revoke. The prompt may identify the remote cache URI but must not include the original local path. Missing/expired cache becomes an unavailable chip and is never silently re-uploaded.

- [ ] **Step 5: Run Task 6 tests and commit**

Run: `node --test products/workbench/tests/chatero-remote-evidence-cache.test.mjs products/workbench/tests/chatero-agent-context.test.mjs products/workbench/tests/zotero-pdf-context.test.mjs`

Expected: all tests PASS, including decline, cancel, bad prefix, bad digest, symlink refusal, expiry, revoke idempotence, and target mismatch.

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
  await system.agent.send("Check this claim against the code");
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

`workbench:verify` must fail if `chatero.remote` lacks the resolver proposal allowlist, either built-in is absent, a Microsoft Remote-SSH identifier/endpoint appears, or a packaged release manifest is unsigned/wrong-commit. Document connect, first authentication, arbitrary/empty folder behavior, remote Codex probe/login, bounded PDF context, explicit full-paper transfer/revoke, logs, reconnection, and the fact that Zotero/profile/PDF remain local by default.

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
- Type consistency: `chatero-remote` owns `runProcess`, `stageEvidence`, and `revokeEvidence`; `chatero-zotero` owns authorized local evidence; `chatero-agent` owns manifests/conversations and consumes only those interfaces.
