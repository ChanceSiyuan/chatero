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
const ITEM_CHILDREN_FIELDS = new Set(["itemKey", "libraryId"]);
const ANNOTATION_FIELDS = new Set(["attachmentKey", "libraryId"]);
const ATTACHMENT_FIELDS = new Set(["attachmentKey", "libraryId"]);
const NOTE_FIELDS = new Set(["libraryId", "noteKey"]);
const MAX_PAGE_SIZE = 200;
const MAX_NOTE_BYTES = 512 * 1024;
const MAX_ANNOTATION_FIELD_BYTES = 256 * 1024;

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

function lookupItem(Zotero, libraryId, key, label) {
	let item = Zotero.Items.getByLibraryAndKey(libraryId, key);
	if (!item || item.libraryID !== libraryId || item.key !== key) {
		throw new Error(`${label} ${libraryId}/${key} was not found`);
	}
	return item;
}

function parentKey(Zotero, item, label) {
	let parent = Zotero.Items.get(item.parentItemID);
	if (!parent || parent.libraryID !== item.libraryID || !parent.isRegularItem?.()) {
		throw new Error(`${label} has no valid parent item`);
	}
	return parent.key;
}

async function attachmentSummary(Zotero, attachment, expectedParent) {
	if (!attachment?.isAttachment?.() || !attachment.isFileAttachment?.()
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
		path,
		title,
	};
}

function noteSummary(Zotero, note, expectedParent) {
	if (!note?.isNote?.() || note.libraryID !== expectedParent.libraryID || note.parentItemID !== expectedParent.id) {
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

		async attachment(params) {
			validateCompositeParams(params, ATTACHMENT_FIELDS, "attachmentKey", "library.attachment");
			let attachment = lookupItem(Zotero, params.libraryId, params.attachmentKey, "Zotero attachment");
			if (!attachment.isAttachment?.() || !attachment.isFileAttachment?.()) {
				throw new Error("library.attachment target must be a file attachment");
			}
			let parent = Zotero.Items.get(attachment.parentItemID);
			if (!parent || parent.libraryID !== attachment.libraryID || !parent.isRegularItem?.()) {
				throw new Error("Zotero attachment has no valid parent item");
			}
			let summary = await attachmentSummary(Zotero, attachment, parent);
			if (!summary) throw new Error("library.attachment target must be an available file attachment");
			return summary;
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
