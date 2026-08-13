import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { REMOTE_AGENT_TUPLES, verifyRelease } from "../remote-agent/release-contract.mjs";

const RELEASE_ROOT = resolve(import.meta.dirname, "..", "remote-agent");
const DEFAULT_RELEASE = join(RELEASE_ROOT, "dist");
const PUBLIC_KEY = join(RELEASE_ROOT, "release-public-key.pem");

async function safeRegularFile(path, label) {
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) throw new Error(`${label} must not be indirect`);
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  return canonical;
}

async function readVerifiedRelease(directory, publicKeyPath) {
  const root = await realpath(resolve(directory));
  if (!(await lstat(root)).isDirectory()) throw new Error("Remote Agent release root must be a directory");
  const manifestPath = await safeRegularFile(join(root, "manifest.json"), "Remote Agent manifest");
  const signaturePath = await safeRegularFile(join(root, "manifest.sig"), "Remote Agent signature");
  const publicKey = await readFile(await safeRegularFile(publicKeyPath, "Remote Agent public key"));
  const manifestText = await readFile(manifestPath, "utf8");
  const signature = await readFile(signaturePath);
  const filenames = JSON.parse(manifestText)?.artifacts?.map(value => value?.filename) ?? [];
  const expected = ["manifest.json", "manifest.sig", ...filenames].sort();
  const actual = (await readdir(root)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Remote Agent release contains missing or unexpected entries");
  const artifacts = new Map();
  for (const filename of filenames) {
    if (basename(filename) !== filename) throw new Error("Remote Agent artifact filename is unsafe");
    artifacts.set(filename, await safeRegularFile(join(root, filename), `Remote Agent artifact ${filename}`));
  }
  const manifest = await verifyRelease({
    manifestText,
    signature,
    publicKey,
    readArtifact: filename => createReadStream(artifacts.get(filename)),
  });
  if (manifest.artifacts.length !== REMOTE_AGENT_TUPLES.length
      || manifest.artifacts.some((value, index) => value.tuple !== REMOTE_AGENT_TUPLES[index])) {
    throw new Error("Remote Agent release does not contain both pinned Linux tuples");
  }
  return { artifacts, manifest, manifestPath, signaturePath };
}

function extensionRoot(appPath) {
  return join(resolve(appPath), "Contents", "Resources", "app", "extensions", "chatero-remote");
}

export async function verifyEmbeddedRemoteAgentRelease(appPath) {
  const extension = extensionRoot(appPath);
  const directory = join(extension, "remote-agent");
  const publicKey = join(extension, "runtime", "release-public-key.pem");
  return (await readVerifiedRelease(directory, publicKey)).manifest;
}

export async function embedRemoteAgentRelease(appPath, {
  releaseDirectory = process.env.CHATERO_REMOTE_AGENT_RELEASE_DIR || DEFAULT_RELEASE,
} = {}) {
  const extension = extensionRoot(appPath);
  const installedPublicKey = join(extension, "runtime", "release-public-key.pem");
  const verified = await readVerifiedRelease(releaseDirectory, PUBLIC_KEY);
  const installedKey = await readFile(await safeRegularFile(installedPublicKey, "installed Remote Agent public key"));
  const trustedKey = await readFile(await safeRegularFile(PUBLIC_KEY, "Remote Agent public key"));
  if (!installedKey.equals(trustedKey)) throw new Error("packaged Remote Agent trust root differs from the release trust root");
  const destination = join(extension, "remote-agent");
  await mkdir(destination, { recursive: false, mode: 0o755 });
  for (const [source, filename] of [
    [verified.manifestPath, "manifest.json"],
    [verified.signaturePath, "manifest.sig"],
    ...verified.manifest.artifacts.map(value => [verified.artifacts.get(value.filename), value.filename]),
  ]) await copyFile(source, join(destination, filename));
  await verifyEmbeddedRemoteAgentRelease(appPath);
  return verified.manifest;
}
