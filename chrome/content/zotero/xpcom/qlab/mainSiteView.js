/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Chance Siyuan / Chatero contributors

	This file is part of Chatero (a Zotero fork).

	***** END LICENSE BLOCK *****
*/

/**
 * Native Main Site presentation and its strict navigation boundary.
 * Process ownership remains in MainSiteService; window views only observe it.
 */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const NATIVE_HOSTS = new Set(['open-pdf', 'select']);
	const NAVIGATION_MESSAGE = 'QLab:MainSiteNavigation';
	const NAVIGATION_CONFIG_MESSAGE = 'QLab:MainSiteNavigationConfig';
	const NAVIGATION_SHUTDOWN_MESSAGE = 'QLab:MainSiteNavigationShutdown';

	function decision(action, url, reason) {
		return Object.freeze({ action, ...(url ? { url } : {}), ...(reason ? { reason } : {}) });
	}

	function parsedURL(value) {
		try { return new URL(String(value || '')); }
		catch (error) { return null; }
	}

	function hasCredentials(url) {
		return Boolean(url && (url.username || url.password));
	}

	function looksLikeLoopbackConfusion(hostname) {
		let host = String(hostname || '').toLowerCase();
		return host === 'localhost'
			|| host === '::1'
			|| host === '[::1]'
			|| host === '127.0.0.1'
			|| host.startsWith('127.')
			|| host.startsWith('localhost.');
	}

	Zotero.QLab.mainSiteNavigationDecision = function ({ currentOrigin, requestedURL } = {}) {
		let current = parsedURL(currentOrigin);
		let requested = parsedURL(requestedURL);
		if (!current || !requested || hasCredentials(current) || hasCredentials(requested)) {
			return decision('refuse', '', 'invalid-or-credentialed-url');
		}
		let currentPort = Number(current.port);
		if (current.protocol !== 'http:' || current.hostname !== '127.0.0.1'
				|| !Number.isInteger(currentPort) || currentPort < 4180 || currentPort > 4199
				|| current.origin !== String(currentOrigin || '').replace(/\/$/, '')) {
			return decision('refuse', '', 'invalid-site-origin');
		}
		if (requested.protocol === 'http:' || requested.protocol === 'https:') {
			if (requested.protocol === 'http:' && requested.origin === current.origin) {
				return decision('embed', requested.href);
			}
			if (looksLikeLoopbackConfusion(requested.hostname)) {
				return decision('refuse', '', 'loopback-origin-mismatch');
			}
			return decision('external', requested.href);
		}
		if ((requested.protocol === 'zotero:' || requested.protocol === 'chatero:')
				&& NATIVE_HOSTS.has(requested.hostname.toLowerCase())
				&& (requested.protocol !== 'chatero:' || requested.hostname.toLowerCase() === 'open-pdf')) {
			return decision('native', requested.href);
		}
		return decision('refuse', '', 'unsupported-protocol');
	};

	Zotero.QLab.mainSiteNavigationFrameScript = function () {
		let source = `(() => {
			const marker = '__qlabMainSiteNavigationBridge';
			if (content[marker]) return;
			let allowedOrigin = '';
			let disposers = [];
			function isTopLevel(win) { return win === content; }
			function findLink(node) {
				for (let current = node; current; current = current.parentElement) {
					if (current.localName === 'a' || current.localName === 'area') return current;
				}
				return null;
			}
			function route(event, rawURL, kind, win) {
				let url;
				try { url = new URL(String(rawURL || ''), win.location.href); }
				catch (error) { url = null; }
				let forbiddenScript = url && url.protocol === 'javascript:';
				let embeds = url && !forbiddenScript
					&& url.protocol === 'http:' && url.origin === allowedOrigin;
				if (embeds) return true;
				if (event) {
					event.preventDefault();
					event.stopPropagation();
				}
				sendAsyncMessage('${NAVIGATION_MESSAGE}', {
					url: url ? url.href : String(rawURL || ''),
					topLevel: isTopLevel(win), kind,
				});
				return false;
			}
			function attach(win) {
				let onClick = event => {
					if (event.button !== 0) return;
					let link = findLink(event.target);
					if (link && link.href) route(event, link.href, 'click', win);
				};
				let onSubmit = event => {
					let form = event.target;
					if (form && form.action) route(event, form.action, 'submit', win);
				};
				win.addEventListener('click', onClick, true);
				win.addEventListener('submit', onSubmit, true);
				let originalOpen = win.open;
				try {
					win.open = function (url, ...args) {
						return route(null, url, 'window-open', win)
							? originalOpen.call(win, url, ...args) : null;
					};
				}
				catch (error) {}
				disposers.push(() => {
					win.removeEventListener('click', onClick, true);
					win.removeEventListener('submit', onSubmit, true);
					try { win.open = originalOpen; } catch (error) {}
				});
			}
			function onWindow(event) {
				let win = event.target && event.target.defaultView;
				if (win) attach(win);
			}
			function shutdown() {
				content.removeEventListener('DOMWindowCreated', onWindow, true);
				for (let dispose of disposers.splice(0)) dispose();
				removeMessageListener('${NAVIGATION_CONFIG_MESSAGE}', onConfig);
				removeMessageListener('${NAVIGATION_SHUTDOWN_MESSAGE}', shutdown);
				delete content[marker];
			}
			function onConfig(message) { allowedOrigin = String(message.data && message.data.origin || ''); }
			content[marker] = true;
			content.addEventListener('DOMWindowCreated', onWindow, true);
			addMessageListener('${NAVIGATION_CONFIG_MESSAGE}', onConfig);
			addMessageListener('${NAVIGATION_SHUTDOWN_MESSAGE}', shutdown);
			attach(content);
		})();`;
		return `data:application/javascript;charset=utf-8,${encodeURIComponent(source)}`;
	};

	Zotero.QLab.bindMainSiteNavigationBridge = function (browser, onNavigate) {
		if (!browser || typeof onNavigate !== 'function') return { updateOrigin() {}, dispose() {} };
		let manager = null;
		let scriptURL = Zotero.QLab.mainSiteNavigationFrameScript();
		let disposed = false;
		let origin = '';
		let listener = message => onNavigate(message && message.data || {});
		function detach() {
			if (!manager) return;
			try { manager.sendAsyncMessage(NAVIGATION_SHUTDOWN_MESSAGE, {}); }
			catch (error) {}
			try { manager.removeMessageListener(NAVIGATION_MESSAGE, listener); }
			catch (error) {}
			try { manager.removeDelayedFrameScript(scriptURL); }
			catch (error) {}
			manager = null;
		}
		function bind() {
			if (disposed) return;
			let next = null;
			try { next = browser.messageManager || null; }
			catch (error) {}
			if (!next || next === manager) return;
			detach();
			manager = next;
			manager.addMessageListener(NAVIGATION_MESSAGE, listener);
			manager.loadFrameScript(scriptURL, true);
			manager.sendAsyncMessage(NAVIGATION_CONFIG_MESSAGE, { origin });
		}
		browser.addEventListener && browser.addEventListener('load', bind, true);
		bind();
		return Object.freeze({
			updateOrigin(nextOrigin) {
				origin = String(nextOrigin || '');
				try { manager && manager.sendAsyncMessage(NAVIGATION_CONFIG_MESSAGE, { origin }); }
				catch (error) {}
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				browser.removeEventListener && browser.removeEventListener('load', bind, true);
				detach();
			},
		});
	};

	function htmlElement(document, tagName, className = '') {
		let element = document.createElementNS('http://www.w3.org/1999/xhtml', tagName);
		if (className) element.className = className;
		return element;
	}

	function button(document, label, className = '') {
		let element = htmlElement(document, 'button', className);
		element.type = 'button';
		element.textContent = label;
		element.setAttribute('aria-label', label);
		element.setAttribute('title', label);
		return element;
	}

	function originFor(snapshot) {
		let candidate = snapshot && (snapshot.url || snapshot.lastGoodURL);
		let parsed = parsedURL(candidate);
		return parsed ? parsed.origin : '';
	}

	function loadBrowser(browser, url) {
		if (!browser || !url) return;
		try {
			if (typeof Services !== 'undefined' && Services.io && Services.io.newURI) {
				browser.loadURI(Services.io.newURI(url), {
					triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
				});
			}
			else browser.loadURI(url);
		}
		catch (error) {
			Zotero.logError && Zotero.logError(error);
		}
	}

	/**
	 * Mount one native, remote web browser for a repository Main Site.
	 * Construction is intentionally read-only: it observes the process service
	 * and performs one health check. Install/build/start require the explicit
	 * primary toolbar action.
	 */
	Zotero.QLab.createMainSiteView = function (document, host, options = {}) {
		if (!document || !host) throw new Error('Main Site view requires a document and host');
		let service = options.service;
		let target = options.target || {};
		if (!service || typeof service.observe !== 'function' || typeof service.check !== 'function') {
			throw new Error('Main Site view requires a process service');
		}
		let disposed = false;
		let snapshot = service.snapshot ? service.snapshot(target.identity) : { state: 'idle' };
		let activeOrigin = originFor(snapshot);
		let lastEmbeddedURL = '';
		let restoredURL = String(options.initialURL || '');
		let cleanups = [];
		let navigationBridge = null;

		let root = htmlElement(document, 'section', 'qlab-main-site');
		root.setAttribute('data-qlab-kind', 'qlabsite');
		let toolbar = htmlElement(document, 'div', 'qlab-main-site__toolbar');
		let back = button(document, 'Back', 'qlab-main-site__icon');
		let forward = button(document, 'Forward', 'qlab-main-site__icon');
		let home = button(document, 'Home', 'qlab-main-site__icon');
		let reload = button(document, 'Reload', 'qlab-main-site__icon');
		let status = htmlElement(document, 'span', 'qlab-main-site__status');
		let primary = button(document, 'Build & Start', 'qlab-main-site__primary');
		let source = button(document, 'Open Source Beside Site', 'qlab-main-site__source');
		let sourceRoutingReady = options.sourceRoutingReady === true
			&& typeof options.openSourceBesideSite === 'function';
		source.disabled = !sourceRoutingReady;
		source.setAttribute('aria-disabled', sourceRoutingReady ? 'false' : 'true');
		source.setAttribute(
			'title',
			sourceRoutingReady
				? 'Open Source Beside Site'
				: 'Available after Task 7 Knowledge routing is enabled'
		);
		for (let element of [back, forward, home, reload, status, primary, source]) toolbar.appendChild(element);

		let browser = document.createXULElement
			? document.createXULElement('browser')
			: htmlElement(document, 'browser');
		browser.className = 'qlab-main-site__browser';
		browser.setAttribute('type', 'content');
		browser.setAttribute('remote', 'true');
		browser.setAttribute('maychangeremoteness', 'true');
		browser.setAttribute('messagemanagergroup', 'browsers');

		let log = htmlElement(document, 'details', 'qlab-main-site__log');
		let logTitle = htmlElement(document, 'summary');
		logTitle.textContent = 'Build Log';
		let logBody = htmlElement(document, 'pre');
		log.appendChild(logTitle);
		log.appendChild(logBody);
		root.appendChild(toolbar);
		root.appendChild(browser);
		root.appendChild(log);
		host.replaceChildren(root);

		function decideAndRoute(url, { load = true } = {}) {
			let result = Zotero.QLab.mainSiteNavigationDecision({
				currentOrigin: activeOrigin,
				requestedURL: url,
			});
			if (result.action === 'embed') {
				if (load && result.url !== lastEmbeddedURL) {
					lastEmbeddedURL = result.url;
					loadBrowser(browser, result.url);
				}
				options.onPersist && options.onPersist(result.url);
			}
			else if (result.action === 'external') {
				(options.openExternal || Zotero.launchURL || (() => {}))(result.url);
			}
			else if (result.action === 'native') {
				let openNative = options.openNative || (url => document.defaultView?.ZoteroPane?.loadURI?.(url));
				openNative(result.url);
			}
			else {
				status.textContent = 'Blocked unsafe navigation';
			}
			return result.action;
		}

		function render(next) {
			if (disposed || !next) return;
			snapshot = next;
			let nextOrigin = originFor(next);
			if (nextOrigin) {
				activeOrigin = nextOrigin;
				navigationBridge && navigationBridge.updateOrigin(activeOrigin);
			}
			status.textContent = next.error || ({
				idle: 'Main Site is stopped', checking: 'Checking Main Site…',
				installing: 'Installing dependencies…', building: 'Building…',
				starting: 'Starting…', ready: 'Main Site is ready', stale: 'Main Site needs a rebuild',
				stopping: 'Stopping…', error: 'Main Site needs attention',
			}[next.state] || 'Main Site');
			primary.textContent = next.state === 'error' ? 'Retry'
				: next.lastGoodURL || next.state === 'ready' ? 'Build & Restart' : 'Build & Start';
			primary.setAttribute('aria-label', primary.textContent);
			primary.setAttribute('title', primary.textContent);
			let busy = ['checking', 'installing', 'building', 'starting', 'stopping'].includes(next.state);
			primary.disabled = busy;
			logBody.textContent = next.diagnosticTail || '';
			// Only a healthy snapshot may replace the browser. Errors retain the
			// exact last-good document already on screen.
			if (next.state === 'ready' && next.url) {
				let requested = next.url;
				if (restoredURL) {
					let restored = Zotero.QLab.mainSiteNavigationDecision({
						currentOrigin: activeOrigin, requestedURL: restoredURL,
					});
					if (restored.action === 'embed') requested = restoredURL;
					restoredURL = '';
				}
				decideAndRoute(requested);
			}
		}

		let unsubscribe = service.observe(target.identity, render);
		if (typeof unsubscribe === 'function') cleanups.push(unsubscribe);

		let progressConstants = options.progressConstants || (typeof Components !== 'undefined'
			? Components.interfaces.nsIWebProgress : {});
		let abortCode = typeof Components !== 'undefined' && Components.results
			? Components.results.NS_BINDING_ABORTED : 0x804b0002;
		let progressListener = {
			onLocationChange(_progress, _request, location) {
				let requested = location && (location.spec || location.href || String(location));
				if (!requested || requested === 'about:blank') return;
				let result = Zotero.QLab.mainSiteNavigationDecision({ currentOrigin: activeOrigin, requestedURL: requested });
				let topLevel = !_progress || _progress.isTopLevel !== false;
				if (result.action === 'embed' && topLevel) {
					lastEmbeddedURL = result.url;
					options.onPersist && options.onPersist(result.url);
				}
				else if (result.action !== 'embed') {
					try { _request && typeof _request.cancel === 'function' && _request.cancel(abortCode); }
					catch (error) {}
					if (topLevel) decideAndRoute(requested, { load: false });
				}
			},
			onStateChange(progress, request, flags) {
				if (!(flags & (progressConstants.STATE_START || 0))) return;
				if (progressConstants.STATE_IS_DOCUMENT
						&& !(flags & progressConstants.STATE_IS_DOCUMENT)) return;
				let requested = request && request.URI && request.URI.spec;
				if (!requested) return;
				let result = Zotero.QLab.mainSiteNavigationDecision({ currentOrigin: activeOrigin, requestedURL: requested });
				if (result.action === 'embed') return;
				try { request.cancel && request.cancel(abortCode); }
				catch (error) {}
				if (!progress || progress.isTopLevel !== false) decideAndRoute(requested, { load: false });
			},
			onProgressChange() {}, onStatusChange() {}, onSecurityChange() {}, onContentBlockingEvent() {},
		};
		if (typeof ChromeUtils !== 'undefined' && ChromeUtils.generateQI
				&& typeof Components !== 'undefined') {
			progressListener.QueryInterface = ChromeUtils.generateQI([
				Components.interfaces.nsIWebProgressListener,
				Components.interfaces.nsISupportsWeakReference,
			]);
		}
		if (browser.webProgress && typeof browser.webProgress.addProgressListener === 'function') {
			try {
				let flags = (progressConstants.NOTIFY_LOCATION || 0)
					| (progressConstants.NOTIFY_STATE_REQUEST || 0);
				browser.webProgress.addProgressListener(progressListener, flags);
				cleanups.push(() => browser.webProgress.removeProgressListener(progressListener));
			}
			catch (error) { Zotero.logError && Zotero.logError(error); }
		}

		navigationBridge = Zotero.QLab.bindMainSiteNavigationBridge(browser, data => {
			if (!data || data.topLevel !== true) {
				status.textContent = 'Blocked unsafe subframe navigation';
				return 'refuse';
			}
			return decideAndRoute(data.url, { load: false });
		});
		navigationBridge.updateOrigin(activeOrigin);
		cleanups.push(() => navigationBridge.dispose());

		function listen(element, type, listener) {
			element.addEventListener(type, listener);
			cleanups.push(() => element.removeEventListener(type, listener));
		}
		listen(back, 'click', () => browser.goBack && browser.goBack());
		listen(forward, 'click', () => browser.goForward && browser.goForward());
		listen(home, 'click', () => {
			let homeURL = snapshot.url || snapshot.lastGoodURL;
			if (homeURL) decideAndRoute(homeURL);
		});
		listen(reload, 'click', () => browser.reload && browser.reload());
		listen(primary, 'click', () => { void buildAndStart(); });
		listen(source, 'click', () => {
			if (sourceRoutingReady) options.openSourceBesideSite(target);
		});

		async function buildAndStart() {
			let operation = snapshot.lastGoodURL || snapshot.state === 'ready'
				? service.rebuild : service.start;
			if (typeof operation !== 'function') return null;
			try { return await operation.call(service, target); }
			catch (error) {
				Zotero.logError && Zotero.logError(error);
				return null;
			}
		}

		let ready = Promise.resolve().then(() => service.check(target)).catch(error => {
			Zotero.logError && Zotero.logError(error);
			return null;
		});
		return Object.freeze({
			ready,
			buildAndStart,
			navigate: url => decideAndRoute(url),
			home: () => home.dispatchEvent ? home.dispatchEvent(new Event('click')) : null,
			snapshot: () => ({ ...snapshot, lastEmbeddedURL }),
			dispose() {
				if (disposed) return;
				disposed = true;
				for (let cleanup of cleanups.splice(0).reverse()) {
					try { cleanup(); }
					catch (error) { Zotero.logError && Zotero.logError(error); }
				}
				root.remove();
			},
		});
	};

	function assertBoundedLoopbackURL(value) {
		let url = parsedURL(value);
		let port = Number(url && url.port);
		if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
				|| hasCredentials(url) || !Number.isInteger(port) || port < 4180 || port > 4199) {
			throw new Error('Main Site health checks are restricted to 127.0.0.1 ports 4180–4199');
		}
		return url;
	}

	Zotero.QLab.fetchMainSiteHealth = async function (baseURL, options = {}) {
		let base = assertBoundedLoopbackURL(baseURL);
		let Controller = options.AbortControllerImpl || AbortController;
		let controller = new Controller();
		let setTimer = options.setTimeoutImpl || setTimeout;
		let clearTimer = options.clearTimeoutImpl || clearTimeout;
		let timeoutMs = Number(options.timeoutMs) || 1500;
		let timer = setTimer(() => controller.abort(), timeoutMs);
		try {
			let request = options.fetchImpl || fetch;
			let response = await request(new URL('/api/qlab/health', base).href, {
				cache: 'no-store', credentials: 'omit', redirect: 'error',
				signal: controller.signal,
			});
			if (!response.ok) return null;
			return response.json();
		}
		finally {
			clearTimer(timer);
		}
	};

	async function commandVersion(command, processRunner) {
		let output = '';
		for await (let event of processRunner.run(command, ['--version'], {})) {
			if (event.type === 'stdout') output += event.data || '';
			if (event.type === 'exit' && event.exitCode !== 0) return '';
		}
		return output.trim();
	}

	/** Production-only adapter. It is created lazily so QLab failures cannot
	 * affect normal Zotero startup or Reader tabs. */
	Zotero.QLab.createGeckoMainSiteRuntime = function () {
		let processRunner = Zotero.QLab.createGeckoProcessRunner();
		return Object.freeze({
			processRunner,
			async canonicalizeRoot(root) {
				let value = String(root || '');
				if (!PathUtils.isAbsolute(value)) throw new Error('Main Site cwd must be an absolute path');
				let file = Components.classes['@mozilla.org/file/local;1']
					.createInstance(Components.interfaces.nsIFile);
				file.initWithPath(value);
				file.normalize();
				let canonical = typeof IOUtils.realPath === 'function'
					? await IOUtils.realPath(file.path) : file.path;
				return String(canonical).replace(/\/+$/, '');
			},
			async fetchHealth(baseURL) {
				return Zotero.QLab.fetchMainSiteHealth(baseURL);
			},
			async isPortAvailable(port, host) {
				if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 4180 || port > 4199) {
					throw new Error('Main Site port probe escaped its bounded loopback range');
				}
				let socket = Components.classes['@mozilla.org/network/server-socket;1']
					.createInstance(Components.interfaces.nsIServerSocket);
				try {
					socket.init(port, true, -1);
					return true;
				}
				catch (error) { return false; }
				finally {
					try { socket.close(); }
					catch (error) {}
				}
			},
			async resolveDependencies() {
				let { Subprocess } = ChromeUtils.importESModule(
					'resource://gre/modules/Subprocess.sys.mjs'
				);
				async function find(name, fallbacks = []) {
					try {
						let found = await Subprocess.pathSearch(name);
						if (found) return found;
					}
					catch (error) {}
					for (let candidate of fallbacks) {
						try { if (await IOUtils.exists(candidate)) return candidate; }
						catch (error) {}
					}
					return null;
				}
				let node = await find('node', ['/opt/homebrew/bin/node', '/usr/local/bin/node']);
				let npm = await find('npm', ['/opt/homebrew/bin/npm', '/usr/local/bin/npm']);
				let quarto = await find('quarto', [
					'/Applications/quarto/bin/quarto', '/opt/homebrew/bin/quarto', '/usr/local/bin/quarto',
				]);
				return {
					node: node ? { command: node, version: await commandVersion(node, processRunner) } : null,
					npm: npm ? { command: npm } : null,
					quarto: quarto ? { command: quarto } : null,
				};
			},
		});
	};

	Zotero.QLab.getMainSiteService = function () {
		if (Zotero.QLab._mainSiteService) return Zotero.QLab._mainSiteService;
		let service = Zotero.QLab.createMainSiteService(Zotero.QLab.createGeckoMainSiteRuntime());
		Zotero.QLab._mainSiteService = service;
		if (!Zotero.QLab._mainSiteShutdownRegistered && Zotero.addShutdownListener) {
			Zotero.QLab._mainSiteShutdownRegistered = true;
			Zotero.addShutdownListener(async () => {
				try { await Zotero.QLab._mainSiteService?.shutdown(); }
				catch (error) { Zotero.logError && Zotero.logError(error); }
				finally { Zotero.QLab._mainSiteService = null; }
			});
		}
		return service;
	};
})();
