/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Optional Quarto live website preview for the Website surface.
 * Soft HTML preview remains available when Quarto is missing.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const PREVIEW_PORT_MIN = 43000;
	const PREVIEW_PORT_SPAN = 1500;
	
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
		
		let command = options.quartoCommand || 'quarto';
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
					if (event.type === 'exit') {
						delete Zotero.QLab._qmdPreviewSessions[key];
					}
				}
			}
			catch (e) {
				Zotero.logError && Zotero.logError(e);
				delete Zotero.QLab._qmdPreviewSessions[key];
			}
		})();
		
		Zotero.QLab._qmdPreviewSessions[key] = {
			url,
			port,
			stop: () => {
				abort = true;
				if (killProcess) {
					try {
						killProcess();
					}
					catch (e) {}
				}
			},
		};
		
		let fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
		if (!fetchImpl) {
			// Still return the URL; the iframe will load when Quarto is ready.
			return url;
		}
		
		let deadline = Date.now() + (options.timeoutMs || 20000);
		while (Date.now() < deadline) {
			try {
				let response = await fetchImpl(url, { cache: 'no-store' });
				if (response && response.ok) {
					return url;
				}
			}
			catch (e) {}
			await new Promise(r => setTimeout(r, 400));
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
