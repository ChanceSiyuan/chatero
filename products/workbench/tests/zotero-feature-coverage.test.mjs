import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  auditZoteroFeatureCoverage,
  extractOfficialZoteroActions,
} from "../scripts/audit-zotero-feature-coverage.mjs";

const root = resolve(import.meta.dirname, "..", "..", "..");

test("official Zotero UI inventory stays executable through complete compatibility mode", async () => {
  const source = await readFile(new URL("../../../chrome/content/zotero/zoteroPane.xhtml", import.meta.url), "utf8");
  const actions = extractOfficialZoteroActions(source);
  for (const required of [
    "cmd_zotero_addByIdentifier",
    "cmd_zotero_createTimeline",
    "cmd_zotero_exportLibrary",
    "cmd_zotero_import",
    "cmd_zotero_rtfScan",
    "menu_addons",
    "menu_EditPreferencesItem",
  ]) assert.ok(actions.includes(required), `official Zotero action inventory omitted ${required}`);
  const report = await auditZoteroFeatureCoverage({ root });
  assert.ok(report.officialActionCount >= 140);
  assert.equal(report.compatibilityCommand, "chatero.zotero.openCompleteZotero");
  assert.deepEqual(report.compatibilityComponents, [
    "connector", "plugins", "sync", "translators", "wordProcessor",
    "wordMac", "wordWindows", "libreOffice",
  ]);
  assert.deepEqual(Object.keys(report.integrationGitlinks), [
    "wordMac", "wordWindows", "libreOffice",
  ]);
  for (const commit of Object.values(report.integrationGitlinks)) {
    assert.match(commit, /^[0-9a-f]{40}$/u);
  }
  assert.match(report.compatibilityComponentsSha256, /^[0-9a-f]{64}$/u);
  assert.equal(report.profileMode, "private-exclusive");
  assert.match(report.officialActionInventorySha256, /^[0-9a-f]{64}$/u);
  assert.match(report.upstreamUiSha256, /^[0-9a-f]{64}$/u);
});
