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

function emptyObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) {
		throw new Error(`${label} params must be an empty object`);
	}
}

export function createZoteroProfileAdapter({ Zotero, profileEpoch, profileName, now = Date.now } = {}) {
	if (!Zotero?.DB || !Zotero?.Schema || typeof Zotero.version !== "string") {
		throw new Error("Zotero Profile adapter requires initialized Zotero DB and Schema APIs");
	}
	if (typeof profileEpoch !== "string" || !profileEpoch) throw new Error("Zotero Profile adapter profileEpoch is required");
	if (typeof profileName !== "string" || !profileName) throw new Error("Zotero Profile adapter profileName is required");

	return Object.freeze({
		async backup() {
			let backupCreated = await Zotero.DB.backUpDatabase({ force: true, online: true, suffix: "chatero-core" });
			return { backupCreated: Boolean(backupCreated), completedAt: now() };
		},
		async migrate() {
			let migrated = await Zotero.Schema.updateSchema();
			let [schemaVersion, compatibilityVersion] = await Promise.all([
				Zotero.Schema.getDBVersion("userdata"),
				Zotero.Schema.getDBVersion("compatibility"),
			]);
			if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1
					|| !Number.isSafeInteger(compatibilityVersion) || compatibilityVersion < 1) {
				throw new Error("Zotero Profile migration returned invalid schema versions");
			}
			return { compatibilityVersion, migrated: Boolean(migrated), schemaVersion };
		},
		async status(params) {
			emptyObject(params, "profile.status");
			let [schemaVersion, compatibilityVersion, integrityCheckRequired, quickCheckPassed] = await Promise.all([
				Zotero.Schema.getDBVersion("userdata"),
				Zotero.Schema.getDBVersion("compatibility"),
				Zotero.Schema.integrityCheckRequired(),
				Zotero.DB.quickCheck(),
			]);
			if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1
					|| !Number.isSafeInteger(compatibilityVersion) || compatibilityVersion < 1) {
				throw new Error("Zotero Profile adapter received invalid schema versions");
			}
			return {
				compatibilityVersion,
				integrityCheckRequired: Boolean(integrityCheckRequired),
				profileEpoch,
				profileName,
				quickCheckPassed: Boolean(quickCheckPassed),
				readOnly: false,
				schemaVersion,
				upstreamVersion: Zotero.version,
			};
		},
	});
}
