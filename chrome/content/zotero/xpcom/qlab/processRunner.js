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
	 *     registerKill?: (kill: () => void) => void,
	 *   }) => AsyncIterable<{ type: 'stdout'|'stderr'|'exit', data?: string, exitCode?: number|null }>
	 * }} impl
	 */
	Zotero.QLab.createProcessRunner = function (impl) {
		if (!impl || typeof impl.spawn !== 'function') {
			throw new Error('ProcessRunner requires spawn()');
		}
		return {
			run(command, args, options = {}) {
				let kill = null;
				let killCalled = false;
				let cancelRequested = false;
				let exitSettled = false;
				let resolveExit;
				let exited = new Promise(resolve => { resolveExit = resolve; });

				function settleExit(exitCode) {
					if (exitSettled) return;
					exitSettled = true;
					resolveExit(typeof exitCode === 'number' ? exitCode : null);
				}

				function cancel() {
					cancelRequested = true;
					if (!kill || killCalled) return;
					killCalled = true;
					kill();
				}

				function registerKill(fn) {
					if (typeof fn !== 'function') return;
					kill = fn;
					if (typeof options.registerKill === 'function') {
						options.registerKill(cancel);
					}
					if (cancelRequested) cancel();
				}

				async function* events() {
					for await (let event of impl.spawn({
						command,
						args: Array.isArray(args) ? args : [],
						cwd: options.cwd,
						env: options.env,
						registerKill,
					})) {
						if (event && event.type === 'exit') settleExit(event.exitCode);
						yield event;
					}
				}

				return {
					[Symbol.asyncIterator]: events,
					cancel,
					waitForExit(timeoutMs = 10000) {
						let timeout = Number(timeoutMs);
						if (!Number.isFinite(timeout) || timeout <= 0) return exited;
						let timer;
						return Promise.race([
							exited,
							new Promise((_resolve, reject) => {
								timer = setTimeout(() => reject(
									new Error(`Process exit timed out after ${timeout}ms`)
								), timeout);
							}),
						]).finally(() => clearTimeout(timer));
					},
				};
			},
		};
	};
	
	Zotero.QLab.createGeckoProcessRunner = function () {
		return Zotero.QLab.createProcessRunner({
			async *spawn({ command, args, cwd, env, registerKill }) {
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
				if (typeof registerKill === 'function') {
					registerKill(() => {
						try {
							proc.kill();
						}
						catch (e) {}
					});
				}
				let queue = [];
				let waiters = [];
				let closed = false;
				function push(event) {
					if (waiters.length) waiters.shift()(event);
					else queue.push(event);
				}
				function next() {
					if (queue.length) return Promise.resolve(queue.shift());
					if (closed) return Promise.resolve(null);
					return new Promise(resolve => waiters.push(resolve));
				}
				async function pump(stream, type) {
					let buffer = '';
					try {
						while (true) {
							let chunk = await stream.readString();
							if (!chunk) break;
							buffer += chunk;
							let parts = buffer.split(/\r?\n/);
							buffer = parts.pop() || '';
							for (let line of parts) push({ type, data: line });
						}
						if (buffer) push({ type, data: buffer });
					}
					catch (error) {
						if (type === 'stdout') throw error;
					}
				}
				(async () => {
					try {
						let waiting = proc.wait();
						await Promise.all([pump(proc.stdout, 'stdout'), pump(proc.stderr, 'stderr')]);
						let result = await waiting;
						push({
							type: 'exit',
							exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
						});
					}
					catch (error) {
						push({ type: 'stderr', data: error.message || String(error) });
						push({ type: 'exit', exitCode: 1 });
					}
					finally {
						closed = true;
						while (waiters.length) waiters.shift()(null);
					}
				})();
				while (true) {
					let event = await next();
					if (!event) break;
					yield event;
					if (event.type === 'exit') break;
				}
			},
		});
	};
	
	/**
	 * Node-only runner for unit tests (and optional sidecar tooling).
	 */
	Zotero.QLab.createNodeProcessRunner = function (childProcess, pathModule) {
		return Zotero.QLab.createProcessRunner({
			async *spawn({ command, args, cwd, env, registerKill }) {
				let { spawn } = childProcess;
				let proc = spawn(command, args, {
					cwd: cwd || undefined,
					env: env ? { ...process.env, ...env } : undefined,
					stdio: ['ignore', 'pipe', 'pipe'],
				});
				if (typeof registerKill === 'function') {
					registerKill(() => {
						try {
							if (!proc.killed) {
								proc.kill('SIGTERM');
							}
						}
						catch (e) {}
					});
				}
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
				let stderrBuf = '';
				let finished = false;
				function finish(code) {
					if (finished) return;
					finished = true;
					if (stdoutBuf) push({ type: 'stdout', data: stdoutBuf });
					if (stderrBuf) push({ type: 'stderr', data: stderrBuf });
					stdoutBuf = '';
					stderrBuf = '';
					push({ type: 'exit', exitCode: code });
					closed = true;
					while (waiters.length) waiters.shift()(null);
				}
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
					stderrBuf += chunk;
					let parts = stderrBuf.split(/\r?\n/);
					stderrBuf = parts.pop() || '';
					for (let line of parts) push({ type: 'stderr', data: line });
				});
				proc.on('error', (error) => {
					push({ type: 'stderr', data: error.message || String(error) });
					finish(1);
				});
				proc.on('close', (code) => {
					finish(code);
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
