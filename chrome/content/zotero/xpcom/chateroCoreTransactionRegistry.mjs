/*
    ***** BEGIN LICENSE BLOCK *****

    Copyright © 2026 Chance Siyuan / Chatero contributors

    This file is part of Chatero (a Zotero fork).

    Chatero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    ***** END LICENSE BLOCK *****
*/

const DEFAULT_CAPACITY = 4096;
const MAX_OPERATION_BYTES = 896 * 1024;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const SCOPE_PATTERN = /^[a-z][a-z0-9-]*(?::[A-Za-z0-9._-]+)(?:\/[a-z][a-z0-9-]*:[A-Za-z0-9._-]+)*$/;
const RECEIPT_SETTING = "chateroCoreTransactionReceiptV1";
const REVISION_SETTING = "chateroCoreTransactionRevisionV1";

function exactObject(value, fields, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	for (let field of Object.keys(value)) {
		if (!fields.has(field)) throw new Error(`${label} has unknown field ${field}`);
	}
}

function canonicalJSON(value, label) {
	let active = new Set();
	let normalize = candidate => {
		if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
		if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
		if (!candidate || typeof candidate !== "object") throw new Error(`${label} must contain only JSON values`);
		if (active.has(candidate)) throw new Error(`${label} must not be cyclic`);
		active.add(candidate);
		let result;
		if (Array.isArray(candidate)) result = candidate.map(normalize);
		else result = Object.fromEntries(Object.keys(candidate).sort().map(key => [key, normalize(candidate[key])]));
		active.delete(candidate);
		return result;
	};
	let normalized;
	try { normalized = normalize(value); }
	catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
	let encoded = JSON.stringify(normalized);
	if (new TextEncoder().encode(encoded).length > MAX_OPERATION_BYTES) throw new Error(`${label} exceeds its size limit`);
	return { encoded, normalized };
}

function freeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (let child of Object.values(value)) freeze(child);
	return Object.freeze(value);
}

function conflict(code, message, fields = {}) {
	let error = new Error(message);
	error.code = code;
	Object.assign(error, fields);
	return error;
}

async function sha256(value) {
	let digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function validateStore(store) {
	if (store === undefined) return;
	if (!store || typeof store !== "object"
			|| typeof store.load !== "function"
			|| typeof store.reserve !== "function"
			|| typeof store.commit !== "function"
			|| typeof store.release !== "function") {
		throw new Error("Core transaction store is invalid");
	}
}

function validateStoredReceipt(value) {
	exactObject(value, new Set([
		"expectedRevision", "idempotencyKey", "operationDigest", "result", "revision", "scope", "state",
	]), "stored Core transaction receipt");
	if (value.state !== "pending" && value.state !== "completed") throw new Error("stored Core transaction receipt state is invalid");
	if (typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_PATTERN.test(value.idempotencyKey)) throw new Error("stored Core transaction idempotencyKey is invalid");
	if (typeof value.scope !== "string" || !SCOPE_PATTERN.test(value.scope) || value.scope.length > 256) throw new Error("stored Core transaction scope is invalid");
	if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) throw new Error("stored Core transaction expectedRevision is invalid");
	if (typeof value.operationDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.operationDigest)) throw new Error("stored Core transaction operationDigest is invalid");
	if (value.state === "pending") {
		if (value.result !== undefined || value.revision !== undefined) throw new Error("pending Core transaction receipt contains a result");
		return freeze({
			expectedRevision: value.expectedRevision,
			idempotencyKey: value.idempotencyKey,
			operationDigest: value.operationDigest,
			scope: value.scope,
			state: value.state,
		});
	}
	if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("stored Core transaction revision is invalid");
	let result = canonicalJSON(value.result, "stored Core transaction result").normalized;
	return freeze({
		expectedRevision: value.expectedRevision,
		idempotencyKey: value.idempotencyKey,
		operationDigest: value.operationDigest,
		result,
		revision: value.revision,
		scope: value.scope,
		state: value.state,
	});
}

function validateStoredRevision(value) {
	if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string"
			|| !SCOPE_PATTERN.test(value[0]) || !Number.isSafeInteger(value[1]) || value[1] < 1) {
		throw new Error("stored Core transaction scope revision is invalid");
	}
	return value;
}

function encode(value, label) {
	let encoded;
	try { encoded = JSON.stringify(value); }
	catch (error) { throw new Error(`${label} is not serializable: ${error.message}`); }
	if (typeof encoded !== "string") throw new Error(`${label} is not serializable`);
	return encoded;
}

export function createZoteroCoreTransactionStore({ Zotero } = {}) {
	if (!Zotero?.DB
			|| typeof Zotero.DB.queryAsync !== "function"
			|| typeof Zotero.DB.executeTransaction !== "function") {
		throw new Error("Zotero Core transaction store requires Zotero.DB");
	}
	return Object.freeze({
		async load() {
			let rows = await Zotero.DB.queryAsync(
				"SELECT setting, key, value FROM settings WHERE setting IN (?, ?)",
				[RECEIPT_SETTING, REVISION_SETTING]
			);
			let receipts = [];
			let revisions = [];
			for (let row of rows || []) {
				if (row.setting === RECEIPT_SETTING) {
					let receipt;
					try { receipt = JSON.parse(row.value); }
					catch (_) { throw new Error(`stored Core transaction receipt ${row.key} is corrupt`); }
					if (receipt?.idempotencyKey !== row.key) throw new Error(`stored Core transaction receipt ${row.key} has mismatched identity`);
					receipts.push(receipt);
				}
				else if (row.setting === REVISION_SETTING) revisions.push([row.key, Number(row.value)]);
			}
			return { receipts, revisions };
		},
		async reserve(receipt) {
			exactObject(receipt, new Set(["expectedRevision", "idempotencyKey", "operationDigest", "scope", "state"]), "Core transaction reservation");
			let value = encode(receipt, "Core transaction reservation");
			await Zotero.DB.executeTransaction(() => Zotero.DB.queryAsync(
				"INSERT INTO settings (setting, key, value) VALUES (?, ?, ?)",
				[RECEIPT_SETTING, receipt.idempotencyKey, value]
			));
		},
		async commit({ evictedKeys, receipt, scopeRevision } = {}) {
			if (!Array.isArray(evictedKeys) || evictedKeys.some(key => typeof key !== "string")) throw new Error("Core transaction evictedKeys are invalid");
			exactObject(receipt, new Set(["expectedRevision", "idempotencyKey", "operationDigest", "result", "revision", "scope", "state"]), "Core transaction receipt");
			exactObject(scopeRevision, new Set(["revision", "scope"]), "Core transaction scope revision");
			let value = encode(receipt, "Core transaction receipt");
			await Zotero.DB.executeTransaction(async () => {
				let reserved = await Zotero.DB.valueQueryAsync("SELECT value FROM settings WHERE setting=? AND key=?", [RECEIPT_SETTING, receipt.idempotencyKey]);
				if (reserved === false) throw new Error("Core transaction reservation disappeared before commit");
				let parsed;
				try { parsed = JSON.parse(reserved); }
				catch (_) { throw new Error("Core transaction reservation is corrupt before commit"); }
				if (parsed?.state !== "pending" || parsed?.operationDigest !== receipt.operationDigest || parsed?.scope !== receipt.scope) {
					throw new Error("Core transaction reservation changed before commit");
				}
				await Zotero.DB.queryAsync("UPDATE settings SET value=? WHERE setting=? AND key=?", [value, RECEIPT_SETTING, receipt.idempotencyKey]);
				await Zotero.DB.queryAsync("REPLACE INTO settings (setting, key, value) VALUES (?, ?, ?)", [REVISION_SETTING, scopeRevision.scope, String(scopeRevision.revision)]);
				for (let idempotencyKey of evictedKeys) await Zotero.DB.queryAsync("DELETE FROM settings WHERE setting=? AND key=?", [RECEIPT_SETTING, idempotencyKey]);
			});
		},
		async release(idempotencyKey) {
			if (typeof idempotencyKey !== "string") throw new Error("Core transaction idempotencyKey is invalid");
			await Zotero.DB.executeTransaction(() => Zotero.DB.queryAsync("DELETE FROM settings WHERE setting=? AND key=?", [RECEIPT_SETTING, idempotencyKey]));
		},
	});
}

function validateTransaction(value) {
	exactObject(value, new Set(["expectedRevision", "idempotencyKey", "operation", "scope"]), "Core transaction");
	if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) {
		throw new Error("Core transaction expectedRevision must be a non-negative safe integer");
	}
	if (typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_PATTERN.test(value.idempotencyKey)) {
		throw new Error("Core transaction idempotencyKey is invalid");
	}
	if (typeof value.scope !== "string" || !SCOPE_PATTERN.test(value.scope) || value.scope.length > 256) {
		throw new Error("Core transaction scope is invalid");
	}
	let operation = canonicalJSON(value.operation, "Core transaction operation");
	return freeze({
		expectedRevision: value.expectedRevision,
		idempotencyKey: value.idempotencyKey,
		operation: operation.normalized,
		operationBytes: operation.encoded,
		scope: value.scope,
	});
}

export function createCoreTransactionRegistry({ capacity = DEFAULT_CAPACITY, store } = {}) {
	if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100000) {
		throw new Error("Core transaction capacity must be an integer from 1 through 100000");
	}
	validateStore(store);
	let receipts = new Map();
	let revisions = new Map();
	let scopeTails = new Map();
	let recoveryScopes = new Set();
	let hydrated = !store;
	let hydration;

	async function hydrate() {
		if (hydrated) return;
		if (!hydration) hydration = (async () => {
			let loaded = await store.load();
			exactObject(loaded, new Set(["receipts", "revisions"]), "Core transaction store state");
			if (!Array.isArray(loaded.receipts) || !Array.isArray(loaded.revisions)) throw new Error("Core transaction store state is invalid");
			let nextReceipts = new Map();
			let nextRevisions = new Map();
			let nextRecoveryScopes = new Set();
			for (let value of loaded.receipts) {
				let receipt = validateStoredReceipt(value);
				if (nextReceipts.has(receipt.idempotencyKey)) throw new Error("Core transaction store contains duplicate receipts");
				if (receipt.state === "pending") nextRecoveryScopes.add(receipt.scope);
				nextReceipts.set(receipt.idempotencyKey, receipt);
			}
			for (let value of loaded.revisions) {
				let [scope, revision] = validateStoredRevision(value);
				if (nextRevisions.has(scope)) throw new Error("Core transaction store contains duplicate scope revisions");
				nextRevisions.set(scope, revision);
			}
			for (let receipt of nextReceipts.values()) {
				if (receipt.state === "completed" && nextRevisions.get(receipt.scope) < receipt.revision) {
					throw new Error("Core transaction store receipt exceeds its scope revision");
				}
			}
			receipts = nextReceipts;
			revisions = nextRevisions;
			recoveryScopes = nextRecoveryScopes;
			hydrated = true;
		})();
		await hydration;
	}

	return Object.freeze({
		get receiptCount() { return receipts.size; },
		getRevision(scope) {
			if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) throw new Error("Core transaction scope is invalid");
			return revisions.get(scope) || 0;
		},
		async execute(input, operation) {
			let transaction = validateTransaction(input);
			if (typeof operation !== "function") throw new Error("Core transaction operation callback is required");
			await hydrate();
			let operationDigest;
			let existing = receipts.get(transaction.idempotencyKey);
			if (existing) {
				let sameOperation = existing.operationBytes !== undefined
					? existing.operationBytes === transaction.operationBytes
					: existing.operationDigest === await sha256(transaction.operationBytes);
				if (existing.scope !== transaction.scope || existing.expectedRevision !== transaction.expectedRevision
						|| !sameOperation) {
					throw conflict("IDEMPOTENCY_CONFLICT", "Core transaction idempotency key was reused with different input");
				}
				if (existing.state === "pending" && !existing.promise) {
					throw conflict("TRANSACTION_RECOVERY_REQUIRED", "Core transaction outcome is ambiguous after an interrupted Core process", {
						idempotencyKey: transaction.idempotencyKey,
						scope: transaction.scope,
					});
				}
				if (!existing.promise) {
					return freeze({ replayed: true, result: existing.result, revision: existing.revision });
				}
				let completed = await existing.promise;
				return freeze({ ...completed, replayed: true });
			}
			if (recoveryScopes.has(transaction.scope)) {
				throw conflict("TRANSACTION_RECOVERY_REQUIRED", "Core transaction scope has an interrupted transaction", { scope: transaction.scope });
			}
			let resolveReceipt;
			let rejectReceipt;
			let promise = new Promise((resolve, reject) => {
				resolveReceipt = resolve;
				rejectReceipt = reject;
			});
			let receipt = { ...transaction, operationDigestPromise: sha256(transaction.operationBytes), promise, state: "pending" };
			receipts.set(transaction.idempotencyKey, receipt);
			let previous = scopeTails.get(transaction.scope) || Promise.resolve();
			let releaseScope;
			let scopeTail = new Promise(resolve => { releaseScope = resolve; });
			scopeTails.set(transaction.scope, scopeTail);
			let operationCompleted = false;
			try {
				await previous;
				operationDigest = await receipt.operationDigestPromise;
				if (store) await store.reserve(freeze({
					expectedRevision: transaction.expectedRevision,
					idempotencyKey: transaction.idempotencyKey,
					operationDigest,
					scope: transaction.scope,
					state: "pending",
				}));
				let actualRevision = revisions.get(transaction.scope) || 0;
				if (transaction.expectedRevision !== actualRevision) {
					throw conflict("REVISION_CONFLICT", "Core transaction expected revision does not match", {
						actualRevision,
						expectedRevision: transaction.expectedRevision,
						scope: transaction.scope,
					});
				}
				let result = canonicalJSON(await operation(transaction.operation), "Core transaction result").normalized;
				operationCompleted = true;
				let revision = actualRevision + 1;
				let completed = freeze({ replayed: false, result, revision });
				let storedReceipt = freeze({
					expectedRevision: transaction.expectedRevision,
					idempotencyKey: transaction.idempotencyKey,
					operationDigest,
					result,
					revision,
					scope: transaction.scope,
					state: "completed",
				});
				let evictedKeys = [];
				let retained = [...receipts.entries()].filter(([key, value]) =>
					key !== transaction.idempotencyKey && value.state === "completed");
				while (retained.length >= capacity) evictedKeys.push(retained.shift()[0]);
				if (store) await store.commit({
					evictedKeys,
					receipt: storedReceipt,
					scopeRevision: freeze({ revision, scope: transaction.scope }),
				});
				revisions.set(transaction.scope, revision);
				resolveReceipt(completed);
				receipts.set(transaction.idempotencyKey, { ...storedReceipt, promise: Promise.resolve(completed) });
				for (let key of evictedKeys) receipts.delete(key);
				while (receipts.size > capacity) {
					let key = [...receipts].find(([, value]) => value.state === "completed")?.[0];
					if (!key) break;
					receipts.delete(key);
				}
				return completed;
			}
			catch (error) {
				receipts.delete(transaction.idempotencyKey);
				if (store && !operationCompleted) {
					try { await store.release(transaction.idempotencyKey); }
					catch (releaseError) {
						recoveryScopes.add(transaction.scope);
						error = conflict("TRANSACTION_RECOVERY_REQUIRED", "Core transaction could not clear its durable reservation", {
							cause: releaseError,
							idempotencyKey: transaction.idempotencyKey,
							scope: transaction.scope,
						});
					}
				}
				else if (store) {
					recoveryScopes.add(transaction.scope);
					error = conflict("TRANSACTION_RECOVERY_REQUIRED", "Core transaction outcome could not be durably committed", {
						cause: error,
						idempotencyKey: transaction.idempotencyKey,
						scope: transaction.scope,
					});
				}
				rejectReceipt(error);
				promise.catch(() => {});
				throw error;
			}
			finally {
				releaseScope();
				if (scopeTails.get(transaction.scope) === scopeTail) scopeTails.delete(transaction.scope);
			}
		},
	});
}
