/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

Zotero.QLab = Zotero.QLab || {};

(function () {
	const SHELL_KINDS = new Set(['qlabchat', 'qlabqmd', 'qlabsite']);
	const UTILITY_KINDS = new Set(['qlabchat']);

	function hasStableItemIdentity(tab, kind, itemID) {
		return tab
			&& tab.kind === kind
			&& itemID !== undefined
			&& itemID !== null
			&& String(tab.payload && tab.payload.itemID) === String(itemID);
	}

	/**
	 * Replace an arrangement's synthetic item-backed tab id with the native id.
	 * Opening a Reader can register the native tab in TabGroups before this
	 * bridge resumes, so remove every stale model entry for the same attachment.
	 */
	function adoptNativeItemTabID(groups, spec, nativeID) {
		let oldID = spec.id;
		if (!nativeID || nativeID === oldID) {
			return false;
		}
		let itemID = spec.payload && spec.payload.itemID;
		let nativeTab = groups.tab(nativeID);
		if (nativeTab && !hasStableItemIdentity(nativeTab, spec.kind, itemID)) {
			throw new Error(`Native tab id ${nativeID} conflicts with ${spec.kind}:${itemID}`);
		}

		if (!nativeTab && oldID) {
			groups.rekeyTab(oldID, nativeID);
		}
		spec.id = nativeID;

		// If the native open registered its id first, rekeyTab correctly refuses
		// to overwrite it. In either order, stable item identity must be unique.
		for (let tab of groups.tabs()) {
			if (tab.id !== nativeID && hasStableItemIdentity(tab, spec.kind, itemID)) {
				groups.closeTab(tab.id);
			}
		}
		return true;
	}
	
	/**
	 * Build idempotent arrangement requests for PDF + Chat and PDF | Editor.
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
			utilities: [{
				kind: 'qlabchat',
				title: 'Chat',
				payload: { primaryItemID: itemID },
			}],
			showUtilities: ['qlabchat'],
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
	 * Research desk: PDF (evidence) | QMD (authority) + floating Chat.
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
			right: {
				kind: 'qlabqmd',
				title: 'QMD Editor',
				payload: draftPath ? { ...payload, draftPath } : payload,
			},
			utilities: [{
				kind: 'qlabchat',
				title: 'Chat',
				payload,
			}],
			showUtilities: ['qlabchat'],
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
			return arrangement.panes.filter(spec => spec && !UTILITY_KINDS.has(spec.kind));
		}
		return ['left', 'center', 'right']
			.map(role => arrangement[role])
			.filter(spec => spec && !UTILITY_KINDS.has(spec.kind));
	};

	/**
	 * Normalize utility launcher requests independently from content panes.
	 * Legacy arrangements that put Chat in `right` are accepted during migration.
	 */
	Zotero.QLab.arrangementUtilities = function (arrangement) {
		if (!arrangement) {
			return [];
		}
		let candidates = Array.isArray(arrangement.utilities)
			? arrangement.utilities.slice()
			: [];
		for (let role of ['left', 'center', 'right']) {
			let spec = arrangement[role];
			if (spec && UTILITY_KINDS.has(spec.kind)) {
				candidates.push(spec);
			}
		}
		let seen = new Set();
		return candidates.filter(spec => {
			if (!spec || !UTILITY_KINDS.has(spec.kind) || seen.has(spec.kind)) {
				return false;
			}
			seen.add(spec.kind);
			return true;
		});
	};
	
	/**
	 * Apply an arrangement to a TabGroups model and optionally to a window tabs API.
	 *
	 * @param {Zotero.QLab.TabGroups} groups
	 * @param {{ left?: object, right?: object, utilities?: object[], showUtilities?: string[] }} arrangement
	 * @param {{
	 *   ensureReader?: (itemID: number) => Promise<string|null>|string|null,
	 *   ensureShellTab?: (kind: string, payload?: object) => Promise<string|null>|string|null,
	 *   select?: (tabID: string) => void,
	 * }} [bridge]
	 */
	Zotero.QLab.applyArrangement = async function (groups, arrangement, bridge = {}) {
		let specs = Zotero.QLab.arrangementPanes(arrangement).map(spec => ({ ...spec }));
		let utilities = Zotero.QLab.arrangementUtilities(arrangement).map(spec => ({ ...spec }));
		if (!specs.length && !utilities.length) {
			return groups.snapshot();
		}
		groups.arrange(...specs, ...utilities);
		
		let remapped = false;
		if (bridge.ensureReader) {
			for (let spec of specs) {
				if (spec.kind !== 'reader' || !spec.payload) {
					continue;
				}
				let readerTabID = await bridge.ensureReader(spec.payload.itemID);
				// Remap model ids onto the live Zotero tab ids when they differ.
				if (readerTabID && readerTabID !== spec.id) {
					remapped = adoptNativeItemTabID(groups, spec, readerTabID) || remapped;
				}
			}
		}
		if (bridge.ensureShellTab) {
			for (let spec of [...specs, ...utilities]) {
				if (!SHELL_KINDS.has(spec.kind)) {
					continue;
				}
				let shellTabID = await bridge.ensureShellTab(
					spec.kind,
					spec.payload || null
				);
				// Session restore historically minted random ids for shell tabs.
				// Without this remap the deck goes is-split but no host gets
				// qlab-visible-right -- an empty gray column.
				let current = groups.tabs().find(tab => tab.kind === spec.kind);
				if (shellTabID && current && shellTabID !== current.id) {
					groups.rekeyTab(current.id, shellTabID);
					spec.id = shellTabID;
					remapped = true;
				}
				else if (shellTabID && !spec.id) {
					spec.id = shellTabID;
					remapped = true;
				}
			}
		}
		if (remapped) {
			groups.arrange(...specs, ...utilities);
		}

		if (bridge.showUtility && Array.isArray(arrangement.showUtilities)) {
			for (let kind of arrangement.showUtilities) {
				let spec = utilities.find(candidate => candidate.kind === kind);
				if (spec) {
					await bridge.showUtility(kind, spec.payload || null);
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
