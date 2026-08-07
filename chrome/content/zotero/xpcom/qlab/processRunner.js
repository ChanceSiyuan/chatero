/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2026 Chance Siyuan / Chatero contributors
	
	This file is part of Chatero (a Zotero fork).
	
	***** END LICENSE BLOCK *****
*/

/**
 * Streaming process runner used by the local Codex provider.
 * Gecko uses Subprocess.sys.mjs; Node tests inject createNodeProcessRunner().
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	/**
	 * @param {{
	 *   spawn: (opts: {
	 *     command: string,
	 *     args: string[],
	 *     cwd?: string,
	 *     env?: Record<string,string>,
	 *   }) => AsyncIterable<{ type: 'stdout'|'stderr'|'exit', data?: string, exitCode?: number|null }>
	 * }} impl
	 */
	Zotero.QLab.createProcessRunner = function (impl) {
		if (!impl || typeof impl.spawn !== 'function') {
			throw new Error('ProcessRunner requires spawn()');
		}
		return {
			async *run(command, args, options = {}) {
				for await (let event of impl.spawn({
					command,
					args: Array.isArray(args) ? args : [],
					cwd: options.cwd,
					env: options.env,
				})) {
					yield event;
				}
			},
		};
	};
	
	Zotero.QLab.createGeckoProcessRunner = function () {
		return Zotero.QLab.createProcessRunner({
			async *spawn({ command, args, cwd, env }) {
				let { Subprocess } = ChromeUtils.importESModule(
					'resource://gre/modules/Subprocess.sys.mjs'
				);
				let resolved = PathUtils.isAbsolute(command)
					? command
					: await Subprocess.pathSearch(command);
				if (!resolved) {
					throw new Error(`Executable not found: ${command}`);
				}
				let opts = {
					command: resolved,
					arguments: args,
				};
				if (cwd) {
					opts.workdir = cwd;
				}
				if (env) {
					opts.environment = env;
					opts.environmentAppend = true;
				}
				let proc = await Subprocess.call(opts);
				let buffer = '';
				while (true) {
					let chunk = await proc.stdout.readString();
					if (!chunk) {
						break;
					}
					buffer += chunk;
					let parts = buffer.split(/\r?\n/);
					buffer = parts.pop() || '';
					for (let line of parts) {
						yield { type: 'stdout', data: line };
					}
				}
				if (buffer) {
					yield { type: 'stdout', data: buffer };
				}
				let stderr = '';
				try {
					while (true) {
						let chunk = await proc.stderr.readString();
						if (!chunk) {
							break;
						}
						stderr += chunk;
					}
				}
				catch (e) {}
				if (stderr.trim()) {
					for (let line of stderr.split(/\r?\n/).filter(Boolean)) {
						yield { type: 'stderr', data: line };
					}
				}
				let result = await proc.wait();
				yield {
					type: 'exit',
					exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
				};
			},
		});
	};
	
	/**
	 * Node-only runner for unit tests (and optional sidecar tooling).
	 */
	Zotero.QLab.createNodeProcessRunner = function (childProcess, pathModule) {
		return Zotero.QLab.createProcessRunner({
			async *spawn({ command, args, cwd, env }) {
				let { spawn } = childProcess;
				let proc = spawn(command, args, {
					cwd: cwd || undefined,
					env: env ? { ...process.env, ...env } : undefined,
					stdio: ['ignore', 'pipe', 'pipe'],
				});
				let queue = [];
				let waiters = [];
				let closed = false;
				
				function push(event) {
					if (waiters.length) {
						waiters.shift()(event);
					}
					else {
						queue.push(event);
					}
				}
				
				function next() {
					if (queue.length) {
						return Promise.resolve(queue.shift());
					}
					if (closed) {
						return Promise.resolve(null);
					}
					return new Promise(resolve => waiters.push(resolve));
				}
				
				let stdoutBuf = '';
				proc.stdout.setEncoding('utf8');
				proc.stdout.on('data', (chunk) => {
					stdoutBuf += chunk;
					let parts = stdoutBuf.split(/\r?\n/);
					stdoutBuf = parts.pop() || '';
					for (let line of parts) {
						push({ type: 'stdout', data: line });
					}
				});
				proc.stderr.setEncoding('utf8');
				proc.stderr.on('data', (chunk) => {
					for (let line of String(chunk).split(/\r?\n/).filter(Boolean)) {
						push({ type: 'stderr', data: line });
					}
				});
				proc.on('error', (error) => {
					push({ type: 'stderr', data: error.message || String(error) });
					push({ type: 'exit', exitCode: 1 });
					closed = true;
					while (waiters.length) {
						waiters.shift()(null);
					}
				});
				proc.on('close', (code) => {
					if (stdoutBuf) {
						push({ type: 'stdout', data: stdoutBuf });
						stdoutBuf = '';
					}
					push({ type: 'exit', exitCode: code });
					closed = true;
					while (waiters.length) {
						waiters.shift()(null);
					}
				});
				
				while (true) {
					let event = await next();
					if (!event) {
						break;
					}
					yield event;
					if (event.type === 'exit') {
						break;
					}
				}
			},
		});
	};
})();
