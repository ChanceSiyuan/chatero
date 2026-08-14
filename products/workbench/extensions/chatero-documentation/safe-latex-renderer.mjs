import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { buildSafeLatexSandbox } from "./safe-latex-sandbox.mjs";

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_LOG_EXCERPT_CHARS = 2048;
const MAX_PROJECT_FILES = 512;
const MAX_PROJECT_BYTES = 128 * 1024 * 1024;
const MAX_PDF_BYTES = 192 * 1024 * 1024;
// A leading hyphen would be parsed by latexmk as an option rather than the
// document to build.
const ENTRY_BASENAME = /^[A-Za-z0-9._ ][A-Za-z0-9._ -]*\.tex$/u;
// latexmk reads `latexmkrc` from the working directory and evaluates it as
// Perl, which is arbitrary code execution from a document-supplied file --
// `-no-shell-escape` never covered that path. `-norc` suppresses it, including
// the system rc files reachable through the sandbox's read-only /usr.
const RC_BASENAMES = new Set(["latexmkrc", ".latexmkrc"]);
const COMPILE_TIMEOUT_MS = 180_000;

export function buildSafeLatexInvocation({ snapshot, runtime } = {}) {
  if (!snapshot || !runtime || resolve(snapshot.disposableRoot) !== snapshot.disposableRoot
      || resolve(runtime.latexExecutable) !== runtime.latexExecutable
      || !ENTRY_BASENAME.test(snapshot.entryBasename)) {
    throw new TypeError("safe LaTeX invocation inputs are invalid");
  }
  return Object.freeze({
    file: runtime.latexExecutable,
    args: Object.freeze([
      "-norc",
      "-pdf",
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-no-shell-escape",
      "-outdir=../output",
      snapshot.entryBasename,
    ]),
    cwd: join(snapshot.disposableRoot, "source"),
    shell: false,
  });
}

// A document can loop forever (\def\x{\x}\x) without ever erroring, so
// -halt-on-error does not bound the run: the compile is killed on a deadline
// and when the session goes away, and bubblewrap's --die-with-parent reaps
// anything the engine spawned.
function runProcess(invocation, { signal, timeoutMs = COMPILE_TIMEOUT_MS } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(invocation.file, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let timedOut = false;
    const stop = () => {
      if (settled || child.killed) return;
      child.kill("SIGKILL");
    };
    const onAbort = () => stop();
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener?.("abort", onAbort, { once: true });
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
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    child.once("error", error => { finish(); reject(error); });
    child.once("close", (code, closeSignal) => {
      finish();
      accept({
        code: Number.isInteger(code) ? code : 1,
        signal: closeSignal,
        stderr: timedOut
          ? `LaTeX compile exceeded ${Math.round(timeoutMs / 1000)}s and was stopped`
          : `${Buffer.concat(chunks).toString("utf8")} ${closeSignal ? `signal=${closeSignal}` : `exit=${code}`}`.trim(),
      });
    });
  });
}

// Bounded copy of the note's directory so \input, bibliographies, and figures
// resolve like an Overleaf project. Dotfiles are skipped; symbolic links are
// refused rather than followed so the snapshot can never reach outside the
// project directory.
async function copyProjectDirectory(sourceDirectory, destination, budget) {
  await mkdir(destination, { mode: 0o700, recursive: true });
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || RC_BASENAMES.has(entry.name.toLowerCase())) continue;
    const from = join(sourceDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("LaTeX project contains a symbolic link");
    if (entry.isDirectory()) {
      await copyProjectDirectory(from, join(destination, entry.name), budget);
      continue;
    }
    if (!entry.isFile()) throw new Error("LaTeX project contains an unsupported entry");
    const metadata = await lstat(from);
    budget.files += 1;
    budget.bytes += metadata.size;
    if (budget.files > MAX_PROJECT_FILES || budget.bytes > MAX_PROJECT_BYTES) {
      throw new Error("LaTeX project exceeds product limits");
    }
    await copyFile(from, join(destination, entry.name));
  }
}

async function validatePdfOutput(outputRoot, entryStem) {
  const pdfPath = join(outputRoot, `${entryStem}.pdf`);
  const metadata = await lstat(pdfPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 5 || metadata.size > MAX_PDF_BYTES) {
    throw new Error("LaTeX output has no valid PDF");
  }
  const head = Buffer.alloc(5);
  const handle = await import("node:fs/promises").then(({ open }) => open(pdfPath, "r"));
  try { await handle.read(head, 0, 5, 0); }
  finally { await handle.close(); }
  if (head.toString("latin1") !== "%PDF-") throw new Error("LaTeX output has no valid PDF");
  return Object.freeze({ bytes: metadata.size, pdfPath });
}

async function logExcerpt(outputRoot, entryStem) {
  try {
    const log = await readFile(join(outputRoot, `${entryStem}.log`), "utf8");
    const lines = log.split("\n");
    const errors = lines.filter(line => line.startsWith("!")).slice(0, 12);
    const tail = lines.slice(-8);
    return [...errors, ...tail].join(" ").replace(/[\r\t]+/gu, " ").slice(0, MAX_LOG_EXCERPT_CHARS);
  }
  catch { return ""; }
}

function diagnostic(error, excerpt) {
  const base = String(error?.stderr || error?.message || error || "LaTeX compile failed")
    .replace(/[\r\n\t]+/gu, " ");
  return `${excerpt ? `${excerpt} ` : ""}${base}`.trim().slice(0, MAX_LOG_EXCERPT_CHARS);
}

export class SafeLatexRenderer {
  constructor({ runtime, sandboxFactory = buildSafeLatexSandbox, run = runProcess, temporaryDirectory = tmpdir() } = {}) {
    if (!runtime || typeof runtime.latexExecutable !== "string" || resolve(runtime.latexExecutable) !== runtime.latexExecutable
      || !Array.isArray(runtime.runtimeRoots) || runtime.runtimeRoots.length === 0
      || typeof sandboxFactory !== "function" || typeof run !== "function") {
      throw new TypeError("Safe LaTeX renderer dependencies are invalid");
    }
    this.runtime = Object.freeze({ ...runtime, runtimeRoots: Object.freeze([...runtime.runtimeRoots]) });
    this.sandboxFactory = sandboxFactory;
    this.run = run;
    this.temporaryDirectory = temporaryDirectory;
    this.lastGood = undefined;
    this.roots = new Set();
    this.disposed = false;
  }

  async render({ signal, sourcePath, source, version } = {}) {
    if (this.disposed) throw new Error("Safe LaTeX renderer is disposed");
    if (typeof sourcePath !== "string" || resolve(sourcePath) !== sourcePath || extname(sourcePath).toLowerCase() !== ".tex"
      || typeof source !== "string" || !Number.isSafeInteger(version) || version < 0) {
      throw new TypeError("Safe LaTeX render request is invalid");
    }
    const entryBasename = basename(sourcePath);
    if (!ENTRY_BASENAME.test(entryBasename)) {
      return Object.freeze({ kind: "unsafe-input", reason: "entry-filename", lastGood: this.lastGood });
    }
    const canonical = await realpath(sourcePath);
    const sourceMetadata = await lstat(canonical);
    // The editor buffer and the file on disk are compared after normalizing a
    // byte-order mark and line endings, which the editor may represent
    // differently from the bytes it wrote.
    const normalize = value => value.replace(/^﻿/u, "").replace(/\r\n?/gu, "\n");
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()
        || normalize(await readFile(canonical, "utf8")) !== normalize(source)) {
      return Object.freeze({ kind: "unsaved-input", lastGood: this.lastGood });
    }
    const root = await realpath(await mkdtemp(join(this.temporaryDirectory, "chatero-latex-")));
    this.roots.add(root);
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    const privateTemp = join(root, "tmp");
    try {
      await copyProjectDirectory(dirname(canonical), sourceRoot, { bytes: 0, files: 0 });
      await Promise.all([
        mkdir(outputRoot, { mode: 0o700 }),
        mkdir(privateTemp, { mode: 0o700 }),
      ]);
    }
    catch (error) {
      await rm(root, { recursive: true, force: true });
      this.roots.delete(root);
      return Object.freeze({ kind: "unsafe-input", reason: diagnostic(error, ""), lastGood: this.lastGood });
    }
    const invocation = buildSafeLatexInvocation({
      snapshot: { disposableRoot: root, entryBasename },
      runtime: this.runtime,
    });
    const sandbox = this.sandboxFactory({
      invocation,
      runtimeRoots: this.runtime.runtimeRoots,
      snapshotRoot: root,
      temporaryRoot: privateTemp,
    });
    if (sandbox.kind === "preview-unavailable") {
      await rm(root, { recursive: true, force: true });
      this.roots.delete(root);
      return Object.freeze({ ...sandbox, lastGood: this.lastGood });
    }
    const entryStem = entryBasename.slice(0, -".tex".length);
    try {
      const result = await this.run(sandbox, { signal });
      if (result.code !== 0 || result.signal) {
        throw Object.assign(new Error("LaTeX compile failed"), {
          stderr: result.stderr,
          excerpt: await logExcerpt(outputRoot, entryStem),
        });
      }
      const manifest = await validatePdfOutput(outputRoot, entryStem);
      this.lastGood = Object.freeze({ ...manifest, root, sourceVersion: version, renderId: randomUUID() });
      return Object.freeze({ kind: "rendered", ...this.lastGood });
    }
    catch (error) {
      const excerpt = error?.excerpt ?? await logExcerpt(outputRoot, entryStem);
      await rm(root, { recursive: true, force: true });
      this.roots.delete(root);
      return Object.freeze({
        kind: this.lastGood ? "failed-with-last-good" : "failed",
        diagnostic: diagnostic(error, excerpt),
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
    if (typeof root !== "string" || resolve(root) !== root || !this.roots.has(root)) {
      throw new TypeError("Safe LaTeX retained output root is invalid");
    }
    await Promise.all([...this.roots].filter(value => value !== root).map(value => rm(value, { recursive: true, force: true })));
    this.roots = new Set([root]);
  }
}
