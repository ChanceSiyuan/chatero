/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Pluggable AgentProvider registry.
 *
 * Local path is the product default. Remote execution (including former SSH)
 * is an optional provider slot -- not part of the core daily-path narrative.
 * Credentials never live in this module.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	async function* stubStream(message, extra = {}) {
		yield { type: 'text-delta', text: message };
		if (extra.approvalNeeded) {
			yield {
				type: 'approval-needed',
				approvalId: 'stub',
				reason: extra.approvalNeeded,
				tool: extra.tool || null,
			};
		}
		yield { type: 'done', status: 'ok' };
	}
	
	function defineProvider(descriptor) {
		let capabilities = Object.freeze({
			tools: !!(descriptor.capabilities && descriptor.capabilities.tools),
			vision: !!(descriptor.capabilities && descriptor.capabilities.vision),
			streaming: !(descriptor.capabilities && descriptor.capabilities.streaming === false),
			remote: !!(descriptor.capabilities && descriptor.capabilities.remote),
		});
		let provider = {
			id: descriptor.id,
			label: descriptor.label,
			kind: descriptor.kind,
			optional: !!descriptor.optional,
			capabilities,
			startTurn: descriptor.startTurn.bind
				? descriptor.startTurn.bind(descriptor)
				: descriptor.startTurn,
		};
		let statusDesc = Object.getOwnPropertyDescriptor(descriptor, 'status');
		if (statusDesc && typeof statusDesc.get === 'function') {
			Object.defineProperty(provider, 'status', {
				enumerable: true,
				configurable: false,
				get: () => descriptor.status,
			});
		}
		else {
			provider.status = descriptor.status || 'stub';
		}
		if (typeof descriptor.refreshStatus === 'function') {
			provider.refreshStatus = () => descriptor.refreshStatus();
		}
		return provider;
	}
	
	function builtinStaticProviders() {
		return [
			defineProvider({
				id: 'openai-compat',
				label: 'OpenAI-compatible API',
				kind: 'http',
				status: 'stub',
				capabilities: { tools: true, vision: true, streaming: true },
				async *startTurn(turn, prompt) {
					yield* stubStream(
						`[openai-compat stub] mode=${turn.mode}. `
						+ 'Keys must live in Keychain/sidecar -- never in Zotero prefs. '
						+ `promptChars=${String(prompt || '').length}.`
					);
				},
			}),
			defineProvider({
				id: 'prove-harness',
				label: 'Prove harness (personal)',
				kind: 'sidecar',
				status: 'stub',
				capabilities: { tools: true, vision: true, streaming: true },
				async *startTurn(turn, _prompt) {
					if (turn.mode !== 'prove' && turn.mode !== 'agent' && turn.mode !== 'ask') {
						yield { type: 'error', message: 'Unsupported mode for prove-harness' };
						yield { type: 'done', status: 'cancelled' };
						return;
					}
					yield* stubStream(
						`[prove-harness stub] trace under work/prove/<run-id>/. `
						+ 'Evidence refs required for material claims.',
						turn.mode === 'prove'
							? {
								approvalNeeded: 'Whitelist HTTP / experiment tools per run',
								tool: 'http_whitelist',
							}
							: undefined
					);
				},
			}),
			defineProvider({
				id: 'remote-execution',
				label: 'Remote execution (optional)',
				kind: 'remote',
				optional: true,
				status: 'deferred',
				capabilities: {
					tools: true,
					vision: false,
					streaming: true,
					remote: true,
				},
				async *startTurn(_turn, _prompt) {
					yield {
						type: 'error',
						message: 'Remote execution is optional and deferred. '
							+ 'SSH/Codex-remote is one future backend for this slot, not a core requirement.',
					};
					yield { type: 'done', status: 'cancelled' };
				},
			}),
		];
	}
	
	Zotero.QLab.AgentProviderRegistry = function (providers) {
		this._providers = new Map();
		for (let provider of providers || []) {
			this.register(provider);
		}
	};
	
	Zotero.QLab.AgentProviderRegistry.prototype = {
		register(provider) {
			if (!provider || !provider.id || typeof provider.startTurn !== 'function') {
				throw new Error('AgentProvider requires id and startTurn()');
			}
			// Live providers (e.g. codex-cli) keep dynamic status getters.
			if (provider.capabilities && Object.isFrozen(provider.capabilities)
					&& (Object.getOwnPropertyDescriptor(provider, 'status')?.get
						|| provider.refreshStatus)) {
				this._providers.set(provider.id, provider);
				return;
			}
			this._providers.set(provider.id, defineProvider(provider));
		},
		
		get(id) {
			return this._providers.get(id) || null;
		},
		
		list({ includeOptional = true } = {}) {
			let out = [];
			for (let provider of this._providers.values()) {
				if (!includeOptional && provider.optional) {
					continue;
				}
				out.push({
					id: provider.id,
					label: provider.label,
					kind: provider.kind,
					optional: provider.optional,
					status: provider.status,
					capabilities: { ...provider.capabilities },
				});
			}
			return out;
		},
		
		listCore() {
			return this.list({ includeOptional: false });
		},
	};
	
	/**
	 * @param {{
	 *   codex?: { discover?: Function, runner?: object },
	 * }} [deps]
	 */
	Zotero.QLab.createDefaultProviderRegistry = function (deps = {}) {
		let codex = Zotero.QLab.createCodexCliProvider
			? Zotero.QLab.createCodexCliProvider(deps.codex || {})
			: defineProvider({
				id: 'codex-cli',
				label: 'Local Codex CLI',
				kind: 'local-cli',
				status: 'unavailable',
				capabilities: { tools: true, vision: true, streaming: true },
				async *startTurn() {
					yield { type: 'error', message: 'Codex provider factory missing' };
					yield { type: 'done', status: 'cancelled' };
				},
			});
		return new Zotero.QLab.AgentProviderRegistry([
			codex,
			...builtinStaticProviders(),
		]);
	};
	
	Zotero.QLab.BUILTIN_AGENT_PROVIDERS = Object.freeze([
		'codex-cli',
		'openai-compat',
		'prove-harness',
		'remote-execution',
	]);
})();
