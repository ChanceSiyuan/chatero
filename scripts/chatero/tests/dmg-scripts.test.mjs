import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const file = (path) => fileURLToPath(new URL(path, root));

test("personal DMG packaging is local, rotates paired artifacts, and verifies before checksumming", async () => {
  await access(new URL("app/scripts/package_chatero_dmg", root));
  const script = await read("app/scripts/package_chatero_dmg");

  assert.match(script, /Chatero-\$\{VERSION\}\.dmg/);
  assert.match(script, /--volname "Chatero"/);
  assert.match(script, /"\$SCRIPT_DIR\/verify_chatero_bundle" "\$APP_BUNDLE"/);
  assert.match(script, /hdiutil verify "\$TEMP_DMG"/);
  assert.match(script, /shasum -a 256 "\$TEMP_DMG" \| \/usr\/bin\/awk -v dmg="\$DMG"/);
  assert.doesNotMatch(script, /notariz/i);

  const rotate = script.indexOf("rotate_existing_artifacts");
  const packageDmg = script.indexOf('"$APP_ROOT_DIR/mac/pkg-dmg"');
  const verify = script.indexOf('hdiutil verify "$TEMP_DMG"');
  const checksum = script.indexOf('shasum -a 256 "$TEMP_DMG"');
  const publishDmg = script.indexOf('mv "$TEMP_DMG" "$DMG"');
  const publishChecksum = script.indexOf('mv "$TEMP_CHECKSUM" "$CHECKSUM"');
  assert.ok(rotate >= 0 && rotate < packageDmg);
  assert.ok(packageDmg < verify && verify < checksum && checksum < publishDmg && publishDmg < publishChecksum);
});

test("bundle verifier checks Chatero identity, ad-hoc signature, and Word Apple Events entitlement", async () => {
  await access(new URL("app/scripts/verify_chatero_bundle", root));
  const script = await read("app/scripts/verify_chatero_bundle");

  assert.match(script, /io\.github\.chancesiyuan\.chatero/);
  assert.match(script, /CFBundleName/);
  assert.match(script, /codesign --verify --deep --strict/);
  assert.match(script, /libZoteroWordIntegration\.dylib/);
  assert.match(script, /com\.apple\.security\.automation\.apple-events/);
  assert.match(script, /Word integration Apple Events entitlement missing/);
});

test("bundle verifier accepts the staged Chatero app", () => {
  const result = spawnSync(file("app/scripts/verify_chatero_bundle"), [file("app/staging/Chatero.app")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("bundle verifier accepts the npm command's relative staged-app path", () => {
  const result = spawnSync(file("app/scripts/verify_chatero_bundle"), ["app/staging/Chatero.app"], {
    cwd: file(""),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
