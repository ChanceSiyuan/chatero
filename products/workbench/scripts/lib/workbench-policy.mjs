import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

const SCANNED_EXTENSIONS = new Set([".cjs", ".js", ".json", ".mjs", ".patch", ".sh", ".ts"]);
const MAX_SCANNED_FILE_BYTES = 4 * 1024 * 1024;
const FORBIDDEN_HOST = /https?:\/\/(?:[a-z0-9-]+\.)*gallerycdn\.vsassets\.io\b|https?:\/\/marketplace\.visualstudio\.com\b/gi;
const FORBIDDEN_EXTENSION = /\b(?:ms-python\.vscode-pylance|ms-vscode-remote\.remote-ssh)\b/g;

function displayPath(root, path) {
  const value = relative(root, path);
  return value.split(sep).join("/");
}

function excerpt(line) {
  return line.trim().slice(0, 160);
}

async function collectPolicyFiles(root, path, files, violations) {
  let metadata;
  try {
    metadata = await lstat(path);
  }
  catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const relativePath = displayPath(root, path);
  if (metadata.isSymbolicLink()) {
    violations.push({
      rule: "unsafe-symlink",
      path: relativePath,
      line: 1,
      excerpt: "symbolic links are not scanned",
    });
    return;
  }
  if (metadata.isDirectory()) {
    const entries = await readdir(path);
    for (const entry of entries.sort()) {
      await collectPolicyFiles(root, join(path, entry), files, violations);
    }
    return;
  }
  if (!metadata.isFile() || !SCANNED_EXTENSIONS.has(extname(path))) {
    return;
  }
  if (metadata.size > MAX_SCANNED_FILE_BYTES) {
    violations.push({
      rule: "oversized-policy-file",
      path: relativePath,
      line: 1,
      excerpt: `file exceeds ${MAX_SCANNED_FILE_BYTES} bytes`,
    });
    return;
  }
  files.push(path);
}

function scanText(root, path, text, violations) {
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    FORBIDDEN_HOST.lastIndex = 0;
    if (FORBIDDEN_HOST.test(line)) {
      violations.push({
        rule: "forbidden-host",
        path: displayPath(root, path),
        line: index + 1,
        excerpt: excerpt(line),
      });
    }
    FORBIDDEN_EXTENSION.lastIndex = 0;
    if (FORBIDDEN_EXTENSION.test(line)) {
      violations.push({
        rule: "forbidden-extension",
        path: displayPath(root, path),
        line: index + 1,
        excerpt: excerpt(line),
      });
    }
  }
}

function parseTemplateURL(value) {
  return new URL(
    value
      .replaceAll("{publisher}", "publisher")
      .replaceAll("{name}", "name")
      .replaceAll("{version}", "version")
  );
}

function verifyGallery(root, productPath, text, violations) {
  let product;
  try {
    product = JSON.parse(text);
  }
  catch (error) {
    violations.push({
      rule: "invalid-product-json",
      path: displayPath(root, productPath),
      line: 1,
      excerpt: error.message.slice(0, 160),
    });
    return;
  }
  const gallery = product?.extensionsGallery;
  for (const field of ["serviceUrl", "itemUrl", "resourceUrlTemplate"]) {
    const value = gallery?.[field];
    let valid = false;
    try {
      const url = parseTemplateURL(value);
      valid = url.protocol === "https:" && url.hostname === "open-vsx.org";
    }
    catch {
      valid = false;
    }
    if (!valid) {
      const lines = text.split(/\r?\n/);
      const lineIndex = Math.max(0, lines.findIndex(line => line.includes(`"${field}"`)));
      violations.push({
        rule: "non-open-vsx-gallery",
        path: displayPath(root, productPath),
        line: lineIndex + 1,
        excerpt: excerpt(lines[lineIndex] ?? field),
      });
    }
  }
}

export async function verifyWorkbenchPolicy({ root, productPath }) {
  const canonicalRoot = resolve(root);
  const canonicalProductPath = resolve(productPath);
  const files = [];
  const violations = [];

  await collectPolicyFiles(
    canonicalRoot,
    join(canonicalRoot, "product.chatero.json"),
    files,
    violations
  );
  await collectPolicyFiles(
    canonicalRoot,
    join(canonicalRoot, "patches"),
    files,
    violations
  );
  if (!files.includes(canonicalProductPath)) {
    await collectPolicyFiles(canonicalRoot, canonicalProductPath, files, violations);
  }

  let productText = null;
  for (const path of files) {
    const text = await readFile(path, "utf8");
    scanText(canonicalRoot, path, text, violations);
    if (path === canonicalProductPath) {
      productText = text;
    }
  }
  if (productText === null) {
    violations.push({
      rule: "missing-product",
      path: displayPath(canonicalRoot, canonicalProductPath),
      line: 1,
      excerpt: "generated product configuration is missing",
    });
  }
  else {
    verifyGallery(canonicalRoot, canonicalProductPath, productText, violations);
  }

  violations.sort((left, right) => (
    left.path.localeCompare(right.path)
    || left.line - right.line
    || left.rule.localeCompare(right.rule)
  ));
  return {
    ok: violations.length === 0,
    scannedFiles: files.length,
    violations,
  };
}
