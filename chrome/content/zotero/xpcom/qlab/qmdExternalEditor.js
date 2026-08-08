/*
	***** BEGIN LICENSE BLOCK *****

	Copyright © 2026 Chance Siyuan / Chatero contributors

	This file is part of Chatero (a Zotero fork).

	***** END LICENSE BLOCK *****
*/

/** Safe handoff of one Draft and its QLab repository to a macOS editor. */
Zotero.QLab = Zotero.QLab || {};

(function () {
	const EDITORS = Object.freeze([
		Object.freeze({ id: 'cursor', label: 'Cursor', application: 'Cursor', bundle: 'Cursor.app' }),
		Object.freeze({
			id: 'vscode',
			label: 'VS Code',
			application: 'Visual Studio Code',
			bundle: 'Visual Studio Code.app',
		}),
		Object.freeze({ id: 'vscodium', label: 'VSCodium', application: 'VSCodium', bundle: 'VSCodium.app' }),
		Object.freeze({ id: 'zed', label: 'Zed', application: 'Zed', bundle: 'Zed.app' }),
		Object.freeze({
			id: 'sublime',
			label: 'Sublime Text',
			application: 'Sublime Text',
			bundle: 'Sublime Text.app',
		}),
	]);

	Zotero.QLab.QMD_EXTERNAL_EDITORS = EDITORS;

	function stripTrailingSeparators(value) {
		let path = String(value || '').replace(/[\\/]+$/u, '');
		return path || '/';
	}

	Zotero.QLab.installedQmdEditors = async function (runtime) {
		if (!runtime || typeof runtime.exists !== 'function') {
			throw new Error('External editor detection requires an exists() runtime');
		}
		let home = typeof runtime.homeDirectory === 'function'
			? stripTrailingSeparators(runtime.homeDirectory())
			: '';
		let directories = ['/Applications', '/System/Applications'];
		if (home && home !== '/') directories.push(`${home}/Applications`);
		let installed = [];
		for (let editor of EDITORS) {
			for (let directory of directories) {
				if (await runtime.exists(`${directory}/${editor.bundle}`)) {
					installed.push(editor);
					break;
				}
			}
		}
		return installed;
	};

	Zotero.QLab.preferredQmdEditor = function (installed, rememberedID = '') {
		let list = Array.isArray(installed) ? installed : [];
		return list.find(editor => editor.id === rememberedID) || list[0] || null;
	};

	Zotero.QLab.openQmdInExternalEditor = async function (
		runtime,
		editor,
		repositoryRoot,
		relativePath
	) {
		if (!runtime || typeof runtime.realPath !== 'function'
				|| typeof runtime.launch !== 'function') {
			throw new Error('External editor launch requires realPath() and launch()');
		}
		if (!editor || !editor.application) {
			throw new Error('Choose an installed external editor');
		}
		let root = stripTrailingSeparators(repositoryRoot);
		let path = String(relativePath || '').replace(/\\/gu, '/').replace(/^\/+/, '');
		if (!root || root === '/' || !Zotero.QLab.isSafeWorkspaceRelativePath(path, { under: 'drafts' })
				|| !/\.qmd$/i.test(path)) {
			throw new Error('External editing accepts only a safe QMD path under drafts/');
		}
		let lexicalDraftRoot = `${root}/drafts`;
		let lexicalPath = `${root}/${path}`;
		let [realRoot, realDraftRoot, realPath] = await Promise.all([
			runtime.realPath(root),
			runtime.realPath(lexicalDraftRoot),
			runtime.realPath(lexicalPath),
		]);
		realRoot = stripTrailingSeparators(realRoot);
		realDraftRoot = stripTrailingSeparators(realDraftRoot);
		realPath = String(realPath || '');
		let expectedDraftRoot = `${realRoot}/drafts`;
		let expectedPath = `${realDraftRoot}/${path.slice('drafts/'.length)}`;
		if (realDraftRoot !== expectedDraftRoot || realPath !== expectedPath) {
			throw new Error('The selected Draft uses a symbolic link or resolves outside drafts/');
		}
		await runtime.launch(editor.application, [realRoot, realPath]);
	};

	Zotero.QLab.createQmdExternalEditorRuntime = function (spawn = null, overrides = {}) {
		let launchProcess = spawn;
		if (typeof launchProcess !== 'function') {
			launchProcess = async argv => {
				let runner = Zotero.QLab.createGeckoProcessRunner();
				let exitCode = null;
				let output = [];
				for await (let event of runner.run(argv[0], argv.slice(1))) {
					if (event.type === 'stderr' && event.data) output.push(event.data);
					if (event.type === 'exit') exitCode = event.exitCode;
				}
				if (exitCode !== 0) {
					throw new Error(output.join('\n') || `External editor exited with code ${exitCode}`);
				}
			};
		}
		let runtime = {
			exists: path => IOUtils.exists(path),
			realPath: async path => {
				let file = Components.classes['@mozilla.org/file/local;1']
					.createInstance(Components.interfaces.nsIFile);
				file.initWithPath(path);
				file.normalize();
				return String(file.path || path);
			},
			homeDirectory: () => {
				try {
					return String(Services.dirsvc.get('Home', Ci.nsIFile).path || '');
				}
				catch (e) {
					return '';
				}
			},
			launch: (application, paths) => launchProcess([
				'/usr/bin/open', '-a', application, ...paths,
			]),
		};
		return { ...runtime, ...overrides };
	};
})();
