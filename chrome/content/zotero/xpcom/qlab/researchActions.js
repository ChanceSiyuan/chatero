/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

Zotero.QLab = Zotero.QLab || {};

(function () {
	const ALL_OBJECTS = Object.freeze(['pdf', 'note', 'collection', 'draft']);
	
	const RESEARCH_ACTIONS = Object.freeze([
		{
			id: 'summarize',
			label: 'Summarize',
			description: 'Summarize the selected object with traceable evidence.',
			objects: ALL_OBJECTS,
		},
		{
			id: 'evidence-qa',
			label: 'Evidence QA',
			description: 'Answer a question and audit each material claim against the source.',
			objects: ALL_OBJECTS,
		},
		{
			id: 'compare-papers',
			label: 'Compare Papers',
			description: 'Compare the selected paper or collection on shared dimensions.',
			objects: Object.freeze(['pdf', 'collection']),
		},
		{
			id: 'analyze-figure',
			label: 'Analyze Figure',
			description: 'Analyze the visible or selected figure without inventing unreadable details.',
			objects: Object.freeze(['pdf']),
		},
		{
			id: 'write-draft',
			label: 'Write Draft',
			description: 'Route verified material into the existing QMD Draft workflow.',
			objects: ALL_OBJECTS,
		},
		{
			id: 'review-draft',
			label: 'Review Draft',
			description: 'Check a Draft for Knowledge readiness without changing or promoting it.',
			objects: Object.freeze(['draft']),
		},
	]);
	
	const READ_ONLY_MODES = Object.freeze({
		summarize: 'summary',
		'evidence-qa': 'evidence-qa',
		'compare-papers': 'compare',
		'analyze-figure': 'figure',
		'review-draft': 'review-only',
	});
	
	const OBJECT_LABELS = Object.freeze({
		pdf: 'PDF',
		note: 'Note',
		collection: 'Collection',
		draft: 'Draft',
	});
	
	Zotero.QLab.RESEARCH_ACTIONS = RESEARCH_ACTIONS;
	
	Zotero.QLab.researchActionsForObject = function (kind) {
		return RESEARCH_ACTIONS.filter(action => action.objects.includes(kind));
	};
	
	Zotero.QLab.researchActionSkill = function (actionID, kind) {
		let action = RESEARCH_ACTIONS.find(candidate => candidate.id === actionID);
		if (!action || !action.objects.includes(kind)) {
			let actionLabel = (action && action.label) || actionID;
			throw new Error(`${actionLabel} is not available for ${OBJECT_LABELS[kind]}`);
		}
		
		if (actionID === 'review-draft') {
			return {
				name: 'review-draft',
				path: 'skills/review-draft/SKILL.md',
				mode: 'review-only',
			};
		}
		if (actionID === 'write-draft') {
			if (kind === 'pdf') {
				return {
					name: 'capture-chat-draft',
					path: 'skills/capture-chat-draft/SKILL.md',
					mode: 'write-draft',
				};
			}
			return {
				name: 'expand-notes',
				path: 'skills/expand-notes/SKILL.md',
				mode: 'write-draft',
			};
		}
		
		let mode = READ_ONLY_MODES[actionID];
		if (!mode) {
			throw new Error(`No canonical skill mode is registered for ${action.label}`);
		}
		return {
			name: 'evidence-review',
			path: 'skills/evidence-review/SKILL.md',
			mode,
		};
	};
	
	function normalizeRepositoryRoot(value) {
		let trimmed = String(value || '').trim();
		if (!trimmed) {
			throw new Error('A selected Research Loop repository is required');
		}
		if (trimmed === '/') {
			return trimmed;
		}
		return trimmed.replace(/[\\/]+$/u, '');
	}
	
	function validateObject(object) {
		if (!object || !String(object.title || '').trim()) {
			throw new Error('The research object needs a title');
		}
		if (object.kind !== 'draft') {
			return;
		}
		let relativePath = String(object.relativePath || '').replace(/\\/gu, '/');
		let segments = relativePath.split('/');
		let safe = relativePath.startsWith('drafts/')
			&& relativePath.endsWith('.qmd')
			&& segments.length > 1
			&& segments.every(segment => segment !== '' && segment !== '.' && segment !== '..');
		if (!safe) {
			throw new Error('A Draft Action requires a safe .qmd path under drafts/');
		}
	}
	
	function escapeObjectEnvelope(json) {
		return json.replace(/<\s*\/\s*research_object\s*>/giu, (value) => (
			value.replaceAll('<', '＜').replaceAll('>', '＞')
		));
	}
	
	Zotero.QLab.buildResearchActionPrompt = function (actionID, context) {
		validateObject(context.object);
		let binding = Zotero.QLab.researchActionSkill(actionID, context.object.kind);
		let object = {
			...context.object,
			qlabRoot: normalizeRepositoryRoot(context.qlabRoot),
		};
		let envelope = escapeObjectEnvelope(JSON.stringify(object, null, 2));
		let prompt = [
			`Research Loop Action: ${actionID}`,
			`Mode: ${binding.mode}`,
			`Authority: Follow $${binding.name} at ${binding.path}.`,
			'<research_object>',
			envelope,
			'</research_object>',
		];
		if (actionID === 'review-draft') {
			prompt.push(
				'Perform a read-only review of the complete current Draft.',
				'Do not write to Knowledge, Drafts, or Literature, and do not modify any repository file.',
				'Do not promote the Draft or apply any proposed change.',
				'Return the check results and a suggested Knowledge destination for later human review.',
			);
		}
		return prompt.join('\n');
	};
	
	Zotero.QLab.isReadOnlyResearchAction = function (actionID) {
		return Object.prototype.hasOwnProperty.call(READ_ONLY_MODES, actionID);
	};
})();
