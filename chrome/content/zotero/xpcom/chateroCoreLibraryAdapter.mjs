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
const COLLECTION_MUTATION_FIELDS = new Set(["action", "collectionKey", "expectedVersion", "libraryId", "name", "parentKey"]);
const COLLECTION_MUTATION_ACTIONS = new Set(["create", "update", "delete"]);
const SEARCH_FIELDS = new Set(["collectionKey", "cursor", "libraryId", "limit", "query", "sortBy", "sortDirection"]);
const SEARCH_SORT_FIELDS = new Set(["creators", "itemType", "title", "year"]);
const SEARCH_SORT_DIRECTIONS = new Set(["asc", "desc"]);
const ITEM_CHILDREN_FIELDS = new Set(["itemKey", "libraryId"]);
const ITEM_METADATA_FIELDS = new Set(["itemKey", "libraryId"]);
const ITEM_FACTS_FIELDS = new Set(["itemKey", "libraryId"]);
const UPDATE_ITEM_FIELDS = new Set(["creators", "expectedVersion", "fields", "itemKey", "libraryId", "relations", "tags"]);
const ITEM_MUTATION_FIELDS = new Set(["action", "collectionKeys", "creators", "expectedVersion", "fields", "itemKey", "itemType", "libraryId", "relations", "tags"]);
const ITEM_MUTATION_ACTIONS = new Set(["create", "collections", "trash", "restore"]);
const ANNOTATION_FIELDS = new Set(["attachmentKey", "libraryId"]);
const UPDATE_ANNOTATIONS_FIELDS = new Set(["attachmentKey", "libraryId", "updates"]);
const ATTACHMENT_FIELDS = new Set(["attachmentKey", "libraryId"]);
const ATTACHMENT_STATE_FIELDS = new Set(["attachmentKey", "libraryId"]);
const ATTACHMENT_UPLOAD_COMMIT_FIELDS = new Set(["collectionKeys", "libraryId", "parentItemKey", "title"]);
const ATTACHMENT_MUTATION_FIELDS = new Set(["action", "attachmentKey", "expectedVersion", "libraryId"]);
const NOTE_FIELDS = new Set(["libraryId", "noteKey"]);
const UPDATE_NOTE_FIELDS = new Set(["expectedVersion", "html", "libraryId", "noteKey"]);
const NOTE_MUTATION_FIELDS = new Set(["action", "expectedVersion", "html", "libraryId", "noteKey", "parentItemKey"]);
const NOTE_MUTATION_ACTIONS = new Set(["create", "trash", "restore"]);
const LIBRARIES_FIELDS = new Set();
const FEEDS_FIELDS = new Set();
const SYNC_STATUS_FIELDS = new Set();
const SYNC_RETRY_FIELDS = new Set(["libraryIds"]);
const SYNC_LIBRARY_FIELDS = new Set(["libraryId"]);
const TRANSLATOR_FIELDS = new Set(["kind"]);
const TRANSLATOR_KINDS = new Set(["export", "import", "search", "web"]);
const CITATION_STYLES_FIELDS = new Set();
const CITATION_RENDER_FIELDS = new Set(["identities", "locale", "mode", "styleId"]);
const CITATION_MODES = new Set(["bibliography", "citation"]);
const EXPORT_ITEMS_FIELDS = new Set(["identities", "translatorId"]);
const IMPORT_ITEMS_FIELDS = new Set(["content", "libraryId", "translatorId"]);
const LOOKUP_FIELDS = new Set(["text"]);
const SAVED_SEARCH_FIELDS = new Set(["libraryId"]);
const SAVED_SEARCH_MUTATION_FIELDS = new Set(["action", "conditions", "expectedVersion", "libraryId", "name", "searchKey"]);
const SAVED_SEARCH_ACTIONS = new Set(["create", "update", "trash", "restore"]);
const SAVED_SEARCH_ITEMS_FIELDS = new Set(["cursor", "libraryId", "limit", "searchKey"]);
const TAG_FIELDS = new Set(["cursor", "libraryId", "limit", "query"]);
const DUPLICATE_FIELDS = new Set(["cursor", "libraryId", "limit"]);
const FULLTEXT_SEARCH_FIELDS = new Set(["cursor", "libraryId", "limit", "query"]);
const FULLTEXT_INDEX_FIELDS = new Set(["attachments", "complete"]);
const MAX_PAGE_SIZE = 200;
const MAX_NOTE_BYTES = 512 * 1024;
const MAX_ANNOTATION_FIELD_BYTES = 256 * 1024;
const MAX_METADATA_FIELD_BYTES = 256 * 1024;
const MAX_RELATIONS = 1024;
const MAX_RELATION_FIELD_BYTES = 16 * 1024;
const MAX_MUTATION_ENTRIES = 1024;
const MAX_CITATION_ITEMS = 200;
const MAX_CITATION_OUTPUT_BYTES = 384 * 1024;
const MAX_EXPORT_OUTPUT_BYTES = 768 * 1024;
const MAX_IMPORT_INPUT_BYTES = 768 * 1024;
const MAX_LOOKUP_TEXT_BYTES = 16 * 1024;

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

function optionalBoundedString(value, maxBytes, label) {
	return typeof value === "string" ? boundedString(value, maxBytes, label) : "";
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

function validateSavedSearchMutation(params) {
	exactObject(params, SAVED_SEARCH_MUTATION_FIELDS, "library.saved-search-mutate params");
	positiveLibraryId(params.libraryId, "library.saved-search-mutate");
	if (!SAVED_SEARCH_ACTIONS.has(params.action)) throw new Error("library.saved-search-mutate action is invalid");
	if (params.searchKey !== undefined) zoteroKey(params.searchKey, "library.saved-search-mutate searchKey");
	if (params.expectedVersion !== undefined && (!Number.isSafeInteger(params.expectedVersion) || params.expectedVersion < 0)) throw new Error("saved search expectedVersion is invalid");
	if (params.name !== undefined && !boundedString(params.name, 16 * 1024, "saved search name").trim()) throw new Error("saved search name must not be empty");
	if (params.conditions !== undefined) {
		if (!Array.isArray(params.conditions) || params.conditions.length < 1 || params.conditions.length > MAX_MUTATION_ENTRIES) throw new Error("saved search conditions must be a non-empty bounded array");
		for (let condition of params.conditions) {
			exactObject(condition, new Set(["condition", "operator", "value"]), "saved search condition");
			if (typeof condition.condition !== "string" || !/^[A-Za-z][A-Za-z0-9/]*$/.test(condition.condition)) throw new Error("saved search condition is invalid");
			boundedString(condition.operator, 256, "saved search operator");
			boundedString(condition.value, MAX_RELATION_FIELD_BYTES, "saved search value");
		}
	}
	if (params.action === "create") {
		if (params.searchKey !== undefined || params.expectedVersion !== undefined || params.name === undefined || params.conditions === undefined) throw new Error("saved search create requires name and conditions only");
	}
	else {
		if (params.searchKey === undefined || params.expectedVersion === undefined) throw new Error("saved search existing action requires identity and version");
		if (params.action === "update" && params.name === undefined && params.conditions === undefined) throw new Error("saved search update requires changes");
		if ((params.action === "trash" || params.action === "restore") && (params.name !== undefined || params.conditions !== undefined)) throw new Error("saved search trash and restore do not accept changes");
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
		synced: Boolean(collection.synced),
		version: Number.isSafeInteger(collection.clientVersion) ? collection.clientVersion : 0,
	};
	if (collection.parentKey) summary.parentKey = collection.parentKey;
	return summary;
}

function validateCollectionMutation(params) {
	exactObject(params, COLLECTION_MUTATION_FIELDS, "library.collection-mutate params");
	positiveLibraryId(params.libraryId, "library.collection-mutate");
	if (!COLLECTION_MUTATION_ACTIONS.has(params.action)) throw new Error("library.collection-mutate action is invalid");
	if (params.collectionKey !== undefined) zoteroKey(params.collectionKey, "library.collection-mutate collectionKey");
	if (params.expectedVersion !== undefined && (!Number.isSafeInteger(params.expectedVersion) || params.expectedVersion < 0)) {
		throw new Error("library.collection-mutate expectedVersion must be a non-negative safe integer");
	}
	if (params.name !== undefined && !boundedString(params.name, 16 * 1024, "collection name").trim()) {
		throw new Error("library.collection-mutate name must not be empty");
	}
	if (params.parentKey !== undefined && params.parentKey !== "") zoteroKey(params.parentKey, "library.collection-mutate parentKey");
	if (params.action === "create") {
		if (params.collectionKey !== undefined || params.expectedVersion !== undefined || params.name === undefined) {
			throw new Error("library.collection-mutate create requires only a new collection name");
		}
	}
	else {
		if (params.collectionKey === undefined || params.expectedVersion === undefined) {
			throw new Error("library.collection-mutate update and delete require collectionKey and expectedVersion");
		}
		if (params.action === "update" && params.name === undefined && params.parentKey === undefined) {
			throw new Error("library.collection-mutate update requires a name or parentKey change");
		}
		if (params.action === "delete" && (params.name !== undefined || params.parentKey !== undefined)) {
			throw new Error("library.collection-mutate delete does not accept changes");
		}
	}
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
		// Match Zotero's Local API concurrency contract: "version" is the
		// object clientVersion, which advances for every committed local edit.
		version: Number.isSafeInteger(item.clientVersion) && item.clientVersion >= 0 ? item.clientVersion : 0,
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

function validateCollectionKeys(Zotero, libraryId, values, label) {
	if (!Array.isArray(values) || values.length > MAX_MUTATION_ENTRIES) throw new Error(`${label} must be a bounded array`);
	let seen = new Set();
	return values.map(key => {
		zoteroKey(key, label);
		if (seen.has(key)) throw new Error(`${label} must be unique`);
		seen.add(key);
		let collection = Zotero.Collections.getByLibraryAndKey(libraryId, key);
		if (!collection || collection.deleted) unavailable(`${label} contains an unavailable collection`);
		return collection;
	});
}

function validateItemMutation(Zotero, params) {
	exactObject(params, ITEM_MUTATION_FIELDS, "library.item-mutate params");
	positiveLibraryId(params.libraryId, "library.item-mutate");
	if (!ITEM_MUTATION_ACTIONS.has(params.action)) throw new Error("library.item-mutate action is invalid");
	if (params.action === "create") {
		if (params.itemKey !== undefined || params.expectedVersion !== undefined || typeof params.itemType !== "string" || !Zotero.ItemTypes.getID(params.itemType)) {
			throw new Error("library.item-mutate create requires a valid itemType and no existing identity");
		}
		validateItemUpdate({
			creators: params.creators, expectedVersion: 0, fields: params.fields,
			itemKey: "VALID001", libraryId: params.libraryId, relations: params.relations, tags: params.tags,
		});
		validateCollectionKeys(Zotero, params.libraryId, params.collectionKeys || [], "library.item-mutate collectionKeys");
		return;
	}
	if (params.itemType !== undefined || params.fields !== undefined || params.creators !== undefined || params.tags !== undefined || params.relations !== undefined) {
		throw new Error("library.item-mutate existing-item actions do not accept metadata");
	}
	zoteroKey(params.itemKey, "library.item-mutate itemKey");
	if (!Number.isSafeInteger(params.expectedVersion) || params.expectedVersion < 0) throw new Error("library.item-mutate expectedVersion is invalid");
	if (params.action === "collections") validateCollectionKeys(Zotero, params.libraryId, params.collectionKeys, "library.item-mutate collectionKeys");
	else if (params.collectionKeys !== undefined) throw new Error("library.item-mutate trash and restore do not accept collectionKeys");
}

function relationObject(relations) {
	let result = {};
	for (let relation of relations) (result[relation.predicate] ||= []).push(relation.object);
	return result;
}

function revisionConflict(item, expectedVersion, label) {
	if (item.clientVersion === expectedVersion) return;
	let error = new Error(`${label} version changed before update`);
	error.code = "REVISION_CONFLICT";
	error.actualRevision = Number.isSafeInteger(item.clientVersion) ? item.clientVersion : 0;
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

function validateNoteMutation(params) {
	exactObject(params, NOTE_MUTATION_FIELDS, "library.note-mutate params");
	positiveLibraryId(params.libraryId, "library.note-mutate");
	if (!NOTE_MUTATION_ACTIONS.has(params.action)) throw new Error("library.note-mutate action is invalid");
	if (params.action === "create") {
		if (params.noteKey !== undefined || params.expectedVersion !== undefined) throw new Error("library.note-mutate create does not accept an existing identity");
		boundedString(params.html, MAX_NOTE_BYTES, "library.note-mutate html");
		if (params.parentItemKey !== undefined) zoteroKey(params.parentItemKey, "library.note-mutate parentItemKey");
	}
	else {
		zoteroKey(params.noteKey, "library.note-mutate noteKey");
		if (!Number.isSafeInteger(params.expectedVersion) || params.expectedVersion < 0) throw new Error("library.note-mutate expectedVersion is invalid");
		if (params.html !== undefined || params.parentItemKey !== undefined) throw new Error("library.note-mutate trash and restore do not accept Note content");
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
		version: Number.isSafeInteger(note.clientVersion) ? note.clientVersion : 0,
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
		version: Number.isSafeInteger(annotation.clientVersion) ? annotation.clientVersion : 0,
	};
}

function validateZotero(Zotero) {
	if (typeof Zotero?.Duplicates !== "function") throw new Error("initialized Zotero API is missing Duplicates");
	let required = [
		[Zotero?.Collections, "get"],
		[Zotero?.Collections, "getByLibrary"],
		[Zotero?.Collections, "getByLibraryAndKey"],
		[Zotero?.Items, "getAll"],
		[Zotero?.Items, "get"],
		[Zotero?.Items, "getByLibraryAndKey"],
		[Zotero?.ItemTypes, "getName"],
		[Zotero?.Libraries, "getAll"],
		[Zotero?.Libraries, "get"],
		[Zotero?.Searches, "getAll"],
		[Zotero?.Searches, "getByLibraryAndKey"],
		[Zotero?.Tags, "getAll"],
		[Zotero?.Feeds, "getAll"],
		[Zotero?.Fulltext || Zotero?.FullText, "getIndexedState"],
		[Zotero?.Fulltext || Zotero?.FullText, "getItemVersion"],
		[Zotero?.Fulltext || Zotero?.FullText, "getPages"],
		[Zotero?.Fulltext || Zotero?.FullText, "findTextInItems"],
		[Zotero?.Fulltext || Zotero?.FullText, "indexItems"],
		[Zotero?.Retractions, "isRetracted"],
		[Zotero?.Retractions, "shouldShowCitationWarning"],
		[Zotero?.Translators, "getAllForType"],
		[Zotero?.Translators, "get"],
		[Zotero?.Styles, "get"],
		[Zotero?.Styles, "getVisible"],
		[Zotero?.QuickCopy, "getContentFromItems"],
		[Zotero?.Utilities, "extractIdentifiers"],
		[Zotero?.Attachments, "importFromNetworkStream"],
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
		async translators(params) {
			exactObject(params, TRANSLATOR_FIELDS, "translation.translators params");
			if (!TRANSLATOR_KINDS.has(params.kind)) {
				throw new Error(`translation.translators kind must be one of ${[...TRANSLATOR_KINDS].join(", ")}`);
			}
			let translators = (await Zotero.Translators.getAllForType(params.kind)).map(translator => ({
				browserSupport: optionalBoundedString(translator.browserSupport, 256, "translator browserSupport"),
				creator: optionalBoundedString(translator.creator, 16 * 1024, "translator creator"),
				kind: params.kind,
				label: boundedString(translator.label, 16 * 1024, "translator label"),
				lastUpdated: optionalBoundedString(translator.lastUpdated, 256, "translator lastUpdated"),
				priority: Number.isSafeInteger(translator.priority) ? translator.priority : 100,
				target: optionalBoundedString(translator.target, 16 * 1024, "translator target"),
				translatorId: boundedString(translator.translatorID, 256, "translator id"),
			})).sort((left, right) => compareText(left.label, right.label) || compareText(left.translatorId, right.translatorId));
			return { translators };
		},

		async citationStyles(params) {
			exactObject(params, CITATION_STYLES_FIELDS, "citation.styles params");
			let styles = Zotero.Styles.getVisible().map(style => ({
				citationFormat: optionalBoundedString(style.citationFormat, 256, "CSL citation format"),
				styleId: boundedString(style.styleID, 16 * 1024, "CSL style id"),
				title: boundedString(style.title, 16 * 1024, "CSL style title"),
			})).sort((left, right) => compareText(left.title, right.title) || compareText(left.styleId, right.styleId));
			return { styles };
		},

		async renderCitation(params) {
			exactObject(params, CITATION_RENDER_FIELDS, "citation.render params");
			let styleId = boundedString(params.styleId, 16 * 1024, "citation.render styleId");
			if (!CITATION_MODES.has(params.mode)) throw new Error("citation.render mode must be bibliography or citation");
			if (params.locale !== undefined && (typeof params.locale !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(params.locale))) {
				throw new Error("citation.render locale is invalid");
			}
			if (!Array.isArray(params.identities) || params.identities.length < 1 || params.identities.length > MAX_CITATION_ITEMS) {
				throw new Error("citation.render identities must be a non-empty bounded array");
			}
			let seen = new Set();
			let items = params.identities.map(identity => {
				validateCompositeParams(identity, ITEM_METADATA_FIELDS, "itemKey", "citation.render identity");
				let composite = `${identity.libraryId}/${identity.itemKey}`;
				if (seen.has(composite)) throw new Error("citation.render identities must be unique");
				seen.add(composite);
				let item = lookupItem(Zotero, identity.libraryId, identity.itemKey, "Zotero citation item");
				if (!item.isRegularItem?.()) throw new Error("citation.render target must be a regular item");
				return item;
			});
			if (!Zotero.Styles.get(styleId)) unavailable("citation.render style is not installed");
			let rendered = Zotero.QuickCopy.getContentFromItems(items, {
				contentType: "",
				id: styleId,
				locale: params.locale || "",
				mode: "bibliography",
			}, null, params.mode === "citation");
			if (!rendered || typeof rendered.text !== "string" || typeof rendered.html !== "string") {
				throw new Error("Zotero Quick Copy did not produce citation content");
			}
			return {
				html: boundedString(rendered.html, MAX_CITATION_OUTPUT_BYTES, "citation HTML"),
				text: boundedString(rendered.text, MAX_CITATION_OUTPUT_BYTES, "citation text"),
			};
		},

		async exportItems(params) {
			exactObject(params, EXPORT_ITEMS_FIELDS, "translation.export params");
			let translatorId = boundedString(params.translatorId, 256, "translation.export translatorId");
			if (!Array.isArray(params.identities) || params.identities.length < 1 || params.identities.length > MAX_CITATION_ITEMS) {
				throw new Error("translation.export identities must be a non-empty bounded array");
			}
			let translator = Zotero.Translators.get(translatorId);
			let exportType = Zotero.Translator?.TRANSLATOR_TYPES?.export || 2;
			if (!translator || !(translator.translatorType & exportType)) unavailable("translation.export requires an installed export translator");
			let seen = new Set();
			let items = params.identities.map(identity => {
				validateCompositeParams(identity, ITEM_METADATA_FIELDS, "itemKey", "translation.export identity");
				let composite = `${identity.libraryId}/${identity.itemKey}`;
				if (seen.has(composite)) throw new Error("translation.export identities must be unique");
				seen.add(composite);
				let item = lookupItem(Zotero, identity.libraryId, identity.itemKey, "Zotero export item");
				if (!item.isRegularItem?.() && !item.isNote?.()) throw new Error("translation.export target must be a regular item or Note");
				return item;
			});
			let translation = new Zotero.Translate.Export();
			translation.setItems(items.slice());
			translation.setTranslator(translator);
			await translation.translate();
			return {
				content: boundedString(translation.string || "", MAX_EXPORT_OUTPUT_BYTES, "translation export content"),
				itemCount: items.length,
				translatorId,
			};
		},

		async importItems(params) {
			exactObject(params, IMPORT_ITEMS_FIELDS, "translation.import params");
			positiveLibraryId(params.libraryId, "translation.import");
			let content = boundedString(params.content, MAX_IMPORT_INPUT_BYTES, "translation.import content");
			if (!content.trim()) throw new Error("translation.import content must not be empty");
			let translatorId = boundedString(params.translatorId, 256, "translation.import translatorId");
			let translator = Zotero.Translators.get(translatorId);
			let importType = Zotero.Translator?.TRANSLATOR_TYPES?.import || 1;
			if (!translator || !(translator.translatorType & importType)) unavailable("translation.import requires an installed import translator");
			let library = Zotero.Libraries.get(params.libraryId);
			if (!library || library.libraryType === "feed" || !library.editable) unavailable("translation.import target library is not editable");
			let translation = new Zotero.Translate.Import();
			translation.setString(content);
			translation.setTranslator(translator);
			let imported = await translation.translate({ libraryID: params.libraryId, saveAttachments: false });
			if (!Array.isArray(imported) || imported.length > MAX_MUTATION_ENTRIES) throw new Error("Zotero import returned an invalid item set");
			let items = imported.filter(item => item?.isRegularItem?.()).map(item => ({
				itemKey: boundedString(item.key, 256, "imported item key"),
				libraryId: item.libraryID,
				title: boundedString(item.getDisplayTitle?.() || "", MAX_METADATA_FIELD_BYTES, "imported item title"),
				version: Number.isSafeInteger(item.clientVersion) ? item.clientVersion : 0,
			}));
			if (items.some(item => item.libraryId !== params.libraryId)) throw new Error("Zotero import crossed the requested library boundary");
			return { items, translatorId };
		},

		async lookupIdentifiers(params) {
			exactObject(params, LOOKUP_FIELDS, "translation.lookup params");
			let text = boundedString(params.text, MAX_LOOKUP_TEXT_BYTES, "translation.lookup text").trim();
			if (!text) throw new Error("translation.lookup text must not be empty");
			let identifiers = Zotero.Utilities.extractIdentifiers(text);
			if (!Array.isArray(identifiers) || identifiers.length < 1 || identifiers.length > MAX_CITATION_ITEMS) unavailable("translation.lookup found no supported identifier");
			let candidates = [];
			let identifierSummaries = [];
			for (let identifier of identifiers) {
				let entries = Object.entries(identifier);
				if (entries.length !== 1) throw new Error("Zotero identifier extraction returned an invalid result");
				let [kind, rawValue] = entries[0];
				let value = boundedString(String(rawValue), 16 * 1024, "lookup identifier");
				identifierSummaries.push({ kind, value });
				let translation = new Zotero.Translate.Search();
				translation.setIdentifier(identifier);
				let translators = await translation.getTranslators();
				if (!Array.isArray(translators) || !translators.length) continue;
				translation.setTranslator(translators);
				let found;
				try { found = await translation.translate({ libraryID: false, saveAttachments: false }); }
				catch (error) {
					if (String(error).includes(translation.ERROR_NO_RESULTS || "No items returned")) continue;
					throw error;
				}
				for (let item of found || []) {
					let creators = (item.creators || item.getCreatorsJSON?.() || []).map(creatorName).filter(Boolean);
					let field = name => item[name] ?? item.getField?.(name) ?? "";
					let candidate = {
						creators,
						date: optionalBoundedString(field("date"), 16 * 1024, "lookup date"),
						itemType: boundedString(item.itemType || Zotero.ItemTypes.getName(item.itemTypeID), 256, "lookup item type"),
						title: boundedString(field("title"), MAX_METADATA_FIELD_BYTES, "lookup title"),
					};
					let doi = optionalBoundedString(field("DOI"), 16 * 1024, "lookup DOI");
					if (doi) candidate.doi = doi;
					candidates.push(candidate);
					if (candidates.length > MAX_CITATION_ITEMS) throw new Error("translation.lookup returned too many candidates");
				}
			}
			if (!candidates.length) unavailable("translation.lookup found no metadata candidates");
			return { candidates, identifiers: identifierSummaries };
		},

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

		async duplicates(params) {
			exactObject(params, DUPLICATE_FIELDS, "library.duplicates params");
			positiveLibraryId(params.libraryId, "library.duplicates");
			if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > MAX_PAGE_SIZE) throw new Error("library.duplicates limit is invalid");
			if (params.cursor !== undefined && (typeof params.cursor !== "string" || !/^\d+$/.test(params.cursor))) throw new Error("library.duplicates cursor is invalid");
			let library = Zotero.Libraries.get(params.libraryId);
			if (!library || library.libraryType === "feed") unavailable("library.duplicates library is unavailable");
			let search = await new Zotero.Duplicates(params.libraryId).getSearchObject();
			let tempTable = Object.values(search.getConditions()).find(value => value.condition === "tempTable")?.value;
			if (typeof tempTable !== "string" || !/^tmpDuplicates_[A-Za-z0-9_]+$/.test(tempTable)) throw new Error("Zotero duplicates temporary table is invalid");
			let ids;
			try { ids = await search.search(); }
			finally { await Zotero.DB.queryAsync(`DROP TABLE IF EXISTS ${tempTable}`, false, { noCache: true }); }
			let matches = Zotero.Items.get(ids).filter(item => item?.libraryID === params.libraryId && item.isRegularItem?.() && !itemIsUnavailable(item))
				.map(item => itemSummary(Zotero, item)).sort((left, right) => compareText(left.title, right.title) || compareText(left.itemKey, right.itemKey));
			let offset = Number(params.cursor || 0);
			if (offset > matches.length) throw new Error("library.duplicates cursor is outside the result set");
			let items = matches.slice(offset, offset + params.limit);
			let nextOffset = offset + items.length;
			return { items, ...(nextOffset < matches.length && { nextCursor: String(nextOffset) }), total: matches.length };
		},

		async fulltextSearch(params) {
			exactObject(params, FULLTEXT_SEARCH_FIELDS, "library.fulltext-search params");
			positiveLibraryId(params.libraryId, "library.fulltext-search");
			let query = boundedString(params.query, 16 * 1024, "library.fulltext-search query").trim();
			if (!query) throw new Error("library.fulltext-search query must not be empty");
			if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > MAX_PAGE_SIZE) throw new Error("library.fulltext-search limit is invalid");
			if (params.cursor !== undefined && (typeof params.cursor !== "string" || !/^\d+$/.test(params.cursor))) throw new Error("library.fulltext-search cursor is invalid");
			let candidates = (await Zotero.Items.getAll(params.libraryId, false, false, false)).filter(item => item?.isAttachment?.() && !itemIsUnavailable(item));
			let found = await (Zotero.Fulltext || Zotero.FullText).findTextInItems(candidates.map(item => item.id), query);
			let matches = found.map(value => Zotero.Items.get(value.id)).filter(item => item?.libraryID === params.libraryId && item.isAttachment?.())
				.map(item => ({
					attachmentKey: item.key,
					libraryId: item.libraryID,
					parentItemKey: parentKey(Zotero, item, "full-text attachment"),
					title: item.getDisplayTitle?.() || item.attachmentFilename || "Untitled attachment",
				})).sort((left, right) => compareText(left.title, right.title) || compareText(left.attachmentKey, right.attachmentKey));
			let offset = Number(params.cursor || 0);
			if (offset > matches.length) throw new Error("library.fulltext-search cursor is outside the result set");
			let page = matches.slice(offset, offset + params.limit);
			let nextOffset = offset + page.length;
			return { matches: page, ...(nextOffset < matches.length && { nextCursor: String(nextOffset) }), total: matches.length };
		},

		async indexFulltext(params) {
			exactObject(params, FULLTEXT_INDEX_FIELDS, "library.fulltext-index params");
			if (!Array.isArray(params.attachments) || params.attachments.length < 1 || params.attachments.length > MAX_PAGE_SIZE) {
				throw new Error("library.fulltext-index attachments must be a non-empty bounded array");
			}
			if (typeof params.complete !== "boolean") throw new Error("library.fulltext-index complete must be boolean");
			let seen = new Set();
			let attachments = params.attachments.map(identity => {
				validateCompositeParams(identity, ATTACHMENT_FIELDS, "attachmentKey", "library.fulltext-index identity");
				let composite = `${identity.libraryId}/${identity.attachmentKey}`;
				if (seen.has(composite)) throw new Error("library.fulltext-index attachments must be unique");
				seen.add(composite);
				let attachment = lookupItem(Zotero, identity.libraryId, identity.attachmentKey, "Zotero attachment");
				if (!attachment.isFileAttachment?.()) throw new Error("library.fulltext-index target must be a file attachment");
				return attachment;
			});
			await (Zotero.Fulltext || Zotero.FullText).indexItems(attachments.map(value => value.id), {
				complete: params.complete,
				ignoreErrors: false,
			});
			return {
				attachments: attachments.map(value => ({ attachmentKey: value.key, libraryId: value.libraryID })),
				complete: params.complete,
			};
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

		async mutateSavedSearch(params) {
			validateSavedSearchMutation(params);
			let library = Zotero.Libraries.get(params.libraryId);
			if (!library || library.libraryType === "feed" || !library.editable) unavailable("saved search target library is not editable");
			let search;
			if (params.action === "create") {
				search = new Zotero.Search();
				search.libraryID = params.libraryId;
			}
			else {
				search = Zotero.Searches.getByLibraryAndKey(params.libraryId, params.searchKey);
				if (!search || search.libraryID !== params.libraryId || search.key !== params.searchKey) unavailable("saved search is unavailable");
				if (params.action !== "restore" && itemIsUnavailable(search)) unavailable("saved search is unavailable");
				if (params.action === "restore" && !search.deleted) throw new Error("saved search restore target is not in trash");
				revisionConflict(search, params.expectedVersion, "Zotero saved search");
			}
			try {
				if (params.action === "create" || params.action === "update") search.fromJSON({
					...(params.conditions !== undefined && { conditions: params.conditions }),
					...(params.name !== undefined && { name: params.name.trim() }),
				}, { strict: true });
				if (params.action === "trash") search.deleted = true;
				if (params.action === "restore") search.deleted = false;
				await search.saveTx();
			}
			catch (error) {
				try { await search.reload?.(null, true); }
				catch (_) {}
				throw error;
			}
			return {
				action: params.action, deleted: Boolean(search.deleted), libraryId: search.libraryID,
				name: search.name, searchKey: search.key, synced: Boolean(search.synced),
				version: Number.isSafeInteger(search.clientVersion) ? search.clientVersion : 0,
			};
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

		async syncStorageStatus(params) {
			exactObject(params, SYNC_LIBRARY_FIELDS, "sync.storage-status params");
			positiveLibraryId(params.libraryId, "sync.storage-status");
			let library = Zotero.Libraries.get(params.libraryId);
			if (!library || library.libraryType === "feed") unavailable("sync.storage-status library is unavailable");
			let storage = Zotero.Sync.Storage.Local;
			let conflicts = await storage.getConflicts(params.libraryId);
			return {
				conflictCount: Array.isArray(conflicts) ? conflicts.length : 0,
				downloadAsNeeded: Boolean(storage.downloadAsNeeded(params.libraryId)),
				enabled: Boolean(storage.getEnabledForLibrary(params.libraryId)),
				libraryId: params.libraryId,
				mode: boundedString(storage.getModeForLibrary(params.libraryId), 256, "storage mode"),
			};
		},

		async syncConflicts(params) {
			exactObject(params, SYNC_LIBRARY_FIELDS, "sync.conflicts params");
			positiveLibraryId(params.libraryId, "sync.conflicts");
			let library = Zotero.Libraries.get(params.libraryId);
			if (!library || library.libraryType === "feed") unavailable("sync.conflicts library is unavailable");
			let conflicts = await Zotero.Sync.Storage.Local.getConflicts(params.libraryId);
			if (!Array.isArray(conflicts) || conflicts.length > MAX_MUTATION_ENTRIES) throw new Error("Zotero storage conflicts are invalid or oversized");
			return { conflicts: conflicts.map(conflict => {
				let leftKey = conflict?.left?.key;
				let rightKey = conflict?.right?.key;
				if (leftKey !== rightKey) throw new Error("Zotero storage conflict identities disagree");
				zoteroKey(leftKey, "sync conflict attachmentKey");
				return {
					attachmentKey: leftKey,
					libraryId: params.libraryId,
					localModifiedAt: optionalBoundedString(conflict.left.dateModified, 256, "local conflict date"),
					remoteModifiedAt: optionalBoundedString(conflict.right.dateModified, 256, "remote conflict date"),
				};
			}) };
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
				version: Number.isSafeInteger(annotation.clientVersion) ? annotation.clientVersion : 0,
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

		async importAttachment(params, upload) {
			exactObject(params, ATTACHMENT_UPLOAD_COMMIT_FIELDS, "attachment.upload-commit operation");
			positiveLibraryId(params.libraryId, "attachment.upload-commit");
			if (!upload || typeof upload !== "object" || !upload.stream || !Number.isSafeInteger(upload.byteCount)) throw new Error("attachment upload stream is invalid");
			let library = Zotero.Libraries.get(params.libraryId);
			if (!library || library.libraryType === "feed" || !library.filesEditable) unavailable("attachment target library files are not editable");
			let parent;
			if (params.parentItemKey !== undefined) {
				zoteroKey(params.parentItemKey, "attachment.upload-commit parentItemKey");
				parent = lookupItem(Zotero, params.libraryId, params.parentItemKey, "Zotero attachment parent");
				if (!parent.isRegularItem?.()) throw new Error("attachment parent must be a regular item");
			}
			let collections = validateCollectionKeys(Zotero, params.libraryId, params.collectionKeys || [], "attachment.upload-commit collectionKeys");
			if (parent && collections.length) throw new Error("attachment upload cannot use parentItemKey and collectionKeys together");
			let title = params.title === undefined ? undefined : boundedString(params.title, MAX_METADATA_FIELD_BYTES, "attachment upload title");
			let attachment = await Zotero.Attachments.importFromNetworkStream({
				byteCount: upload.byteCount,
				contentType: upload.contentType,
				...(collections.length && { collections: collections.map(collection => collection.id) }),
				...(!parent && { libraryID: params.libraryId }),
				...(parent && { parentItemID: parent.id }),
				stream: upload.stream,
				...(title !== undefined && { title }),
				url: `https://chatero.invalid/upload/${encodeURIComponent(upload.filename)}`,
			});
			if (!attachment?.isAttachment?.() || attachment.libraryID !== params.libraryId) throw new Error("Zotero attachment import crossed the requested library boundary");
			return {
				attachmentKey: attachment.key,
				libraryId: attachment.libraryID,
				...(parent && { parentItemKey: parent.key }),
				synced: Boolean(attachment.synced),
				version: Number.isSafeInteger(attachment.clientVersion) ? attachment.clientVersion : 0,
			};
		},

		async mutateAttachment(params) {
			exactObject(params, ATTACHMENT_MUTATION_FIELDS, "library.attachment-mutate params");
			positiveLibraryId(params.libraryId, "library.attachment-mutate");
			zoteroKey(params.attachmentKey, "library.attachment-mutate attachmentKey");
			if (params.action !== "trash" && params.action !== "restore") throw new Error("library.attachment-mutate action is invalid");
			if (!Number.isSafeInteger(params.expectedVersion) || params.expectedVersion < 0) throw new Error("library.attachment-mutate expectedVersion is invalid");
			let library = Zotero.Libraries.get(params.libraryId);
			if (!library || library.libraryType === "feed" || !library.filesEditable) unavailable("attachment target library files are not editable");
			let attachment = Zotero.Items.getByLibraryAndKey(params.libraryId, params.attachmentKey);
			if (!attachment || attachment.libraryID !== params.libraryId || !attachment.isAttachment?.()) unavailable("Zotero attachment is unavailable");
			if (params.action !== "restore" && itemIsUnavailable(attachment)) unavailable("Zotero attachment is unavailable");
			if (params.action === "restore" && !attachment.deleted && !attachment.isInTrash?.()) throw new Error("attachment restore target is not in trash");
			revisionConflict(attachment, params.expectedVersion, "Zotero attachment");
			try { attachment.deleted = params.action === "trash"; await attachment.saveTx(); }
			catch (error) {
				try { await attachment.reload?.(null, true); }
				catch (_) {}
				throw error;
			}
			return {
				action: params.action, attachmentKey: attachment.key, deleted: Boolean(attachment.deleted), libraryId: attachment.libraryID,
				...(attachment.parentItemID && { parentItemKey: parentKey(Zotero, attachment, "Zotero attachment") }),
				synced: Boolean(attachment.synced), version: Number.isSafeInteger(attachment.clientVersion) ? attachment.clientVersion : 0,
			};
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

		async mutateCollection(params) {
			validateCollectionMutation(params);
			let library = Zotero.Libraries.get(params.libraryId);
			if (!library || library.libraryType === "feed" || !library.editable) unavailable("collection target library is not editable");
			let collection;
			if (params.action === "create") {
				collection = new Zotero.Collection({ libraryID: params.libraryId, name: params.name.trim() });
			}
			else {
				collection = Zotero.Collections.getByLibraryAndKey(params.libraryId, params.collectionKey);
				if (!collection || collection.deleted) unavailable(`Zotero collection ${params.libraryId}/${params.collectionKey} is unavailable`);
				revisionConflict(collection, params.expectedVersion, "Zotero collection");
			}
			if (params.parentKey !== undefined && params.parentKey !== "") {
				let parent = Zotero.Collections.getByLibraryAndKey(params.libraryId, params.parentKey);
				if (!parent || parent.deleted) unavailable("collection parent is unavailable");
				if (parent === collection) throw new Error("collection cannot be its own parent");
			}
			try {
				if (params.action === "delete") collection.deleted = true;
				else {
					if (params.name !== undefined) collection.name = params.name.trim();
					if (params.parentKey !== undefined) collection.parentKey = params.parentKey || false;
				}
				await collection.saveTx();
			}
			catch (error) {
				try { await collection.reload?.(null, true); }
				catch (_) {}
				throw error;
			}
			return {
				action: params.action,
				collectionKey: collection.key,
				deleted: Boolean(collection.deleted),
				libraryId: collection.libraryID,
				...(params.action !== "delete" && {
					name: collection.name,
					...(collection.parentKey && { parentKey: collection.parentKey }),
					synced: Boolean(collection.synced),
					version: Number.isSafeInteger(collection.clientVersion) ? collection.clientVersion : 0,
				}),
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
			if (item.clientVersion !== params.expectedVersion) {
				let error = new Error("Zotero item version changed before update");
				error.code = "REVISION_CONFLICT";
				error.actualRevision = Number.isSafeInteger(item.clientVersion) ? item.clientVersion : 0;
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
				version: Number.isSafeInteger(item.clientVersion) ? item.clientVersion : 0,
			};
		},

		async mutateItem(params) {
			validateItemMutation(Zotero, params);
			let library = Zotero.Libraries.get(params.libraryId);
			if (!library || library.libraryType === "feed" || !library.editable) unavailable("item target library is not editable");
			let item;
			if (params.action === "create") {
				item = new Zotero.Item(params.itemType);
				item.libraryID = params.libraryId;
			}
			else {
				item = Zotero.Items.getByLibraryAndKey(params.libraryId, params.itemKey);
				if (!item || item.libraryID !== params.libraryId || item.key !== params.itemKey || !item.isRegularItem?.()) unavailable("Zotero item is unavailable");
				if (params.action !== "restore" && itemIsUnavailable(item)) unavailable("Zotero item is unavailable");
				if (params.action === "restore" && !item.deleted && !item.isInTrash?.()) throw new Error("library.item-mutate restore target is not in trash");
				revisionConflict(item, params.expectedVersion, "Zotero item");
			}
			try {
				if (params.action === "create") {
					for (let field of params.fields) item.setField(field.field, field.value);
					if (params.creators !== undefined) item.setCreators(params.creators, { strict: true });
					if (params.tags !== undefined) item.setTags(params.tags.map(tag => ({ tag: tag.name, type: tag.type })));
					if (params.relations !== undefined) item.setRelations(relationObject(params.relations));
				}
				if (params.action === "create" || params.action === "collections") {
					let collections = validateCollectionKeys(Zotero, params.libraryId, params.collectionKeys || [], "library.item-mutate collectionKeys");
					item.setCollections(collections.map(collection => collection.id));
				}
				if (params.action === "trash") item.deleted = true;
				if (params.action === "restore") item.deleted = false;
				await item.saveTx();
			}
			catch (error) {
				try { await item.reload?.(null, true); }
				catch (_) {}
				throw error;
			}
			let collectionKeys = item.getCollections(false).map(id => Zotero.Collections.get(id))
				.filter(collection => collection?.libraryID === item.libraryID).map(collection => collection.key).sort(compareText);
			return {
				action: params.action, collectionKeys, deleted: Boolean(item.deleted), itemKey: item.key,
				libraryId: item.libraryID, synced: Boolean(item.synced),
				version: Number.isSafeInteger(item.clientVersion) ? item.clientVersion : 0,
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
				version: Number.isSafeInteger(note.clientVersion) ? note.clientVersion : 0,
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
				version: Number.isSafeInteger(note.clientVersion) ? note.clientVersion : 0,
			};
		},

		async mutateNote(params) {
			validateNoteMutation(params);
			let library = Zotero.Libraries.get(params.libraryId);
			if (!library || library.libraryType === "feed" || !library.editable) unavailable("Note target library is not editable");
			let note;
			if (params.action === "create") {
				note = new Zotero.Item("note");
				note.libraryID = params.libraryId;
				if (params.parentItemKey) {
					let parent = lookupItem(Zotero, params.libraryId, params.parentItemKey, "Zotero Note parent");
					if (!parent.isRegularItem?.()) throw new Error("library.note-mutate parent must be a regular item");
					note.parentItemID = parent.id;
				}
				note.setNote(params.html);
			}
			else {
				note = Zotero.Items.getByLibraryAndKey(params.libraryId, params.noteKey);
				if (!note || note.libraryID !== params.libraryId || !note.isNote?.()) unavailable("Zotero Note is unavailable");
				if (params.action !== "restore" && itemIsUnavailable(note)) unavailable("Zotero Note is unavailable");
				if (params.action === "restore" && !note.deleted && !note.isInTrash?.()) throw new Error("library.note-mutate restore target is not in trash");
				revisionConflict(note, params.expectedVersion, "Zotero Note");
				note.deleted = params.action === "trash";
			}
			try { await note.saveTx(); }
			catch (error) {
				try { await note.reload?.(null, true); }
				catch (_) {}
				throw error;
			}
			let result = {
				action: params.action, deleted: Boolean(note.deleted), libraryId: note.libraryID, noteKey: note.key,
				synced: Boolean(note.synced), version: Number.isSafeInteger(note.clientVersion) ? note.clientVersion : 0,
			};
			if (note.parentItemID) result.parentItemKey = parentKey(Zotero, note, "Zotero Note");
			return result;
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
