/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Phase 3C scaffolding: Keep semantics for Draft AI working copies.
 * Full Visual Edit ports later; these helpers define the authority contract.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	Zotero.QLab.DraftWorkingCopy = {
		/**
		 * @param {{ originalPath: string, workingPath: string, revision: number }} state
		 */
		canKeep(state) {
			return !!(state
				&& state.originalPath
				&& state.workingPath
				&& state.revision != null
				&& String(state.revision).length > 0);
		},
		
		/**
		 * Keep is the only path that promotes the AI working copy over the original Draft.
		 * Returns a plan object; IO is the caller's responsibility.
		 */
		buildKeepPlan(state) {
			if (!this.canKeep(state)) {
				throw new Error('Keep requires originalPath, workingPath, and revision');
			}
			if (!Zotero.QLab.isSafeWorkspaceRelativePath(state.originalPath, { under: 'drafts' })
				&& !String(state.originalPath).includes('/drafts/')) {
				// Absolute workspace paths are allowed when they still target drafts.
				let normalized = String(state.originalPath).replace(/\\/g, '/');
				if (!normalized.includes('/drafts/') || !normalized.endsWith('.qmd')) {
					throw new Error('Keep only applies to Draft QMD paths');
				}
			}
			return {
				action: 'keep',
				from: state.workingPath,
				to: state.originalPath,
				expectedRevision: state.revision,
				clearReviewState: true,
			};
		},
	};
})();
