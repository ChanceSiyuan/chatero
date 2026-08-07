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
const assertFinished = (result) => {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, "fixture subprocess timed out or was killed");
};

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
  const copyCount = join(dir, "copy-count");
  const removeCount = join(dir, "remove-count");
  const shasumCount = join(dir, "shasum-count");
  const packageArgs = join(dir, "pkg-dmg-args");
  const verifierLog = join(dir, "verifier.log");
  await mkdir(app, { recursive: true });
  await mkdir(dist, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(versionFile, version);
  await writeExecutable(join(bin, "pkg-dmg"), `#!/bin/bash
set -euo pipefail
[ "\${PKG_FAIL:-0}" = 0 ] || exit 41
[ "\${REQUIRE_VERIFIER:-0}" = 0 ] || [ -s "$VERIFIER_LOG" ]
printf '%s\\n' "$@" > "$PKG_ARGS"
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
count=0
[ -f "$SHASUM_COUNT" ] && count=$(cat "$SHASUM_COUNT")
count=$((count + 1))
printf '%s\\n' "$count" > "$SHASUM_COUNT"
case ",\${SHASUM_FAIL_AT:-0}," in *,"$count",*) exit 43;; esac
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
  await writeExecutable(join(bin, "cp"), `#!/bin/bash
set -euo pipefail
count=0
[ -f "$COPY_COUNT" ] && count=$(cat "$COPY_COUNT")
count=$((count + 1))
printf '%s\\n' "$count" > "$COPY_COUNT"
case ",\${FAIL_COPY_AT:-0}," in *,"$count",*) exit 45;; esac
exec /bin/cp "$@"
`);
  await writeExecutable(join(bin, "rm"), `#!/bin/bash
set -euo pipefail
count=0
[ -f "$REMOVE_COUNT" ] && count=$(cat "$REMOVE_COUNT")
count=$((count + 1))
printf '%s\\n' "$count" > "$REMOVE_COUNT"
case ",\${FAIL_REMOVE_AT:-0}," in *,"$count",*) exit 46;; esac
exec /bin/rm "$@"
`);
  await writeExecutable(join(bin, "verify"), `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$1" >> "$VERIFIER_LOG"
`);
  const run = (extra = {}) => spawnSync(packageScript, [], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
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
      CHATER0_PACKAGE_TEST_COPY: join(bin, "cp"),
      CHATER0_PACKAGE_TEST_REMOVE: join(bin, "rm"),
      CHATER0_PACKAGE_TEST_VERIFY: join(bin, "verify"),
      MOVE_COUNT: moveCount,
      COPY_COUNT: copyCount,
      REMOVE_COUNT: removeCount,
      SHASUM_COUNT: shasumCount,
      PKG_ARGS: packageArgs,
      VERIFIER_LOG: verifierLog,
      ...extra,
    },
  });
  return { app, dir, dist, run, versionFile, packageArgs, verifierLog };
}

async function writePriorPair(dist, version, value = "old-dmg") {
  const name = `Chatero-${version}.dmg`;
  await writeFile(join(dist, name), value);
  await writeFile(join(dist, `${name}.sha256`), checksum(name, value));
  return name;
}

async function assertBoundPair(dist, dmgName, checksumName = `${dmgName}.sha256`, value) {
  const artifact = await readFile(join(dist, dmgName), "utf8");
  const line = await readFile(join(dist, checksumName), "utf8");
  assert.equal(line, checksum(dmgName, value ?? artifact));
}

async function assertHasBoundRecoveryPair(dist) {
  const entries = await readdir(dist);
  const dmgs = entries.filter((entry) => entry.includes(".dmg") && !entry.includes(".sha256"));
  for (const dmg of dmgs) {
    const checksumName = dmg.includes(".dmg.")
      ? dmg.replace(".dmg.", ".dmg.sha256.")
      : `${dmg}.sha256`;
    if (!entries.includes(checksumName)) continue;
    const artifact = await readFile(join(dist, dmg), "utf8");
    if (await readFile(join(dist, checksumName), "utf8") === checksum(dmg, artifact)) return;
  }
  assert.fail(`no exact checksum-bound recovery pair among: ${entries.join(", ")}`);
}

test("package fixture publishes a final checksum bound to exactly the DMG basename", async (t) => {
  const fixture = await packageFixture(t);
  const result = fixture.run();
  assertFinished(result);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const name = "Chatero-1.0.SOURCE.dmg";
  assert.equal(await readFile(join(fixture.dist, name), "utf8"), "new-dmg");
  assert.equal(await readFile(join(fixture.dist, `${name}.sha256`), "utf8"), checksum(name, "new-dmg"));
  assert.deepEqual((await readdir(fixture.dist)).filter((entry) => entry.startsWith(".chatero-dmg")), []);
});

test("package fixture invokes its verifier first and passes the personal non-notarizing pkg-dmg contract", async (t) => {
  const fixture = await packageFixture(t);
  const result = fixture.run({ CHATER0_PACKAGE_TEST_SKIP_BUNDLE_VERIFY: "0", REQUIRE_VERIFIER: "1" });
  assertFinished(result);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await readFile(fixture.verifierLog, "utf8"), `${fixture.app}\n`);
  const args = (await readFile(fixture.packageArgs, "utf8")).trim().split("\n");
  assert.deepEqual(args.slice(0, 6), ["--source", fixture.app, "--target", args[3], "--sourcefile", "--volname"]);
  assert.equal(args[6], "Chatero");
  assert.ok(!args.some((arg) => /notariz/i.test(arg)));
});

test("package fixture rotates an existing verified pair with checksum bound to its previous DMG", async (t) => {
  const fixture = await packageFixture(t);
  const name = await writePriorPair(fixture.dist, "1.0.SOURCE");
  const result = fixture.run();
  assertFinished(result);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entries = await readdir(fixture.dist);
  const previousDmg = entries.find((entry) => entry.startsWith(`${name}.`) && entry.includes(".previous") && !entry.includes(".sha256"));
  const previousChecksum = entries.find((entry) => entry.startsWith(`${name}.sha256.`) && entry.includes(".previous"));
  assert.ok(previousDmg);
  assert.ok(previousChecksum);
  assert.equal(await readFile(join(fixture.dist, previousChecksum), "utf8"), checksum(previousDmg, "old-dmg"));
  assert.equal(await readFile(join(fixture.dist, `${name}.sha256`), "utf8"), checksum(name, "new-dmg"));
});

test("copy-on-write backup failure leaves the existing final pair untouched", async (t) => {
  const fixture = await packageFixture(t);
  const name = await writePriorPair(fixture.dist, "1.0.SOURCE");
  const result = fixture.run({ FAIL_COPY_AT: "1" });
  assertFinished(result);
  assert.notEqual(result.status, 0);
  await assertBoundPair(fixture.dist, name, `${name}.sha256`, "old-dmg");
  assert.deepEqual((await readdir(fixture.dist)).filter((entry) => entry.includes(".previous")), []);
});

test("package fixture rejects malformed versions before creating artifacts", async (t) => {
  for (const version of ["", "bad/name", "bad\r\n", "two\nlines", "space value"]) {
    const fixture = await packageFixture(t, version);
    const result = fixture.run();
    assertFinished(result);
    assert.notEqual(result.status, 0, `${JSON.stringify(version)} unexpectedly packaged`);
    assert.deepEqual(await readdir(fixture.dist), []);
  }
});

test("package fixture rejects a version containing a NUL byte without producing artifacts", async (t) => {
  const fixture = await packageFixture(t);
  await writeFile(fixture.versionFile, Buffer.from("1.0\0beta\n"));
  const result = fixture.run();
  assertFinished(result);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await readdir(fixture.dist), []);
});

test("package fixture refuses a prior checksum that names a different artifact", async (t) => {
  const fixture = await packageFixture(t);
  const name = await writePriorPair(fixture.dist, "1.0.SOURCE");
  await writeFile(join(fixture.dist, `${name}.sha256`), checksum("other.dmg", "old-dmg"));
  const result = fixture.run();
  assertFinished(result);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not bound/);
  assert.equal(await readFile(join(fixture.dist, name), "utf8"), "old-dmg");
});

test("package fixture cleans temporary output after pkg-dmg, hdiutil, and checksum failures", async (t) => {
  for (const env of [{ PKG_FAIL: "1" }, { HDIUTIL_FAIL: "1" }, { SHASUM_FAIL: "1" }]) {
    const fixture = await packageFixture(t);
    const result = fixture.run(env);
    assertFinished(result);
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readdir(fixture.dist), []);
  }
});

test("package fixture restores a complete prior pair after checksum publication fails", async (t) => {
  const fixture = await packageFixture(t);
  const name = await writePriorPair(fixture.dist, "1.0.SOURCE");
  const result = fixture.run({ FAIL_MV_AT: "5" });
  assertFinished(result);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restoring final from verified backup/);
  assert.equal(await readFile(join(fixture.dist, name), "utf8"), "old-dmg");
  assert.equal(await readFile(join(fixture.dist, `${name}.sha256`), "utf8"), checksum(name, "old-dmg"));
  assert.deepEqual((await readdir(fixture.dist)).filter((entry) => entry.startsWith(".chatero-dmg")), []);
});

test("ordinary rollback leaves only complete checksum-bound pairs", async (t) => {
  const fixture = await packageFixture(t);
  const name = await writePriorPair(fixture.dist, "1.0.SOURCE");
  const result = fixture.run({ FAIL_MV_AT: "5" });
  assertFinished(result);
  assert.notEqual(result.status, 0);
  const entries = await readdir(fixture.dist);
  for (const entry of entries.filter((item) => item.includes(".previous") && item.includes(".sha256"))) {
    const artifact = entry.replace(".sha256.", ".");
    await assertBoundPair(fixture.dist, artifact, entry);
  }
  await assertBoundPair(fixture.dist, name, `${name}.sha256`, "old-dmg");
});

test("early backup copy/checksum cleanup failures retain an exact recovery pair", async (t) => {
  const fixture = await packageFixture(t);
  const name = await writePriorPair(fixture.dist, "1.0.SOURCE");
  const result = fixture.run({ FAIL_COPY_AT: "1,2", FAIL_REMOVE_AT: "1,2,3" });
  assertFinished(result);
  assert.notEqual(result.status, 0);
  await assertBoundPair(fixture.dist, name, `${name}.sha256`, "old-dmg");
});

test("copy-on-write backup survives injected checksum-move and remove failures", async (t) => {
  for (const env of [{ FAIL_MV_AT: "1" }, { FAIL_MV_AT: "2" }, { FAIL_MV_AT: "5", FAIL_REMOVE_AT: "1" }]) {
    const fixture = await packageFixture(t);
    await writePriorPair(fixture.dist, "1.0.SOURCE");
    const result = fixture.run(env);
    assertFinished(result);
    assert.notEqual(result.status, 0);
    await assertHasBoundRecoveryPair(fixture.dist);
  }
});

test("package fixture removes fresh partial publication after checksum or final-validation failure", async (t) => {
  for (const env of [{ FAIL_MV_AT: "2" }, { SHASUM_FAIL_AT: "2" }]) {
    const fixture = await packageFixture(t);
    const result = fixture.run(env);
    assertFinished(result);
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readdir(fixture.dist), []);
  }
});

test("package fixture preserves a bound previous pair through restoration move and validation failures", async (t) => {
  for (const env of [{ FAIL_MV_AT: "5,7" }, { FAIL_MV_AT: "5,8" }, { SHASUM_FAIL_AT: "4,5" }]) {
    const fixture = await packageFixture(t);
    const name = await writePriorPair(fixture.dist, "1.0.SOURCE");
    const result = fixture.run(env);
    assertFinished(result);
    assert.notEqual(result.status, 0);
    const entries = await readdir(fixture.dist);
    const previousDmg = entries.find((entry) => entry.startsWith(`${name}.`) && entry.includes(".previous") && !entry.includes(".sha256"));
    const previousChecksum = entries.find((entry) => entry.startsWith(`${name}.sha256.`) && entry.includes(".previous"));
    assert.ok(previousDmg, `${JSON.stringify(env)}: ${entries.join(", ")}\n${result.stderr}`);
    assert.ok(previousChecksum, `${JSON.stringify(env)}: ${entries.join(", ")}\n${result.stderr}`);
    assert.equal(await readFile(join(fixture.dist, previousChecksum), "utf8"), checksum(previousDmg, "old-dmg"));
  }
});

test("package fixture retains recovery paths and emits a fatal diagnostic when rollback itself fails", async (t) => {
  const fixture = await packageFixture(t);
  await writePriorPair(fixture.dist, "1.0.SOURCE");
  const result = fixture.run({ FAIL_MV_AT: "5,6" });
  assertFinished(result);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FATAL: final restoration move failed; valid recovery pair remains/);
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
    timeout: 10_000,
    killSignal: "SIGKILL",
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
  const result = spawnSync(verifierScript, [join(root, "app/staging/Chatero.app")], {
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  assertFinished(result);
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
    assertFinished(result);
    assert.notEqual(result.status, 0);
  }
});
