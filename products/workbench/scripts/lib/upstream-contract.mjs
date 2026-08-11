import { readFile } from "node:fs/promises";

const ROOT_FIELDS = ["schemaVersion", "codeOss", "openVSX"];
const CODE_OSS_FIELDS = [
  "repository",
  "ref",
  "commit",
  "version",
  "node",
  "electron",
];
const OPEN_VSX_FIELDS = ["gallery", "item", "resource"];
const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LOWERCASE_SHA1 = /^[0-9a-f]{40}$/;

function assertRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function assertExactFields(value, fields, field) {
  assertRecord(value, field);
  for (const required of fields) {
    if (!Object.hasOwn(value, required)) {
      throw new TypeError(`${field === "contract" ? "" : `${field}.`}${required} is required`);
    }
  }
  for (const actual of Object.keys(value)) {
    if (!fields.includes(actual)) {
      throw new TypeError(`unknown field ${field === "contract" ? actual : `${field}.${actual}`}`);
    }
  }
}

function assertSemanticVersion(value, field) {
  if (typeof value !== "string" || !SEMANTIC_VERSION.test(value)) {
    throw new TypeError(`${field} must be a semantic version`);
  }
}

function assertHttpsURL(value, field, { allowTemplate = false } = {}) {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must use HTTPS`);
  }
  const parseable = allowTemplate
    ? value.replaceAll("{publisher}", "publisher")
      .replaceAll("{name}", "name")
      .replaceAll("{version}", "version")
    : value;
  let url;
  try {
    url = new URL(parseable);
  }
  catch {
    throw new TypeError(`${field} must use HTTPS`);
  }
  if (url.protocol !== "https:") {
    throw new TypeError(`${field} must use HTTPS`);
  }
}

function freezeRecursively(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      freezeRecursively(child);
    }
  }
  return Object.freeze(value);
}

function validateContract(contract) {
  assertExactFields(contract, ROOT_FIELDS, "contract");
  assertExactFields(contract.codeOss, CODE_OSS_FIELDS, "codeOss");
  assertExactFields(contract.openVSX, OPEN_VSX_FIELDS, "openVSX");

  if (contract.schemaVersion !== 1) {
    throw new TypeError("schemaVersion must equal 1");
  }
  assertHttpsURL(contract.codeOss.repository, "codeOss.repository");
  if (typeof contract.codeOss.commit !== "string" || !LOWERCASE_SHA1.test(contract.codeOss.commit)) {
    throw new TypeError("codeOss.commit must be a 40-character lowercase SHA-1");
  }
  assertSemanticVersion(contract.codeOss.version, "codeOss.version");
  assertSemanticVersion(contract.codeOss.node, "codeOss.node");
  assertSemanticVersion(contract.codeOss.electron, "codeOss.electron");

  if (typeof contract.codeOss.ref !== "string" || !contract.codeOss.ref.startsWith("refs/tags/")) {
    throw new TypeError("codeOss.ref must identify an immutable tag");
  }
  const expectedRef = `refs/tags/${contract.codeOss.version}`;
  if (contract.codeOss.ref !== expectedRef) {
    throw new TypeError(`codeOss.ref must equal ${expectedRef}`);
  }

  assertHttpsURL(contract.openVSX.gallery, "openVSX.gallery");
  assertHttpsURL(contract.openVSX.item, "openVSX.item");
  assertHttpsURL(contract.openVSX.resource, "openVSX.resource", { allowTemplate: true });
  return freezeRecursively(contract);
}

export async function loadUpstreamContract(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  }
  catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError(`upstream contract is not valid JSON: ${error.message}`);
    }
    throw error;
  }
  return validateContract(parsed);
}
