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
			return {
				cwd: joinWorkspacePath(root, 'drafts'),
				file: rel.slice('drafts/'.length),
			};
		}
		if (rel.includes('/')) {
			let slash = rel.lastIndexOf('/');
			return {
				cwd: joinWorkspacePath(root, rel.slice(0, slash)),
				file: rel.slice(slash + 1),
			};
		}
		return {
			cwd: root,
			file: rel,
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
	
	/**
	 * Start `quarto preview` for one file. Returns http URL or throws.
	 * Node tests inject runner + fetch; Gecko uses Subprocess when available.
	 */
	Zotero.QLab.startQmdQuartoPreview = async function (root, relativePath, options = {}) {
		let rel = String(relativePath || '');
		let target = Zotero.QLab.resolveQuartoPreviewTarget(root, rel);
		let key = `${target.cwd}:${target.file}`;
		let existing = Zotero.QLab._qmdPreviewSessions[key];
		if (existing && existing.url) {
			return existing.url;
		}
		
		let port = options.port || Zotero.QLab.nextQmdPreviewPort(hash(key));
		let url = `http://127.0.0.1:${port}/`;
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
		function reportProcessFailure(error) {
			if (abort) return;
			delete Zotero.QLab._qmdPreviewSessions[key];
			resolveProcessFailure({ error });
		}

		Zotero.QLab._qmdPreviewSessions[key] = {
			url,
			port,
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

		(async () => {
			try {
				for await (let event of runner.run(command, args, {
					cwd: target.cwd,
					registerKill: (kill) => {
						killProcess = kill;
					},
				})) {
					if (abort) {
						break;
					}
					recordOutput(event);
					if (event.type === 'exit') {
						delete Zotero.QLab._qmdPreviewSessions[key];
						if (Number(event.exitCode) !== 0) {
							let detail = output.join('\n').trim();
							reportProcessFailure(new Error(
								`Quarto preview exited with code ${event.exitCode}`
								+ (detail ? `: ${detail}` : '')
							));
						}
					}
				}
			}
			catch (error) {
				Zotero.logError && Zotero.logError(error);
				reportProcessFailure(error);
			}
		})();
		
		let fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
		if (!fetchImpl) {
			// Still return the URL; the iframe will load when Quarto is ready.
			return url;
		}
		
		let deadline = Date.now() + (options.timeoutMs || 20000);
		let pollIntervalMs = options.pollIntervalMs || 400;
		let delay = options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
		while (Date.now() < deadline) {
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
			if (outcome && outcome.ready) return url;
		}
		Zotero.QLab.stopQmdQuartoPreview(root, relativePath);
		throw new Error('Quarto preview did not become ready in time');
	};
	
	Zotero.QLab.stopQmdQuartoPreview = function (root, relativePath) {
		let rel = String(relativePath || '');
		let target = Zotero.QLab.resolveQuartoPreviewTarget(root, rel);
		let key = `${target.cwd}:${target.file}`;
		let session = Zotero.QLab._qmdPreviewSessions[key];
		if (session && session.stop) {
			session.stop();
		}
		delete Zotero.QLab._qmdPreviewSessions[key];
	};
})();
