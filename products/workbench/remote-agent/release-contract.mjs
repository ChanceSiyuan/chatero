import { createHash, verify } from "node:crypto";

export const REMOTE_AGENT_TUPLES = Object.freeze([
  "linux-x86_64",
  "linux-aarch64",
]);

const ROOT_FIELDS = Object.freeze([
  "schemaVersion",
  "product",
  "releaseVersion",
  "codeOssCommit",
  "artifacts",
]);
const ARTIFACT_FIELDS = Object.freeze([
  "tuple",
  "filename",
  "sha256",
  "size",
  "treeManifestSha256",
  "nodeSha256",
  "integrityVerifierSha256",
]);
const CODE_OSS_COMMIT = "df53daabb18cd157bdb08c7f01c34df936cf12f4";
const RELEASE_VERSION = "1.132.0";
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

function assertRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function assertExactFields(value, expected, field) {
  assertRecord(value, field);
  for (const required of expected) {
    if (!Object.hasOwn(value, required)) {
      throw new TypeError(`${field === "manifest" ? "" : `${field}.`}${required} is required`);
    }
  }
  for (const actual of Object.keys(value)) {
    if (!expected.includes(actual)) {
      throw new TypeError(`unknown field ${field === "manifest" ? actual : `${field}.${actual}`}`);
    }
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

function assertNoDuplicateObjectKeys(text) {
  let index = 0;

  function invalidJSON() {
    throw new SyntaxError(`unexpected token at character ${index}`);
  }

  function skipWhitespace() {
    while (/[\t\n\r ]/.test(text[index] ?? "")) {
      index++;
    }
  }

  function parseString() {
    const start = index;
    if (text[index++] !== '"') {
      invalidJSON();
    }
    while (index < text.length) {
      const character = text[index++];
      if (character === '"') {
        return JSON.parse(text.slice(start, index));
      }
      if (character === "\\") {
        if (index >= text.length) {
          invalidJSON();
        }
        if (text[index] === "u") {
          index += 5;
        }
        else {
          index++;
        }
      }
    }
    invalidJSON();
  }

  function parseArray() {
    index++;
    skipWhitespace();
    if (text[index] === "]") {
      index++;
      return;
    }
    while (true) {
      parseValue();
      skipWhitespace();
      if (text[index] === "]") {
        index++;
        return;
      }
      if (text[index++] !== ",") {
        invalidJSON();
      }
      skipWhitespace();
    }
  }

  function parseObject() {
    index++;
    const keys = new Set();
    skipWhitespace();
    if (text[index] === "}") {
      index++;
      return;
    }
    while (true) {
      const key = parseString();
      if (keys.has(key)) {
        throw new TypeError(`duplicate object key ${key}`);
      }
      keys.add(key);
      skipWhitespace();
      if (text[index++] !== ":") {
        invalidJSON();
      }
      parseValue();
      skipWhitespace();
      if (text[index] === "}") {
        index++;
        return;
      }
      if (text[index++] !== ",") {
        invalidJSON();
      }
      skipWhitespace();
    }
  }

  function parseValue() {
    skipWhitespace();
    const character = text[index];
    if (character === "{") {
      parseObject();
      return;
    }
    if (character === "[") {
      parseArray();
      return;
    }
    if (character === '"') {
      parseString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const number = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      index += number[0].length;
      return;
    }
    invalidJSON();
  }

  parseValue();
  skipWhitespace();
  if (index !== text.length) {
    invalidJSON();
  }
}

function parseJSON(text) {
  if (typeof text !== "string") {
    throw new TypeError("release manifest must be UTF-8 text");
  }
  try {
    assertNoDuplicateObjectKeys(text);
    return JSON.parse(text);
  }
  catch (error) {
    throw new TypeError(`release manifest is not valid JSON: ${error.message}`);
  }
}

function validateManifest(manifest) {
  assertExactFields(manifest, ROOT_FIELDS, "manifest");
  if (manifest.schemaVersion !== 1) {
    throw new TypeError("schemaVersion must equal 1");
  }
  if (manifest.product !== "chatero") {
    throw new TypeError("product must equal chatero");
  }
  if (manifest.releaseVersion !== RELEASE_VERSION) {
    throw new TypeError(`releaseVersion must equal ${RELEASE_VERSION}`);
  }
  if (manifest.codeOssCommit !== CODE_OSS_COMMIT) {
    throw new TypeError(`codeOssCommit must equal pinned commit ${CODE_OSS_COMMIT}`);
  }
  if (!Array.isArray(manifest.artifacts)) {
    throw new TypeError("artifacts must be an array");
  }

  const tuples = new Set();
  const filenames = new Set();
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const field = `artifacts[${index}]`;
    assertExactFields(artifact, ARTIFACT_FIELDS, field);
    if (artifact.tuple !== REMOTE_AGENT_TUPLES[index]) {
      throw new TypeError(`${field}.tuple must equal ${REMOTE_AGENT_TUPLES[index]}`);
    }
    if (!REMOTE_AGENT_TUPLES.includes(artifact.tuple)) {
      throw new TypeError(`${field}.tuple must be one of ${REMOTE_AGENT_TUPLES.join(", ")}`);
    }
    if (tuples.has(artifact.tuple)) {
      throw new TypeError(`${field}.tuple duplicates ${artifact.tuple}`);
    }
    tuples.add(artifact.tuple);

    const expectedFilename = `chatero-agent-${artifact.tuple}.tar.gz`;
    if (artifact.filename !== expectedFilename) {
      throw new TypeError(`${field}.filename must equal ${expectedFilename}`);
    }
    if (filenames.has(artifact.filename)) {
      throw new TypeError(`${field}.filename is duplicated`);
    }
    filenames.add(artifact.filename);

    if (typeof artifact.sha256 !== "string" || !LOWERCASE_SHA256.test(artifact.sha256)) {
      throw new TypeError(`${field}.sha256 must be 64 lowercase hexadecimal characters`);
    }
    for (const digestField of [
      "treeManifestSha256",
      "nodeSha256",
      "integrityVerifierSha256",
    ]) {
      if (typeof artifact[digestField] !== "string" || !LOWERCASE_SHA256.test(artifact[digestField])) {
        throw new TypeError(`${field}.${digestField} must be 64 lowercase hexadecimal characters`);
      }
    }
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1) {
      throw new TypeError(`${field}.size must be a positive safe integer`);
    }
  }
  for (const tuple of REMOTE_AGENT_TUPLES) {
    if (!tuples.has(tuple)) {
      throw new TypeError(`artifacts must include ${tuple}`);
    }
  }
  if (manifest.artifacts.length !== REMOTE_AGENT_TUPLES.length) {
    throw new TypeError(`artifacts must contain exactly ${REMOTE_AGENT_TUPLES.length} entries`);
  }
  return freezeRecursively(manifest);
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value;
}

export function canonicalManifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(canonicalize(manifest))}\n`, "utf8");
}

export function parseReleaseManifest(text) {
  return validateManifest(parseJSON(text));
}

async function readAndHashArtifact(source, artifact) {
  const hash = createHash("sha256");
  let size = 0;
  const chunks = Buffer.isBuffer(source) || source instanceof Uint8Array
    ? [source]
    : source;
  if (!chunks || typeof chunks[Symbol.asyncIterator] !== "function"
    && typeof chunks[Symbol.iterator] !== "function") {
    throw new TypeError(`artifact reader for ${artifact.filename} must return bytes or a stream`);
  }
  for await (const chunk of chunks) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      throw new TypeError(`artifact reader for ${artifact.filename} returned a non-byte chunk`);
    }
    size += chunk.byteLength;
    hash.update(chunk);
  }
  const digest = hash.digest("hex");
  const badSize = size !== artifact.size;
  const badDigest = digest !== artifact.sha256;
  if (badSize || badDigest) {
    const mismatches = [badSize && "size", badDigest && "digest"].filter(Boolean).join(" and ");
    throw new Error(`artifact ${mismatches} mismatch for ${artifact.filename}`);
  }
}

// Trust root: Ed25519 signature over the canonical manifest bytes. No artifact
// IO, so a caller that only needs the manifest never reads a tarball.
export function verifyReleaseManifest({ manifestText, signature, publicKey }) {
  const parsed = parseJSON(manifestText);
  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      canonicalManifestBytes(parsed),
      publicKey,
      signature
    );
  }
  catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw new Error("release manifest signature verification failed");
  }
  return validateManifest(parsed);
}

// Size and SHA-256 check for one artifact of an already signature-verified
// manifest.
export async function verifyReleaseArtifact(readArtifact, artifact) {
  if (typeof readArtifact !== "function") {
    throw new TypeError("readArtifact must be a function");
  }
  await readAndHashArtifact(await readArtifact(artifact.filename), artifact);
}

export async function verifyRelease({
  manifestText,
  signature,
  publicKey,
  readArtifact,
}) {
  const manifest = verifyReleaseManifest({ manifestText, signature, publicKey });
  if (typeof readArtifact !== "function") {
    throw new TypeError("readArtifact must be a function");
  }
  for (const artifact of manifest.artifacts) {
    await verifyReleaseArtifact(readArtifact, artifact);
  }
  return manifest;
}

export function selectArtifact(manifest, { commit, tuple }) {
  validateManifest(manifest);
  if (commit !== manifest.codeOssCommit) {
    throw new Error(`release commit does not match requested commit ${commit}`);
  }
  if (!REMOTE_AGENT_TUPLES.includes(tuple)) {
    throw new Error(`unsupported remote agent tuple ${tuple}`);
  }
  return manifest.artifacts.find(artifact => artifact.tuple === tuple);
}
