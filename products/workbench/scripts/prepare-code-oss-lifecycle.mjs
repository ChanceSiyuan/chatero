#!/usr/bin/env node

import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SENTINEL = "foundry-local-sdk-winml";

async function assertCheckout(value) {
  const checkout = resolve(value);
  const metadata = await lstat(checkout);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(checkout) !== checkout) {
    throw new Error("Code-OSS lifecycle checkout must be a real directory");
  }
  const product = JSON.parse(await readFile(resolve(checkout, "product.json"), "utf8"));
  if (product.nameShort !== "Chatero" || product.nameLong !== "Chatero Research Workbench"
      || product.applicationName !== "chatero") {
    throw new Error("Code-OSS lifecycle checkout identity is invalid");
  }
  return checkout;
}

export async function manageFoundryLifecycleSentinel({ checkout, mode } = {}) {
  const root = await assertCheckout(checkout);
  const nodeModules = resolve(root, "node_modules");
  if (!nodeModules.startsWith(`${root}/`)) throw new Error("Code-OSS node_modules escaped its checkout");
  const sentinel = resolve(nodeModules, SENTINEL);
  if (resolve(sentinel, "..") !== nodeModules) throw new Error("Foundry lifecycle sentinel escaped node_modules");
  if (mode === "prepare") {
    const existing = await lstat(sentinel).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (existing) throw new Error("Foundry lifecycle sentinel already exists");
    await mkdir(sentinel, { mode: 0o755 });
    await writeFile(resolve(sentinel, "package.json"), JSON.stringify({
      name: SENTINEL,
      private: true,
      version: "0.0.0-chatero-lifecycle-sentinel",
    }), { flag: "wx", mode: 0o644 });
    return Object.freeze({ kind: "prepared" });
  }
  if (mode === "cleanup") {
    const existing = await lstat(sentinel).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!existing) return Object.freeze({ kind: "already-clean" });
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Foundry lifecycle sentinel is unsafe");
    const manifest = JSON.parse(await readFile(resolve(sentinel, "package.json"), "utf8"));
    if (manifest.name !== SENTINEL || manifest.version !== "0.0.0-chatero-lifecycle-sentinel") {
      throw new Error("Refusing to remove a non-Chatero Foundry package");
    }
    await rm(sentinel, { recursive: true });
    return Object.freeze({ kind: "cleaned" });
  }
  throw new TypeError("lifecycle mode must equal prepare or cleanup");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [checkout, flag] = process.argv.slice(2);
  manageFoundryLifecycleSentinel({ checkout, mode: flag?.replace(/^--/u, "") }).then(
    result => process.stdout.write(`${JSON.stringify(result)}\n`),
    error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; },
  );
}
