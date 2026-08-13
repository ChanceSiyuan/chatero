import assert from "node:assert/strict";
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
