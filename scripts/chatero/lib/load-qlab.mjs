import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import katex from "katex";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const qlabRoot = join(repositoryRoot, "chrome/content/zotero/xpcom/qlab");

const QLAB_SCRIPTS = [
	"tabGroups.js",
	"qlabWorkspace.js",
	"researchActions.js",
	"settings.js",
	"arrangement.js",
	"draftWorkingCopy.js",
	"agentRuntime.js",
	"codexDiscovery.js",
	"processRunner.js",
	"codexExecProvider.js",
	"agentProviders.js",
	"splitLayout.js",
	"readerContext.js",
	"readerIcons.js",
	"readerHooks.js",
	"approvalPolicy.js",
	"chatRules.js",
	"chatThreadIO.js",
	"workspaceSearch.js",
	"qmdCompletion.js",
	"chatComposerContext.js",
	"qmdDraftIO.js",
	"qmdDraftSession.js",
	"qmdSourceModel.js",
	"qmdLanguage.js",
	"qmdExplorer.js",
	"qmdMathRender.js",
	"qmdMarkdownLite.js",
	"qmdSurface.js",
	"qmdApply.js",
	"qmdPreview.js",
	"phase4.js",
	"qlabModule.js",
];

/**
 * Load Chatero QLab XPCOM scripts into an isolated Zotero.QLab namespace.
 */
export async function loadQLab(extraZotero = {}) {
	const Zotero = {
		QLab: {},
		logError: () => {},
		debug: () => {},
		// Mirrors the production zotero:// -> chatero:// public link mapping.
		toExternalURI: (uri) => String(uri).replace(/^zotero:\/\//, "chatero://"),
		...extraZotero,
	};
	const sandbox = { Zotero, console };
	sandbox.fetch = typeof globalThis.fetch === "function"
		? (...args) => globalThis.fetch(...args)
		: () => Promise.resolve({ ok: true });
	for (const name of QLAB_SCRIPTS) {
		const source = await readFile(join(qlabRoot, name), "utf8");
		runInNewContext(source, sandbox, { filename: name });
	}
	Zotero.QLab._katexCache = katex;
	return Zotero.QLab;
}
