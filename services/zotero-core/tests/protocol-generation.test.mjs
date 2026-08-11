import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");
const sourcePath = join(repositoryRoot, "services", "zotero-core", "protocol", "chatero-core.protocol.json");
const generatedJavaScript = join(repositoryRoot, "services", "zotero-core", "generated", "protocol.mjs");
const generatedDeclarations = join(repositoryRoot, "services", "zotero-core", "generated", "protocol.d.ts");
const generatedGeckoJavaScript = join(repositoryRoot, "chrome", "content", "zotero", "modules", "chateroCoreProtocol.mjs");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    force: true,
    recursive: true,
  })));
});

test("generates deterministic runtime constants and TypeScript declarations", async () => {
  const { generateProtocol } = await import("../scripts/generate-protocol.mjs");
  const directory = await mkdtemp(join(tmpdir(), "chatero-core-protocol-"));
  temporaryDirectories.push(directory);
  const javascriptPath = join(directory, "protocol.mjs");
  const geckoJavascriptPath = join(directory, "gecko-protocol.mjs");
  const declarationsPath = join(directory, "protocol.d.ts");

  const first = await generateProtocol({ sourcePath, javascriptPath, geckoJavascriptPath, declarationsPath });
  const firstJavaScript = await readFile(javascriptPath, "utf8");
  const firstGeckoJavaScript = await readFile(geckoJavascriptPath, "utf8");
  const firstDeclarations = await readFile(declarationsPath, "utf8");
  const second = await generateProtocol({ sourcePath, javascriptPath, geckoJavascriptPath, declarationsPath });

  assert.deepEqual(second, first);
  assert.equal(await readFile(javascriptPath, "utf8"), firstJavaScript);
  assert.equal(await readFile(geckoJavascriptPath, "utf8"), firstGeckoJavaScript);
  assert.equal(firstGeckoJavaScript, firstJavaScript);
  assert.equal(await readFile(declarationsPath, "utf8"), firstDeclarations);
  assert.match(firstJavaScript, /export const PROTOCOL_VERSION = "1\.0"/);
  assert.match(firstJavaScript, /"library\.search": "library:search"/);
  assert.match(firstJavaScript, /"library\.item-children": "library:read"/);
  assert.match(firstJavaScript, /"library\.attachment": "library:read"/);
  assert.match(firstJavaScript, /"library\.annotations": "library:read"/);
  assert.match(firstJavaScript, /"library\.note": "library:read"/);
  assert.match(firstDeclarations, /export interface LibrarySearchParams/);
  assert.match(firstDeclarations, /export interface LibraryAttachmentSummary/);
  assert.match(firstDeclarations, /export interface LibraryAttachmentParams/);
  assert.match(firstDeclarations, /export interface LibraryNoteSummary/);
  assert.match(firstDeclarations, /export interface LibraryAnnotationSummary/);
  assert.match(firstDeclarations, /export interface ProfileStatusResult/);
});

test("check mode verifies committed generated files without rewriting them", async () => {
  const { generateProtocol } = await import("../scripts/generate-protocol.mjs");
  const beforeJavaScript = await readFile(generatedJavaScript, "utf8");
  const beforeGeckoJavaScript = await readFile(generatedGeckoJavaScript, "utf8");
  const beforeDeclarations = await readFile(generatedDeclarations, "utf8");

  const report = await generateProtocol({
    sourcePath,
    javascriptPath: generatedJavaScript,
    geckoJavascriptPath: generatedGeckoJavaScript,
    declarationsPath: generatedDeclarations,
    check: true,
  });

  assert.equal(report.checked, true);
  assert.equal(await readFile(generatedJavaScript, "utf8"), beforeJavaScript);
  assert.equal(await readFile(generatedGeckoJavaScript, "utf8"), beforeGeckoJavaScript);
  assert.equal(await readFile(generatedDeclarations, "utf8"), beforeDeclarations);
});

test("rejects duplicate methods, unknown fields, and unsafe limits before writing", async () => {
  const { generateProtocol } = await import("../scripts/generate-protocol.mjs");
  const directory = await mkdtemp(join(tmpdir(), "chatero-core-protocol-invalid-"));
  temporaryDirectories.push(directory);
  const invalidSource = join(directory, "protocol.json");
  const javascriptPath = join(directory, "protocol.mjs");
  const geckoJavascriptPath = join(directory, "gecko-protocol.mjs");
  const declarationsPath = join(directory, "protocol.d.ts");
  await writeFile(invalidSource, JSON.stringify({
    schemaVersion: 1,
    protocolVersion: "1.0",
    maxFrameBytes: 0,
    defaultDeadlineMs: 5000,
    capabilities: ["profile:read"],
    methods: [
      { name: "profile.status", capability: "profile:read", paramsType: "ProfileStatusParams", resultType: "ProfileStatusResult" },
      { name: "profile.status", capability: "profile:read", paramsType: "ProfileStatusParams", resultType: "ProfileStatusResult" },
    ],
    types: {},
    unexpected: true,
  }));

  await assert.rejects(
    generateProtocol({ sourcePath: invalidSource, javascriptPath, geckoJavascriptPath, declarationsPath }),
    /unknown field unexpected|duplicate method profile\.status|maxFrameBytes/
  );
  await assert.rejects(readFile(javascriptPath, "utf8"), /ENOENT/);
  await assert.rejects(readFile(geckoJavascriptPath, "utf8"), /ENOENT/);
  await assert.rejects(readFile(declarationsPath, "utf8"), /ENOENT/);
});
