import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

const SCANNED_EXTENSIONS = new Set([".cjs", ".js", ".json", ".mjs", ".patch", ".sh", ".ts"]);
const MAX_SCANNED_FILE_BYTES = 4 * 1024 * 1024;
const FORBIDDEN_HOST = /https?:\/\/(?:[a-z0-9-]+\.)*gallerycdn\.vsassets\.io\b|https?:\/\/marketplace\.visualstudio\.com\b/gi;
const FORBIDDEN_EXTENSION = /\b(?:github\.copilot(?:-chat)?|ms-python\.vscode-pylance|ms-vscode-remote\.remote-ssh)\b/gi;
const FORBIDDEN_AGENT_DEPENDENCIES = new Set([
  "@github/copilot",
  "@github/copilot-sdk",
  "@vscode/copilot-api",
]);
const FORBIDDEN_PACKAGING = /\b(?:compileCopilotExtensionBuildTask|prepareCopilotRipgrepShimTask|ensureCopilotPlatformPackage|getCopilotRuntimePrebuildFiles|packageCopilotExtensionStream)\b/;

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
  const unifiedPatch = extname(path) === ".patch" && /^diff --git /m.test(text);
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (unifiedPatch && (line.startsWith("-") || !line.startsWith("+"))) {
      continue;
    }
    const policyLine = unifiedPatch && line.startsWith("+")
      ? line.slice(1)
      : line;
    FORBIDDEN_HOST.lastIndex = 0;
    if (FORBIDDEN_HOST.test(policyLine)) {
      violations.push({
        rule: "forbidden-host",
        path: displayPath(root, path),
        line: index + 1,
        excerpt: excerpt(policyLine),
      });
    }
    FORBIDDEN_EXTENSION.lastIndex = 0;
    if (FORBIDDEN_EXTENSION.test(policyLine)) {
      violations.push({
        rule: "forbidden-extension",
        path: displayPath(root, path),
        line: index + 1,
        excerpt: excerpt(policyLine),
      });
    }
  }
}

async function verifyBuildScripts(root, checkout, violations) {
  if (!checkout) return;
  const packagePath = join(resolve(checkout), "package.json");
  let text;
  let pkg;
  try {
    text = await readFile(packagePath, "utf8");
    pkg = JSON.parse(text);
  }
  catch (error) {
    violations.push({
      rule: "invalid-build-package",
      path: displayPath(root, packagePath),
      line: 1,
      excerpt: error.message.slice(0, 160),
    });
    return;
  }
  const lines = text.split(/\r?\n/);
  for (const [name, command] of Object.entries(pkg?.scripts || {})) {
    if (typeof command !== "string" || !/copilot/i.test(command)) continue;
    const lineIndex = Math.max(0, lines.findIndex(line => line.includes(`"${name}"`)));
    violations.push({
      rule: "forbidden-agent-build",
      path: displayPath(root, packagePath),
      line: lineIndex + 1,
      excerpt: excerpt(lines[lineIndex] ?? `${name}: ${command}`),
    });
  }
}

async function readCheckoutFile(root, checkout, relativePath, rule, violations) {
  const path = join(resolve(checkout), relativePath);
  try {
    return { path, text: await readFile(path, "utf8") };
  }
  catch (error) {
    violations.push({
      rule,
      path: displayPath(root, path),
      line: 1,
      excerpt: error.message.slice(0, 160),
    });
    return null;
  }
}

async function verifyAgentSupplyChain(root, checkout, violations) {
  if (!checkout) return;

  const packageFile = await readCheckoutFile(
    root,
    checkout,
    "package.json",
    "invalid-build-package",
    violations
  );
  const lockFile = await readCheckoutFile(
    root,
    checkout,
    "package-lock.json",
    "invalid-build-lockfile",
    violations
  );
  const declared = new Map();
  for (const file of [packageFile, lockFile]) {
    if (!file) continue;
    let value;
    try {
      value = JSON.parse(file.text);
    }
    catch (error) {
      violations.push({
        rule: file === packageFile ? "invalid-build-package" : "invalid-build-lockfile",
        path: displayPath(root, file.path),
        line: 1,
        excerpt: error.message.slice(0, 160),
      });
      continue;
    }
    const dependencies = file === packageFile
      ? value?.dependencies
      : value?.packages?.[""]?.dependencies;
    for (const name of Object.keys(dependencies || {})) {
      if (FORBIDDEN_AGENT_DEPENDENCIES.has(name) && !declared.has(name)) {
        declared.set(name, file);
      }
    }
  }
  for (const [name, file] of declared) {
    const lines = file.text.split(/\r?\n/);
    const lineIndex = Math.max(0, lines.findIndex(line => line.includes(`"${name}"`)));
    violations.push({
      rule: "forbidden-agent-dependency",
      path: displayPath(root, file.path),
      line: lineIndex + 1,
      excerpt: excerpt(lines[lineIndex] ?? name),
    });
  }

  const dirsFile = await readCheckoutFile(
    root,
    checkout,
    join("build", "npm", "dirs.ts"),
    "missing-install-manifest",
    violations
  );
  if (dirsFile) {
    const lines = dirsFile.text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!/["']extensions\/copilot["']/.test(line)) continue;
      violations.push({
        rule: "forbidden-agent-install",
        path: displayPath(root, dirsFile.path),
        line: index + 1,
        excerpt: excerpt(line),
      });
    }
  }

  for (const relativePath of [
    join("build", "gulpfile.reh.ts"),
    join("build", "gulpfile.vscode.ts"),
    join("build", "gulpfile.extensions.ts"),
  ]) {
    const file = await readCheckoutFile(
      root,
      checkout,
      relativePath,
      "missing-packaging-manifest",
      violations
    );
    if (!file) continue;
    const lines = file.text.split(/\r?\n/);
    const lineIndex = lines.findIndex(line => FORBIDDEN_PACKAGING.test(line));
    if (lineIndex < 0) continue;
    violations.push({
      rule: "forbidden-agent-packaging",
      path: displayPath(root, file.path),
      line: lineIndex + 1,
      excerpt: excerpt(lines[lineIndex]),
    });
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

async function verifySystemExtensionExclusions(root, productPath, text, checkout, violations) {
  let product;
  try {
    product = JSON.parse(text);
  }
  catch {
    return;
  }
  const configured = product?.excludedSystemExtensionNames;
  const validNames = Array.isArray(configured)
    ? configured.filter(value => typeof value === "string" && value.length > 0)
    : [];
  const valid = Array.isArray(configured)
    && validNames.length === configured.length
    && new Set(validNames).size === validNames.length;
  if (!valid) {
    const lines = text.split(/\r?\n/);
    const lineIndex = Math.max(0, lines.findIndex(line => line.includes('"excludedSystemExtensionNames"')));
    violations.push({
      rule: "invalid-system-extension-exclusions",
      path: displayPath(root, productPath),
      line: lineIndex + 1,
      excerpt: excerpt(lines[lineIndex] ?? "excludedSystemExtensionNames"),
    });
  }
  if (!checkout) return;

  const extensionDirectory = join(resolve(checkout), "extensions", "copilot");
  const manifestPath = join(extensionDirectory, "package.json");
  let directoryMetadata;
  try {
    directoryMetadata = await lstat(extensionDirectory);
  }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    violations.push({
      rule: "invalid-system-extension-manifest",
      path: displayPath(root, extensionDirectory),
      line: 1,
      excerpt: "system extension directory must be a real directory",
    });
    return;
  }
  let manifestMetadata;
  let manifestText;
  try {
    manifestMetadata = await lstat(manifestPath);
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) throw new Error("manifest must be a real file");
    manifestText = await readFile(manifestPath, "utf8");
  }
  catch (error) {
    violations.push({
      rule: "invalid-system-extension-manifest",
      path: displayPath(root, manifestPath),
      line: 1,
      excerpt: error.message.slice(0, 160),
    });
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  }
  catch (error) {
    violations.push({
      rule: "invalid-system-extension-manifest",
      path: displayPath(root, manifestPath),
      line: 1,
      excerpt: error.message.slice(0, 160),
    });
    return;
  }
  if (typeof manifest?.name !== "string" || manifest.name.length === 0) {
    violations.push({
      rule: "invalid-system-extension-manifest",
      path: displayPath(root, manifestPath),
      line: 1,
      excerpt: "system extension manifest requires a non-empty name",
    });
    return;
  }
  if (!new Set(validNames).has(manifest.name)) {
    violations.push({
      rule: "unexcluded-system-extension",
      path: displayPath(root, manifestPath),
      line: 1,
      excerpt: `system extension ${manifest.name} is not excluded by the Chatero product`,
    });
  }
}

export async function verifyWorkbenchPolicy({ root, productPath, checkout = null }) {
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
  await collectPolicyFiles(
    canonicalRoot,
    join(canonicalRoot, "extensions"),
    files,
    violations
  );
  await collectPolicyFiles(
    canonicalRoot,
    join(canonicalRoot, "first-party-extensions.json"),
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
    await verifySystemExtensionExclusions(
      canonicalRoot,
      canonicalProductPath,
      productText,
      checkout,
      violations
    );
  }
  await verifyBuildScripts(canonicalRoot, checkout, violations);
  await verifyAgentSupplyChain(canonicalRoot, checkout, violations);

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
