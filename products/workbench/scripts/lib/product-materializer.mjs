import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function readJSON(path, label) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  }
  catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError(`${label} is not valid JSON: ${error.message}`);
    }
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value;
}

function sortRecursively(value) {
  if (Array.isArray(value)) {
    return value.map(sortRecursively);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, sortRecursively(value[key])])
  );
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o644 });
    await rename(temporaryPath, path);
  }
  catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function materializeProduct({
  upstreamProductPath,
  overlayPath,
  outputPath,
  contract,
}) {
  const upstream = await readJSON(upstreamProductPath, "upstream product");
  const overlay = await readJSON(overlayPath, "Chatero product overlay");
  if (Object.hasOwn(overlay, "extensionsGallery")) {
    throw new TypeError("overlay must not define extensionsGallery");
  }
  if (!contract?.openVSX) {
    throw new TypeError("verified upstream contract with openVSX is required");
  }

  const product = sortRecursively({
    ...upstream,
    ...overlay,
    extensionsGallery: {
      serviceUrl: contract.openVSX.gallery,
      itemUrl: contract.openVSX.item,
      resourceUrlTemplate: contract.openVSX.resource,
    },
  });
  const bytes = `${JSON.stringify(product, null, 2)}\n`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await atomicWrite(outputPath, bytes);
  return { outputPath, sha256 };
}
