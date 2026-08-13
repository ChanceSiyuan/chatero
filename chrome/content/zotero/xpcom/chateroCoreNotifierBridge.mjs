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

const OBSERVED_TYPES = Object.freeze([
	"collection", "search", "item", "file", "tag", "group", "trash", "relation", "feed", "feedItem", "sync",
]);
const TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

function itemIdentities(Zotero, ids, maxIdentities) {
	let numeric = ids.filter(id => Number.isSafeInteger(id) && id > 0).slice(0, maxIdentities);
	let items = Zotero.Items?.get?.(numeric) || [];
	return items
		.filter(item => Number.isSafeInteger(item?.libraryID) && item.libraryID > 0 && typeof item.key === "string" && /^[A-Z0-9]{8}$/.test(item.key))
		.map(item => ({ itemKey: item.key, libraryId: item.libraryID }));
}

function genericIdentities(ids, maxIdentities) {
	return ids
		.filter(id => typeof id === "string" && id.length > 0 && id.length <= 128 || Number.isSafeInteger(id) && id >= 0)
		.slice(0, maxIdentities)
		.map(id => ({ id: String(id) }));
}

export function createZoteroNotifierBridge({ Zotero, publish, maxIdentities = 256 } = {}) {
	if (typeof Zotero?.Notifier?.registerObserver !== "function" || typeof Zotero.Notifier.unregisterObserver !== "function") {
		throw new Error("Zotero notifier bridge requires the Zotero Notifier API");
	}
	if (typeof publish !== "function") throw new Error("Zotero notifier bridge publish callback is required");
	if (!Number.isSafeInteger(maxIdentities) || maxIdentities < 1 || maxIdentities > 1000) {
		throw new Error("Zotero notifier bridge maxIdentities must be an integer from 1 through 1000");
	}
	let observer = {
		async notify(action, objectType, ids) {
			if (!TOKEN_PATTERN.test(action) || !OBSERVED_TYPES.includes(objectType) || !Array.isArray(ids)) return;
			let identities = objectType === "item" || objectType === "file"
				? itemIdentities(Zotero, ids, maxIdentities)
				: genericIdentities(ids, maxIdentities);
			publish(`zotero.${objectType.toLowerCase()}.${action.toLowerCase()}`, {
				action,
				identities,
				objectType,
				truncated: ids.length > maxIdentities,
			});
		},
	};
	let observerId = Zotero.Notifier.registerObserver(observer, [...OBSERVED_TYPES], "chatero-core");
	let disposed = false;
	return Object.freeze({
		dispose() {
			if (disposed) return false;
			disposed = true;
			Zotero.Notifier.unregisterObserver(observerId);
			return true;
		},
	});
}
