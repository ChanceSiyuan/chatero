import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

async function fixtureHome() {
  const home = await mkdtemp(join(tmpdir(), "chatero-zotero-profiles-"));
  temporaryDirectories.push(home);
  const support = join(home, "Library", "Application Support", "Zotero");
  const first = join(support, "Profiles", "alpha.default");
  const second = join(support, "Profiles", "beta.research");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(join(support, "profiles.ini"), [
    "[General]",
    "StartWithLastProfile=1",
    "",
    "[Profile0]",
    "Name=Research Library",
    "IsRelative=1",
    "Path=Profiles/beta.research",
    "Default=1",
    "",
    "[Profile1]",
    "Name=Personal Library",
    "IsRelative=1",
    "Path=Profiles/alpha.default",
    "",
  ].join("\n"));
  return { first, home, second, support };
}

test("discovers existing macOS Zotero profiles read-only and orders the default first", async () => {
  const { discoverZoteroProfiles } = await import("../extensions/chatero-zotero/zotero-profile-discovery.mjs");
  const { first, home, second } = await fixtureHome();

  assert.deepEqual(await discoverZoteroProfiles({ homeDirectory: home, platform: "darwin" }), [
    { dataPath: join(home, "Zotero"), default: true, name: "Research Library", path: second, source: "Zotero" },
    { dataPath: join(home, "Zotero"), default: false, name: "Personal Library", path: first, source: "Zotero" },
  ]);
});

test("profiles.ini parsing rejects traversal, duplicate keys, oversized input, and symlink profiles", async () => {
  const { discoverZoteroProfiles, parseZoteroProfilesIni } = await import("../extensions/chatero-zotero/zotero-profile-discovery.mjs");
  const { home, support } = await fixtureHome();

  assert.throws(() => parseZoteroProfilesIni("[Profile0]\nName=Escape\nIsRelative=1\nPath=../outside\n", { baseDirectory: support }), /escapes/);
  assert.throws(() => parseZoteroProfilesIni("[Profile0]\nName=One\nName=Two\nIsRelative=1\nPath=Profiles/one\n", { baseDirectory: support }), /duplicate/);
  assert.throws(() => parseZoteroProfilesIni("x".repeat(131_073), { baseDirectory: support }), /too large/);

  const linked = join(support, "Profiles", "linked.default");
  await symlink(join(support, "Profiles", "alpha.default"), linked);
  await writeFile(join(support, "profiles.ini"), "[Profile0]\nName=Linked\nIsRelative=1\nPath=Profiles/linked.default\nDefault=1\n");
  assert.deepEqual(await discoverZoteroProfiles({ homeDirectory: home, platform: "darwin" }), []);
});

test("uses a bounded absolute custom Zotero data directory preference", async () => {
  const { discoverZoteroProfiles, parseZoteroDataDirectoryPreference } = await import("../extensions/chatero-zotero/zotero-profile-discovery.mjs");
  const { home, second } = await fixtureHome();
  const custom = join(home, "Research Data");
  await mkdir(custom);
  const preferences = `user_pref("extensions.zotero.useDataDir", true);\nuser_pref("extensions.zotero.dataDir", ${JSON.stringify(custom)});\n`;
  assert.equal(parseZoteroDataDirectoryPreference(preferences), custom);
  await writeFile(join(second, "prefs.js"), preferences);
  const profiles = await discoverZoteroProfiles({ homeDirectory: home, platform: "darwin" });
  assert.equal(profiles[0].dataPath, custom);
  assert.throws(() => parseZoteroDataDirectoryPreference('user_pref("extensions.zotero.useDataDir", true);\nuser_pref("extensions.zotero.dataDir", "relative");\n'), /absolute/iu);
  assert.throws(() => parseZoteroDataDirectoryPreference("x".repeat(1_048_577)), /too large/iu);
});

test("profile chooser requires an explicit item and exposes a manual fallback", async () => {
  const { selectDiscoveredZoteroProfile } = await import("../extensions/chatero-zotero/zotero-profile-discovery.mjs");
  const profiles = [{ dataPath: "/safe/data", default: true, name: "Research", path: "/safe/research", source: "Zotero" }];
  let received;
  const picked = await selectDiscoveredZoteroProfile({
    profiles,
    showQuickPick: async (items, options) => {
      received = { items, options };
      return items[0];
    },
  });
  assert.deepEqual(picked, { dataPath: "/safe/data", kind: "profile", name: "Research", path: "/safe/research" });
  assert.equal(received.options.title, "Choose the Zotero profile for Chatero Core");
  assert.deepEqual(received.items.map(item => item.label), ["$(star-full) Research", "$(folder-opened) Choose another folder…"]);

  assert.deepEqual(await selectDiscoveredZoteroProfile({
    profiles,
    showQuickPick: async items => items.at(-1),
  }), { kind: "manual" });
  assert.equal(await selectDiscoveredZoteroProfile({ profiles, showQuickPick: async () => undefined }), null);
});
