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

const COLLECTION_FIELDS = new Set(["libraryId", "parentKey"]);
const SEARCH_FIELDS = new Set(["collectionKey", "cursor", "libraryId", "limit", "query"]);
const MAX_PAGE_SIZE = 200;

function exactObject(value, fields, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	for (let field of Object.keys(value)) {
		if (!fields.has(field)) throw new Error(`${label} has unknown field ${field}`);
	}
}

function positiveLibraryId(value, label) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${label} libraryId must be a positive safe integer`);
	}
}

function validateCollectionsParams(params) {
	exactObject(params, COLLECTION_FIELDS, "library.collections params");
	let hasParent = params.parentKey !== undefined;
	let hasLibrary = params.libraryId !== undefined;
	if (hasParent !== hasLibrary) {
		throw new Error("library.collections parentKey and libraryId must be provided together");
	}
	if (hasParent && (typeof params.parentKey !== "string" || !params.parentKey)) {
		throw new Error("library.collections parentKey must be a non-empty string");
	}
	if (hasLibrary) positiveLibraryId(params.libraryId, "library.collections");
}

function validateSearchParams(params) {
	exactObject(params, SEARCH_FIELDS, "library.search params");
	if (typeof params.query !== "string") throw new Error("library.search query must be a string");
	if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > MAX_PAGE_SIZE) {
		throw new Error(`library.search limit must be an integer from 1 through ${MAX_PAGE_SIZE}`);
	}
	if (params.cursor !== undefined && (typeof params.cursor !== "string" || !/^\d+$/.test(params.cursor))) {
		throw new Error("library.search cursor must be a decimal offset");
	}
	let hasCollection = params.collectionKey !== undefined;
	let hasLibrary = params.libraryId !== undefined;
	if (hasCollection !== hasLibrary) {
		throw new Error("library.search collectionKey and libraryId must be provided together");
	}
	if (hasCollection && (typeof params.collectionKey !== "string" || !params.collectionKey)) {
		throw new Error("library.search collectionKey must be a non-empty string");
	}
	if (hasLibrary) positiveLibraryId(params.libraryId, "library.search");
}

function compareText(left, right) {
	return String(left).localeCompare(String(right), "en-US");
}

function collectionSummary(collection) {
	let summary = {
		childCount: collection.getChildCollections(true, false).length,
		collectionKey: collection.key,
		itemCount: collection.getChildItems(true, false).length,
		libraryId: collection.libraryID,
		name: collection.name,
	};
	if (collection.parentKey) summary.parentKey = collection.parentKey;
	return summary;
}

function creatorName(creator) {
	if (typeof creator?.name === "string" && creator.name.trim()) return creator.name.trim();
	return [creator?.firstName, creator?.lastName]
		.filter(value => typeof value === "string" && value.trim())
		.map(value => value.trim())
		.join(" ");
}

function itemSummary(Zotero, item) {
	let collectionKeys = item.getCollections(false)
		.map(id => Zotero.Collections.get(id))
		.filter(collection => collection && collection.libraryID === item.libraryID)
		.map(collection => collection.key)
		.sort(compareText);
	let creators = item.getCreatorsJSON().map(creatorName).filter(Boolean);
	let summary = {
		attachmentCount: item.getAttachments(false).length,
		collectionKeys,
		creators,
		itemKey: item.key,
		itemType: Zotero.ItemTypes.getName(item.itemTypeID),
		libraryId: item.libraryID,
		title: item.getDisplayTitle(),
	};
	let year = item.getField("year");
	if (typeof year === "number" && Number.isSafeInteger(year) && year >= 0
			|| typeof year === "string" && /^\d{1,4}$/.test(year)) {
		summary.year = Number(year);
	}
	return summary;
}

function validateZotero(Zotero) {
	let required = [
		[Zotero?.Collections, "get"],
		[Zotero?.Collections, "getByLibrary"],
		[Zotero?.Collections, "getByLibraryAndKey"],
		[Zotero?.Items, "getAll"],
		[Zotero?.ItemTypes, "getName"],
		[Zotero?.Libraries, "getAll"],
	];
	for (let [owner, method] of required) {
		if (typeof owner?.[method] !== "function") {
			throw new Error(`initialized Zotero API is missing ${method}`);
		}
	}
}

export function createZoteroLibraryAdapter({ Zotero } = {}) {
	validateZotero(Zotero);

	return Object.freeze({
		async collections(params) {
			validateCollectionsParams(params);
			let collections;
			if (params.parentKey !== undefined) {
				let parent = Zotero.Collections.getByLibraryAndKey(params.libraryId, params.parentKey);
				if (!parent) throw new Error(`Zotero collection ${params.libraryId}/${params.parentKey} was not found`);
				collections = parent.getChildCollections(false, false);
			}
			else {
				collections = Zotero.Libraries.getAll().flatMap(library =>
					Zotero.Collections.getByLibrary(library.libraryID, false, false));
			}
			return {
				collections: collections.map(collectionSummary).sort((left, right) =>
					compareText(left.name, right.name)
					|| left.libraryId - right.libraryId
					|| compareText(left.collectionKey, right.collectionKey)),
			};
		},

		async search(params) {
			validateSearchParams(params);
			let items;
			if (params.collectionKey !== undefined) {
				let collection = Zotero.Collections.getByLibraryAndKey(params.libraryId, params.collectionKey);
				if (!collection) throw new Error(`Zotero collection ${params.libraryId}/${params.collectionKey} was not found`);
				items = collection.getChildItems(false, false);
			}
			else {
				let byLibrary = await Promise.all(Zotero.Libraries.getAll().map(library =>
					Zotero.Items.getAll(library.libraryID, true, false, false)));
				items = byLibrary.flat();
			}

			let query = params.query.trim().toLocaleLowerCase("en-US");
			let matches = items
				.filter(item => item?.isRegularItem?.())
				.map(item => itemSummary(Zotero, item))
				.filter(item => !query || [item.title, ...item.creators]
					.some(value => String(value).toLocaleLowerCase("en-US").includes(query)))
				.sort((left, right) => compareText(left.title, right.title)
					|| left.libraryId - right.libraryId
					|| compareText(left.itemKey, right.itemKey));
			let offset = Number(params.cursor || 0);
			let page = matches.slice(offset, offset + params.limit);
			let nextOffset = offset + page.length;
			return {
				items: page,
				...(nextOffset < matches.length && { nextCursor: String(nextOffset) }),
				total: matches.length,
			};
		},
	});
}
