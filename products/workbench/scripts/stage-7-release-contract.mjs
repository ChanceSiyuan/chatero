import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
export const CUTOVER_FIELDS = Object.freeze([
  "developerIdVerified", "notarizationAccepted", "ticketStapled", "gatekeeperAccepted",
  "cleanInstall", "sideBySideInstall", "copiedProfileMigration", "upgrade", "rollback",
  "urlScheme", "connector", "documentIntegration", "electronOnlyVisibleProduct",
]);

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function safeRegularFile(path, expectedParent) {
  const canonicalParent = await realpath(resolve(expectedParent));
  const canonical = await realpath(resolve(path));
  const escaped = relative(canonicalParent, canonical);
  if (!escaped || escaped === ".." || escaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("release artifact escapes or aliases its expected directory");
  }
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("release artifact is not a safe regular file");
  }
  return canonical;
}

export function validateReleaseReceipt(receipt, { sourceCommit, productSha256 } = {}) {
  const keys = [
    "schemaVersion", "status", "sourceCommit", "productFilename", "productSha256",
    "notarySubmissionId", "tested", ...CUTOVER_FIELDS,
  ];
  if (!receipt || Object.keys(receipt).sort().join(",") !== keys.sort().join(",")
      || receipt.schemaVersion !== 1 || receipt.status !== "passed"
      || !COMMIT.test(receipt.sourceCommit) || !SHA256.test(receipt.productSha256)
      || receipt.sourceCommit !== sourceCommit || receipt.productSha256 !== productSha256
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.dmg$/u.test(receipt.productFilename)
      || !/^[0-9a-f-]{36}$/iu.test(receipt.notarySubmissionId)
      || !receipt.tested || Object.values(receipt.tested).some(value => typeof value !== "string" || !value.length)
      || CUTOVER_FIELDS.some(field => receipt[field] !== true)) {
    throw new Error("Stage 7 release receipt is invalid or incomplete");
  }
  return Object.freeze({ ...receipt, tested: Object.freeze({ ...receipt.tested }) });
}

export async function verifyReleaseReceiptArtifact({ receiptPath, sourceCommit }) {
  const canonicalReceipt = await safeRegularFile(receiptPath, dirname(receiptPath));
  const receipt = JSON.parse(await readFile(canonicalReceipt, "utf8"));
  const artifactPath = await safeRegularFile(resolve(dirname(canonicalReceipt), "..", "..", "dist", receipt.productFilename), resolve(dirname(canonicalReceipt), "..", "..", "dist"));
  const productSha256 = await sha256File(artifactPath);
  return Object.freeze({
    artifactPath,
    receipt: validateReleaseReceipt(receipt, { sourceCommit, productSha256 }),
  });
}
