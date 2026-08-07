/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

Zotero.QLab = Zotero.QLab || {};

(function () {
	const SHELL_KINDS = new Set(['qlabchat', 'qlabqmd', 'qlabsite']);
	
	/**
	 * Build idempotent arrangement requests for PDF | Chat and PDF | Editor.
	 * Pure: does not touch the DOM or Zotero_Tabs.
	 */
	Zotero.QLab.buildPDFChatArrangement = function ({ itemID, title } = {}) {
		if (!Number.isFinite(itemID)) {
			throw new Error('PDF | Chat requires a numeric attachment itemID');
		}
		return {
			left: {
				kind: 'reader',
				id: `reader:${itemID}`,
				title: title || 'PDF',
				payload: { itemID },
			},
			right: {
				kind: 'qlabchat',
				title: 'Chat',
				payload: { primaryItemID: itemID },
			},
		};
	};
	
	Zotero.QLab.buildPDFEditorArrangement = function ({ itemID, title } = {}) {
		if (!Number.isFinite(itemID)) {
			throw new Error('PDF | Editor requires a numeric attachment itemID');
		}
		return {
			left: {
				kind: 'reader',
				id: `reader:${itemID}`,
				title: title || 'PDF',
				payload: { itemID },
			},
			right: {
				kind: 'qlabqmd',
				title: 'QMD Editor',
				payload: { primaryItemID: itemID },
			},
		};
	};
	
	/**
	 * Research desk: PDF (evidence) | QMD (authority) | Chat (assistant).
	 */
	Zotero.QLab.buildResearchDeskArrangement = function ({ itemID, title, draftPath } = {}) {
		if (!Number.isFinite(itemID)) {
			throw new Error('Research desk requires a numeric attachment itemID');
		}
		let payload = { primaryItemID: itemID };
		return {
			left: {
				kind: 'reader',
				id: `reader:${itemID}`,
				title: title || 'PDF',
				payload: { itemID },
			},
			center: {
				kind: 'qlabqmd',
				title: 'QMD Editor',
				payload: draftPath ? { ...payload, draftPath } : payload,
			},
			right: {
				kind: 'qlabchat',
				title: 'Chat',
				payload,
			},
		};
	};
	
	/**
	 * Normalize an arrangement into an ordered left-to-right pane spec list.
	 */
	Zotero.QLab.arrangementPanes = function (arrangement) {
		if (!arrangement) {
			return [];
		}
		if (Array.isArray(arrangement.panes)) {
			return arrangement.panes.filter(Boolean);
		}
		return ['left', 'center', 'right']
			.map(role => arrangement[role])
			.filter(Boolean);
	};
	
	/**
	 * Apply an arrangement to a TabGroups model and optionally to a window tabs API.
	 *
	 * @param {Zotero.QLab.TabGroups} groups
	 * @param {{ left: object, right: object }} arrangement
	 * @param {{
	 *   ensureReader?: (itemID: number) => Promise<string|null>|string|null,
	 *   ensureShellTab?: (kind: string, payload?: object) => Promise<string|null>|string|null,
	 *   select?: (tabID: string) => void,
	 * }} [bridge]
	 */
	Zotero.QLab.applyArrangement = async function (groups, arrangement, bridge = {}) {
		let specs = Zotero.QLab.arrangementPanes(arrangement).map(spec => ({ ...spec }));
		if (!specs.length) {
			return groups.snapshot();
		}
		groups.arrange(...specs);
		
		let remapped = false;
		if (bridge.ensureReader) {
			for (let spec of specs) {
				if (spec.kind !== 'reader' || !spec.payload) {
					continue;
				}
				let readerTabID = await bridge.ensureReader(spec.payload.itemID);
				// Remap model ids onto the live Zotero tab ids when they differ.
				if (readerTabID && readerTabID !== spec.id) {
					spec.id = readerTabID;
					remapped = true;
				}
			}
		}
		if (remapped) {
			groups.arrange(...specs);
		}
		
		if (bridge.ensureShellTab) {
			for (let spec of specs) {
				if (SHELL_KINDS.has(spec.kind)) {
					await bridge.ensureShellTab(spec.kind, spec.payload || null);
				}
			}
		}
		
		let snapshot = groups.snapshot();
		if (bridge.select && snapshot.groups.left.activeTabID) {
			bridge.select(snapshot.groups.left.activeTabID);
		}
		return snapshot;
	};
})();
