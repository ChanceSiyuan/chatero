import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const read = (path) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

test("macOS staging, launch, test, and archive paths use APP_NAME", async () => {
  const build = await read("app/build.sh");
  const dirBuild = await read("app/scripts/dir_build");
  const incrementalUpdate = await read("app/scripts/incremental_update");
  const addOmniFile = await read("app/scripts/add_omni_file");
  const run = await read("app/scripts/build_and_run");
  const runTests = await read("test/runtests.sh");

  assert.match(build, /echo "Building \$APP_NAME\.app"/);
  assert.match(build, /APPDIR="\$STAGE_DIR\/\$APP_NAME\.app"/);
  assert.match(build, /dmg="\$DIST_DIR\/\$APP_NAME-\$VERSION\.dmg"/);
  assert.match(build, /--source "\$STAGE_DIR\/\$APP_NAME\.app"/);
  assert.match(build, /"\$DIST_DIR\/\$APP_NAME-\$\{VERSION\}_mac\.zip"/);
  assert.match(dirBuild, /"\$STAGE_DIR\/\$APP_NAME\.app"/);
  assert.match(incrementalUpdate, /app_dir="\$STAGE_DIR\/\$APP_NAME\.app\/Contents\/Resources"/);
  assert.match(addOmniFile, /mac_path="\$STAGE_DIR\/\$APP_NAME\.app\/Contents\/Resources"/);
  assert.match(run, /\. "\$APP_ROOT_DIR\/config\.sh"/);
  assert.match(run, /command="\$APP_NAME\.app\/Contents\/MacOS\/zotero"/);
  assert.match(runTests, /\. "\$ROOT_DIR\/app\/config\.sh"/);
  assert.match(runTests, /Z_EXECUTABLE="\$ROOT_DIR\/app\/staging\/\$APP_NAME\.app\/Contents\/MacOS\/zotero"/);

  assert.doesNotMatch(build, /STAGE_DIR\/Zotero\.app/);
  assert.doesNotMatch(dirBuild, /STAGE_DIR\/Zotero\.app/);
  assert.doesNotMatch(incrementalUpdate, /STAGE_DIR\/Zotero\.app/);
  assert.doesNotMatch(addOmniFile, /STAGE_DIR\/Zotero\.app/);
  assert.doesNotMatch(runTests, /staging\/Zotero\.app/);
});

test("macOS bundle diagnostics preserve a non-Zotero identifier", async () => {
  const build = await read("app/build.sh");

  assert.match(build, /bundle_identifier="\$\{APP_BUNDLE_ID:-org\.zotero\.zotero\}"/);
  assert.match(build, /<key>CFBundleIdentifier<\\\/key>\\s\*<string>/);
  assert.doesNotMatch(build, /PlistBuddy -c "Print :CFBundleIdentifier"/);
  assert.doesNotMatch(build, /grep -B 1 org\.zotero\.zotero/);
  assert.doesNotMatch(build, /s\/org\\\.zotero\\\.zotero\/org\.zotero\.zotero-/);
});

test("local macOS builds are ad-hoc signed and deeply verified", async () => {
  const dirBuild = await read("app/scripts/dir_build");
  const codesign = await read("app/scripts/codesign_local");

  assert.match(
    dirBuild,
    /if \[ \$incr_status -ne 2 \]; then[\s\S]*?incr_status -eq 0[\s\S]*?codesign_local[\s\S]*?exit \$incr_status/,
  );
  assert.match(codesign, /\/usr\/bin\/xattr -cr "\$APPDIR"/);
  assert.doesNotMatch(codesign, /codesign --force --deep --sign/);
  assert.match(codesign, /com\.apple\.security\.automation\.apple-events/);
  assert.match(codesign, /PlistBuddy -c "Print :com\.apple\.security\.automation\.apple-events"/);
  assert.match(
    codesign,
    /if ! \/usr\/bin\/codesign --force --force-library-entitlements[\s\S]*then[\s\S]*codesign --force --options runtime --entitlements/,
  );
  assert.doesNotMatch(codesign, /codesign_help=/);
  assert.doesNotMatch(codesign, /library_entitlements_args/);
  assert.match(codesign, /cleanup_status=\$\?[\s\S]*exit \$cleanup_status/);
  assert.match(codesign, /bundle_executables=\("\$outer_executable"\)/);
  assert.match(codesign, /Print :CFBundleExecutable/);
  assert.match(codesign, /for bundle_executable in "\$\{bundle_executables\[@\]\}"/);
  assert.match(codesign, /find "\$APPDIR\/Contents" -depth/);
  assert.match(
    codesign,
    /\/usr\/bin\/codesign --force --entitlements "\$entitlements_file" --sign - "\$APPDIR"/,
  );
  assert.doesNotMatch(codesign, /--options runtime --sign - "\$code_path"/);
  assert.doesNotMatch(codesign, /--options runtime --sign - "\$bundle_path"/);
  assert.match(codesign, /\/usr\/bin\/codesign --verify --deep --strict --verbose=2 "\$APPDIR"/);

  const xattr = codesign.indexOf('/usr/bin/xattr -cr "$APPDIR"');
  const leaves = codesign.indexOf("while IFS= read -r -d '' code_path");
  const word = codesign.indexOf(
    '/usr/bin/codesign --force --force-library-entitlements --options runtime --entitlements "$entitlements_file" --sign - "$word_dylib"',
  );
  const bundles = codesign.indexOf('find "$APPDIR/Contents" -depth');
  const outer = codesign.indexOf(
    '/usr/bin/codesign --force --entitlements "$entitlements_file" --sign - "$APPDIR"',
  );
  const verify = codesign.indexOf('/usr/bin/codesign --verify --deep --strict --verbose=2 "$APPDIR"');
  assert.ok(xattr < leaves && leaves < word && word < bundles && bundles < outer && outer < verify);
});

test("add_omni_file re-signs once after all staged macOS mutations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chatero-add-omni-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const appRoot = join(root, "app");
  const scripts = join(appRoot, "scripts");
  const staging = join(appRoot, "staging");
  const build = join(root, "build");
  const macApp = join(staging, "Chatero.app");
  const macResources = join(macApp, "Contents", "Resources");
  const winResources = join(staging, "Zotero_win-x64");
  const signLog = join(root, "sign.log");

  await mkdir(scripts, { recursive: true });
  await mkdir(build, { recursive: true });
  await copyFile(new URL("../../../app/scripts/add_omni_file", import.meta.url), join(scripts, "add_omni_file"));
  await writeFile(join(appRoot, "config.sh"), 'APP_NAME="Chatero"\nSTAGE_DIR="$ROOT_DIR/staging"\n');
  await writeFile(
    join(scripts, "codesign_local"),
    `#!/bin/bash
set -euo pipefail
resources="$1/Contents/Resources"
unzip -Z1 "$resources/app/omni.ja" | grep -Fx first.txt >/dev/null
unzip -Z1 "$resources/app/omni.ja" | grep -Fx second.txt >/dev/null
unzip -Z1 "$WIN_RESOURCES/app/omni.ja" | grep -Fx first.txt >/dev/null
unzip -Z1 "$WIN_RESOURCES/app/omni.ja" | grep -Fx second.txt >/dev/null
grep -Eq '^BuildID=[0-9]{14}$' "$resources/app/application.ini"
printf '%s\\n' "$1" >> "$SIGN_LOG"
`,
  );
  await chmod(join(scripts, "codesign_local"), 0o755);

  for (const resources of [macResources, winResources]) {
    await mkdir(join(resources, "app"), { recursive: true });
    await writeFile(join(resources, "app", "application.ini"), "BuildID=old\n");
  }
  await writeFile(join(build, "seed.txt"), "seed\n");
  await writeFile(join(build, "first.txt"), "first\n");
  await writeFile(join(build, "second.txt"), "second\n");
  for (const resources of [macResources, winResources]) {
    const seeded = spawnSync("zip", ["-q", join(resources, "app", "omni.ja"), "seed.txt"], {
      cwd: build,
      encoding: "utf8",
    });
    assert.equal(seeded.status, 0, seeded.stderr);
  }

  const result = spawnSync("bash", [join(scripts, "add_omni_file"), "first.txt", "second.txt"], {
    cwd: build,
    encoding: "utf8",
    env: { ...process.env, SIGN_LOG: signLog, WIN_RESOURCES: winResources },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const signatures = await readFile(signLog, "utf8").catch(() => "");
  assert.deepEqual(signatures.trim().split("\n").filter(Boolean), [macApp]);
});

test("direct local Chatero packaging signs before DMG creation and skips notarization", async () => {
  const build = await read("app/build.sh");
  const packageStart = build.indexOf("# Build and notarize disk image");
  const localSign = build.indexOf('[[ $SIGN == 0 ]] && [[ "${APP_BUNDLE_ID:-}" == "io.github.chancesiyuan.chatero" ]]');
  const dmg = build.indexOf('"$CALLDIR/mac/pkg-dmg"');
  const signedNotarization = build.indexOf('[[ $SIGN == 1 ]] && [[ "$UPDATE_CHANNEL" != "test" ]]');

  assert.ok(packageStart < localSign && localSign < dmg && dmg < signedNotarization);
  assert.match(build, /"\$CALLDIR\/scripts\/codesign_local" "\$APPDIR"/);
  assert.match(build, /Local ad-hoc-signed build -- skipping notarization/);
});
