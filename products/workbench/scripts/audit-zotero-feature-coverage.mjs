#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const execFile = promisify(execFileCallback);

export function extractOfficialZoteroActions(source) {
  if (typeof source !== "string") throw new TypeError("official Zotero UI source must be text");
  const actions = [];
  for (const match of source.matchAll(/<(command|menuitem|toolbarbutton)\b[^>]*(?:oncommand|command)=["'][^"']+["'][^>]*>/gu)) {
    const id = /\bid=["']([^"']+)["']/u.exec(match[0])?.[1];
    if (id) actions.push(id);
  }
  return Object.freeze([...new Set(actions)].sort());
}

export async function auditZoteroFeatureCoverage({ root = ROOT } = {}) {
  const componentPaths = Object.freeze({
    connector: "chrome/content/zotero/xpcom/server/server_connector.js",
    plugins: "chrome/content/zotero/xpcom/plugins.js",
    sync: "chrome/content/zotero/xpcom/sync.js",
    translators: "chrome/content/zotero/xpcom/translation/translators.js",
    wordProcessor: "resource/word-processor-plugin-installer.mjs",
  });
  const integrationPaths = Object.freeze({
    wordMac: "app/modules/zotero-word-for-mac-integration",
    wordWindows: "app/modules/zotero-word-for-windows-integration",
    libreOffice: "app/modules/zotero-libreoffice-integration",
  });
  const [officialUi, manifestText, extensionSource, launcherSource, ordinaryContents, gitlinks] = await Promise.all([
    readFile(join(root, "chrome", "content", "zotero", "zoteroPane.xhtml"), "utf8"),
    readFile(join(root, "products", "workbench", "extensions", "chatero-zotero", "package.json"), "utf8"),
    readFile(join(root, "products", "workbench", "extensions", "chatero-zotero", "extension.cjs"), "utf8"),
    readFile(join(root, "products", "workbench", "extensions", "chatero-zotero", "zotero-compatibility-launcher.mjs"), "utf8"),
    Promise.all(Object.values(componentPaths).map(path => readFile(join(root, path)))),
    execFile("git", ["ls-files", "--stage", "--", ...Object.values(integrationPaths)], { cwd: root, encoding: "utf8" }),
  ]);
  const actions = extractOfficialZoteroActions(officialUi);
  if (actions.length < 140) throw new Error("official Zotero action inventory is unexpectedly small");
  const manifest = JSON.parse(manifestText);
  const compatibilityCommand = manifest.contributes.commands.find(value => value.command === "chatero.zotero.openCompleteZotero");
  if (!compatibilityCommand || !extensionSource.includes("buildZoteroCompatibilityLaunchPlan")
      || !extensionSource.includes("await lifecycle.stopCore()")) {
    throw new Error("complete Zotero compatibility mode is not wired through an exclusive Core transition");
  }
  if (!launcherSource.includes("acquireLease") || !launcherSource.includes("await lease.release()")) {
    throw new Error("complete Zotero compatibility mode does not own a profile lease for its full lifetime");
  }
  const gitlinkRecords = new Map(gitlinks.stdout.trim().split("\n").filter(Boolean).map(line => {
    const match = /^(160000) ([0-9a-f]{40}) 0\t(.+)$/u.exec(line);
    if (!match) throw new Error("official Zotero integration gitlink inventory is invalid");
    return [match[3], match[2]];
  }));
  const integrationGitlinks = Object.freeze(Object.fromEntries(Object.entries(integrationPaths).map(([name, path]) => {
    const commit = gitlinkRecords.get(path);
    if (!commit) throw new Error(`official Zotero integration gitlink is missing: ${name}`);
    return [name, commit];
  })));
  const componentContents = [...ordinaryContents, ...Object.values(integrationGitlinks).map(value => Buffer.from(value))];
  if (componentContents.some(value => value.length === 0)) {
    throw new Error("official Zotero compatibility component inventory contains an empty artifact");
  }
  const components = Object.freeze([...Object.keys(componentPaths), ...Object.keys(integrationPaths)]);
  const componentHasher = createHash("sha256");
  componentContents.forEach((value, index) => componentHasher.update(components[index]).update("\0").update(value));
  return Object.freeze({
    compatibilityCommand: compatibilityCommand.command,
    compatibilityComponents: components,
    compatibilityComponentsSha256: componentHasher.digest("hex"),
    integrationGitlinks,
    officialActionCount: actions.length,
    officialActionInventorySha256: createHash("sha256").update(actions.join("\n")).digest("hex"),
    profileMode: "private-exclusive",
    upstreamUiSha256: createHash("sha256").update(officialUi).digest("hex"),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.stdout.write(`${JSON.stringify(await auditZoteroFeatureCoverage(), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
