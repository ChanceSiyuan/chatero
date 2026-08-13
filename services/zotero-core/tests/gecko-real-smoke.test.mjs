import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { startCore } from "../supervisor/core-supervisor.mjs";

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(CORE_ROOT, "..", "..");
const DEFAULT_GECKO_EXECUTABLE = join(
  REPOSITORY_ROOT,
  "app",
  "staging",
  "Chatero.app",
  "Contents",
  "MacOS",
  "zotero",
);

const geckoExecutable = process.env.CHATERO_GECKO_EXECUTABLE || DEFAULT_GECKO_EXECUTABLE;
const hasGeckoExecutable = await stat(geckoExecutable).then(value => value.isFile()).catch(() => false);

const running = [];
const temporaryDirectories = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(running.splice(0).map(value => value.stop().catch(() => {})));
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }).catch(() => {})));
});

test(
  "launches a real headless Gecko Core, serves read-only Library RPC, and stops without a residual session",
  { skip: hasGeckoExecutable ? false : `Gecko Core executable not available: ${geckoExecutable}` },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "chatero-gecko-real-smoke-"));
    temporaryDirectories.push(root);
    const profileDirectory = join(root, "profile");
    await mkdir(profileDirectory, { mode: 0o700 });

    const core = await startCore({
      geckoExecutable,
      profileDirectory,
      readyTimeoutMs: 60000,
      upstreamVersion: "7.0-real-smoke",
    });
    running.push(core);

    assert.equal(core.mode, "gecko");
    assert.ok(core.child.spawnargs.includes("-headless"));
    assert.ok(core.child.spawnargs.includes("-ChateroCore"));

    const status = await core.client.request("profile.status", {});
    assert.equal(status.readOnly, false);
    assert.ok(status.schemaVersion >= 76);
    assert.ok(status.compatibilityVersion >= 1);
    assert.equal(status.quickCheckPassed, true);
    assert.match(status.upstreamVersion, /^11\.0\.SOURCE\./);

    const collections = await core.client.request("library.collections", {});
    assert.ok(Array.isArray(collections.collections));

    const search = await core.client.request("library.search", { limit: 10, query: "" });
    assert.equal(typeof search.total, "number");

    const sessionDirectory = core.sessionDirectory;
    const stopped = await core.stop();
    assert.equal(stopped, true);

    await assert.rejects(stat(sessionDirectory), /ENOENT/);
  },
);

test(
  "replays a durable write receipt after a real Gecko Core restart without a second event",
  { skip: hasGeckoExecutable ? false : `Gecko Core executable not available: ${geckoExecutable}` },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "chatero-gecko-restart-smoke-"));
    temporaryDirectories.push(root);
    const profileDirectory = join(root, "profile");
    await mkdir(profileDirectory, { mode: 0o700 });
    const params = {
      action: "create",
      expectedRevision: 0,
      idempotencyKey: `real-gecko-${randomUUID()}`,
      libraryId: 1,
      name: "Durable receipt",
    };

    const firstCore = await startCore({ geckoExecutable, profileDirectory, readyTimeoutMs: 60000 });
    running.push(firstCore);
    const first = await firstCore.client.request("library.collection-mutate", params).catch(error => {
			throw new Error(`first Core write failed: ${error.message}`, { cause: error });
		});
    assert.equal(first.replayed, false);
    assert.equal(first.revision, 1);
    const firstKey = first.collectionKey;
    await firstCore.stop();
    running.splice(running.indexOf(firstCore), 1);
		const stored = await execFileAsync("/usr/bin/sqlite3", [join(profileDirectory, "zotero", "zotero.sqlite"),
			"SELECT setting || '|' || key || '|' || value FROM settings WHERE setting LIKE 'chateroCoreTransaction%';"]);
		assert.match(stored.stdout, /"state":"completed"/);

    const secondCore = await startCore({ geckoExecutable, profileDirectory, readyTimeoutMs: 60000 });
    running.push(secondCore);
    const replay = await secondCore.client.request("library.collection-mutate", params).catch(error => {
			throw new Error(`restarted Core replay failed: ${error.message}; stored=${stored.stdout.trim()}`, { cause: error });
		});
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision, 1);
    assert.equal(replay.collectionKey, firstKey);
    assert.equal((await secondCore.client.request("core.events", { afterSequence: 0, limit: 10 })).events.length, 0);
  },
);
