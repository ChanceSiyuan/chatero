import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";

import {
  REMOTE_AGENT_TUPLES,
  canonicalManifestBytes,
  parseReleaseManifest,
  selectArtifact,
  verifyRelease,
} from "../remote-agent/release-contract.mjs";

const CODE_OSS_COMMIT = "df53daabb18cd157bdb08c7f01c34df936cf12f4";
const BRIDGE_PATH = fileURLToPath(new URL(
  "../remote-agent/runtime/chatero-process-bridge.mjs",
  import.meta.url
));
const EVIDENCE_HELPER_PATH = fileURLToPath(new URL(
  "../remote-agent/runtime/chatero-evidence-cache.mjs",
  import.meta.url
));
const STAGE_PATH = fileURLToPath(new URL(
  "../remote-agent/scripts/stage-release.mjs",
  import.meta.url
));
const BUILD_PATH = fileURLToPath(new URL(
  "../remote-agent/scripts/build-linux-agent.mjs",
  import.meta.url
));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIRST_PARTY_MANIFEST_PATH = fileURLToPath(new URL(
  "../first-party-extensions.json",
  import.meta.url,
));
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    force: true,
    recursive: true,
  })));
});

function makeManifest(artifacts, tuples = REMOTE_AGENT_TUPLES) {
  return {
    schemaVersion: 1,
    product: "chatero",
    releaseVersion: "1.132.0",
    codeOssCommit: CODE_OSS_COMMIT,
    artifacts: tuples.map(tuple => {
      const bytes = artifacts.get(`chatero-agent-${tuple}.tar.gz`);
      return {
        tuple,
        filename: `chatero-agent-${tuple}.tar.gz`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        treeManifestSha256: createHash("sha256").update(`${tuple}:tree`).digest("hex"),
        nodeSha256: createHash("sha256").update(`${tuple}:node`).digest("hex"),
        integrityVerifierSha256: createHash("sha256").update(`${tuple}:verifier`).digest("hex"),
      };
    }),
  };
}

async function signedFixture({ tuples = REMOTE_AGENT_TUPLES, mutateManifest } = {}) {
  const artifacts = new Map([
    ["chatero-agent-linux-x86_64.tar.gz", Buffer.from("x64-agent")],
    ["chatero-agent-linux-aarch64.tar.gz", Buffer.from("arm64-agent")],
  ]);
  const manifest = makeManifest(artifacts, tuples);
  mutateManifest?.(manifest);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifestText = canonicalManifestBytes(manifest).toString("utf8");
  const signature = sign(null, Buffer.from(manifestText), privateKey);
  return {
    artifacts,
    manifestText,
    publicKey,
    readArtifact(filename) {
      const bytes = artifacts.get(filename);
      if (!bytes) {
        throw new Error(`missing test artifact ${filename}`);
      }
      return Readable.from([bytes]);
    },
    signature,
  };
}

async function runBridge(request) {
  const child = spawn(process.execPath, [BRIDGE_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const [code, signal] = await once(child, "close");
  const frames = Buffer.concat(stdout)
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
  return {
    code,
    frames,
    signal,
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));
  const [code, signal] = await once(child, "close");
  return {
    code,
    signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function elfFixture(machine) {
  const header = Buffer.alloc(20);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(header);
  header.writeUInt16LE(machine, 18);
  return header;
}

async function addDocumentationExtensionFixture(source, root) {
  const manifest = JSON.parse(await readFile(FIRST_PARTY_MANIFEST_PATH, "utf8"));
  const extension = manifest.extensions.find(value => value.id === "chatero.documentation");
  assert.ok(extension);
  for (const record of extension.files) {
    const destination = join(source, root, record.destination);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(REPOSITORY_ROOT, record.source)), { mode: 0o644 });
  }
}

async function createRemoteAgentFixture(source, root, tuple, {
  agentSdks = {},
  omitNotice,
} = {}) {
  const architecture = tuple === "linux-x86_64"
    ? {
      machine: 62,
      packageName: "codex-linux-x64",
      packageVersion: "0.142.0-linux-x64",
      triple: "x86_64-unknown-linux-musl",
    }
    : {
      machine: 183,
      packageName: "codex-linux-arm64",
      packageVersion: "0.142.0-linux-arm64",
      triple: "aarch64-unknown-linux-musl",
    };
  const bin = join(source, root, "bin");
  const openAi = join(source, root, "agent-sdk", "codex", "node_modules", "@openai");
  const nativeRoot = join(openAi, architecture.packageName);
  const vendorRoot = join(nativeRoot, "vendor", architecture.triple);
  const nodeModules = join(source, root, "agent-sdk", "codex", "node_modules");
  await mkdir(join(vendorRoot, "bin"), { recursive: true });
  await mkdir(join(vendorRoot, "codex-path"), { recursive: true });
  await mkdir(join(openAi, "codex", "bin"), { recursive: true });
  await mkdir(join(nodeModules, ".bin"), { recursive: true });
  await mkdir(join(source, root, "licenses"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await addDocumentationExtensionFixture(source, root);
  await writeFile(join(source, root, "node"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(bin, "chatero-server"), `${tuple}\n`, { mode: 0o755 });
  await writeFile(join(source, root, "product.json"), JSON.stringify({ agentSdks }), "utf8");
  await writeFile(join(openAi, "codex", "package.json"), JSON.stringify({ version: "0.142.0" }));
  await writeFile(join(openAi, "codex", "bin", "codex.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
  await writeFile(join(nodeModules, ".package-lock.json"), "{}\n", "utf8");
  await symlink("../@openai/codex/bin/codex.js", join(nodeModules, ".bin", "codex"));
  await writeFile(join(nativeRoot, "package.json"), JSON.stringify({ version: architecture.packageVersion }));
  await writeFile(join(vendorRoot, "bin", "codex"), elfFixture(architecture.machine), { mode: 0o755 });
  await writeFile(join(vendorRoot, "codex-path", "rg"), elfFixture(architecture.machine), { mode: 0o755 });
  for (const notice of [
    "LICENSE.txt",
    "ThirdPartyNotices.txt",
    "licenses/OpenAI-Codex-Apache-2.0.txt",
    "licenses/OpenAI-Codex-NOTICE.txt",
    "licenses/ripgrep-MIT.txt",
    "licenses/ripgrep-UNLICENSE.txt",
  ]) {
    if (notice !== omitNotice) {
      await writeFile(join(source, root, notice), `${notice}\n`, "utf8");
    }
  }
}

test("canonical manifest bytes recursively sort object keys and preserve array order", () => {
  const bytes = canonicalManifestBytes({ z: { b: 2, a: 1 }, a: [{ y: 2, x: 1 }] });

  assert.equal(bytes.toString("utf8"), '{"a":[{"x":1,"y":2}],"z":{"a":1,"b":2}}\n');
});

test("release verification requires both exact pinned Linux tuples", async () => {
  const signed = await signedFixture({ tuples: ["linux-x86_64"] });

  await assert.rejects(() => verifyRelease(signed), /linux-aarch64/);
});

test("release verification requires artifacts in pinned tuple order", async () => {
  const signed = await signedFixture({
    tuples: ["linux-aarch64", "linux-x86_64"],
  });

  await assert.rejects(
    () => verifyRelease(signed),
    /artifacts\[0\]\.tuple must equal linux-x86_64/
  );
});

test("release parsing rejects duplicate root and nested object keys", async () => {
  const signed = await signedFixture();
  const duplicateRoot = signed.manifestText.replace(
    '"product":"chatero"',
    '"product":"chatero","product":"chatero"'
  );
  const duplicateNested = signed.manifestText.replace(
    '"filename":"chatero-agent-linux-x86_64.tar.gz"',
    '"filename":"chatero-agent-linux-x86_64.tar.gz","filename":"chatero-agent-linux-x86_64.tar.gz"'
  );

  assert.throws(() => parseReleaseManifest(duplicateRoot), /duplicate object key product/);
  assert.throws(() => parseReleaseManifest(duplicateNested), /duplicate object key filename/);
});

test("release verification rejects a changed manifest or artifact", async () => {
  const signed = await signedFixture();

  await assert.rejects(
    () => verifyRelease({
      ...signed,
      manifestText: signed.manifestText.replace("x86_64", "x86_65"),
    }),
    /signature/
  );
  signed.artifacts.set("chatero-agent-linux-x86_64.tar.gz", Buffer.from("changed"));
  await assert.rejects(() => verifyRelease(signed), /digest/);
});

test("release verification rejects malformed key sets and metadata", async () => {
  const unknown = await signedFixture({
    mutateManifest(manifest) {
      manifest.channel = "stable";
    },
  });
  const missing = await signedFixture({
    mutateManifest(manifest) {
      delete manifest.product;
    },
  });

  await assert.rejects(() => verifyRelease(unknown), /unknown field channel/);
  await assert.rejects(() => verifyRelease(missing), /product is required/);
  assert.throws(
    () => parseReleaseManifest('{"schemaVersion":1,"product":"chatero"}'),
    /releaseVersion is required/
  );
});

test("release verification checks signature before opening artifacts", async () => {
  const signed = await signedFixture();
  let artifactReads = 0;

  await assert.rejects(() => verifyRelease({
    ...signed,
    signature: Buffer.alloc(64),
    readArtifact(filename) {
      artifactReads++;
      return signed.readArtifact(filename);
    },
  }), /signature/);
  assert.equal(artifactReads, 0);
});

test("release verification rejects bad artifact sizes and digests", async () => {
  const badSize = await signedFixture({
    mutateManifest(manifest) {
      manifest.artifacts[0].size++;
    },
  });
  const badDigest = await signedFixture({
    mutateManifest(manifest) {
      manifest.artifacts[1].sha256 = "0".repeat(64);
    },
  });

  await assert.rejects(() => verifyRelease(badSize), /size/);
  await assert.rejects(() => verifyRelease(badDigest), /digest/);
});

test("release verification requires every signed installed-tree digest", async () => {
  for (const field of ["treeManifestSha256", "nodeSha256", "integrityVerifierSha256"]) {
    const signed = await signedFixture({
      mutateManifest(manifest) { delete manifest.artifacts[0][field]; },
    });
    await assert.rejects(() => verifyRelease(signed), new RegExp(field));
  }
});

test("installed-tree verification rejects changed bytes, modes, links, and entries", async () => {
  const {
    verifyInstallTree,
    writeInstallTreeManifest,
  } = await import("../remote-agent/runtime/chatero-install-integrity.mjs");
  const directory = await mkdtemp(join(tmpdir(), "chatero-install-tree-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "agent");
  const launcherDirectory = join(root, "agent-sdk", "codex", "node_modules", "@openai", "codex", "bin");
  const shimDirectory = join(root, "agent-sdk", "codex", "node_modules", ".bin");
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(launcherDirectory, { recursive: true });
  await mkdir(shimDirectory, { recursive: true });
  await writeFile(join(root, "node"), "node\n", { mode: 0o755 });
  await writeFile(join(root, "bin", "chatero-server"), "server\n", { mode: 0o755 });
  await writeFile(join(root, "bin", "chatero-install-integrity.mjs"), "verifier\n", { mode: 0o755 });
  await writeFile(join(launcherDirectory, "codex.js"), "launcher\n", { mode: 0o755 });
  await symlink("../@openai/codex/bin/codex.js", join(shimDirectory, "codex"));
  const written = await writeInstallTreeManifest({ root });
  const verify = () => verifyInstallTree({
    root,
    manifestBytes: written.manifestBytes,
    expectedTreeDigest: written.treeManifestSha256,
  });
  assert.deepEqual(await verify(), {
    kind: "verified",
    treeManifestSha256: written.treeManifestSha256,
  });

  const server = join(root, "bin", "chatero-server");
  await writeFile(server, "changed\n", { mode: 0o755 });
  assert.equal((await verify()).kind, "integrity-failure");
  await writeFile(server, "server\n", { mode: 0o755 });
  await chmod(server, 0o700);
  assert.equal((await verify()).kind, "integrity-failure");
  await chmod(server, 0o755);
  await writeFile(join(root, "extra"), "extra\n");
  assert.equal((await verify()).kind, "integrity-failure");
  await rm(join(root, "extra"));
  await rm(server);
  assert.equal((await verify()).kind, "integrity-failure");
  await writeFile(server, "server\n", { mode: 0o755 });
  await rm(join(shimDirectory, "codex"));
  await symlink("../../../../../../bin/chatero-server", join(shimDirectory, "codex"));
  assert.equal((await verify()).kind, "integrity-failure");

  await rm(join(shimDirectory, "codex"));
  await symlink("../@openai/codex/bin/codex.js", join(shimDirectory, "codex"));
  await link(server, join(root, "hardlink"));
  assert.equal((await verify()).kind, "integrity-failure");
});

test("artifact selection requires the pinned commit and a supported tuple", async () => {
  const signed = await signedFixture();
  const manifest = await verifyRelease(signed);

  const selected = selectArtifact(manifest, {
      commit: CODE_OSS_COMMIT,
      tuple: "linux-aarch64",
    });
  assert.equal(selected.filename, "chatero-agent-linux-aarch64.tar.gz");
  assert.match(selected.treeManifestSha256, /^[0-9a-f]{64}$/);
  assert.match(selected.nodeSha256, /^[0-9a-f]{64}$/);
  assert.match(selected.integrityVerifierSha256, /^[0-9a-f]{64}$/);
  assert.throws(
    () => selectArtifact(manifest, { commit: "0".repeat(40), tuple: "linux-aarch64" }),
    /commit/
  );
  assert.throws(
    () => selectArtifact(manifest, { commit: CODE_OSS_COMMIT, tuple: "linux-riscv64" }),
    /tuple/
  );
});

test("process bridge preserves argv boundaries and emits base64 output frames", async () => {
  const request = {
    protocolVersion: 1,
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1))); process.stderr.write('warning')",
      "hello world",
      "$(touch should-not-exist)",
    ],
    cwd: process.cwd(),
    env: { CHATERO_BRIDGE_TEST: "present" },
  };

  const result = await runBridge(request);
  const stdout = result.frames
    .filter(frame => frame.type === "stdout")
    .map(frame => Buffer.from(frame.data, "base64"))
    .join("");
  const stderr = result.frames
    .filter(frame => frame.type === "stderr")
    .map(frame => Buffer.from(frame.data, "base64"))
    .join("");

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(stdout), ["hello world", "$(touch should-not-exist)"]);
  assert.equal(stderr, "warning");
  assert.deepEqual(result.frames.at(-1), { type: "exit", code: 0, signal: null });
});

test("process bridge rejects non-absolute cwd and oversized argv before spawning", async () => {
  const base = {
    protocolVersion: 1,
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: process.cwd(),
    env: {},
  };

  const relativeCwd = await runBridge({ ...base, cwd: "relative/path" });
  const oversizedArg = await runBridge({ ...base, args: ["x".repeat(64 * 1024 + 1)] });

  assert.equal(relativeCwd.code, 1);
  assert.match(relativeCwd.frames[0].message, /cwd.*absolute/);
  assert.equal(oversizedArg.code, 1);
  assert.match(oversizedArg.frames[0].message, /argument.*64 KiB/);
});

test("process bridge rejects unknown request keys and oversized environment entries", async () => {
  const base = {
    protocolVersion: 1,
    command: process.execPath,
    args: [],
    cwd: process.cwd(),
    env: {},
  };

  const unknown = await runBridge({ ...base, shell: true });
  const oversizedEnv = await runBridge({
    ...base,
    env: { TOO_LARGE: "x".repeat(64 * 1024) },
  });

  assert.equal(unknown.code, 1);
  assert.match(unknown.frames[0].message, /unknown field shell/);
  assert.equal(oversizedEnv.code, 1);
  assert.match(oversizedEnv.frames[0].message, /environment entry.*64 KiB/);
});

test("release staging injects fixed helpers and signs the exact install tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatero-stage-release-"));
  temporaryDirectories.push(directory);
  const inputs = join(directory, "inputs");
  const output = join(directory, "output");
  await mkdir(inputs);
  const archives = {};
  for (const [arch, tuple] of [["x64", "linux-x86_64"], ["arm64", "linux-aarch64"]]) {
    const root = `chatero-agent-${tuple}`;
    const source = join(directory, `${arch}-source`);
    await createRemoteAgentFixture(source, root, tuple);
    archives[arch] = join(inputs, `${arch}.tar.gz`);
    const packed = await run("tar", ["-czf", archives[arch], "-C", source, root]);
    assert.equal(packed.code, 0, packed.stderr);
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(directory, "release.private.pem");
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });

  const staged = await run(process.execPath, [
    STAGE_PATH,
    "--x64", archives.x64,
    "--arm64", archives.arm64,
    "--private-key", privateKeyPath,
    "--out", output,
  ]);
  assert.equal(staged.code, 0, staged.stderr);

  const manifestText = await readFile(join(output, "manifest.json"), "utf8");
  const signature = await readFile(join(output, "manifest.sig"));
  const manifest = await verifyRelease({
    manifestText,
    signature,
    publicKey,
    readArtifact(filename) {
      return createReadStream(join(output, filename));
    },
  });
  for (const artifact of manifest.artifacts) {
    const listed = await run("tar", ["-tzf", join(output, artifact.filename)]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(
      listed.stdout,
      new RegExp(`^chatero-agent-${artifact.tuple}/bin/chatero-process-bridge\\.mjs$`, "m")
    );
    assert.match(
      listed.stdout,
      new RegExp(`^chatero-agent-${artifact.tuple}/bin/chatero-evidence-cache\\.mjs$`, "m")
    );
    assert.match(
      listed.stdout,
      new RegExp(`^chatero-agent-${artifact.tuple}/bin/chatero-install-integrity\\.mjs$`, "m")
    );
    assert.match(
      listed.stdout,
      new RegExp(`^chatero-agent-${artifact.tuple}/integrity/tree\\.v1\\.json$`, "m")
    );
    assert.match(
      listed.stdout,
      new RegExp(`^chatero-agent-${artifact.tuple}/extensions/chatero-documentation/runtime/chatero-documentation-authority\\.mjs$`, "m")
    );
    const extracted = join(directory, `extracted-${artifact.tuple}`);
    await mkdir(extracted);
    const unpacked = await run("tar", ["-xzf", join(output, artifact.filename), "-C", extracted]);
    assert.equal(unpacked.code, 0, unpacked.stderr);
    const helper = join(extracted, `chatero-agent-${artifact.tuple}`, "bin", "chatero-evidence-cache.mjs");
    const metadata = await lstat(helper);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.nlink, 1);
    assert.notEqual(metadata.mode & 0o111, 0);
    assert.deepEqual(await readFile(helper), await readFile(EVIDENCE_HELPER_PATH));
    const root = join(extracted, `chatero-agent-${artifact.tuple}`);
    const manifestBytes = await readFile(join(root, "integrity", "tree.v1.json"));
    const verifierBytes = await readFile(join(root, "bin", "chatero-install-integrity.mjs"));
    const nodeBytes = await readFile(join(root, "node"));
    assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), artifact.treeManifestSha256);
    assert.equal(createHash("sha256").update(verifierBytes).digest("hex"), artifact.integrityVerifierSha256);
    assert.equal(createHash("sha256").update(nodeBytes).digest("hex"), artifact.nodeSha256);
    const { verifyInstallTree } = await import("../remote-agent/runtime/chatero-install-integrity.mjs");
    assert.equal((await verifyInstallTree({
      root,
      manifestBytes,
      expectedTreeDigest: artifact.treeManifestSha256,
    })).kind, "verified");
  }
});

test("release staging refuses to sign an archive without the complete SDK notices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatero-stage-incomplete-sdk-"));
  temporaryDirectories.push(directory);
  const inputs = join(directory, "inputs");
  const output = join(directory, "output");
  await mkdir(inputs);
  const archives = {};
  for (const [arch, tuple] of [["x64", "linux-x86_64"], ["arm64", "linux-aarch64"]]) {
    const root = `chatero-agent-${tuple}`;
    const source = join(directory, `${arch}-source`);
    await createRemoteAgentFixture(source, root, tuple, {
      omitNotice: arch === "x64" ? "licenses/ripgrep-UNLICENSE.txt" : undefined,
    });
    archives[arch] = join(inputs, `${arch}.tar.gz`);
    const packed = await run("tar", ["-czf", archives[arch], "-C", source, root]);
    assert.equal(packed.code, 0, packed.stderr);
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(directory, "release.private.pem");
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });

  const staged = await run(process.execPath, [
    STAGE_PATH,
    "--x64", archives.x64,
    "--arm64", archives.arm64,
    "--private-key", privateKeyPath,
    "--out", output,
  ]);

  assert.equal(staged.code, 1);
  assert.match(staged.stderr, /ripgrep-UNLICENSE\.txt.*regular file/);
});

test("release staging rejects an Agent SDK download fallback in product.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatero-stage-sdk-fallback-"));
  temporaryDirectories.push(directory);
  const inputs = join(directory, "inputs");
  const output = join(directory, "output");
  await mkdir(inputs);
  const archives = {};
  for (const [arch, tuple] of [["x64", "linux-x86_64"], ["arm64", "linux-aarch64"]]) {
    const root = `chatero-agent-${tuple}`;
    const source = join(directory, `${arch}-source`);
    await createRemoteAgentFixture(source, root, tuple, {
      agentSdks: arch === "x64" ? {
        codex: { version: "0.142.0", urlTemplate: "https://main.vscode-cdn.net/sdk.tgz" },
      } : {},
    });
    archives[arch] = join(inputs, `${arch}.tar.gz`);
    const packed = await run("tar", ["-czf", archives[arch], "-C", source, root]);
    assert.equal(packed.code, 0, packed.stderr);
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(directory, "release.private.pem");
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

  const staged = await run(process.execPath, [
    STAGE_PATH,
    "--x64", archives.x64,
    "--arm64", archives.arm64,
    "--private-key", privateKeyPath,
    "--out", output,
  ]);

  assert.equal(staged.code, 1);
  assert.match(staged.stderr, /product\.json.*agentSdks.*empty/i);
});

test("release staging rejects a required payload behind an intermediate symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatero-stage-parent-symlink-"));
  temporaryDirectories.push(directory);
  const inputs = join(directory, "inputs");
  const output = join(directory, "output");
  await mkdir(inputs);
  const archives = {};
  for (const [arch, tuple] of [["x64", "linux-x86_64"], ["arm64", "linux-aarch64"]]) {
    const root = `chatero-agent-${tuple}`;
    const source = join(directory, `${arch}-source`);
    await createRemoteAgentFixture(source, root, tuple);
    if (arch === "x64") {
      const external = join(directory, "external-licenses");
      await mkdir(external);
      for (const name of [
        "OpenAI-Codex-Apache-2.0.txt",
        "OpenAI-Codex-NOTICE.txt",
        "ripgrep-MIT.txt",
        "ripgrep-UNLICENSE.txt",
      ]) {
        await writeFile(join(external, name), `${name}\n`, "utf8");
      }
      await rm(join(source, root, "licenses"), { recursive: true });
      await symlink(external, join(source, root, "licenses"));
    }
    archives[arch] = join(inputs, `${arch}.tar.gz`);
    const packed = await run("tar", ["-czf", archives[arch], "-C", source, root]);
    assert.equal(packed.code, 0, packed.stderr);
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(directory, "release.private.pem");
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

  const staged = await run(process.execPath, [
    STAGE_PATH,
    "--x64", archives.x64,
    "--arm64", archives.arm64,
    "--private-key", privateKeyPath,
    "--out", output,
  ]);

  assert.equal(staged.code, 1);
  assert.match(staged.stderr, /licenses.*ancestors must be real directories/i);
});

test("release staging rejects unpinned Documentation and Agent SDK payloads", async t => {
  for (const [name, addForbiddenPayload, expected] of [
    ["install marker symlink", async root => {
      await symlink("product.json", join(root, ".chatero-release-sha256"));
    }, /must not provide.*release marker/i],
    ["extra agent provider", async root => {
      await mkdir(join(root, "agent-sdk", "claude"), { recursive: true });
      await writeFile(join(root, "agent-sdk", "claude", "payload"), "forbidden\n", "utf8");
    }, /agent-sdk.*exactly codex/i],
    ["extra OpenAI package", async root => {
      await mkdir(join(root, "agent-sdk", "codex", "node_modules", "@openai", "foo"), { recursive: true });
      await writeFile(join(root, "agent-sdk", "codex", "node_modules", "@openai", "foo", "payload"), "forbidden\n", "utf8");
    }, /@openai.*exactly.*codex/i],
    ["changed Documentation helper", async root => {
      await writeFile(
        join(root, "extensions", "chatero-documentation", "runtime", "chatero-documentation-authority.mjs"),
        "tampered\n",
      );
    }, /Documentation extension.*first-party provenance/i],
  ]) {
    await t.test(name, async () => {
      const directory = await mkdtemp(join(tmpdir(), "chatero-stage-provider-"));
      temporaryDirectories.push(directory);
      const inputs = join(directory, "inputs");
      const output = join(directory, "output");
      await mkdir(inputs);
      const archives = {};
      for (const [arch, tuple] of [["x64", "linux-x86_64"], ["arm64", "linux-aarch64"]]) {
        const rootName = `chatero-agent-${tuple}`;
        const source = join(directory, `${arch}-source`);
        await createRemoteAgentFixture(source, rootName, tuple);
        if (arch === "x64") await addForbiddenPayload(join(source, rootName));
        archives[arch] = join(inputs, `${arch}.tar.gz`);
        const packed = await run("tar", ["-czf", archives[arch], "-C", source, rootName]);
        assert.equal(packed.code, 0, packed.stderr);
      }
      const { privateKey } = generateKeyPairSync("ed25519");
      const privateKeyPath = join(directory, "release.private.pem");
      await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

      const staged = await run(process.execPath, [
        STAGE_PATH,
        "--x64", archives.x64,
        "--arm64", archives.arm64,
        "--private-key", privateKeyPath,
        "--out", output,
      ]);

      assert.equal(staged.code, 1);
      assert.match(staged.stderr, expected);
    });
  }
});

test("release staging rejects a bridge destination symlink without changing its target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatero-stage-symlink-"));
  temporaryDirectories.push(directory);
  const inputs = join(directory, "inputs");
  const output = join(directory, "output");
  const sentinel = join(directory, "outside-sentinel");
  await mkdir(inputs);
  await writeFile(sentinel, "unchanged\n", "utf8");
  const archives = {};
  for (const [arch, tuple] of [["x64", "linux-x86_64"], ["arm64", "linux-aarch64"]]) {
    const root = `chatero-agent-${tuple}`;
    const source = join(directory, `${arch}-symlink-source`);
    const bin = join(source, root, "bin");
    await createRemoteAgentFixture(source, root, tuple);
    if (arch === "x64") {
      await symlink(sentinel, join(bin, "chatero-process-bridge.mjs"));
    }
    archives[arch] = join(inputs, `${arch}.tar.gz`);
    const packed = await run("tar", ["-czf", archives[arch], "-C", source, root]);
    assert.equal(packed.code, 0, packed.stderr);
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(directory, "release.private.pem");
  await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });

  const staged = await run(process.execPath, [
    STAGE_PATH,
    "--x64", archives.x64,
    "--arm64", archives.arm64,
    "--private-key", privateKeyPath,
    "--out", output,
  ]);

  assert.equal(staged.code, 1);
  assert.match(staged.stderr, /bridge destination.*regular file/);
  assert.equal(await readFile(sentinel, "utf8"), "unchanged\n");
});

test("Linux agent builder rejects unsupported hosts before doing build work", async () => {
  const result = await run(process.execPath, [BUILD_PATH]);

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    process.platform === "linux" ? /--arch is required/ : /only runs on Linux/
  );
});

test("Linux agent builder requires the pinned Node runtime", async () => {
  const { assertBuildNodeVersion } = await import(BUILD_PATH);

  assert.doesNotThrow(() => assertBuildNodeVersion("24.18.0"));
  assert.throws(() => assertBuildNodeVersion("24.17.0"), /Node 24\.18\.0/);
});

test("Linux agent builder runs gulp with the already verified Node executable", async () => {
  const { makeCodeOssBuildInvocation } = await import(BUILD_PATH);

  assert.deepEqual(makeCodeOssBuildInvocation({
    checkout: "/srv/code-oss",
    target: "vscode-reh-linux-x64-min-ci",
    nodePath: "/opt/chatero/node-v24.18.0/bin/node",
    environment: {
      AGENT_SDK_RESULTS_FILE: "/tmp/untrusted-sdk-results.json",
      PATH: "/usr/bin",
      VSCODE_PUBLISH: "true",
    },
  }), {
    command: "/opt/chatero/node-v24.18.0/bin/node",
    args: [
      "--experimental-strip-types",
      "--max-old-space-size=8192",
      "/srv/code-oss/node_modules/gulp/bin/gulp.js",
      "vscode-reh-linux-x64-min-ci",
    ],
    cwd: "/srv/code-oss",
    env: {
      PATH: "/usr/bin",
      VSCODE_PUBLISH: "false",
    },
  });

  const source = await readFile(BUILD_PATH, "utf8");
  assert.doesNotMatch(source, /run\(["']npm["'],\s*\[["']run["'],\s*["']gulp["']/);
  const sdkDestinationPreflight = source.indexOf("assertSafeFileDestination(plan.tarball");
  assert.notEqual(sdkDestinationPreflight, -1);
  assert.ok(
    sdkDestinationPreflight < source.indexOf("await run(process.execPath"),
    "the SDK tarball destination must be checked before package.ts runs",
  );
});

test("Linux agent builder accepts only a verified Chatero materialization", async () => {
  const { assertVerifiedCheckout } = await import(BUILD_PATH);
  const calls = [];

  const report = await assertVerifiedCheckout("/srv/code-oss", {
    verify: async input => {
      calls.push(input);
      return { ok: true, destination: "/srv/code-oss", commit: CODE_OSS_COMMIT };
    },
  });

  assert.equal(report.ok, true);
  assert.deepEqual(calls, [{ destination: "/srv/code-oss" }]);
  await assert.rejects(
    assertVerifiedCheckout("/srv/code-oss", {
      verify: async () => ({ ok: true, destination: "/srv/other", commit: CODE_OSS_COMMIT }),
    }),
    /verified checkout destination/
  );

  const source = await readFile(BUILD_PATH, "utf8");
  assert.match(source, /verifyCodeOss/);
  assert.doesNotMatch(source, /status["'],\s*["']--porcelain/);
});

test("Linux agent builder selects only the pinned REH targets and Chatero output roots", async () => {
  const planProgram = [
    `import { makeBuildPlan } from ${JSON.stringify(pathToFileURL(BUILD_PATH).href)};`,
    "process.stdout.write(JSON.stringify([",
    "makeBuildPlan({arch:'x64',checkout:'/srv/code-oss',output:'/out/x64.tar.gz'}),",
    "makeBuildPlan({arch:'arm64',checkout:'/srv/code-oss',output:'/out/arm64.tar.gz'})",
    "]));",
  ].join(" ");
  const result = await run(process.execPath, ["--input-type=module", "-e", planProgram]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    {
      target: "vscode-reh-linux-x64-min-ci",
      upstreamRoot: "/srv/vscode-reh-linux-x64",
      rootName: "chatero-agent-linux-x86_64",
      output: "/out/x64.tar.gz",
    },
    {
      target: "vscode-reh-linux-arm64-min-ci",
      upstreamRoot: "/srv/vscode-reh-linux-arm64",
      rootName: "chatero-agent-linux-aarch64",
      output: "/out/arm64.tar.gz",
    },
  ]);
});

test("Linux agent builder embeds the exact architecture-matched Codex SDK", async () => {
  const { makeCodexSdkPlan } = await import(BUILD_PATH);

  assert.deepEqual(makeCodexSdkPlan({
    arch: "x64",
    checkout: "/srv/code-oss",
    root: "/tmp/chatero-agent-linux-x86_64",
  }), {
    version: "0.142.0",
    target: "linux-x64",
    nativePackage: "@openai/codex-linux-x64",
    nativeTriple: "x86_64-unknown-linux-musl",
    packageScript: "/srv/code-oss/build/agent-sdk/package.ts",
    tarball: "/srv/code-oss/.build/agent-sdk/chatero/codex-0.142.0-linux-x64.tgz",
    destination: "/tmp/chatero-agent-linux-x86_64/agent-sdk/codex",
  });
  assert.deepEqual(makeCodexSdkPlan({
    arch: "arm64",
    checkout: "/srv/code-oss",
    root: "/tmp/chatero-agent-linux-aarch64",
  }), {
    version: "0.142.0",
    target: "linux-arm64",
    nativePackage: "@openai/codex-linux-arm64",
    nativeTriple: "aarch64-unknown-linux-musl",
    packageScript: "/srv/code-oss/build/agent-sdk/package.ts",
    tarball: "/srv/code-oss/.build/agent-sdk/chatero/codex-0.142.0-linux-arm64.tgz",
    destination: "/tmp/chatero-agent-linux-aarch64/agent-sdk/codex",
  });
});

test("Linux agent builder requires Code-OSS, Codex, and bundled ripgrep notices", async () => {
  const { REMOTE_AGENT_NOTICE_FILES } = await import(BUILD_PATH);

  assert.deepEqual(REMOTE_AGENT_NOTICE_FILES, [
    "LICENSE.txt",
    "ThirdPartyNotices.txt",
    "licenses/OpenAI-Codex-Apache-2.0.txt",
    "licenses/OpenAI-Codex-NOTICE.txt",
    "licenses/ripgrep-MIT.txt",
    "licenses/ripgrep-UNLICENSE.txt",
  ]);
  for (const [name, digest] of Object.entries({
    "OpenAI-Codex-Apache-2.0.txt": "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc",
    "OpenAI-Codex-NOTICE.txt": "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915",
    "ripgrep-MIT.txt": "0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f",
    "ripgrep-UNLICENSE.txt": "7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c",
  })) {
    const bytes = await readFile(new URL(`../remote-agent/licenses/${name}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
  }
});
