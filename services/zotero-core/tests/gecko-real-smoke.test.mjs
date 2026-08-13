import assert from "node:assert/strict";
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
    assert.equal(status.readOnly, true);
    assert.equal(status.schemaVersion, 1);
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
