import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

test("Chatero identity is isolated while Zotero compatibility IDs remain stable", async () => {
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

  const applicationINI = await read("app/assets/application.ini");
  assert.match(applicationINI, /Name=Chatero/);
  assert.match(applicationINI, /ID=zotero@zotero\.org/);
  assert.doesNotMatch(applicationINI, /download\/client\/update/);

  const plist = await read("app/mac/Contents/Info.plist");
  assert.match(plist, /<string>io\.github\.chancesiyuan\.chatero<\/string>/);
  assert.match(plist, /<string>Chatero<\/string>/);
  assert.match(plist, /<string>chatero<\/string>/);
  assert.doesNotMatch(plist, /<string>zotero<\/string>\s*<\/array>\s*<\/dict>\s*<\/array>/);

  const runtimeConfig = await read("resource/config.mjs");
  assert.match(runtimeConfig, /GUID: 'zotero@zotero\.org'/);
  assert.match(runtimeConfig, /ID: 'zotero'/);
  assert.match(runtimeConfig, /CLIENT_NAME: 'Chatero'/);
  assert.match(runtimeConfig, /PREF_BRANCH: 'extensions\.zotero\.'/);
  assert.match(runtimeConfig, /EXTERNAL_URL_SCHEME: 'chatero'/);
  assert.match(runtimeConfig, /HTTP_SERVER_FALLBACK_PORTS: \[23129\]/);
});
