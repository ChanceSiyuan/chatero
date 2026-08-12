import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

const execFile = promisify(execFileCallback);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    force: true,
    recursive: true,
  })));
});

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8" });
  return stdout.trimEnd();
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "chatero-bootstrap-integration-"));
  temporaryDirectories.push(root);
  const upstream = join(root, "upstream");
  const workbenchRoot = join(root, "products", "workbench");
  const destination = join(root, "vendor", "code-oss");
  await mkdir(upstream, { recursive: true });
  await mkdir(join(upstream, "build", "npm"), { recursive: true });
  await mkdir(join(workbenchRoot, "patches", "code-oss"), { recursive: true });
  await mkdir(join(workbenchRoot, "extensions", "chatero-documentation", "webview"), { recursive: true });
  await mkdir(join(root, "first-party-src"), { recursive: true });
  await symlink(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
  await git(upstream, "init", "--initial-branch=main");
  await git(upstream, "config", "user.name", "Chatero Tests");
  await git(upstream, "config", "user.email", "tests@chatero.invalid");
  await writeFile(join(upstream, "product.json"), `${JSON.stringify({
    nameShort: "Code - OSS",
    applicationName: "code-oss",
    dataFolderName: ".vscode-oss",
    licenseName: "MIT",
    builtInExtensions: [{ name: "upstream-download" }],
  }, null, 2)}\n`);
  await writeFile(join(upstream, "package.json"), `${JSON.stringify({
    name: "code-oss-dev",
    version: "1.132.0",
    scripts: {
      compile: "npm run compile-client",
      watch: "npm-run-all2 -lp watch-client-transpile watch-client watch-extensions",
    },
  }, null, 2)}\n`);
  await writeFile(join(upstream, "package-lock.json"), `${JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: {} },
    },
  }, null, 2)}\n`);
  await writeFile(join(upstream, "build", "npm", "dirs.ts"), "export const dirs = [''];\n");
  await writeFile(join(upstream, "build", "gulpfile.vscode.ts"), "export const packageTasks = ['package-core'];\n");
  await writeFile(join(upstream, "build", "gulpfile.extensions.ts"), "export const extensionTasks = ['package-builtins'];\n");
  await writeFile(join(upstream, "build", "gulpfile.reh.ts"), "export const remoteTasks = ['package-remote'];\n");
  await git(upstream, "add", "build", "package.json", "package-lock.json", "product.json");
  await git(upstream, "commit", "-m", "fixture Code-OSS");
  const commit = await git(upstream, "rev-parse", "HEAD");
  await git(upstream, "tag", "1.132.0");

  await writeFile(join(workbenchRoot, "product.chatero.json"), `${JSON.stringify({
    nameShort: "Chatero",
    nameLong: "Chatero Research Workbench",
    applicationName: "chatero",
    dataFolderName: ".chatero",
    darwinBundleIdentifier: "io.github.chancesiyuan.chatero",
    urlProtocol: "chatero",
    builtInExtensions: [],
  }, null, 2)}\n`);
  await writeFile(join(workbenchRoot, "patches", "code-oss", "series.json"), '{"schemaVersion":1,"patches":[]}\n');
  await writeFile(join(workbenchRoot, "extensions", "chatero-documentation", "webview", "live-preview-entry.mjs"), "document.body.textContent = 'fixture';\n");
  await writeFile(join(workbenchRoot, "extensions", "chatero-documentation", "webview", "live-preview.css"), "body { margin: 0; }\n");
  await writeFile(join(root, "first-party-src", "extension.mjs"), "export function activate() {}\n");
  await writeFile(join(workbenchRoot, "first-party-extensions.json"), `${JSON.stringify({
    schemaVersion: 1,
    extensions: [{
      id: "chatero.zotero",
      files: [{
        source: "first-party-src/extension.mjs",
        destination: "extensions/chatero-zotero/extension.mjs",
      }],
    }],
  })}\n`);

  const contract = Object.freeze({
    schemaVersion: 1,
    codeOss: Object.freeze({
      repository: upstream,
      ref: "refs/tags/1.132.0",
      commit,
      version: "1.132.0",
      node: "24.18.0",
      electron: "42.7.1",
    }),
    openVSX: Object.freeze({
      gallery: "https://open-vsx.org/vscode/gallery",
      item: "https://open-vsx.org/vscode/item",
      resource: "https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/Microsoft.VisualStudio.Code.WebResources/extension",
    }),
  });
  return { contract, destination, root, workbenchRoot };
}

test("materializes and verifies a pinned Chatero checkout without network access", async () => {
  const { bootstrapCodeOss } = await import("../scripts/bootstrap-code-oss.mjs");
  const { verifyCodeOss } = await import("../scripts/verify-code-oss.mjs");
  const input = await createFixture();

  const result = await bootstrapCodeOss(input);
  const product = JSON.parse(await readFile(join(input.destination, "product.json"), "utf8"));
  const provenance = JSON.parse(await readFile(join(input.destination, ".chatero-provenance.json"), "utf8"));

  assert.equal(result.reused, false);
  assert.equal(result.commit, input.contract.codeOss.commit);
  assert.equal(product.nameShort, "Chatero");
  assert.equal(product.extensionsGallery.serviceUrl, "https://open-vsx.org/vscode/gallery");
  assert.equal(provenance.codeOssCommit, input.contract.codeOss.commit);
  assert.deepEqual(provenance.patches, []);
  assert.equal(provenance.firstPartyExtensions[0].id, "chatero.zotero");
  assert.deepEqual(provenance.managedPaths, [
    "extensions/chatero-zotero/extension.mjs",
    "product.json",
  ]);
  assert.equal(await readFile(join(input.destination, "extensions", "chatero-zotero", "extension.mjs"), "utf8"), "export function activate() {}\n");
  assert.match(provenance.productSha256, /^[0-9a-f]{64}$/);
  assert.match(provenance.worktreeDiffSha256, /^[0-9a-f]{64}$/);
  assert.equal((await verifyCodeOss(input)).ok, true);
});

test("reuses a valid generated checkout without rewriting provenance", async () => {
  const { bootstrapCodeOss } = await import("../scripts/bootstrap-code-oss.mjs");
  const input = await createFixture();
  await bootstrapCodeOss(input);
  const provenancePath = join(input.destination, ".chatero-provenance.json");
  const before = await stat(provenancePath);
  const beforeBytes = await readFile(provenancePath, "utf8");

  const result = await bootstrapCodeOss(input);
  const after = await stat(provenancePath);

  assert.equal(result.reused, true);
  assert.equal(await readFile(provenancePath, "utf8"), beforeBytes);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("refuses to repair or overwrite a tampered generated checkout", async () => {
  const { bootstrapCodeOss } = await import("../scripts/bootstrap-code-oss.mjs");
  const { verifyCodeOss } = await import("../scripts/verify-code-oss.mjs");
  const input = await createFixture();
  await bootstrapCodeOss(input);
  await writeFile(join(input.destination, "product.json"), "tampered bytes\n");

  await assert.rejects(verifyCodeOss(input), /product\.json SHA-256 does not match provenance/);
  await assert.rejects(bootstrapCodeOss(input), /existing generated checkout failed verification/);
  assert.equal(await readFile(join(input.destination, "product.json"), "utf8"), "tampered bytes\n");
});

test("does not publish provenance when marketplace policy fails", async () => {
  const { bootstrapCodeOss } = await import("../scripts/bootstrap-code-oss.mjs");
  const input = await createFixture();
  const unsafeContract = {
    ...input.contract,
    openVSX: {
      ...input.contract.openVSX,
      gallery: "https://marketplace.visualstudio.com/_apis/public/gallery",
    },
  };

  await assert.rejects(
    bootstrapCodeOss({ ...input, contract: unsafeContract }),
    /workbench policy rejected generated product/
  );
  assert.equal(await exists(join(input.destination, ".chatero-provenance.json")), false);
});

test("standalone verification is read-only", async () => {
  const { bootstrapCodeOss } = await import("../scripts/bootstrap-code-oss.mjs");
  const { verifyCodeOss } = await import("../scripts/verify-code-oss.mjs");
  const input = await createFixture();
  await bootstrapCodeOss(input);
  const beforeStatus = await git(input.destination, "status", "--porcelain=v1", "--untracked-files=all");
  const beforeProvenance = await readFile(join(input.destination, ".chatero-provenance.json"), "utf8");

  const report = await verifyCodeOss(input);

  assert.equal(report.ok, true);
  assert.equal(await git(input.destination, "status", "--porcelain=v1", "--untracked-files=all"), beforeStatus);
  assert.equal(await readFile(join(input.destination, ".chatero-provenance.json"), "utf8"), beforeProvenance);
});

test("verification permits only the deterministic API proposal artifact generated by compilation", async () => {
  const { bootstrapCodeOss } = await import("../scripts/bootstrap-code-oss.mjs");
  const { verifyCodeOss } = await import("../scripts/verify-code-oss.mjs");
  const input = await createFixture();
  await bootstrapCodeOss(input);
  const generatedDirectory = join(input.destination, "src", "vs", "platform", "extensions", "common");
  await mkdir(generatedDirectory, { recursive: true });
  await writeFile(join(generatedDirectory, "extensionsApiProposals.ts"), "// generated by compile-api-proposal-names\n");

  assert.equal((await verifyCodeOss(input)).ok, true);

  await writeFile(join(generatedDirectory, "unexpected.ts"), "// not a declared build artifact\n");
  await assert.rejects(
    verifyCodeOss(input),
    /managed checkout paths differ from provenance: .*unexpected\.ts/
  );
});
