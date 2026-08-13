import assert from "node:assert/strict";
import { test } from "node:test";

import { createZoteroCoreTransactionStore } from "../../../chrome/content/zotero/xpcom/chateroCoreTransactionRegistry.mjs";

function fakeZotero() {
  const rows = new Map();
  let transactions = 0;
  const key = (setting, entryKey) => `${setting}\0${entryKey}`;
  return {
    DB: {
      async executeTransaction(callback) {
        transactions += 1;
        const before = structuredClone(rows);
        try { return await callback(); }
        catch (error) {
          rows.clear();
          for (const entry of before) rows.set(...entry);
          throw error;
        }
      },
      async queryAsync(sql, params) {
        if (sql.startsWith("SELECT")) return [...rows.values()].map(value => ({ ...value }));
        if (sql.startsWith("INSERT")) {
          const [setting, entryKey, value] = params;
          if (rows.has(key(setting, entryKey))) throw new Error("unique constraint");
          rows.set(key(setting, entryKey), { key: entryKey, setting, value });
          return 1;
        }
        if (sql.startsWith("UPDATE")) {
          const [value, setting, entryKey] = params;
          const existing = rows.get(key(setting, entryKey));
          if (!existing) return 0;
          rows.set(key(setting, entryKey), { ...existing, value });
          return 1;
        }
        if (sql.startsWith("REPLACE")) {
          const [setting, entryKey, value] = params;
          rows.set(key(setting, entryKey), { key: entryKey, setting, value });
          return 1;
        }
        if (sql.startsWith("DELETE")) {
          const [setting, entryKey] = params;
          return rows.delete(key(setting, entryKey)) ? 1 : 0;
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
			async valueQueryAsync(sql, params) {
				if (!sql.startsWith("SELECT value")) throw new Error(`unexpected value SQL: ${sql}`);
				return rows.get(key(params[0], params[1]))?.value ?? false;
			},
    },
    get transactions() { return transactions; },
    rows,
  };
}

test("Zotero transaction store durably reserves, commits, loads, and releases receipts", async () => {
  const Zotero = fakeZotero();
  const store = createZoteroCoreTransactionStore({ Zotero });
  const pending = {
    expectedRevision: 0,
    idempotencyKey: "transaction-key-0001",
    operationDigest: "a".repeat(64),
    scope: "library:1/item:ITEM0001",
    state: "pending",
  };
  await store.reserve(pending);
  assert.deepEqual(await store.load(), { receipts: [pending], revisions: [] });

  const receipt = { ...pending, result: { ok: true }, revision: 1, state: "completed" };
  await store.commit({ evictedKeys: [], receipt, scopeRevision: { revision: 1, scope: pending.scope } });
  assert.deepEqual(await store.load(), { receipts: [receipt], revisions: [[pending.scope, 1]] });
  await store.release(pending.idempotencyKey);
  assert.deepEqual(await store.load(), { receipts: [], revisions: [[pending.scope, 1]] });
  assert.equal(Zotero.transactions, 3);
});

test("Zotero transaction store rejects commit without its durable reservation", async () => {
  const Zotero = fakeZotero();
  const store = createZoteroCoreTransactionStore({ Zotero });
  await assert.rejects(store.commit({
    evictedKeys: [],
    receipt: {
      expectedRevision: 0,
      idempotencyKey: "transaction-key-0001",
      operationDigest: "a".repeat(64),
      result: { ok: true },
      revision: 1,
      scope: "library:1/item:ITEM0001",
      state: "completed",
    },
    scopeRevision: { revision: 1, scope: "library:1/item:ITEM0001" },
  }), /reservation disappeared/);
  assert.equal(Zotero.rows.size, 0);
});
