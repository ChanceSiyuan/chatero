/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Chance Siyuan / Chatero contributors

	This file is part of Chatero (a Zotero fork).

	***** END LICENSE BLOCK *****
*/

/**
 * Per-repository supervisor for the local Research Loop main site.
 *
 * The service is deliberately UI-free. Network probes, dependency discovery,
 * process execution, ports, and time are injected so callers can keep setup
 * explicit and unit tests never need a real server or repository.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const HOST = '127.0.0.1';
	const PREFERRED_PORT = 4180;
	const FIRST_FALLBACK_PORT = 4181;
	const LAST_FALLBACK_PORT = 4199;
	const MINIMUM_NODE = Object.freeze([22, 13, 0]);
	const IDENTITY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	const STATES = new Set([
		'idle', 'checking', 'installing', 'building', 'starting',
		'ready', 'stale', 'stopping', 'error',
	]);

	function siteURL(port) {
		return `http://${HOST}:${port}/`;
	}

	function plainSnapshot(record) {
		return Object.freeze({
			identity: record.identity,
			root: record.root,
			state: record.state,
			url: record.url,
			lastGoodURL: record.lastGoodURL,
			port: record.port,
			ownership: record.ownership,
			diagnosticTail: record.diagnosticTail,
			error: record.error,
			updatedAt: record.updatedAt,
		});
	}

	function parseNodeVersion(value) {
		let match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
		return match ? match.slice(1).map(Number) : null;
	}

	function nodeVersionIsSupported(value) {
		let parsed = parseNodeVersion(value);
		if (!parsed) return false;
		for (let index = 0; index < MINIMUM_NODE.length; index++) {
			if (parsed[index] > MINIMUM_NODE[index]) return true;
			if (parsed[index] < MINIMUM_NODE[index]) return false;
		}
		return true;
	}

	function requireAbsoluteExecutable(value, label) {
		let command = String(value || '');
		if (!command.startsWith('/') || command.includes('\0') || /[\r\n]/.test(command)) {
			throw new Error(`${label} executable must be an absolute path`);
		}
		return command;
	}

	function healthMatches(payload, identity) {
		return !!payload
			&& payload.ok === true
			&& payload.repositoryIdentity === identity;
	}

	Zotero.QLab.createMainSiteService = function (runtime = {}) {
		if (!runtime.processRunner || typeof runtime.processRunner.run !== 'function') {
			throw new Error('Main Site service requires a process runner');
		}
		for (let method of ['fetchHealth', 'isPortAvailable', 'resolveDependencies']) {
			if (typeof runtime[method] !== 'function') {
				throw new Error(`Main Site service requires ${method}()`);
			}
		}

		let records = new Map();
		let shuttingDown = false;
		let now = typeof runtime.now === 'function' ? runtime.now : Date.now;
		let sleep = typeof runtime.sleep === 'function'
			? runtime.sleep
			: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
		let maxDiagnosticChars = Math.max(64, Number(runtime.maxDiagnosticChars) || 24000);
		let startupPollAttempts = Math.max(1, Number(runtime.startupPollAttempts) || 180);
		let startupPollIntervalMs = Math.max(0, Number(runtime.startupPollIntervalMs) || 1000);
		let shutdownTimeoutMs = Math.max(1, Number(runtime.shutdownTimeoutMs) || 5000);

		function get(identity) {
			let key = String(identity || '');
			if (!records.has(key)) {
				records.set(key, {
					identity: key,
					root: '',
					state: 'idle',
					url: '',
					lastGoodURL: '',
					port: null,
					ownership: null,
					diagnosticTail: '',
					error: null,
					updatedAt: now(),
					listeners: new Set(),
					inFlight: null,
					process: null,
					processPump: null,
					processExit: undefined,
					activeStream: null,
					cancelRequested: false,
				});
			}
			return records.get(key);
		}

		function publish(record) {
			record.updatedAt = now();
			let snapshot = plainSnapshot(record);
			for (let listener of [...record.listeners]) {
				try { listener(snapshot); }
				catch (error) { Zotero.logError && Zotero.logError(error); }
			}
			return snapshot;
		}

		function transition(record, state, changes = {}) {
			if (!STATES.has(state)) throw new Error(`Unknown Main Site state: ${state}`);
			Object.assign(record, changes, { state });
			return publish(record);
		}

		function appendDiagnostic(record, channel, value) {
			let text = String(value || '').replace(/\r\n?/g, '\n').trimEnd();
			if (!text) return;
			let next = `${record.diagnosticTail}${record.diagnosticTail ? '\n' : ''}[${channel}] ${text}`;
			record.diagnosticTail = next.slice(-maxDiagnosticChars);
			publish(record);
		}

		async function resolveTarget(input) {
			let identity = String(input && input.identity || '').toLowerCase();
			if (!IDENTITY_PATTERN.test(identity)) {
				throw new Error('Main Site target requires a valid repository identity');
			}
			let suppliedRoot = String(input && input.root || '');
			let root = typeof runtime.canonicalizeRoot === 'function'
				? await runtime.canonicalizeRoot(suppliedRoot)
				: suppliedRoot;
			root = String(root || '').replace(/\/+$/, '');
			if (!root.startsWith('/') || root.includes('\0') || /[\r\n]/.test(root)) {
				throw new Error('Main Site cwd must be an absolute canonical path');
			}
			return Object.freeze({ identity, root });
		}

		async function probe(url) {
			try {
				let value = await runtime.fetchHealth(url);
				return value && typeof value === 'object' ? value : null;
			}
			catch (error) {
				return null;
			}
		}

		async function selectPort(preferredHealth) {
			if (!preferredHealth && await runtime.isPortAvailable(PREFERRED_PORT, HOST)) {
				return PREFERRED_PORT;
			}
			for (let port = FIRST_FALLBACK_PORT; port <= LAST_FALLBACK_PORT; port++) {
				if (await runtime.isPortAvailable(port, HOST)) return port;
			}
			throw new Error('No available loopback port in the bounded range 4181 through 4199');
		}

		async function dependencies() {
			let resolved = await runtime.resolveDependencies();
			if (!resolved || !resolved.node || !nodeVersionIsSupported(resolved.node.version)) {
				throw new Error('Research Loop requires Node.js 22.13.0 or newer');
			}
			let node = requireAbsoluteExecutable(resolved.node.command, 'Node.js');
			let npm = resolved.npm && requireAbsoluteExecutable(resolved.npm.command, 'npm');
			if (!npm) throw new Error('Research Loop requires npm');
			let quarto = resolved.quarto && requireAbsoluteExecutable(resolved.quarto.command, 'Quarto');
			if (!quarto) throw new Error('Research Loop requires Quarto');
			return Object.freeze({ node, npm, quarto });
		}

		async function runFiniteStage(record, state, command, args, options) {
			transition(record, state, { error: null });
			let stream = runtime.processRunner.run(command, args, options);
			record.activeStream = stream;
			let exitCode = null;
			try {
				for await (let event of stream) {
					if (event.type === 'stdout' || event.type === 'stderr') {
						appendDiagnostic(record, event.type, event.data);
					}
					else if (event.type === 'exit') {
						exitCode = event.exitCode;
					}
					if (record.cancelRequested) {
						if (stream && typeof stream.cancel === 'function') stream.cancel();
						throw new Error('Main Site operation was cancelled');
					}
				}
			}
			finally {
				if (record.activeStream === stream) record.activeStream = null;
			}
			if (exitCode !== 0) {
				let detail = record.diagnosticTail.trim();
				throw new Error(detail || `Main Site process exited with code ${exitCode ?? 'unknown'}`);
			}
		}

		function pumpServer(record, stream) {
			record.processExit = undefined;
			let pump = (async () => {
				try {
					for await (let event of stream) {
						if (event.type === 'stdout' || event.type === 'stderr') {
							appendDiagnostic(record, event.type, event.data);
						}
						else if (event.type === 'exit') {
							record.processExit = event.exitCode;
						}
					}
				}
				catch (error) {
					record.processExit = null;
					appendDiagnostic(record, 'stderr', error.message || String(error));
				}
				if (record.state === 'ready' && record.ownership === 'owned') {
					transition(record, 'stale', {
						error: 'The Main Site process exited unexpectedly',
					});
				}
			})();
			record.processPump = pump;
			return pump;
		}

		async function launch(record, target, npm, port) {
			transition(record, 'starting', {
				port,
				url: siteURL(port),
				ownership: 'owned',
				error: null,
			});
			let stream = runtime.processRunner.run(npm, [
				'run', 'start', '--', '--hostname', HOST, '--port', String(port),
			], {
				cwd: target.root,
				env: { QLAB_REPOSITORY_ID: target.identity },
			});
			record.process = stream;
			pumpServer(record, stream);
			for (let attempt = 0; attempt < startupPollAttempts; attempt++) {
				let health = await probe(record.url);
				if (healthMatches(health, target.identity)) {
					record.lastGoodURL = record.url;
					return transition(record, 'ready', { error: null });
				}
				if (record.cancelRequested) throw new Error('Main Site operation was cancelled');
				if (record.processExit !== undefined) {
					let detail = record.diagnosticTail.trim();
					throw new Error(detail || `Main Site process exited with code ${record.processExit ?? 'unknown'}`);
				}
				await sleep(startupPollIntervalMs);
			}
			throw new Error('Main Site startup timed out before repository health became ready');
		}

		async function performStart(record, input) {
			let target = await resolveTarget(input);
			record.root = target.root;
			if (record.cancelRequested) throw new Error('Main Site operation was cancelled');
			transition(record, 'checking', { error: null });
			if (record.url) {
				let knownHealth = await probe(record.url);
				if (healthMatches(knownHealth, target.identity)) {
					record.lastGoodURL = record.url;
					return transition(record, 'ready', { error: null });
				}
			}
			let preferredURL = siteURL(PREFERRED_PORT);
			let preferredHealth = await probe(preferredURL);
			if (healthMatches(preferredHealth, target.identity)) {
				record.lastGoodURL = preferredURL;
				return transition(record, 'ready', {
					url: preferredURL,
					port: PREFERRED_PORT,
					ownership: 'external',
					error: null,
				});
			}
			let port = await selectPort(preferredHealth);
			let resolved = await dependencies();
			await runFiniteStage(record, 'installing', resolved.npm, ['ci'], { cwd: target.root });
			await runFiniteStage(record, 'building', resolved.npm, ['run', 'build'], { cwd: target.root });
			return launch(record, target, resolved.npm, port);
		}

		function trackedOperation(record, operation) {
			let promise = (async () => {
				try {
					return await operation();
				}
				catch (error) {
					if (record.process && record.state === 'starting'
							&& typeof record.process.cancel === 'function') {
						record.process.cancel();
					}
					if (record.cancelRequested) {
						transition(record, 'idle', {
							ownership: null,
							port: null,
							url: record.lastGoodURL || '',
							error: null,
						});
					}
					else {
						transition(record, 'error', {
							url: record.lastGoodURL || '',
							error: error && error.message ? error.message : String(error),
						});
					}
					throw error;
				}
			})();
			record.inFlight = promise;
			promise.then(
				() => { if (record.inFlight === promise) record.inFlight = null; },
				() => { if (record.inFlight === promise) record.inFlight = null; }
			);
			return promise;
		}

		let service = {
			observe(identity, listener) {
				if (typeof listener !== 'function') throw new Error('Main Site observer requires a listener');
				let record = get(identity);
				record.listeners.add(listener);
				listener(plainSnapshot(record));
				return () => record.listeners.delete(listener);
			},
			snapshot(identity) {
				return plainSnapshot(get(identity));
			},
			async check(input) {
				let target = await resolveTarget(input);
				let record = get(target.identity);
				record.root = target.root;
				if (record.inFlight) return plainSnapshot(record);
				transition(record, 'checking', { error: null });
				if (record.url) {
					let knownHealth = await probe(record.url);
					if (healthMatches(knownHealth, target.identity)) {
						record.lastGoodURL = record.url;
						return transition(record, 'ready', { error: null });
					}
				}
				let url = siteURL(PREFERRED_PORT);
				let health = await probe(url);
				if (healthMatches(health, target.identity)) {
					record.lastGoodURL = url;
					return transition(record, 'ready', {
						url,
						port: PREFERRED_PORT,
						ownership: 'external',
					});
				}
				return transition(record, record.lastGoodURL ? 'stale' : 'idle', {
					url: record.lastGoodURL || '',
					port: record.process ? record.port : null,
					ownership: record.process ? 'owned' : null,
				});
			},
			start(input) {
				let identity = String(input && input.identity || '').toLowerCase();
				let record = get(identity);
				if (record.inFlight) return record.inFlight;
				if (shuttingDown) return Promise.reject(new Error('Main Site service is shutting down'));
				record.cancelRequested = false;
				return trackedOperation(record, () => performStart(record, input));
			},
			rebuild(input) {
				let identity = String(input && input.identity || '').toLowerCase();
				let record = get(identity);
				if (record.inFlight) return record.inFlight;
				if (shuttingDown) return Promise.reject(new Error('Main Site service is shutting down'));
				record.cancelRequested = false;
				return trackedOperation(record, async () => {
					let target = await resolveTarget(input);
					record.root = target.root;
					if (record.cancelRequested) throw new Error('Main Site operation was cancelled');
					transition(record, 'stale', { error: null });
					let resolved = await dependencies();
					await runFiniteStage(record, 'installing', resolved.npm, ['ci'], { cwd: target.root });
					await runFiniteStage(record, 'building', resolved.npm, ['run', 'build'], { cwd: target.root });
					let url = record.lastGoodURL || siteURL(PREFERRED_PORT);
					if (healthMatches(await probe(url), target.identity)) {
						return transition(record, 'ready', { url, error: null });
					}
					let port = record.port || PREFERRED_PORT;
					return launch(record, target, resolved.npm, port);
				});
			},
			async stop(identity) {
				let record = get(identity);
				if (record.ownership !== 'owned' && !record.inFlight) return plainSnapshot(record);
				record.cancelRequested = true;
				transition(record, 'stopping', { error: null });
				let active = record.activeStream || record.process;
				if (active && typeof active.cancel === 'function') active.cancel();
				if (record.inFlight) {
					try { await record.inFlight; }
					catch (error) {}
				}
				if (record.process && record.process !== active
						&& typeof record.process.cancel === 'function') {
					record.process.cancel();
				}
				if (record.process && typeof record.process.waitForExit === 'function') {
					try { await record.process.waitForExit(shutdownTimeoutMs); }
					catch (error) { appendDiagnostic(record, 'stderr', error.message || String(error)); }
				}
				record.process = null;
				record.processPump = null;
				record.activeStream = null;
				return transition(record, 'idle', {
					url: record.lastGoodURL || '',
					port: null,
					ownership: null,
					error: null,
				});
			},
			async shutdown() {
				shuttingDown = true;
				for (let record of records.values()) {
					if (record.ownership === 'owned' || record.inFlight) {
						await service.stop(record.identity);
					}
				}
			},
		};
		return Object.freeze(service);
	};
})();
