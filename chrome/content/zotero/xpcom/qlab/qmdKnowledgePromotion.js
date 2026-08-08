/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Chance Siyuan / Chatero contributors

	This file is part of Chatero (a Zotero fork).

	***** END LICENSE BLOCK *****
*/

/**
 * Human-authorized Draft -> Knowledge promotion. Agents never call this API.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	function joinRoot(root, relativePath) {
		return `${String(root || '').replace(/[\\/]+$/, '')}/${String(relativePath || '').replace(/^\/+/, '')}`;
	}

	function stripTrailingSeparators(value) {
		let path = String(value || '').replace(/[\\/]+$/u, '');
		return path || '/';
	}

	function safeKnowledgePath(value) {
		let path = String(value || '').replace(/\\/g, '/');
		return Zotero.QLab.isSafeWorkspaceRelativePath(path, { under: 'knowledge' })
			&& /\.qmd$/i.test(path);
	}

	async function assertExact(root, relativePath, boundary, host, label) {
		if (!host || typeof host.realPath !== 'function') {
			throw new Error(`${label} host cannot verify real paths`);
		}
		let [realRoot, realBoundary, realPath] = await Promise.all([
			host.realPath(root),
			host.realPath(joinRoot(root, boundary)),
			host.realPath(joinRoot(root, relativePath)),
		]);
		realRoot = stripTrailingSeparators(realRoot);
		if (stripTrailingSeparators(realBoundary) !== `${realRoot}/${boundary}`
				|| stripTrailingSeparators(realPath) !== `${realRoot}/${relativePath}`) {
			throw new Error(`${label} uses a symbolic link or resolves outside its allowed directory`);
		}
	}

	async function ensureParent(root, target, host) {
		await assertExact(root, 'knowledge', 'knowledge', host, 'Knowledge');
		let parts = target.split('/').slice(1, -1);
		let parent = 'knowledge';
		for (let part of parts) {
			let next = `${parent}/${part}`;
			let absolute = joinRoot(root, next);
			if (!(await host.exists(absolute))) {
				await host.makeDir(absolute, { createAncestors: false });
			}
			await assertExact(root, next, parent, host, 'Knowledge destination');
			parent = next;
		}
		return parent;
	}

	async function createTrustedKnowledgeFile(path, text, host) {
		if (!host || typeof host.writeNew !== 'function') {
			throw new Error('Knowledge promotion requires atomic create-only IO');
		}
		try {
			await host.writeNew(path, text);
		}
		catch (error) {
			throw new Error(
				'Knowledge destination was not created; existing trusted content was not overwritten',
				{ cause: error }
			);
		}
	}

	Zotero.QLab.defaultKnowledgePathForDraft = function (draftPath) {
		let path = String(draftPath || '').replace(/\\/g, '/');
		if (!Zotero.QLab.isSafeWorkspaceRelativePath(path, { under: 'drafts' })
				|| !/\.qmd$/i.test(path)) {
			throw new Error('Choose a safe QMD Draft to promote');
		}
		return `knowledge/${path.slice('drafts/'.length)}`;
	};

	Zotero.QLab.promoteDraftToKnowledge = async function ({
		root,
		draftPath,
		knowledgePath = '',
		expectedRevision = '',
		host,
	} = {}) {
		let target = knowledgePath || Zotero.QLab.defaultKnowledgePathForDraft(draftPath);
		if (!safeKnowledgePath(target)) throw new Error('Choose a safe Knowledge QMD destination');
		if (!Zotero.QLab.QmdDraftIO || !host) throw new Error('Draft promotion IO is unavailable');
		let source = await Zotero.QLab.QmdDraftIO.readSource(root, draftPath, host);
		if (expectedRevision && source.revision !== expectedRevision) {
			throw new Error('Draft changed after approval; Knowledge was not updated');
		}
		let compliance = await Zotero.QLab.runQmdCompliance(root, draftPath, {
			source: source.text,
			host,
		});
		if (!compliance.ok) {
			let summary = (compliance.diagnostics || [])
				.map(item => item && item.message)
				.filter(Boolean)
				.join('; ');
			throw new Error(
				`Draft does not satisfy the trusted Knowledge contract${summary ? `: ${summary}` : ''}`
			);
		}
		let parent = await ensureParent(root, target, host);
		let absoluteTarget = joinRoot(root, target);
		// This must be one filesystem operation. An exists() check followed by a
		// normal write lets another publisher (or a dangling symlink) replace the
		// destination between the two calls and overwrite trusted/external data.
		await createTrustedKnowledgeFile(absoluteTarget, source.text, host);
		await assertExact(root, target, parent, host, 'Knowledge destination');
		return {
			promoted: true,
			from: draftPath,
			to: target,
			revision: source.revision,
		};
	};

	/**
	 * Complete the publication gate in a strict order:
	 * compliance -> read-only AI review -> unchanged-source check -> human approval
	 * -> trusted Knowledge copy. The callbacks keep UI and agent concerns outside
	 * the filesystem authority; only the final human-authorized copy may write
	 * under knowledge/.
	 */
	Zotero.QLab.reviewAndPromoteDraft = async function ({
		root,
		draftPath,
		knowledgePath = '',
		host,
		review,
		confirm,
	} = {}) {
		if (typeof review !== 'function') throw new Error('Draft AI review is unavailable');
		if (typeof confirm !== 'function') throw new Error('Human publication approval is unavailable');
		let target = knowledgePath || Zotero.QLab.defaultKnowledgePathForDraft(draftPath);
		let before = await Zotero.QLab.QmdDraftIO.readSource(root, draftPath, host);
		let compliance = await Zotero.QLab.runQmdCompliance(root, draftPath, {
			source: before.text,
			host,
		});
		if (!compliance.ok) {
			throw new Error('Draft does not satisfy the trusted Knowledge contract');
		}
		let context = {
			root,
			draftPath,
			knowledgePath: target,
			revision: before.revision,
		};
		let reviewResult = await review(context);
		if (!reviewResult || reviewResult.status !== 'completed') {
			return {
				promoted: false,
				status: 'review-cancelled',
				from: draftPath,
				to: target,
			};
		}
		let reviewed = await Zotero.QLab.QmdDraftIO.readSource(root, draftPath, host);
		if (reviewed.revision !== before.revision) {
			throw new Error('Draft changed during AI review; review it again before publishing');
		}
		let approved = await confirm({
			...context,
			review: reviewResult,
		});
		if (!approved) {
			return {
				promoted: false,
				status: 'declined',
				from: draftPath,
				to: target,
			};
		}
		return Zotero.QLab.promoteDraftToKnowledge({
			root,
			draftPath,
			knowledgePath: target,
			expectedRevision: reviewed.revision,
			host,
		});
	};
})();
