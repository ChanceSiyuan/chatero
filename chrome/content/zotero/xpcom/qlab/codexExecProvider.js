/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Local Codex CLI provider via `codex exec --json`.
 * Full app-server / NativeBridge parity can replace this later without changing
 * AgentRuntime or the provider id (`codex-cli`).
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	function sandboxForTurn(turn) {
		if (turn.mode === 'ask' || Zotero.QLab.turnAllowsTool
				&& !Zotero.QLab.turnAllowsTool(turn, 'workspace_write_drafts')) {
			return 'read-only';
		}
		// Research Actions marked read-only should still force read-only sandbox.
		if (turn.attachments && turn.attachments.some(a => a.readOnly)) {
			return 'read-only';
		}
		return 'workspace-write';
	}
	
	/**
	 * Map one JSONL object from `codex exec --json` into AgentEvent(s).
	 * Schema is treated as soft: unknown shapes become text-delta.
	 */
	Zotero.QLab.mapCodexExecJsonLine = function (line) {
		let trimmed = String(line || '').trim();
		if (!trimmed) {
			return [];
		}
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		}
		catch (e) {
			return [{ type: 'text-delta', text: trimmed + '\n' }];
		}
		if (!parsed || typeof parsed !== 'object') {
			return [{ type: 'text-delta', text: trimmed + '\n' }];
		}
		
		let type = String(parsed.type || parsed.event || parsed.kind || '');
		if (/agent_message|message|text|assistant/i.test(type)
				|| typeof parsed.text === 'string'
				|| typeof parsed.delta === 'string'
				|| typeof parsed.content === 'string') {
			let text = parsed.text || parsed.delta || parsed.content
				|| (parsed.message && parsed.message.content)
				|| '';
			if (typeof text === 'string' && text) {
				return [{ type: 'text-delta', text }];
			}
		}
		if (/error|failed/i.test(type) || parsed.error) {
			return [{
				type: 'error',
				message: String(
					parsed.message
					|| parsed.error?.message
					|| parsed.error
					|| trimmed
				),
			}];
		}
		if (/approval|confirm/i.test(type)) {
			return [{
				type: 'approval-needed',
				approvalId: String(parsed.id || parsed.approvalId || 'codex'),
				reason: String(parsed.reason || parsed.message || 'Codex requests approval'),
				tool: parsed.tool ? String(parsed.tool) : null,
			}];
		}
		if (/done|completed|turn\.completed|session\.completed/i.test(type)) {
			return [{ type: 'done', status: 'ok' }];
		}
		// Keep a breadcrumb for unrecognized structured events.
		let label = type || 'event';
		return [{ type: 'text-delta', text: `[codex:${label}]\n` }];
	};
	
	Zotero.QLab.buildCodexExecArgv = function (turn, prompt, { executable, model } = {}) {
		let exe = executable || 'codex';
		let args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never'];
		let sandbox = sandboxForTurn(turn);
		args.push('-s', sandbox);
		let modelId = model || (turn && turn.model) || '';
		if (modelId) {
			args.push('-m', String(modelId));
		}
		if (turn.workspaceRoot) {
			args.push('-C', turn.workspaceRoot);
		}
		if (sandbox === 'workspace-write' && turn.workspaceRoot) {
			// Keep generated state writable beside drafts/literature.
			args.push('--add-dir', `${turn.workspaceRoot.replace(/\/$/, '')}/work`);
		}
		args.push('--');
		args.push(String(prompt || ''));
		return { command: exe, args, sandbox };
	};
	
	/**
	 * @param {{
	 *   discover?: () => Promise<string|null>,
	 *   runner?: { run: Function },
	 * }} [deps]
	 */
	Zotero.QLab.createCodexCliProvider = function (deps = {}) {
		// Revalidation window for a memoized executable path. refreshStatus() runs
		// before every send and again in each turn's `finally`, so a full PATH scan
		// per call is pure overhead once the binary has been located.
		const STATUS_TTL_MS = 30_000;
		let cachedExe = null;
		let cachedStatus = 'stub';
		let cachedAt = 0;
		
		function discoveryHost() {
			return typeof IOUtils !== 'undefined'
				? Zotero.QLab.createGeckoCodexDiscoveryHost()
				: {};
		}
		
		async function resolveExe() {
			if (cachedExe) {
				return cachedExe;
			}
			let discover = deps.discover
				|| (() => Zotero.QLab.discoverCodexExecutable(discoveryHost()));
			cachedExe = await discover();
			cachedStatus = cachedExe ? 'ready' : 'unavailable';
			cachedAt = Date.now();
			return cachedExe;
		}
		
		/**
		 * Confirm a memoized path is still on disk without re-walking PATH.
		 * Returns false when no cheap existence check is available, which makes the
		 * caller fall back to full discovery.
		 */
		async function cachedExeStillPresent() {
			let exists = deps.exists || discoveryHost().exists;
			if (typeof exists !== 'function') {
				return false;
			}
			try {
				return !!(await exists(cachedExe));
			}
			catch {
				return false;
			}
		}
		
		return {
			id: 'codex-cli',
			label: 'Local Codex CLI',
			kind: 'local-cli',
			optional: false,
			get status() {
				return cachedStatus;
			},
			capabilities: Object.freeze({
				tools: true,
				vision: true,
				streaming: true,
				remote: false,
			}),
			async refreshStatus() {
				// A missing binary is never cached, so installing Codex mid-session is
				// still picked up on the next call. A located binary is revalidated
				// cheaply, and only a vanished path triggers rediscovery.
				if (cachedExe) {
					if (Date.now() - cachedAt < STATUS_TTL_MS) {
						return cachedStatus;
					}
					if (await cachedExeStillPresent()) {
						cachedAt = Date.now();
						return cachedStatus;
					}
					cachedExe = null;
				}
				await resolveExe();
				return cachedStatus;
			},
			async *startTurn(turn, prompt, options = {}) {
				let cancelToken = options.cancelToken || null;
				let exe = await resolveExe();
				if (!exe) {
					yield {
						type: 'error',
						message: 'Codex CLI was not found on PATH. Install Codex, then retry.',
					};
					yield { type: 'done', status: 'cancelled' };
					return;
				}
				
				let runner = deps.runner;
				if (!runner) {
					if (typeof ChromeUtils !== 'undefined' && Zotero.QLab.createGeckoProcessRunner) {
						runner = Zotero.QLab.createGeckoProcessRunner();
					}
				}
				if (!runner) {
					yield {
						type: 'error',
						message: 'No process runner is available for Codex exec in this environment.',
					};
					yield { type: 'done', status: 'cancelled' };
					return;
				}
				
				let { command, args, sandbox } = Zotero.QLab.buildCodexExecArgv(turn, prompt, {
					executable: exe,
					model: turn.model,
				});
				yield {
					type: 'text-delta',
					text: `[codex-cli] sandbox=${sandbox} cwd=${turn.workspaceRoot || '(none)'}\n`,
				};
				
				if (cancelToken && cancelToken.cancelled) {
					yield { type: 'done', status: 'cancelled' };
					return;
				}
				
				let sawDone = false;
				let exitCode = null;
				let killed = false;
				try {
					for await (let event of runner.run(command, args, {
						cwd: turn.workspaceRoot || undefined,
						env: { NO_COLOR: '1' },
						registerKill: (kill) => {
							if (cancelToken && cancelToken.onCancel) {
								cancelToken.onCancel(() => {
									killed = true;
									kill();
								});
							}
						},
					})) {
						if (cancelToken && cancelToken.cancelled) {
							killed = true;
							yield { type: 'done', status: 'cancelled' };
							return;
						}
						if (event.type === 'stdout') {
							for (let mapped of Zotero.QLab.mapCodexExecJsonLine(event.data)) {
								if (mapped.type === 'done') {
									sawDone = true;
								}
								yield mapped;
							}
						}
						else if (event.type === 'stderr' && event.data) {
							yield { type: 'text-delta', text: `[codex:stderr] ${event.data}\n` };
						}
						else if (event.type === 'exit') {
							exitCode = event.exitCode;
						}
					}
				}
				catch (e) {
					if (killed || (cancelToken && cancelToken.cancelled)) {
						yield { type: 'done', status: 'cancelled' };
						return;
					}
					yield {
						type: 'error',
						message: e.message || String(e),
					};
					yield { type: 'done', status: 'cancelled' };
					return;
				}
				
				if (killed || (cancelToken && cancelToken.cancelled)) {
					yield { type: 'done', status: 'cancelled' };
					return;
				}
				
				if (!sawDone) {
					if (exitCode && exitCode !== 0) {
						yield {
							type: 'error',
							message: `codex exec exited with code ${exitCode}`,
						};
						yield { type: 'done', status: 'cancelled' };
					}
					else {
						yield { type: 'done', status: 'ok' };
					}
				}
			},
		};
	};
})();
