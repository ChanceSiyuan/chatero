#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "acorn";
import * as esbuild from "esbuild";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIRECTORY, "..", "..", "..");
const DEFAULT_OUTDIR = join(DEFAULT_ROOT, "products", "workbench", ".cache", "documentation-webview");
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const KATEX_WOFF2_FILES = Object.freeze([
  "KaTeX_AMS-Regular.woff2",
  "KaTeX_Caligraphic-Bold.woff2",
  "KaTeX_Caligraphic-Regular.woff2",
  "KaTeX_Fraktur-Bold.woff2",
  "KaTeX_Fraktur-Regular.woff2",
  "KaTeX_Main-Bold.woff2",
  "KaTeX_Main-BoldItalic.woff2",
  "KaTeX_Main-Italic.woff2",
  "KaTeX_Main-Regular.woff2",
  "KaTeX_Math-BoldItalic.woff2",
  "KaTeX_Math-Italic.woff2",
  "KaTeX_SansSerif-Bold.woff2",
  "KaTeX_SansSerif-Italic.woff2",
  "KaTeX_SansSerif-Regular.woff2",
  "KaTeX_Script-Regular.woff2",
  "KaTeX_Size1-Regular.woff2",
  "KaTeX_Size2-Regular.woff2",
  "KaTeX_Size3-Regular.woff2",
  "KaTeX_Size4-Regular.woff2",
  "KaTeX_Typewriter-Regular.woff2",
]);

export const DOCUMENTATION_WEBVIEW_OUTPUTS = Object.freeze([
  "live-preview.css",
  "live-preview.js",
  ...KATEX_WOFF2_FILES.map(name => `fonts/${name}`),
]);

export const XML_NAMESPACE_URLS = Object.freeze([
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/XML/1998/namespace",
]);

const XML_NAMESPACE_URL_SET = new Set(XML_NAMESPACE_URLS);
const ESBUILD_OPTIONS = Object.freeze({
  bundle: true,
  platform: "browser",
  format: "iife",
  target: Object.freeze(["chrome142"]),
  charset: "utf8",
  legalComments: "none",
  minify: true,
  sourcemap: false,
  metafile: true,
});
const NETWORK_IDENTIFIERS = new Set([
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Worker",
  "SharedWorker",
]);
const FORBIDDEN_ENDPOINTS = Object.freeze([
  "marketplace.visualstudio.com",
  "update.code.visualstudio.com",
  "marketplacecdn.vsassets.io",
]);

function staticPropertyName(node) {
  if (!node) return undefined;
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  if (node.computed && node.property?.type === "Literal" && typeof node.property.value === "string") {
    return node.property.value;
  }
  return undefined;
}

function calleeContainsIdentifier(node, name) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "Identifier" && node.name === name) return true;
  if (node.type === "MemberExpression") {
    return calleeContainsIdentifier(node.object, name)
      || (!node.computed && node.property?.type === "Identifier" && node.property.name === name)
      || (node.computed && node.property?.type === "Literal" && node.property.value === name);
  }
  if (node.type === "SequenceExpression") {
    return node.expressions.some(expression => calleeContainsIdentifier(expression, name));
  }
  if (node.type === "ChainExpression") return calleeContainsIdentifier(node.expression, name);
  return false;
}

function isGlobalCallable(node, name) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "Identifier") return node.name === name;
  if (node.type === "MemberExpression") {
    const owner = node.object?.type === "Identifier" ? node.object.name : undefined;
    return ["globalThis", "window", "self"].includes(owner) && staticPropertyName(node) === name;
  }
  if (node.type === "SequenceExpression") return node.expressions.some(value => isGlobalCallable(value, name));
  if (node.type === "ChainExpression") return isGlobalCallable(node.expression, name);
  return false;
}

function literalStrings(node) {
  if (node.type === "Literal" && typeof node.value === "string") return [node.value];
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return [node.quasis.map(quasi => quasi.value.cooked ?? quasi.value.raw).join("")];
  }
  return [];
}

function visitAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "range") continue;
    if (Array.isArray(value)) {
      for (const child of value) visitAst(child, visit);
    }
    else if (value && typeof value === "object") {
      visitAst(value, visit);
    }
  }
}

export function auditDocumentationJavaScript(source) {
  if (typeof source !== "string") throw new TypeError("Documentation JavaScript must be a string");
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowHashBang: true,
  });
  const urlLiterals = [];

  visitAst(ast, node => {
    if (node.type === "ImportExpression") {
      throw new Error("dynamic import is forbidden in the Documentation webview");
    }
    if (node.type === "Identifier" && NETWORK_IDENTIFIERS.has(node.name)) {
      throw new Error(`${node.name} network access is forbidden in the Documentation webview`);
    }
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      if (calleeContainsIdentifier(node.callee, "eval") || calleeContainsIdentifier(node.callee, "Function")) {
        throw new Error("dynamic code execution is forbidden in the Documentation webview");
      }
      if (isGlobalCallable(node.callee, "fetch")
        || isGlobalCallable(node.callee, "importScripts")
        || staticPropertyName(node.callee) === "sendBeacon"
        || staticPropertyName(node.callee) === "open" && calleeContainsIdentifier(node.callee, "XMLHttpRequest")) {
        throw new Error("network API use is forbidden in the Documentation webview");
      }
      if (node.type === "CallExpression"
        && staticPropertyName(node.callee) === "createElement"
        && node.arguments[0]?.type === "Literal"
        && ["script", "link", "iframe"].includes(String(node.arguments[0].value).toLowerCase())) {
        throw new Error("dynamic remote loader elements are forbidden in the Documentation webview");
      }
    }
    for (const value of literalStrings(node)) {
      const lower = value.toLowerCase();
      if (FORBIDDEN_ENDPOINTS.some(endpoint => lower.includes(endpoint))) {
        throw new Error("a forbidden Microsoft endpoint is present in the Documentation webview");
      }
      if (/^https?:/i.test(value)) {
        if (!XML_NAMESPACE_URL_SET.has(value)) {
          throw new Error(`URL literal is forbidden in the Documentation webview: ${value}`);
        }
        urlLiterals.push(value);
      }
    }
  });

  return Object.freeze({ urlLiterals: Object.freeze(urlLiterals) });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function woff2OnlyKatexCss(source) {
  if (typeof source !== "string") throw new TypeError("KaTeX stylesheet must be a string");
  let declarations = 0;
  const css = source.replace(
    /src:url\((fonts\/[A-Za-z0-9_-]+\.woff2)\) format\("woff2"\),url\(fonts\/[A-Za-z0-9_-]+\.woff\) format\("woff"\),url\(fonts\/[A-Za-z0-9_-]+\.ttf\) format\("truetype"\)/gu,
    (_match, path) => {
      declarations += 1;
      return `src:url(${path}) format("woff2")`;
    },
  );
  if (declarations !== KATEX_WOFF2_FILES.length || /\.(?:woff|ttf)\)/u.test(css) || /\bdata:/iu.test(css)) {
    throw new Error("KaTeX stylesheet font provenance is unexpected");
  }
  const referenced = [...css.matchAll(/url\(fonts\/([A-Za-z0-9_-]+\.woff2)\)/gu)].map(match => match[1]);
  if (JSON.stringify(referenced) !== JSON.stringify(KATEX_WOFF2_FILES)) {
    throw new Error("KaTeX stylesheet does not reference the exact pinned WOFF2 set");
  }
  return css;
}

export async function buildDocumentationWebview({
  root = DEFAULT_ROOT,
  outdir = join(root, "products", "workbench", ".cache", "documentation-webview"),
} = {}) {
  const entry = join(root, "products", "workbench", "extensions", "chatero-documentation", "webview", "live-preview-entry.mjs");
  const stylesheet = join(root, "products", "workbench", "extensions", "chatero-documentation", "webview", "live-preview.css");
  const katexRoot = join(root, "node_modules", "katex", "dist");
  await mkdir(outdir, { recursive: true });
  const buildResult = await esbuild.build({
    ...ESBUILD_OPTIONS,
    target: [...ESBUILD_OPTIONS.target],
    entryPoints: [entry],
    outfile: join(outdir, "live-preview.js"),
  });
  for (const output of Object.values(buildResult.metafile.outputs)) {
    if (output.imports.length !== 0) {
      throw new Error("Documentation webview bundle contains an external import");
    }
  }
  const [baseCss, katexCss] = await Promise.all([
    readFile(stylesheet, "utf8"),
    readFile(join(katexRoot, "katex.min.css"), "utf8"),
  ]);
  await writeFile(join(outdir, "live-preview.css"), `${baseCss.trimEnd()}\n\n${woff2OnlyKatexCss(katexCss)}\n`);
  await mkdir(join(outdir, "fonts"), { recursive: true });
  await Promise.all(KATEX_WOFF2_FILES.map(name => copyFile(
    join(katexRoot, "fonts", name),
    join(outdir, "fonts", name),
  )));

  const files = [];
  for (const path of DOCUMENTATION_WEBVIEW_OUTPUTS) {
    const bytes = await readFile(join(outdir, path));
    if (bytes.byteLength >= MAX_OUTPUT_BYTES) throw new Error(`Documentation webview output is too large: ${path}`);
    if (path.endsWith(".js")) auditDocumentationJavaScript(bytes.toString("utf8"));
    files.push(Object.freeze({ path, size: bytes.byteLength, sha256: sha256(bytes) }));
  }
  return Object.freeze({ files: Object.freeze(files) });
}

function isMainModule() {
  return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  buildDocumentationWebview({ root: DEFAULT_ROOT, outdir: DEFAULT_OUTDIR })
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => {
      process.stderr.write(`Documentation webview build failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
