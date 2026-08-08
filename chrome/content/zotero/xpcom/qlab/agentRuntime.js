/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Agent Runtime -- policy-facing session layer.
 * UI and Research Actions talk to this layer only; they never call HTTP/API keys.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const MODES = Object.freeze(['ask', 'agent', 'prove']);
	
	const DEFAULT_GRANTS = Object.freeze({
		ask: Object.freeze([
			'zotero_get_reader_context',
			'workspace_read',
		]),
		agent: Object.freeze([
			'zotero_get_reader_context',
			'workspace_read',
			'workspace_write_drafts',
			'workspace_write_work',
			'knowledge_propose',
		]),
		prove: Object.freeze([
			'zotero_get_reader_context',
			'workspace_read',
			'workspace_write_drafts',
			'workspace_write_work',
			'knowledge_propose',
			'prove_trace_write',
			'http_whitelist',
		]),
	});
	
	function randomID(prefix) {
		return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
	}
	
	/**
	 * Cooperative cancel token for streaming turns. Providers may register a
	 * kill hook (e.g. subprocess SIGTERM); callers get `.cancel()` on the
	 * async iterator returned by AgentRuntime.startTurn.
	 */
	Zotero.QLab.createCancelToken = function () {
		let cancelled = false;
		let hooks = [];
		return {
			get cancelled() {
				return cancelled;
			},
			onCancel(fn) {
				if (typeof fn !== 'function') {
					return;
				}
				if (cancelled) {
					try {
						fn();
					}
					catch (_) {}
					return;
				}
				hooks.push(fn);
			},
			cancel() {
				if (cancelled) {
					return;
				}
				cancelled = true;
				for (let fn of hooks.splice(0)) {
					try {
						fn();
					}
					catch (_) {}
				}
			},
		};
	};
	
	/**
	 * @param {object} input
	 * @returns {object} ProveTurn
	 */
	Zotero.QLab.createProveTurn = function (input = {}) {
		let mode = MODES.includes(input.mode) ? input.mode : 'ask';
		let workspaceRoot = String(input.workspaceRoot || '').trim();
		if (mode !== 'ask' && !workspaceRoot) {
			throw new Error(`${mode} mode requires a workspaceRoot`);
		}
		
		let grants = Array.isArray(input.tools) && input.tools.length
			? input.tools.map(String)
			: DEFAULT_GRANTS[mode].slice();
		
		// Never grant knowledge_apply from a turn factory -- human Apply only.
		grants = grants.filter(tool => tool !== 'knowledge_apply');
		
		return Object.freeze({
			threadId: String(input.threadId || randomID('thread')),
			turnId: String(input.turnId || randomID('turn')),
			workspaceRoot,
			mode,
			tools: Object.freeze(grants),
			attachments: Object.freeze(
				Array.isArray(input.attachments)
					? input.attachments.map(ref => Object.freeze({ ...ref }))
					: []
			),
			providerId: input.providerId ? String(input.providerId) : null,
			model: input.model ? String(input.model) : null,
			createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
		});
	};
	
	Zotero.QLab.turnAllowsTool = function (turn, toolName) {
		if (!turn || !Array.isArray(turn.tools)) {
			return false;
		}
		return turn.tools.includes(toolName);
	};
	
	/**
	 * Normalize provider stream events into a closed set.
	 */
	Zotero.QLab.normalizeAgentEvent = function (raw) {
		if (!raw || typeof raw !== 'object') {
			return { type: 'error', message: 'Invalid agent event' };
		}
		let type = String(raw.type || '');
		switch (type) {
			case 'text-delta':
				return { type, text: String(raw.text || '') };
			case 'tool-call':
				return {
					type,
					callId: String(raw.callId || ''),
					name: String(raw.name || ''),
					arguments: raw.arguments && typeof raw.arguments === 'object'
						? raw.arguments
						: {},
				};
			case 'tool-result':
				return {
					type,
					callId: String(raw.callId || ''),
					ok: raw.ok !== false,
					result: raw.result,
				};
			case 'approval-needed':
				return {
					type,
					approvalId: String(raw.approvalId || randomID('approval')),
					reason: String(raw.reason || ''),
					tool: raw.tool ? String(raw.tool) : null,
				};
			case 'done':
				return {
					type,
					status: raw.status === 'cancelled' ? 'cancelled' : 'ok',
				};
			case 'error':
				return { type, message: String(raw.message || 'Unknown provider error') };
			default:
				return { type: 'error', message: `Unknown event type: ${type}` };
		}
	};
	
	/**
	 * Window- or process-scoped runtime. Owns threads; does not own credentials.
	 */
	Zotero.QLab.AgentRuntime = function (options = {}) {
		this._registry = options.registry || null;
		this._threads = new Map();
		this._activeProviderId = options.defaultProviderId || null;
	};
	
	Zotero.QLab.AgentRuntime.prototype = {
		setRegistry(registry) {
			this._registry = registry;
		},
		
		listProviders() {
			return this._registry ? this._registry.list() : [];
		},
		
		getActiveProviderId() {
			if (this._activeProviderId && this._registry
					&& this._registry.get(this._activeProviderId)) {
				return this._activeProviderId;
			}
			let listed = this.listProviders().filter(p => p.status === 'ready'
				|| p.status === 'stub');
			return listed.length ? listed[0].id : null;
		},
		
		setActiveProviderId(id) {
			if (!this._registry || !this._registry.get(id)) {
				throw new Error(`Unknown agent provider: ${id}`);
			}
			this._activeProviderId = id;
		},
		
		/**
		 * Start a turn against the selected provider.
		 * Returns an async iterable of normalized AgentEvents with a `.cancel()`
		 * method that cooperatively stops the stream and kills the subprocess
		 * when the provider registered a kill hook.
		 */
		startTurn(input = {}) {
			let cancelToken = input.cancelToken || Zotero.QLab.createCancelToken();
			let self = this;
			
			async function* events() {
				let providerId = input.providerId || self.getActiveProviderId();
				if (!providerId || !self._registry) {
					yield Zotero.QLab.normalizeAgentEvent({
						type: 'error',
						message: 'No agent provider is registered',
					});
					yield Zotero.QLab.normalizeAgentEvent({ type: 'done', status: 'cancelled' });
					return;
				}
				
				let provider = self._registry.get(providerId);
				if (!provider) {
					yield Zotero.QLab.normalizeAgentEvent({
						type: 'error',
						message: `Provider not found: ${providerId}`,
					});
					yield Zotero.QLab.normalizeAgentEvent({ type: 'done', status: 'cancelled' });
					return;
				}
				
				let turn;
				try {
					turn = Zotero.QLab.createProveTurn({
						...input,
						providerId,
					});
				}
				catch (e) {
					yield Zotero.QLab.normalizeAgentEvent({
						type: 'error',
						message: e.message || String(e),
					});
					yield Zotero.QLab.normalizeAgentEvent({ type: 'done', status: 'cancelled' });
					return;
				}
				
				self._threads.set(turn.threadId, {
					threadId: turn.threadId,
					providerId,
					mode: turn.mode,
					updatedAt: Date.now(),
				});
				
				let prompt = String(input.prompt || '');
				let stream;
				try {
					stream = provider.startTurn(turn, prompt, { cancelToken });
				}
				catch (e) {
					yield Zotero.QLab.normalizeAgentEvent({
						type: 'error',
						message: e.message || String(e),
					});
					yield Zotero.QLab.normalizeAgentEvent({ type: 'done', status: 'cancelled' });
					return;
				}
				
				for await (let raw of stream) {
					if (cancelToken.cancelled) {
						yield Zotero.QLab.normalizeAgentEvent({
							type: 'done',
							status: 'cancelled',
						});
						return;
					}
					let event = Zotero.QLab.normalizeAgentEvent(raw);
					if (event.type === 'tool-call'
							&& !Zotero.QLab.turnAllowsTool(turn, event.name)) {
						yield Zotero.QLab.normalizeAgentEvent({
							type: 'error',
							message: `Tool not granted for this turn: ${event.name}`,
						});
						continue;
					}
					yield event;
					if (event.type === 'done' || event.type === 'error') {
						// Keep draining only until a terminal event when cancelled mid-stream.
					}
				}
				
				if (cancelToken.cancelled) {
					yield Zotero.QLab.normalizeAgentEvent({
						type: 'done',
						status: 'cancelled',
					});
				}
			}
			
			let iterator = events();
			iterator.cancel = () => cancelToken.cancel();
			iterator.cancelToken = cancelToken;
			return iterator;
		},
		
		getThread(threadId) {
			return this._threads.get(threadId) || null;
		},
	};
	
	Zotero.QLab.AGENT_MODES = MODES;
	Zotero.QLab.DEFAULT_TOOL_GRANTS = DEFAULT_GRANTS;
})();
