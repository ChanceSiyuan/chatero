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

const RECEIPT_SETTING = "chateroCoreTransactionReceiptV1";
const REVISION_SETTING = "chateroCoreTransactionRevisionV1";

function exactObject(value, fields, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	for (let field of Object.keys(value)) {
		if (!fields.has(field)) throw new Error(`${label} has unknown field ${field}`);
	}
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
				else if (row.setting === REVISION_SETTING) {
					let revision = Number(row.value);
					revisions.push([row.key, revision]);
				}
			}
			return { receipts, revisions };
		},

		async reserve(receipt) {
			exactObject(receipt, new Set([
				"expectedRevision", "idempotencyKey", "operationDigest", "scope", "state",
			]), "Core transaction reservation");
			let value = encode(receipt, "Core transaction reservation");
			await Zotero.DB.executeTransaction(async () => {
				await Zotero.DB.queryAsync(
					"INSERT INTO settings (setting, key, value) VALUES (?, ?, ?)",
					[RECEIPT_SETTING, receipt.idempotencyKey, value]
				);
			});
		},

		async commit({ evictedKeys, receipt, scopeRevision } = {}) {
			if (!Array.isArray(evictedKeys) || evictedKeys.some(key => typeof key !== "string")) {
				throw new Error("Core transaction evictedKeys are invalid");
			}
			exactObject(receipt, new Set([
				"expectedRevision", "idempotencyKey", "operationDigest", "result", "revision", "scope", "state",
			]), "Core transaction receipt");
			exactObject(scopeRevision, new Set(["revision", "scope"]), "Core transaction scope revision");
			let value = encode(receipt, "Core transaction receipt");
			await Zotero.DB.executeTransaction(async () => {
				let changed = await Zotero.DB.queryAsync(
					"UPDATE settings SET value=? WHERE setting=? AND key=?",
					[value, RECEIPT_SETTING, receipt.idempotencyKey]
				);
				if (changed !== 1) throw new Error("Core transaction reservation disappeared before commit");
				await Zotero.DB.queryAsync(
					"REPLACE INTO settings (setting, key, value) VALUES (?, ?, ?)",
					[REVISION_SETTING, scopeRevision.scope, String(scopeRevision.revision)]
				);
				for (let idempotencyKey of evictedKeys) {
					await Zotero.DB.queryAsync(
						"DELETE FROM settings WHERE setting=? AND key=?",
						[RECEIPT_SETTING, idempotencyKey]
					);
				}
			});
		},

		async release(idempotencyKey) {
			if (typeof idempotencyKey !== "string") throw new Error("Core transaction idempotencyKey is invalid");
			await Zotero.DB.executeTransaction(async () => {
				await Zotero.DB.queryAsync(
					"DELETE FROM settings WHERE setting=? AND key=?",
					[RECEIPT_SETTING, idempotencyKey]
				);
			});
		},
	});
}

