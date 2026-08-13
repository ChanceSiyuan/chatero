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
const MAX_OPERATION_BYTES = 256 * 1024;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const SCOPE_PATTERN = /^[a-z][a-z0-9-]*(?::[A-Za-z0-9._-]+)(?:\/[a-z][a-z0-9-]*:[A-Za-z0-9._-]+)*$/;

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

export function createCoreTransactionRegistry({ capacity = DEFAULT_CAPACITY } = {}) {
	if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100000) {
		throw new Error("Core transaction capacity must be an integer from 1 through 100000");
	}
	let receipts = new Map();
	let revisions = new Map();

	return Object.freeze({
		get receiptCount() { return receipts.size; },
		getRevision(scope) {
			if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) throw new Error("Core transaction scope is invalid");
			return revisions.get(scope) || 0;
		},
		async execute(input, operation) {
			let transaction = validateTransaction(input);
			if (typeof operation !== "function") throw new Error("Core transaction operation callback is required");
			let existing = receipts.get(transaction.idempotencyKey);
			if (existing) {
				if (existing.scope !== transaction.scope || existing.expectedRevision !== transaction.expectedRevision
						|| existing.operationBytes !== transaction.operationBytes) {
					throw conflict("IDEMPOTENCY_CONFLICT", "Core transaction idempotency key was reused with different input");
				}
				let completed = await existing.promise;
				return freeze({ ...completed, replayed: true });
			}
			let actualRevision = revisions.get(transaction.scope) || 0;
			if (transaction.expectedRevision !== actualRevision) {
				throw conflict("REVISION_CONFLICT", "Core transaction expected revision does not match", {
					actualRevision,
					expectedRevision: transaction.expectedRevision,
					scope: transaction.scope,
				});
			}
			let resolveReceipt;
			let rejectReceipt;
			let promise = new Promise((resolve, reject) => {
				resolveReceipt = resolve;
				rejectReceipt = reject;
			});
			let receipt = { ...transaction, promise };
			receipts.set(transaction.idempotencyKey, receipt);
			try {
				let result = canonicalJSON(await operation(transaction.operation), "Core transaction result").normalized;
				let revision = actualRevision + 1;
				revisions.set(transaction.scope, revision);
				let completed = freeze({ replayed: false, result, revision });
				resolveReceipt(completed);
				receipt.promise = Promise.resolve(completed);
				while (receipts.size > capacity) receipts.delete(receipts.keys().next().value);
				return completed;
			}
			catch (error) {
				receipts.delete(transaction.idempotencyKey);
				rejectReceipt(error);
				promise.catch(() => {});
				throw error;
			}
		},
	});
}
