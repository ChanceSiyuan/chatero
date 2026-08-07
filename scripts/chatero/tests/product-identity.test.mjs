import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";

const read = (path) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
const execFile = promisify(execFileCallback);

const parseINI = (text) => {
  const result = {};
  let section;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";")) continue;
    const match = trimmed.match(/^\[([^\]]+)\]$/);
    if (match) {
      section = match[1];
      result[section] = {};
      continue;
    }
    const separator = trimmed.indexOf("=");
    assert.ok(section && separator > 0, `invalid INI line: ${line}`);
    result[section][trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }

  return result;
};

const parseShellAssignments = (text) => Object.fromEntries(
  [...text.matchAll(/^([A-Z_]+)="([^"]*)"$|^([A-Z_]+)=([^\s#]+)$/gm)].map((match) => [
    match[1] ?? match[3],
    match[2] ?? match[4]
  ])
);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const entryValue = (text, key, separator = "=") => {
  const match = text.match(new RegExp(`^${escapeRegExp(key)}\\s*${escapeRegExp(separator)}\\s*(.+)$`, "m"));
  assert.ok(match, `missing ${key}`);
  return match[1];
};

const parsePlist = (text) => {
  const tokens = text
    .replace(/<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!--[\s\S]*?-->/g, "")
    .match(/<[^>]+>|[^<]+/g)
    ?.map((token) => token.trim())
    .filter(Boolean) ?? [];
  let index = 0;

  const next = () => tokens[index++];
  const value = () => {
    const tag = next();
    if (tag === "<dict>") {
      const dict = {};
      while (tokens[index] !== "</dict>") {
        assert.equal(next(), "<key>");
        const key = next();
        assert.equal(next(), "</key>");
        dict[key] = value();
      }
      next();
      return dict;
    }
    if (tag === "<array>") {
      const array = [];
      while (tokens[index] !== "</array>") array.push(value());
      next();
      return array;
    }
    if (tag === "<string>") {
      const string = tokens[index] === "</string>" ? "" : next();
      assert.equal(next(), "</string>");
      return string;
    }
    if (tag === "<true/>") return true;
    if (tag === "<false/>") return false;
    throw new Error(`unsupported plist value ${tag}`);
  };

  assert.match(next(), /^<plist\b/);
  const plist = value();
  assert.equal(next(), "</plist>");
  assert.equal(index, tokens.length);
  return plist;
};

const readPreferences = (text) => {
  const preferences = new Map();
  runInNewContext(text, { pref: (name, value) => preferences.set(name, value) });
  return preferences;
};

test("Chatero identity is isolated while Zotero compatibility IDs remain stable", async () => {
  // This catches any accidental divergence between the product manifest and a consuming surface.
  const product = JSON.parse(await read("app/chatero-product.json"));
  assert.deepEqual(product, {
    displayName: "Chatero",
    bundleID: "io.github.chancesiyuan.chatero",
    applicationID: "zotero@zotero.org",
    internalID: "zotero",
    preferenceBranch: "extensions.zotero.",
    externalURLScheme: "chatero",
    profileRootName: "Chatero",
    dataDirectoryName: "Data",
    connectorPort: 23119,
    fallbackPorts: [23129],
    automaticUpdates: false
  });

  const { stdout: shellConfigOutput } = await execFile("bash", [
    "-c",
    'DIR="$1"; . "$DIR/config-custom.sh"; printf "%s\\n" "$APP_NAME" "$APP_ID" "$APP_BUNDLE_ID" "$APP_URL_SCHEME" "$SIGN"',
    "bash",
    fileURLToPath(new URL("../../../app/", import.meta.url))
  ]);
  const shellConfig = Object.fromEntries([
    "APP_NAME",
    "APP_ID",
    "APP_BUNDLE_ID",
    "APP_URL_SCHEME",
    "SIGN"
  ].map((key, index) => [key, shellConfigOutput.trim().split("\n")[index]]));
  assert.deepEqual(
    Object.fromEntries(["APP_NAME", "APP_ID", "APP_BUNDLE_ID", "APP_URL_SCHEME", "SIGN"].map((key) => [key, shellConfig[key]])),
    {
      APP_NAME: product.displayName,
      APP_ID: product.applicationID,
      APP_BUNDLE_ID: product.bundleID,
      APP_URL_SCHEME: product.externalURLScheme,
      SIGN: "0"
    }
  );

  const applicationINI = parseINI(await read("app/assets/application.ini"));
  assert.deepEqual(
    Object.fromEntries(["Vendor", "Name", "ID"].map((key) => [key, applicationINI.App[key]])),
    {
      Vendor: product.displayName,
      Name: product.displayName,
      ID: product.applicationID
    }
  );
  assert.equal(applicationINI.AppUpdate, undefined);

  const plist = parsePlist(await read("app/mac/Contents/Info.plist"));
  assert.equal(plist.CFBundleIdentifier, product.bundleID);
  assert.equal(plist.CFBundleName, product.displayName);
  assert.equal(plist.CFBundleGetInfoString, `${product.displayName} {{VERSION}}, © 2006-2018 Contributors`);
  assert.equal(plist.CFBundleExecutable, product.internalID);
  const registeredSchemes = plist.CFBundleURLTypes.flatMap(({ CFBundleURLSchemes }) => CFBundleURLSchemes);
  assert.deepEqual(registeredSchemes, [product.externalURLScheme]);
  assert.ok(!registeredSchemes.includes(product.internalID));

  const { ZOTERO_CONFIG: runtimeConfig } = await import(new URL("../../../resource/config.mjs", import.meta.url));
  assert.deepEqual(
    Object.fromEntries([
      "GUID",
      "ID",
      "CLIENT_NAME",
      "EXTERNAL_URL_SCHEME",
      "DATA_DIRECTORY_WITHIN_PROFILE_ROOT",
      "DATA_DIRECTORY_NAME",
      "HTTP_SERVER_FALLBACK_PORTS",
      "PREF_BRANCH"
    ].map((key) => [key, runtimeConfig[key]])),
    {
      GUID: product.applicationID,
      ID: product.internalID,
      CLIENT_NAME: product.displayName,
      EXTERNAL_URL_SCHEME: product.externalURLScheme,
      DATA_DIRECTORY_WITHIN_PROFILE_ROOT: true,
      DATA_DIRECTORY_NAME: product.dataDirectoryName,
      HTTP_SERVER_FALLBACK_PORTS: product.fallbackPorts,
      PREF_BRANCH: product.preferenceBranch
    }
  );
  assert.deepEqual(
    Object.fromEntries([
      "DOMAIN_NAME",
      "REPOSITORY_URL",
      "BASE_URI",
      "WWW_BASE_URL",
      "API_URL",
      "STREAMING_URL",
      "SERVICES_URL"
    ].map((key) => [key, runtimeConfig[key]])),
    {
      DOMAIN_NAME: "zotero.org",
      REPOSITORY_URL: "https://repo.zotero.org/repo/",
      BASE_URI: "http://zotero.org/",
      WWW_BASE_URL: "https://www.zotero.org/",
      API_URL: "https://api.zotero.org/",
      STREAMING_URL: "wss://stream.zotero.org/",
      SERVICES_URL: "https://services.zotero.org/"
    }
  );

  const preferences = readPreferences(await read("defaults/preferences/zotero.js"));
  assert.equal(preferences.get("app.update.enabled"), product.automaticUpdates);
  assert.equal(preferences.get(`${product.preferenceBranch}httpServer.port`), product.connectorPort);

  const fluentBranding = await read("app/assets/branding/locale/brand.ftl");
  for (const key of ["-brand-shorter-name", "-brand-short-name", "-brand-full-name", "-brand-product-name", "-vendor-short-name", "-app-name"]) {
    assert.equal(entryValue(fluentBranding, key), product.displayName);
  }
  assert.equal(entryValue(fluentBranding, "-subscription-name"), `${product.displayName} Storage`);
  assert.equal(entryValue(fluentBranding, "trademarkInfo"), "Zotero is a trademark of the Corporation for Digital Scholarship.");

  const propertiesBranding = await read("app/assets/branding/locale/brand.properties");
  for (const key of ["brandShorterName", "brandShortName", "brandFullName"]) {
    assert.equal(entryValue(propertiesBranding, key), product.displayName);
  }
  const dtdBranding = await read("app/assets/branding/locale/brand.dtd");
  assert.equal(dtdBranding.match(/<!ENTITY\s+brandShortName\s+"([^"]+)">/)?.[1], product.displayName);

  const updaterINI = parseINI(await read("app/assets/updater.ini"));
  assert.equal(updaterINI.Strings.Title, `${product.displayName} Update`);
  assert.equal(updaterINI.Strings.Info, `${product.displayName} is installing your updates and will start in a few moments…`);
});

test("the manifest deterministically supplies generated build and runtime identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chatero-product-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const product = {
    ...JSON.parse(await read("app/chatero-product.json")),
    displayName: "Chatero Test",
    bundleID: "io.github.chancesiyuan.chatero.test",
    externalURLScheme: "chatero-test",
    dataDirectoryName: "Test Data",
    fallbackPorts: [24129]
  };
  await mkdir(join(root, "app"), { recursive: true });
  await mkdir(join(root, "resource"), { recursive: true });
  await mkdir(join(root, "scripts", "chatero"), { recursive: true });
  await writeFile(join(root, "app", "chatero-product.json"), `${JSON.stringify(product, null, 2)}\n`);
  await writeFile(join(root, "app", "config-custom.sh"), await read("app/config-custom.sh"));
  await writeFile(join(root, "resource", "config.mjs"), await read("resource/config.mjs"));
  await writeFile(join(root, "scripts", "chatero", "generate-product.mjs"), await read("scripts/chatero/generate-product.mjs"));

  const { generateProduct } = await import(new URL("../generate-product.mjs", import.meta.url));
  await generateProduct({ root });

  const generatedRuntimePath = join(root, "resource", "chatero-product.mjs");
  const generatedRuntime = await import(`${pathToFileURL(generatedRuntimePath).href}?generated`);
  assert.deepEqual(generatedRuntime.CHATERO_PRODUCT, product);

  const generatedShell = parseShellAssignments(await readFile(join(root, "app", "chatero-product.sh"), "utf8"));
  assert.deepEqual(
    Object.fromEntries(["APP_NAME", "APP_ID", "APP_BUNDLE_ID", "APP_URL_SCHEME", "SIGN"].map((key) => [key, generatedShell[key]])),
    {
      APP_NAME: product.displayName,
      APP_ID: product.applicationID,
      APP_BUNDLE_ID: product.bundleID,
      APP_URL_SCHEME: product.externalURLScheme,
      SIGN: "0"
    }
  );

  const { stdout } = await execFile("bash", [
    "-c",
    'DIR="$1/app"; . "$DIR/config-custom.sh"; printf "%s\\n" "$APP_NAME" "$APP_ID" "$APP_BUNDLE_ID" "$APP_URL_SCHEME" "$SIGN"',
    "bash",
    root
  ]);
  assert.deepEqual(stdout.trim().split("\n"), [
    product.displayName,
    product.applicationID,
    product.bundleID,
    product.externalURLScheme,
    "0"
  ]);

  const { ZOTERO_CONFIG: generatedRuntimeConfig } = await import(`${pathToFileURL(join(root, "resource", "config.mjs")).href}?runtime`);
  assert.deepEqual(
    Object.fromEntries(["GUID", "ID", "CLIENT_NAME", "EXTERNAL_URL_SCHEME", "DATA_DIRECTORY_WITHIN_PROFILE_ROOT", "DATA_DIRECTORY_NAME", "HTTP_SERVER_FALLBACK_PORTS"].map((key) => [key, generatedRuntimeConfig[key]])),
    {
      GUID: product.applicationID,
      ID: product.internalID,
      CLIENT_NAME: product.displayName,
      EXTERNAL_URL_SCHEME: product.externalURLScheme,
      DATA_DIRECTORY_WITHIN_PROFILE_ROOT: Boolean(product.profileRootName),
      DATA_DIRECTORY_NAME: product.dataDirectoryName,
      HTTP_SERVER_FALLBACK_PORTS: product.fallbackPorts
    }
  );

  const originalRuntimeArtifact = await readFile(generatedRuntimePath, "utf8");
  await generateProduct({ root, check: true });
  await writeFile(generatedRuntimePath, "// stale\n");
  await assert.rejects(generateProduct({ root, check: true }), /stale generated artifact/);
  await generateProduct({ root });
  assert.equal(await readFile(generatedRuntimePath, "utf8"), originalRuntimeArtifact);

  const packageJSON = JSON.parse(await read("package.json"));
  assert.match(packageJSON.scripts.build, /scripts\/chatero\/generate-product\.mjs/);
});

test("shell config regenerates manifest identity before consuming it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chatero-shell-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const product = {
    ...JSON.parse(await read("app/chatero-product.json")),
    displayName: "Chatero Shell Test",
    bundleID: "io.github.chancesiyuan.chatero.shell-test",
    externalURLScheme: "chatero-shell-test"
  };
  await mkdir(join(root, "app"), { recursive: true });
  await mkdir(join(root, "resource"), { recursive: true });
  await mkdir(join(root, "scripts", "chatero"), { recursive: true });
  await writeFile(join(root, "app", "chatero-product.json"), `${JSON.stringify(product, null, 2)}\n`);
  await writeFile(join(root, "app", "config.sh"), await read("app/config.sh"));
  await writeFile(join(root, "app", "config-custom.sh"), await read("app/config-custom.sh"));
  await writeFile(join(root, "resource", "config.mjs"), await read("resource/config.mjs"));
  await writeFile(join(root, "scripts", "chatero", "generate-product.mjs"), await read("scripts/chatero/generate-product.mjs"));
  await writeFile(join(root, "app", "chatero-product.sh"), 'APP_NAME="Stale"\nAPP_ID="stale"\nAPP_BUNDLE_ID="stale"\nAPP_URL_SCHEME="stale"\nSIGN=0\n');
  await writeFile(join(root, "resource", "chatero-product.mjs"), 'export const CHATERO_PRODUCT = Object.freeze({ displayName: "Stale" });\n');

  const { stdout } = await execFile("bash", [
    "-c",
    '. "$1/app/config.sh"; printf "%s\\n" "$APP_NAME" "$APP_BUNDLE_ID" "$APP_URL_SCHEME"',
    "bash",
    root
  ]);
  assert.deepEqual(stdout.trim().split("\n"), [product.displayName, product.bundleID, product.externalURLScheme]);
  const regeneratedShell = parseShellAssignments(await readFile(join(root, "app", "chatero-product.sh"), "utf8"));
  assert.deepEqual(
    Object.fromEntries(["APP_NAME", "APP_BUNDLE_ID", "APP_URL_SCHEME"].map((key) => [key, regeneratedShell[key]])),
    {
      APP_NAME: product.displayName,
      APP_BUNDLE_ID: product.bundleID,
      APP_URL_SCHEME: product.externalURLScheme
    }
  );
  const regeneratedRuntime = await import(`${pathToFileURL(join(root, "resource", "chatero-product.mjs")).href}?shell-config`);
  assert.deepEqual(regeneratedRuntime.CHATERO_PRODUCT, product);
});

test("application hash invalidates manifest-derived packaging inputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chatero-app-hash-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const appDir = join(root, "app");
  await Promise.all([
    ...["assets", "scripts", "mac", "win", "linux", "modules", "update-packaging"].map((path) => mkdir(join(appDir, path), { recursive: true })),
    mkdir(join(root, "resource"), { recursive: true }),
    mkdir(join(root, "scripts", "chatero"), { recursive: true })
  ]);
  await writeFile(join(appDir, "scripts", "utils.sh"), await read("app/scripts/utils.sh"));
  for (const path of ["build.sh", "config.sh", "config-custom.sh", "chatero-product.json", "chatero-product.sh"]) {
    await writeFile(join(appDir, path), `${path}\n`);
  }
  await writeFile(join(root, "resource", "chatero-product.mjs"), "runtime\n");
  await writeFile(join(root, "scripts", "chatero", "generate-product.mjs"), "generator\n");

  const applicationHash = async () => (await execFile("bash", [
    "-c",
    '. "$1/app/scripts/utils.sh"; generate_app_hash "$1/app"',
    "bash",
    root
  ])).stdout.trim();
  let previousHash = await applicationHash();
  for (const path of [
    join(appDir, "chatero-product.json"),
    join(appDir, "chatero-product.sh"),
    join(root, "resource", "chatero-product.mjs"),
    join(root, "scripts", "chatero", "generate-product.mjs")
  ]) {
    await writeFile(path, `${await readFile(path, "utf8")}changed\n`);
    const nextHash = await applicationHash();
    assert.notEqual(nextHash, previousHash, `${path} must invalidate the application hash`);
    previousHash = nextHash;
  }
});
