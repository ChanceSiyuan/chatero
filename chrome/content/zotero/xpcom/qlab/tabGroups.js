/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
	
	***** END LICENSE BLOCK *****
*/

/**
 * Pure ordered-pane tab layout for native Chatero windows.
 * DOM-free so Node tests can exercise invariants without a Zotero window.
 *
 * Panes are dense and ordered left to right. Role names are derived from
 * position so that two-pane layouts keep their original left/right meaning:
 *
 *   1 pane  -> left
 *   2 panes -> left, right
 *   3 panes -> left, center, right   (content only)
 *
 * Tab kinds are Zotero-native peers: library, reader, note, plus QLab shells.
 * Chat is a window utility launcher and therefore never belongs to a pane.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const SINGLETON_KINDS = new Set(['qlabchat', 'qlabqmd', 'qlabsite']);
	const UTILITY_KINDS = new Set(['qlabchat']);
	const ALL_KINDS = new Set([
		'library', 'reader', 'note', 'qlabchat', 'qlabqmd', 'qlabsite'
	]);
	const DEFAULT_TITLES = {
		'qlabchat': 'Chat',
		'qlabqmd': 'QMD Editor',
		'qlabsite': 'Knowledge Site',
	};

	function restoredContentKind(type) {
		return String(type || '').replace(/-(?:unloaded|loading)$/, '');
	}

	function clonePaneWithIDs(pane, idMap, droppedIDs = new Set()) {
		if (!pane || typeof pane !== 'object') {
			return pane;
		}
		let tabIDs = Array.isArray(pane.tabIDs)
			? pane.tabIDs
				.filter(id => !droppedIDs.has(id))
				.map(id => idMap.get(id) || id)
			: pane.tabIDs;
		let activeTabID = droppedIDs.has(pane.activeTabID)
			? null
			: (idMap.get(pane.activeTabID) || pane.activeTabID);
		if (Array.isArray(tabIDs) && !tabIDs.includes(activeTabID)) {
			activeTabID = tabIDs[tabIDs.length - 1] || null;
		}
		return {
			...pane,
			tabIDs,
			activeTabID,
		};
	}

	/**
	 * Native session restore mints new Reader/Note tab ids. Rebind persisted
	 * QLab pane membership by stable item identity after native tabs exist.
	 */
	Zotero.QLab.reconcileRestoredTabGroupState = function (data, liveTabs = []) {
		if (!data || typeof data !== 'object') {
			return data;
		}
		let result = { ...data };
		let tabKey = Number(data.version) >= 3 ? 'contentTabs' : 'tabs';
		let entries = Array.isArray(data[tabKey]) ? data[tabKey] : [];
		let candidates = new Map();
		for (let tab of Array.isArray(liveTabs) ? liveTabs : []) {
			let kind = restoredContentKind(tab && tab.type);
			if ((kind !== 'reader' && kind !== 'note') || !tab?.data) {
				continue;
			}
			let key = `${kind}:${String(tab.data.itemID)}`;
			let values = candidates.get(key) || [];
			values.push(tab);
			candidates.set(key, values);
		}
		let used = new Set();
		let idMap = new Map();
		let droppedIDs = new Set();
		result[tabKey] = entries.flatMap(entry => {
			let next = {
				...entry,
				payload: entry?.payload && typeof entry.payload === 'object'
					? { ...entry.payload }
					: entry?.payload,
			};
			if (entry?.kind !== 'reader' && entry?.kind !== 'note') {
				return [next];
			}
			let itemID = entry.payload?.itemID;
			let key = `${entry.kind}:${String(itemID)}`;
			let values = itemID === undefined || itemID === null
				? []
				: (candidates.get(key) || []);
			let live = values.find(tab => tab.id === entry.id && !used.has(tab.id))
				|| values.find(tab => !used.has(tab.id));
			if (!live) {
				if (typeof entry.id === 'string' && entry.id) {
					droppedIDs.add(entry.id);
				}
				return [];
			}
			used.add(live.id);
			idMap.set(entry.id, live.id);
			next.id = live.id;
			return [next];
		});
		if (Array.isArray(data.panes)) {
			result.panes = data.panes.map(
				pane => clonePaneWithIDs(pane, idMap, droppedIDs)
			);
		}
		if (data.groups && typeof data.groups === 'object') {
			result.groups = {};
			for (let role of ['left', 'center', 'right']) {
				if (Object.prototype.hasOwnProperty.call(data.groups, role)) {
					result.groups[role] = clonePaneWithIDs(
						data.groups[role], idMap, droppedIDs
					);
				}
			}
		}
		return result;
	};

	/**
	 * Restore native tabs before reconciling the QLab presentation state.
	 *
	 * `progress.claimNativeRestore()` transfers responsibility for native tab
	 * restoration to this helper. The pane startup fallback must not repeat a
	 * non-idempotent Reader restore if a later QLab-only step fails.
	 *
	 * @param {object} tabsAPI
	 * @param {object} state
	 * @param {{ claimNativeRestore?: Function }} [progress]
	 */
	Zotero.QLab.restoreNativeAndQLabTabState = async function (tabsAPI, state, progress) {
		if (!tabsAPI || !state) {
			return null;
		}
		if (typeof tabsAPI.restoreState === 'function') {
			if (typeof progress?.claimNativeRestore === 'function') {
				progress.claimNativeRestore();
			}
			await tabsAPI.restoreState(Array.isArray(state.tabs) ? state.tabs : []);
		}
		let reconciled = null;
		if (state.qlabGroups && typeof tabsAPI.restoreQLabGroupsState === 'function') {
			reconciled = Zotero.QLab.reconcileRestoredTabGroupState(
				state.qlabGroups,
				tabsAPI._tabs || []
			);
			tabsAPI.restoreQLabGroupsState(reconciled);
		}
		if (state.qlabChatPresentation
				&& typeof tabsAPI.restoreQLabChatPresentationState === 'function') {
			tabsAPI.restoreQLabChatPresentationState(state.qlabChatPresentation);
		}
		return reconciled;
	};
	const MAX_PANES = 3;
	const ROLE_LAYOUTS = {
		1: ['left'],
		2: ['left', 'right'],
		3: ['left', 'center', 'right'],
	};
	// Divider positions as fractions of the deck width, not pane widths.
	const DEFAULT_RATIOS = {
		2: [0.5],
		3: [0.34, 0.67],
	};
	const MIN_PANE_FRACTION = 0.15;
	
	function createPane() {
		return { tabIDs: [], activeTabID: null };
	}
	
	function clonePane(pane) {
		if (!pane) {
			return null;
		}
		return {
			tabIDs: pane.tabIDs.slice(),
			activeTabID: pane.activeTabID,
		};
	}
	
	function libraryTab() {
		return {
			id: 'zotero-pane',
			kind: 'library',
			title: 'Library',
			payload: null,
		};
	}
	
	/**
	 * Clamp divider positions so every pane keeps a usable minimum width.
	 *
	 * @param {number[]} ratios
	 * @param {number} paneCount
	 */
	function clampRatios(ratios, paneCount) {
		let count = Math.max(0, paneCount - 1);
		let out = [];
		for (let i = 0; i < count; i++) {
			let value = Number(ratios[i]);
			if (!Number.isFinite(value)) {
				value = DEFAULT_RATIOS[paneCount] ? DEFAULT_RATIOS[paneCount][i] : 0.5;
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
	 * @param {Function} [onChange]
	 */
	Zotero.QLab.TabGroups = function (onChange) {
		this._onChange = typeof onChange === 'function' ? onChange : () => {};
		this._tabs = new Map();
		this._utilityTabIDs = new Set();
		this._panes = [createPane()];
		this._focusedIndex = 0;
		this._splitRatios = DEFAULT_RATIOS[2].slice();
		this._ratiosTouched = false;
		// Library is always present in the first pane.
		this._tabs.set('zotero-pane', libraryTab());
		this._panes[0].tabIDs.push('zotero-pane');
		this._panes[0].activeTabID = 'zotero-pane';
	};
	
	Zotero.QLab.TabGroups.prototype = {
		snapshot() {
			let roles = this._roles();
			let groups = { left: null, center: null, right: null };
			for (let i = 0; i < this._panes.length; i++) {
				groups[roles[i]] = clonePane(this._panes[i]);
			}
			return {
				groups,
				panes: this._panes.map(clonePane),
				paneCount: this._panes.length,
				focusedGroup: roles[this._focusedIndex] || 'left',
				splitRatio: this.splitRatios()[0] !== undefined
					? this.splitRatios()[0]
					: DEFAULT_RATIOS[2][0],
				splitRatios: this.splitRatios(),
				utilityTabs: this.utilityTabs(),
			};
		},
		
		tabs() {
			return Array.from(this._tabs.values()).map(tab => ({ ...tab }));
		},

		contentTabs() {
			return this.tabs().filter(tab => !this._utilityTabIDs.has(tab.id));
		},

		utilityTabs() {
			return this.tabs().filter(tab => this._utilityTabIDs.has(tab.id));
		},
		
		tab(id) {
			let tab = this._tabs.get(id);
			return tab ? { ...tab } : null;
		},
		
		paneCount() {
			return this._panes.length;
		},
		
		/**
		 * Divider positions for the current pane count.
		 */
		splitRatios() {
			let effective = this._ratiosTouched
				? this._splitRatios
				: (DEFAULT_RATIOS[this._panes.length] || this._splitRatios);
			return clampRatios(effective, this._panes.length);
		},
		
		groupOf(id) {
			let index = this._paneIndexOf(id);
			return index < 0 ? null : this._roles()[index];
		},
		
		setSplitRatio(ratio) {
			this.setSplitRatioAt(0, ratio);
		},
		
		/**
		 * @param {number} index Divider index (0 is the leftmost divider)
		 * @param {number} ratio Position as a fraction of the deck width
		 */
		setSplitRatioAt(index, ratio) {
			let next = Number(ratio);
			if (!Number.isFinite(next) || index < 0 || index >= MAX_PANES - 1) {
				return;
			}
			this._mutate(() => {
				let current = this.splitRatios().slice();
				while (current.length <= index) {
					current.push(next);
				}
				current[index] = next;
				this._splitRatios = clampRatios(current, Math.max(
					this._panes.length,
					index + 2
				));
				this._ratiosTouched = true;
			});
		},
		
		/**
		 * @param {{ kind: string, id?: string, title?: string, payload?: object }} request
		 * @param {'left'|'center'|'right'} [group]
		 */
		openTab(request, group) {
			let id = this._idFor(request);
			this._mutate(() => {
				let existing = this._tabs.get(id);
				if (existing) {
					this._applyRequest(existing, request);
					if (this._isUtilityID(id)) {
						this._removeFromPanes(id);
					}
					else {
						this._activateInPlace(id);
					}
					return;
				}
				let title = request.title
					|| DEFAULT_TITLES[request.kind]
					|| request.kind;
				this._tabs.set(id, {
					id,
					kind: request.kind,
					title,
					payload: request.payload ? { ...request.payload } : null,
				});
				if (UTILITY_KINDS.has(request.kind)) {
					this._utilityTabIDs.add(id);
					this._removeFromPanes(id);
					return;
				}
				let index = group
					? this._ensurePaneForRole(group)
					: this._focusedIndex;
				let target = this._panes[index] || this._panes[0];
				target.tabIDs.push(id);
				target.activeTabID = id;
				this._focusedIndex = this._panes.indexOf(target);
			});
			return id;
		},
		
		closeTab(id) {
			if (id === 'zotero-pane') {
				throw new Error('Library tab cannot be closed');
			}
			this._mutate(() => {
				if (!this._tabs.has(id)) {
					return;
				}
				this._tabs.delete(id);
				this._utilityTabIDs.delete(id);
				this._removeFromPanes(id);
				this._normalize();
			});
		},
		
		/**
		 * Point an existing model entry at a different live tab id (session
		 * restore may mint a random id while arrange still asks for the
		 * singleton kind name).
		 */
		rekeyTab(oldID, newID) {
			if (!oldID || !newID || oldID === newID) {
				return false;
			}
			if (oldID === 'zotero-pane' || newID === 'zotero-pane') {
				throw new Error('Library tab id cannot be rekeyed');
			}
			if (!this._tabs.has(oldID) || this._tabs.has(newID)) {
				return false;
			}
			this._mutate(() => {
				let tab = this._tabs.get(oldID);
				this._tabs.delete(oldID);
				tab.id = newID;
				this._tabs.set(newID, tab);
				if (this._utilityTabIDs.delete(oldID)) {
					this._utilityTabIDs.add(newID);
				}
				for (let pane of this._panes) {
					pane.tabIDs = pane.tabIDs.map(id => (id === oldID ? newID : id));
					if (pane.activeTabID === oldID) {
						pane.activeTabID = newID;
					}
				}
			});
			return true;
		},
		
		activateTab(id) {
			this._mutate(() => {
				if (!this._tabs.has(id) || this._isUtilityID(id)) {
					return;
				}
				this._activateInPlace(id);
			});
		},
		
		moveTab(id, group, index) {
			if (id === 'zotero-pane' && group && group !== 'left') {
				throw new Error('Library tab cannot leave the left group');
			}
			this._mutate(() => {
				if (!this._tabs.has(id)) {
					return;
				}
				if (this._isUtilityID(id)) {
					this._removeFromPanes(id);
					this._normalize();
					return;
				}
				let paneIndex = this._ensurePaneForRole(group, id);
				this._removeFromPanes(id);
				// Removing the tab may have emptied a pane, but panes are only
				// collapsed in _normalize() so the index stays valid here.
				let target = this._panes[paneIndex] || this._panes[0];
				let at = index === undefined
					? target.tabIDs.length
					: Math.max(0, Math.min(index, target.tabIDs.length));
				target.tabIDs.splice(at, 0, id);
				target.activeTabID = id;
				this._focusedIndex = this._panes.indexOf(target);
				this._normalize();
			});
		},
		
		/**
		 * Idempotent left-to-right arrangement.
		 *
		 * arrange(left, right)          -> PDF | Editor
		 * arrange(left, utility)        -> PDF + floating Chat
		 * arrange(left, right, utility) -> PDF | Editor + floating Chat
		 *
		 * @param {...{ kind: string, id?: string, title?: string, payload?: object }} specs
		 */
		arrange(...specs) {
			let allRequests = specs.filter(Boolean);
			let requests = allRequests
				.filter(request => !UTILITY_KINDS.has(request.kind))
				.slice(0, MAX_PANES);
			let utilityRequests = allRequests.filter(request => UTILITY_KINDS.has(request.kind));
			if (!requests.length && !utilityRequests.length) {
				return;
			}
			// Validate before mutating so a rejected arrangement leaves no residue.
			let planned = [];
			for (let request of requests) {
				let id = this._idFor(request);
				if (!planned.includes(id)) {
					planned.push(id);
				}
			}
			if (planned.indexOf('zotero-pane') > 0) {
				throw new Error('Library tab cannot leave the left group');
			}
			this._mutate(() => {
				for (let request of utilityRequests) {
					this._ensureTab(request);
				}
				let ids = [];
				for (let request of requests) {
					let id = this._ensureTab(request);
					if (!ids.includes(id)) {
						ids.push(id);
					}
				}
				if (!ids.length) {
					this._normalize();
					return;
				}
				if (ids.length === 1) {
					this._activateInPlace(ids[0]);
					this._focusedIndex = Math.max(0, this._paneIndexOf(ids[0]));
					this._normalize();
					return;
				}
				while (this._panes.length < ids.length) {
					this._panes.push(createPane());
				}
				for (let i = 0; i < ids.length; i++) {
					let id = ids[i];
					if (this._paneIndexOf(id) !== i) {
						this._removeFromPanes(id);
						this._panes[i].tabIDs.push(id);
					}
					this._panes[i].activeTabID = id;
				}
				// Arranging fewer panes than are open folds the surplus into the
				// last requested pane instead of closing the tabs it holds.
				let last = this._panes[ids.length - 1];
				for (let surplus of this._panes.splice(ids.length)) {
					for (let id of surplus.tabIDs) {
						last.tabIDs.push(id);
					}
				}
				this._focusedIndex = 0;
				this._normalize();
			});
		},
		
		serialize() {
			let snapshot = this.snapshot();
			return {
				version: 3,
				contentTabs: this.contentTabs().map(tab => ({
					id: tab.id,
					kind: tab.kind,
					title: tab.title,
					...(tab.payload ? { payload: { ...tab.payload } } : {}),
				})),
				utilityTabs: this.utilityTabs().map(tab => ({
					id: tab.id,
					kind: tab.kind,
					title: tab.title,
					...(tab.payload ? { payload: { ...tab.payload } } : {}),
				})),
				groups: snapshot.groups,
				panes: snapshot.panes,
				paneCount: snapshot.paneCount,
				focusedGroup: snapshot.focusedGroup,
				splitRatio: snapshot.splitRatio,
				// Keep dormant divider positions so a migrated PDF | Chat layout
				// regains its old ratio when a QMD content pane is opened later.
				splitRatios: this._ratiosTouched
					? clampRatios(this._splitRatios, MAX_PANES)
					: snapshot.splitRatios,
			};
		},
		
		restore(data) {
			this._mutate(() => {
				this._tabs = new Map();
				this._utilityTabIDs = new Set();
				this._panes = [createPane()];
				this._focusedIndex = 0;
				this._splitRatios = DEFAULT_RATIOS[2].slice();
				this._ratiosTouched = false;
				
				let serializedTabs = this._serializedTabs(data);
				if (!data || typeof data !== 'object' || !serializedTabs) {
					this._tabs.set('zotero-pane', libraryTab());
					this._panes[0].tabIDs.push('zotero-pane');
					this._panes[0].activeTabID = 'zotero-pane';
					return;
				}
				
				for (let entry of serializedTabs) {
					let tab = this._reviveTab(entry);
					let duplicateUtility = tab && UTILITY_KINDS.has(tab.kind)
						&& this.utilityTabs().some(existing => existing.kind === tab.kind);
					if (tab && !duplicateUtility && !this._tabs.has(tab.id)) {
						this._tabs.set(tab.id, tab);
						if (UTILITY_KINDS.has(tab.kind)) {
							this._utilityTabIDs.add(tab.id);
						}
					}
				}
				if (!this._tabs.has('zotero-pane')) {
					this._tabs.set('zotero-pane', libraryTab());
				}
				
				let serializedPanes = this._serializedPanes(data);
				let revived = [];
				for (let raw of serializedPanes) {
					let pane = this._revivePane(raw, revived);
					if (pane) {
						revived.push(pane);
					}
				}
				this._panes = revived.length ? revived.slice(0, MAX_PANES) : [createPane()];
				
				for (let id of this._tabs.keys()) {
					if (!this._isUtilityID(id) && !this.groupOf(id)) {
						this._panes[0].tabIDs.push(id);
					}
				}
				if (!this._panes[0].tabIDs.includes('zotero-pane')) {
					this._panes[0].tabIDs.unshift('zotero-pane');
				}
				
				let originalRoles = ROLE_LAYOUTS[Math.min(serializedPanes.length, MAX_PANES)] || [];
				let originalFocus = originalRoles.indexOf(data.focusedGroup);
				let focusedID = originalFocus >= 0 && serializedPanes[originalFocus]
					? serializedPanes[originalFocus].activeTabID
					: null;
				let focusedIndex = focusedID ? this._paneIndexOf(focusedID) : -1;
				if (focusedIndex < 0) {
					let roles = this._roles();
					focusedIndex = roles.indexOf(data.focusedGroup);
				}
				this._focusedIndex = focusedIndex < 0 ? 0 : focusedIndex;
				
				if (Array.isArray(data.splitRatios) && data.splitRatios.length) {
					this._splitRatios = data.splitRatios.map(Number);
					this._ratiosTouched = true;
				}
				else if (Number.isFinite(data.splitRatio)) {
					this._splitRatios = [data.splitRatio, DEFAULT_RATIOS[3][1]];
					this._ratiosTouched = true;
				}
				this._normalize();
			});
		},
		
		_roles() {
			return ROLE_LAYOUTS[this._panes.length] || ROLE_LAYOUTS[MAX_PANES];
		},
		
		_paneIndexOf(id) {
			for (let i = 0; i < this._panes.length; i++) {
				if (this._panes[i].tabIDs.includes(id)) {
					return i;
				}
			}
			return -1;
		},
		
		/**
		 * Resolve a role name to a pane index, growing the layout when the role
		 * does not exist yet. `center` splits the current layout in the middle so
		 * that a two-pane deck becomes PDF | Notes | Chat rather than reordering.
		 */
		_ensurePaneForRole(role, movingID) {
			if (!role) {
				return this._focusedIndex;
			}
			let roles = this._roles();
			let index = roles.indexOf(role);
			if (index >= 0) {
				return index;
			}
			// The role is not part of the current layout, so a pane must be added.
			// Adding one is only possible when a tab is leaving another pane or the
			// deck is below the pane cap.
			if (this._panes.length >= MAX_PANES) {
				return this._panes.length - 1;
			}
			let occupied = movingID ? this._paneIndexOf(movingID) : -1;
			let onlyTabInPane = occupied >= 0
				&& this._panes[occupied].tabIDs.length === 1;
			if (onlyTabInPane && this._panes.length === MAX_PANES - 1) {
				// Moving the pane's only tab would collapse it again; keep it put.
				return occupied;
			}
			if (role === 'center') {
				this._panes.splice(1, 0, createPane());
				return 1;
			}
			if (role === 'left') {
				this._panes.unshift(createPane());
				return 0;
			}
			this._panes.push(createPane());
			return this._panes.length - 1;
		},
		
		_idFor(request) {
			if (UTILITY_KINDS.has(request.kind)) {
				let existing = this.utilityTabs().find(tab => tab.kind === request.kind);
				if (existing) {
					return existing.id;
				}
			}
			if (request.id) {
				return request.id;
			}
			if (SINGLETON_KINDS.has(request.kind)) {
				return request.kind;
			}
			if (request.kind === 'reader' || request.kind === 'note') {
				let itemID = request.payload && request.payload.itemID;
				return `${request.kind}:${itemID}`;
			}
			if (request.kind === 'library') {
				return 'zotero-pane';
			}
			return `${request.kind}-${Math.random().toString(36).slice(2, 10)}`;
		},
		
		_applyRequest(tab, request) {
			if (request.title) {
				tab.title = request.title;
			}
			if (request.payload) {
				tab.payload = { ...request.payload };
			}
		},
		
		_ensureTab(request) {
			let id = this._idFor(request);
			let existing = this._tabs.get(id);
			if (existing) {
				this._applyRequest(existing, request);
				return id;
			}
			let title = request.title
				|| DEFAULT_TITLES[request.kind]
				|| request.kind;
			this._tabs.set(id, {
				id,
				kind: request.kind,
				title,
				payload: request.payload ? { ...request.payload } : null,
			});
			if (UTILITY_KINDS.has(request.kind)) {
				this._utilityTabIDs.add(id);
			}
			else {
				this._panes[0].tabIDs.push(id);
			}
			return id;
		},
		
		_activateInPlace(id) {
			let index = this._paneIndexOf(id);
			if (index < 0) {
				return;
			}
			this._panes[index].activeTabID = id;
			this._focusedIndex = index;
		},
		
		_removeFromPanes(id) {
			for (let pane of this._panes) {
				let index = pane.tabIDs.indexOf(id);
				if (index < 0) {
					continue;
				}
				pane.tabIDs.splice(index, 1);
				if (pane.activeTabID === id) {
					pane.activeTabID = pane.tabIDs[pane.tabIDs.length - 1] || null;
				}
			}
		},
		
		_normalize() {
			for (let id of this._utilityTabIDs) {
				this._removeFromPanes(id);
			}
			let kept = this._panes.filter(pane => pane.tabIDs.length);
			this._panes = kept.length ? kept.slice(0, MAX_PANES) : [createPane()];
			
			if (this._tabs.has('zotero-pane')) {
				let libraryIndex = this._paneIndexOf('zotero-pane');
				if (libraryIndex < 0) {
					this._panes[0].tabIDs.unshift('zotero-pane');
				}
				else if (libraryIndex > 0) {
					this._removeFromPanes('zotero-pane');
					this._panes[0].tabIDs.unshift('zotero-pane');
					this._panes = this._panes.filter(pane => pane.tabIDs.length);
				}
			}
			
			for (let pane of this._panes) {
				if (pane.activeTabID && !pane.tabIDs.includes(pane.activeTabID)) {
					pane.activeTabID = pane.tabIDs[pane.tabIDs.length - 1] || null;
				}
				if (!pane.activeTabID && pane.tabIDs.length) {
					pane.activeTabID = pane.tabIDs[pane.tabIDs.length - 1];
				}
			}
			
			if (this._focusedIndex >= this._panes.length) {
				this._focusedIndex = this._panes.length - 1;
			}
			if (this._focusedIndex < 0) {
				this._focusedIndex = 0;
			}
			if (!this._panes[0].activeTabID
					&& this._panes[0].tabIDs.includes('zotero-pane')) {
				this._panes[0].activeTabID = 'zotero-pane';
			}
			if (this._ratiosTouched) {
				this._splitRatios = clampRatios(this._splitRatios, MAX_PANES);
			}
		},
		
		_serializedPanes(data) {
			if (Array.isArray(data.panes)) {
				return data.panes;
			}
			let groups = data.groups && typeof data.groups === 'object' ? data.groups : {};
			return [groups.left, groups.center, groups.right].filter(Boolean);
		},

		_serializedTabs(data) {
			if (!data || typeof data !== 'object') {
				return null;
			}
			if (Number(data.version) >= 3) {
				let content = Array.isArray(data.contentTabs) ? data.contentTabs : [];
				let utilities = Array.isArray(data.utilityTabs) ? data.utilityTabs : [];
				return [...content, ...utilities];
			}
			return Array.isArray(data.tabs) ? data.tabs : null;
		},

		_isUtilityID(id) {
			return this._utilityTabIDs.has(id)
				|| (this._tabs.has(id) && UTILITY_KINDS.has(this._tabs.get(id).kind));
		},
		
		_reviveTab(entry) {
			if (!entry || typeof entry !== 'object') {
				return null;
			}
			let kind = entry.kind;
			if (!ALL_KINDS.has(kind)) {
				return null;
			}
			let id = typeof entry.id === 'string' && entry.id
				? entry.id
				: this._idFor({ kind, payload: entry.payload });
			let title = typeof entry.title === 'string' && entry.title
				? entry.title
				: (DEFAULT_TITLES[kind] || kind);
			return {
				id,
				kind,
				title,
				payload: entry.payload && typeof entry.payload === 'object'
					? { ...entry.payload }
					: null,
			};
		},
		
		_revivePane(raw, alreadyRevived) {
			if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tabIDs)) {
				return null;
			}
			let taken = new Set();
			for (let pane of alreadyRevived) {
				for (let id of pane.tabIDs) {
					taken.add(id);
				}
			}
			let tabIDs = [];
			for (let id of raw.tabIDs) {
				if (typeof id === 'string' && this._tabs.has(id) && !this._isUtilityID(id) && !taken.has(id)
						&& !tabIDs.includes(id)) {
					tabIDs.push(id);
				}
			}
			if (!tabIDs.length) {
				return null;
			}
			let activeTabID = typeof raw.activeTabID === 'string'
				&& tabIDs.includes(raw.activeTabID)
				? raw.activeTabID
				: (tabIDs[tabIDs.length - 1] || null);
			return { tabIDs, activeTabID };
		},
		
		_mutate(apply) {
			let before = JSON.stringify(this.serialize());
			apply();
			if (JSON.stringify(this.serialize()) !== before) {
				this._onChange();
			}
		},
	};
})();
