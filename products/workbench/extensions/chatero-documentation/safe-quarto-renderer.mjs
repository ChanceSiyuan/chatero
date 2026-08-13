import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { validatePassiveQuartoInput } from "./quarto-input-policy.mjs";
import { buildSafeQuartoSandbox } from "./safe-quarto-sandbox.mjs";

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_OUTPUT_FILES = 4096;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

export function buildSafeQuartoInvocation({ snapshot, runtime, output } = {}) {
  if (!snapshot || !runtime || !output || resolve(snapshot.disposableRoot) !== snapshot.disposableRoot
      || resolve(runtime.quartoExecutable) !== runtime.quartoExecutable
      || !/^[A-Za-z0-9._ -]+\.qmd$/u.test(snapshot.entryBasename)
      || !/^\.\/[A-Za-z0-9._/-]+$/u.test(output.relativePath)) {
    throw new TypeError("safe Quarto invocation inputs are invalid");
  }
  return Object.freeze({
    file: runtime.quartoExecutable,
    args: Object.freeze(["render", `./source/${snapshot.entryBasename}`, "--no-execute", "--output-dir", output.relativePath]),
    cwd: snapshot.disposableRoot,
    shell: false,
  });
}

function runProcess(invocation) {
  return new Promise((accept, reject) => {
    const child = spawn(invocation.file, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks = [];
    let bytes = 0;
    const capture = chunk => {
      if (bytes >= MAX_DIAGNOSTIC_BYTES) return;
      const kept = Buffer.from(chunk).subarray(0, MAX_DIAGNOSTIC_BYTES - bytes);
      chunks.push(kept);
      bytes += kept.byteLength;
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", reject);
    child.once("close", (code, signal) => accept({
      code: Number.isInteger(code) ? code : 1,
      signal,
      stderr: `${Buffer.concat(chunks).toString("utf8")} ${signal ? `signal=${signal}` : `exit=${code}`}`.trim(),
    }));
  });
}

async function validateOutput(root, entryRelativePath = "source/index.html") {
  let files = 0;
  let bytes = 0;
  async function visit(path) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error("Quarto output contains a symbolic link");
    if (metadata.isFile()) {
      files += 1;
      bytes += metadata.size;
      if (files > MAX_OUTPUT_FILES || bytes > MAX_OUTPUT_BYTES) throw new Error("Quarto output exceeds product limits");
      return;
    }
    if (!metadata.isDirectory()) throw new Error("Quarto output contains an unsupported entry");
    for (const entry of await readdir(path)) await visit(join(path, entry));
  }
  await visit(root);
  const entryPath = join(root, entryRelativePath);
  const entry = await lstat(entryPath);
  if (!entry.isFile() || entry.isSymbolicLink() || !/^\s*<!doctype html|^\s*<html/iu.test(await readFile(entryPath, "utf8"))) {
    throw new Error("Quarto output has no valid index.html");
  }
  return Object.freeze({ bytes, entryPath, files, root });
}

function diagnostic(error) {
  return String(error?.stderr || error?.message || error || "Quarto render failed")
    .replace(/[\r\n\t]+/gu, " ").slice(0, 1024);
}

export class SafeQuartoRenderer {
  constructor({ runtime, sandboxFactory = buildSafeQuartoSandbox, run = runProcess, temporaryDirectory = tmpdir() } = {}) {
    if (!runtime || typeof runtime.quartoExecutable !== "string" || resolve(runtime.quartoExecutable) !== runtime.quartoExecutable
      || typeof runtime.runtimeRoot !== "string" || resolve(runtime.runtimeRoot) !== runtime.runtimeRoot
      || typeof sandboxFactory !== "function" || typeof run !== "function") {
      throw new TypeError("Safe Quarto renderer dependencies are invalid");
    }
    this.runtime = Object.freeze({ ...runtime });
    this.sandboxFactory = sandboxFactory;
    this.run = run;
    this.temporaryDirectory = temporaryDirectory;
    this.lastGood = undefined;
    this.roots = new Set();
    this.disposed = false;
  }

  async render({ sourcePath, source, version } = {}) {
    if (this.disposed) throw new Error("Safe Quarto renderer is disposed");
    if (typeof sourcePath !== "string" || resolve(sourcePath) !== sourcePath || extname(sourcePath).toLowerCase() !== ".qmd"
      || typeof source !== "string" || !Number.isSafeInteger(version) || version < 0) {
      throw new TypeError("Safe Quarto render request is invalid");
    }
    const policy = validatePassiveQuartoInput(source);
    if (policy.kind !== "passive-input") return Object.freeze({ kind: "unsafe-input", reason: policy.reason, lastGood: this.lastGood });
    const canonical = await realpath(sourcePath);
    const sourceMetadata = await lstat(canonical);
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink() || await readFile(canonical, "utf8") !== source) {
      return Object.freeze({ kind: "unsaved-input", lastGood: this.lastGood });
    }
    const root = await realpath(await mkdtemp(join(this.temporaryDirectory, "chatero-quarto-")));
    this.roots.add(root);
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    const privateTemp = join(root, "tmp");
    await Promise.all([
      mkdir(sourceRoot, { mode: 0o700 }),
      mkdir(outputRoot, { mode: 0o700 }),
      mkdir(privateTemp, { mode: 0o700 }),
      mkdir(join(root, ".quarto"), { mode: 0o700 }),
    ]);
    const entryBasename = "index.qmd";
    await Promise.all([
      writeFile(join(sourceRoot, entryBasename), source, { flag: "wx", mode: 0o600 }),
      writeFile(join(root, "_quarto.yml"), "project:\n  type: default\nexecute:\n  enabled: false\nformat:\n  html:\n    embed-resources: true\n", { flag: "wx", mode: 0o600 }),
    ]);
    const invocation = buildSafeQuartoInvocation({
      snapshot: { disposableRoot: root, entryBasename },
      runtime: this.runtime,
      output: { relativePath: "./output" },
    });
    const sandbox = this.sandboxFactory({
      invocation,
      outputRoot,
      runtimeRoot: this.runtime.runtimeRoot,
      snapshotRoot: root,
      temporaryRoot: privateTemp,
    });
    if (sandbox.kind === "preview-unavailable") {
      await rm(root, { recursive: true, force: true });
      this.roots.delete(root);
      return Object.freeze({ ...sandbox, lastGood: this.lastGood });
    }
    try {
      const result = await this.run(sandbox);
      if (result.code !== 0 || result.signal) throw Object.assign(new Error("Quarto render failed"), { stderr: result.stderr });
      const manifest = await validateOutput(outputRoot);
      this.lastGood = Object.freeze({ ...manifest, sourceVersion: version, renderId: randomUUID() });
      return Object.freeze({ kind: "rendered", ...this.lastGood });
    }
    catch (error) {
      await rm(root, { recursive: true, force: true });
      this.roots.delete(root);
      return Object.freeze({
        kind: this.lastGood ? "failed-with-last-good" : "failed",
        diagnostic: diagnostic(error),
        ...(this.lastGood ? { lastGood: this.lastGood } : {}),
      });
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.roots].map(root => rm(root, { recursive: true, force: true })));
    this.roots.clear();
    this.lastGood = undefined;
  }

  async releaseExcept(root) {
    if (typeof root !== "string" || resolve(root) !== root || !this.roots.has(dirname(root))) {
      throw new TypeError("Safe Quarto retained output root is invalid");
    }
    const retained = dirname(root);
    await Promise.all([...this.roots].filter(value => value !== retained).map(value => rm(value, { recursive: true, force: true })));
    this.roots = new Set([retained]);
  }
}
