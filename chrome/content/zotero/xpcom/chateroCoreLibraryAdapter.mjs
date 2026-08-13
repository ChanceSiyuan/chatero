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

import { openGeckoAttachmentSource } from "./chateroCoreGeckoAttachmentSource.mjs";

const COLLECTION_FIELDS = new Set(["libraryId", "parentKey"]);
const SEARCH_FIELDS = new Set(["collectionKey", "cursor", "libraryId", "limit", "query", "sortBy", "sortDirection"]);
const SEARCH_SORT_FIELDS = new Set(["creators", "itemType", "title", "year"]);
const SEARCH_SORT_DIRECTIONS = new Set(["asc", "desc"]);
const ITEM_CHILDREN_FIELDS = new Set(["itemKey", "libraryId"]);
const ITEM_METADATA_FIELDS = new Set(["itemKey", "libraryId"]);
const ITEM_FACTS_FIELDS = new Set(["itemKey", "libraryId"]);
const UPDATE_ITEM_FIELDS = new Set(["creators", "expectedVersion", "fields", "itemKey", "libraryId", "relations", "tags"]);
const ANNOTATION_FIELDS = new Set(["attachmentKey", "libraryId"]);
const UPDATE_ANNOTATIONS_FIELDS = new Set(["attachmentKey", "libraryId", "updates"]);
const ATTACHMENT_FIELDS = new Set(["attachmentKey", "libraryId"]);
const ATTACHMENT_STATE_FIELDS = new Set(["attachmentKey", "libraryId"]);
const NOTE_FIELDS = new Set(["libraryId", "noteKey"]);
const UPDATE_NOTE_FIELDS = new Set(["expectedVersion", "html", "libraryId", "noteKey"]);
const LIBRARIES_FIELDS = new Set();
const FEEDS_FIELDS = new Set();
const SYNC_STATUS_FIELDS = new Set();
const SYNC_RETRY_FIELDS = new Set(["libraryIds"]);
const SAVED_SEARCH_FIELDS = new Set(["libraryId"]);
const SAVED_SEARCH_ITEMS_FIELDS = new Set(["cursor", "libraryId", "limit", "searchKey"]);
const TAG_FIELDS = new Set(["cursor", "libraryId", "limit", "query"]);
const MAX_PAGE_SIZE = 200;
const MAX_NOTE_BYTES = 512 * 1024;
const MAX_ANNOTATION_FIELD_BYTES = 256 * 1024;
const MAX_METADATA_FIELD_BYTES = 256 * 1024;
const MAX_RELATIONS = 1024;
const MAX_RELATION_FIELD_BYTES = 16 * 1024;
const MAX_MUTATION_ENTRIES = 1024;

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

function zoteroKey(value, label) {
	if (typeof value !== "string" || !/^[A-Z0-9]{8}$/.test(value)) {
		throw new Error(`${label} must be an eight-character Zotero key`);
	}
}

function validateCompositeParams(params, fields, keyField, label) {
	exactObject(params, fields, `${label} params`);
	positiveLibraryId(params.libraryId, label);
	zoteroKey(params[keyField], `${label} ${keyField}`);
}

function boundedString(value, maxBytes, label) {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	if (new TextEncoder().encode(value).length > maxBytes) throw new Error(`${label} exceeds its size limit`);
	return value;
}

function stableJSON(value) {
	if (Array.isArray(value)) return value.map(stableJSON);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJSON(value[key])]));
}

function canonicalPosition(value) {
	let text = boundedString(value, MAX_ANNOTATION_FIELD_BYTES, "annotation position");
	let parsed;
	try {
		parsed = JSON.parse(text);
	}
	catch (_) {
		throw new Error("annotation position must be valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("annotation position must contain an object");
	}
	return JSON.stringify(stableJSON(parsed));
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
	if (params.sortBy !== undefined && !SEARCH_SORT_FIELDS.has(params.sortBy)) {
		throw new Error(`library.search sortBy must be one of ${[...SEARCH_SORT_FIELDS].join(", ")}`);
	}
	if (params.sortDirection !== undefined && !SEARCH_SORT_DIRECTIONS.has(params.sortDirection)) {
		throw new Error("library.search sortDirection must be asc or desc");
	}
}

function validateTagsParams(params) {
	exactObject(params, TAG_FIELDS, "library.tags params");
	positiveLibraryId(params.libraryId, "library.tags");
	if (typeof params.query !== "string") throw new Error("library.tags query must be a string");
	if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > MAX_PAGE_SIZE) {
		throw new Error(`library.tags limit must be an integer from 1 through ${MAX_PAGE_SIZE}`);
	}
	if (params.cursor !== undefined && (typeof params.cursor !== "string" || !/^\d+$/.test(params.cursor))) {
		throw new Error("library.tags cursor must be a decimal offset");
	}
}

function compareText(left, right) {
	return String(left).localeCompare(String(right), "en-US");
}

function compareItemSummary(left, right, sortBy) {
	if (sortBy === "year") {
		let leftYear = Number.isSafeInteger(left.year) ? left.year : null;
		let rightYear = Number.isSafeInteger(right.year) ? right.year : null;
		if (leftYear === null && rightYear === null) return 0;
		if (leftYear === null) return 1;
		if (rightYear === null) return -1;
		return leftYear - rightYear;
	}
	if (sortBy === "creators") {
		return compareText(left.creators?.[0] || "", right.creators?.[0] || "");
	}
	if (sortBy === "itemType") {
		return compareText(left.itemType, right.itemType);
	}
	return compareText(left.title, right.title);
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

function optionalField(item, field) {
	let value = item.getField(field);
	if (typeof value !== "string" || !value.trim()) return undefined;
	return value.trim();
}

function itemMetadataSummary(Zotero, item) {
	let creators = item.getCreatorsJSON().map(creatorName).filter(Boolean);
	let tags = (item.getTags() || [])
		.map(tag => tag?.tag)
		.filter(value => typeof value === "string" && value.trim())
		.map(value => value.trim())
		.sort(compareText);
	let metadata = {
		abstractNote: boundedString(item.getField("abstractNote") || "", MAX_METADATA_FIELD_BYTES, "item abstractNote"),
		creators,
		date: item.getField("date") || "",
		itemKey: item.key,
		itemType: Zotero.ItemTypes.getName(item.itemTypeID),
		libraryId: item.libraryID,
		tags,
		title: item.getDisplayTitle(),
	};
	let year = item.getField("year");
	if (typeof year === "number" && Number.isSafeInteger(year) && year >= 0
			|| typeof year === "string" && /^\d{1,4}$/.test(year)) {
		metadata.year = Number(year);
	}
	for (let [field, key] of [["DOI", "doi"], ["url", "url"], ["publicationTitle", "publicationTitle"]]) {
		let value = optionalField(item, field);
		if (value !== undefined) metadata[key] = value;
	}
	return metadata;
}

function itemFactsSummary(Zotero, item) {
	let rawRelations = item.getRelations?.() || {};
	if (!rawRelations || typeof rawRelations !== "object" || Array.isArray(rawRelations)) {
		throw new Error("Zotero item relations must be an object");
	}
	let relations = [];
	for (let [predicate, rawObjects] of Object.entries(rawRelations)) {
		let objects = Array.isArray(rawObjects) ? rawObjects : [rawObjects];
		for (let object of objects) {
			relations.push({
				object: boundedString(object, MAX_RELATION_FIELD_BYTES, "item relation object"),
				predicate: boundedString(predicate, MAX_RELATION_FIELD_BYTES, "item relation predicate"),
			});
			if (relations.length > MAX_RELATIONS) throw new Error(`item relations exceed the ${MAX_RELATIONS} entry limit`);
		}
	}
	relations.sort((left, right) => compareText(left.predicate, right.predicate) || compareText(left.object, right.object));
	return {
		citationWarning: Boolean(Zotero.Retractions.shouldShowCitationWarning(item)),
		itemKey: item.key,
		libraryId: item.libraryID,
		relations,
		retracted: Boolean(Zotero.Retractions.isRetracted(item)),
		synced: Boolean(item.synced),
		version: Number.isSafeInteger(item.version) && item.version >= 0 ? item.version : 0,
	};
}

function stateName(value, owner, prefix, names, fallback) {
	for (let name of names) {
		if (value === owner?.[`${prefix}${name.replaceAll("-", "_").toUpperCase()}`]) return name;
	}
	return fallback;
}

async function attachmentStateSummary(Zotero, attachment) {
	let path = await attachment.getFilePathAsync();
	let fulltext = Zotero.Fulltext || Zotero.FullText;
	let indexState = await fulltext.getIndexedState(attachment);
	let pages = await fulltext.getPages(attachment.id);
	let version = await fulltext.getItemVersion(attachment.id);
	let result = {
		attachmentKey: attachment.key,
		fileAvailable: typeof path === "string" && path.startsWith("/"),
		fulltextIndexState: stateName(indexState, fulltext, "INDEX_STATE_",
			["unavailable", "unindexed", "partial", "indexed", "queued"], "unknown"),
		libraryId: attachment.libraryID,
		storageSyncState: stateName(attachment.attachmentSyncState, Zotero.Sync.Storage.Local, "SYNC_STATE_",
			["to-upload", "to-download", "in-sync", "force-upload", "force-download", "in-conflict"], "unknown"),
	};
	if (Number.isSafeInteger(version) && version >= 0) result.fulltextVersion = version;
	if (Number.isSafeInteger(pages?.indexedPages) && pages.indexedPages >= 0) result.indexedPages = pages.indexedPages;
	if (Number.isSafeInteger(pages?.total) && pages.total >= 0) result.totalPages = pages.total;
	return result;
}

function validateItemUpdate(params) {
	exactObject(params, UPDATE_ITEM_FIELDS, "library.item-update params");
	positiveLibraryId(params.libraryId, "library.item-update");
	zoteroKey(params.itemKey, "library.item-update itemKey");
	if (!Number.isSafeInteger(params.expectedVersion) || params.expectedVersion < 0) {
		throw new Error("library.item-update expectedVersion must be a non-negative safe integer");
	}
	if (!Array.isArray(params.fields) || params.fields.length > MAX_MUTATION_ENTRIES) {
		throw new Error("library.item-update fields must be a bounded array");
	}
	for (let field of params.fields) {
		exactObject(field, new Set(["field", "value"]), "library.item-update field");
		if (typeof field.field !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(field.field)) {
			throw new Error("library.item-update field name is invalid");
		}
		boundedString(field.value, MAX_METADATA_FIELD_BYTES, `library.item-update ${field.field}`);
	}
	if (params.creators !== undefined) {
		if (!Array.isArray(params.creators) || params.creators.length > MAX_MUTATION_ENTRIES) {
			throw new Error("library.item-update creators must be a bounded array");
		}
		for (let creator of params.creators) {
			exactObject(creator, new Set(["creatorType", "firstName", "lastName", "name"]), "library.item-update creator");
			boundedString(creator.creatorType, 256, "creator type");
			let hasName = typeof creator.name === "string";
			let hasParts = typeof creator.firstName === "string" && typeof creator.lastName === "string";
			if (hasName === hasParts) throw new Error("creator requires either name or firstName and lastName");
			for (let value of [creator.name, creator.firstName, creator.lastName]) {
				if (value !== undefined) boundedString(value, MAX_RELATION_FIELD_BYTES, "creator name");
			}
		}
	}
	if (params.tags !== undefined) {
		if (!Array.isArray(params.tags) || params.tags.length > MAX_MUTATION_ENTRIES) {
			throw new Error("library.item-update tags must be a bounded array");
		}
		for (let tag of params.tags) {
			exactObject(tag, new Set(["name", "type"]), "library.item-update tag");
			boundedString(tag.name, MAX_RELATION_FIELD_BYTES, "tag name");
			if (!Number.isSafeInteger(tag.type) || tag.type < 0 || tag.type > 1) throw new Error("tag type must be 0 or 1");
		}
	}
	if (params.relations !== undefined) {
		if (!Array.isArray(params.relations) || params.relations.length > MAX_RELATIONS) {
			throw new Error("library.item-update relations must be a bounded array");
		}
		for (let relation of params.relations) {
			exactObject(relation, new Set(["object", "predicate"]), "library.item-update relation");
			if (typeof relation.predicate !== "string" || !/^[a-z]+:[a-z]+$/i.test(relation.predicate)) {
				throw new Error("relation predicate is invalid");
			}
			boundedString(relation.object, MAX_RELATION_FIELD_BYTES, "relation object");
		}
	}
	if (!params.fields.length && params.creators === undefined && params.tags === undefined && params.relations === undefined) {
		throw new Error("library.item-update requires at least one change");
	}
}

function relationObject(relations) {
	let result = {};
	for (let relation of relations) (result[relation.predicate] ||= []).push(relation.object);
	return result;
}

function revisionConflict(item, expectedVersion, label) {
	if (item.version === expectedVersion) return;
	let error = new Error(`${label} version changed before update`);
	error.code = "REVISION_CONFLICT";
	error.actualRevision = Number.isSafeInteger(item.version) ? item.version : 0;
	error.expectedRevision = expectedVersion;
	throw error;
}

function validateAnnotationUpdates(params) {
	exactObject(params, UPDATE_ANNOTATIONS_FIELDS, "library.annotations-update params");
	positiveLibraryId(params.libraryId, "library.annotations-update");
	zoteroKey(params.attachmentKey, "library.annotations-update attachmentKey");
	if (!Array.isArray(params.updates) || params.updates.length < 1 || params.updates.length > MAX_MUTATION_ENTRIES) {
		throw new Error("library.annotations-update updates must be a non-empty bounded array");
	}
	let keys = new Set();
	for (let update of params.updates) {
		exactObject(update, new Set(["annotationKey", "color", "comment", "expectedVersion", "text"]), "annotation update");
		zoteroKey(update.annotationKey, "annotation update annotationKey");
		if (keys.has(update.annotationKey)) throw new Error("annotation update keys must be unique");
		keys.add(update.annotationKey);
		if (!Number.isSafeInteger(update.expectedVersion) || update.expectedVersion < 0) {
			throw new Error("annotation update expectedVersion must be a non-negative safe integer");
		}
		for (let field of ["color", "comment", "text"]) {
			if (update[field] !== undefined) boundedString(update[field], MAX_ANNOTATION_FIELD_BYTES, `annotation ${field}`);
		}
		if (update.color === undefined && update.comment === undefined && update.text === undefined) {
			throw new Error("annotation update requires at least one change");
		}
	}
}

function itemIsUnavailable(item) {
	if (!item) return true;
	if (item.deleted) return true;
	return typeof item.isInTrash === "function" ? Boolean(item.isInTrash()) : Boolean(item.isInTrash);
}

function unavailable(message) {
	let error = new Error(message);
	error.code = "UNAVAILABLE";
	throw error;
}

function lookupItem(Zotero, libraryId, key, label) {
	let item = Zotero.Items.getByLibraryAndKey(libraryId, key);
	if (!item || item.libraryID !== libraryId || item.key !== key) {
		unavailable(`${label} ${libraryId}/${key} was not found`);
	}
	if (itemIsUnavailable(item)) unavailable(`${label} ${libraryId}/${key} is unavailable`);
	return item;
}

function parentKey(Zotero, item, label) {
	let parent = Zotero.Items.get(item.parentItemID);
	if (itemIsUnavailable(parent)) unavailable(`${label} parent item is unavailable`);
	if (!parent || parent.libraryID !== item.libraryID || !parent.isRegularItem?.()) {
		throw new Error(`${label} has no valid parent item`);
	}
	return parent.key;
}

async function attachmentSummary(Zotero, attachment, expectedParent) {
	if (!attachment?.isAttachment?.() || !attachment.isFileAttachment?.()
			|| itemIsUnavailable(attachment) || itemIsUnavailable(expectedParent)
			|| attachment.libraryID !== expectedParent.libraryID || attachment.parentItemID !== expectedParent.id) {
		return null;
	}
	let path = await attachment.getFilePathAsync();
	if (typeof path !== "string" || !path.startsWith("/")) return null;
	let filename = attachment.attachmentFilename || "";
	let title = attachment.getDisplayTitle?.() || filename || "Untitled attachment";
	return {
		annotationCount: attachment.getAnnotations(false).length,
		attachmentKey: attachment.key,
		contentType: attachment.attachmentContentType || "application/octet-stream",
		filename,
		libraryId: attachment.libraryID,
		parentItemKey: expectedParent.key,
		title,
	};
}

function noteSummary(Zotero, note, expectedParent) {
	if (!note?.isNote?.() || itemIsUnavailable(note) || itemIsUnavailable(expectedParent)
			|| note.libraryID !== expectedParent.libraryID || note.parentItemID !== expectedParent.id) {
		return null;
	}
	return {
		libraryId: note.libraryID,
		noteKey: note.key,
		parentItemKey: expectedParent.key,
		title: note.getDisplayTitle?.() || "Untitled note",
	};
}

function annotationSummary(annotation, attachment) {
	if (!annotation?.isAnnotation?.() || annotation.libraryID !== attachment.libraryID
			|| annotation.parentItemID !== attachment.id) {
		throw new Error("annotation does not belong to the requested attachment");
	}
	return {
		annotationKey: annotation.key,
		color: boundedString(annotation.annotationColor || "", MAX_ANNOTATION_FIELD_BYTES, "annotation color"),
		comment: boundedString(annotation.annotationComment || "", MAX_ANNOTATION_FIELD_BYTES, "annotation comment"),
		libraryId: annotation.libraryID,
		pageLabel: boundedString(annotation.annotationPageLabel || "", MAX_ANNOTATION_FIELD_BYTES, "annotation pageLabel"),
		positionJson: canonicalPosition(annotation.annotationPosition || "{}"),
		sortIndex: boundedString(annotation.annotationSortIndex || "", MAX_ANNOTATION_FIELD_BYTES, "annotation sortIndex"),
		text: boundedString(annotation.annotationText || "", MAX_ANNOTATION_FIELD_BYTES, "annotation text"),
		type: boundedString(annotation.annotationType || "", MAX_ANNOTATION_FIELD_BYTES, "annotation type"),
	};
}

function validateZotero(Zotero) {
	let required = [
		[Zotero?.Collections, "get"],
		[Zotero?.Collections, "getByLibrary"],
		[Zotero?.Collections, "getByLibraryAndKey"],
		[Zotero?.Items, "getAll"],
		[Zotero?.Items, "get"],
		[Zotero?.Items, "getByLibraryAndKey"],
		[Zotero?.ItemTypes, "getName"],
		[Zotero?.Libraries, "getAll"],
		[Zotero?.Searches, "getAll"],
		[Zotero?.Searches, "getByLibraryAndKey"],
		[Zotero?.Tags, "getAll"],
		[Zotero?.Feeds, "getAll"],
		[Zotero?.Fulltext || Zotero?.FullText, "getIndexedState"],
		[Zotero?.Fulltext || Zotero?.FullText, "getItemVersion"],
		[Zotero?.Fulltext || Zotero?.FullText, "getPages"],
		[Zotero?.Retractions, "isRetracted"],
		[Zotero?.Retractions, "shouldShowCitationWarning"],
	];
	for (let [owner, method] of required) {
		if (typeof owner?.[method] !== "function") {
			throw new Error(`initialized Zotero API is missing ${method}`);
		}
	}
}

export function createZoteroLibraryAdapter({ Zotero, isOffline = () => Boolean(Services?.io?.offline), openAttachmentFile = openGeckoAttachmentSource } = {}) {
	validateZotero(Zotero);
	if (typeof openAttachmentFile !== "function") throw new Error("attachment source opener is required");
	if (typeof isOffline !== "function") throw new Error("offline state provider is required");

	return Object.freeze({
		async feeds(params) {
			exactObject(params, FEEDS_FIELDS, "library.feeds params");
			let feeds = Zotero.Feeds.getAll().map(feed => ({
				cleanupReadAfter: Number.isSafeInteger(feed.cleanupReadAfter) ? feed.cleanupReadAfter : 0,
				cleanupUnreadAfter: Number.isSafeInteger(feed.cleanupUnreadAfter) ? feed.cleanupUnreadAfter : 0,
				lastCheck: Number.isSafeInteger(feed.lastCheck) ? feed.lastCheck : 0,
				lastCheckError: typeof feed.lastCheckError === "string" ? feed.lastCheckError : "",
				lastUpdate: Number.isSafeInteger(feed.lastUpdate) ? feed.lastUpdate : 0,
				libraryId: feed.libraryID,
				name: feed.name,
				refreshInterval: Number.isSafeInteger(feed.refreshInterval) ? feed.refreshInterval : 0,
				unreadCount: Number.isSafeInteger(feed.unreadCount) ? feed.unreadCount : 0,
				updating: Boolean(feed.updating),
				url: feed.url,
			})).sort((left, right) => compareText(left.name, right.name) || left.libraryId - right.libraryId);
			return { feeds };
		},

		async libraries(params) {
			exactObject(params, LIBRARIES_FIELDS, "library.libraries params");
			let libraries = Zotero.Libraries.getAll().map(library => ({
				allowsLinkedFiles: Boolean(library.allowsLinkedFiles),
				archived: Boolean(library.archived),
				editable: Boolean(library.editable),
				filesEditable: Boolean(library.filesEditable),
				...(Number.isSafeInteger(library.groupID) && { groupId: library.groupID }),
				lastSync: Number.isSafeInteger(library.lastSync) ? library.lastSync : 0,
				libraryId: library.libraryID,
				libraryType: library.libraryType,
				libraryVersion: Number.isSafeInteger(library.libraryVersion) ? library.libraryVersion : 0,
				name: library.name,
				storageVersion: Number.isSafeInteger(library.storageVersion) ? library.storageVersion : 0,
				syncable: Boolean(library.syncable),
			})).sort((left, right) => left.libraryId - right.libraryId);
			return { libraries };
		},

		async savedSearches(params) {
			exactObject(params, SAVED_SEARCH_FIELDS, "library.saved-searches params");
			positiveLibraryId(params.libraryId, "library.saved-searches");
			let searches = (await Zotero.Searches.getAll(params.libraryId))
				.filter(value => !itemIsUnavailable(value))
				.map(search => ({
					libraryId: search.libraryID,
					name: search.name,
					searchKey: search.key,
					synced: Boolean(search.synced),
					version: Number.isSafeInteger(search.version) ? search.version : 0,
				}))
				.sort((left, right) => compareText(left.name, right.name) || compareText(left.searchKey, right.searchKey));
			return { searches };
		},

		async savedSearchItems(params) {
			exactObject(params, SAVED_SEARCH_ITEMS_FIELDS, "library.saved-search-items params");
			positiveLibraryId(params.libraryId, "library.saved-search-items");
			zoteroKey(params.searchKey, "library.saved-search-items searchKey");
			if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > MAX_PAGE_SIZE) {
				throw new Error(`library.saved-search-items limit must be an integer from 1 through ${MAX_PAGE_SIZE}`);
			}
			if (params.cursor !== undefined && (typeof params.cursor !== "string" || !/^\d+$/.test(params.cursor))) {
				throw new Error("library.saved-search-items cursor must be a decimal offset");
			}
			let search = Zotero.Searches.getByLibraryAndKey(params.libraryId, params.searchKey);
			if (!search || search.libraryID !== params.libraryId || search.key !== params.searchKey || itemIsUnavailable(search)) {
				unavailable(`Zotero saved search ${params.libraryId}/${params.searchKey} was not found`);
			}
			let ids = await search.search();
			if (!Array.isArray(ids) || ids.some(value => !Number.isSafeInteger(value) || value < 1)) {
				throw new Error("Zotero saved search returned invalid item ids");
			}
			let items = Zotero.Items.get(ids)
				.filter(item => item?.libraryID === params.libraryId && item.isRegularItem?.() && !itemIsUnavailable(item))
				.map(item => itemSummary(Zotero, item))
				.sort((left, right) => compareText(left.title, right.title) || compareText(left.itemKey, right.itemKey));
			let offset = Number(params.cursor || 0);
			if (offset > items.length) throw new Error("library.saved-search-items cursor is outside the result set");
			let page = items.slice(offset, offset + params.limit);
			let nextOffset = offset + page.length;
			return { items: page, ...(nextOffset < items.length && { nextCursor: String(nextOffset) }), total: items.length };
		},

		async tags(params) {
			validateTagsParams(params);
			let query = params.query.trim().toLocaleLowerCase("en-US");
			let matches = (await Zotero.Tags.getAll(params.libraryId))
				.map(tag => ({ name: tag.tag, type: Number.isSafeInteger(tag.type) ? tag.type : 0 }))
				.filter(tag => !query || tag.name.toLocaleLowerCase("en-US").includes(query))
				.sort((left, right) => compareText(left.name, right.name) || left.type - right.type);
			let offset = Number(params.cursor || 0);
			if (offset > matches.length) throw new Error("library.tags cursor is outside the result set");
			let tags = matches.slice(offset, offset + params.limit);
			let nextOffset = offset + tags.length;
			return { tags, ...(nextOffset < matches.length && { nextCursor: String(nextOffset) }), total: matches.length };
		},

		async syncStatus(params) {
			exactObject(params, SYNC_STATUS_FIELDS, "sync.status params");
			let lastSync = Zotero.Sync.Data.Local.getLastSyncTime();
			let libraries = Zotero.Libraries.getAll()
				.filter(library => library.libraryType !== "feed")
				.map(library => ({
					errors: (Zotero.Sync.Runner.getErrorsByLibrary(library.libraryID) || []).slice(0, 100).map(error => ({
						message: boundedString(String(error?.message || error), 16 * 1024, "sync error message"),
						type: typeof error?.errorType === "string" ? error.errorType : "error",
					})),
					lastSync: Number.isSafeInteger(library.lastSync) ? library.lastSync : 0,
					libraryId: library.libraryID,
					libraryVersion: Number.isSafeInteger(library.libraryVersion) ? library.libraryVersion : 0,
					storageVersion: Number.isSafeInteger(library.storageVersion) ? library.storageVersion : 0,
				})).sort((left, right) => left.libraryId - right.libraryId);
			return {
				enabled: Boolean(Zotero.Sync.Runner.enabled),
				inProgress: Boolean(Zotero.Sync.Runner.syncInProgress),
				...(lastSync instanceof Date && Number.isFinite(lastSync.getTime()) && { lastSyncAt: lastSync.getTime() }),
				libraries,
				offline: Boolean(isOffline()),
				status: typeof Zotero.Sync.Runner.lastSyncStatus === "string" ? Zotero.Sync.Runner.lastSyncStatus : "",
			};
		},

		async retrySync(params) {
			exactObject(params, SYNC_RETRY_FIELDS, "sync.retry params");
			if (!Array.isArray(params.libraryIds) || params.libraryIds.length < 1 || params.libraryIds.length > MAX_PAGE_SIZE
					|| params.libraryIds.some(value => !Number.isSafeInteger(value) || value < 1)) {
				throw new Error("sync.retry libraryIds must be a non-empty bounded array of positive integers");
			}
			if (isOffline()) unavailable("Zotero sync is unavailable while offline");
			if (!Zotero.Sync.Runner.enabled) unavailable("Zotero sync is not configured");
			if (Zotero.Sync.Runner.syncInProgress) unavailable("Zotero sync is already in progress");
			let libraryIds = [...new Set(params.libraryIds)].sort((left, right) => left - right);
			let syncable = new Set(Zotero.Libraries.getAll()
				.filter(library => library.libraryType !== "feed" && library.syncable)
				.map(library => library.libraryID));
			if (libraryIds.some(value => !syncable.has(value))) throw new Error("sync.retry library is not syncable");
			let completed = await Zotero.Sync.Runner.sync({ background: true, libraries: libraryIds });
			return { completed: completed !== false, libraryIds };
		},
		async annotations(params) {
			validateCompositeParams(params, ANNOTATION_FIELDS, "attachmentKey", "library.annotations");
			let attachment = lookupItem(Zotero, params.libraryId, params.attachmentKey, "Zotero attachment");
			if (!attachment.isFileAttachment?.()) throw new Error("library.annotations target must be a file attachment");
			let annotations = attachment.getAnnotations(false)
				.map(value => annotationSummary(value, attachment))
				.sort((left, right) => compareText(left.sortIndex, right.sortIndex)
					|| compareText(left.annotationKey, right.annotationKey));
			return { annotations };
		},

		async updateAnnotations(params) {
			validateAnnotationUpdates(params);
			let attachment = lookupItem(Zotero, params.libraryId, params.attachmentKey, "Zotero attachment");
			if (!attachment.isFileAttachment?.()) throw new Error("library.annotations-update target must be a file attachment");
			let byKey = new Map(attachment.getAnnotations(false).map(id => {
				let annotation = Number.isSafeInteger(id) ? Zotero.Items.get(id) : id;
				return [annotation?.key, annotation];
			}));
			let prepared = params.updates.map(update => {
				let annotation = byKey.get(update.annotationKey);
				if (!annotation?.isAnnotation?.() || annotation.libraryID !== attachment.libraryID || annotation.parentItemID !== attachment.id) {
					unavailable(`Zotero annotation ${params.libraryId}/${update.annotationKey} was not found`);
				}
				revisionConflict(annotation, update.expectedVersion, `Zotero annotation ${update.annotationKey}`);
				return { annotation, update };
			});
			await Zotero.DB.executeTransaction(async () => {
				for (let { annotation, update } of prepared) {
					if (update.color !== undefined) annotation.annotationColor = update.color;
					if (update.comment !== undefined) annotation.annotationComment = update.comment;
					if (update.text !== undefined) annotation.annotationText = update.text;
					await annotation.save({ tx: false });
				}
			});
			return { annotations: prepared.map(({ annotation }) => ({
				annotationKey: annotation.key,
				libraryId: annotation.libraryID,
				synced: Boolean(annotation.synced),
				version: Number.isSafeInteger(annotation.version) ? annotation.version : 0,
			})) };
		},

		async attachment(params) {
			validateCompositeParams(params, ATTACHMENT_FIELDS, "attachmentKey", "library.attachment");
			let attachment = lookupItem(Zotero, params.libraryId, params.attachmentKey, "Zotero attachment");
			if (!attachment.isAttachment?.() || !attachment.isFileAttachment?.()) {
				throw new Error("library.attachment target must be a file attachment");
			}
			let parent = Zotero.Items.get(attachment.parentItemID);
			if (itemIsUnavailable(parent)) unavailable("Zotero attachment parent item is unavailable");
			if (!parent || parent.libraryID !== attachment.libraryID || !parent.isRegularItem?.()) {
				throw new Error("Zotero attachment has no valid parent item");
			}
			let summary = await attachmentSummary(Zotero, attachment, parent);
			if (!summary) throw new Error("library.attachment target must be an available file attachment");
			return summary;
		},

		async attachmentState(params) {
			validateCompositeParams(params, ATTACHMENT_STATE_FIELDS, "attachmentKey", "library.attachment-state");
			let attachment = lookupItem(Zotero, params.libraryId, params.attachmentKey, "Zotero attachment");
			if (!attachment.isAttachment?.() || !attachment.isFileAttachment?.()) {
				throw new Error("library.attachment-state target must be a file attachment");
			}
			return attachmentStateSummary(Zotero, attachment);
		},

		async attachmentSource(params) {
			validateCompositeParams(params, ATTACHMENT_FIELDS, "attachmentKey", "attachment.open");
			let attachment = lookupItem(Zotero, params.libraryId, params.attachmentKey, "Zotero attachment");
			if (!attachment.isAttachment?.() || !attachment.isFileAttachment?.()) {
				throw new Error("attachment.open target must be a file attachment");
			}
			let path = await attachment.getFilePathAsync();
			if (typeof path !== "string" || !path) unavailable("Zotero attachment file is unavailable");
			return openAttachmentFile(path);
		},

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

		async itemChildren(params) {
			validateCompositeParams(params, ITEM_CHILDREN_FIELDS, "itemKey", "library.item-children");
			let item = lookupItem(Zotero, params.libraryId, params.itemKey, "Zotero item");
			if (!item.isRegularItem?.()) throw new Error("library.item-children target must be a regular item");
			let attachments = (await Promise.all(Zotero.Items.get(item.getAttachments(false))
				.map(attachment => attachmentSummary(Zotero, attachment, item))))
				.filter(Boolean)
				.sort((left, right) => compareText(left.title, right.title)
					|| compareText(left.attachmentKey, right.attachmentKey));
			let notes = Zotero.Items.get(item.getNotes(false))
				.map(note => noteSummary(Zotero, note, item))
				.filter(Boolean)
				.sort((left, right) => compareText(left.title, right.title)
					|| compareText(left.noteKey, right.noteKey));
			return { attachments, notes };
		},

		async itemMetadata(params) {
			validateCompositeParams(params, ITEM_METADATA_FIELDS, "itemKey", "library.item-metadata");
			let item = lookupItem(Zotero, params.libraryId, params.itemKey, "Zotero item");
			if (!item.isRegularItem?.()) throw new Error("library.item-metadata target must be a regular item");
			return itemMetadataSummary(Zotero, item);
		},

		async itemFacts(params) {
			validateCompositeParams(params, ITEM_FACTS_FIELDS, "itemKey", "library.item-facts");
			let item = lookupItem(Zotero, params.libraryId, params.itemKey, "Zotero item");
			if (!item.isRegularItem?.()) throw new Error("library.item-facts target must be a regular item");
			return itemFactsSummary(Zotero, item);
		},

		async updateItem(params) {
			validateItemUpdate(params);
			let item = lookupItem(Zotero, params.libraryId, params.itemKey, "Zotero item");
			if (!item.isRegularItem?.()) throw new Error("library.item-update target must be a regular item");
			if (item.version !== params.expectedVersion) {
				let error = new Error("Zotero item version changed before update");
				error.code = "REVISION_CONFLICT";
				error.actualRevision = Number.isSafeInteger(item.version) ? item.version : 0;
				error.expectedRevision = params.expectedVersion;
				throw error;
			}
			try {
				for (let field of params.fields) item.setField(field.field, field.value);
				if (params.creators !== undefined) item.setCreators(params.creators, { strict: true });
				if (params.tags !== undefined) item.setTags(params.tags.map(tag => ({ tag: tag.name, type: tag.type })));
				if (params.relations !== undefined) item.setRelations(relationObject(params.relations));
				await item.saveTx();
			}
			catch (error) {
				try { await item.reload?.(null, true); }
				catch (_) {}
				throw error;
			}
			return {
				itemKey: item.key,
				libraryId: item.libraryID,
				synced: Boolean(item.synced),
				version: Number.isSafeInteger(item.version) ? item.version : 0,
			};
		},

		async note(params) {
			validateCompositeParams(params, NOTE_FIELDS, "noteKey", "library.note");
			let note = lookupItem(Zotero, params.libraryId, params.noteKey, "Zotero note");
			if (!note.isNote?.()) throw new Error("library.note target must be a Note");
			let summary = {
				libraryId: note.libraryID,
				noteKey: note.key,
				parentItemKey: parentKey(Zotero, note, "Zotero note"),
				title: note.getDisplayTitle?.() || "Untitled note",
			};
			return {
				...summary,
				html: boundedString(note.getNote(), MAX_NOTE_BYTES, "Zotero Note HTML"),
			};
		},

		async updateNote(params) {
			validateCompositeParams(params, UPDATE_NOTE_FIELDS, "noteKey", "library.note-update");
			if (!Number.isSafeInteger(params.expectedVersion) || params.expectedVersion < 0) {
				throw new Error("library.note-update expectedVersion must be a non-negative safe integer");
			}
			let html = boundedString(params.html, MAX_NOTE_BYTES, "Zotero Note HTML");
			let note = lookupItem(Zotero, params.libraryId, params.noteKey, "Zotero note");
			if (!note.isNote?.()) throw new Error("library.note-update target must be a Note");
			revisionConflict(note, params.expectedVersion, "Zotero Note");
			try {
				note.setNote(html);
				await note.saveTx();
			}
			catch (error) {
				try { await note.reload?.(null, true); }
				catch (_) {}
				throw error;
			}
			return {
				libraryId: note.libraryID,
				noteKey: note.key,
				synced: Boolean(note.synced),
				version: Number.isSafeInteger(note.version) ? note.version : 0,
			};
		},

		async search(params) {
			validateSearchParams(params);
			let sortBy = params.sortBy || "title";
			let sortDirection = params.sortDirection || "asc";
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
				.sort((left, right) => {
					let comparison = compareItemSummary(left, right, sortBy)
						|| left.libraryId - right.libraryId
						|| compareText(left.itemKey, right.itemKey);
					return sortDirection === "desc" ? -comparison : comparison;
				});
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
