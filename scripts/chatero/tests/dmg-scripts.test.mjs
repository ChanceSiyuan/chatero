import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const packageScript = join(root, "app/scripts/package_chatero_dmg");
const verifierScript = join(root, "app/scripts/verify_chatero_bundle");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const checksum = (name, value) => `${digest(value)}  ${name}\n`;

async function writeExecutable(path, body) {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

async function packageFixture(t, version = "1.0.SOURCE") {
  const dir = await mkdtemp(join(tmpdir(), "chatero-dmg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = join(dir, "Chatero.app");
  const dist = join(dir, "dist");
  const bin = join(dir, "bin");
  const versionFile = join(dir, "version");
  const moveCount = join(dir, "move-count");
  await mkdir(app, { recursive: true });
  await mkdir(dist, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(versionFile, version);
  await writeExecutable(join(bin, "pkg-dmg"), `#!/bin/bash
set -euo pipefail
[ "\${PKG_FAIL:-0}" = 0 ] || exit 41
while [ "$#" -gt 0 ]; do
  if [ "$1" = --target ]; then target="$2"; break; fi
  shift
done
mkdir -p "$(dirname "$target")"
printf 'new-dmg' > "$target"
`);
  await writeExecutable(join(bin, "hdiutil"), `#!/bin/bash
set -euo pipefail
[ "\${HDIUTIL_FAIL:-0}" = 0 ] || exit 42
[ "$1" = verify ] && [ -f "$2" ]
`);
  await writeExecutable(join(bin, "shasum"), `#!/bin/bash
set -euo pipefail
[ "\${SHASUM_FAIL:-0}" = 0 ] || exit 43
exec /usr/bin/shasum "$@"
`);
  await writeExecutable(join(bin, "mv"), `#!/bin/bash
set -euo pipefail
count=0
[ -f "$MOVE_COUNT" ] && count=$(cat "$MOVE_COUNT")
count=$((count + 1))
printf '%s\\n' "$count" > "$MOVE_COUNT"
case ",\${FAIL_MV_AT:-0}," in *,"$count",*) exit 44;; esac
exec /bin/mv "$@"
`);
  const run = (extra = {}) => spawnSync(packageScript, [], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CHATER0_PACKAGE_TEST_MODE: "1",
      CHATER0_PACKAGE_TEST_SKIP_BUILD: "1",
      CHATER0_PACKAGE_TEST_SKIP_BUNDLE_VERIFY: "1",
      CHATER0_PACKAGE_TEST_APP_BUNDLE: app,
      CHATER0_PACKAGE_TEST_DIST_DIR: dist,
      CHATER0_PACKAGE_TEST_VERSION_FILE: versionFile,
      CHATER0_PACKAGE_TEST_PKG_DMG: join(bin, "pkg-dmg"),
      CHATER0_PACKAGE_TEST_HDIUTIL: join(bin, "hdiutil"),
      CHATER0_PACKAGE_TEST_SHASUM: join(bin, "shasum"),
      CHATER0_PACKAGE_TEST_MV: join(bin, "mv"),
      MOVE_COUNT: moveCount,
      ...extra,
    },
  });
  return { app, dir, dist, run, versionFile };
}

async function writePriorPair(dist, version, value = "old-dmg") {
  const name = `Chatero-${version}.dmg`;
  await writeFile(join(dist, name), value);
  await writeFile(join(dist, `${name}.sha256`), checksum(name, value));
  return name;
}

test("package fixture publishes a final checksum bound to exactly the DMG basename", async (t) => {
  const fixture = await packageFixture(t);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const name = "Chatero-1.0.SOURCE.dmg";
  assert.equal(await readFile(join(fixture.dist, name), "utf8"), "new-dmg");
  assert.equal(await readFile(join(fixture.dist, `${name}.sha256`), "utf8"), checksum(name, "new-dmg"));
  assert.deepEqual((await readdir(fixture.dist)).filter((entry) => entry.startsWith(".chatero-dmg")), []);
});

test("package fixture rotates an existing verified pair with checksum bound to its previous DMG", async (t) => {
  const fixture = await packageFixture(t);
  const name = await writePriorPair(fixture.dist, "1.0.SOURCE");
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entries = await readdir(fixture.dist);
  const previousDmg = entries.find((entry) => entry.startsWith(`${name}.`) && entry.includes(".previous"));
  const previousChecksum = entries.find((entry) => entry.startsWith(`${name}.sha256.`) && entry.includes(".previous"));
  assert.ok(previousDmg);
  assert.ok(previousChecksum);
  assert.equal(await readFile(join(fixture.dist, previousChecksum), "utf8"), checksum(previousDmg, "old-dmg"));
  assert.equal(await readFile(join(fixture.dist, `${name}.sha256`), "utf8"), checksum(name, "new-dmg"));
});

test("package fixture rejects malformed versions before creating artifacts", async (t) => {
  for (const version of ["", "bad/name", "bad\r\n", "two\nlines", "space value"]) {
    const fixture = await packageFixture(t, version);
    const result = fixture.run();
    assert.notEqual(result.status, 0, `${JSON.stringify(version)} unexpectedly packaged`);
    assert.deepEqual(await readdir(fixture.dist), []);
  }
});

test("package fixture refuses a prior checksum that names a different artifact", async (t) => {
  const fixture = await packageFixture(t);
  const name = await writePriorPair(fixture.dist, "1.0.SOURCE");
  await writeFile(join(fixture.dist, `${name}.sha256`), checksum("other.dmg", "old-dmg"));
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not bound/);
  assert.equal(await readFile(join(fixture.dist, name), "utf8"), "old-dmg");
});

test("package fixture cleans temporary output after pkg-dmg, hdiutil, and checksum failures", async (t) => {
  for (const env of [{ PKG_FAIL: "1" }, { HDIUTIL_FAIL: "1" }, { SHASUM_FAIL: "1" }]) {
    const fixture = await packageFixture(t);
    const result = fixture.run(env);
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readdir(fixture.dist), []);
  }
});

test("package fixture restores a complete prior pair after checksum publication fails", async (t) => {
  const fixture = await packageFixture(t);
  const name = await writePriorPair(fixture.dist, "1.0.SOURCE");
  const result = fixture.run({ FAIL_MV_AT: "5" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restoring previous artifacts/);
  assert.equal(await readFile(join(fixture.dist, name), "utf8"), "old-dmg");
  assert.equal(await readFile(join(fixture.dist, `${name}.sha256`), "utf8"), checksum(name, "old-dmg"));
  assert.deepEqual((await readdir(fixture.dist)).filter((entry) => entry.startsWith(".chatero-dmg")), []);
});

test("package fixture retains recovery paths and emits a fatal diagnostic when rollback itself fails", async (t) => {
  const fixture = await packageFixture(t);
  await writePriorPair(fixture.dist, "1.0.SOURCE");
  const result = fixture.run({ FAIL_MV_AT: "5,6" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FATAL: rollback could not restore/);
  assert.ok((await readdir(fixture.dist)).some((entry) => entry.startsWith(".chatero-dmg")));
  assert.ok((await readdir(fixture.dist)).some((entry) => entry.includes(".previous")));
});

async function verifierFixture(t, ini = "Name=Chatero\nID=zotero@zotero.org\n") {
  const dir = await mkdtemp(join(tmpdir(), "chatero-verifier-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = join(dir, "Chatero.app");
  const bin = join(dir, "bin");
  const entitlements = join(dir, "entitlements.plist");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(app, "Contents", "Resources", "app"), { recursive: true });
  await mkdir(join(app, "Contents", "Resources", "integration", "word-for-mac"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(app, "Contents", "Info.plist"), "fixture");
  await writeFile(join(app, "Contents", "Resources", "app", "application.ini"), ini);
  await writeExecutable(join(app, "Contents", "MacOS", "zotero"), "#!/bin/bash\n");
  await writeFile(join(app, "Contents", "Resources", "integration", "word-for-mac", "libZoteroWordIntegration.dylib"), "fixture");
  await writeFile(entitlements, "fixture");
  await writeExecutable(join(bin, "PlistBuddy"), `#!/bin/bash
case "$2" in
  *CFBundleName*) printf '%s\\n' "\${TEST_BUNDLE_NAME:-Chatero}" ;;
  *CFBundleIdentifier*) printf '%s\\n' "\${TEST_BUNDLE_ID:-io.github.chancesiyuan.chatero}" ;;
  *CFBundleURLTypes*) printf '%s\\n' "\${TEST_SCHEME:-chatero}" ;;
  *CFBundleExecutable*) printf '%s\\n' "\${TEST_EXECUTABLE:-zotero}" ;;
  *automation.apple-events*) printf '%s\\n' "\${TEST_ENTITLEMENT:-true}" ;;
esac
`);
  await writeExecutable(join(bin, "codesign"), `#!/bin/bash
set -euo pipefail
if [ "$1" = --verify ]; then exit 0; fi
if [ "$1" = -dvvv ]; then
  printf 'Signature=%s\\nTeamIdentifier=%s\\n' "\${TEST_SIGNATURE:-adhoc}" "\${TEST_TEAM:-not set}"
  exit 0
fi
if [ "$1" = -d ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --entitlements ]; then cp "$TEST_ENTITLEMENTS" "$2"; exit 0; fi
    shift
  done
fi
exit 1
`);
  const run = (extra = {}) => spawnSync(verifierScript, [app], {
    encoding: "utf8",
    env: {
      ...process.env,
      CHATER0_VERIFY_TEST_MODE: "1",
      CHATER0_VERIFY_TEST_PLISTBUDDY: join(bin, "PlistBuddy"),
      CHATER0_VERIFY_TEST_CODESIGN: join(bin, "codesign"),
      TEST_ENTITLEMENTS: entitlements,
      ...extra,
    },
  });
  return { run };
}

test("bundle verifier accepts the staged Chatero app", () => {
  const result = spawnSync(verifierScript, [join(root, "app/staging/Chatero.app")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("bundle verifier rejects non-ad-hoc metadata, active UpdateURL, wrong executable, and missing Word entitlement", async (t) => {
  for (const [ini, env] of [
    [undefined, { TEST_SIGNATURE: "Developer ID Application" }],
    [undefined, { TEST_TEAM: "ABC123" }],
    ["Name=Chatero\nID=zotero@zotero.org\nUpdateURL=https://updates.example/\n", {}],
    [undefined, { TEST_EXECUTABLE: "other" }],
    [undefined, { TEST_ENTITLEMENT: "false" }],
  ]) {
    const fixture = await verifierFixture(t, ini);
    const result = fixture.run(env);
    assert.notEqual(result.status, 0);
  }
});
