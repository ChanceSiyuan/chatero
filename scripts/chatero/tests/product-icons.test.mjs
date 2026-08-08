import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../../${path}`, import.meta.url));

test("macOS bundle uses the pinned Chatero icon instead of Assets.car AppIcon", async () => {
	let plist = String(await read("app/mac/Contents/Info.plist"));
	assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>AppIcon\.icns<\/string>/);
	assert.doesNotMatch(plist, /<key>CFBundleIconName<\/key>/);
	
	let master = await read("app/assets/icons/chatero-app-icon.png");
	assert.equal(
		createHash("sha256").update(master).digest("hex"),
		"64be6071c6ddf915ad91c6a7e852c04a081a29f6a0c151719cfaebf56fad97af",
	);
	let icns = await read("app/mac/Contents/Resources/AppIcon.icns");
	assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
	assert.equal(
		createHash("sha256").update(icns).digest("hex"),
		"6fdbd07b778458316a8b92853604593258996ec0ddfff1cfe1ccef1275f194da",
	);
});

test("in-app and Linux brand marks identify Chatero", async () => {
	for (let path of [
		"chrome/skin/default/zotero/z.svg",
		"chrome/skin/default/zotero/zotero.svg",
		"app/linux/icons/symbolic.svg",
	]) {
		let source = String(await read(path));
		assert.match(source, /<title>Chatero<\/title>/, path);
		assert.doesNotMatch(source, /<title>Zotero<\/title>/, path);
	}
	let about = String(await read("chrome/content/zotero/about.xhtml"));
	assert.match(about, /alt="Chatero"/);
});

test("both DMG packagers apply the Chatero volume icon", async () => {
	for (let path of [
		"app/build.sh",
		"app/scripts/package_chatero_dmg",
	]) {
		let source = String(await read(path));
		assert.match(source, /--icon .*AppIcon\.icns/, path);
	}
	let packager = String(await read("app/mac/pkg-dmg"));
	assert.match(packager, /'cmd_SetFile'\s*=>\s*'\/usr\/bin\/SetFile'/);
	assert.doesNotMatch(packager, /'cmd_SetFile'\s*=>\s*'\/Developer\/Tools\/SetFile'/);
});
