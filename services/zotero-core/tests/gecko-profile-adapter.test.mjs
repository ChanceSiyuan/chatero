import assert from "node:assert/strict";
import { test } from "node:test";

import { createZoteroProfileAdapter } from "../../../chrome/content/zotero/xpcom/chateroCoreProfileAdapter.mjs";

test("profile adapter reports real Zotero schema state without exposing paths", async () => {
  const calls = [];
  const adapter = createZoteroProfileAdapter({
    Zotero: {
      DB: { async quickCheck() { calls.push("quickCheck"); return true; } },
      Schema: {
        async getDBVersion(name) { calls.push(["version", name]); return name === "userdata" ? 142 : 10; },
        async integrityCheckRequired() { calls.push("integrity"); return false; },
      },
      version: "8.0-test",
    },
    profileEpoch: "epoch-1",
    profileName: "Disposable Profile",
  });

  assert.deepEqual(await adapter.status({}), {
    compatibilityVersion: 10,
    integrityCheckRequired: false,
    profileEpoch: "epoch-1",
    profileName: "Disposable Profile",
    quickCheckPassed: true,
    readOnly: false,
    schemaVersion: 142,
    upstreamVersion: "8.0-test",
  });
  assert.deepEqual(calls, [["version", "userdata"], ["version", "compatibility"], "integrity", "quickCheck"]);
});

test("profile backup delegates only to Zotero DB and returns content-free evidence", async () => {
  const calls = [];
  const adapter = createZoteroProfileAdapter({
    Zotero: {
      DB: {
        async backUpDatabase(options) { calls.push(options); return true; },
      },
      Schema: {},
      version: "8.0-test",
    },
    now: () => 1234,
    profileEpoch: "epoch-1",
    profileName: "Disposable Profile",
  });

  assert.deepEqual(await adapter.backup(), { backupCreated: true, completedAt: 1234 });
  assert.deepEqual(calls, [{ force: true, online: true, suffix: "chatero-core" }]);
});
