import assert from "node:assert/strict";
import test from "node:test";
import { loadQLab } from "../lib/load-qlab.mjs";

test("inlineQmdFormatHTML renders inline math with KaTeX", async () => {
	const QLab = await loadQLab();
	const html = QLab.inlineQmdFormatHTML("Energy is $E = mc^2$ here.");
	assert.match(html, /katex/);
	assert.match(html, /qlab-qmd-math-inline/);
	assert.ok(!html.includes("$E = mc^2$"));
});

test("Visual QMD links allow only navigable research schemes and safe relative targets", async () => {
	const QLab = await loadQLab();
	const safe = [
		["https", "https://example.test/note"],
		["http", "http://127.0.0.1:43104/note.html"],
		["zotero", "zotero://open-pdf/library/items/ABC?page=2"],
		["chatero", "chatero://open-pdf/library/items/ABC?page=2"],
		["mail", "mailto:author@example.test"],
		["anchor", "#result"],
		["sibling", "./note.qmd"],
		["parent", "../index.qmd"],
		["root", "/knowledge/topic/"],
		["bare", "topic/note.qmd"],
	];
	for (const [label, href] of safe) {
		assert.equal(
			QLab.inlineQmdFormatHTML(`[${label}](${href})`),
			`<a href="${href}">${label}</a>`,
			href,
		);
	}

	for (const scheme of ["javascript", "data", "file", "chrome", "resource", "blob", "about"]) {
		const html = QLab.inlineQmdFormatHTML(`[unsafe](${scheme}:payload)`);
		assert.doesNotMatch(html, /<a\b/i, scheme);
		assert.match(html, /unsafe/, scheme);
	}
	assert.doesNotMatch(QLab.inlineQmdFormatHTML("[network](//evil.test/note)"), /<a\b/i);
	assert.doesNotMatch(QLab.inlineQmdFormatHTML("[slash](topic\\note.qmd)"), /<a\b/i);
});

test("renderDisplayMathHTML renders display math blocks", async () => {
	const QLab = await loadQLab();
	const html = QLab.renderDisplayMathHTML("$$\n\\int_0^1 x^2 dx\n$$");
	assert.match(html, /katex/);
	assert.match(html, /qlab-qmd-math-display/);
	assert.match(html, /qlab-qmd-math-block/);
	assert.ok(!html.includes("katex-mathml"));
});

test("callout blocks render inline math in card body", async () => {
	const QLab = await loadQLab();
	const block = {
		kind: "callout",
		source: "::: {#def .callout-note}\n\nDefine $f(u, G, x)$.\n\n:::",
		start: 0,
		end: 50,
	};
	const html = QLab.renderQmdBlockHTML(block);
	assert.match(html, /qlab-qmd-card-body/);
	assert.match(html, /katex/);
	assert.ok(!html.includes("<pre>"));
	assert.ok(!html.includes("$f(u, G, x)$"));
});

test("renderQmdBlockHTML uses KaTeX for display-math blocks", async () => {
	const QLab = await loadQLab();
	const block = {
		kind: "display-math",
		source: "$$\\alpha + \\beta$$",
		start: 0,
		end: 16,
	};
	const html = QLab.renderQmdBlockHTML(block);
	assert.match(html, /katex/);
	assert.ok(!html.includes("<pre"));
});

test("resolveQuartoPreviewTarget uses drafts root as cwd", async () => {
	const QLab = await loadQLab();
	const target = QLab.resolveQuartoPreviewTarget("/workspace", "drafts/note.qmd");
	assert.equal(target.cwd, "/workspace/drafts");
	assert.equal(target.file, "note.qmd");
});

for (let [path, page] of [
	["index.qmd", "/"],
	["local_alg.qmd", "/local_alg.html"],
	["topic/note.qmd", "/topic/note.html"],
	["topic/index.qmd", "/topic/"],
]) {
	test(`selected Quarto route for ${path}`, async () => {
		const QLab = await loadQLab();
		assert.equal(QLab.qmdQuartoPagePath(path), page);
	});
}

test("startQmdQuartoPreview probes and returns the selected page instead of the Draft index", async () => {
	const QLab = await loadQLab();
	QLab._qmdPreviewSessions = Object.create(null);
	let fetched = [];
	const runner = {
		async *run() {
			await new Promise(() => {});
		},
	};
	let url = await QLab.startQmdQuartoPreview("/workspace-route", "drafts/topic/note.qmd", {
		runner,
		fetch: async value => {
			fetched.push(String(value));
			return { ok: true };
		},
		port: 43104,
	});
	assert.equal(url, "http://127.0.0.1:43104/topic/note.html");
	assert.deepEqual(fetched, ["http://127.0.0.1:43104/topic/note.html"]);
	QLab.stopQmdQuartoPreview("/workspace-route", "drafts/topic/note.qmd");
});

test("startQmdQuartoPreview reuses the live session for the same Draft", async () => {
	const QLab = await loadQLab();
	QLab._qmdPreviewSessions = Object.create(null);
	let runs = 0;
	const runner = {
		async *run() {
			runs++;
			await new Promise(() => {});
		},
	};
	let options = {
		runner,
		fetch: async () => ({ ok: true }),
		port: 43105,
	};
	let first = await QLab.startQmdQuartoPreview("/workspace-reuse", "drafts/note.qmd", options);
	let second = await QLab.startQmdQuartoPreview("/workspace-reuse", "drafts/note.qmd", options);
	assert.equal(first, "http://127.0.0.1:43105/note.html");
	assert.equal(second, first);
	assert.equal(runs, 1);
	QLab.stopQmdQuartoPreview("/workspace-reuse", "drafts/note.qmd");
});

test("concurrent preview callers share readiness failure instead of publishing a dead URL", async () => {
	const QLab = await loadQLab();
	QLab._qmdPreviewSessions = Object.create(null);
	let release;
	let runs = 0;
	const gate = new Promise(resolve => { release = resolve; });
	const runner = {
		async *run() {
			runs++;
			await gate;
			yield { type: "stderr", data: "invalid qmd" };
			yield { type: "exit", exitCode: 1 };
		},
	};
	const options = {
		runner,
		fetch: async () => ({ ok: false }),
		pollIntervalMs: 1,
		timeoutMs: 100,
		port: 43109,
	};
	const first = QLab.startQmdQuartoPreview("/workspace-shared-pending", "drafts/note.qmd", options);
	const second = QLab.startQmdQuartoPreview("/workspace-shared-pending", "drafts/note.qmd", options);
	release();
	const outcomes = await Promise.allSettled([first, second]);
	assert.equal(runs, 1);
	assert.deepEqual(outcomes.map(result => result.status), ["rejected", "rejected"]);
	assert.match(outcomes[0].reason.message, /invalid qmd/);
	assert.match(outcomes[1].reason.message, /invalid qmd/);
});

test("concurrent preview startup shares Quarto discovery and one process", async () => {
	const QLab = await loadQLab();
	QLab._qmdPreviewSessions = Object.create(null);
	QLab._qmdPreviewStarts = Object.create(null);
	let releaseDiscovery;
	let discoveries = 0;
	let runs = 0;
	const discovery = new Promise(resolve => { releaseDiscovery = resolve; });
	const options = {
		runner: {
			async *run() {
				runs++;
				await new Promise(() => {});
			},
		},
		discoveryHost: {
			pathSearch: async () => {
				discoveries++;
				await discovery;
				return "/opt/homebrew/bin/quarto";
			},
			exists: async () => false,
		},
		fetch: async () => ({ ok: true }),
		port: 43111,
	};
	const first = QLab.startQmdQuartoPreview("/workspace-shared-start", "drafts/note.qmd", options);
	const second = QLab.startQmdQuartoPreview("/workspace-shared-start", "drafts/note.qmd", options);
	releaseDiscovery();
	const urls = await Promise.all([first, second]);
	assert.equal(discoveries, 1);
	assert.equal(runs, 1);
	assert.equal(urls[0], urls[1]);
	QLab.stopQmdQuartoPreview("/workspace-shared-start", "drafts/note.qmd");
});

test("shared preview leases keep Quarto alive until the last controller releases it", async () => {
	const QLab = await loadQLab();
	QLab._qmdPreviewSessions = Object.create(null);
	let killed = 0;
	const ownerA = {};
	const ownerB = {};
	const runner = {
		async *run(command, args, options) {
			options.registerKill(() => killed++);
			await new Promise(() => {});
		},
	};
	const base = {
		runner,
		fetch: async () => ({ ok: true }),
		port: 43110,
	};
	await Promise.all([
		QLab.startQmdQuartoPreview("/workspace-leases", "drafts/note.qmd", { ...base, owner: ownerA }),
		QLab.startQmdQuartoPreview("/workspace-leases", "drafts/note.qmd", { ...base, owner: ownerB }),
	]);
	QLab.stopQmdQuartoPreview("/workspace-leases", "drafts/note.qmd", { owner: ownerA });
	assert.equal(killed, 0);
	assert.equal(Object.keys(QLab._qmdPreviewSessions).length, 1);
	QLab.stopQmdQuartoPreview("/workspace-leases", "drafts/note.qmd", { owner: ownerB });
	assert.equal(killed, 1);
	assert.equal(Object.keys(QLab._qmdPreviewSessions).length, 0);
});

test("startQmdQuartoPreview restarts after a cached runner ends without an exit event", async () => {
	const QLab = await loadQLab();
	QLab._qmdPreviewSessions = Object.create(null);
	let runs = 0;
	let endRunner;
	let runnerEnded = new Promise(resolve => { endRunner = resolve; });
	const runner = {
		async *run() {
			runs++;
			if (runs === 1) {
				await runnerEnded;
			}
			else await new Promise(() => {});
		},
	};
	let options = {
		runner,
		fetch: async () => ({ ok: true }),
		port: 43106,
	};
	await QLab.startQmdQuartoPreview("/workspace-dead-cache", "drafts/note.qmd", options);
	endRunner();
	await new Promise(resolve => setTimeout(resolve, 0));
	await QLab.startQmdQuartoPreview("/workspace-dead-cache", "drafts/note.qmd", options);
	assert.equal(runs, 2);
	QLab.stopQmdQuartoPreview("/workspace-dead-cache", "drafts/note.qmd");
});

test("stopQmdQuartoPreview kills a process registered after the preview is stopped", async () => {
	const QLab = await loadQLab();
	QLab._qmdPreviewSessions = Object.create(null);
	let registerKill;
	let killed = 0;
	const runner = {
		async *run(command, args, options) {
			registerKill = options.registerKill;
			await new Promise(() => {});
		},
	};
	await QLab.startQmdQuartoPreview("/workspace-late-kill", "drafts/note.qmd", {
		runner,
		fetch: async () => ({ ok: true }),
		port: 43107,
	});
	QLab.stopQmdQuartoPreview("/workspace-late-kill", "drafts/note.qmd");
	registerKill(() => killed++);
	assert.equal(killed, 1);
});

test("discoverQuartoExecutable prefers PATH and checks common macOS installs", async () => {
	const QLab = await loadQLab();
	let fromPath = await QLab.discoverQuartoExecutable({
		pathSearch: async name => name === "quarto" ? "/custom/bin/quarto" : null,
		exists: async () => false,
	});
	assert.equal(fromPath, "/custom/bin/quarto");

	let checked = [];
	let common = await QLab.discoverQuartoExecutable({
		pathSearch: async () => null,
		exists: async path => {
			checked.push(path);
			return path === "/usr/local/bin/quarto";
		},
	});
	assert.equal(common, "/usr/local/bin/quarto");
	assert.deepEqual(checked, ["/usr/local/bin/quarto"]);
});

test("startQmdQuartoPreview passes drafts cwd and no-execute flags", async () => {
	const QLab = await loadQLab();
	let seen = null;
	const runner = {
		async *run(command, args, options) {
			seen = { command, args, options };
			await new Promise(() => {});
		},
	};
	await QLab.startQmdQuartoPreview("/workspace", "drafts/note.qmd", {
		runner,
		fetch: async () => ({ ok: true }),
		port: 43100,
	});
	assert.equal(seen.command, "quarto");
	assert.equal(seen.options.cwd, "/workspace/drafts");
	assert.equal(seen.args[0], "preview");
	assert.equal(seen.args[1], "note.qmd");
	assert.ok(seen.args.includes("--no-execute"));
	assert.ok(seen.args.includes("--host"));
	assert.ok(seen.args.includes("127.0.0.1"));
	assert.equal(seen.args.at(-1), "43100");
});

test("startQmdQuartoPreview uses a discovered absolute executable", async () => {
	const QLab = await loadQLab();
	QLab._qmdPreviewSessions = Object.create(null);
	let command = "";
	const runner = {
		async *run(value) {
			command = value;
			await new Promise(() => {});
		},
	};
	await QLab.startQmdQuartoPreview("/workspace-discovery", "drafts/note.qmd", {
		runner,
		discoveryHost: {
			pathSearch: async () => null,
			exists: async path => path === "/opt/homebrew/bin/quarto",
		},
		fetch: async () => ({ ok: true }),
		port: 43101,
	});
	assert.equal(command, "/opt/homebrew/bin/quarto");
});

test("startQmdQuartoPreview reports a spawn failure instead of timing out", async () => {
	const QLab = await loadQLab();
	QLab._qmdPreviewSessions = Object.create(null);
	const runner = {
		async *run() {
			throw new Error("spawn exploded");
		},
	};
	await assert.rejects(
		QLab.startQmdQuartoPreview("/workspace-spawn", "drafts/note.qmd", {
			runner,
			fetch: async () => ({ ok: false }),
			pollIntervalMs: 1,
			timeoutMs: 50,
			port: 43102,
		}),
		/spawn exploded/,
	);
});

test("startQmdQuartoPreview reports stderr from an early process exit", async () => {
	const QLab = await loadQLab();
	QLab._qmdPreviewSessions = Object.create(null);
	const runner = {
		async *run() {
			yield { type: "stderr", data: "bad yaml at line 2" };
			yield { type: "exit", exitCode: 1 };
		},
	};
	await assert.rejects(
		QLab.startQmdQuartoPreview("/workspace-exit", "drafts/note.qmd", {
			runner,
			fetch: async () => ({ ok: false }),
			pollIntervalMs: 1,
			timeoutMs: 50,
			port: 43103,
		}),
		/bad yaml at line 2.*code 1|code 1.*bad yaml at line 2/,
	);
});

test("startQmdQuartoPreview fails immediately when the runner exits cleanly before the page is ready", async () => {
	const QLab = await loadQLab();
	QLab._qmdPreviewSessions = Object.create(null);
	const runner = {
		async *run() {
			yield { type: "exit", exitCode: 0 };
		},
	};
	await assert.rejects(
		QLab.startQmdQuartoPreview("/workspace-clean-exit", "drafts/note.qmd", {
			runner,
			fetch: async () => ({ ok: false }),
			pollIntervalMs: 1,
			timeoutMs: 50,
			port: 43108,
		}),
		/process ended before becoming ready/,
	);
	assert.deepEqual(Object.keys(QLab._qmdPreviewSessions), []);
});
