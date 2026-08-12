import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIRST_PARTY_MANIFEST = new URL("../first-party-extensions.json", import.meta.url);
const EXTENSION_ROOT = "extensions/chatero-documentation";

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function within(root, path) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.includes(`${sep}..${sep}`));
}

async function expectedDocumentationFiles() {
  const manifest = JSON.parse(await readFile(FIRST_PARTY_MANIFEST, "utf8"));
  const extension = manifest?.extensions?.find(value => value?.id === "chatero.documentation");
  if (!extension || !Array.isArray(extension.files) || extension.files.length === 0) {
    throw new Error("first-party Documentation payload declaration is missing");
  }
  const files = [];
  for (const record of extension.files) {
    if (!record || typeof record.source !== "string" || typeof record.destination !== "string"
      || !record.destination.startsWith(`${EXTENSION_ROOT}/`)) {
      throw new Error("first-party Documentation payload declaration is unsafe");
    }
    const source = resolve(REPOSITORY_ROOT, record.source);
    if (!within(REPOSITORY_ROOT, source)) throw new Error("Documentation payload source escapes the repository");
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error(`Documentation payload source is unsafe: ${record.source}`);
    }
    const bytes = await readFile(source);
    files.push(Object.freeze({
      path: record.destination,
      sha256: sha256(bytes),
      size: bytes.byteLength,
    }));
  }
  files.sort((left, right) => compareUtf8Bytes(left.path, right.path));
  return Object.freeze(files);
}

async function collect(root, directory, files) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error("signed Documentation extension root is unsafe");
  }
  const names = await readdir(directory);
  names.sort(compareUtf8Bytes);
  for (const name of names) {
    const path = join(directory, name);
    const value = await lstat(path);
    if (value.isSymbolicLink()) throw new Error("signed Documentation extension contains a symbolic link");
    if (value.isDirectory()) await collect(root, path, files);
    else if (value.isFile() && value.nlink === 1) {
      const bytes = await readFile(path);
      files.push(Object.freeze({
        path: relative(root, path).split(sep).join("/"),
        sha256: sha256(bytes),
        size: bytes.byteLength,
      }));
    }
    else throw new Error("signed Documentation extension contains an unsafe entry");
  }
}

export async function assertDocumentationPayload(root) {
  const canonicalRoot = resolve(root);
  if (await realpath(canonicalRoot) !== canonicalRoot) throw new Error("Remote Agent payload root is unsafe");
  const expected = await expectedDocumentationFiles();
  const actual = [];
  await collect(canonicalRoot, join(canonicalRoot, ...EXTENSION_ROOT.split("/")), actual);
  actual.sort((left, right) => compareUtf8Bytes(left.path, right.path));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Remote Agent Documentation extension does not match first-party provenance");
  }
  const helper = actual.find(value => value.path.endsWith("/runtime/chatero-documentation-authority.mjs"));
  const protocol = actual.find(value => value.path.endsWith("/runtime/protocol.mjs"));
  if (!helper || !protocol) throw new Error("Remote Agent Documentation authority runtime is incomplete");
  return Object.freeze({ files: expected, helperSha256: helper.sha256, protocolSha256: protocol.sha256 });
}
