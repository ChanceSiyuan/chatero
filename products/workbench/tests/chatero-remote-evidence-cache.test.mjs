import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  AuthorizedPdfSourceRegistry,
  openAuthorizedPdfSource,
} from "../extensions/chatero-zotero/authorized-pdf-source.mjs";
import {
  EvidenceCacheService,
  assertRevokeEvidenceRequest,
  assertStageEvidenceRequest,
  makeRemoteCacheAttachment,
  runSimpleProtocol,
  runStageProtocol,
} from "../extensions/chatero-remote/evidence-cache.mjs";
import {
  makeRemoteInstallRelativePath,
  REMOTE_AGENT_SCRIPTS,
  RemoteAgentInstaller,
} from "../extensions/chatero-remote/remote-agent-installer.mjs";
import { decodeAuthority, encodeAuthority } from "../extensions/chatero-remote/authority.mjs";
import {
  writeInstallTreeManifest,
} from "../remote-agent/runtime/chatero-install-integrity.mjs";

const TARGET_ID = "profile:lab-a";
const OTHER_TARGET_ID = "profile:lab-b";
const FINGERPRINT = `SHA256:${"A".repeat(43)}`;
const OTHER_FINGERPRINT = `SHA256:${"B".repeat(43)}`;
const DIGEST = createHash("sha256").update("paper").digest("hex");
const HELPER_PATH = fileURLToPath(new URL("../remote-agent/runtime/chatero-evidence-cache.mjs", import.meta.url));
const INSTALL_INTEGRITY_HELPER_PATH = fileURLToPath(new URL(
  "../remote-agent/runtime/chatero-install-integrity.mjs",
  import.meta.url,
));
const linuxTest = process.platform === "linux" ? test : test.skip;

function runShell(script, args, { home, env = {}, input = null } = {}) {
  const child = spawn("sh", ["-c", script, "chatero", ...args], {
    env: { ...process.env, HOME: home, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", bytes => stdout.push(Buffer.from(bytes)));
  child.stderr.on("data", bytes => stderr.push(Buffer.from(bytes)));
  if (input === null) child.stdin.end();
  else child.stdin.end(input);
  return once(child, "close").then(([code, signal]) => ({
    code,
    signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  }));
}

function runLocal(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const stderr = [];
  child.stderr.on("data", bytes => stderr.push(Buffer.from(bytes)));
  return once(child, "close").then(([code, signal]) => {
    if (code !== 0 || signal) {
      throw new Error(`${command} failed: ${Buffer.concat(stderr).toString("utf8")}`);
    }
  });
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function refreshInstallIntegrity(root) {
  const rootMode = (await lstat(root)).mode & 0o7777;
  const markerPath = join(root, ".chatero-release-sha256");
  let markerBytes = null;
  try {
    markerBytes = await readFile(markerPath);
    await rm(markerPath);
  }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rm(join(root, "integrity"), { recursive: true, force: true });
  const manifest = await writeInstallTreeManifest({ root });
  await chmod(root, rootMode);
  if (markerBytes !== null) await writeFile(markerPath, markerBytes, { mode: 0o600 });
  return Object.freeze({
    treeManifestSha256: manifest.treeManifestSha256,
    nodeSha256: await sha256File(join(root, "node")),
    integrityVerifierSha256: await sha256File(join(root, "bin", "chatero-install-integrity.mjs")),
  });
}

function integrityArguments(fixture) {
  return [
    fixture.treeManifestSha256,
    fixture.nodeSha256,
    fixture.integrityVerifierSha256,
  ];
}

async function makeInstallArchive(home, {
  commit = "a".repeat(40),
  transactionId = "1".repeat(24),
  tuple = "linux-x86_64",
  markerSymlink = null,
} = {}) {
  const rootName = `chatero-agent-${tuple}`;
  const source = join(home, `source-${transactionId}`);
  const root = join(source, rootName);
  const architecture = tuple === "linux-x86_64"
    ? { packageName: "codex-linux-x64", triple: "x86_64-unknown-linux-musl" }
    : { packageName: "codex-linux-arm64", triple: "aarch64-unknown-linux-musl" };
  const vendor = join(
    root,
    "agent-sdk", "codex", "node_modules", "@openai", architecture.packageName,
    "vendor", architecture.triple,
  );
  const directories = [
    join(root, "bin"),
    join(root, "agent-sdk", "codex", "node_modules", ".bin"),
    join(root, "agent-sdk", "codex", "node_modules", "@openai", "codex", "bin"),
    join(vendor, "bin"),
    join(vendor, "codex-path"),
  ];
  for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o755 });
  for (const file of [
    join(root, "bin", "chatero-server"),
    join(root, "bin", "chatero-process-bridge.mjs"),
    join(root, "bin", "chatero-evidence-cache.mjs"),
    join(root, "agent-sdk", "codex", "node_modules", "@openai", "codex", "bin", "codex.js"),
    join(vendor, "bin", "codex"),
    join(vendor, "codex-path", "rg"),
  ]) {
    await writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  await writeFile(join(root, "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  await writeFile(
    join(root, "bin", "chatero-install-integrity.mjs"),
    await readFile(INSTALL_INTEGRITY_HELPER_PATH),
    { mode: 0o755 },
  );
  await symlink(
    "../@openai/codex/bin/codex.js",
    join(root, "agent-sdk", "codex", "node_modules", ".bin", "codex"),
  );
  if (markerSymlink) await symlink(markerSymlink, join(root, ".chatero-release-sha256"));
  const integrity = await refreshInstallIntegrity(root);
  const archive = join(home, `archive-${transactionId}.tar.gz`);
  await runLocal("tar", ["-czf", archive, "-C", source, rootName]);
  const archiveBytes = await readFile(archive);
  const digest = createHash("sha256").update(archiveBytes).digest("hex");
  const transactionRoot = join(home, ".chatero-server", "transactions", commit);
  for (const directory of [
    join(home, ".chatero-server"),
    join(home, ".chatero-server", "transactions"),
    transactionRoot,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const partRelativePath = `.chatero-server/transactions/${commit}/${transactionId}.part`;
  await writeFile(join(home, partRelativePath), archiveBytes, { mode: 0o600 });
  return Object.freeze({
    archiveBytes,
    commit,
    digest,
    installRelativePath: `.chatero-server/artifacts-v1/${digest}/${commit}/${tuple}`,
    partRelativePath,
    rootName,
    tuple,
    ...integrity,
  });
}

function controlledSource(bytes = Buffer.from("%PDF-1.7\nfixture\n")) {
  let closed = 0;
  const value = Object.freeze({
    size: bytes.length,
    async read(offset, length) {
      return Uint8Array.from(bytes.subarray(offset, offset + length));
    },
    async close() {
      closed += 1;
    },
  });
  return { value, get closed() { return closed; } };
}

test("PDF grants are 256-bit, 60-second, single-use, target and fingerprint bound", async () => {
  let now = 1_000_000;
  let randomCalls = 0;
  const source = controlledSource();
  const registry = new AuthorizedPdfSourceRegistry({
    now: () => now,
    randomBytes: size => {
      assert.equal(size, 32);
      randomCalls += 1;
      return Buffer.alloc(32, 6 + randomCalls);
    },
  });

  const grantId = registry.issue({
    source: source.value,
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
  });
  assert.equal(randomCalls, 1);
  assert.match(grantId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(registry), "{}");

  const redeemed = registry.redeem({ grantId,
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
  });
  assert.deepEqual(Object.keys(redeemed).sort(), ["close", "read", "size"]);
  assert.equal(redeemed.size, source.value.size);
  assert.deepEqual(Buffer.from(await redeemed.read(0, redeemed.size)), Buffer.from("%PDF-1.7\nfixture\n"));
  assert.throws(() => registry.redeem({ grantId,
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
  }), /unavailable/i);
  await redeemed.close();
  assert.equal(source.closed, 1);

  const expiredSource = controlledSource();
  const expired = registry.issue({
    source: expiredSource.value,
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
  });
  now += 60_000;
  assert.throws(() => registry.redeem({ grantId: expired,
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
  }), /unavailable/i);
  await registry.drain();
  assert.equal(expiredSource.closed, 1);
});

test("wrong target or fingerprint consumes the grant and closes its source", async () => {
  for (const binding of [
    { targetId: OTHER_TARGET_ID, hostFingerprint: FINGERPRINT },
    { targetId: TARGET_ID, hostFingerprint: OTHER_FINGERPRINT },
  ]) {
    const source = controlledSource();
    const registry = new AuthorizedPdfSourceRegistry();
    const grantId = registry.issue({
      source: source.value,
      targetId: TARGET_ID,
      hostFingerprint: FINGERPRINT,
    });
    assert.throws(() => registry.redeem({ grantId, ...binding }), /unavailable/i);
    await registry.drain();
    assert.equal(source.closed, 1);
    assert.throws(() => registry.redeem({ grantId,
      targetId: TARGET_ID,
      hostFingerprint: FINGERPRINT,
    }), /unavailable/i);
  }
});

test("registry revocation and deactivation close pending and redeemed sources exactly once", async () => {
  const pending = controlledSource();
  const active = controlledSource();
  const registry = new AuthorizedPdfSourceRegistry();
  registry.issue({ source: pending.value, targetId: TARGET_ID, hostFingerprint: FINGERPRINT });
  const activeId = registry.issue({ source: active.value, targetId: TARGET_ID, hostFingerprint: FINGERPRINT });
  const redeemed = registry.redeem({ grantId: activeId, targetId: TARGET_ID, hostFingerprint: FINGERPRINT });

  await registry.revokePending();
  assert.equal(pending.closed, 1);
  assert.equal(active.closed, 0);
  await registry.dispose();
  assert.equal(active.closed, 1);
  await redeemed.close();
  await registry.dispose();
  assert.equal(active.closed, 1);
});

test("grant redemption rejects every non-capability field before consuming the grant", async () => {
  const source = controlledSource();
  const registry = new AuthorizedPdfSourceRegistry();
  const grantId = registry.issue({ source: source.value, targetId: TARGET_ID, hostFingerprint: FINGERPRINT });
  for (const extra of [
    { sourcePath: "/private/paper.pdf" },
    { uri: "file:///private/paper.pdf" },
    { fd: 7 },
    { handle: {} },
  ]) {
    assert.throws(() => registry.redeem({
      grantId,
      targetId: TARGET_ID,
      hostFingerprint: FINGERPRINT,
      ...extra,
    }), /unavailable/i);
  }
  assert.equal(source.closed, 0);
  const redeemed = registry.redeem({ grantId, targetId: TARGET_ID, hostFingerprint: FINGERPRINT });
  await redeemed.close();
  assert.equal(source.closed, 1);
});

test("public cache API accepts only exact target-bound request shapes", () => {
  assert.deepEqual(assertStageEvidenceRequest({
    grantId: "A".repeat(43),
    targetId: TARGET_ID,
    ttlSeconds: 86400,
  }), {
    grantId: "A".repeat(43),
    targetId: TARGET_ID,
    ttlSeconds: 86400,
  });
  assert.deepEqual(assertRevokeEvidenceRequest({ digest: DIGEST, targetId: TARGET_ID }), {
    digest: DIGEST,
    targetId: TARGET_ID,
  });

  for (const request of [
    { grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400, sourcePath: "/Users/alice/paper.pdf" },
    { grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400, uri: "file:///private/paper.pdf" },
    { grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400, source: {} },
    { grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400, hostFingerprint: FINGERPRINT },
    { grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 1 },
  ]) {
    assert.throws(() => assertStageEvidenceRequest(request), /request/i);
  }
  assert.throws(() => assertRevokeEvidenceRequest({
    digest: DIGEST,
    targetId: TARGET_ID,
    sourcePath: "/private/paper.pdf",
  }), /request/i);
  assert.throws(() => assertStageEvidenceRequest({
    grantId: `${"A".repeat(42)}B`,
    targetId: TARGET_ID,
    ttlSeconds: 86400,
  }), /request/i);
});

test("remote authority preserves the full 255-character concrete alias bound", () => {
  const maximum = `profile:${"a".repeat(255)}`;
  assert.equal(decodeAuthority(encodeAuthority(maximum)), maximum);
  assert.throws(() => encodeAuthority(`profile:${"a".repeat(256)}`), /target id/i);
});

test("invalid public requests are rejected before session, Zotero, or SSH lookup", async () => {
  const effects = [];
  const service = new EvidenceCacheService({
    getContext: async () => { effects.push("session"); },
    getZoteroApi: async () => { effects.push("zotero"); },
    reconnect: async () => { effects.push("reconnect"); },
  });
  await assert.rejects(service.stageEvidence({
    grantId: "A".repeat(43),
    targetId: TARGET_ID,
    ttlSeconds: 86400,
    sourcePath: "/private/local-paper.pdf",
  }), /request/i);
  await assert.rejects(service.stageEvidence({
    grantId: "A".repeat(43),
    targetId: TARGET_ID,
    ttlSeconds: 86400,
    hostFingerprint: FINGERPRINT,
  }), /request/i);
  assert.deepEqual(effects, []);
  await service.dispose();
});

test("local PDF source delegates only to the bounded Core attachment capability", async () => {
  const calls = [];
  const bytes = Buffer.from("%PDF fixture");
  const source = await openAuthorizedPdfSource(Object.freeze({
    attachmentKey: "ABCD1234",
    contentType: "application/pdf",
    libraryId: 1,
  }), {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "attachment.open") return { expiresAt: Date.now() + 60_000, size: bytes.length, sourceId: Buffer.alloc(32, 3).toString("base64url") };
      if (method === "attachment.read") return { bytesBase64url: bytes.subarray(params.offset, params.offset + params.length).toString("base64url"), eof: true };
      if (method === "attachment.close") return { closed: true };
    },
  });
  assert.deepEqual(Object.keys(source).sort(), ["close", "read", "size"]);
  assert.doesNotMatch(JSON.stringify(source), /private|Zotero|paper\.pdf/);
  assert.deepEqual(await source.read(0, bytes.length), Uint8Array.from(bytes));
  await source.close();
  assert.deepEqual(calls.map(value => value.method), ["attachment.open", "attachment.read", "attachment.close"]);
});

test("grant issuance failures close the already-open source", async () => {
  for (const registry of [new AuthorizedPdfSourceRegistry(), new AuthorizedPdfSourceRegistry()]) {
    const source = controlledSource();
    assert.throws(() => registry.issue({
      source: source.value,
      targetId: ".bad",
      hostFingerprint: FINGERPRINT,
    }));
    await registry.drain();
    assert.equal(source.closed, 1);
  }
  const entropyFailure = controlledSource();
  const entropyRegistry = new AuthorizedPdfSourceRegistry({ randomBytes: () => Buffer.alloc(31) });
  assert.throws(() => entropyRegistry.issue({
    source: entropyFailure.value,
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
  }), /entropy/);
  await entropyRegistry.drain();
  assert.equal(entropyFailure.closed, 1);
});

test("a spent grant id is never reissued to a different PDF source", async () => {
  const entropy = Buffer.alloc(32, 11);
  const registry = new AuthorizedPdfSourceRegistry({ randomBytes: () => entropy });
  const first = controlledSource(Buffer.from("first PDF"));
  const firstId = registry.issue({ source: first.value, targetId: TARGET_ID, hostFingerprint: FINGERPRINT });
  const redeemed = registry.redeem({ grantId: firstId, targetId: TARGET_ID, hostFingerprint: FINGERPRINT });
  await redeemed.close();
  const second = controlledSource(Buffer.from("second PDF"));
  assert.throws(() => registry.issue({
    source: second.value,
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
  }), /unique/i);
  await registry.drain();
  assert.equal(second.closed, 1);
});

test("pending revocation and expiry never let an old capability id become valid again", async () => {
  let now = 0;
  const registry = new AuthorizedPdfSourceRegistry({
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 12),
  });
  const first = controlledSource();
  const oldId = registry.issue({ source: first.value, targetId: TARGET_ID, hostFingerprint: FINGERPRINT });
  await registry.revokePending();
  now += 10 * 86400_000;
  const replacement = controlledSource();
  assert.throws(() => registry.issue({
    source: replacement.value,
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
  }), /unique/i);
  await registry.drain();
  assert.equal(replacement.closed, 1);
  assert.throws(() => registry.redeem({
    grantId: oldId,
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
  }), /unavailable/i);
  await registry.dispose();
});

test("remote cache Chat attachment contains only cache identity, expiry, and canonical remote path", () => {
  const result = Object.freeze({
    kind: "remote-pdf-cache",
    digest: DIGEST,
    size: 19,
    expiresAt: "2026-08-12T00:00:00.000Z",
    targetId: TARGET_ID,
    remotePath: `/home/alice/.cache/chatero/evidence/${DIGEST}.${"e".repeat(64)}.pdf`,
  });
  const attachment = makeRemoteCacheAttachment(result);
  assert.deepEqual(Object.keys(attachment).sort(), ["label", "text"]);
  assert.equal(attachment.label, `Remote PDF cache ${DIGEST.slice(0, 12)}`);
  assert.match(attachment.text, new RegExp(`remote-cache://${DIGEST}`));
  assert.match(attachment.text, new RegExp(result.expiresAt.replaceAll(".", "\\.")));
  assert.match(attachment.text, new RegExp(result.remotePath.replaceAll("/", "\\/")));
  assert.doesNotMatch(JSON.stringify(attachment), /Zotero|paper title|Users\/|libraryId|attachmentKey/i);
  for (const control of ["\t", "\u001b", "\u007f", "\u0085", "\u2028", "\u2029"]) {
    assert.throws(() => makeRemoteCacheAttachment({
      ...result,
      remotePath: `/home/alice${control}/.cache/chatero/evidence/${DIGEST}.${"e".repeat(64)}.pdf`,
    }), /canonical path/i);
  }
});

test("Remote Agent installation path is immutable per signed artifact digest", () => {
  const commit = "a".repeat(40);
  const first = makeRemoteInstallRelativePath(commit, "linux-x86_64", "b".repeat(64));
  const upgraded = makeRemoteInstallRelativePath(commit, "linux-x86_64", "c".repeat(64));
  assert.equal(first, `.chatero-server/artifacts-v1/${"b".repeat(64)}/${commit}/linux-x86_64`);
  assert.notEqual(first, upgraded);
});

linuxTest("real install probe rejects symlinked executables and hardlinked fixed helpers", async t => {
  const home = await mkdtemp(join(tmpdir(), "chatero-install-probe-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const commit = "a".repeat(40);
  const digest = "b".repeat(64);
  const relative = `.chatero-server/artifacts-v1/${digest}/${commit}/linux-x86_64`;
  const root = join(home, relative);
  const nativePackage = join(root, "agent-sdk", "codex", "node_modules", "@openai", "codex-linux-x64");
  const native = join(nativePackage, "vendor", "x86_64-unknown-linux-musl");
  const directories = [
    join(home, ".chatero-server"),
    join(home, ".chatero-server", "artifacts-v1"),
    join(home, ".chatero-server", "artifacts-v1", digest),
    join(home, ".chatero-server", "artifacts-v1", digest, commit),
    root,
    join(root, "bin"),
    join(root, "agent-sdk"),
    join(root, "agent-sdk", "codex"),
    join(root, "agent-sdk", "codex", "node_modules"),
    join(root, "agent-sdk", "codex", "node_modules", ".bin"),
    join(root, "agent-sdk", "codex", "node_modules", "@openai"),
    join(root, "agent-sdk", "codex", "node_modules", "@openai", "codex"),
    join(root, "agent-sdk", "codex", "node_modules", "@openai", "codex", "bin"),
    nativePackage,
    join(nativePackage, "vendor"),
    native,
    join(native, "bin"),
    join(native, "codex-path"),
  ];
  for (const directory of directories) {
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o700);
  }
  const executables = [
    join(root, "bin", "chatero-server"),
    join(root, "bin", "chatero-process-bridge.mjs"),
    join(root, "bin", "chatero-evidence-cache.mjs"),
    join(native, "bin", "codex"),
    join(native, "codex-path", "rg"),
  ];
  for (const path of executables) await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const nodeBytes = Buffer.from(`#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  await writeFile(join(root, "node"), nodeBytes, { mode: 0o755 });
  await writeFile(
    join(root, "bin", "chatero-install-integrity.mjs"),
    await readFile(INSTALL_INTEGRITY_HELPER_PATH),
    { mode: 0o755 },
  );
  const launcher = join(root, "agent-sdk", "codex", "node_modules", "@openai", "codex", "bin", "codex.js");
  await writeFile(launcher, "#!/usr/bin/env node\n", { mode: 0o755 });
  await symlink("../@openai/codex/bin/codex.js", join(root, "agent-sdk", "codex", "node_modules", ".bin", "codex"));
  const integrity = await refreshInstallIntegrity(root);
  await chmod(root, 0o700);
  await writeFile(join(root, ".chatero-release-sha256"), `${digest}\n`, { mode: 0o600 });
  const probe = () => runShell(REMOTE_AGENT_SCRIPTS.probeInstalled, [
    relative,
    digest,
    ...integrityArguments(integrity),
  ], { home });
  assert.equal((await probe()).stdout.trim(), "ready");
  const linkedHome = join(home, "linked-home");
  await symlink(".", linkedHome);
  assert.equal((await runShell(REMOTE_AGENT_SCRIPTS.probeInstalled, [
    relative,
    digest,
    ...integrityArguments(integrity),
  ], {
    home: linkedHome,
  })).stdout.trim(), "ready");

  await unlink(join(root, "node"));
  await symlink("/bin/true", join(root, "node"));
  assert.equal((await probe()).stdout.trim(), "missing");
  await unlink(join(root, "node"));
  await writeFile(join(root, "node"), nodeBytes, { mode: 0o755 });

  await chmod(join(root, "node"), 0o777);
  assert.equal((await probe()).stdout.trim(), "missing");
  await chmod(join(root, "node"), 0o755);

  const external = join(home, "external-helper");
  await writeFile(external, "#!/bin/sh\n", { mode: 0o755 });
  await unlink(join(root, "bin", "chatero-evidence-cache.mjs"));
  await link(external, join(root, "bin", "chatero-evidence-cache.mjs"));
  assert.equal((await probe()).stdout.trim(), "missing");
});

linuxTest("real finalize installs into a disjoint digest root and leaves a legacy install untouched", async t => {
  const home = await mkdtemp(join(tmpdir(), "chatero-install-finalize-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fixture = await makeInstallArchive(home);
  const legacy = join(home, ".chatero-server", "bin", fixture.commit, fixture.tuple);
  await mkdir(legacy, { recursive: true, mode: 0o755 });
  await chmod(legacy, 0o755);
  const sentinel = join(legacy, "legacy-sentinel");
  await writeFile(sentinel, "legacy unchanged\n", { mode: 0o644 });
  const legacyBefore = await lstat(legacy);

  const finalized = await runShell(REMOTE_AGENT_SCRIPTS.finalize, [
    fixture.partRelativePath,
    fixture.installRelativePath,
    fixture.rootName,
    fixture.digest,
    ...integrityArguments(fixture),
  ], { home });
  assert.equal(finalized.code, 0, finalized.stderr);
  assert.equal(await readFile(sentinel, "utf8"), "legacy unchanged\n");
  const legacyAfter = await lstat(legacy);
  assert.equal(legacyAfter.ino, legacyBefore.ino);
  assert.equal(legacyAfter.mode & 0o777, 0o755);
  assert.equal((await runShell(REMOTE_AGENT_SCRIPTS.probeInstalled, [
    fixture.installRelativePath,
    fixture.digest,
    ...integrityArguments(fixture),
  ], { home })).stdout.trim(), "ready");
  await assert.rejects(lstat(join(home, fixture.partRelativePath)), error => error?.code === "ENOENT");
});

linuxTest("real finalize replaces a tampered immutable cache only from the signed archive", async t => {
  const home = await mkdtemp(join(tmpdir(), "chatero-install-repair-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fixture = await makeInstallArchive(home);
  const args = [
    fixture.partRelativePath,
    fixture.installRelativePath,
    fixture.rootName,
    fixture.digest,
    ...integrityArguments(fixture),
  ];
  const first = await runShell(REMOTE_AGENT_SCRIPTS.finalize, args, { home });
  assert.equal(first.code, 0, first.stderr);

  const installedServer = join(home, fixture.installRelativePath, "bin", "chatero-server");
  await writeFile(installedServer, "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  assert.equal((await runShell(REMOTE_AGENT_SCRIPTS.probeInstalled, [
    fixture.installRelativePath,
    fixture.digest,
    ...integrityArguments(fixture),
  ], { home })).stdout.trim(), "missing");

  await writeFile(join(home, fixture.partRelativePath), fixture.archiveBytes, { mode: 0o600 });
  const repaired = await runShell(REMOTE_AGENT_SCRIPTS.finalize, args, { home });
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.equal(await readFile(installedServer, "utf8"), "#!/bin/sh\nexit 0\n");
  assert.equal((await runShell(REMOTE_AGENT_SCRIPTS.probeInstalled, [
    fixture.installRelativePath,
    fixture.digest,
    ...integrityArguments(fixture),
  ], { home })).stdout.trim(), "ready");
});

linuxTest("real finalize rejects an artifact-ancestor symlink without writing or chmodding outside HOME", async t => {
  const home = await mkdtemp(join(tmpdir(), "chatero-install-ancestor-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fixture = await makeInstallArchive(home);
  const outside = join(home, "outside-artifacts");
  await mkdir(outside, { mode: 0o755 });
  const sentinel = join(outside, "sentinel");
  await writeFile(sentinel, "outside unchanged\n", { mode: 0o644 });
  await symlink(outside, join(home, ".chatero-server", "artifacts-v1"));
  const result = await runShell(REMOTE_AGENT_SCRIPTS.finalize, [
    fixture.partRelativePath,
    fixture.installRelativePath,
    fixture.rootName,
    fixture.digest,
    ...integrityArguments(fixture),
  ], { home });
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(sentinel, "utf8"), "outside unchanged\n");
  assert.equal((await lstat(outside)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(outside), ["sentinel"]);
});

linuxTest("real finalize never replaces a destination inserted at its publish boundary", async t => {
  const home = await mkdtemp(join(tmpdir(), "chatero-install-noclobber-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fixture = await makeInstallArchive(home);
  const wrappers = join(home, "wrappers");
  await mkdir(wrappers, { mode: 0o700 });
  const mvWrapper = join(wrappers, "mv");
  await writeFile(mvWrapper, [
    "#!/bin/sh",
    "last=",
    "for argument do last=$argument; done",
    "/bin/mkdir -m 700 \"$last\"",
    "/usr/bin/printf '%s\\n' raced >\"$last/race-sentinel\"",
    "exec /usr/bin/mv \"$@\"",
    "",
  ].join("\n"), { mode: 0o755 });
  const result = await runShell(REMOTE_AGENT_SCRIPTS.finalize, [
    fixture.partRelativePath,
    fixture.installRelativePath,
    fixture.rootName,
    fixture.digest,
    ...integrityArguments(fixture),
  ], { home, env: { PATH: `${wrappers}:/usr/bin:/bin` } });
  assert.notEqual(result.code, 0);
  const destination = join(home, fixture.installRelativePath);
  assert.equal(await readFile(join(destination, "race-sentinel"), "utf8"), "raced\n");
  assert.deepEqual((await readdir(destination)).sort(), ["race-sentinel"]);
  const parentEntries = await readdir(join(destination, ".."));
  assert.equal(parentEntries.some(name => name.startsWith(".installing.")), false);
});

linuxTest("the next finalize recovers an installing directory left by a killed owner", async t => {
  const home = await mkdtemp(join(tmpdir(), "chatero-install-recover-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fixture = await makeInstallArchive(home);
  const wrappers = join(home, "kill-wrappers");
  await mkdir(wrappers, { mode: 0o700 });
  await writeFile(join(wrappers, "tar"), [
    "#!/bin/sh",
    "kill -9 \"$PPID\"",
    "exit 99",
    "",
  ].join("\n"), { mode: 0o755 });
  const killed = await runShell(REMOTE_AGENT_SCRIPTS.finalize, [
    fixture.partRelativePath,
    fixture.installRelativePath,
    fixture.rootName,
    fixture.digest,
    ...integrityArguments(fixture),
  ], { home, env: { PATH: `${wrappers}:/usr/bin:/bin` } });
  assert.notEqual(killed.code, 0);
  const parent = join(home, fixture.installRelativePath, "..");
  assert.equal((await readdir(parent)).some(name => name.startsWith(".installing.")), true);

  const recovered = await runShell(REMOTE_AGENT_SCRIPTS.finalize, [
    fixture.partRelativePath,
    fixture.installRelativePath,
    fixture.rootName,
    fixture.digest,
    ...integrityArguments(fixture),
  ], { home });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal((await readdir(parent)).some(name => name.startsWith(".installing.")), false);
  assert.equal((await runShell(REMOTE_AGENT_SCRIPTS.probeInstalled, [
    fixture.installRelativePath,
    fixture.digest,
    ...integrityArguments(fixture),
  ], { home })).stdout.trim(), "ready");
});

linuxTest("finalize rejects a same-second archive mutation across extraction", async t => {
  const home = await mkdtemp(join(tmpdir(), "chatero-install-live-archive-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fixture = await makeInstallArchive(home);
  const wrappers = join(home, "touch-wrappers");
  await mkdir(wrappers, { mode: 0o700 });
  await writeFile(join(wrappers, "tar"), [
    "#!/bin/sh",
    "/usr/bin/touch \"$2\"",
    "exec /usr/bin/tar \"$@\"",
    "",
  ].join("\n"), { mode: 0o755 });
  const result = await runShell(REMOTE_AGENT_SCRIPTS.finalize, [
    fixture.partRelativePath,
    fixture.installRelativePath,
    fixture.rootName,
    fixture.digest,
    ...integrityArguments(fixture),
  ], { home, env: { PATH: `${wrappers}:/usr/bin:/bin` } });
  assert.equal(result.code, 76, result.stderr);
  await assert.rejects(lstat(join(home, fixture.installRelativePath)), error => error?.code === "ENOENT");
});

linuxTest("remote upload transaction scripts reject hardlinks and symlinks without touching the source", async t => {
  const home = await mkdtemp(join(tmpdir(), "chatero-install-part-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const commit = "a".repeat(40);
  const transaction = "2".repeat(24);
  const relative = `.chatero-server/transactions/${commit}/${transaction}.part`;
  const parent = join(home, ".chatero-server", "transactions", commit);
  for (const directory of [
    join(home, ".chatero-server"),
    join(home, ".chatero-server", "transactions"),
    parent,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const external = join(home, "external-part");
  await writeFile(external, "signed bytes", { mode: 0o600 });
  await link(external, join(home, relative));
  assert.notEqual((await runShell(REMOTE_AGENT_SCRIPTS.partSize, [relative, "100"], { home })).code, 0);
  assert.notEqual((await runShell(REMOTE_AGENT_SCRIPTS.upload, [relative, "12"], {
    home,
    input: Buffer.from(" attacker"),
  })).code, 0);
  assert.equal(await readFile(external, "utf8"), "signed bytes");
  await unlink(join(home, relative));
  await symlink(external, join(home, relative));
  assert.notEqual((await runShell(REMOTE_AGENT_SCRIPTS.partSize, [relative, "100"], { home })).code, 0);
  assert.equal(await readFile(external, "utf8"), "signed bytes");

  const liveTransaction = "4".repeat(24);
  const liveRelative = `.chatero-server/transactions/${commit}/${liveTransaction}.part`;
  const livePart = join(home, liveRelative);
  const victim = join(home, "live-swap-victim");
  await writeFile(livePart, "signed bytes", { mode: 0o600 });
  await writeFile(victim, "victim", { mode: 0o600 });
  const wrappers = join(home, "upload-wrappers");
  await mkdir(wrappers, { mode: 0o700 });
  await writeFile(join(wrappers, "cat"), [
    "#!/bin/sh",
    "/bin/mv \"$CHATERO_PART\" \"$CHATERO_PART.old\"",
    "/bin/ln \"$CHATERO_VICTIM\" \"$CHATERO_PART\"",
    "exec /bin/cat \"$@\"",
    "",
  ].join("\n"), { mode: 0o755 });
  const swapped = await runShell(REMOTE_AGENT_SCRIPTS.upload, [liveRelative, "12"], {
    home,
    env: {
      PATH: `${wrappers}:/usr/bin:/bin`,
      CHATERO_PART: livePart,
      CHATERO_VICTIM: victim,
    },
    input: Buffer.from("-APPEND"),
  });
  assert.notEqual(swapped.code, 0);
  assert.equal(await readFile(victim, "utf8"), "victim");
  assert.equal(await readFile(`${livePart}.old`, "utf8"), "signed bytes-APPEND");
});

linuxTest("remote finalize refuses an archive-provided release marker symlink", async t => {
  const home = await mkdtemp(join(tmpdir(), "chatero-install-marker-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sentinel = join(home, "marker-sentinel");
  await writeFile(sentinel, "do not overwrite\n", { mode: 0o600 });
  const fixture = await makeInstallArchive(home, {
    transactionId: "3".repeat(24),
    markerSymlink: sentinel,
  });
  const result = await runShell(REMOTE_AGENT_SCRIPTS.finalize, [
    fixture.partRelativePath,
    fixture.installRelativePath,
    fixture.rootName,
    fixture.digest,
    ...integrityArguments(fixture),
  ], { home });
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(sentinel, "utf8"), "do not overwrite\n");
  await assert.rejects(lstat(join(home, fixture.installRelativePath)), error => error?.code === "ENOENT");
});

linuxTest("remote finalize refuses to publish an archive under a different architecture leaf", async t => {
  const home = await mkdtemp(join(tmpdir(), "chatero-install-tuple-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fixture = await makeInstallArchive(home);
  const mismatched = fixture.installRelativePath.replace(/linux-x86_64$/u, "linux-aarch64");
  const result = await runShell(REMOTE_AGENT_SCRIPTS.finalize, [
    fixture.partRelativePath,
    mismatched,
    fixture.rootName,
    fixture.digest,
    ...integrityArguments(fixture),
  ], { home });
  assert.notEqual(result.code, 0);
  await assert.rejects(lstat(join(home, mismatched)), error => error?.code === "ENOENT");
});

linuxTest("createRuntime kills an unready server and removes transaction secrets on failure or cancellation", async t => {
  const home = await mkdtemp(join(tmpdir(), "chatero-runtime-cleanup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const fixture = await makeInstallArchive(home);
  const finalized = await runShell(REMOTE_AGENT_SCRIPTS.finalize, [
    fixture.partRelativePath,
    fixture.installRelativePath,
    fixture.rootName,
    fixture.digest,
    ...integrityArguments(fixture),
  ], { home });
  assert.equal(finalized.code, 0, finalized.stderr);
  const runtimeBase = join(home, "runtime-base");
  await mkdir(runtimeBase, { mode: 0o700 });
  const installedRoot = join(home, fixture.installRelativePath);
  const server = join(installedRoot, "bin", "chatero-server");
  const pidFile = join(home, "delayed-server.pid");
  await writeFile(server, [
    "#!/bin/sh",
    "printf '%s\\n' \"$$\" >\"$CHATERO_TEST_PID_FILE\"",
    "trap 'exit 0' HUP INT TERM",
    "while :; do sleep 1; done",
    "",
  ].join("\n"), { mode: 0o755 });
  let runtimeIntegrity = await refreshInstallIntegrity(installedRoot);
  const child = spawn("sh", [
    "-c", REMOTE_AGENT_SCRIPTS.createRuntime, "chatero",
    fixture.installRelativePath, fixture.tuple, ...integrityArguments(runtimeIntegrity),
  ], {
    env: {
      ...process.env,
      HOME: home,
      XDG_RUNTIME_DIR: runtimeBase,
      CHATERO_TEST_PID_FILE: pidFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end("temporary-token\n");
  let serverPid;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      serverPid = Number((await readFile(pidFile, "utf8")).trim());
      break;
    }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await delay(5);
    }
  }
  assert.ok(Number.isSafeInteger(serverPid), "the delayed server started");
  t.after(() => { try { process.kill(serverPid, "SIGKILL"); } catch (_) {} });
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "close"),
    delay(2_000).then(() => { throw new Error("createRuntime did not terminate"); }),
  ]);
  assert.throws(() => process.kill(serverPid, 0), error => error?.code === "ESRCH");
  assert.deepEqual(await readdir(join(runtimeBase, "chatero")), []);

  const readyPidFile = join(home, "ready-server.pid");
  await writeFile(server, [
    "#!/bin/sh",
    "printf '%s\\n' \"$$\" >\"$CHATERO_TEST_PID_FILE\"",
    "printf '%s\\n' 'Extension host agent listening on 43123'",
    "trap 'exit 0' HUP INT TERM",
    "while :; do sleep 1; done",
    "",
  ].join("\n"), { mode: 0o755 });
  runtimeIntegrity = await refreshInstallIntegrity(installedRoot);
  const longRuntime = join(home, "x".repeat(90));
  const ready = await runShell(
    REMOTE_AGENT_SCRIPTS.createRuntime,
    [fixture.installRelativePath, fixture.tuple, ...integrityArguments(runtimeIntegrity)],
    {
      home,
      env: { XDG_RUNTIME_DIR: longRuntime, CHATERO_TEST_PID_FILE: readyPidFile },
      input: Buffer.from("temporary-token\n"),
    },
  );
  assert.equal(ready.code, 0, ready.stderr);
  const [port, socket, installPath] = ready.stdout.trim().split("\n");
  assert.equal(port, "43123");
  assert.ok(Buffer.byteLength(socket) <= 100);
  assert.equal(installPath, join(home, fixture.installRelativePath));
  const readyPid = Number((await readFile(readyPidFile, "utf8")).trim());
  t.after(() => { try { process.kill(readyPid, "SIGKILL"); } catch (_) {} });
  process.kill(readyPid, "SIGTERM");

  await writeFile(server, "#!/bin/sh\nexit 9\n", { mode: 0o755 });
  runtimeIntegrity = await refreshInstallIntegrity(installedRoot);
  const failed = await runShell(
    REMOTE_AGENT_SCRIPTS.createRuntime,
    [fixture.installRelativePath, fixture.tuple, ...integrityArguments(runtimeIntegrity)],
    { home, env: { XDG_RUNTIME_DIR: runtimeBase }, input: Buffer.from("temporary-token\n") },
  );
  assert.notEqual(failed.code, 0);
  assert.deepEqual(await readdir(join(runtimeBase, "chatero")), []);
});

test("the evidence helper is injected and verified as a fixed signed payload", async () => {
  const [build, stage] = await Promise.all([
    readFile(new URL("../remote-agent/scripts/build-linux-agent.mjs", import.meta.url), "utf8"),
    readFile(new URL("../remote-agent/scripts/stage-release.mjs", import.meta.url), "utf8"),
  ]);
  for (const source of [build, stage]) {
    assert.match(source, /chatero-evidence-cache\.mjs/);
  }
  assert.match(stage, /assertRegularPayloadFile\([^)]*chatero-evidence-cache/s);
});

class FakeEvidenceChannel {
  constructor(onWrite = () => {}) {
    this.onWrite = onWrite;
    this.dataListeners = new Set();
    this.closeListeners = new Set();
    this.writes = [];
    this.ended = 0;
    this.closed = 0;
  }

  write(bytes) {
    const value = Buffer.from(bytes);
    this.writes.push(value);
    this.onWrite(JSON.parse(value.toString("utf8")), this);
    return true;
  }

  drain() { return Promise.resolve(); }
  end() { this.ended += 1; }
  close() { this.closed += 1; this.emitClose({ code: null, signal: "SIGTERM", error: null }); }
  onData(listener) { this.dataListeners.add(listener); return { dispose: () => this.dataListeners.delete(listener) }; }
  onClose(listener) { this.closeListeners.add(listener); return { dispose: () => this.closeListeners.delete(listener) }; }
  emit(value) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    queueMicrotask(() => { for (const listener of [...this.dataListeners]) listener(bytes); });
  }
  emitRaw(value) {
    queueMicrotask(() => { for (const listener of [...this.dataListeners]) listener(Buffer.from(value)); });
  }
  emitClose(result = { code: 0, signal: null, error: null }) {
    queueMicrotask(() => { for (const listener of [...this.closeListeners]) listener(result); });
  }
}

test("client rejects a channel close before resume without hanging", async () => {
  const source = controlledSource(Buffer.from("paper"));
  const channel = new FakeEvidenceChannel((_frame, value) => value.emitClose({ code: 255, signal: null, error: null }));
  await assert.rejects(runStageProtocol(channel, {
    digest: DIGEST,
    source: source.value,
    transferId: "5".repeat(32),
    ttlSeconds: 86400,
    targetId: TARGET_ID,
  }), error => error?.code === "SSH_TRANSPORT");
});

test("cancelling while waiting for resume consumes resume, confirms abort, and never hangs", async () => {
  const controller = new AbortController();
  const source = controlledSource(Buffer.from("paper"));
  const channel = new FakeEvidenceChannel((frame, value) => {
    if (frame.type === "abort") {
      value.emit({
        type: "resume",
        offset: 0,
        prefixDigest: createHash("sha256").digest("hex"),
      });
      value.emit({ type: "aborted" });
      value.emitClose();
    }
  });
  const running = runStageProtocol(channel, {
    digest: DIGEST,
    source: source.value,
    transferId: "6".repeat(32),
    ttlSeconds: 86400,
    targetId: TARGET_ID,
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort(new Error("/private/path must not leak"));
  await assert.rejects(running, error => {
    assert.equal(error.name, "AbortError");
    assert.doesNotMatch(error.message, /private|path/);
    return true;
  });
  assert.equal(channel.ended, 1);
  assert.equal(channel.writes.some(value => value.toString().includes('"type":"abort"')), true);
});

test("cancellation after an accepted backpressured request queues abort without waiting for drain", async () => {
  const controller = new AbortController();
  const source = controlledSource(Buffer.from("paper"));
  const channel = new FakeEvidenceChannel((frame, value) => {
    if (frame.type === "abort") {
      value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
      value.emit({ type: "aborted" });
      value.emitClose();
    }
  });
  const originalWrite = channel.write.bind(channel);
  channel.write = bytes => {
    const frame = JSON.parse(Buffer.from(bytes).toString("utf8"));
    originalWrite(bytes);
    return frame.operation === "stage" ? false : true;
  };
  channel.drain = () => new Promise(() => {});
  const running = runStageProtocol(channel, {
    digest: DIGEST,
    source: source.value,
    transferId: "9".repeat(32),
    ttlSeconds: 86400,
    targetId: TARGET_ID,
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(Promise.race([
    running,
    delay(500).then(() => { throw new Error("cancellation hung behind drain"); }),
  ]), error => error?.name === "AbortError");
  assert.equal(channel.writes.some(value => value.toString().includes('"type":"abort"')), true);
});

test("a synchronous finalize write failure remains abortable and deletes the part", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const source = controlledSource(bytes);
  const channel = new FakeEvidenceChannel((frame, value) => {
    if (frame.operation === "stage") {
      value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
    }
    if (frame.type === "finalize") throw new Error("finalize was not handed to transport");
    if (frame.type === "abort") {
      value.emit({ type: "aborted" });
      value.emitClose();
    }
  });
  await assert.rejects(runStageProtocol(channel, {
    digest,
    source: source.value,
    transferId: "0".repeat(32),
    ttlSeconds: 86400,
    targetId: TARGET_ID,
  }), /not handed/);
  assert.equal(channel.writes.some(value => value.toString().includes('"type":"abort"')), true);
});

test("simple requests finish after handoff even if backpressure never drains", async () => {
  const channel = new FakeEvidenceChannel((_frame, value) => {
    value.emit({ type: "revoked" });
    value.emitClose();
  });
  channel.write = bytes => {
    FakeEvidenceChannel.prototype.write.call(channel, bytes);
    return false;
  };
  channel.drain = () => new Promise(() => {});
  await Promise.race([
    runSimpleProtocol(channel, { protocolVersion: 1, operation: "revoke", digest: DIGEST }, undefined, "revoked"),
    delay(500).then(() => { throw new Error("simple helper request hung behind drain"); }),
  ]);
});

test("terminal helper requests never consult drain after the frame is accepted", async () => {
  const simple = new FakeEvidenceChannel((_frame, value) => {
    value.emit({ type: "revoked" });
    value.emitClose();
  });
  simple.write = bytes => {
    FakeEvidenceChannel.prototype.write.call(simple, bytes);
    return false;
  };
  simple.drain = () => { throw new Error("drain must not be observed"); };
  await runSimpleProtocol(
    simple,
    { protocolVersion: 1, operation: "revoke", digest: DIGEST },
    undefined,
    "revoked",
  );

  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const source = controlledSource(bytes);
  const finalized = new FakeEvidenceChannel((frame, value) => {
    if (frame.operation === "stage") {
      value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
    }
    if (frame.type === "finalize") {
      value.emit({
        type: "complete",
        createdAt: "2099-01-01T00:00:00.000Z",
        digest,
        size: bytes.length,
        expiresAt: "2099-01-02T00:00:00.000Z",
        remotePath: `/home/alice/.cache/chatero/evidence/${digest}.${"a".repeat(64)}.pdf`,
      });
      value.emitClose();
    }
  });
  const originalWrite = finalized.write.bind(finalized);
  finalized.write = frameBytes => {
    const frame = JSON.parse(Buffer.from(frameBytes).toString("utf8"));
    originalWrite(frameBytes);
    return frame.type === "finalize" ? false : true;
  };
  finalized.drain = () => { throw new Error("drain must not be observed after finalize"); };
  await runStageProtocol(finalized, {
    digest,
    source: source.value,
    transferId: "3".repeat(32),
    ttlSeconds: 86400,
    targetId: TARGET_ID,
  });
  assert.equal(finalized.writes.some(value => value.toString().includes('"type":"abort"')), false);
});

test("an accepted backpressured finalize waits for complete instead of drain", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const source = controlledSource(bytes);
  const channel = new FakeEvidenceChannel((frame, value) => {
    if (frame.operation === "stage") {
      value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
    }
    if (frame.type === "finalize") {
      value.emit({
        type: "complete",
        createdAt: "2099-01-01T00:00:00.000Z",
        digest,
        size: bytes.length,
        expiresAt: "2099-01-02T00:00:00.000Z",
        remotePath: `/home/alice/.cache/chatero/evidence/${digest}.${"a".repeat(64)}.pdf`,
      });
      value.emitClose();
    }
  });
  const originalWrite = channel.write.bind(channel);
  channel.write = frameBytes => {
    const frame = JSON.parse(Buffer.from(frameBytes).toString("utf8"));
    originalWrite(frameBytes);
    return frame.type === "finalize" ? false : true;
  };
  channel.drain = () => new Promise(() => {});
  const result = await Promise.race([
    runStageProtocol(channel, {
      digest,
      source: source.value,
      transferId: "2".repeat(32),
      ttlSeconds: 86400,
      targetId: TARGET_ID,
    }),
    delay(500).then(() => { throw new Error("finalize hung behind drain"); }),
  ]);
  assert.equal(result.digest, digest);
});

test("client bounds the total helper frame transcript", async () => {
  const source = controlledSource(Buffer.from("paper"));
  const channel = new FakeEvidenceChannel((_request, value) => {
    for (let index = 0; index < 20; index++) {
      value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
    }
  });
  await assert.rejects(runStageProtocol(channel, {
    digest: DIGEST,
    source: source.value,
    transferId: "1".repeat(32),
    ttlSeconds: 86400,
    targetId: TARGET_ID,
  }), /too many frames|transport/i);
});

test("client rejects mismatched complete metadata, remote clock skew is irrelevant, and trailing frames fail", async t => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  for (const [name, mutate] of [
    ["digest", frame => ({ ...frame, digest: "f".repeat(64) })],
    ["size", frame => ({ ...frame, size: bytes.length + 1 })],
    ["expiry", frame => ({ ...frame, expiresAt: "1999-01-02T00:00:01.000Z" })],
    ["trailing", frame => [frame, { type: "revoked" }]],
  ]) {
    await t.test(name, async () => {
      const source = controlledSource(bytes);
      const channel = new FakeEvidenceChannel((request, value) => {
        if (request.operation === "stage") value.emit({
          type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex"),
        });
        if (request.type === "finalize") {
          const createdAt = "2099-04-05T00:00:00.000Z";
          const base = {
            type: "complete",
            createdAt,
            digest,
            size: bytes.length,
            expiresAt: "2099-04-06T00:00:00.000Z",
            remotePath: `/home/alice/.cache/chatero/evidence/${digest}.${"e".repeat(64)}.pdf`,
          };
          const frames = mutate(base);
          for (const frame of Array.isArray(frames) ? frames : [frames]) value.emit(frame);
          value.emitClose();
        }
      });
      await assert.rejects(runStageProtocol(channel, {
        digest,
        source: source.value,
        transferId: "7".repeat(32),
        ttlSeconds: 86400,
        targetId: TARGET_ID,
      }), /mismatch|24-hour|after.*terminal/i);
    });
  }
});

test("protocol failures close a helper channel that does not close itself", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const source = controlledSource(bytes);
  const channel = new FakeEvidenceChannel((frame, value) => {
    if (frame.operation === "stage") {
      value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
    }
    if (frame.type === "finalize") {
      value.emit({
        type: "complete",
        createdAt: "2099-01-01T00:00:00.000Z",
        digest: "f".repeat(64),
        size: bytes.length,
        expiresAt: "2099-01-02T00:00:00.000Z",
        remotePath: `/home/alice/.cache/chatero/evidence/${"f".repeat(64)}.${"a".repeat(64)}.pdf`,
      });
    }
  });
  await assert.rejects(Promise.race([
    runStageProtocol(channel, {
      digest,
      source: source.value,
      transferId: "4".repeat(32),
      ttlSeconds: 86400,
      targetId: TARGET_ID,
    }),
    delay(500).then(() => { throw new Error("protocol failure did not settle"); }),
  ]), /mismatch/i);
  assert.equal(channel.closed, 1);
});

function makeServiceSession({
  fingerprint = FINGERPRINT,
  generation = 1,
  onOpen,
  onStageRequest,
  stageResume,
  createdAt = "2099-01-01T00:00:00.000Z",
  instance = "a".repeat(64),
} = {}) {
  const state = { fingerprint, generation, openCount: 0, channels: [], operations: [] };
  const session = {
    openEvidenceCache(expected) {
      onOpen?.(expected, state);
      if (expected.generation !== state.generation || expected.hostFingerprint !== state.fingerprint) {
        throw new Error("stale authenticated SSH session");
      }
      state.openCount += 1;
      const openNumber = state.openCount;
      let request;
      const channel = new FakeEvidenceChannel((frame, value) => {
        if (frame.operation) {
          request = frame;
          state.operations.push(frame.operation);
        }
        if (frame.operation === "stage") {
          onStageRequest?.(frame, value, state);
          value.emit(stageResume ?? {
            type: "resume",
            offset: 0,
            prefixDigest: createHash("sha256").digest("hex"),
          });
        }
        else if (frame.operation === "revoke") {
          value.emit({ type: "revoked" });
          value.emitClose();
        }
        else if (frame.operation === "cleanup") {
          value.emit({ type: "cleaned", count: 0 });
          value.emitClose();
        }
        else if (frame.type === "abort") {
          value.emit({ type: "aborted" });
          value.emitClose();
        }
        else if (frame.type === "finalize") {
          const cacheInstance = typeof instance === "function" ? instance(state, openNumber) : instance;
          value.emit({
            type: "complete",
            createdAt,
            digest: request.digest,
            size: request.size,
            expiresAt: new Date(Date.parse(createdAt) + 86400_000).toISOString(),
            remotePath: `/home/alice/.cache/chatero/evidence/${request.digest}.${cacheInstance}.pdf`,
          });
          value.emitClose();
        }
      });
      state.channels.push(channel);
      return channel;
    },
  };
  return {
    state,
    session,
    context: () => ({
      targetId: TARGET_ID,
      hostFingerprint: state.fingerprint,
      generation: state.generation,
      session,
    }),
  };
}

test("service fences grant bytes to the authenticated fingerprint and generation before helper spawn", async () => {
  const remote = makeServiceSession();
  const source = controlledSource(Buffer.from("paper"));
  const service = new EvidenceCacheService({
    getContext: async () => remote.context(),
    getZoteroApi: async () => ({
      redeemFullPdfGrant: async () => {
        remote.state.fingerprint = OTHER_FINGERPRINT;
        remote.state.generation += 1;
        return source.value;
      },
    }),
    reconnect: async () => remote.context(),
  });
  await assert.rejects(service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }), /stale|unavailable/i);
  assert.equal(remote.state.openCount, 0);
  assert.equal(source.closed, 1);
  await service.dispose();
});

test("service snapshots a mutable context before grant redemption and hashing", async () => {
  const remote = makeServiceSession();
  const mutable = remote.context();
  const source = controlledSource(Buffer.from("paper"));
  const service = new EvidenceCacheService({
    getContext: async () => mutable,
    getZoteroApi: async () => ({
      redeemFullPdfGrant: async () => {
        mutable.hostFingerprint = OTHER_FINGERPRINT;
        mutable.generation = 99;
        return source.value;
      },
    }),
    reconnect: async () => mutable,
  });
  const result = await service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  });
  assert.equal(result.targetId, TARGET_ID);
  assert.equal(remote.state.openCount, 1);
  await service.dispose();
});

test("service schedules every cache instance for one fixed local 24-hour delay despite remote clock skew", async () => {
  const delays = [];
  const callbacks = [];
  let contextCalls = 0;
  let stageIndex = 0;
  const sessions = [
    makeServiceSession({ createdAt: "1999-01-01T00:00:00.000Z", instance: "a".repeat(64) }),
    makeServiceSession({ createdAt: "2099-01-01T00:00:00.000Z", instance: "b".repeat(64) }),
  ];
  const sources = [controlledSource(Buffer.from("paper")), controlledSource(Buffer.from("paper"))];
  const service = new EvidenceCacheService({
    getContext: async () => { contextCalls += 1; return sessions[Math.min(stageIndex, 1)].context(); },
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[stageIndex++].value }),
    reconnect: async () => sessions[Math.min(stageIndex, 1)].context(),
    randomTransferId: () => String(stageIndex + 1).repeat(32),
    setTimeout: (callback, milliseconds) => {
      callbacks.push(callback);
      delays.push(milliseconds);
      return { unref() {} };
    },
    clearTimeout() {},
  });
  const first = await service.stageEvidence({ grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400 });
  const second = await service.stageEvidence({
    grantId: Buffer.alloc(32, 2).toString("base64url"), targetId: TARGET_ID, ttlSeconds: 86400,
  });
  assert.notEqual(first.remotePath, second.remotePath);
  assert.deepEqual(delays, [86400_000, 86400_000]);
  await service.dispose();
  const before = contextCalls;
  for (const callback of callbacks) callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(contextCalls, before, "disposed expiry callbacks must have no side effects");
});

test("revoke and expiry retain the original fingerprint tombstone until a new explicit stage", async t => {
  for (const terminalState of ["revoke", "expiry"]) {
    await t.test(terminalState, async () => {
      const callbacks = [];
      const remote = makeServiceSession();
      const sources = [controlledSource(Buffer.from("paper")), controlledSource(Buffer.from("paper"))];
      let sourceIndex = 0;
      const service = new EvidenceCacheService({
        getContext: async () => remote.context(),
        getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[sourceIndex++].value }),
        reconnect: async () => remote.context(),
        randomTransferId: () => String(sourceIndex + 1).repeat(32),
        setTimeout: callback => {
          callbacks.push(callback);
          return { unref() {} };
        },
        clearTimeout() {},
      });
      const first = await service.stageEvidence({
        grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
      });
      if (terminalState === "revoke") {
        await service.revokeEvidence({ targetId: TARGET_ID, digest: first.digest });
      }
      else {
        callbacks[0]();
        await Promise.resolve();
        await Promise.resolve();
      }
      remote.state.fingerprint = OTHER_FINGERPRINT;
      remote.state.generation += 1;
      const opensBeforeRepeat = remote.state.openCount;
      await service.revokeEvidence({ targetId: TARGET_ID, digest: first.digest });
      assert.equal(remote.state.openCount, opensBeforeRepeat, "repeat revoke must not touch the replacement host");

      await service.stageEvidence({
        grantId: Buffer.alloc(32, 3).toString("base64url"),
        targetId: TARGET_ID,
        ttlSeconds: 86400,
      });
      await service.revokeEvidence({ targetId: TARGET_ID, digest: first.digest });
      assert.equal(remote.state.operations.at(-1), "revoke");
      await service.dispose();
    });
  }
});

test("one cache instance expiring neither expires nor revokes a later instance of the same digest", async () => {
  const callbacks = [];
  const remote = makeServiceSession({
    instance: (_state, openNumber) => (openNumber === 1 ? "a" : "b").repeat(64),
  });
  const sources = [controlledSource(Buffer.from("paper")), controlledSource(Buffer.from("paper"))];
  let index = 0;
  const service = new EvidenceCacheService({
    getContext: async () => remote.context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[index++].value }),
    reconnect: async () => remote.context(),
    randomTransferId: () => String(index + 3).repeat(32),
    setTimeout: callback => {
      callbacks.push(callback);
      return { unref() {} };
    },
    clearTimeout() {},
  });
  const first = await service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  });
  await service.stageEvidence({
    grantId: Buffer.alloc(32, 4).toString("base64url"), targetId: TARGET_ID, ttlSeconds: 86400,
  });
  callbacks[0]();
  await Promise.resolve();
  await service.revokeEvidence({ targetId: TARGET_ID, digest: first.digest });
  assert.equal(remote.state.operations.filter(value => value === "revoke").length, 1);
  await service.dispose();
});

test("a queued old expiry callback cannot clobber a revoked digest that was explicitly rebound", async () => {
  const callbacks = [];
  const remote = makeServiceSession({ instance: "a".repeat(64) });
  const sources = [controlledSource(Buffer.from("paper")), controlledSource(Buffer.from("paper"))];
  let index = 0;
  const service = new EvidenceCacheService({
    getContext: async () => remote.context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[index++].value }),
    reconnect: async () => remote.context(),
    randomTransferId: () => String(index + 4).repeat(32),
    setTimeout: callback => {
      callbacks.push(callback);
      return { unref() {} };
    },
    clearTimeout() {},
  });
  const first = await service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  });
  await service.revokeEvidence({ targetId: TARGET_ID, digest: first.digest });
  remote.state.fingerprint = OTHER_FINGERPRINT;
  remote.state.generation += 1;
  await service.stageEvidence({
    grantId: Buffer.alloc(32, 9).toString("base64url"), targetId: TARGET_ID, ttlSeconds: 86400,
  });
  const revokesBefore = remote.state.operations.filter(value => value === "revoke").length;
  callbacks[0]();
  await Promise.resolve();
  await service.revokeEvidence({ targetId: TARGET_ID, digest: first.digest });
  assert.equal(remote.state.operations.filter(value => value === "revoke").length, revokesBefore + 1);
  await service.dispose();
});

test("an old expiry callback cannot delete a same-host rebound record at the same remote path", async () => {
  const callbacks = [];
  const expired = [];
  const remote = makeServiceSession({ instance: "a".repeat(64) });
  const sources = [controlledSource(Buffer.from("paper")), controlledSource(Buffer.from("paper"))];
  let sourceIndex = 0;
  let transferIndex = 0;
  const service = new EvidenceCacheService({
    getContext: async () => remote.context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[sourceIndex++].value }),
    reconnect: async () => remote.context(),
    randomTransferId: () => (++transferIndex).toString(16).repeat(32),
    onExpired: value => { expired.push(value); },
    setTimeout: callback => {
      callbacks.push(callback);
      return { unref() {} };
    },
    clearTimeout() {},
  });
  const first = await service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  });
  await service.revokeEvidence({ targetId: TARGET_ID, digest: first.digest });
  const rebound = await service.stageEvidence({
    grantId: Buffer.alloc(32, 29).toString("base64url"),
    targetId: TARGET_ID,
    ttlSeconds: 86400,
  });
  assert.equal(rebound.remotePath, first.remotePath);

  callbacks[0]();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(expired, []);
  const revokes = remote.state.operations.filter(value => value === "revoke").length;
  await service.revokeEvidence({ targetId: TARGET_ID, digest: first.digest });
  assert.equal(remote.state.operations.filter(value => value === "revoke").length, revokes + 1);
  await service.dispose();
});

test("expiry isolates synchronous observer and context lookup failures", async t => {
  for (const mode of ["observer throws", "context lookup throws"]) {
    await t.test(mode, async () => {
      const callbacks = [];
      const remote = makeServiceSession();
      const source = controlledSource(Buffer.from("paper"));
      let failContext = false;
      const service = new EvidenceCacheService({
        getContext: () => {
          if (failContext) throw new Error("synchronous context failure");
          return remote.context();
        },
        getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
        reconnect: async () => remote.context(),
        onExpired: () => {
          if (mode === "observer throws") throw new Error("synchronous observer failure");
        },
        setTimeout: callback => {
          callbacks.push(callback);
          return { unref() {} };
        },
        clearTimeout() {},
      });
      try {
        await service.stageEvidence({
          grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
        });
        failContext = mode === "context lookup throws";
        assert.doesNotThrow(() => callbacks[0]());
        if (mode === "observer throws") {
          for (let attempt = 0; attempt < 50
              && !remote.state.operations.includes("cleanup"); attempt++) await delay(1);
          assert.equal(remote.state.operations.includes("cleanup"), true,
            "observer failure must not block target-side expiry cleanup");
        }
        else {
          await Promise.resolve();
          await Promise.resolve();
          assert.deepEqual(remote.state.operations, ["stage"]);
        }
      }
      finally { await service.dispose(); }
    });
  }
});

test("an active digest cannot migrate to a different host before its cache expires or is revoked", async () => {
  const remote = makeServiceSession();
  const sources = [controlledSource(Buffer.from("paper")), controlledSource(Buffer.from("paper"))];
  let index = 0;
  const service = new EvidenceCacheService({
    getContext: async () => remote.context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[index++].value }),
    reconnect: async () => remote.context(),
  });
  await service.stageEvidence({ grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400 });
  remote.state.fingerprint = OTHER_FINGERPRINT;
  remote.state.generation += 1;
  const opens = remote.state.openCount;
  await assert.rejects(service.stageEvidence({
    grantId: Buffer.alloc(32, 5).toString("base64url"), targetId: TARGET_ID, ttlSeconds: 86400,
  }), /another authenticated host/i);
  assert.equal(remote.state.openCount, opens);
  await service.dispose();
});

test("concurrent first stages reserve one fingerprint before either helper can receive bytes", async () => {
  let reads = 0;
  let releaseReads;
  const readBarrier = new Promise(resolve => { releaseReads = resolve; });
  const makeSource = () => {
    let closed = false;
    return Object.freeze({
      size: 5,
      async read() {
        reads += 1;
        if (reads === 2) releaseReads();
        await readBarrier;
        return Uint8Array.from(Buffer.from("paper"));
      },
      async close() { closed = true; },
    });
  };
  const remotes = [
    makeServiceSession({ fingerprint: FINGERPRINT, instance: "a".repeat(64) }),
    makeServiceSession({ fingerprint: OTHER_FINGERPRINT, instance: "b".repeat(64) }),
  ];
  const sources = [makeSource(), makeSource()];
  let contextIndex = 0;
  let apiIndex = 0;
  const service = new EvidenceCacheService({
    getContext: async () => remotes[contextIndex++].context(),
    getZoteroApi: async () => {
      const source = sources[apiIndex++];
      return { redeemFullPdfGrant: async () => source };
    },
    reconnect: async () => { throw new Error("not expected"); },
    randomTransferId: () => String(apiIndex + 6).repeat(32),
  });
  const outcomes = await Promise.allSettled([
    service.stageEvidence({ grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400 }),
    service.stageEvidence({
      grantId: Buffer.alloc(32, 6).toString("base64url"), targetId: TARGET_ID, ttlSeconds: 86400,
    }),
  ]);
  assert.deepEqual(outcomes.map(value => value.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(remotes[0].state.openCount + remotes[1].state.openCount, 1);
  await service.dispose();
});

test("concurrent same-fingerprint reservations both complete without compensating each other", async () => {
  const remote = makeServiceSession({
    instance: (_state, openNumber) => (openNumber === 1 ? "a" : "b").repeat(64),
  });
  const sources = [controlledSource(Buffer.from("paper")), controlledSource(Buffer.from("paper"))];
  let sourceIndex = 0;
  let transferIndex = 0;
  const service = new EvidenceCacheService({
    getContext: async () => remote.context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[sourceIndex++].value }),
    reconnect: async () => remote.context(),
    randomTransferId: () => String(++transferIndex + 7).repeat(32),
  });
  const results = await Promise.all([
    service.stageEvidence({ grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400 }),
    service.stageEvidence({
      grantId: Buffer.alloc(32, 7).toString("base64url"), targetId: TARGET_ID, ttlSeconds: 86400,
    }),
  ]);
  assert.notEqual(results[0].remotePath, results[1].remotePath);
  assert.equal(remote.state.operations.includes("revoke"), false);
  await service.dispose();
});

test("revoke invalidates a stage that received complete but not clean close", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const source = controlledSource(bytes);
  const operations = [];
  let stageChannel;
  let completeSent;
  const sawComplete = new Promise(resolve => { completeSent = resolve; });
  const context = {
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: 1,
    session: {
      openEvidenceCache() {
        let request;
        const channel = new FakeEvidenceChannel((frame, value) => {
          if (frame.operation) {
            request = frame;
            operations.push(frame.operation);
          }
          if (frame.operation === "stage") {
            stageChannel = value;
            value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
          }
          else if (frame.type === "finalize") {
            value.emit({
              type: "complete",
              createdAt: "2099-01-01T00:00:00.000Z",
              digest,
              size: request.size,
              expiresAt: "2099-01-02T00:00:00.000Z",
              remotePath: `/home/alice/.cache/chatero/evidence/${digest}.${"c".repeat(64)}.pdf`,
            });
            queueMicrotask(completeSent);
          }
          else if (frame.operation === "revoke") {
            value.emit({ type: "revoked" });
            value.emitClose();
          }
        });
        return channel;
      },
    },
  };
  const service = new EvidenceCacheService({
    getContext: async () => context,
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: async () => context,
  });
  const staging = service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  });
  await sawComplete;
  await service.revokeEvidence({ targetId: TARGET_ID, digest });
  stageChannel.emitClose();
  await assert.rejects(staging, /revoked before completion/i);
  const beforeRepeat = operations.length;
  await service.revokeEvidence({ targetId: TARGET_ID, digest });
  assert.equal(operations.length, beforeRepeat);
  assert.deepEqual(operations, ["stage", "revoke"]);
  await service.dispose();
});

test("an uncertain revoke blocks new stages and is retried before next-session cleanup", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const sources = [controlledSource(bytes), controlledSource(bytes)];
  let sourceIndex = 0;
  let failRevoke = true;
  const operations = [];
  const expiryCallbacks = [];
  const context = {
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: 1,
    session: {
      openEvidenceCache() {
        let request;
        return new FakeEvidenceChannel((frame, value) => {
          if (frame.operation) {
            request = frame;
            operations.push(frame.operation);
          }
          if (frame.operation === "stage") {
            value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
          }
          else if (frame.type === "finalize") {
            value.emit({
              type: "complete",
              createdAt: "2099-01-01T00:00:00.000Z",
              digest,
              size: request.size,
              expiresAt: "2099-01-02T00:00:00.000Z",
              remotePath: `/home/alice/.cache/chatero/evidence/${digest}.${"d".repeat(64)}.pdf`,
            });
            value.emitClose();
          }
          else if (frame.operation === "revoke") {
            if (failRevoke) {
              failRevoke = false;
              value.emitClose({ code: 255, signal: null, error: null });
            }
            else {
              value.emit({ type: "revoked" });
              value.emitClose();
            }
          }
          else if (frame.operation === "cleanup") {
            value.emit({ type: "cleaned", count: 0 });
            value.emitClose();
          }
        });
      },
    },
  };
  const service = new EvidenceCacheService({
    getContext: async () => context,
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[sourceIndex++].value }),
    reconnect: async () => context,
    setTimeout: callback => {
      expiryCallbacks.push(callback);
      return { unref() {} };
    },
    clearTimeout() {},
  });
  await service.stageEvidence({ grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400 });
  await assert.rejects(
    service.revokeEvidence({ targetId: TARGET_ID, digest }),
    error => error?.code === "SSH_TRANSPORT",
  );
  expiryCallbacks[0]();
  await Promise.resolve();
  const opensBeforeStage = operations.length;
  await assert.rejects(service.stageEvidence({
    grantId: Buffer.alloc(32, 8).toString("base64url"), targetId: TARGET_ID, ttlSeconds: 86400,
  }), /revocation is still pending/i);
  assert.equal(operations.length, opensBeforeStage);
  assert.equal(await service.cleanupSession({ ...context, generation: 2 }), 0);
  assert.deepEqual(operations, ["stage", "revoke", "revoke", "cleanup"]);
  await service.dispose();
});

test("revoke intent survives context lookup failure and a replacement host", async t => {
  for (const mode of ["context unavailable", "replacement fingerprint"]) {
    await t.test(mode, async () => {
      const remoteA = makeServiceSession({ fingerprint: FINGERPRINT, instance: "a".repeat(64) });
      const remoteB = makeServiceSession({ fingerprint: OTHER_FINGERPRINT, instance: "b".repeat(64) });
      const source = controlledSource(Buffer.from("paper"));
      let lookupMode = "original";
      const service = new EvidenceCacheService({
        getContext: async () => {
          if (lookupMode === "unavailable") throw new Error("SSH target is temporarily unavailable");
          return lookupMode === "replacement" ? remoteB.context() : remoteA.context();
        },
        getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
        reconnect: async () => remoteA.context(),
      });
      try {
        const result = await service.stageEvidence({
          grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
        });
        lookupMode = mode === "context unavailable" ? "unavailable" : "replacement";
        await assert.rejects(
          service.revokeEvidence({ targetId: TARGET_ID, digest: result.digest }),
          /unavailable|originally authenticated host/i,
        );
        assert.equal(remoteB.state.openCount, 0, "revoke must never open a replacement host");

        remoteA.state.generation = 2;
        assert.equal(await service.cleanupSession(remoteA.context()), 0);
        assert.deepEqual(remoteA.state.operations, ["stage", "revoke", "cleanup"]);
        lookupMode = "unavailable";
        await service.revokeEvidence({ targetId: TARGET_ID, digest: result.digest });
        assert.deepEqual(remoteA.state.operations, ["stage", "revoke", "cleanup"]);
      }
      finally { await service.dispose(); }
    });
  }
});

test("revoke rechecks authority after context lookup before touching a newly conflicting host", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const remoteA = makeServiceSession({ fingerprint: FINGERPRINT, instance: "a".repeat(64) });
  const remoteB = makeServiceSession({ fingerprint: OTHER_FINGERPRINT, instance: "b".repeat(64) });
  const source = controlledSource(bytes);
  let resolveFirstLookup;
  const firstLookup = new Promise(resolve => { resolveFirstLookup = resolve; });
  let resolveLookupStarted;
  const lookupStarted = new Promise(resolve => { resolveLookupStarted = resolve; });
  let lookupCount = 0;
  const service = new EvidenceCacheService({
    getContext: () => {
      lookupCount += 1;
      if (lookupCount === 1) {
        queueMicrotask(resolveLookupStarted);
        return firstLookup;
      }
      return remoteA.context();
    },
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: async () => remoteA.context(),
  });

  try {
    const revoke = service.revokeEvidence({ targetId: TARGET_ID, digest }).then(
      value => ({ status: "fulfilled", value }),
      reason => ({ status: "rejected", reason }),
    );
    await lookupStarted;
    const staged = await service.stageEvidence({
      grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
    });
    assert.equal(staged.digest, digest);

    resolveFirstLookup(remoteB.context());
    const outcome = await revoke;
    assert.equal(outcome.status, "rejected");
    assert.match(outcome.reason.message, /originally authenticated host/i);
    assert.equal(remoteB.state.openCount, 0);

    remoteA.state.generation = 2;
    assert.equal(await service.cleanupSession(remoteA.context()), 0);
    assert.deepEqual(remoteA.state.operations, ["stage", "revoke", "cleanup"]);
  }
  finally { await service.dispose(); }
});

test("a slow public revoke cannot cross its completed epoch and revoke a rebound cache", async () => {
  const remote = makeServiceSession({
    instance: (_state, openNumber) => (openNumber === 1 ? "a" : "b").repeat(64),
  });
  const sources = [controlledSource(Buffer.from("paper")), controlledSource(Buffer.from("paper"))];
  let sourceIndex = 0;
  let transferIndex = 0;
  let holdNextLookup = false;
  let resolveSlowLookup;
  const slowLookup = new Promise(resolve => { resolveSlowLookup = resolve; });
  let resolveSlowLookupStarted;
  const slowLookupStarted = new Promise(resolve => { resolveSlowLookupStarted = resolve; });
  const service = new EvidenceCacheService({
    getContext: () => {
      if (holdNextLookup) {
        holdNextLookup = false;
        queueMicrotask(resolveSlowLookupStarted);
        return slowLookup;
      }
      return remote.context();
    },
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[sourceIndex++].value }),
    reconnect: async () => remote.context(),
    randomTransferId: () => (++transferIndex).toString(16).repeat(32),
  });

  try {
    const first = await service.stageEvidence({
      grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
    });
    holdNextLookup = true;
    const slowRevoke = service.revokeEvidence({ targetId: TARGET_ID, digest: first.digest });
    await slowLookupStarted;
    await service.revokeEvidence({ targetId: TARGET_ID, digest: first.digest });
    const rebound = await service.stageEvidence({
      grantId: Buffer.alloc(32, 31).toString("base64url"),
      targetId: TARGET_ID,
      ttlSeconds: 86400,
    });
    resolveSlowLookup(remote.context());
    await slowRevoke;
    assert.equal(remote.state.operations.filter(value => value === "revoke").length, 1);

    await service.revokeEvidence({ targetId: TARGET_ID, digest: rebound.digest });
    assert.deepEqual(remote.state.operations, ["stage", "revoke", "stage", "revoke"]);
  }
  finally { await service.dispose(); }
});

test("a synchronous revoke-channel failure is not cached as a permanently rejected flight", async () => {
  const remote = makeServiceSession();
  const source = controlledSource(Buffer.from("paper"));
  const service = new EvidenceCacheService({
    getContext: async () => remote.context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: async () => remote.context(),
  });
  const result = await service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  });
  const originalOpen = remote.session.openEvidenceCache.bind(remote.session);
  let failSynchronously = true;
  remote.session.openEvidenceCache = expected => {
    if (failSynchronously) {
      failSynchronously = false;
      throw new Error("synchronous stale-session fence");
    }
    return originalOpen(expected);
  };
  await assert.rejects(
    service.revokeEvidence({ targetId: TARGET_ID, digest: result.digest }),
    /stale-session fence/,
  );
  remote.state.generation = 2;
  assert.equal(await service.cleanupSession(remote.context()), 0);
  assert.deepEqual(remote.state.operations, ["stage", "revoke", "cleanup"]);
  await service.dispose();
});

test("a stale host compensation cannot join a later host revoke flight", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const sources = [controlledSource(bytes), controlledSource(bytes)];
  let sourceIndex = 0;
  let currentContext;
  let delayedStageChannel;
  let resolveAComplete;
  const aComplete = new Promise(resolve => { resolveAComplete = resolve; });
  const aOperations = [];
  const contextA = {
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: 1,
    session: {
      openEvidenceCache(expected) {
        assert.deepEqual(expected, { generation: 1, hostFingerprint: FINGERPRINT });
        let request;
        return new FakeEvidenceChannel((frame, value) => {
          if (frame.operation) {
            request = frame;
            aOperations.push(frame.operation);
          }
          if (frame.operation === "stage") {
            delayedStageChannel = value;
            value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
          }
          else if (frame.type === "finalize") {
            value.emit({
              type: "complete",
              createdAt: "2099-01-01T00:00:00.000Z",
              digest,
              size: request.size,
              expiresAt: "2099-01-02T00:00:00.000Z",
              remotePath: `/home/a/.cache/chatero/evidence/${digest}.${"a".repeat(64)}.pdf`,
            });
            queueMicrotask(resolveAComplete);
          }
          else if (frame.operation === "revoke") {
            value.emit({ type: "revoked" });
            value.emitClose();
          }
        });
      },
    },
  };
  let pausedBRevoke;
  let resolveBRevokeOpened;
  const bRevokeOpened = new Promise(resolve => { resolveBRevokeOpened = resolve; });
  const bOperations = [];
  const contextB = {
    targetId: TARGET_ID,
    hostFingerprint: OTHER_FINGERPRINT,
    generation: 1,
    session: {
      openEvidenceCache(expected) {
        assert.deepEqual(expected, { generation: 1, hostFingerprint: OTHER_FINGERPRINT });
        let request;
        return new FakeEvidenceChannel((frame, value) => {
          if (frame.operation) {
            request = frame;
            bOperations.push(frame.operation);
          }
          if (frame.operation === "stage") {
            value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
          }
          else if (frame.type === "finalize") {
            value.emit({
              type: "complete",
              createdAt: "2099-01-01T00:00:00.000Z",
              digest,
              size: request.size,
              expiresAt: "2099-01-02T00:00:00.000Z",
              remotePath: `/home/b/.cache/chatero/evidence/${digest}.${"b".repeat(64)}.pdf`,
            });
            value.emitClose();
          }
          else if (frame.operation === "revoke") {
            pausedBRevoke = value;
            queueMicrotask(resolveBRevokeOpened);
          }
        });
      },
    },
  };
  currentContext = contextA;
  const service = new EvidenceCacheService({
    getContext: async () => currentContext,
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[sourceIndex++].value }),
    reconnect: async () => currentContext,
  });
  const oldStage = service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  });
  await aComplete;
  await service.revokeEvidence({ targetId: TARGET_ID, digest });
  currentContext = contextB;
  await service.stageEvidence({
    grantId: Buffer.alloc(32, 18).toString("base64url"),
    targetId: TARGET_ID,
    ttlSeconds: 86400,
  });
  const bRevoke = service.revokeEvidence({ targetId: TARGET_ID, digest });
  await bRevokeOpened;
  delayedStageChannel.emitClose();
  await assert.rejects(oldStage, /revoked before completion/i);
  assert.deepEqual(aOperations, ["stage", "revoke"]);
  assert.deepEqual(bOperations, ["stage", "revoke"]);
  pausedBRevoke.emit({ type: "revoked" });
  pausedBRevoke.emitClose();
  await bRevoke;
  await service.dispose();
});

test("revoke commits before notifying observers and observer failures or reentry never block it", async t => {
  for (const mode of ["synchronous throw", "reentrant revoke", "observer dispose"]) {
    await t.test(mode, async () => {
      const remote = makeServiceSession();
      const source = controlledSource(Buffer.from("paper"));
      let service;
      let digest;
      let resolveObserverDone;
      const observerDone = new Promise(resolve => { resolveObserverDone = resolve; });
      const onRevoked = () => {
        if (mode === "synchronous throw") throw new Error("observer failure");
        const operation = mode === "reentrant revoke"
          ? service.revokeEvidence({ targetId: TARGET_ID, digest })
          : service.dispose();
        return operation.finally(resolveObserverDone);
      };
      service = new EvidenceCacheService({
        getContext: async () => remote.context(),
        getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
        reconnect: async () => remote.context(),
        onRevoked,
      });
      let revokeSettled = false;
      try {
        const result = await service.stageEvidence({
          grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
        });
        digest = result.digest;
        await Promise.race([
          service.revokeEvidence({ targetId: TARGET_ID, digest }),
          delay(300).then(() => { throw new Error(`${mode} blocked revoke completion`); }),
        ]);
        revokeSettled = true;
        if (mode !== "synchronous throw") {
          await Promise.race([
            observerDone,
            delay(300).then(() => { throw new Error(`${mode} observer did not settle`); }),
          ]);
        }
        if (mode !== "observer dispose") {
          const opens = remote.state.openCount;
          await service.revokeEvidence({ targetId: TARGET_ID, digest });
          assert.equal(remote.state.openCount, opens, "terminal repeat must stay local and idempotent");
        }
        assert.deepEqual(remote.state.operations, ["stage", "revoke"]);
      }
      finally {
        if (revokeSettled && mode !== "observer dispose") await service.dispose();
      }
    });
  }
});

test("a fresh cleanup generation retries a revoke flight started by stale-stage compensation", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const sources = [controlledSource(bytes), controlledSource(bytes)];
  let sourceIndex = 0;
  let generation = 1;
  let failContextLookup = false;
  let stageNumber = 0;
  let transferNumber = 0;
  let oldStageChannel;
  let staleRevokeChannel;
  let resolveOldComplete;
  const oldComplete = new Promise(resolve => { resolveOldComplete = resolve; });
  let resolveStaleRevokeOpened;
  const staleRevokeOpened = new Promise(resolve => { resolveStaleRevokeOpened = resolve; });
  const operations = [];
  const session = {
    openEvidenceCache(expected) {
      let request;
      return new FakeEvidenceChannel((frame, value) => {
        if (frame.operation) {
          request = frame;
          operations.push([frame.operation, expected.generation]);
        }
        if (frame.operation === "stage") {
          stageNumber += 1;
          value.emit({
            type: "resume",
            offset: 0,
            prefixDigest: createHash("sha256").digest("hex"),
          });
        }
        else if (frame.type === "finalize") {
          const instance = stageNumber === 1 ? "a" : "b";
          value.emit({
            type: "complete",
            createdAt: "2099-01-01T00:00:00.000Z",
            digest,
            size: request.size,
            expiresAt: "2099-01-02T00:00:00.000Z",
            remotePath: `/home/a/.cache/chatero/evidence/${digest}.${instance.repeat(64)}.pdf`,
          });
          if (stageNumber === 1) {
            oldStageChannel = value;
            queueMicrotask(resolveOldComplete);
          }
          else value.emitClose();
        }
        else if (frame.operation === "revoke" && expected.generation === 1) {
          staleRevokeChannel = value;
          queueMicrotask(resolveStaleRevokeOpened);
        }
        else if (frame.operation === "revoke") {
          value.emit({ type: "revoked" });
          value.emitClose();
        }
        else if (frame.operation === "cleanup") {
          value.emit({ type: "cleaned", count: 0 });
          value.emitClose();
        }
      });
    },
  };
  const context = value => ({
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: value,
    session,
  });
  const service = new EvidenceCacheService({
    getContext: () => {
      if (failContextLookup) throw new Error("context unavailable");
      return context(generation);
    },
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[sourceIndex++].value }),
    reconnect: async () => context(generation),
    randomTransferId: () => String(++transferNumber).repeat(32),
  });

  try {
    const oldStage = service.stageEvidence({
      grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
    }).then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }));
    await oldComplete;

    generation = 2;
    await service.revokeEvidence({ targetId: TARGET_ID, digest });
    await service.stageEvidence({
      grantId: Buffer.alloc(32, 24).toString("base64url"),
      targetId: TARGET_ID,
      ttlSeconds: 86400,
    });
    failContextLookup = true;
    await assert.rejects(
      service.revokeEvidence({ targetId: TARGET_ID, digest }),
      /context unavailable/i,
    );
    failContextLookup = false;

    oldStageChannel.emitClose();
    await staleRevokeOpened;
    const freshCleanup = service.cleanupSession(context(4));
    await delay(0);
    staleRevokeChannel.emitClose({ code: 255, signal: null, error: null });

    assert.equal((await oldStage).status, "rejected");
    assert.equal(await freshCleanup, 0);
    assert.deepEqual(operations, [
      ["stage", 1],
      ["revoke", 2],
      ["stage", 2],
      ["revoke", 1],
      ["revoke", 4],
      ["cleanup", 4],
    ]);
  }
  finally {
    oldStageChannel?.emitClose();
    staleRevokeChannel?.emitClose({ code: 255, signal: null, error: null });
    await service.dispose();
  }
});

test("post-finalize compensation publishes its pending revoke before a fresh cleanup joins", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const wrongDigest = "f".repeat(64);
  const source = controlledSource(bytes);
  const operations = [];
  let staleRevokeChannel;
  let resolveStaleRevokeOpened;
  const staleRevokeOpened = new Promise(resolve => { resolveStaleRevokeOpened = resolve; });
  const session = {
    openEvidenceCache(expected) {
      let request;
      return new FakeEvidenceChannel((frame, value) => {
        if (frame.operation) {
          request = frame;
          operations.push([frame.operation, expected.generation]);
        }
        if (frame.operation === "stage") {
          value.emit({
            type: "resume",
            offset: 0,
            prefixDigest: createHash("sha256").digest("hex"),
          });
        }
        else if (frame.type === "finalize") {
          value.emit({
            type: "complete",
            createdAt: "2099-01-01T00:00:00.000Z",
            digest: wrongDigest,
            size: request.size,
            expiresAt: "2099-01-02T00:00:00.000Z",
            remotePath: `/home/a/.cache/chatero/evidence/${wrongDigest}.${"a".repeat(64)}.pdf`,
          });
        }
        else if (frame.operation === "revoke" && expected.generation === 1) {
          staleRevokeChannel = value;
          queueMicrotask(resolveStaleRevokeOpened);
        }
        else if (frame.operation === "revoke") {
          value.emit({ type: "revoked" });
          value.emitClose();
        }
        else if (frame.operation === "cleanup") {
          value.emit({ type: "cleaned", count: 0 });
          value.emitClose();
        }
      });
    },
  };
  const context = generation => ({
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation,
    session,
  });
  const service = new EvidenceCacheService({
    getContext: async () => context(1),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: async () => context(1),
    randomTransferId: () => "7".repeat(32),
  });
  const staging = service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  });
  let cleanupSettled = false;
  try {
    await staleRevokeOpened;
    const cleanup = service.cleanupExpiredEvidence(context(2)).finally(() => {
      cleanupSettled = true;
    });
    await delay(0);
    assert.equal(cleanupSettled, false, "fresh cleanup must join the already-started pending revoke");
    staleRevokeChannel.emitClose({ code: 255, signal: null, error: null });
    await assert.rejects(staging, /mismatch/i);
    assert.equal(await cleanup, 0);
    assert.deepEqual(operations, [
      ["stage", 1],
      ["revoke", 1],
      ["revoke", 2],
      ["cleanup", 2],
    ]);
    assert.equal(digest.length, 64);
  }
  finally {
    staleRevokeChannel?.emitClose({ code: 255, signal: null, error: null });
    await staging.catch(() => {});
    await service.dispose();
  }
});

test("an old same-host stage compensation only joins the current revoke epoch", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const sources = [controlledSource(bytes), controlledSource(bytes)];
  let sourceIndex = 0;
  let generation = 1;
  let stageNumber = 0;
  let revokeNumber = 0;
  let transferNumber = 0;
  let oldStageChannel;
  let currentRevokeChannel;
  let resolveOldComplete;
  const oldComplete = new Promise(resolve => { resolveOldComplete = resolve; });
  let resolveCurrentRevokeOpened;
  const currentRevokeOpened = new Promise(resolve => { resolveCurrentRevokeOpened = resolve; });
  const operations = [];
  const session = {
    openEvidenceCache(expected) {
      let request;
      return new FakeEvidenceChannel((frame, value) => {
        if (frame.operation) {
          request = frame;
          operations.push([frame.operation, expected.generation]);
        }
        if (frame.operation === "stage") {
          stageNumber += 1;
          value.emit({
            type: "resume",
            offset: 0,
            prefixDigest: createHash("sha256").digest("hex"),
          });
        }
        else if (frame.type === "finalize") {
          const instance = stageNumber === 1 ? "a" : "b";
          value.emit({
            type: "complete",
            createdAt: "2099-01-01T00:00:00.000Z",
            digest,
            size: request.size,
            expiresAt: "2099-01-02T00:00:00.000Z",
            remotePath: `/home/a/.cache/chatero/evidence/${digest}.${instance.repeat(64)}.pdf`,
          });
          if (stageNumber === 1) {
            oldStageChannel = value;
            queueMicrotask(resolveOldComplete);
          }
          else value.emitClose();
        }
        else if (frame.operation === "revoke") {
          revokeNumber += 1;
          if (revokeNumber === 1) {
            value.emit({ type: "revoked" });
            value.emitClose();
          }
          else {
            currentRevokeChannel = value;
            queueMicrotask(resolveCurrentRevokeOpened);
          }
        }
      });
    },
  };
  const context = () => ({ targetId: TARGET_ID, hostFingerprint: FINGERPRINT, generation, session });
  const service = new EvidenceCacheService({
    getContext: async () => context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[sourceIndex++].value }),
    reconnect: async () => context(),
    randomTransferId: () => (++transferNumber).toString(16).repeat(32),
  });

  try {
    let oldSettled = false;
    const oldStage = service.stageEvidence({
      grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
    }).then(
      value => { oldSettled = true; return { status: "fulfilled", value }; },
      reason => { oldSettled = true; return { status: "rejected", reason }; },
    );
    await oldComplete;
    generation = 2;
    await service.revokeEvidence({ targetId: TARGET_ID, digest });
    await service.stageEvidence({
      grantId: Buffer.alloc(32, 30).toString("base64url"),
      targetId: TARGET_ID,
      ttlSeconds: 86400,
    });

    let currentRevokeSettled = false;
    const currentRevoke = service.revokeEvidence({ targetId: TARGET_ID, digest })
      .then(() => { currentRevokeSettled = true; });
    await currentRevokeOpened;
    oldStageChannel.emitClose();
    await delay(0);
    assert.equal(revokeNumber, 2, "stale compensation must join instead of opening another revoke");
    assert.equal(oldSettled, false, "stale stage waits for the current revoke terminal result");
    assert.equal(currentRevokeSettled, false);

    currentRevokeChannel.emit({ type: "revoked" });
    currentRevokeChannel.emitClose();
    await currentRevoke;
    const oldOutcome = await oldStage;
    assert.equal(oldOutcome.status, "rejected");
    assert.match(oldOutcome.reason.message, /revoked before completion/i);
    const opens = operations.length;
    await service.revokeEvidence({ targetId: TARGET_ID, digest });
    assert.equal(operations.length, opens);
    assert.deepEqual(operations, [
      ["stage", 1],
      ["revoke", 2],
      ["stage", 2],
      ["revoke", 2],
    ]);
  }
  finally {
    oldStageChannel?.emitClose();
    currentRevokeChannel?.emitClose({ code: 255, signal: null, error: null });
    await service.dispose();
  }
});

test("dispose closes and awaits an in-flight cleanup helper channel", async () => {
  let channel;
  const context = {
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: 1,
    session: {
      openEvidenceCache() {
        channel = new FakeEvidenceChannel((_frame, value) => {
          globalThis.setTimeout(() => {
            value.emit({ type: "cleaned", count: 0 });
            value.emitClose();
          }, 20);
        });
        return channel;
      },
    },
  };
  const service = new EvidenceCacheService({
    getContext: async () => context,
    getZoteroApi: async () => null,
    reconnect: async () => context,
  });
  const cleanup = service.cleanupSession(context).catch(error => error);
  for (let attempt = 0; attempt < 50 && !channel; attempt++) await delay(1);
  assert.ok(channel, "cleanup helper channel opened");
  await Promise.race([
    service.dispose(),
    delay(500).then(() => { throw new Error("dispose did not close in-flight cleanup"); }),
  ]);
  assert.equal(channel.closed, 0);
  assert.equal(await cleanup, 0);
});

test("dispose gives an accepted helper transaction more than 250ms to acknowledge", async () => {
  let channel;
  const context = {
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: 1,
    session: {
      openEvidenceCache() {
        channel = new FakeEvidenceChannel((_frame, value) => {
          globalThis.setTimeout(() => {
            value.emit({ type: "cleaned", count: 0 });
            value.emitClose();
          }, 300);
        });
        return channel;
      },
    },
  };
  const service = new EvidenceCacheService({
    getContext: async () => context,
    getZoteroApi: async () => null,
    reconnect: async () => context,
  });
  const cleanup = service.cleanupSession(context);
  for (let attempt = 0; attempt < 50 && !channel; attempt++) await delay(1);
  const started = Date.now();
  await service.dispose();
  assert.ok(Date.now() - started >= 250);
  assert.equal(await cleanup, 0);
  assert.equal(channel.closed, 0, "dispose must not kill the channel before its acknowledgement");
});

test("dispose aborts a hung authorized read and closes its source within the grace bound", async () => {
  let readStarted = false;
  let closeCount = 0;
  const source = Object.freeze({
    size: 5,
    read() {
      readStarted = true;
      return new Promise(() => {});
    },
    async close() { closeCount += 1; },
  });
  const remote = makeServiceSession();
  const service = new EvidenceCacheService({
    getContext: async () => remote.context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source }),
    reconnect: async () => remote.context(),
  });
  const staging = service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }).catch(error => error);
  for (let attempt = 0; attempt < 50 && !readStarted; attempt++) await delay(1);
  assert.equal(readStarted, true);
  await Promise.race([
    service.dispose(),
    delay(500).then(() => { throw new Error("dispose remained blocked on authorized read"); }),
  ]);
  assert.equal((await staging).name, "AbortError");
  assert.ok(closeCount >= 1);
  assert.equal(remote.state.openCount, 0);
});

test("synchronous PDF source close implementations never override a successful stage", async t => {
  for (const mode of ["returns void", "throws"]) {
    await t.test(mode, async () => {
      const bytes = Buffer.from("paper");
      let closeCount = 0;
      const source = Object.freeze({
        size: bytes.length,
        async read(offset, length) {
          return Uint8Array.from(bytes.subarray(offset, offset + length));
        },
        close() {
          closeCount += 1;
          if (mode === "throws") throw new Error("synchronous close failure");
        },
      });
      const remote = makeServiceSession();
      const service = new EvidenceCacheService({
        getContext: async () => remote.context(),
        getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source }),
        reconnect: async () => remote.context(),
      });
      const result = await service.stageEvidence({
        grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
      });
      assert.equal(result.digest, createHash("sha256").update(bytes).digest("hex"));
      assert.equal(closeCount, 1);
      await Promise.race([
        service.dispose(),
        delay(300).then(() => { throw new Error("dispose did not settle after synchronous close"); }),
      ]);
    });
  }
});

test("dispose isolates a synchronous source close throw while aborting a hung read", async () => {
  let readStarted = false;
  let closeCount = 0;
  const source = Object.freeze({
    size: 5,
    read() {
      readStarted = true;
      return new Promise(() => {});
    },
    close() {
      closeCount += 1;
      throw new Error("synchronous close failure");
    },
  });
  const remote = makeServiceSession();
  const service = new EvidenceCacheService({
    getContext: async () => remote.context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source }),
    reconnect: async () => remote.context(),
  });
  const staging = service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }).then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }));
  for (let attempt = 0; attempt < 50 && !readStarted; attempt++) await delay(1);
  assert.equal(readStarted, true);
  await Promise.race([
    service.dispose(),
    delay(300).then(() => { throw new Error("dispose escaped or hung on synchronous close"); }),
  ]);
  const outcome = await staging;
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason.name, "AbortError");
  assert.ok(closeCount >= 1);
});

test("concurrent dispose calls share one complete source-close barrier", async () => {
  let readStarted = false;
  let closeCount = 0;
  let releaseClose;
  const closeBarrier = new Promise(resolve => { releaseClose = resolve; });
  const source = Object.freeze({
    size: 5,
    read() {
      readStarted = true;
      return new Promise(() => {});
    },
    close() {
      closeCount += 1;
      return closeBarrier;
    },
  });
  const remote = makeServiceSession();
  const service = new EvidenceCacheService({
    getContext: async () => remote.context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source }),
    reconnect: async () => remote.context(),
  });
  const staging = service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }).catch(error => error);
  for (let attempt = 0; attempt < 50 && !readStarted; attempt++) await delay(1);
  assert.equal(readStarted, true);

  let firstSettled = false;
  let secondSettled = false;
  const first = service.dispose().then(() => { firstSettled = true; });
  const second = service.dispose().then(() => { secondSettled = true; });
  await delay(0);
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);
  assert.equal(closeCount, 1, "all disposal paths share one source close");
  releaseClose();
  await Promise.all([first, second]);
  assert.equal((await staging).name, "AbortError");
  assert.equal(closeCount, 1);
});

test("dispose aborts never-settling context and Zotero API lookups", async t => {
  for (const blocked of ["getContext", "getZoteroApi"]) {
    await t.test(blocked, async () => {
      const remote = makeServiceSession();
      let resolveStarted;
      const started = new Promise(resolve => { resolveStarted = resolve; });
      const never = new Promise(() => {});
      const service = new EvidenceCacheService({
        getContext: () => {
          if (blocked === "getContext") {
            queueMicrotask(resolveStarted);
            return never;
          }
          return remote.context();
        },
        getZoteroApi: () => {
          queueMicrotask(resolveStarted);
          return never;
        },
        reconnect: async () => remote.context(),
      });
      const staging = service.stageEvidence({
        grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
      }).then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }));
      await started;
      await Promise.race([
        service.dispose(),
        delay(300).then(() => { throw new Error(`${blocked} prevented disposal`); }),
      ]);
      const outcome = await staging;
      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.reason.name, "AbortError");
      assert.equal(remote.state.openCount, 0);
    });
  }
});

test("a PDF source that resolves after cancellation is closed exactly once without helper spawn", async () => {
  const remote = makeServiceSession();
  let resolveRedeem;
  let resolveRedeemStarted;
  const redeemStarted = new Promise(resolve => { resolveRedeemStarted = resolve; });
  const redeem = new Promise(resolve => { resolveRedeem = resolve; });
  let closeCount = 0;
  const lateSource = Object.freeze({
    size: 5,
    async read() { return Uint8Array.from(Buffer.from("paper")); },
    async close() { closeCount += 1; },
  });
  const service = new EvidenceCacheService({
    getContext: async () => remote.context(),
    getZoteroApi: async () => ({
      redeemFullPdfGrant() {
        queueMicrotask(resolveRedeemStarted);
        return redeem;
      },
    }),
    reconnect: async () => remote.context(),
  });
  const staging = service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }).then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }));
  await redeemStarted;
  await Promise.race([
    service.dispose(),
    delay(300).then(() => { throw new Error("pending grant redemption prevented disposal"); }),
  ]);
  const outcome = await staging;
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason.name, "AbortError");
  assert.equal(remote.state.openCount, 0);
  resolveRedeem(lateSource);
  for (let attempt = 0; attempt < 50 && closeCount < 1; attempt++) await delay(1);
  assert.equal(closeCount, 1);
  assert.equal(remote.state.openCount, 0);
});

test("dispose aborts a never-settling reconnect after transport loss", async () => {
  let resolveReconnectStarted;
  const reconnectStarted = new Promise(resolve => { resolveReconnectStarted = resolve; });
  const source = controlledSource(Buffer.from("paper"));
  let openCount = 0;
  const context = {
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: 1,
    session: {
      openEvidenceCache() {
        openCount += 1;
        return new FakeEvidenceChannel((frame, value) => {
          if (frame.operation === "stage") {
            value.emitClose({ code: 255, signal: null, error: null });
          }
        });
      },
    },
  };
  const service = new EvidenceCacheService({
    getContext: async () => context,
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: () => {
      queueMicrotask(resolveReconnectStarted);
      return new Promise(() => {});
    },
  });
  const staging = service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }).then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }));
  await reconnectStarted;
  await Promise.race([
    service.dispose(),
    delay(300).then(() => { throw new Error("pending reconnect prevented disposal"); }),
  ]);
  const outcome = await staging;
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason.name, "AbortError");
  assert.equal(openCount, 1);
  assert.equal(source.closed, 1);
});

test("a synchronous abort-listener reentry receives the canonical disposal barrier", async () => {
  const source = controlledSource(Buffer.from("paper"));
  let service;
  let innerDispose;
  let resolveReconnectStarted;
  const reconnectStarted = new Promise(resolve => { resolveReconnectStarted = resolve; });
  const context = {
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: 1,
    session: {
      openEvidenceCache() {
        return new FakeEvidenceChannel((frame, value) => {
          if (frame.operation === "stage") {
            value.emitClose({ code: 255, signal: null, error: null });
          }
        });
      },
    },
  };
  service = new EvidenceCacheService({
    getContext: async () => context,
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: (_targetId, signal) => {
      signal.addEventListener("abort", () => { innerDispose = service.dispose(); }, { once: true });
      queueMicrotask(resolveReconnectStarted);
      return new Promise(() => {});
    },
  });
  const staging = service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }).catch(error => error);
  await reconnectStarted;
  const outerDispose = service.dispose();
  await Promise.resolve();
  assert.equal(innerDispose, outerDispose);
  await outerDispose;
  assert.equal((await staging).name, "AbortError");
  assert.equal(source.closed, 1);
});

test("an async source close awaiting disposal cannot self-deadlock", async () => {
  let service;
  let readStarted = false;
  let closeCount = 0;
  const source = Object.freeze({
    size: 5,
    read() {
      readStarted = true;
      return new Promise(() => {});
    },
    async close() {
      closeCount += 1;
      await service.dispose();
    },
  });
  const remote = makeServiceSession();
  service = new EvidenceCacheService({
    getContext: async () => remote.context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source }),
    reconnect: async () => remote.context(),
  });
  const staging = service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }).catch(error => error);
  for (let attempt = 0; attempt < 50 && !readStarted; attempt++) await delay(1);
  assert.equal(readStarted, true);
  await Promise.race([
    service.dispose(),
    delay(300).then(() => { throw new Error("source close self-deadlocked disposal"); }),
  ]);
  assert.equal((await staging).name, "AbortError");
  assert.equal(closeCount, 1);
});

test("an async source close may start disposal from the stage-finally path", async () => {
  const bytes = Buffer.from("paper");
  let service;
  let closeCount = 0;
  const source = Object.freeze({
    size: bytes.length,
    async read(offset, length) { return Uint8Array.from(bytes.subarray(offset, offset + length)); },
    async close() {
      closeCount += 1;
      await service.dispose();
    },
  });
  const remote = makeServiceSession();
  service = new EvidenceCacheService({
    getContext: async () => remote.context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source }),
    reconnect: async () => remote.context(),
  });
  const result = await Promise.race([
    service.stageEvidence({
      grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
    }),
    delay(300).then(() => { throw new Error("stage-finally source close self-deadlocked"); }),
  ]);
  assert.equal(result.digest, createHash("sha256").update(bytes).digest("hex"));
  await Promise.race([
    service.dispose(),
    delay(300).then(() => { throw new Error("full external disposal did not settle"); }),
  ]);
  assert.equal(closeCount, 1);
});

test("a pre-publish stage failure aborts only its transfer and preserves existing cache instances", async () => {
  let existingCache = true;
  const remote = makeServiceSession({
    stageResume: { type: "resume", offset: 1, prefixDigest: "f".repeat(64) },
  });
  const originalOpen = remote.session.openEvidenceCache.bind(remote.session);
  remote.session.openEvidenceCache = expected => {
    const channel = originalOpen(expected);
    const originalWrite = channel.write.bind(channel);
    channel.write = bytes => {
      const frame = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (frame.operation === "revoke") existingCache = false;
      return originalWrite(bytes);
    };
    return channel;
  };
  const source = controlledSource(Buffer.from("paper"));
  const service = new EvidenceCacheService({
    getContext: async () => remote.context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: async () => remote.context(),
  });
  await assert.rejects(service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }), /prefix digest/i);
  assert.equal(existingCache, true);
  assert.deepEqual(remote.state.operations, ["stage"]);
  await service.dispose();
});

test("a twice-lost transport retains a target-fingerprint transaction cleanup for the next connection", async () => {
  let generation = 1;
  let opens = 0;
  const frames = [];
  const session = {
    openEvidenceCache(expected) {
      assert.deepEqual(expected, { generation, hostFingerprint: FINGERPRINT });
      opens += 1;
      const openNumber = opens;
      const channel = new FakeEvidenceChannel((frame, value) => {
        frames.push(frame);
        if (openNumber <= 2 && frame.operation === "stage") {
          value.emitClose({ code: 255, signal: null, error: null });
        }
        else if (frame.operation === "stage") {
          value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
        }
        else if (frame.type === "abort") {
          value.emit({ type: "aborted" });
          value.emitClose();
        }
        else if (frame.operation === "cleanup") {
          value.emit({ type: "cleaned", count: 0 });
          value.emitClose();
        }
      });
      return channel;
    },
  };
  const context = () => ({ targetId: TARGET_ID, hostFingerprint: FINGERPRINT, generation, session });
  const source = controlledSource(Buffer.from("paper"));
  const service = new EvidenceCacheService({
    getContext: async () => context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: async () => { generation += 1; return context(); },
    randomTransferId: () => "d".repeat(32),
  });
  await assert.rejects(service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }), error => error?.code === "SSH_TRANSPORT");
  assert.equal(source.closed, 1);
  generation += 1;
  assert.equal(await service.cleanupSession(context()), 0);
  assert.deepEqual(frames.map(frame => frame.operation ?? frame.type), [
    "stage", "stage", "stage", "abort", "cleanup",
  ]);
  await service.dispose();
});

test("concurrent cleanup generations claim one pending transaction without releasing another stage", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const sources = [
    controlledSource(bytes),
    controlledSource(bytes),
    controlledSource(bytes),
  ];
  const pendingTransferId = "1".repeat(32);
  const heldTransferId = "2".repeat(32);
  const transferIds = [pendingTransferId, heldTransferId, "3".repeat(32)];
  let sourceIndex = 0;
  let generation = 1;
  let cleanupPhase = false;
  let pendingAbortCount = 0;
  const pendingCleanupChannels = [];
  let resolvePendingCleanupOpened;
  const pendingCleanupOpened = new Promise(resolve => { resolvePendingCleanupOpened = resolve; });
  let releaseHeldStage;
  let resolveHeldFinalize;
  const heldFinalize = new Promise(resolve => { resolveHeldFinalize = resolve; });

  const sessionA = {
    openEvidenceCache() {
      let request;
      return new FakeEvidenceChannel((frame, value) => {
        if (frame.operation === "stage") {
          request = frame;
          if (frame.transferId === pendingTransferId) {
            if (!cleanupPhase) {
              value.emitClose({ code: 255, signal: null, error: null });
            }
            else {
              pendingCleanupChannels.push(value);
              if (pendingCleanupChannels.length === 1) queueMicrotask(resolvePendingCleanupOpened);
            }
          }
          else if (frame.transferId === heldTransferId) {
            value.emit({
              type: "resume",
              offset: 0,
              prefixDigest: createHash("sha256").digest("hex"),
            });
          }
        }
        else if (frame.type === "abort" && request?.transferId === pendingTransferId) {
          pendingAbortCount += 1;
          value.emit({ type: "aborted" });
          value.emitClose();
        }
        else if (frame.type === "finalize" && request?.transferId === heldTransferId) {
          releaseHeldStage = () => {
            value.emit({
              type: "complete",
              createdAt: "2099-01-01T00:00:00.000Z",
              digest,
              size: request.size,
              expiresAt: "2099-01-02T00:00:00.000Z",
              remotePath: `/home/a/.cache/chatero/evidence/${digest}.${"a".repeat(64)}.pdf`,
            });
            value.emitClose();
          };
          queueMicrotask(resolveHeldFinalize);
        }
        else if (frame.operation === "cleanup") {
          value.emit({ type: "cleaned", count: 0 });
          value.emitClose();
        }
      });
    },
  };
  const contextA = () => ({
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation,
    session: sessionA,
  });
  const remoteB = makeServiceSession({
    fingerprint: OTHER_FINGERPRINT,
    instance: "b".repeat(64),
  });
  let currentContext = contextA();
  const service = new EvidenceCacheService({
    getContext: async () => currentContext,
    getZoteroApi: async () => ({
      redeemFullPdfGrant: async () => sources[sourceIndex++].value,
    }),
    reconnect: async () => {
      generation += 1;
      currentContext = contextA();
      return currentContext;
    },
    randomTransferId: () => transferIds.shift(),
  });

  try {
    await assert.rejects(service.stageEvidence({
      grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
    }), error => error?.code === "SSH_TRANSPORT");
    cleanupPhase = true;

    const heldStage = service.stageEvidence({
      grantId: Buffer.alloc(32, 20).toString("base64url"),
      targetId: TARGET_ID,
      ttlSeconds: 86400,
    });
    await heldFinalize;

    const firstCleanup = service.cleanupSession({ ...contextA(), generation: 3 });
    await pendingCleanupOpened;
    const secondCleanup = service.cleanupSession({ ...contextA(), generation: 4 });
    await delay(0);
    for (const channel of pendingCleanupChannels) {
      channel.emit({
        type: "resume",
        offset: 0,
        prefixDigest: createHash("sha256").digest("hex"),
      });
    }
    await Promise.all([firstCleanup, secondCleanup]);

    currentContext = remoteB.context();
    const otherHostOutcome = await service.stageEvidence({
      grantId: Buffer.alloc(32, 21).toString("base64url"),
      targetId: TARGET_ID,
      ttlSeconds: 86400,
    }).then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }));

    releaseHeldStage();
    const heldOutcome = await heldStage.then(
      value => ({ status: "fulfilled", value }),
      reason => ({ status: "rejected", reason }),
    );

    assert.equal(pendingAbortCount, 1, "only one cleanup may claim the pending transfer");
    assert.equal(remoteB.state.openCount, 0, "another host must remain fenced while the held stage owns its reservation");
    assert.equal(otherHostOutcome.status, "rejected");
    assert.match(otherHostOutcome.reason.message, /another authenticated host/i);
    assert.equal(heldOutcome.status, "fulfilled");
    assert.equal(heldOutcome.value.digest, digest);
  }
  finally {
    releaseHeldStage?.();
    await service.dispose();
  }
});

test("a fresh cleanup generation retries a shared pending transaction after the stale generation fails", async () => {
  const bytes = Buffer.from("paper");
  const pendingTransferId = "4".repeat(32);
  let generation = 1;
  let initialAttempts = 0;
  let staleCleanupChannel;
  let resolveStaleCleanupOpened;
  const staleCleanupOpened = new Promise(resolve => { resolveStaleCleanupOpened = resolve; });
  const operations = [];
  const session = {
    openEvidenceCache(expected) {
      let request;
      return new FakeEvidenceChannel((frame, value) => {
        if (frame.operation) {
          request = frame;
          operations.push([frame.operation, expected.generation]);
        }
        if (frame.operation === "stage" && initialAttempts < 2) {
          initialAttempts += 1;
          value.emitClose({ code: 255, signal: null, error: null });
        }
        else if (frame.operation === "stage" && expected.generation === 3) {
          staleCleanupChannel = value;
          queueMicrotask(resolveStaleCleanupOpened);
        }
        else if (frame.operation === "stage" && expected.generation === 4) {
          value.emit({
            type: "resume",
            offset: 0,
            prefixDigest: createHash("sha256").digest("hex"),
          });
        }
        else if (frame.type === "abort" && request?.transferId === pendingTransferId) {
          value.emit({ type: "aborted" });
          value.emitClose();
        }
        else if (frame.operation === "cleanup") {
          value.emit({ type: "cleaned", count: 0 });
          value.emitClose();
        }
      });
    },
  };
  const context = value => ({
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: value,
    session,
  });
  const source = controlledSource(bytes);
  const service = new EvidenceCacheService({
    getContext: async () => context(generation),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: async () => {
      generation = 2;
      return context(generation);
    },
    randomTransferId: () => pendingTransferId,
  });

  try {
    await assert.rejects(service.stageEvidence({
      grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
    }), error => error?.code === "SSH_TRANSPORT");

    const staleCleanup = service.cleanupSession(context(3)).then(
      value => ({ status: "fulfilled", value }),
      reason => ({ status: "rejected", reason }),
    );
    await staleCleanupOpened;
    const freshCleanup = service.cleanupSession(context(4));
    await delay(0);
    staleCleanupChannel.emitClose({ code: 255, signal: null, error: null });

    const staleOutcome = await staleCleanup;
    assert.equal(staleOutcome.status, "rejected");
    assert.equal(staleOutcome.reason.code, "SSH_TRANSPORT");
    assert.equal(await freshCleanup, 0);
    assert.deepEqual(operations, [
      ["stage", 1],
      ["stage", 2],
      ["stage", 3],
      ["cleanup", 3],
      ["stage", 4],
      ["cleanup", 4],
    ]);
  }
  finally {
    staleCleanupChannel?.emitClose({ code: 255, signal: null, error: null });
    await service.dispose();
  }
});

test("a pending transfer key cannot be reused and its original transaction remains cleanable", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const transferId = "5".repeat(32);
  const sources = [controlledSource(bytes), controlledSource(bytes)];
  let sourceIndex = 0;
  let generation = 1;
  let phase = "initial";
  let openCount = 0;
  let abortCount = 0;
  const session = {
    openEvidenceCache(expected) {
      assert.equal(expected.generation, generation);
      openCount += 1;
      let request;
      return new FakeEvidenceChannel((frame, value) => {
        if (frame.operation === "stage") {
          request = frame;
          if (phase === "initial") {
            value.emitClose({ code: 255, signal: null, error: null });
          }
          else {
            value.emit({
              type: "resume",
              offset: 0,
              prefixDigest: createHash("sha256").digest("hex"),
            });
          }
        }
        else if (frame.type === "abort" && request?.transferId === transferId) {
          abortCount += 1;
          value.emit({ type: "aborted" });
          value.emitClose();
        }
        else if (frame.type === "finalize" && phase === "reuse") {
          value.emit({
            type: "complete",
            createdAt: "2099-01-01T00:00:00.000Z",
            digest,
            size: request.size,
            expiresAt: "2099-01-02T00:00:00.000Z",
            remotePath: `/home/a/.cache/chatero/evidence/${digest}.${"d".repeat(64)}.pdf`,
          });
          value.emitClose();
        }
        else if (frame.operation === "cleanup") {
          value.emit({ type: "cleaned", count: 0 });
          value.emitClose();
        }
      });
    },
  };
  const context = () => ({ targetId: TARGET_ID, hostFingerprint: FINGERPRINT, generation, session });
  const service = new EvidenceCacheService({
    getContext: async () => context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[sourceIndex++].value }),
    reconnect: async () => {
      generation = 2;
      return context();
    },
    randomTransferId: () => transferId,
  });

  try {
    await assert.rejects(service.stageEvidence({
      grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
    }), error => error?.code === "SSH_TRANSPORT");
    assert.equal(openCount, 2);

    phase = "reuse";
    const reused = await service.stageEvidence({
      grantId: Buffer.alloc(32, 22).toString("base64url"),
      targetId: TARGET_ID,
      ttlSeconds: 86400,
    }).then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }));
    assert.equal(reused.status, "rejected");
    assert.match(reused.reason.message, /transfer.*already|transfer.*unavailable/i);
    assert.equal(openCount, 2, "a reused active/pending transfer key must fail before helper spawn");

    phase = "cleanup";
    generation = 3;
    assert.equal(await service.cleanupSession(context()), 0);
    assert.equal(abortCount, 1, "the original pending transfer remains addressable");
  }
  finally { await service.dispose(); }
});

test("cleanup prioritizes and fairly sweeps every queued revoke before pending transactions", async () => {
  const payloads = {
    pendingBad: Buffer.from("pending-bad"),
    pendingGood: Buffer.from("pending-good"),
    revokeBad: Buffer.from("revoke-bad"),
    revokeGood: Buffer.from("revoke-good"),
  };
  const digests = Object.fromEntries(Object.entries(payloads).map(([key, value]) => [
    key,
    createHash("sha256").update(value).digest("hex"),
  ]));
  const digestNames = new Map(Object.entries(digests).map(([name, digest]) => [digest, name]));
  const sources = Object.values(payloads).map(value => controlledSource(value));
  let sourceIndex = 0;
  let transferIndex = 0;
  let generation = 1;
  let cleanupMode = false;
  let contextUnavailable = false;
  const cleanupOperations = [];
  const session = {
    openEvidenceCache() {
      let request;
      return new FakeEvidenceChannel((frame, value) => {
        if (frame.operation) request = frame;
        const name = request?.digest && digestNames.get(request.digest);
        if (cleanupMode && frame.operation) cleanupOperations.push(`${frame.operation}:${name ?? "none"}`);
        if (frame.operation === "stage" && !cleanupMode
            && (name === "pendingBad" || name === "pendingGood")) {
          value.emitClose({ code: 255, signal: null, error: null });
        }
        else if (frame.operation === "stage" && cleanupMode && name === "pendingBad") {
          value.emit({ type: "error", code: "bad-transaction" });
          value.emitClose();
        }
        else if (frame.operation === "stage") {
          value.emit({
            type: "resume",
            offset: 0,
            prefixDigest: createHash("sha256").digest("hex"),
          });
        }
        else if (frame.type === "abort") {
          cleanupOperations.push(`abort:${name}`);
          value.emit({ type: "aborted" });
          value.emitClose();
        }
        else if (frame.type === "finalize") {
          value.emit({
            type: "complete",
            createdAt: "2099-01-01T00:00:00.000Z",
            digest: request.digest,
            size: request.size,
            expiresAt: "2099-01-02T00:00:00.000Z",
            remotePath: `/home/a/.cache/chatero/evidence/${request.digest}.${"f".repeat(64)}.pdf`,
          });
          value.emitClose();
        }
        else if (frame.operation === "revoke" && name === "revokeBad") {
          value.emit({ type: "error", code: "bad-revoke" });
          value.emitClose();
        }
        else if (frame.operation === "revoke") {
          value.emit({ type: "revoked" });
          value.emitClose();
        }
        else if (frame.operation === "cleanup") {
          value.emit({ type: "cleaned", count: 0 });
          value.emitClose();
        }
      });
    },
  };
  const context = () => ({ targetId: TARGET_ID, hostFingerprint: FINGERPRINT, generation, session });
  const service = new EvidenceCacheService({
    getContext: () => {
      if (contextUnavailable) throw new Error("context unavailable");
      return context();
    },
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[sourceIndex++].value }),
    reconnect: async () => {
      generation += 1;
      return context();
    },
    randomTransferId: () => (++transferIndex).toString(16).repeat(32),
  });

  try {
    for (const index of [0, 1]) {
      await assert.rejects(service.stageEvidence({
        grantId: index === 0 ? "A".repeat(43) : Buffer.alloc(32, 25).toString("base64url"),
        targetId: TARGET_ID,
        ttlSeconds: 86400,
      }), error => error?.code === "SSH_TRANSPORT");
    }
    const revokeResults = [];
    for (const index of [2, 3]) {
      revokeResults.push(await service.stageEvidence({
        grantId: Buffer.alloc(32, 25 + index).toString("base64url"),
        targetId: TARGET_ID,
        ttlSeconds: 86400,
      }));
    }
    contextUnavailable = true;
    for (const result of revokeResults) {
      await assert.rejects(
        service.revokeEvidence({ targetId: TARGET_ID, digest: result.digest }),
        /context unavailable/i,
      );
    }
    contextUnavailable = false;
    cleanupMode = true;
    generation += 1;
    await assert.rejects(
      service.cleanupSession(context()),
      /bad-revoke|bad-transaction|helper failed|pending cleanup failed/i,
    );
    assert.deepEqual(cleanupOperations, [
      "revoke:revokeBad",
      "revoke:revokeGood",
      "stage:pendingBad",
      "stage:pendingGood",
      "abort:pendingGood",
      "cleanup:none",
    ]);
  }
  finally { await service.dispose(); }
});

test("two active stages cannot share one transfer key", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const transferId = "6".repeat(32);
  const sources = [controlledSource(bytes), controlledSource(bytes)];
  let sourceIndex = 0;
  let openCount = 0;
  let request;
  let firstChannel;
  let resolveFirstOpened;
  const firstOpened = new Promise(resolve => { resolveFirstOpened = resolve; });
  const context = {
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: 1,
    session: {
      openEvidenceCache() {
        openCount += 1;
        return new FakeEvidenceChannel((frame, value) => {
          if (frame.operation === "stage") {
            request = frame;
            firstChannel = value;
            queueMicrotask(resolveFirstOpened);
          }
          else if (frame.type === "finalize") {
            value.emit({
              type: "complete",
              createdAt: "2099-01-01T00:00:00.000Z",
              digest,
              size: request.size,
              expiresAt: "2099-01-02T00:00:00.000Z",
              remotePath: `/home/a/.cache/chatero/evidence/${digest}.${"e".repeat(64)}.pdf`,
            });
            value.emitClose();
          }
        });
      },
    },
  };
  const service = new EvidenceCacheService({
    getContext: async () => context,
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => sources[sourceIndex++].value }),
    reconnect: async () => context,
    randomTransferId: () => transferId,
  });

  try {
    const first = service.stageEvidence({
      grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
    });
    await firstOpened;
    await assert.rejects(service.stageEvidence({
      grantId: Buffer.alloc(32, 23).toString("base64url"),
      targetId: TARGET_ID,
      ttlSeconds: 86400,
    }), /transfer.*already|transfer.*unavailable/i);
    assert.equal(openCount, 1);
    firstChannel.emit({
      type: "resume",
      offset: 0,
      prefixDigest: createHash("sha256").digest("hex"),
    });
    assert.equal((await first).digest, digest);
  }
  finally {
    firstChannel?.emitClose({ code: 255, signal: null, error: null });
    await service.dispose();
  }
});

test("the first transport loss remains pending when reconnect throws or authenticates another host", async t => {
  for (const [name, reconnect] of [
    ["reconnect throws", async () => { throw new Error("network unavailable"); }],
    ["host fingerprint changes", async () => ({
      targetId: TARGET_ID,
      hostFingerprint: OTHER_FINGERPRINT,
      generation: 1,
      session: { openEvidenceCache() { throw new Error("must not open changed host"); } },
    })],
  ]) {
    await t.test(name, async () => {
      let first = true;
      const frames = [];
      const session = {
        openEvidenceCache() {
          const channel = new FakeEvidenceChannel((frame, value) => {
            frames.push(frame.operation ?? frame.type);
            if (first && frame.operation === "stage") {
              first = false;
              value.emitClose({ code: 255, signal: null, error: null });
            }
            else if (frame.operation === "stage") {
              value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
            }
            else if (frame.type === "abort") {
              value.emit({ type: "aborted" });
              value.emitClose();
            }
            else if (frame.operation === "cleanup") {
              value.emit({ type: "cleaned", count: 0 });
              value.emitClose();
            }
          });
          return channel;
        },
      };
      const initial = { targetId: TARGET_ID, hostFingerprint: FINGERPRINT, generation: 1, session };
      const source = controlledSource(Buffer.from("paper"));
      const service = new EvidenceCacheService({
        getContext: async () => initial,
        getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
        reconnect,
        randomTransferId: () => "f".repeat(32),
      });
      await assert.rejects(service.stageEvidence({
        grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
      }));
      assert.equal(await service.cleanupSession({ ...initial, generation: 2 }), 0);
      assert.deepEqual(frames, ["stage", "stage", "abort", "cleanup"]);
      await service.dispose();
    });
  }
});

test("a second-generation post-finalize failure is compensated on that exact generation", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const source = controlledSource(bytes);
  const operations = [];
  let generation = 1;
  let openNumber = 0;
  const session = {
    openEvidenceCache(expected) {
      assert.deepEqual(expected, { generation, hostFingerprint: FINGERPRINT });
      openNumber += 1;
      const openedGeneration = generation;
      let request;
      return new FakeEvidenceChannel((frame, value) => {
        if (frame.operation) {
          request = frame;
          operations.push([frame.operation, openedGeneration]);
        }
        if (frame.operation === "stage" && openNumber === 1) {
          value.emitClose({ code: 255, signal: null, error: null });
        }
        else if (frame.operation === "stage") {
          value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
        }
        else if (frame.type === "finalize") {
          value.emit({
            type: "complete",
            createdAt: "2099-01-01T00:00:00.000Z",
            digest: "f".repeat(64),
            size: request.size,
            expiresAt: "2099-01-02T00:00:00.000Z",
            remotePath: `/home/alice/.cache/chatero/evidence/${"f".repeat(64)}.${"a".repeat(64)}.pdf`,
          });
          value.emitClose();
        }
        else if (frame.operation === "revoke") {
          value.emit({ type: "revoked" });
          value.emitClose();
        }
      });
    },
  };
  const context = () => ({ targetId: TARGET_ID, hostFingerprint: FINGERPRINT, generation, session });
  const service = new EvidenceCacheService({
    getContext: async () => context(),
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: async () => { generation = 2; return context(); },
  });
  await assert.rejects(service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }), /mismatch/i);
  assert.deepEqual(operations, [["stage", 1], ["stage", 2], ["revoke", 2]]);
  assert.equal(digest.length, 64);
  await service.dispose();
});

test("a confirmed abort after reconnect leaves no ghost reservation or pending transaction", async () => {
  const bytes = Buffer.from("paper");
  const sourceA = controlledSource(bytes);
  const sourceB = controlledSource(bytes);
  let generation = 1;
  let opensA = 0;
  const sessionA = {
    openEvidenceCache(expected) {
      assert.deepEqual(expected, { generation, hostFingerprint: FINGERPRINT });
      opensA += 1;
      const attempt = opensA;
      return new FakeEvidenceChannel((frame, value) => {
        if (frame.operation === "stage" && attempt === 1) {
          value.emitClose({ code: 255, signal: null, error: null });
        }
        else if (frame.operation === "stage") {
          value.emit({ type: "resume", offset: 1, prefixDigest: "f".repeat(64) });
        }
        else if (frame.type === "abort") {
          value.emit({ type: "aborted" });
          value.emitClose();
        }
      });
    },
  };
  const remoteB = makeServiceSession({ fingerprint: OTHER_FINGERPRINT, instance: "b".repeat(64) });
  let current = { targetId: TARGET_ID, hostFingerprint: FINGERPRINT, generation, session: sessionA };
  let sourceIndex = 0;
  const service = new EvidenceCacheService({
    getContext: async () => current,
    getZoteroApi: async () => ({
      redeemFullPdfGrant: async () => [sourceA.value, sourceB.value][sourceIndex++],
    }),
    reconnect: async () => {
      generation = 2;
      current = { ...current, generation };
      return current;
    },
  });
  await assert.rejects(service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }), /prefix digest/i);
  current = remoteB.context();
  await service.stageEvidence({
    grantId: Buffer.alloc(32, 19).toString("base64url"),
    targetId: TARGET_ID,
    ttlSeconds: 86400,
  });
  assert.equal(remoteB.state.openCount, 1);
  await service.dispose();
});

test("a transport loss after finalize never retries staging and is compensated digest-wide", async () => {
  const operations = [];
  let reconnectCalls = 0;
  const context = {
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: 1,
    session: {
      openEvidenceCache() {
        let request;
        return new FakeEvidenceChannel((frame, value) => {
          if (frame.operation) {
            request = frame;
            operations.push(frame.operation);
          }
          if (frame.operation === "stage") {
            value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
          }
          else if (frame.type === "finalize") {
            assert.equal(request.operation, "stage");
            value.emitClose({ code: 255, signal: null, error: null });
          }
          else if (frame.operation === "revoke") {
            value.emit({ type: "revoked" });
            value.emitClose();
          }
        });
      },
    },
  };
  const source = controlledSource(Buffer.from("paper"));
  const service = new EvidenceCacheService({
    getContext: async () => context,
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: async () => { reconnectCalls += 1; return context; },
  });
  await assert.rejects(service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }), error => error?.code === "SSH_TRANSPORT");
  assert.equal(reconnectCalls, 0);
  assert.deepEqual(operations, ["stage", "revoke"]);
  await service.dispose();
});

test("an unconfirmed pre-publish abort is retried on a fresh fixed helper without revoking other instances", async () => {
  let opens = 0;
  const frames = [];
  const context = {
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: 1,
    session: {
      openEvidenceCache() {
        opens += 1;
        const openNumber = opens;
        const channel = new FakeEvidenceChannel((frame, value) => {
          frames.push(frame.operation ?? frame.type);
          if (frame.operation === "stage") {
            value.emit({
              type: "resume",
              offset: openNumber === 1 ? 1 : 0,
              prefixDigest: openNumber === 1 ? "f".repeat(64) : createHash("sha256").digest("hex"),
            });
          }
          else if (frame.type === "abort") {
            if (openNumber === 1) throw new Error("first abort write was not confirmed");
            value.emit({ type: "aborted" });
            value.emitClose();
          }
        });
        return channel;
      },
    },
  };
  const source = controlledSource(Buffer.from("paper"));
  const service = new EvidenceCacheService({
    getContext: async () => context,
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: async () => context,
    randomTransferId: () => "e".repeat(32),
  });
  await assert.rejects(service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }), /prefix digest/i);
  assert.deepEqual(frames, ["stage", "abort", "stage", "abort"]);
  await service.dispose();
});

test("dispose drains post-finalize compensation without opening a public channel afterwards", async () => {
  const bytes = Buffer.from("paper");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const source = controlledSource(bytes);
  const operations = [];
  let service;
  let disposePromise;
  const context = {
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: 1,
    session: {
      openEvidenceCache() {
        let request;
        return new FakeEvidenceChannel((frame, value) => {
          if (frame.operation) {
            request = frame;
            operations.push(frame.operation);
          }
          if (frame.operation === "stage") {
            value.emit({ type: "resume", offset: 0, prefixDigest: createHash("sha256").digest("hex") });
          }
          else if (frame.type === "finalize") {
            value.emit({
              type: "complete",
              createdAt: "2099-01-01T00:00:00.000Z",
              digest: "f".repeat(64),
              size: request.size,
              expiresAt: "2099-01-02T00:00:00.000Z",
              remotePath: `/home/alice/.cache/chatero/evidence/${"f".repeat(64)}.${"a".repeat(64)}.pdf`,
            });
            queueMicrotask(() => { disposePromise = service.dispose(); });
          }
          else if (frame.operation === "revoke") {
            value.emit({ type: "revoked" });
            value.emitClose();
          }
        });
      },
    },
  };
  service = new EvidenceCacheService({
    getContext: async () => context,
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: async () => context,
  });
  await assert.rejects(service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }), /mismatch/i);
  await disposePromise;
  assert.deepEqual(operations, ["stage", "revoke"]);
  await assert.rejects(service.cleanupSession(context), /disposed/i);
  assert.deepEqual(operations, ["stage", "revoke"]);
  assert.equal(digest.length, 64);
});

test("simple helper protocols close cleanly and reject extra terminal fields", async () => {
  const good = new FakeEvidenceChannel((_request, value) => {
    value.emit({ type: "revoked" });
    value.emitClose();
  });
  await runSimpleProtocol(good, { protocolVersion: 1, operation: "revoke", digest: DIGEST }, undefined, "revoked");
  assert.equal(good.ended, 1);

  const extra = new FakeEvidenceChannel((_request, value) => {
    value.emit({ type: "revoked", path: "/private/leak" });
    value.emitClose();
  });
  await assert.rejects(
    runSimpleProtocol(extra, { protocolVersion: 1, operation: "revoke", digest: DIGEST }, undefined, "revoked"),
    /fields/i,
  );
});

function helperProcess(home, { execArgv = [], env = {} } = {}) {
  const child = spawn(process.execPath, [...execArgv, HELPER_PATH], {
    env: { ...process.env, HOME: home, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  const stderr = [];
  const frames = [];
  const waiters = [];
  child.stdout.on("data", chunk => {
    stdout = Buffer.concat([stdout, chunk]);
    for (;;) {
      const newline = stdout.indexOf(0x0a);
      if (newline < 0) break;
      const frame = JSON.parse(stdout.subarray(0, newline).toString("utf8"));
      stdout = stdout.subarray(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame);
      else frames.push(frame);
    }
  });
  child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
  const closed = once(child, "close").then(result => {
    const error = new Error(`helper closed before frame: ${Buffer.concat(stderr).toString("utf8")}`);
    for (const waiter of waiters.splice(0)) waiter.reject(error);
    return result;
  });
  return {
    child,
    closed,
    write(value) { child.stdin.write(`${JSON.stringify(value)}\n`); },
    next() {
      if (frames.length) return Promise.resolve(frames.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for helper frame: ${Buffer.concat(stderr).toString("utf8")}`)),
          5_000,
        );
        waiters.push({
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); },
        });
      });
    },
    async closeInput() {
      child.stdin.end();
      const [code, signal] = await closed;
      return { code, signal, frames };
    },
  };
}

function rawHelperChannel(home, {
  execArgv = [],
  env = {},
  blockChunkDrain = false,
  onChunk = () => {},
} = {}) {
  const child = spawn(process.execPath, [...execArgv, HELPER_PATH], {
    env: { ...process.env, HOME: home, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const dataListeners = new Set();
  const closeListeners = new Set();
  let closed = false;
  child.stdout.on("data", bytes => {
    for (const listener of [...dataListeners]) listener(Uint8Array.from(bytes));
  });
  child.stdin.on("error", () => {});
  const emitClose = (code, signal, error = null) => {
    if (closed) return;
    closed = true;
    for (const listener of [...closeListeners]) listener({ code, signal, error });
  };
  child.on("error", error => emitClose(null, null, error));
  child.on("close", (code, signal) => emitClose(code, signal));
  const channel = {
    write(bytes) {
      const buffer = Buffer.from(bytes);
      const accepted = child.stdin.write(buffer);
      if (blockChunkDrain && buffer.includes(Buffer.from('"type":"chunk"'))) {
        onChunk();
        return false;
      }
      return accepted;
    },
    drain() {
      if (blockChunkDrain) return new Promise(() => {});
      return Promise.resolve();
    },
    end() { child.stdin.end(); },
    close() { if (!closed) child.kill("SIGTERM"); },
    onData(listener) {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onClose(listener) {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
  };
  return { channel, child, closed: once(child, "close") };
}

async function temporaryHome(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

linuxTest("dispose receives a real helper abort acknowledgement and leaves no partial transaction", async t => {
  const home = await temporaryHome("chatero-evidence-dispose-abort-");
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.allSettled(children.map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : once(child, "close")));
    await rm(home, { recursive: true, force: true });
  });
  let chunkReady;
  const sawChunk = new Promise(resolve => { chunkReady = resolve; });
  const context = {
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: 1,
    session: {
      openEvidenceCache() {
        const opened = rawHelperChannel(home, { blockChunkDrain: true, onChunk: chunkReady });
        children.push(opened.child);
        return opened.channel;
      },
    },
  };
  const source = controlledSource(Buffer.from("%PDF dispose real helper"));
  const service = new EvidenceCacheService({
    getContext: async () => context,
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: async () => context,
    randomTransferId: () => "9".repeat(32),
  });
  const staging = service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }).catch(error => error);
  await sawChunk;
  await service.dispose();
  assert.equal((await staging).name, "AbortError");
  const entries = await readdir(join(home, ".cache", "chatero", "evidence"));
  assert.equal(entries.some(entry => entry.includes("9".repeat(32))
    && /\.(?:part|state\.json)$/u.test(entry)), false);
});

linuxTest("dispose waits through a delayed real finalize then revokes the published instance", async t => {
  const home = await temporaryHome("chatero-evidence-dispose-finalize-");
  const hook = join(home, "pause-finalize.cjs");
  const ready = join(home, "finalize-ready");
  const release = join(home, "finalize-release");
  const children = [];
  t.after(async () => {
    await writeFile(release, "release").catch(() => {});
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.allSettled(children.map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : once(child, "close")));
    await rm(home, { recursive: true, force: true });
  });
  await writeFile(hook, [
    'const fs = require("node:fs");',
    'const { syncBuiltinESMExports } = require("node:module");',
    'const original = fs.promises.link.bind(fs.promises);',
    'fs.promises.link = async (from, to) => {',
    '  if (/\\.[0-9a-f]{64}\\.pdf$/.test(to)) {',
    '    await fs.promises.writeFile(process.env.CHATERO_TEST_READY, "ready");',
    '    while (!fs.existsSync(process.env.CHATERO_TEST_RELEASE)) await new Promise(resolve => setTimeout(resolve, 2));',
    '  }',
    '  return original(from, to);',
    '};',
    'syncBuiltinESMExports();',
  ].join("\n"));
  let opens = 0;
  const context = {
    targetId: TARGET_ID,
    hostFingerprint: FINGERPRINT,
    generation: 1,
    session: {
      openEvidenceCache() {
        opens += 1;
        const opened = rawHelperChannel(home, opens === 1 ? {
          execArgv: ["--require", hook],
          env: { CHATERO_TEST_READY: ready, CHATERO_TEST_RELEASE: release },
        } : {});
        children.push(opened.child);
        return opened.channel;
      },
    },
  };
  const bytes = Buffer.from("%PDF delayed finalize dispose");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const source = controlledSource(bytes);
  const service = new EvidenceCacheService({
    getContext: async () => context,
    getZoteroApi: async () => ({ redeemFullPdfGrant: async () => source.value }),
    reconnect: async () => context,
    randomTransferId: () => "a".repeat(32),
  });
  const staging = service.stageEvidence({
    grantId: "A".repeat(43), targetId: TARGET_ID, ttlSeconds: 86400,
  }).catch(error => error);
  for (let attempt = 0; attempt < 1_000 && !await lstat(ready).then(() => true, () => false); attempt++) await delay(2);
  assert.equal(await lstat(ready).then(() => true, () => false), true);
  let disposed = false;
  const disposing = service.dispose().then(() => { disposed = true; });
  await delay(300);
  assert.equal(disposed, false, "dispose waits for the accepted finalize transaction");
  await writeFile(release, "release");
  await disposing;
  assert.equal((await staging).name, "AbortError");
  const entries = await readdir(join(home, ".cache", "chatero", "evidence"));
  assert.equal(entries.some(entry => entry.startsWith(`${digest}.`)
    && /\.(?:pdf|meta\.json|part|state\.json)$/u.test(entry)), false);
});

async function completeHelperStage(home, bytes, { transferId = "1".repeat(32) } = {}) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const helper = helperProcess(home);
  helper.write({
    protocolVersion: 1,
    operation: "stage",
    digest,
    size: bytes.length,
    transferId,
    ttlSeconds: 86400,
  });
  const resume = await helper.next();
  helper.write({ type: "continue" });
  if (resume.offset < bytes.length) {
    helper.write({ type: "chunk", data: bytes.subarray(resume.offset).toString("base64") });
  }
  helper.write({ type: "finalize" });
  helper.child.stdin.end();
  const complete = await helper.next();
  const [code, signal] = await helper.closed;
  const closed = { code, signal };
  assert.equal(closed.code, 0);
  return { complete, digest, resume };
}

linuxTest("fixed helper stages an owner-only digest-verified PDF outside the workspace for exactly 24 hours", async t => {
  const home = await temporaryHome("chatero-evidence-helper-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const bytes = Buffer.from("%PDF-1.7\ncomplete fixture\n");
  const before = Date.now();
  const { complete, digest, resume } = await completeHelperStage(home, bytes);
  const after = Date.now();
  assert.deepEqual(resume, {
    type: "resume",
    offset: 0,
    prefixDigest: createHash("sha256").digest("hex"),
  });
  assert.equal(complete.type, "complete");
  assert.equal(complete.digest, digest);
  assert.equal(complete.size, bytes.length);
  assert.ok(Date.parse(complete.expiresAt) >= before + 86400_000);
  assert.ok(Date.parse(complete.expiresAt) <= after + 86400_000);
  assert.match(complete.remotePath, new RegExp(
    `^${join(home, ".cache", "chatero", "evidence", digest).replaceAll("/", "\\/")}\\.[0-9a-f]{64}\\.pdf$`,
  ));
  assert.deepEqual(await readFile(complete.remotePath), bytes);
  assert.equal((await lstat(join(home, ".cache", "chatero"))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(home, ".cache", "chatero", "evidence"))).mode & 0o777, 0o700);
  const finalMetadata = await lstat(complete.remotePath);
  assert.equal(finalMetadata.mode & 0o777, 0o600);
  assert.equal(finalMetadata.nlink, 1);
});

linuxTest("each explicit stage keeps an independent 24-hour generation and revoke removes them all", async t => {
  const home = await temporaryHome("chatero-evidence-generations-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const bytes = Buffer.from("%PDF repeated explicit authorization");
  const first = await completeHelperStage(home, bytes, { transferId: "a".repeat(32) });
  await delay(5);
  const second = await completeHelperStage(home, bytes, { transferId: "b".repeat(32) });
  assert.notEqual(first.complete.remotePath, second.complete.remotePath);
  assert.deepEqual(await readFile(first.complete.remotePath), bytes);
  assert.deepEqual(await readFile(second.complete.remotePath), bytes);
  assert.equal(Date.parse(first.complete.expiresAt) - Date.parse(first.complete.createdAt), 86400_000);
  assert.equal(Date.parse(second.complete.expiresAt) - Date.parse(second.complete.createdAt), 86400_000);

  const revoke = helperProcess(home);
  revoke.write({ protocolVersion: 1, operation: "revoke", digest: first.digest });
  revoke.child.stdin.end();
  assert.deepEqual(await revoke.next(), { type: "revoked" });
  assert.equal((await revoke.closed)[0], 0);
  await assert.rejects(readFile(first.complete.remotePath), /ENOENT/);
  await assert.rejects(readFile(second.complete.remotePath), /ENOENT/);
});

linuxTest("two concurrently confirmed grants for one digest both complete in distinct cache instances", async t => {
  const home = await temporaryHome("chatero-evidence-concurrent-instances-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const bytes = Buffer.from("%PDF concurrent explicit grants");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const helpers = [helperProcess(home), helperProcess(home)];
  for (let index = 0; index < helpers.length; index++) {
    helpers[index].write({
      protocolVersion: 1,
      operation: "stage",
      digest,
      size: bytes.length,
      transferId: String(index + 1).repeat(32),
      ttlSeconds: 86400,
    });
    await helpers[index].next();
    helpers[index].write({ type: "continue" });
    helpers[index].write({ type: "chunk", data: bytes.toString("base64") });
  }
  for (const helper of helpers) {
    helper.write({ type: "finalize" });
    helper.child.stdin.end();
  }
  const completed = await Promise.all(helpers.map(helper => helper.next()));
  assert.deepEqual(completed.map(frame => frame.type), ["complete", "complete"]);
  assert.notEqual(completed[0].remotePath, completed[1].remotePath);
  assert.deepEqual(await readFile(completed[0].remotePath), bytes);
  assert.deepEqual(await readFile(completed[1].remotePath), bytes);
});

linuxTest("helper resumes only a matching partial prefix and explicit abort removes the transaction", async t => {
  const home = await temporaryHome("chatero-evidence-resume-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const bytes = Buffer.from("%PDF resumable fixture bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const transferId = "2".repeat(32);
  const first = helperProcess(home);
  first.write({ protocolVersion: 1, operation: "stage", digest, size: bytes.length, transferId, ttlSeconds: 86400 });
  assert.equal((await first.next()).offset, 0);
  first.write({ type: "continue" });
  first.write({ type: "chunk", data: bytes.subarray(0, 8).toString("base64") });
  const interrupted = await first.closeInput();
  assert.equal(interrupted.code, 1);

  const resumed = helperProcess(home);
  resumed.write({ protocolVersion: 1, operation: "stage", digest, size: bytes.length, transferId, ttlSeconds: 86400 });
  assert.deepEqual(await resumed.next(), {
    type: "resume",
    offset: 8,
    prefixDigest: createHash("sha256").update(bytes.subarray(0, 8)).digest("hex"),
  });
  resumed.write({ type: "abort" });
  resumed.child.stdin.end();
  const aborted = await resumed.next();
  assert.deepEqual(aborted, { type: "aborted" });
  assert.equal((await resumed.closed)[0], 0);
  const root = join(home, ".cache", "chatero", "evidence");
  const entries = await readdir(root);
  assert.equal(entries.some(value => value.includes(transferId)), false);
});

linuxTest("same-transfer lease blocks a second writer and recovers a killed owner before resume", async t => {
  const home = await temporaryHome("chatero-evidence-transfer-lease-");
  const helpers = [];
  t.after(async () => {
    for (const helper of helpers) {
      if (helper.child.exitCode === null && helper.child.signalCode === null) helper.child.kill("SIGKILL");
    }
    await Promise.allSettled(helpers.map(helper => Promise.race([helper.closed, delay(1_000)])));
    await rm(home, { recursive: true, force: true });
  });
  const bytes = Buffer.from("%PDF one transfer has one writer");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const transferId = "c".repeat(32);
  const request = { protocolVersion: 1, operation: "stage", digest, size: bytes.length, transferId, ttlSeconds: 86400 };
  const first = helperProcess(home);
  helpers.push(first);
  first.write(request);
  await first.next();
  first.write({ type: "continue" });
  first.write({ type: "chunk", data: bytes.subarray(0, 9).toString("base64") });

  const second = helperProcess(home);
  helpers.push(second);
  second.write(request);
  let resumed = false;
  const resumePromise = second.next().then(frame => { resumed = true; return frame; });
  await delay(50);
  assert.equal(resumed, false);
  first.child.kill("SIGKILL");
  const resume = await resumePromise;
  assert.equal(resume.offset, 9);
  second.write({ type: "continue" });
  second.write({ type: "chunk", data: bytes.subarray(9).toString("base64") });
  second.write({ type: "finalize" });
  second.child.stdin.end();
  const complete = await second.next();
  assert.equal(complete.type, "complete");
  assert.deepEqual(await readFile(complete.remotePath), bytes);
});

linuxTest("revoke is idempotent, target-side generation wins a concurrent finalize, and removes the final", async t => {
  const home = await temporaryHome("chatero-evidence-revoke-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const bytes = Buffer.from("%PDF revoke race");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const stage = helperProcess(home);
  stage.write({ protocolVersion: 1, operation: "stage", digest, size: bytes.length, transferId: "3".repeat(32), ttlSeconds: 86400 });
  await stage.next();
  stage.write({ type: "continue" });
  stage.write({ type: "chunk", data: bytes.toString("base64") });

  for (let iteration = 0; iteration < 2; iteration++) {
    const revoke = helperProcess(home);
    revoke.write({ protocolVersion: 1, operation: "revoke", digest });
    revoke.child.stdin.end();
    assert.deepEqual(await revoke.next(), { type: "revoked" });
    assert.equal((await revoke.closed)[0], 0);
  }
  stage.write({ type: "finalize" });
  stage.child.stdin.end();
  assert.deepEqual(await stage.next(), { type: "error", code: "revoked" });
  assert.equal((await stage.closed)[0], 1);
  const entries = await readdir(join(home, ".cache", "chatero", "evidence"));
  assert.equal(entries.some(entry => entry.startsWith(`${digest}.`) && entry.endsWith(".pdf")), false);
});

linuxTest("revoke cannot return while an older generation is paused immediately before publish", async t => {
  const home = await temporaryHome("chatero-evidence-publish-barrier-");
  const hook = join(home, "pause-link.cjs");
  const ready = join(home, "publish-ready");
  const release = join(home, "publish-release");
  const helpers = [];
  t.after(async () => {
    await writeFile(release, "release").catch(() => {});
    for (const helper of helpers) {
      if (helper.child.exitCode === null && helper.child.signalCode === null) helper.child.kill("SIGTERM");
    }
    await Promise.allSettled(helpers.map(helper => Promise.race([helper.closed, delay(1_000)])));
    await rm(home, { recursive: true, force: true });
  });
  await writeFile(hook, [
    'const fs = require("node:fs");',
    'const { syncBuiltinESMExports } = require("node:module");',
    'const original = fs.promises.link.bind(fs.promises);',
    'fs.promises.link = async (from, to) => {',
    '  if (/(?:\\.[0-9a-f]{64})?\\.pdf$/.test(to)) {',
    '    await fs.promises.writeFile(process.env.CHATERO_TEST_READY, "ready");',
    '    while (!fs.existsSync(process.env.CHATERO_TEST_RELEASE)) await new Promise(resolve => setTimeout(resolve, 2));',
    '  }',
    '  return original(from, to);',
    '};',
    'syncBuiltinESMExports();',
  ].join("\n"));
  const bytes = Buffer.from("%PDF deterministic publish/revoke barrier");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const stage = helperProcess(home, {
    execArgv: ["--require", hook],
    env: { CHATERO_TEST_READY: ready, CHATERO_TEST_RELEASE: release },
  });
  helpers.push(stage);
  stage.write({
    protocolVersion: 1,
    operation: "stage",
    digest,
    size: bytes.length,
    transferId: "8".repeat(32),
    ttlSeconds: 86400,
  });
  await stage.next();
  stage.write({ type: "continue" });
  stage.write({ type: "chunk", data: bytes.toString("base64") });
  stage.write({ type: "finalize" });
  stage.child.stdin.end();
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await lstat(ready).then(() => true, () => false)) break;
    await delay(2);
  }
  assert.equal(await lstat(ready).then(() => true, () => false), true, "stage reached pre-publish barrier");

  const revoke = helperProcess(home);
  helpers.push(revoke);
  revoke.write({ protocolVersion: 1, operation: "revoke", digest });
  revoke.child.stdin.end();
  let revokeSettled = false;
  const revoked = revoke.next().then(frame => { revokeSettled = true; return frame; });
  await delay(50);
  const settledBeforeRelease = revokeSettled;
  const releasedAt = Date.now();
  await writeFile(release, "release");
  const [stageFrame, revokeFrame] = await Promise.all([stage.next(), revoked]);
  await Promise.all([stage.closed, revoke.closed]);
  assert.equal(settledBeforeRelease, false, "revoke must wait for the digest publish critical section");
  assert.equal(stageFrame.type, "complete");
  assert.ok(Date.parse(stageFrame.createdAt) >= releasedAt,
    "the exact 24-hour lifetime starts when the instance is actually published");
  assert.deepEqual(revokeFrame, { type: "revoked" });
  const root = join(home, ".cache", "chatero", "evidence");
  const entries = await readdir(root);
  assert.equal(entries.some(entry => entry.startsWith(`${digest}.`) && /\.(?:pdf|meta\.json)$/u.test(entry)), false);
});

linuxTest("a killed digest-lock owner and a killed recovery claimant are both recoverable", async t => {
  const home = await temporaryHome("chatero-evidence-lock-recovery-");
  const helpers = [];
  const releases = [join(home, "owner-release"), join(home, "claim-release")];
  t.after(async () => {
    await Promise.all(releases.map(path => writeFile(path, "release").catch(() => {})));
    for (const helper of helpers) {
      if (helper.child.exitCode === null && helper.child.signalCode === null) helper.child.kill("SIGKILL");
    }
    await Promise.allSettled(helpers.map(helper => Promise.race([helper.closed, delay(1_000)])));
    await rm(home, { recursive: true, force: true });
  });
  const hook = join(home, "lock-crash.cjs");
  await writeFile(hook, [
    'const fs = require("node:fs");',
    'const { syncBuiltinESMExports } = require("node:module");',
    'const link = fs.promises.link.bind(fs.promises);',
    'const rename = fs.promises.rename.bind(fs.promises);',
    'const pause = async () => {',
    '  await fs.promises.writeFile(process.env.CHATERO_TEST_READY, "ready");',
    '  while (!fs.existsSync(process.env.CHATERO_TEST_RELEASE)) await new Promise(resolve => setTimeout(resolve, 2));',
    '};',
    'fs.promises.link = async (from, to) => {',
    '  const result = await link(from, to);',
    '  if (process.env.CHATERO_TEST_PHASE === "owner" && to.endsWith(".lock")) await pause();',
    '  return result;',
    '};',
    'fs.promises.rename = async (from, to) => {',
    '  const result = await rename(from, to);',
    '  if (process.env.CHATERO_TEST_PHASE === "claim" && to.includes(".claim.")) await pause();',
    '  return result;',
    '};',
    'syncBuiltinESMExports();',
  ].join("\n"));
  const digest = createHash("sha256").update("lock crash").digest("hex");
  const request = { protocolVersion: 1, operation: "revoke", digest };

  const ownerReady = join(home, "owner-ready");
  const owner = helperProcess(home, {
    execArgv: ["--require", hook],
    env: {
      CHATERO_TEST_PHASE: "owner",
      CHATERO_TEST_READY: ownerReady,
      CHATERO_TEST_RELEASE: releases[0],
    },
  });
  helpers.push(owner);
  owner.write(request);
  owner.child.stdin.end();
  for (let attempt = 0; attempt < 500 && !await lstat(ownerReady).then(() => true, () => false); attempt++) await delay(2);
  assert.equal(await lstat(ownerReady).then(() => true, () => false), true);
  owner.child.kill("SIGKILL");

  const claimReady = join(home, "claim-ready");
  const claimant = helperProcess(home, {
    execArgv: ["--require", hook],
    env: {
      CHATERO_TEST_PHASE: "claim",
      CHATERO_TEST_READY: claimReady,
      CHATERO_TEST_RELEASE: releases[1],
    },
  });
  helpers.push(claimant);
  claimant.write(request);
  claimant.child.stdin.end();
  for (let attempt = 0; attempt < 500 && !await lstat(claimReady).then(() => true, () => false); attempt++) await delay(2);
  assert.equal(await lstat(claimReady).then(() => true, () => false), true);
  claimant.child.kill("SIGKILL");

  const recovered = helperProcess(home);
  helpers.push(recovered);
  recovered.write(request);
  recovered.child.stdin.end();
  assert.deepEqual(await recovered.next(), { type: "revoked" });
  assert.equal((await recovered.closed)[0], 0);
});

linuxTest("cleanup removes malformed metadata but does not rotate for an old-generation stale transaction", async t => {
  const home = await temporaryHome("chatero-evidence-cleanup-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const bytes = Buffer.from("%PDF cleanup generations");
  const staged = await completeHelperStage(home, bytes, { transferId: "d".repeat(32) });
  const root = join(home, ".cache", "chatero", "evidence");
  const generationPath = join(root, `${staged.digest}.generation`);
  const current = (await readFile(generationPath, "utf8")).trim();
  const staleTransfer = "e".repeat(32);
  const staleState = join(root, `${staged.digest}.${staleTransfer}.state.json`);
  const stalePart = join(root, `${staged.digest}.${staleTransfer}.part`);
  await writeFile(staleState, JSON.stringify({
    epoch: "f".repeat(64),
    instance: "a".repeat(64),
    size: bytes.length,
  }), { mode: 0o600 });
  await writeFile(stalePart, bytes, { mode: 0o600 });
  const old = new Date(Date.now() - 2 * 86400_000);
  await utimes(staleState, old, old);
  await utimes(stalePart, old, old);

  const cleanOld = helperProcess(home);
  cleanOld.write({ protocolVersion: 1, operation: "cleanup" });
  cleanOld.child.stdin.end();
  assert.equal((await cleanOld.next()).type, "cleaned");
  assert.equal((await cleanOld.closed)[0], 0);
  assert.equal((await readFile(generationPath, "utf8")).trim(), current);
  assert.deepEqual(await readFile(staged.complete.remotePath), bytes);

  const metaPath = staged.complete.remotePath.replace(/\.pdf$/u, ".meta.json");
  await writeFile(metaPath, '{"digest":"duplicate","digest":"fields"}', { mode: 0o600 });
  const cleanMalformed = helperProcess(home);
  cleanMalformed.write({ protocolVersion: 1, operation: "cleanup" });
  cleanMalformed.child.stdin.end();
  assert.equal((await cleanMalformed.next()).type, "cleaned");
  assert.equal((await cleanMalformed.closed)[0], 0);
  await assert.rejects(readFile(staged.complete.remotePath), /ENOENT/);
});

linuxTest("invalid and out-of-range metadata dates are cleaned without blocking later evidence", async t => {
  const home = await temporaryHome("chatero-evidence-invalid-date-");
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const [index, createdAt] of ["not-a-date", "+999999-01-01T00:00:00.000Z"].entries()) {
    const bytes = Buffer.from(`%PDF invalid metadata date ${index}`);
    const staged = await completeHelperStage(home, bytes, { transferId: String(index + 6).repeat(32) });
    const metaPath = staged.complete.remotePath.replace(/\.pdf$/u, ".meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    await writeFile(metaPath, JSON.stringify({ ...meta, createdAt }), { mode: 0o600 });
    const cleanup = helperProcess(home);
    cleanup.write({ protocolVersion: 1, operation: "cleanup" });
    cleanup.child.stdin.end();
    assert.equal((await cleanup.next()).type, "cleaned");
    assert.equal((await cleanup.closed)[0], 0);
    await assert.rejects(readFile(staged.complete.remotePath), /ENOENT/);
  }
});

linuxTest("malformed transaction state cannot block target-bound revoke", async t => {
  const home = await temporaryHome("chatero-evidence-malformed-state-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const bytes = Buffer.from("%PDF revoke despite malformed state");
  const staged = await completeHelperStage(home, bytes, { transferId: "4".repeat(32) });
  const root = join(home, ".cache", "chatero", "evidence");
  const transferId = "5".repeat(32);
  await writeFile(join(root, `${staged.digest}.${transferId}.state.json`), '{"epoch":"x","epoch":"y"}', { mode: 0o600 });
  await writeFile(join(root, `${staged.digest}.${transferId}.part`), bytes, { mode: 0o600 });
  const revoke = helperProcess(home);
  revoke.write({ protocolVersion: 1, operation: "revoke", digest: staged.digest });
  revoke.child.stdin.end();
  assert.deepEqual(await revoke.next(), { type: "revoked" });
  assert.equal((await revoke.closed)[0], 0);
  await assert.rejects(readFile(staged.complete.remotePath), /ENOENT/);
});

linuxTest("helper rejects duplicate, unknown, and oversized JSON without retaining a stage", async t => {
  const home = await temporaryHome("chatero-evidence-strict-json-");
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const [line, code] of [
    ['{"protocolVersion":1,"operation":"cleanup","operation":"cleanup"}\n', "input-canonical"],
    ['{"protocolVersion":1,"operation":"cleanup","unknown":true}\n', "cleanup-fields"],
    [`${"x".repeat(1024 * 1024 + 1)}\n`, "input-size"],
  ]) {
    const helper = helperProcess(home);
    helper.child.stdin.end(line);
    assert.deepEqual(await helper.next(), { type: "error", code });
    assert.equal((await helper.closed)[0], 1);
  }
});

linuxTest("helper rejects symlink and hardlink cache attacks", async t => {
  const home = await temporaryHome("chatero-evidence-unsafe-");
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".cache"));
  const outside = join(home, "outside");
  await mkdir(outside);
  await symlink(outside, join(home, ".cache", "chatero"));
  const unsafe = helperProcess(home);
  unsafe.write({ protocolVersion: 1, operation: "cleanup" });
  unsafe.child.stdin.end();
  assert.deepEqual(await unsafe.next(), { type: "error", code: "unsafe-directory" });
  assert.equal((await unsafe.closed)[0], 1);

  await rm(join(home, ".cache", "chatero"));
  await mkdir(join(home, ".cache", "chatero", "evidence"), { recursive: true });
  await chmod(join(home, ".cache", "chatero"), 0o700);
  await chmod(join(home, ".cache", "chatero", "evidence"), 0o700);
  const bytes = Buffer.from("%PDF hardlink");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const externalFile = join(home, "external.pdf");
  await writeFile(externalFile, bytes, { mode: 0o600 });
  await link(externalFile, join(home, ".cache", "chatero", "evidence", `${digest}.${"4".repeat(32)}.part`));
  const hardlink = helperProcess(home);
  hardlink.write({ protocolVersion: 1, operation: "stage", digest, size: bytes.length, transferId: "4".repeat(32), ttlSeconds: 86400 });
  hardlink.child.stdin.end();
  assert.deepEqual(await hardlink.next(), { type: "error", code: "unsafe-file" });
  assert.equal((await hardlink.closed)[0], 1);
  assert.deepEqual(await readFile(externalFile), bytes);
});

test("two signed artifacts for one commit and tuple install into distinct immutable roots", async () => {
  const paths = [];
  const remote = {
    async probe() { return "Linux\nx86_64\n6.8\n"; },
    async probeInstalled(input) { paths.push(input.installRelativePath); return true; },
    async discardPart() {},
    async createRuntime(input) {
      return {
        remotePort: 41001,
        agentHostPath: "/run/user/1000/a.sock",
        installPath: `/home/alice/${input.installRelativePath}`,
      };
    },
  };
  for (const digest of ["b".repeat(64), "c".repeat(64)]) {
    const installer = new RemoteAgentInstaller({
      remote,
      verifyRelease: async release => release.manifest,
      selectArtifact: manifest => manifest.artifacts[0],
      randomToken: () => "t".repeat(43),
    });
    await installer.ensureInstalled({
      alias: "lab-a",
      controlPath: "/tmp/master.sock",
      release: {
        manifest: {
          codeOssCommit: "a".repeat(40),
          artifacts: [{
            tuple: "linux-x86_64",
            filename: "agent.tar.gz",
            sha256: digest,
            size: 1,
            treeManifestSha256: "d".repeat(64),
            nodeSha256: "e".repeat(64),
            integrityVerifierSha256: "f".repeat(64),
          }],
        },
      },
    });
  }
  assert.deepEqual(paths, [
    `.chatero-server/artifacts-v1/${"b".repeat(64)}/${"a".repeat(40)}/linux-x86_64`,
    `.chatero-server/artifacts-v1/${"c".repeat(64)}/${"a".repeat(40)}/linux-x86_64`,
  ]);
});
