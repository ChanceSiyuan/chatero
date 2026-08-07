import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.match(codesign, /\/usr\/bin\/codesign --force --deep --sign - "\$APPDIR"/);
  assert.match(codesign, /\/usr\/bin\/codesign --verify --deep --strict --verbose=2 "\$APPDIR"/);
});
