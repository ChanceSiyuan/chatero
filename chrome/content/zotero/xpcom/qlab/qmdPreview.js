/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Quarto live website preview for the Website surface.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const PREVIEW_PORT_MIN = 43000;
	const PREVIEW_PORT_SPAN = 1500;
	const QUARTO_MAC_CANDIDATES = [
		'/usr/local/bin/quarto',
		'/opt/homebrew/bin/quarto',
		'/Applications/quarto/bin/quarto',
	];
	
	function hash(value) {
		let total = 5381;
		for (let i = 0; i < String(value).length; i++) {
			total = ((total * 33) ^ String(value).charCodeAt(i)) >>> 0;
		}
		return total;
	}
	
	function joinWorkspacePath(root, rel) {
		let base = String(root || '').replace(/[/\\]+$/, '');
		let normalized = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
		return `${base}/${normalized}`;
	}

	Zotero.QLab.qmdQuartoPagePath = function (relativeFile) {
		let within = String(relativeFile || '').replace(/\\/g, '/').replace(/^\/+/, '');
		if (within === 'index.qmd') return '/';
		if (within.endsWith('/index.qmd')) {
			return `/${within.slice(0, -'index.qmd'.length)}`;
		}
		return `/${within.slice(0, -'.qmd'.length)}.html`;
	};
	
	/**
	 * Quarto preview cwd + file argument for a workspace-relative QMD path.
	 * Drafts preview from drafts/ with the note-relative path, matching quarto-lab.
	 */
	Zotero.QLab.resolveQuartoPreviewTarget = function (root, relativePath) {
		let rel = String(relativePath || '').replace(/\\/g, '/');
		if (!rel.endsWith('.qmd')) {
			throw new Error('Quarto preview requires a .qmd path');
		}
		if (rel.startsWith('drafts/')) {
			let file = rel.slice('drafts/'.length);
			return {
				cwd: joinWorkspacePath(root, 'drafts'),
				file,
				page: Zotero.QLab.qmdQuartoPagePath(file),
			};
		}
		if (rel.includes('/')) {
			let slash = rel.lastIndexOf('/');
			let file = rel.slice(slash + 1);
			return {
				cwd: joinWorkspacePath(root, rel.slice(0, slash)),
				file,
				page: Zotero.QLab.qmdQuartoPagePath(file),
			};
		}
		return {
			cwd: root,
			file: rel,
			page: Zotero.QLab.qmdQuartoPagePath(rel),
		};
	};
	
	Zotero.QLab.nextQmdPreviewPort = function (seed) {
		return PREVIEW_PORT_MIN + (Math.abs(seed) % PREVIEW_PORT_SPAN);
	};

	Zotero.QLab.discoverQuartoExecutable = async function (host = {}) {
		if (typeof host.pathSearch === 'function') {
			try {
				let found = await host.pathSearch('quarto');
				if (found) return found;
			}
			catch (error) {}
		}
		if (typeof host.exists === 'function') {
			for (let candidate of QUARTO_MAC_CANDIDATES) {
				try {
					if (await host.exists(candidate)) return candidate;
				}
				catch (error) {}
			}
		}
		return null;
	};

	Zotero.QLab.createGeckoQuartoDiscoveryHost = function () {
		return {
			pathSearch: async (name) => {
				try {
					let { Subprocess } = ChromeUtils.importESModule(
						'resource://gre/modules/Subprocess.sys.mjs'
					);
					return await Subprocess.pathSearch(name);
				}
				catch (error) {
					return null;
				}
			},
			exists: async (path) => {
				try {
					return await IOUtils.exists(path);
				}
				catch (error) {
					return false;
				}
			},
		};
	};
	
	Zotero.QLab._qmdPreviewSessions = Zotero.QLab._qmdPreviewSessions || Object.create(null);
	Zotero.QLab._qmdPreviewStarts = Zotero.QLab._qmdPreviewStarts || Object.create(null);
	
	/**
	 * Start `quarto preview` for one file. Returns http URL or throws.
	 * Node tests inject runner + fetch; Gecko uses Subprocess when available.
	 */
	Zotero.QLab.startQmdQuartoPreview = async function (root, relativePath, options = {}) {
		let rel = String(relativePath || '');
		let target = Zotero.QLab.resolveQuartoPreviewTarget(root, rel);
		let key = `${target.cwd}:${target.file}`;
		let owner = options.owner || null;
		if (owner && owner.released) {
			throw new Error('Quarto preview lease was already released');
		}
		let existing = Zotero.QLab._qmdPreviewSessions[key];
		if (existing && existing.url) {
			if (owner) {
				existing.clients = existing.clients || new Set();
				existing.clients.add(owner);
			}
			return existing.readyPromise || existing.url;
		}
		if (!options._insideStartLock) {
			let pending = Zotero.QLab._qmdPreviewStarts[key];
			if (pending) {
				if (owner) pending.owners.add(owner);
				else pending.hasUnownedCaller = true;
				return pending.promise;
			}
			pending = {
				owners: new Set(owner ? [owner] : []),
				hasUnownedCaller: !owner,
				cancelled: false,
				promise: null,
			};
			Zotero.QLab._qmdPreviewStarts[key] = pending;
			let innerOptions = { ...options, owner: null, _insideStartLock: true };
			pending.promise = Promise.resolve()
				.then(() => Zotero.QLab.startQmdQuartoPreview(root, rel, innerOptions))
				.then(url => {
					let live = Zotero.QLab._qmdPreviewSessions[key];
					if (live) {
						live.clients = live.clients || new Set();
						for (let client of pending.owners) {
							if (!client.released) live.clients.add(client);
						}
						if (pending.cancelled
								|| (!pending.hasUnownedCaller && live.clients.size === 0)) {
							Zotero.QLab.stopQmdQuartoPreview(root, rel);
						}
					}
					return url;
				})
				.finally(() => {
					if (Zotero.QLab._qmdPreviewStarts[key] === pending) {
						delete Zotero.QLab._qmdPreviewStarts[key];
					}
				});
			return pending.promise;
		}
		
		let port = options.port || Zotero.QLab.nextQmdPreviewPort(hash(key));
		let origin = `http://127.0.0.1:${port}/`;
		let url = `${origin.replace(/\/$/, '')}${target.page}`;
		let runner = options.runner
			|| (Zotero.QLab.createGeckoProcessRunner && Zotero.QLab.createGeckoProcessRunner());
		if (!runner) {
			throw new Error('Process runner unavailable for Quarto preview');
		}
		
		let command = options.quartoCommand || '';
		if (!command && (options.discoveryHost || !options.runner)) {
			let discoveryHost = options.discoveryHost
				|| (Zotero.QLab.createGeckoQuartoDiscoveryHost
					? Zotero.QLab.createGeckoQuartoDiscoveryHost()
					: {});
			command = await Zotero.QLab.discoverQuartoExecutable(discoveryHost) || '';
			if (!command) {
				throw new Error(
					'Quarto executable not found. Install Quarto in /usr/local/bin, '
					+ '/opt/homebrew/bin, or /Applications/quarto/bin.'
				);
			}
		}
		if (!command) command = 'quarto';
		let args = [
			'preview',
			target.file,
			'--no-browser',
			'--no-execute',
			'--host',
			'127.0.0.1',
			'--port',
			String(port),
		];
		
		let killProcess = null;
		let abort = false;
		let ready = false;
		let session;
		let processError = null;
		let resolveProcessFailure;
		let processFailure = new Promise(resolve => {
			resolveProcessFailure = resolve;
		});
		let output = [];
		function recordOutput(event) {
			if (!event || !['stdout', 'stderr'].includes(event.type) || !event.data) return;
			output.push(String(event.data));
			if (output.length > 24) output.shift();
		}
		function clearSession() {
			if (Zotero.QLab._qmdPreviewSessions[key] === session) {
				delete Zotero.QLab._qmdPreviewSessions[key];
			}
		}
		function reportProcessFailure(error) {
			if (abort) return;
			processError = error;
			clearSession();
			resolveProcessFailure({ error });
		}

		session = {
			url,
			port,
			ready: false,
			readyPromise: null,
			clients: new Set(owner ? [owner] : []),
			stop: () => {
				abort = true;
				if (killProcess) {
					try {
						killProcess();
					}
					catch (error) {}
				}
			},
		};
		Zotero.QLab._qmdPreviewSessions[key] = session;

		(async () => {
			try {
				let sawExit = false;
				for await (let event of runner.run(command, args, {
					cwd: target.cwd,
					registerKill: (kill) => {
						killProcess = kill;
						if (abort && killProcess) {
							try {
								killProcess();
							}
							catch (error) {}
						}
					},
				})) {
					if (abort) {
						break;
					}
					recordOutput(event);
					if (event.type === 'exit') {
						sawExit = true;
						clearSession();
						if (Number(event.exitCode) !== 0) {
							let detail = output.join('\n').trim();
							reportProcessFailure(new Error(
								`Quarto preview exited with code ${event.exitCode}`
								+ (detail ? `: ${detail}` : '')
							));
						}
						else if (!ready) {
							reportProcessFailure(new Error(
								'Quarto preview process ended before becoming ready'
							));
						}
					}
				}
				if (!abort && !sawExit) {
					clearSession();
					resolveProcessFailure({ error: new Error('Quarto preview process ended unexpectedly') });
				}
			}
			catch (error) {
				Zotero.logError && Zotero.logError(error);
				reportProcessFailure(error);
			}
		})();
		
		let fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
		session.readyPromise = (async () => {
			if (!fetchImpl) {
				// Still return the URL; the browser will load when Quarto is ready.
				ready = true;
				session.ready = true;
				return url;
			}
			let deadline = Date.now() + (options.timeoutMs || 20000);
			let pollIntervalMs = options.pollIntervalMs || 400;
			let delay = options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
			while (Date.now() < deadline) {
				if (processError) {
					Zotero.QLab.stopQmdQuartoPreview(root, relativePath);
					throw processError;
				}
				let probe = Promise.resolve()
					.then(() => fetchImpl(url, { cache: 'no-store' }))
					.then(response => response && response.ok ? { ready: true } : null)
					.catch(() => null);
				let outcome = await Promise.race([
					probe,
					processFailure,
					delay(pollIntervalMs).then(() => null),
				]);
				if (outcome && outcome.error) {
					Zotero.QLab.stopQmdQuartoPreview(root, relativePath);
					throw outcome.error;
				}
				if (outcome && outcome.ready) {
					ready = true;
					session.ready = true;
					return url;
				}
			}
			// Give an already queued runner completion one microtask to publish its
			// precise error before falling back to the generic readiness timeout.
			await Promise.resolve();
			if (processError) {
				Zotero.QLab.stopQmdQuartoPreview(root, relativePath);
				throw processError;
			}
			Zotero.QLab.stopQmdQuartoPreview(root, relativePath);
			throw new Error('Quarto preview did not become ready in time');
		})();
		return session.readyPromise;
	};
	
	Zotero.QLab.stopQmdQuartoPreview = function (root, relativePath, options = {}) {
		let rel = String(relativePath || '');
		let target = Zotero.QLab.resolveQuartoPreviewTarget(root, rel);
		let key = `${target.cwd}:${target.file}`;
		let owner = options.owner || null;
		let pending = Zotero.QLab._qmdPreviewStarts[key];
		if (pending) {
			if (owner) {
				pending.owners.delete(owner);
				if (!pending.hasUnownedCaller && pending.owners.size === 0) {
					pending.cancelled = true;
				}
			}
			else pending.cancelled = true;
		}
		let session = Zotero.QLab._qmdPreviewSessions[key];
		if (session && pending && pending.cancelled) {
			session.stop && session.stop();
			delete Zotero.QLab._qmdPreviewSessions[key];
			return;
		}
		if (session && owner) {
			if (!session.clients || !session.clients.has(owner)) return;
			session.clients.delete(owner);
			if (session.clients.size) return;
		}
		if (session && session.stop) {
			session.stop();
		}
		delete Zotero.QLab._qmdPreviewSessions[key];
	};
})();
