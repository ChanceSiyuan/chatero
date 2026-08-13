import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { createCoreTransactionRegistry } from "../../../chrome/content/zotero/xpcom/chateroCoreTransactionRegistry.mjs";

function transaction(overrides = {}) {
  return {
    expectedRevision: 0,
    idempotencyKey: "transaction-key-0001",
    operation: { kind: "set-title", title: "First" },
    scope: "library:1/item:ITEM0001",
    ...overrides,
  };
}

test("one idempotency key executes once and replays the immutable result", async () => {
  const registry = createCoreTransactionRegistry({ capacity: 4 });
  let calls = 0;
  const input = transaction();
  const first = registry.execute(input, async () => {
    calls += 1;
    await Promise.resolve();
    return { itemKey: "ITEM0001", title: "First" };
  });
  const concurrent = registry.execute(input, async () => {
    calls += 1;
    return { forged: true };
  });

  assert.deepEqual(await first, {
    replayed: false,
    result: { itemKey: "ITEM0001", title: "First" },
    revision: 1,
  });
  assert.deepEqual(await concurrent, {
    replayed: true,
    result: { itemKey: "ITEM0001", title: "First" },
    revision: 1,
  });
  assert.equal(calls, 1);
  input.operation.title = "mutated afterwards";
  assert.deepEqual(registry.getRevision("library:1/item:ITEM0001"), 1);
});

test("idempotency reuse, stale revisions, and failed operations never mutate truth", async () => {
  const registry = createCoreTransactionRegistry();
  await registry.execute(transaction(), async () => ({ ok: true }));

  await assert.rejects(
    registry.execute(transaction({ operation: { kind: "set-title", title: "Different" } }), async () => ({})),
    error => error.code === "IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    registry.execute(transaction({ idempotencyKey: "transaction-key-0002", expectedRevision: 0 }), async () => ({})),
    error => error.code === "REVISION_CONFLICT" && error.actualRevision === 1,
  );

  await assert.rejects(
    registry.execute(transaction({ idempotencyKey: "transaction-key-0003", expectedRevision: 0, scope: "library:1/item:ITEM0002" }), async () => {
      throw new Error("adapter failed");
    }),
    /adapter failed/,
  );
  assert.equal(registry.getRevision("library:1/item:ITEM0002"), 0);
  assert.deepEqual(await registry.execute(
    transaction({ idempotencyKey: "transaction-key-0003", expectedRevision: 0, scope: "library:1/item:ITEM0002" }),
    async () => ({ recovered: true }),
  ), {
    replayed: false,
    result: { recovered: true },
    revision: 1,
  });
});

test("transaction registry rejects ambiguous values and bounds retained receipts", async () => {
  const registry = createCoreTransactionRegistry({ capacity: 2 });

  await assert.rejects(registry.execute(transaction({ idempotencyKey: "short" }), async () => ({})), /idempotencyKey/);
  await assert.rejects(registry.execute(transaction({ scope: "../escape" }), async () => ({})), /scope/);
  await assert.rejects(registry.execute(transaction({ operation: { invalid: undefined } }), async () => ({})), /JSON/);

  for (let index = 1; index <= 3; index++) {
    await registry.execute(transaction({
      expectedRevision: 0,
      idempotencyKey: `transaction-key-retained-${index}`,
      scope: `library:1/item:ITEM000${index}`,
    }), async () => ({ index }));
  }
  assert.equal(registry.receiptCount, 2);
});

test("different idempotency keys cannot commit concurrently at one scope revision", async () => {
  const registry = createCoreTransactionRegistry();
  let releaseFirst;
  const firstCanFinish = new Promise(resolve => { releaseFirst = resolve; });
  let firstStarted;
  const firstDidStart = new Promise(resolve => { firstStarted = resolve; });
  const first = registry.execute(transaction(), async () => {
    firstStarted();
    await firstCanFinish;
    return { winner: "first" };
  });
  await firstDidStart;
  let secondRan = false;
  const second = registry.execute(transaction({ idempotencyKey: "transaction-key-0002" }), async () => {
    secondRan = true;
    return { winner: "second" };
  });
  releaseFirst();

  assert.equal((await first).revision, 1);
  await assert.rejects(second, error => error.code === "REVISION_CONFLICT" && error.actualRevision === 1);
  assert.equal(secondRan, false);
  assert.equal(registry.getRevision("library:1/item:ITEM0001"), 1);
});

function persistentStore() {
  const records = new Map();
  const revisions = new Map();
  return {
    async load() {
      return {
        receipts: [...records.values()].map(value => structuredClone(value)),
        revisions: [...revisions].map(value => [...value]),
      };
    },
    async reserve(record) {
      records.set(record.idempotencyKey, structuredClone(record));
    },
    async commit({ evictedKeys, receipt, scopeRevision }) {
      records.set(receipt.idempotencyKey, structuredClone(receipt));
      revisions.set(scopeRevision.scope, scopeRevision.revision);
      for (const key of evictedKeys) records.delete(key);
    },
    async release(idempotencyKey) {
      records.delete(idempotencyKey);
    },
  };
}

test("completed receipts and scope revisions survive a Core registry restart", async () => {
  const store = persistentStore();
  const firstRegistry = createCoreTransactionRegistry({ capacity: 4, store });
  let calls = 0;
  assert.deepEqual(await firstRegistry.execute(transaction(), async () => {
    calls += 1;
    return { itemKey: "ITEM0001", title: "First" };
  }), {
    replayed: false,
    result: { itemKey: "ITEM0001", title: "First" },
    revision: 1,
  });

  const restartedRegistry = createCoreTransactionRegistry({ capacity: 4, store });
  assert.deepEqual(await restartedRegistry.execute(transaction(), async () => {
    calls += 1;
    return { forged: true };
  }), {
    replayed: true,
    result: { itemKey: "ITEM0001", title: "First" },
    revision: 1,
  });
  assert.equal(calls, 1);
  assert.equal(restartedRegistry.getRevision("library:1/item:ITEM0001"), 1);
});

test("a crash-ambiguous durable reservation fails closed instead of executing twice", async () => {
  const store = persistentStore();
  await store.reserve({
    expectedRevision: 0,
    idempotencyKey: "transaction-key-0001",
    operationDigest: createHash("sha256").update(JSON.stringify(transaction().operation)).digest("hex"),
    scope: "library:1/item:ITEM0001",
    state: "pending",
  });
  const registry = createCoreTransactionRegistry({ store });
  let calls = 0;
  await assert.rejects(
    registry.execute(transaction(), async () => { calls += 1; }),
    error => error.code === "TRANSACTION_RECOVERY_REQUIRED",
  );
  assert.equal(calls, 0);
});
