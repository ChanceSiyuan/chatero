/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Pure helpers for multi-pane content visibility (no DOM).
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const ROLE_LAYOUTS = {
		1: ['left'],
		2: ['left', 'right'],
		3: ['left', 'center', 'right'],
	};
	const DEFAULT_RATIOS = {
		2: [0.5],
		3: [0.34, 0.67],
	};
	const MIN_PANE_FRACTION = 0.15;
	
	function clampRatios(ratios, paneCount) {
		let count = Math.max(0, paneCount - 1);
		let defaults = DEFAULT_RATIOS[paneCount] || DEFAULT_RATIOS[2];
		let out = [];
		for (let i = 0; i < count; i++) {
			let value = Number(ratios && ratios[i]);
			if (!Number.isFinite(value)) {
				value = defaults[i] !== undefined ? defaults[i] : 0.5;
			}
			let floor = MIN_PANE_FRACTION * (i + 1);
			let ceiling = 1 - MIN_PANE_FRACTION * (count - i);
			if (i > 0) {
				floor = Math.max(floor, out[i - 1] + MIN_PANE_FRACTION);
			}
			out.push(Math.min(ceiling, Math.max(floor, value)));
		}
		return out;
	}
	
	/**
	 * Accepts both the ordered `panes` array and the legacy left/right groups.
	 */
	function utilityIDsFrom(snapshot) {
		let ids = new Set(['qlabchat']);
		for (let tab of (snapshot && snapshot.utilityTabs) || []) {
			if (tab && typeof tab.id === 'string') {
				ids.add(tab.id);
			}
		}
		return ids;
	}

	function panesFrom(snapshot) {
		if (!snapshot) {
			return [];
		}
		let utilityIDs = utilityIDsFrom(snapshot);
		let source = Array.isArray(snapshot.panes)
			? snapshot.panes
			: [
				snapshot.groups && snapshot.groups.left,
				snapshot.groups && snapshot.groups.center,
				snapshot.groups && snapshot.groups.right,
			];
		return source.map(pane => {
			if (!pane || !Array.isArray(pane.tabIDs)) {
				return null;
			}
			let tabIDs = pane.tabIDs.filter(id => !utilityIDs.has(id));
			if (!tabIDs.length) {
				return null;
			}
			let activeTabID = tabIDs.includes(pane.activeTabID)
				? pane.activeTabID
				: tabIDs[tabIDs.length - 1];
			return { tabIDs, activeTabID };
		}).filter(Boolean);
	}
	
	/**
	 * @param {object} snapshot Zotero.QLab.TabGroups#snapshot output
	 * @param {string} selectedID Zotero_Tabs selection identity
	 */
	Zotero.QLab.resolveSplitVisibility = function (snapshot, selectedID) {
		if (utilityIDsFrom(snapshot).has(selectedID)) {
			selectedID = null;
		}
		let paneIDs = panesFrom(snapshot).map(pane => pane.activeTabID);
		if (!paneIDs.length && selectedID) {
			paneIDs = [selectedID];
		}
		let paneCount = paneIDs.length;
		let split = paneCount >= 2;
		let roles = ROLE_LAYOUTS[paneCount] || ROLE_LAYOUTS[3];
		let splitRatios = clampRatios(
			snapshot && Array.isArray(snapshot.splitRatios)
				? snapshot.splitRatios
				: [snapshot && snapshot.splitRatio],
			Math.max(paneCount, 2)
		);
		
		let leftID = paneIDs[roles.indexOf('left')] || selectedID || null;
		let centerID = roles.includes('center')
			? paneIDs[roles.indexOf('center')] || null
			: null;
		let rightID = roles.includes('right')
			? paneIDs[roles.indexOf('right')] || null
			: null;
		let focusedID = selectedID
			|| paneIDs[roles.indexOf(snapshot && snapshot.focusedGroup)]
			|| leftID;
		
		return {
			split,
			paneCount,
			paneIDs,
			leftID,
			centerID,
			rightID,
			focusedID,
			splitRatio: splitRatios[0],
			splitRatios,
			visibleIDs: split
				? paneIDs.filter(Boolean)
				: [focusedID].filter(Boolean),
		};
	};
	
	/**
	 * Map a tab id into pane class names for the content host.
	 */
	Zotero.QLab.paneClassForTab = function (tabID, visibility) {
		let classes = [];
		if (!visibility || !visibility.split) {
			if (visibility && tabID === visibility.focusedID) {
				classes.push('deck-selected');
			}
			return classes;
		}
		let paneIDs = Array.isArray(visibility.paneIDs) && visibility.paneIDs.length
			? visibility.paneIDs
			: [visibility.leftID, visibility.centerID, visibility.rightID].filter(Boolean);
		let roles = ROLE_LAYOUTS[paneIDs.length] || ROLE_LAYOUTS[3];
		let index = paneIDs.indexOf(tabID);
		if (index < 0 || !roles[index]) {
			return classes;
		}
		classes.push('deck-selected', `qlab-visible-${roles[index]}`);
		return classes;
	};
	
	/**
	 * True when a tab is currently rendered in one of the visible panes.
	 */
	Zotero.QLab.isTabVisible = function (visibility, tabID) {
		if (!visibility || !tabID) {
			return false;
		}
		return (visibility.visibleIDs || []).includes(tabID);
	};
})();
