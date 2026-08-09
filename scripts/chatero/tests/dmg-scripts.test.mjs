import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const packageScript = join(root, "app/scripts/package_chatero_dmg");
const verifierScript = join(root, "app/scripts/verify_chatero_bundle");
const starterRoot = join(root, "resource", "chatero", "qlab-starter");
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
  const removeArgs = join(dir, "remove-args");
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
printf '%s\\n' "$@" > "$REMOVE_ARGS"
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
      REMOVE_ARGS: removeArgs,
      SHASUM_COUNT: shasumCount,
      PKG_ARGS: packageArgs,
      VERIFIER_LOG: verifierLog,
      ...extra,
    },
  });
  return {
    app,
    dir,
    dist,
    run,
    versionFile,
    packageArgs,
    verifierLog,
    moveCount,
    copyCount,
    removeCount,
    removeArgs,
  };
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

async function assertExactRecoveryLayout(dist, { allowEmpty = false } = {}) {
  const entries = await readdir(dist);
  const dmgs = entries.filter((entry) => entry.includes(".dmg") && !entry.includes(".sha256"));
  const checksums = entries.filter((entry) => entry.includes(".sha256"));

  if (dmgs.length === 0 && checksums.length === 0) {
    assert.ok(allowEmpty, `recovery layout unexpectedly empty: ${dist}`);
    return;
  }

  const expectedChecksums = new Map();
  for (const dmg of dmgs) {
    const match = /^(Chatero-[A-Za-z0-9][A-Za-z0-9._+-]*\.dmg)(\.\d{8}T\d{6}Z\.previous(?:\.\d+)?)?$/.exec(dmg);
    assert.ok(match, `unrecognized final/previous DMG name: ${dmg}`);
    const checksumName = `${match[1]}.sha256${match[2] ?? ""}`;
    assert.ok(!expectedChecksums.has(checksumName), `duplicate checksum binding for ${dmg}`);
    expectedChecksums.set(checksumName, dmg);
  }

  assert.equal(checksums.length, expectedChecksums.size, `orphan or duplicate checksum among: ${entries.join(", ")}`);
  for (const checksumName of checksums) {
    assert.ok(expectedChecksums.has(checksumName), `orphan or misnamed checksum: ${checksumName}`);
  }
  for (const [checksumName, dmg] of expectedChecksums) {
    assert.ok(checksums.includes(checksumName), `DMG has no exact checksum: ${dmg}`);
    const artifact = await readFile(join(dist, dmg));
    assert.equal(
      await readFile(join(dist, checksumName), "utf8"),
      checksum(dmg, artifact),
      `checksum is not exactly bound to ${dmg}`,
    );
  }
}

test("recovery-layout assertion rejects every orphan, misbound, or duplicate checksum entry", async (t) => {
  const controls = [
    async (dist, name) => {
      await writeFile(join(dist, `${name}.20260807T000000Z.previous`), "orphan-dmg");
    },
    async (dist, name) => {
      await writeFile(join(dist, `${name}.sha256.20260807T000000Z.previous`), checksum(`${name}.20260807T000000Z.previous`, "orphan-dmg"));
    },
    async (dist, name) => {
      await writeFile(join(dist, `${name}.sha256`), checksum("other.dmg", "old-dmg"));
    },
    async (dist, name) => {
      const line = checksum(name, "old-dmg");
      await writeFile(join(dist, `${name}.sha256`), line + line);
    },
  ];

  for (const mutate of controls) {
    const dist = await mkdtemp(join(tmpdir(), "chatero-recovery-layout-"));
    t.after(() => rm(dist, { recursive: true, force: true }));
    const name = await writePriorPair(dist, "1.0.SOURCE");
    await mutate(dist, name);
    await assert.rejects(() => assertExactRecoveryLayout(dist));
  }
});

test("package fixture publishes a final checksum bound to exactly the DMG basename", async (t) => {
  const fixture = await packageFixture(t);
  const result = fixture.run();
  assertFinished(result);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const name = "Chatero-1.0.SOURCE.dmg";
  assert.equal(await readFile(join(fixture.dist, name), "utf8"), "new-dmg");
  assert.equal(await readFile(join(fixture.dist, `${name}.sha256`), "utf8"), checksum(name, "new-dmg"));
  await assertExactRecoveryLayout(fixture.dist);
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
  await assertExactRecoveryLayout(fixture.dist);
});

test("copy-on-write backup failure leaves the existing final pair untouched", async (t) => {
  const fixture = await packageFixture(t);
  const name = await writePriorPair(fixture.dist, "1.0.SOURCE");
  const result = fixture.run({ FAIL_COPY_AT: "1" });
  assertFinished(result);
  assert.notEqual(result.status, 0);
  await assertBoundPair(fixture.dist, name, `${name}.sha256`, "old-dmg");
  await assertExactRecoveryLayout(fixture.dist);
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

test("ordinary rollback leaves no previous DMG or checksum orphan", async (t) => {
  const fixture = await packageFixture(t);
  const name = await writePriorPair(fixture.dist, "1.0.SOURCE");
  const result = fixture.run({ FAIL_MV_AT: "5" });
  assertFinished(result);
  assert.notEqual(result.status, 0);
  await assertExactRecoveryLayout(fixture.dist);
  await assertBoundPair(fixture.dist, name, `${name}.sha256`, "old-dmg");
});

test("backup checksum-move failure reaches first cleanup removal after the previous DMG copy", async (t) => {
  const fixture = await packageFixture(t);
  const name = await writePriorPair(fixture.dist, "1.0.SOURCE");
  const result = fixture.run({ FAIL_MV_AT: "1", FAIL_REMOVE_AT: "1" });
  assertFinished(result);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Backup creation failed; existing final pair remains recoverable/);
  assert.equal(await readFile(fixture.copyCount, "utf8"), "1\n");
  assert.equal(await readFile(fixture.moveCount, "utf8"), "1\n");
  assert.equal(await readFile(fixture.removeCount, "utf8"), "1\n");
  const removeArgs = (await readFile(fixture.removeArgs, "utf8")).trim().split("\n");
  assert.equal(removeArgs[0], "-f");
  assert.match(removeArgs[1], new RegExp(`${name}\\.\\d{8}T\\d{6}Z\\.previous$`));
  await assertBoundPair(fixture.dist, name, `${name}.sha256`, "old-dmg");
  await assertExactRecoveryLayout(fixture.dist);
});

test("copy-on-write backup survives injected checksum-move and remove failures", async (t) => {
  for (const env of [{ FAIL_MV_AT: "1" }, { FAIL_MV_AT: "2" }, { FAIL_MV_AT: "5", FAIL_REMOVE_AT: "1" }]) {
    const fixture = await packageFixture(t);
    await writePriorPair(fixture.dist, "1.0.SOURCE");
    const result = fixture.run(env);
    assertFinished(result);
    assert.notEqual(result.status, 0);
    await assertExactRecoveryLayout(fixture.dist);
  }
});

test("package fixture removes fresh partial publication after checksum or final-validation failure", async (t) => {
  for (const env of [{ FAIL_MV_AT: "2" }, { SHASUM_FAIL_AT: "2" }]) {
    const fixture = await packageFixture(t);
    const result = fixture.run(env);
    assertFinished(result);
    assert.notEqual(result.status, 0);
    await assertExactRecoveryLayout(fixture.dist, { allowEmpty: true });
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
    await assertExactRecoveryLayout(fixture.dist);
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
  await assertExactRecoveryLayout(fixture.dist);
});

async function verifierFixture(t, ini = "[App]\nName=Chatero\nID=zotero@zotero.org\n") {
  const dir = await mkdtemp(join(tmpdir(), "chatero-verifier-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = join(dir, "Chatero.app");
  const bin = join(dir, "bin");
  const entitlements = join(dir, "entitlements.plist");
  const preferences = join(dir, "zotero.js");
  const provenance = join(dir, "chatero-build.mjs");
  const starterManifest = join(dir, "qlab-starter-manifest.json");
  const starterArchive = join(dir, "research-loop-starter.zip");
  const sourceCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const upstreamBase = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(app, "Contents", "Resources", "app"), { recursive: true });
  await mkdir(join(app, "Contents", "Resources", "integration", "word-for-mac"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(app, "Contents", "Info.plist"), "fixture");
  await writeFile(join(app, "Contents", "Resources", "app", "application.ini"), ini);
  await writeExecutable(join(app, "Contents", "MacOS", "zotero"), "#!/bin/bash\n");
  await writeFile(join(app, "Contents", "Resources", "integration", "word-for-mac", "libZoteroWordIntegration.dylib"), "fixture");
  await writeFile(entitlements, "fixture");
  await writeFile(preferences, 'pref("app.update.enabled", false);\n');
  await writeFile(provenance, `export const CHATERO_BUILD = Object.freeze({\n  "sourceCommit": "${sourceCommit}",\n  "upstreamBase": "${upstreamBase}"\n});\n`);
  await writeFile(starterManifest, await readFile(join(starterRoot, "manifest.json")));
  await writeFile(starterArchive, await readFile(join(starterRoot, "research-loop-starter.zip")));
  await writeExecutable(join(bin, "PlistBuddy"), `#!/bin/bash
case "$2" in
  *CFBundleName*) printf '%s\\n' "\${TEST_BUNDLE_NAME:-Chatero}" ;;
  *CFBundleIdentifier*) printf '%s\\n' "\${TEST_BUNDLE_ID:-io.github.chancesiyuan.chatero}" ;;
  *CFBundleURLTypes*) printf '%s\\n' "\${TEST_SCHEME:-chatero}" ;;
  *CFBundleExecutable*) printf '%s\\n' "\${TEST_EXECUTABLE:-zotero}" ;;
  *automation.apple-events*) printf '%s\\n' "\${TEST_ENTITLEMENT:-true}" ;;
esac
`);
  await writeExecutable(join(bin, "plutil"), `#!/bin/bash
if [ -n "\${TEST_URL_TYPES_JSON:-}" ]; then
  printf '%s\n' "$TEST_URL_TYPES_JSON"
else
  printf '%s\n' '[{"CFBundleURLSchemes":["chatero"]}]'
fi
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
      CHATER0_VERIFY_TEST_PLUTIL: join(bin, "plutil"),
      CHATER0_VERIFY_TEST_CODESIGN: join(bin, "codesign"),
      CHATER0_VERIFY_TEST_DEFAULT_PREFS: preferences,
      CHATER0_VERIFY_TEST_BUILD_PROVENANCE: provenance,
      CHATER0_VERIFY_TEST_SOURCE_COMMIT: sourceCommit,
      CHATER0_VERIFY_TEST_UPSTREAM_BASE: upstreamBase,
      CHATER0_VERIFY_TEST_STARTER_MANIFEST: starterManifest,
      CHATER0_VERIFY_TEST_STARTER_ARCHIVE: starterArchive,
      TEST_ENTITLEMENTS: entitlements,
      ...extra,
    },
  });
  return { provenance, preferences, run, sourceCommit, starterArchive, starterManifest, upstreamBase };
}

test("bundle verifier accepts a complete isolated fixture", async (t) => {
  const fixture = await verifierFixture(t);
  const result = fixture.run();
  assertFinished(result);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("bundle verifier requires a complete starter payload and rejects an archive whose digest changes", async (t) => {
  const fixture = await verifierFixture(t);
  await writeFile(fixture.starterArchive, "tampered starter archive");
  let result = fixture.run();
  assertFinished(result);
  assert.notEqual(result.status, 0, "tampered public starter archive unexpectedly verified");

  const missingManifest = join(dirname(fixture.starterManifest), "missing-manifest.json");
  result = fixture.run({ CHATER0_VERIFY_TEST_STARTER_MANIFEST: missingManifest });
  assertFinished(result);
  assert.notEqual(result.status, 0, "missing public starter manifest unexpectedly verified");
});

test("bundle verifier rejects a starter manifest whose canonical digest is stale", async (t) => {
  const fixture = await verifierFixture(t);
  const manifest = JSON.parse(await readFile(fixture.starterManifest, "utf8"));
  manifest.digest = "0".repeat(64);
  await writeFile(fixture.starterManifest, `${JSON.stringify(manifest)}\n`);
  const result = fixture.run();
  assertFinished(result);
  assert.notEqual(result.status, 0, "stale public starter manifest unexpectedly verified");
});

test("bundle verifier rejects non-ad-hoc metadata, active UpdateURL, wrong executable, and missing Word entitlement", async (t) => {
  for (const [ini, env] of [
    [undefined, { TEST_SIGNATURE: "Developer ID Application" }],
    [undefined, { TEST_TEAM: "ABC123" }],
    ["[App]\nName=Chatero\nID=zotero@zotero.org\nUpdateURL=https://updates.example/\n", {}],
    [undefined, { TEST_EXECUTABLE: "other" }],
    [undefined, { TEST_ENTITLEMENT: "false" }],
  ]) {
    const fixture = await verifierFixture(t, ini);
    const result = fixture.run(env);
    assertFinished(result);
    assert.notEqual(result.status, 0);
  }
});

test("package script refuses dirty trees including untracked source before provenance", async () => {
  const source = await readFile(packageScript, "utf8");
  assert.match(source, /git status --porcelain --untracked-files=all/);
  assert.doesNotMatch(source, /--untracked-files=no/);
  assert.match(source, /generate-product\.mjs --build-provenance --require-clean-tree/);
  assert.match(
    source,
    /Refusing to package a bundle from a dirty tree \(tracked changes or untracked source would not match provenance\)/
  );
});

test("bundle verifier parses update sections and enforces packaged preferences, schemes, and provenance", async (t) => {
  const controls = [
    {
      name: "active AppUpdate URL",
      ini: "[App]\nName=Chatero\nID=zotero@zotero.org\n[AppUpdate]\nURL=https://updates.example/\n"
    },
    { name: "extra public URL scheme", env: { TEST_URL_TYPES_JSON: '[{"CFBundleURLSchemes":["chatero","zotero"]}]' } },
    { name: "missing public URL scheme", env: { TEST_URL_TYPES_JSON: '[{"CFBundleURLSchemes":["zotero"]}]' } },
    { name: "enabled packaged updater", preferences: 'pref("app.update.enabled", true);\n' },
    { name: "missing packaged updater preference", preferences: 'pref("extensions.zotero.test", true);\n' },
    {
      name: "wrong source commit provenance",
      provenance: 'export const CHATERO_BUILD = Object.freeze({"sourceCommit":"cccccccccccccccccccccccccccccccccccccccc","upstreamBase":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"});\n'
    },
    {
      name: "wrong upstream base provenance",
      provenance: 'export const CHATERO_BUILD = Object.freeze({"sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","upstreamBase":"cccccccccccccccccccccccccccccccccccccccc"});\n'
    }
  ];

  for (const control of controls) {
    await t.test(control.name, async () => {
      const fixture = await verifierFixture(t, control.ini);
      if (control.preferences) await writeFile(fixture.preferences, control.preferences);
      if (control.provenance) await writeFile(fixture.provenance, control.provenance);
      const result = fixture.run(control.env);
      assertFinished(result);
      assert.notEqual(result.status, 0, `${control.name} unexpectedly verified`);
    });
  }
});
