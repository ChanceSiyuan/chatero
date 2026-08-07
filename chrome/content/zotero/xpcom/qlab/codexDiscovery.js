/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Locate the local Codex CLI without spawning a turn.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const CANDIDATE_NAMES = ['codex'];
	
	/**
	 * @param {{
	 *   pathSearch?: (name: string) => Promise<string|null>,
	 *   exists?: (path: string) => Promise<boolean>,
	 *   envPath?: string,
	 *   homeDir?: string,
	 * }} [host]
	 */
	Zotero.QLab.discoverCodexExecutable = async function (host = {}) {
		if (host.pathSearch) {
			for (let name of CANDIDATE_NAMES) {
				try {
					let found = await host.pathSearch(name);
					if (found) {
						return found;
					}
				}
				catch (e) {}
			}
		}
		
		let envPath = host.envPath;
		if (envPath === undefined && typeof process !== 'undefined' && process.env) {
			envPath = process.env.PATH || '';
		}
		let homeDir = host.homeDir;
		if (homeDir === undefined && typeof process !== 'undefined' && process.env) {
			homeDir = process.env.HOME || '';
		}
		
		let dirs = String(envPath || '').split(':').filter(Boolean);
		if (homeDir) {
			dirs.unshift(
				`${homeDir}/.local/bin`,
				`${homeDir}/.codex/bin`,
			);
		}
		
		let exists = host.exists || (async () => false);
		for (let dir of dirs) {
			for (let name of CANDIDATE_NAMES) {
				let candidate = `${dir.replace(/\/$/, '')}/${name}`;
				try {
					if (await exists(candidate)) {
						return candidate;
					}
				}
				catch (e) {}
			}
		}
		return null;
	};
	
	Zotero.QLab.createGeckoCodexDiscoveryHost = function () {
		return {
			pathSearch: async (name) => {
				try {
					let { Subprocess } = ChromeUtils.importESModule(
						'resource://gre/modules/Subprocess.sys.mjs'
					);
					return await Subprocess.pathSearch(name);
				}
				catch (e) {
					return null;
				}
			},
			exists: async (path) => {
				try {
					return await IOUtils.exists(path);
				}
				catch (e) {
					return false;
				}
			},
		};
	};
})();
