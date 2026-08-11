import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const STAGE_PATH = fileURLToPath(new URL(
  "../remote-agent/scripts/stage-release.mjs",
  import.meta.url
));
const BUILD_PATH = fileURLToPath(new URL(
  "../remote-agent/scripts/build-linux-agent.mjs",
  import.meta.url
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

test("artifact selection requires the pinned commit and a supported tuple", async () => {
  const signed = await signedFixture();
  const manifest = await verifyRelease(signed);

  assert.equal(
    selectArtifact(manifest, {
      commit: CODE_OSS_COMMIT,
      tuple: "linux-aarch64",
    }).filename,
    "chatero-agent-linux-aarch64.tar.gz"
  );
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

test("release staging injects the bridge and signs the final archive bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatero-stage-release-"));
  temporaryDirectories.push(directory);
  const inputs = join(directory, "inputs");
  const output = join(directory, "output");
  await mkdir(inputs);
  const archives = {};
  for (const [arch, tuple] of [["x64", "linux-x86_64"], ["arm64", "linux-aarch64"]]) {
    const root = `chatero-agent-${tuple}`;
    const source = join(directory, `${arch}-source`);
    await mkdir(join(source, root, "bin"), { recursive: true });
    await writeFile(join(source, root, "bin", "chatero-server"), `${tuple}\n`, "utf8");
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
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "chatero-server"), `${tuple}\n`, "utf8");
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

test("Linux agent builder rejects tracked and untracked checkout changes but allows ignored output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chatero-builder-checkout-"));
  temporaryDirectories.push(directory);
  const checkout = join(directory, "code-oss");
  await mkdir(checkout);
  for (const args of [
    ["init", "--quiet", checkout],
    ["-C", checkout, "config", "user.name", "Chatero Test"],
    ["-C", checkout, "config", "user.email", "chatero@example.invalid"],
  ]) {
    const result = await run("git", args);
    assert.equal(result.code, 0, result.stderr);
  }
  await writeFile(join(checkout, ".gitignore"), "generated/\n", "utf8");
  await writeFile(join(checkout, "tracked.txt"), "clean\n", "utf8");
  let result = await run("git", ["-C", checkout, "add", "."]);
  assert.equal(result.code, 0, result.stderr);
  result = await run("git", [
    "-C", checkout,
    "-c", "commit.gpgSign=false",
    "commit", "--quiet", "-m", "fixture",
  ]);
  assert.equal(result.code, 0, result.stderr);
  await mkdir(join(checkout, "generated"));
  await writeFile(join(checkout, "generated", "bundle"), "ignored\n", "utf8");

  const validationProgram = [
    `import { assertCleanCheckout } from ${JSON.stringify(pathToFileURL(BUILD_PATH).href)};`,
    "await assertCleanCheckout(process.argv[1]);",
  ].join(" ");
  const clean = await run(process.execPath, [
    "--input-type=module", "-e", validationProgram, checkout,
  ]);
  assert.equal(clean.code, 0, clean.stderr);

  await writeFile(join(checkout, "tracked.txt"), "dirty\n", "utf8");
  const tracked = await run(process.execPath, [
    "--input-type=module", "-e", validationProgram, checkout,
  ]);
  assert.equal(tracked.code, 1);
  assert.match(tracked.stderr, /dirty.*tracked\.txt/s);

  await writeFile(join(checkout, "tracked.txt"), "clean\n", "utf8");
  await writeFile(join(checkout, "untracked.txt"), "dirty\n", "utf8");
  const untracked = await run(process.execPath, [
    "--input-type=module", "-e", validationProgram, checkout,
  ]);
  assert.equal(untracked.code, 1);
  assert.match(untracked.stderr, /dirty.*untracked\.txt/s);
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
