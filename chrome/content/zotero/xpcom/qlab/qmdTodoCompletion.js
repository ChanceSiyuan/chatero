/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Chance Siyuan / Chatero contributors

	This file is part of Chatero (a Zotero fork).

	***** END LICENSE BLOCK *****
*/

/**
 * Pure TODO-only completion contracts for private QMD working copies.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const TODO_PLACEHOLDER_PATTERN = /\[todo\s*:[^\]\r\n]*\]/giu;
	const CHANGE_ROOT = 'work/qlab-zotero/draft-changes';

	/**
	 * Proves that `after` differs from `before` only inside literal
	 * `[todo: ...]` spans and that every span received a non-empty completion.
	 */
	Zotero.QLab.validateTodoOnlyChange = function (before, after) {
		let sourceBefore = String(before ?? '');
		let sourceAfter = String(after ?? '');
		TODO_PLACEHOLDER_PATTERN.lastIndex = 0;
		let matches = [...sourceBefore.matchAll(TODO_PLACEHOLDER_PATTERN)];
		if (!matches.length) {
			return sourceBefore === sourceAfter
				? { ok: true, todoCount: 0, message: 'No TODO placeholders were present' }
				: {
					ok: false,
					todoCount: 0,
					message: 'The Draft had no [todo: ...] placeholders, but other content changed',
				};
		}

		let fixed = [];
		let cursor = 0;
		for (let match of matches) {
			let start = match.index;
			fixed.push(sourceBefore.slice(cursor, start));
			cursor = start + match[0].length;
		}
		fixed.push(sourceBefore.slice(cursor));
		if (!sourceAfter.startsWith(fixed[0])) {
			return {
				ok: false,
				todoCount: matches.length,
				message: 'Content before the first [todo: ...] placeholder changed',
			};
		}
		if (fixed.slice(1, -1).some(segment => segment.length === 0)) {
			return {
				ok: false,
				todoCount: matches.length,
				message: 'Adjacent TODO placeholders must be separated before automatic completion',
			};
		}
		let nonEmptyFixed = fixed.filter(segment => segment.length > 0);
		if (new Set(nonEmptyFixed).size !== nonEmptyFixed.length) {
			return {
				ok: false,
				todoCount: matches.length,
				message: 'Repeated fixed source segments make TODO completion boundaries ambiguous',
			};
		}

		let memo = new Map();
		function locate(segmentIndex, afterCursor) {
			let key = `${segmentIndex}:${afterCursor}`;
			if (memo.has(key)) return memo.get(key);
			let segment = fixed[segmentIndex];
			if (segmentIndex === fixed.length - 1) {
				let start = sourceAfter.length - segment.length;
				let result = start >= afterCursor && sourceAfter.startsWith(segment, start)
					? [[sourceAfter.slice(afterCursor, start)]]
					: [];
				memo.set(key, result);
				return result;
			}
			let results = [];
			let foundAt = sourceAfter.indexOf(segment, afterCursor);
			while (foundAt >= 0 && results.length < 2) {
				let tails = locate(segmentIndex + 1, foundAt + segment.length);
				for (let tail of tails) {
					results.push([sourceAfter.slice(afterCursor, foundAt), ...tail]);
					if (results.length === 2) break;
				}
				foundAt = sourceAfter.indexOf(segment, foundAt + Math.max(1, segment.length));
			}
			memo.set(key, results);
			return results;
		}

		let candidates = locate(1, fixed[0].length);
		if (!candidates.length) {
			return {
				ok: false,
				todoCount: matches.length,
				message: 'Content outside a [todo: ...] placeholder changed',
			};
		}
		if (candidates.length !== 1) {
			return {
				ok: false,
				todoCount: matches.length,
				message: 'TODO completion boundaries are ambiguous',
			};
		}
		let replacements = candidates[0];
		if (replacements.some(replacement => !replacement.trim())) {
			return {
				ok: false,
				todoCount: matches.length,
				message: 'At least one TODO was removed without a completion',
			};
		}
		if (TODO_PLACEHOLDER_PATTERN.test(sourceAfter)) {
			TODO_PLACEHOLDER_PATTERN.lastIndex = 0;
			return {
				ok: false,
				todoCount: matches.length,
				message: 'At least one [todo: ...] placeholder remains unresolved',
			};
		}
		TODO_PLACEHOLDER_PATTERN.lastIndex = 0;
		return {
			ok: true,
			todoCount: matches.length,
			message: `${matches.length} TODO${matches.length === 1 ? '' : 's'} completed`,
		};
	};

	function hasTodoPlaceholder(value) {
		TODO_PLACEHOLDER_PATTERN.lastIndex = 0;
		let found = TODO_PLACEHOLDER_PATTERN.test(String(value || ''));
		TODO_PLACEHOLDER_PATTERN.lastIndex = 0;
		return found;
	}

	function rejected(message) {
		return { ok: false, message: String(message || 'Invalid TODO completion manifest') };
	}

	/**
	 * Parse a local TODO completion manifest without trusting it to rewrite the
	 * Draft. Index coverage is verified against the source by apply below.
	 */
	Zotero.QLab.parseQmdTodoCompletions = function (input) {
		let manifest = input;
		if (typeof input === 'string') {
			try {
				manifest = JSON.parse(input);
			}
			catch (error) {
				return rejected('TODO completion manifest must be valid JSON');
			}
		}
		if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
			return rejected('TODO completion manifest must be an object');
		}
		if (manifest.version !== 1) {
			return rejected('TODO completion manifest version must be 1');
		}
		if (!Array.isArray(manifest.completions)) {
			return rejected('TODO completion manifest must contain a completions array');
		}
		let completions = [];
		for (let completion of manifest.completions) {
			if (!completion || typeof completion !== 'object'
					|| !Number.isInteger(completion.index) || completion.index < 0) {
				return rejected('Each TODO completion requires a non-negative integer index');
			}
			if (typeof completion.replacement !== 'string' || !completion.replacement.trim()) {
				return rejected('Each TODO completion requires a non-empty replacement');
			}
			if (hasTodoPlaceholder(completion.replacement)) {
				return rejected('TODO completion replacements must not contain [todo: ...] placeholders');
			}
			completions.push({
				index: completion.index,
				replacement: completion.replacement,
			});
		}
		return { ok: true, completions };
	};

	/**
	 * Apply one validated completion per original placeholder. This reconstructs
	 * the Draft around original offsets, so fixed source can never be moved by a
	 * model-provided replacement.
	 */
	Zotero.QLab.applyQmdTodoCompletions = function (source, input) {
		let before = String(source ?? '');
		let parsed = Zotero.QLab.parseQmdTodoCompletions(input);
		TODO_PLACEHOLDER_PATTERN.lastIndex = 0;
		let matches = [...before.matchAll(TODO_PLACEHOLDER_PATTERN)];
		if (!parsed.ok) {
			return { ok: false, todoCount: matches.length, message: parsed.message };
		}
		let byIndex = new Map();
		for (let completion of parsed.completions) {
			if (byIndex.has(completion.index)) {
				return {
					ok: false,
					todoCount: matches.length,
					message: `TODO completion index ${completion.index} is duplicated`,
				};
			}
			byIndex.set(completion.index, completion.replacement);
		}
		if (byIndex.size !== matches.length
				|| [...byIndex.keys()].some(index => index >= matches.length)) {
			return {
				ok: false,
				todoCount: matches.length,
				message: 'TODO completion indexes must cover every source placeholder exactly once',
			};
		}
		let after = [];
		let cursor = 0;
		for (let index = 0; index < matches.length; index++) {
			let match = matches[index];
			after.push(before.slice(cursor, match.index), byIndex.get(index));
			cursor = match.index + match[0].length;
		}
		after.push(before.slice(cursor));
		let rebuilt = after.join('');
		return {
			ok: true,
			todoCount: matches.length,
			after: rebuilt,
			message: `${matches.length} TODO${matches.length === 1 ? '' : 's'} completed`,
		};
	};

	Zotero.QLab.buildQmdTodoPrompt = function ({ workingPath, originalPath } = {}) {
		let working = String(workingPath || '').replace(/\\/g, '/');
		let original = String(originalPath || '').replace(/\\/g, '/');
		if (!Zotero.QLab.isSafeWorkspaceRelativePath(working, { under: CHANGE_ROOT })
				|| !/\/draft\.qmd$/.test(working)) {
			throw new Error('Unsafe private working-copy path');
		}
		if (!Zotero.QLab.isSafeWorkspaceRelativePath(original, { under: 'drafts' })
				|| !/\.qmd$/.test(original)) {
			throw new Error('Unsafe original Draft path');
		}

		return [
			'Action: complete-todos',
			'Mode: todo-only',
			'Authority: Follow $complete-gaps at skills/complete-gaps/SKILL.md.',
			`Private working copy: ${working}`,
			'TODO completion manifest: ./todo-completions.json',
			`Original Draft (read-only): ${original}`,
			'Read ./input.qmd and find every literal [todo: ...] placeholder.',
			'Process placeholders in source order and create exactly one completion per placeholder index.',
			'Chatero will preserve every byte outside the original placeholder spans by local reconstruction.',
			'Write JSON only: {"version":1,"completions":[{"index":0,"replacement":"..."}]}.',
			'Write all completions in English.',
			'Write only ./todo-completions.json.',
			'Do not edit ./input.qmd, ./draft.qmd, the original Draft, trusted Knowledge, Literature, or any other file.',
			'If a TODO cannot be completed without guessing, omit its completion so Chatero can reject the manifest safely.',
			'Show actions and outcomes only; never expose hidden chain-of-thought or private reasoning.',
			'Do not ask for another approval; save once and leave the result for Original/AI comparison and Keep review.',
		].join('\n');
	};

	/**
	 * Converts a pure validation result into the orchestration decision. An
	 * invalid first manifest is discarded before one private retry; an invalid
	 * retry is discarded and stopped. The proposal itself is never rolled back.
	 */
	Zotero.QLab.decideQmdTodoGuard = function (validation, { attempt = 1 } = {}) {
		if (!validation || typeof validation.ok !== 'boolean') {
			throw new TypeError('A TODO-only validation result is required');
		}
		if (!Number.isInteger(attempt) || attempt < 1) {
			throw new TypeError('TODO completion attempt must be a positive integer');
		}
		if (validation.ok) {
			return {
				outcome: 'accept',
				discardManifest: false,
				retryPrivately: false,
				nextAttempt: null,
				privateFeedback: null,
			};
		}
		let retry = attempt === 1;
		return {
			outcome: retry ? 'discard-and-retry' : 'discard-and-stop',
			discardManifest: true,
			retryPrivately: retry,
			nextAttempt: retry ? 2 : null,
			privateFeedback: String(validation.message || 'TODO-only guard rejected the change'),
		};
	};
})();
