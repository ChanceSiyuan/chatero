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

window.addEventListener("load", () => {
	void (async () => {
		let { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");
		let { startGeckoCoreHost } = ChromeUtils.importESModule(
			"chrome://zotero/content/xpcom/chateroCoreHost.mjs"
		);
		await Zotero.initializationPromise;
		await startGeckoCoreHost({ Zotero, window });
	})().catch(error => {
		dump(`Chatero Core startup failed: ${error?.stack || error}\n`);
		Components.utils.reportError(error);
		Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
	});
}, { once: true });
