import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

const temporaryDirectories = [];
const running = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map(value => value.stop().catch(() => {})));
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    force: true,
    recursive: true,
  })));
});

async function createProfile() {
  const root = await mkdtemp(join(tmpdir(), "chatero-core-supervisor-"));
  temporaryDirectories.push(root);
  const profileDirectory = join(root, "profile");
  await mkdir(profileDirectory, { mode: 0o700 });
  return { profileDirectory, root };
}

const fixtureItems = [
  {
    attachmentCount: 1,
    creators: ["Michael Fisher"],
    itemKey: "FISHER01",
    itemType: "journalArticle",
    libraryId: 1,
    title: "Renormalization group theory",
    year: 1974,
  },
  {
    attachmentCount: 2,
    creators: ["Steven White"],
    itemKey: "WHITE92",
    itemType: "journalArticle",
    libraryId: 1,
    title: "Density matrix formulation",
    year: 1992,
  },
];
const fixtureCollections = [
  { childCount: 1, collectionKey: "PHYSICS", itemCount: 2, libraryId: 1, name: "Physics" },
  { childCount: 0, collectionKey: "RG", itemCount: 1, libraryId: 1, name: "Renormalization", parentKey: "PHYSICS" },
];
const fixtureItemChildren = [{
  attachments: [{
    annotationCount: 1,
    attachmentKey: "PDF00001",
    contentType: "application/pdf",
    filename: "paper.pdf",
    libraryId: 1,
    parentItemKey: "FISHER01",
    path: "/tmp/paper.pdf",
    title: "Paper PDF",
  }],
  itemKey: "FISHER01",
  libraryId: 1,
  notes: [{ libraryId: 1, noteKey: "NOTE0001", parentItemKey: "FISHER01", title: "Reading note" }],
}];
const fixtureNotes = [{
  html: "<p>Reading note</p>",
  libraryId: 1,
  noteKey: "NOTE0001",
  parentItemKey: "FISHER01",
  title: "Reading note",
}];
const fixtureAnnotations = [{
  annotations: [{
    annotationKey: "ANN00001",
    color: "#ffd400",
    comment: "Evidence",
    libraryId: 1,
    pageLabel: "3",
    positionJson: '{"pageIndex":2,"rects":[[1,2,3,4]]}',
    sortIndex: "00002|000001|00000",
    text: "Critical statement",
    type: "highlight",
  }],
  attachmentKey: "PDF00001",
  libraryId: 1,
}];

test("builds an explicit headless Gecko launch without putting secrets in argv or environment", async () => {
  const { buildCoreLaunchPlan } = await import("../supervisor/core-supervisor.mjs");
  const plan = buildCoreLaunchPlan({
    geckoExecutable: "/Applications/Chatero Core.app/Contents/MacOS/zotero",
    profileDirectory: "/tmp/chatero profile",
  });

  assert.equal(plan.executable, "/Applications/Chatero Core.app/Contents/MacOS/zotero");
  assert.deepEqual(plan.args, ["-no-remote", "-profile", "/tmp/chatero profile", "-headless", "-ChateroCore"]);
  assert.equal(JSON.stringify(plan).includes("bootstrap"), false);
  assert.equal(JSON.stringify(plan).includes("socket"), false);
  assert.throws(() => buildCoreLaunchPlan({ geckoExecutable: "relative/zotero", profileDirectory: "/tmp/profile" }), /absolute/);
});

test("supervises an explicit Core executable through the same authenticated client", async () => {
  const { startCore } = await import("../supervisor/core-supervisor.mjs");
  const { profileDirectory, root } = await createProfile();
  const executable = join(root, "fake-gecko-core");
  const fixtureCore = resolve(import.meta.dirname, "..", "fixture", "fixture-core.mjs");
  await writeFile(executable, `#!/bin/sh\nif [ ! -f /dev/fd/3 ]; then\n  echo "bootstrap fd must be a regular inherited file" >&2\n  exit 99\nfi\nexec "${process.execPath}" "${fixtureCore}" "$@"\n`);
  await chmod(executable, 0o700);

  const core = await startCore({ geckoExecutable: executable, profileDirectory, fixtureCollections, fixtureItems });
  running.push(core);
  assert.equal(core.mode, "gecko");
  assert.equal(core.child.spawnargs.includes("-ChateroCore"), true);
  assert.equal((await core.client.request("library.search", { limit: 10, query: "density" })).total, 1);
});

test("supervises an authenticated fixture Core over an owner-only Unix socket", async () => {
  const { startCore } = await import("../supervisor/core-supervisor.mjs");
  const { profileDirectory } = await createProfile();
  const core = await startCore({
    profileDirectory,
    fixtureAnnotations,
    fixtureCollections,
    fixtureItemChildren,
    fixtureItems,
    fixtureNotes,
  });
  running.push(core);

  assert.equal(core.transport, "unix");
  assert.equal(core.bootstrapTransport, "inherited-fd");
  assert.equal(core.child.spawnargs.some(value => value.includes("bootstrap")), false);
  assert.equal((await stat(core.sessionDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(core.socketPath)).mode & 0o777, 0o600);

  assert.deepEqual(await core.client.request("profile.status", {}), {
    profileEpoch: core.profileEpoch,
    profileName: "profile",
    readOnly: true,
    schemaVersion: 1,
    upstreamVersion: "7.0-fixture",
  });
  assert.deepEqual(await core.client.request("library.search", {
    query: "white",
    limit: 20,
  }), {
    items: [fixtureItems[1]],
    total: 1,
  });
  assert.deepEqual(await core.client.request("library.collections", {}), {
    collections: [fixtureCollections[0]],
  });
  assert.deepEqual(await core.client.request("library.collections", { libraryId: 1, parentKey: "PHYSICS" }), {
    collections: [fixtureCollections[1]],
  });
  assert.deepEqual(await core.client.request("library.item-children", { libraryId: 1, itemKey: "FISHER01" }), {
    attachments: fixtureItemChildren[0].attachments,
    notes: fixtureItemChildren[0].notes,
  });
  assert.deepEqual(await core.client.request("library.attachment", { attachmentKey: "PDF00001", libraryId: 1 }), fixtureItemChildren[0].attachments[0]);
  assert.deepEqual(await core.client.request("library.note", { libraryId: 1, noteKey: "NOTE0001" }), fixtureNotes[0]);
  assert.deepEqual(await core.client.request("library.annotations", { attachmentKey: "PDF00001", libraryId: 1 }), {
    annotations: fixtureAnnotations[0].annotations,
  });
});

test("keeps one profile owner and removes only disposable state on stop", async () => {
  const { startCore } = await import("../supervisor/core-supervisor.mjs");
  const { profileDirectory } = await createProfile();
  const first = await startCore({ profileDirectory, fixtureItems });
  running.push(first);

  await assert.rejects(startCore({ profileDirectory, fixtureItems }), /live Chatero Core owner/);
  const sessionDirectory = first.sessionDirectory;
  await first.stop();
  running.splice(running.indexOf(first), 1);

  await assert.rejects(lstat(sessionDirectory), /ENOENT/);
  await assert.rejects(lstat(join(profileDirectory, ".chatero-core.lock")), /ENOENT/);
  assert.deepEqual(await readFile(join(profileDirectory, "prefs.js"), "utf8").catch(error => error.code), "ENOENT");
});

test("enforces the capabilities granted during handshake", async () => {
  const { startCore } = await import("../supervisor/core-supervisor.mjs");
  const { profileDirectory } = await createProfile();
  const core = await startCore({
    profileDirectory,
    fixtureItems,
    requestedCapabilities: ["profile:read"],
  });
  running.push(core);

  await assert.rejects(
    core.client.request("library.search", { query: "", limit: 10 }),
    error => error.code === "FORBIDDEN" && /library:search/.test(error.message)
  );
  assert.equal((await core.client.request("profile.status", {})).profileEpoch, core.profileEpoch);
});

test("returns bounded structured validation errors without stopping Core", async () => {
  const { startCore } = await import("../supervisor/core-supervisor.mjs");
  const { profileDirectory } = await createProfile();
  const core = await startCore({ profileDirectory, fixtureItems });
  running.push(core);

  await assert.rejects(
    core.client.request("library.search", { query: "x", limit: 1000 }),
    error => error.code === "INVALID_PARAMS" && /limit/.test(error.message)
  );
  assert.equal((await core.client.request("profile.status", {})).readOnly, true);
});

test("cancels in-flight work and keeps the authenticated session usable", async () => {
  const { startCore } = await import("../supervisor/core-supervisor.mjs");
  const { profileDirectory } = await createProfile();
  const core = await startCore({ profileDirectory, fixtureItems, fixtureSearchDelayMs: 250 });
  running.push(core);
  const controller = new AbortController();
  const pending = core.client.request("library.search", { query: "", limit: 10 }, {
    signal: controller.signal,
    timeoutMs: 1000,
  });
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(pending, error => error.code === "CANCELLED");
  assert.equal((await core.client.request("profile.status", {})).readOnly, true);
});

test("delivers monotonic Core events independently of request responses", async () => {
  const { startCore } = await import("../supervisor/core-supervisor.mjs");
  const { profileDirectory } = await createProfile();
  const core = await startCore({ profileDirectory, fixtureItems });
  running.push(core);
  const event = new Promise(resolvePromise => {
    const dispose = core.client.onEvent(value => {
      dispose();
      resolvePromise(value);
    });
  });

  await core.client.request("library.search", { query: "white", limit: 10 });

  assert.deepEqual(await event, {
    event: true,
    payload: { count: 1, query: "white" },
    profileEpoch: core.profileEpoch,
    sequence: 1,
    topic: "library.search.completed",
  });
});

test("cleans the profile lease and session after an unexpected Core crash", async () => {
  const { startCore } = await import("../supervisor/core-supervisor.mjs");
  const { profileDirectory } = await createProfile();
  const core = await startCore({ profileDirectory, fixtureItems });
  const sessionDirectory = core.sessionDirectory;
  core.child.kill("SIGKILL");

  const exit = await core.whenStopped;

  assert.equal(exit.expected, false);
  await assert.rejects(lstat(sessionDirectory), /ENOENT/);
  await assert.rejects(lstat(join(profileDirectory, ".chatero-core.lock")), /ENOENT/);
});

test("a launch failure leaves no profile lease behind", async () => {
  const { startCore } = await import("../supervisor/core-supervisor.mjs");
  const { profileDirectory } = await createProfile();

  await assert.rejects(startCore({
    profileDirectory,
    fixtureCorePath: join(profileDirectory, "missing-core.mjs"),
    readyTimeoutMs: 1000,
  }), /exited before readiness|could not be started/);

  await assert.rejects(lstat(join(profileDirectory, ".chatero-core.lock")), /ENOENT/);
});
