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
					operationTargetPromise: null,
					requestedRoot: '',
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

		function assertNotCancelled(record) {
			if (record.cancelRequested) throw new Error('Main Site operation was cancelled');
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

		function pinTarget(record, target) {
			if (record.root && record.root !== target.root) {
				let error = new Error('A repository identity cannot be used with a different canonical root');
				error.code = 'QLAB_TARGET_CONFLICT';
				throw error;
			}
			if (!record.root) record.root = target.root;
			return target;
		}

		function joinInFlight(record, input) {
			if (record.requestedRoot === String(input && input.root || '')) {
				return record.inFlight;
			}
			let activeTarget = record.operationTargetPromise;
			let activeOperation = record.inFlight;
			return (async () => {
				let [candidate, pinned] = await Promise.all([
					resolveTarget(input),
					activeTarget,
				]);
				if (!pinned || candidate.identity !== pinned.identity || candidate.root !== pinned.root) {
					let error = new Error('A repository identity cannot be used with a different canonical root');
					error.code = 'QLAB_TARGET_CONFLICT';
					throw error;
				}
				return activeOperation;
			})();
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

		async function selectReplacementPort(previousPort) {
			if (Number.isInteger(previousPort)
					&& previousPort >= PREFERRED_PORT
					&& previousPort <= LAST_FALLBACK_PORT
					&& await runtime.isPortAvailable(previousPort, HOST)) {
				return previousPort;
			}
			let preferredHealth = await probe(siteURL(PREFERRED_PORT));
			return selectPort(preferredHealth);
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
			assertNotCancelled(record);
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

		async function retireOwnedProcess(record) {
			if (record.ownership !== 'owned') return;
			let process = record.process;
			if (!process || typeof process.cancel !== 'function'
					|| typeof process.waitForExit !== 'function') {
				throw new Error('Owned Main Site process cannot be safely stopped');
			}
			transition(record, 'stopping', { error: null });
			process.cancel();
			try {
				await process.waitForExit(shutdownTimeoutMs);
			}
			catch (error) {
				appendDiagnostic(record, 'stderr', error.message || String(error));
				transition(record, 'error', {
					error: error && error.message ? error.message : String(error),
				});
				throw error;
			}
			if (record.process !== process) {
				throw new Error('Owned Main Site process changed while it was stopping');
			}
			record.process = null;
			record.processPump = null;
			record.processExit = undefined;
			record.port = null;
			record.ownership = null;
			publish(record);
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
			assertNotCancelled(record);
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

		async function performStart(record, targetPromise) {
			let target = pinTarget(record, await targetPromise);
			assertNotCancelled(record);
			transition(record, 'checking', { error: null });
			if (record.url) {
				let knownHealth = await probe(record.url);
				if (healthMatches(knownHealth, target.identity)) {
					record.lastGoodURL = record.url;
					return transition(record, 'ready', { error: null });
				}
			}
			if (record.ownership === 'owned') await retireOwnedProcess(record);
			assertNotCancelled(record);
			let preferredURL = siteURL(PREFERRED_PORT);
			let preferredHealth = await probe(preferredURL);
			assertNotCancelled(record);
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
			assertNotCancelled(record);
			let resolved = await dependencies();
			assertNotCancelled(record);
			await runFiniteStage(record, 'installing', resolved.npm, ['ci'], { cwd: target.root });
			await runFiniteStage(record, 'building', resolved.npm, ['run', 'build'], { cwd: target.root });
			return launch(record, target, resolved.npm, port);
		}

		function trackedOperation(record, operation, targetPromise, requestedRoot) {
			let promise = (async () => {
				try {
					return await operation();
				}
				catch (error) {
					if (error && error.code === 'QLAB_TARGET_CONFLICT') throw error;
					if (record.process && record.state === 'starting'
							&& typeof record.process.cancel === 'function') {
						record.process.cancel();
					}
					if (record.cancelRequested) {
						transition(record, 'idle', {
							ownership: record.process ? 'owned' : null,
							port: record.process ? record.port : null,
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
			record.operationTargetPromise = targetPromise;
			record.requestedRoot = requestedRoot;
			promise.then(
				() => {
					if (record.inFlight !== promise) return;
					record.inFlight = null;
					record.operationTargetPromise = null;
					record.requestedRoot = '';
				},
				() => {
					if (record.inFlight !== promise) return;
					record.inFlight = null;
					record.operationTargetPromise = null;
					record.requestedRoot = '';
				}
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
				if (record.inFlight) {
					let active = await record.operationTargetPromise;
					if (!active || active.root !== target.root) {
						throw new Error('A repository identity cannot be used with a different canonical root');
					}
					return plainSnapshot(record);
				}
				pinTarget(record, target);
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
				if (record.inFlight) return joinInFlight(record, input);
				if (shuttingDown) return Promise.reject(new Error('Main Site service is shutting down'));
				record.cancelRequested = false;
				let requestedRoot = String(input && input.root || '');
				let targetPromise = resolveTarget(input);
				return trackedOperation(
					record,
					() => performStart(record, targetPromise),
					targetPromise,
					requestedRoot
				);
			},
			rebuild(input) {
				let identity = String(input && input.identity || '').toLowerCase();
				let record = get(identity);
				if (record.inFlight) return joinInFlight(record, input);
				if (shuttingDown) return Promise.reject(new Error('Main Site service is shutting down'));
				record.cancelRequested = false;
				let requestedRoot = String(input && input.root || '');
				let targetPromise = resolveTarget(input);
				return trackedOperation(record, async () => {
					let target = pinTarget(record, await targetPromise);
					assertNotCancelled(record);
					transition(record, 'stale', { error: null });
					let rebuildsOwnedProcess = record.ownership === 'owned';
					let previousOwnedPort = rebuildsOwnedProcess ? record.port : null;
					let currentHealth = record.url ? await probe(record.url) : null;
					if (!healthMatches(currentHealth, target.identity)
							&& record.ownership === 'owned') {
						await retireOwnedProcess(record);
					}
					assertNotCancelled(record);
					let resolved = await dependencies();
					assertNotCancelled(record);
					await runFiniteStage(record, 'installing', resolved.npm, ['ci'], { cwd: target.root });
					await runFiniteStage(record, 'building', resolved.npm, ['run', 'build'], { cwd: target.root });
					if (rebuildsOwnedProcess) {
						if (record.ownership === 'owned') await retireOwnedProcess(record);
						assertNotCancelled(record);
						let port = await selectReplacementPort(previousOwnedPort);
						assertNotCancelled(record);
						return launch(record, target, resolved.npm, port);
					}
					let url = record.lastGoodURL || siteURL(PREFERRED_PORT);
					if (healthMatches(await probe(url), target.identity)) {
						return transition(record, 'ready', { url, error: null });
					}
					if (record.ownership === 'owned') await retireOwnedProcess(record);
					assertNotCancelled(record);
					let preferredURL = siteURL(PREFERRED_PORT);
					let preferredHealth = await probe(preferredURL);
					assertNotCancelled(record);
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
					assertNotCancelled(record);
					return launch(record, target, resolved.npm, port);
				}, targetPromise, requestedRoot);
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
				if (record.ownership === 'owned') {
					await retireOwnedProcess(record);
				}
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
						try { await service.stop(record.identity); }
						catch (error) {}
					}
				}
			},
		};
		return Object.freeze(service);
	};
})();
