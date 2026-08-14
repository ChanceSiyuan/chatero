import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import {
  decodeAuthorityRequest,
  decodeAuthorityResponse,
  encodeAuthorityRequest,
  encodeAuthorityResponse,
} from "../documentation-authority/protocol.mjs";
import {
  runDocumentationAuthority,
} from "../documentation-authority/runtime/chatero-documentation-authority.mjs";
import {
  createFixedAuthorityTransport,
  makeFixedHelperInvocation,
} from "../extensions/chatero-documentation/documentation-authority-client.mjs";
import {
  createProductionDocumentationServices,
} from "../extensions/chatero-documentation/documentation-services.mjs";
import {
  canonicalOperationDigest,
  stateOperationId,
} from "../extensions/chatero-documentation/documentation-operations.mjs";
import { documentationPagePath } from "../extensions/chatero-documentation/documentation-path.mjs";
import { parseDocumentationState } from "../extensions/chatero-documentation/documentation-state.mjs";
import {
  settlementAffectedResourceDigest,
  settlementOperationDigest,
  settlementTextProofDigest,
} from "../extensions/chatero-documentation/settlement-protocol.mjs";
import { materializeFirstPartyExtensions } from "../scripts/lib/first-party-extensions.mjs";
import { writeInstallTreeManifest } from "../remote-agent/runtime/chatero-install-integrity.mjs";

const REPOSITORY_ROOT = new URL("../../../", import.meta.url);
const FIRST_PARTY_MANIFEST = new URL("../first-party-extensions.json", import.meta.url);

class FakeChild extends EventEmitter {
  constructor(responseFor) {
    super();
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    const chunks = [];
    this.stdin = new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
      final: callback => {
        try {
          const frame = Buffer.concat(chunks).toString("ascii").trimEnd();
          this.stdout.push(`${responseFor(frame)}\n`);
          this.stdout.push(null);
          this.stderr.push(null);
          setImmediate(() => this.emit("close", 0, null));
          callback();
        }
        catch (error) {
          callback(error);
          queueMicrotask(() => this.emit("error", error));
        }
      },
    });
  }

  kill() {}
}

function requestFrame(workspace = "file:///workspace-fixture") {
  return encodeAuthorityRequest({
    protocolVersion: 1,
    requestId: "request-1",
    kind: "snapshot",
    workspace,
    epoch: "epoch-1",
    snapshot: { kind: "paths", paths: [], overlays: [] },
  });
}

test("fixed authority invocation contains only the product helper and frame stdin", async () => {
  const invocation = makeFixedHelperInvocation({
    processPath: "/product/node",
    helperPath: "/product/extensions/chatero-documentation/runtime/chatero-documentation-authority.mjs",
    frame: requestFrame(),
    electron: false,
  });
  assert.deepEqual(invocation.args, [
    "/product/extensions/chatero-documentation/runtime/chatero-documentation-authority.mjs",
  ]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.stdin, `${requestFrame()}\n`);
  assert.equal(invocation.args.some(value => value.includes("workspace-fixture")), false);

  const spawnCalls = [];
  let verifications = 0;
  const transport = createFixedAuthorityTransport({
    extensionUri: pathToFileURL("/product/extensions/chatero-documentation"),
    processPath: "/product/node",
    electron: false,
    verifyTrustedRuntime: async () => {
      verifications++;
      if (verifications === 2) throw new Error("trusted runtime changed");
      return { kind: "verified", canonicalRoot: "/product/extensions/chatero-documentation" };
    },
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      return new FakeChild(frame => {
        const request = decodeAuthorityRequest(frame);
        return encodeAuthorityResponse({
          protocolVersion: 1,
          requestId: request.requestId,
          result: { kind: "snapshot", epoch: request.epoch, entries: [] },
        });
      });
    },
  });
  assert.equal(decodeAuthorityResponse(await transport.request(requestFrame())).result.kind, "snapshot");
  await assert.rejects(transport.request(requestFrame()), /trusted runtime changed/);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, invocation.args);
  assert.deepEqual(spawnCalls[0].options, invocation.options);
});

test("production local composition revalidates materialized provenance before every helper spawn", async t => {
  const fixture = await mkdtemp(join(tmpdir(), "chatero-documentation-composition-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const checkout = join(fixture, "checkout");
  const workspace = join(fixture, "workspace");
  await mkdir(join(checkout, "extensions"), { recursive: true });
  await mkdir(workspace);
  const fullManifest = JSON.parse(await readFile(FIRST_PARTY_MANIFEST, "utf8"));
  const documentation = fullManifest.extensions.find(value => value.id === "chatero.documentation");
  const manifestPath = join(fixture, "documentation-first-party.json");
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, extensions: [documentation] })}\n`);
  const materialized = await materializeFirstPartyExtensions({
    root: fileURLToPath(REPOSITORY_ROOT),
    checkout,
    manifestPath,
  });
  await writeFile(join(checkout, ".chatero-provenance.json"), `${JSON.stringify({
    firstPartyExtensions: materialized.extensions,
  })}\n`);
  const extensionRoot = join(checkout, "extensions", "chatero-documentation");
  const uri = {
    scheme: "file",
    authority: "",
    path: workspace,
    fsPath: workspace,
    query: "",
    fragment: "",
    toString() { return pathToFileURL(this.path).href; },
    with(changes) { return { ...this, ...changes, toString: this.toString, with: this.with }; },
  };
  let sequence = 0;
  const services = await createProductionDocumentationServices({
    vscode: { workspace: { workspaceFolders: [{ uri }], textDocuments: [], isTrusted: true } },
    context: {
      extensionUri: { scheme: "file", path: extensionRoot, fsPath: extensionRoot },
    },
    uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  const state = await services.transactions.state(services.scope);
  assert.equal(state.generation, "0000000000000000");
  const migration = await services.transactions.planMigration(services.scope);
  assert.equal(migration.kind, "planned");
  assert.equal(migration.plan.schemaVersion, 2);
  assert.equal(JSON.stringify(migration).includes(workspace), false);

  // A tamper that restores size and mtime is still caught: the cheap identity sweep that guards the
  // cached proof can only skip re-hashing when nothing about the tree changed.
  const helperPath = join(extensionRoot, "runtime", "protocol.mjs");
  const original = await readFile(helperPath);
  const before = await lstat(helperPath);
  const disguised = Buffer.from(original);
  disguised[0] ^= 0x01;
  await writeFile(helperPath, disguised);
  await utimes(helperPath, before.atime, before.mtime);
  await assert.rejects(
    services.transactions.state(services.scope),
    /differ from first-party provenance/,
  );

  await writeFile(helperPath, "tampered\n");
  await assert.rejects(
    services.transactions.state(services.scope),
    /differ from first-party provenance/,
  );
});

test("production SSH composition revalidates the complete signed install tree before every helper spawn", async t => {
  const fixture = await mkdtemp(join(tmpdir(), "chatero-documentation-remote-composition-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const installRoot = join(fixture, "chatero-agent-linux-x86_64");
  const workspace = join(fixture, "remote-workspace");
  await mkdir(join(installRoot, "extensions"), { recursive: true });
  await mkdir(join(installRoot, "bin"));
  await mkdir(workspace);
  const fullManifest = JSON.parse(await readFile(FIRST_PARTY_MANIFEST, "utf8"));
  const documentation = fullManifest.extensions.find(value => value.id === "chatero.documentation");
  const manifestPath = join(fixture, "documentation-remote-first-party.json");
  await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, extensions: [documentation] })}\n`);
  await materializeFirstPartyExtensions({
    root: fileURLToPath(REPOSITORY_ROOT),
    checkout: installRoot,
    manifestPath,
  });
  const nodePath = join(installRoot, "node");
  const verifierPath = join(installRoot, "bin", "chatero-install-integrity.mjs");
  await writeFile(nodePath, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  await copyFile(
    fileURLToPath(new URL("../remote-agent/runtime/chatero-install-integrity.mjs", import.meta.url)),
    verifierPath,
  );
  await chmod(verifierPath, 0o755);
  const unrelated = join(installRoot, "unrelated-runtime.txt");
  await writeFile(unrelated, "signed\n");
  const tree = await writeInstallTreeManifest({ root: installRoot });
  await chmod(installRoot, 0o700);
  const environment = {
    CHATERO_AGENT_INSTALL_ROOT: installRoot,
    CHATERO_AGENT_TREE_MANIFEST_SHA256: tree.treeManifestSha256,
    CHATERO_AGENT_NODE_SHA256: createHash("sha256").update(await readFile(nodePath)).digest("hex"),
    CHATERO_AGENT_INTEGRITY_VERIFIER_SHA256: createHash("sha256").update(await readFile(verifierPath)).digest("hex"),
  };
  const uri = {
    scheme: "vscode-remote",
    authority: "chatero-remote+lab",
    path: workspace,
    query: "",
    fragment: "",
    toString() { return `vscode-remote://${this.authority}${this.path}`; },
    with(changes) { return { ...this, ...changes, toString: this.toString, with: this.with }; },
  };
  let sequence = 0;
  const extensionRoot = join(installRoot, "extensions", "chatero-documentation");
  const services = await createProductionDocumentationServices({
    vscode: { workspace: { workspaceFolders: [{ uri }], textDocuments: [], isTrusted: true } },
    context: { extensionUri: { scheme: "file", path: extensionRoot, fsPath: extensionRoot } },
    environment,
    uuid: () => `10000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  assert.equal((await services.transactions.state(services.scope)).generation, "0000000000000000");
  const migration = await services.transactions.planMigration(services.scope);
  assert.equal(migration.kind, "planned");
  assert.equal(migration.plan.schemaVersion, 2);
  assert.equal(JSON.stringify(migration).includes(workspace), false);

  await writeFile(unrelated, "tampered\n");
  await assert.rejects(
    services.transactions.state(services.scope),
    /installed-tree verification failed/,
  );
});

async function invokeHelper(request) {
  const output = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); },
  });
  await runDocumentationAuthority({
    stdin: Readable.from([`${encodeAuthorityRequest(request)}\n`]),
    stdout,
    clock: { now: () => 1_000 },
  });
  const lines = Buffer.concat(output).toString("ascii").trimEnd().split("\n");
  assert.equal(lines.length, 1);
  return decodeAuthorityResponse(lines[0]);
}

test("one fixed helper snapshots identical local and SSH workspace bytes", async t => {
  const root = await mkdtemp(join(tmpdir(), "chatero-documentation-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "documentation"), { recursive: true });
  await writeFile(join(root, "documentation", "index.qmd"), "# Exact\n");

  const snapshot = async workspace => (await invokeHelper({
    protocolVersion: 1,
    requestId: `snapshot-${workspace.startsWith("file:") ? "local" : "remote"}`,
    kind: "snapshot",
    workspace,
    epoch: "epoch-1",
    snapshot: {
      kind: "paths",
      paths: ["documentation/index.qmd", "documentation/missing.qmd"],
      overlays: [],
    },
  })).result;
  const local = await snapshot(pathToFileURL(root).href);
  const remote = await snapshot(`vscode-remote://chatero-remote+lab${pathToFileURL(root).pathname}`);
  assert.deepEqual(remote, local);
  assert.equal(Buffer.from(local.entries[0].bytes, "base64url").toString("utf8"), "# Exact\n");
  assert.equal(local.entries[1].type, "absent");
});

test("one transaction frame durably commits and idempotently replays workflow state", async t => {
  const root = await mkdtemp(join(tmpdir(), "chatero-documentation-state-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "documentation"), { recursive: true });
  await mkdir(join(root, ".chatero"), { mode: 0o755 });
  const pageBytes = Buffer.from("# Reviewed\n");
  await writeFile(join(root, "documentation", "index.qmd"), pageBytes);
  await writeFile(
    join(root, ".chatero", "documentation-state.v1.json"),
    '{"schemaVersion":1,"generation":"0000000000000001","documents":{"index.qmd":{"state":"working"}}}\n',
  );
  const input = Object.freeze({
    path: documentationPagePath("index.qmd"),
    expectedDocumentRevision: `sha256:${createHash("sha256").update(pageBytes).digest("hex")}`,
    expectedStateGeneration: "0000000000000001",
    state: "reviewed",
    idempotencyKey: "helper-reviewed-1",
  });
  const transaction = Object.freeze({
    kind: "set-document-state",
    schemaVersion: 1,
    operationId: stateOperationId(input.idempotencyKey),
    idempotencyKey: input.idempotencyKey,
    requestDigest: canonicalOperationDigest(input),
    workspaceEpoch: "epoch-1",
    workspaceScopeDigest: "e".repeat(64),
    path: input.path.value,
    expectedDocumentRevision: input.expectedDocumentRevision,
    expectedStateGeneration: input.expectedStateGeneration,
    intendedState: input.state,
    workingCopy: null,
  });
  const request = requestId => ({
    protocolVersion: 1,
    requestId,
    kind: "transact",
    workspace: pathToFileURL(root).href,
    epoch: "epoch-1",
    transaction,
  });

  const committed = (await invokeHelper(request("state-1"))).result;
  assert.deepEqual(committed, {
    kind: "state-committed",
    generation: "0000000000000002",
    receipt: input.idempotencyKey,
  });
  assert.deepEqual((await invokeHelper(request("state-2"))).result, committed);
  const state = parseDocumentationState(await readFile(join(root, ".chatero", "documentation-state.v1.json")));
  assert.equal(state.kind, "valid");
  assert.equal(state.state.documents["index.qmd"].state, "reviewed");
  const journal = JSON.parse(await readFile(
    join(root, ".chatero", "documentation-operations", `${transaction.operationId}.json`),
    "utf8",
  ));
  assert.equal(journal.phase, "committed");
});

test("settlement prepare is durable before text ack and never writes QMD bytes", async t => {
  const root = await mkdtemp(join(tmpdir(), "chatero-documentation-settlement-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "documentation"), { recursive: true });
  await mkdir(join(root, ".chatero"), { mode: 0o755 });
  const before = "human preface\none\ntwo\n";
  const intended = "human preface\none\nTWO\n";
  await writeFile(join(root, "documentation", "topic.qmd"), before);
  await writeFile(
    join(root, ".chatero", "documentation-state.v1.json"),
    '{"schemaVersion":1,"generation":"0000000000000002","documents":{"topic.qmd":{"state":"reviewed"}}}\n',
  );
  const beforeDigest = `sha256:${createHash("sha256").update(before).digest("hex")}`;
  const intendedDigest = `sha256:${createHash("sha256").update(intended).digest("hex")}`;
  const operationId = "settle-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const prepare = {
    kind: "prepare-settlement",
    schemaVersion: 1,
    operationId,
    idempotencyKey: "settlement-helper-a",
    operationDigest: "pending",
    affectedResourceDigest: "pending",
    approvalReservationDigest: `sha256:${"e".repeat(64)}`,
    reviewDigest: `sha256:${"c".repeat(64)}`,
    generationDigest: `sha256:${"d".repeat(64)}`,
    expectedStateGeneration: "0000000000000002",
    decisions: [{ id: "hunk-a", decision: "accept" }],
    textOverlay: [{
      operationId: "edit-topic",
      path: "topic.qmd",
      expectedVersion: 7,
      currentRevision: `text-document:7:${beforeDigest}`,
      beforeDigest,
      intendedText: intended,
      intendedDigest,
    }],
    resourceOperations: [],
    stateChanges: [{ kind: "set", path: "topic.qmd", state: "working" }],
    deferredOperations: [],
  };
  prepare.affectedResourceDigest = settlementAffectedResourceDigest(prepare);
  prepare.operationDigest = settlementOperationDigest(prepare);
  const { operationDigest, affectedResourceDigest } = prepare;
  const transact = async (requestId, transaction) => (await invokeHelper({
    protocolVersion: 1,
    requestId,
    kind: "transact",
    workspace: pathToFileURL(root).href,
    epoch: "epoch-1",
    transaction,
  })).result;

  const prepared = await transact("settlement-prepare-1", prepare);
  assert.equal(prepared.kind, "awaiting-text");
  assert.equal(prepared.operationDigest, operationDigest);
  assert.match(prepared.approvalAcceptanceProof, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(await readFile(join(root, "documentation", "topic.qmd"), "utf8"), before);
  const marker = JSON.parse(await readFile(
    join(root, ".chatero", "documentation-operation-active.v1.json"),
    "utf8",
  ));
  assert.equal(marker.operationId, operationId);
  assert.equal(marker.operationDigest, operationDigest);
  const journalPath = join(root, ".chatero", "documentation-operations", `${operationId}.json`);
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).phase, "awaiting-text");
  assert.deepEqual(await transact("settlement-prepare-2", prepare), prepared);
  const inspected = (await invokeHelper({
    protocolVersion: 1,
    requestId: "settlement-inspect-1",
    kind: "recover",
    workspace: pathToFileURL(root).href,
    epoch: "epoch-1",
    recovery: { kind: "inspect-settlement", schemaVersion: 1 },
  })).result;
  assert.deepEqual(inspected, prepared);
  const markerPath = join(root, ".chatero", "documentation-operation-active.v1.json");
  const markerBytes = await readFile(markerPath);
  await rm(markerPath);
  const missingMarker = (await invokeHelper({
    protocolVersion: 1,
    requestId: "settlement-inspect-missing-marker",
    kind: "recover",
    workspace: pathToFileURL(root).href,
    epoch: "epoch-1",
    recovery: { kind: "inspect-settlement", schemaVersion: 1 },
  })).result;
  assert.equal(missingMarker.kind, "documentation-tamper");
  await writeFile(markerPath, markerBytes, { mode: 0o600 });

  const textProof = {
    kind: "settlement-text-proof",
    operationId,
    operationDigest,
    resources: [{
      uri: `${pathToFileURL(root).href.replace(/\/$/u, "")}/documentation/topic.qmd`,
      beforeVersion: 7,
      afterVersion: 8,
      beforeDigest,
      intendedDigest,
    }],
  };
  textProof.proofDigest = settlementTextProofDigest(textProof);
  const committed = await transact("settlement-ack-1", {
    kind: "ack-settlement-text",
    schemaVersion: 1,
    operationId,
    operationDigest,
    affectedResourceDigest,
    textProof,
  });
  assert.deepEqual(committed, {
    kind: "settlement-committed",
    operationId,
    receipt: "settlement-helper-a",
  });
  assert.equal(await readFile(join(root, "documentation", "topic.qmd"), "utf8"), before);
  await assert.rejects(
    readFile(join(root, ".chatero", "documentation-operation-active.v1.json")),
    error => error?.code === "ENOENT",
  );
  const state = parseDocumentationState(await readFile(join(root, ".chatero", "documentation-state.v1.json")));
  assert.equal(state.kind, "valid");
  assert.equal(state.state.documents["topic.qmd"].state, "working");
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).phase, "committed");
});

test("helper never follows a Documentation symlink", async t => {
  const root = await mkdtemp(join(tmpdir(), "chatero-documentation-unsafe-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "documentation"));
  const outside = join(root, "outside-secret");
  await writeFile(outside, "must not be read\n");
  await symlink(outside, join(root, "documentation", "linked.qmd"));
  const response = await invokeHelper({
    protocolVersion: 1,
    requestId: "symlink-1",
    kind: "snapshot",
    workspace: pathToFileURL(root).href,
    epoch: "epoch-1",
    snapshot: { kind: "paths", paths: ["documentation/linked.qmd"], overlays: [] },
  });
  assert.deepEqual(response.result.entries, [{
    path: "documentation/linked.qmd",
    type: "symlink",
    target: outside,
  }]);
  assert.doesNotMatch(JSON.stringify(response), /must not be read/);
});

test("helper rejects Documentation case aliases", async t => {
  const root = await mkdtemp(join(tmpdir(), "chatero-documentation-alias-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "documentation"));
  await writeFile(join(root, "documentation", "Index.qmd"), "upper\n");
  const aliasText = "lower\n";
  await assert.rejects(invokeHelper({
    protocolVersion: 1,
    requestId: "alias-1",
    kind: "snapshot",
    workspace: pathToFileURL(root).href,
    epoch: "epoch-1",
    snapshot: {
      kind: "documentation-state",
      overlays: [{
        uri: pathToFileURL(join(root, "documentation", "index.qmd")).href,
        version: 1,
        dirty: true,
        text: aliasText,
        revision: `text-document:1:sha256:${createHash("sha256").update(aliasText).digest("hex")}`,
      }],
    },
  }), /case-fold alias/);
});

test("helper rejects trailing frames and never emits a second response", async () => {
  const frame = requestFrame("file:///tmp/workspace");
  const output = [];
  await assert.rejects(runDocumentationAuthority({
    stdin: Readable.from([`${frame}\n${frame}\n`]),
    stdout: new Writable({
      write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); },
    }),
    clock: { now: () => 1_000 },
  }), /exactly one|trailing/i);
  assert.equal(output.length, 0);
});
