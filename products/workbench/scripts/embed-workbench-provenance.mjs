import { copyFile, lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DEFAULT_SOURCE = join(REPOSITORY_ROOT, "vendor", "code-oss", ".chatero-provenance.json");

async function safeRegularFile(path, label) {
  const canonical = await realpath(path).catch(error => {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  });
  if (canonical !== resolve(path)) throw new Error(`${label} must not be indirect`);
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  return canonical;
}

function installedPath(appPath) {
  return join(resolve(appPath), "Contents", "Resources", "app", ".chatero-provenance.json");
}

function validateShape(bytes) {
  let value;
  try { value = JSON.parse(bytes); }
  catch (error) { throw new Error(`Workbench provenance is invalid JSON: ${error.message}`); }
  if (value?.schemaVersion !== 1 || !Array.isArray(value.firstPartyExtensions)
      || !value.firstPartyExtensions.some(entry => entry?.id === "chatero.documentation")
      || !value.firstPartyExtensions.some(entry => entry?.id === "chatero.remote")
      || !value.firstPartyExtensions.some(entry => entry?.id === "chatero.zotero")) {
    throw new Error("Workbench provenance does not cover every Chatero first-party extension");
  }
  return value;
}

export async function verifyEmbeddedWorkbenchProvenance(appPath, {
  provenancePath = DEFAULT_SOURCE,
} = {}) {
  const source = await safeRegularFile(provenancePath, "source Workbench provenance");
  const installed = await safeRegularFile(installedPath(appPath), "installed Workbench provenance");
  const [sourceBytes, installedBytes] = await Promise.all([readFile(source), readFile(installed)]);
  validateShape(sourceBytes);
  validateShape(installedBytes);
  if (!sourceBytes.equals(installedBytes)) {
    throw new Error("installed Workbench provenance differs from the verified Code-OSS checkout");
  }
  return JSON.parse(installedBytes);
}

export async function embedWorkbenchProvenance(appPath, {
  provenancePath = DEFAULT_SOURCE,
} = {}) {
  const source = await safeRegularFile(provenancePath, "source Workbench provenance");
  const destination = installedPath(appPath);
  if (await lstat(destination).then(() => true).catch(error => {
    if (error?.code === "ENOENT") return false;
    throw error;
  })) throw new Error("packaged Workbench provenance destination already exists");
  validateShape(await readFile(source));
  await copyFile(source, destination);
  return verifyEmbeddedWorkbenchProvenance(appPath, { provenancePath: source });
}
